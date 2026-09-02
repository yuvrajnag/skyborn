import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";

import { GrantStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ACTIONS } from "@/lib/catalogue";
import { authenticateBearer } from "@/server/grants";
import { callTool, resourcesFor, toolsFor } from "@/server/mcp";
import {
  OAuthError,
  beginAuthorization,
  issueAuthorizationCode,
  redeemAuthorizationCode,
  registerOAuthClient,
} from "@/server/oauth";
import { approveGrant } from "@/server/grants";
import { creditWalletManually } from "@/server/wallet";
import { makeAgent, makeUser } from "./helpers";
import { approvedGrant } from "./auth.test";

after(async () => {
  await prisma.$disconnect();
});

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

async function registeredClient(redirectUris = ["http://127.0.0.1:9876/callback"]) {
  const user = await makeUser("mcp-dev");
  return registerOAuthClient({
    clientName: "Probe Client",
    redirectUris,
    ownerUserId: user.id,
  });
}

describe("dynamic client registration", () => {
  it("accepts https and loopback http", async () => {
    const { devApp } = await registeredClient([
      "https://app.example.com/cb",
      "http://127.0.0.1:9876/callback",
      "http://localhost:1234/cb",
    ]);
    assert.equal(devApp.redirectUris.length, 3);
    assert.equal(devApp.isPublicClient, true);
  });

  it("refuses plain http on a non-loopback host", async () => {
    await assert.rejects(
      registeredClient(["http://evil.example.com/cb"]),
      (e: OAuthError) => e.code === "invalid_redirect_uri",
    );
  });

  it("refuses registration with no redirect URI", async () => {
    await assert.rejects(
      registeredClient([]),
      (e: OAuthError) => e.code === "invalid_redirect_uri",
    );
  });
});

describe("authorization", () => {
  it("refuses a redirect URI that is not an exact match", async () => {
    const { devApp } = await registeredClient(["http://127.0.0.1:9876/callback"]);
    const { agent } = await makeAgent("MCP Agent");
    const { challenge } = pkce();

    await assert.rejects(
      beginAuthorization({
        clientId: devApp.clientId,
        agentId: agent.id,
        // A path suffix. Prefix matching here is how codes reach the wrong server.
        redirectUri: "http://127.0.0.1:9876/callback/evil",
        scopes: ["wallet:read"],
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      }),
      (e: OAuthError) => e.code === "invalid_redirect_uri",
    );
  });

  it("refuses plain PKCE", async () => {
    const { devApp } = await registeredClient();
    const { agent } = await makeAgent("Plain PKCE Agent");
    const { challenge } = pkce();

    await assert.rejects(
      beginAuthorization({
        clientId: devApp.clientId,
        agentId: agent.id,
        redirectUri: "http://127.0.0.1:9876/callback",
        scopes: ["wallet:read"],
        codeChallenge: challenge,
        codeChallengeMethod: "plain",
      }),
      (e: OAuthError) => e.code === "invalid_request",
    );
  });

  it("marks the grant as issued via mcp but otherwise identical", async () => {
    const { devApp } = await registeredClient();
    const { user, agent } = await makeAgent("Identical Agent");
    const { challenge } = pkce();

    const { grant } = await beginAuthorization({
      clientId: devApp.clientId,
      agentId: agent.id,
      redirectUri: "http://127.0.0.1:9876/callback",
      scopes: ["wallet:read", "wallet:transfer"],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      spendingCapPaise: 50_000n,
    });

    assert.equal(grant.issuedVia, "mcp");
    assert.equal(grant.status, GrantStatus.pending);
    assert.equal(grant.spendingCap, 50_000n);

    // Approved through the very same function the REST consent page uses.
    const approved = await approveGrant({ grantId: grant.id, approvingUserId: user.id });
    assert.equal(approved.status, GrantStatus.active);
  });
});

describe("code redemption", () => {
  async function issuedCode() {
    const { devApp } = await registeredClient();
    const { user, agent, wallet } = await makeAgent("Redeem Agent");
    const { verifier, challenge } = pkce();
    const redirectUri = "http://127.0.0.1:9876/callback";

    const { grant } = await beginAuthorization({
      clientId: devApp.clientId,
      agentId: agent.id,
      redirectUri,
      scopes: ["wallet:read", "wallet:transfer"],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    await approveGrant({ grantId: grant.id, approvingUserId: user.id });

    const code = await issueAuthorizationCode({
      grantId: grant.id,
      devAppId: devApp.id,
      redirectUri,
      codeChallenge: challenge,
      scopes: grant.scopes,
    });

    return { devApp, grant, code, verifier, redirectUri, wallet };
  }

  it("redeems once with the right verifier", async () => {
    const { devApp, code, verifier, redirectUri, grant } = await issuedCode();
    const redeemed = await redeemAuthorizationCode({
      code,
      clientId: devApp.clientId,
      redirectUri,
      codeVerifier: verifier,
    });
    assert.equal(redeemed.id, grant.id);
  });

  it("refuses a wrong PKCE verifier", async () => {
    const { devApp, code, redirectUri } = await issuedCode();
    await assert.rejects(
      redeemAuthorizationCode({
        code,
        clientId: devApp.clientId,
        redirectUri,
        codeVerifier: randomBytes(32).toString("base64url"),
      }),
      (e: OAuthError) => e.code === "invalid_grant",
    );
  });

  it("refuses a mismatched redirect URI", async () => {
    const { devApp, code, verifier } = await issuedCode();
    await assert.rejects(
      redeemAuthorizationCode({
        code,
        clientId: devApp.clientId,
        redirectUri: "http://127.0.0.1:9876/other",
        codeVerifier: verifier,
      }),
      (e: OAuthError) => e.code === "invalid_grant",
    );
  });

  it("revokes the grant when a code is replayed", async () => {
    const { devApp, code, verifier, redirectUri, grant } = await issuedCode();

    await redeemAuthorizationCode({ code, clientId: devApp.clientId, redirectUri, codeVerifier: verifier });

    await assert.rejects(
      redeemAuthorizationCode({ code, clientId: devApp.clientId, redirectUri, codeVerifier: verifier }),
      (e: OAuthError) => e.code === "invalid_grant",
    );

    // A replayed code means it leaked, so the grant dies rather than just the
    // one exchange being refused.
    const after = await prisma.grant.findUniqueOrThrow({ where: { id: grant.id } });
    assert.equal(after.status, GrantStatus.revoked);
  });

  it("refuses a code issued to a different client", async () => {
    const { code, verifier, redirectUri } = await issuedCode();
    const other = await registeredClient();

    await assert.rejects(
      redeemAuthorizationCode({
        code,
        clientId: other.devApp.clientId,
        redirectUri,
        codeVerifier: verifier,
      }),
      (e: OAuthError) => e.code === "invalid_grant",
    );
  });
});

describe("MCP tool surface", () => {
  it("advertises only the tools the grant's scopes cover", async () => {
    const built = await approvedGrant({ scopes: ["wallet:read"] });
    const grant = await authenticateBearer(built.tokens.accessToken);

    const names = toolsFor(grant).map((t) => t.name);
    assert.deepEqual(names.sort(), ["check_balance", "list_transactions"]);
    assert.ok(!names.includes("transfer_money"), "must not advertise an unapproved capability");
  });

  it("marks irreversible tools destructive and reads read-only", async () => {
    const built = await approvedGrant({
      scopes: ["wallet:read", "wallet:payout", "messages:send"],
    });
    const grant = await authenticateBearer(built.tokens.accessToken);
    const tools = Object.fromEntries(toolsFor(grant).map((t) => [t.name, t]));

    assert.equal(tools.check_balance.annotations.readOnlyHint, true);
    assert.equal(tools.payout.annotations.destructiveHint, true);
    assert.equal(tools.send_message.annotations.destructiveHint, true);
    assert.equal(tools.send_message.annotations.openWorldHint, true);
  });

  it("hides the balance resource without wallet:read", async () => {
    const built = await approvedGrant({ scopes: ["messages:send"] });
    const grant = await authenticateBearer(built.tokens.accessToken);
    assert.equal(resourcesFor(grant).length, 0);
  });

  it("enforces scope on a call even if the tool name is guessed", async () => {
    const built = await approvedGrant({ scopes: ["wallet:read"] });
    const grant = await authenticateBearer(built.tokens.accessToken);

    await assert.rejects(
      callTool(grant, "transfer_money", { to_handle: "x@y.local", amount_paise: "100" }),
      (e: { code?: string }) => e.code === "INSUFFICIENT_SCOPE",
    );
  });

  it("runs a real call through the core layer", async () => {
    const built = await approvedGrant({ scopes: ["wallet:read"] });
    await creditWalletManually({ walletId: built.wallet.id, amountPaise: 250_000n });
    const grant = await authenticateBearer(built.tokens.accessToken);

    const result = (await callTool(grant, "check_balance", {})) as { balancePaise: string };
    assert.equal(result.balancePaise, "250000");
  });

  it("rejects a float amount", async () => {
    const built = await approvedGrant({ scopes: ["wallet:read", "wallet:transfer"] });
    const grant = await authenticateBearer(built.tokens.accessToken);

    await assert.rejects(
      callTool(grant, "transfer_money", { to_handle: "x@y.local", amount_paise: 100.5 }),
      (e: { code?: string }) => e.code === "INVALID_AMOUNT",
    );
  });

  it("has a handler for every catalogued tool", async () => {
    const built = await approvedGrant({ scopes: [...new Set(ACTIONS.map((a) => a.scope))] });
    const grant = await authenticateBearer(built.tokens.accessToken);
    const advertised = toolsFor(grant).map((t) => t.name).sort();

    assert.deepEqual(advertised, ACTIONS.map((a) => a.toolName).sort());

    // Every one dispatches to something — a missing case would throw UNKNOWN_TOOL
    // rather than a validation error about its arguments.
    for (const action of ACTIONS) {
      await callTool(grant, action.toolName, {}).catch((error: { code?: string }) => {
        assert.notEqual(
          error.code,
          "UNKNOWN_TOOL",
          `${action.toolName} is advertised but has no handler`,
        );
      });
    }
  });
});
