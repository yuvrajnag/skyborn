import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { GrantStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  GrantError,
  approveGrant,
  authenticateBearer,
  authenticateDevApp,
  exchangeGrantForTokens,
  refreshTokens,
  registerDevApp,
  requestGrant,
  revokeGrantById,
} from "@/server/grants";
import { makeAgent, makeUser } from "./helpers";

after(async () => {
  await prisma.$disconnect();
});

/** Walks the whole Section 10 flow and hands back everything it produced. */
async function approvedGrant(options?: { scopes?: string[]; capPaise?: bigint | null }) {
  const developer = await makeUser("dev");
  const { user: owner, agent, wallet } = await makeAgent("Granted Agent");

  const { devApp, clientSecret } = await registerDevApp({
    userId: developer.id,
    name: "Test App",
  });

  const { grant, consentUrl } = await requestGrant({
    devAppId: devApp.id,
    agentId: agent.id,
    scopes: options?.scopes ?? ["wallet:read", "wallet:transfer", "messages:send"],
    spendingCapPaise: options?.capPaise === undefined ? 100_000n : options.capPaise,
    baseUrl: "http://localhost:3000",
  });

  await approveGrant({ grantId: grant.id, approvingUserId: owner.id });

  const tokens = await exchangeGrantForTokens({
    clientId: devApp.clientId,
    clientSecret,
    grantId: grant.id,
  });

  return { developer, owner, agent, wallet, devApp, clientSecret, grant, tokens, consentUrl };
}

describe("DevApp registration", () => {
  it("returns secrets once and stores only hashes", async () => {
    const user = await makeUser();
    const { devApp, clientSecret, sandboxKeySecret } = await registerDevApp({
      userId: user.id,
      name: "Concierge",
    });

    assert.ok(clientSecret.startsWith("sky_secret_"));
    assert.ok(sandboxKeySecret.startsWith("sky_sksec_sandbox_"));

    const stored = await prisma.devApp.findUniqueOrThrow({ where: { id: devApp.id } });
    assert.notEqual(stored.clientSecretHash, clientSecret);
    assert.equal(stored.clientSecretHash.length, 64, "stored as a sha-256 hex digest");
    assert.ok(!JSON.stringify(stored).includes(clientSecret), "raw secret never persisted");
  });

  it("rejects a bad client secret", async () => {
    const user = await makeUser();
    const { devApp } = await registerDevApp({ userId: user.id, name: "Concierge" });

    await assert.rejects(
      authenticateDevApp(devApp.clientId, "sky_secret_wrong"),
      (e: GrantError) => e.code === "INVALID_CLIENT" && e.status === 401,
    );
  });
});

describe("grant request and consent", () => {
  it("starts pending and returns a consent URL", async () => {
    const developer = await makeUser("dev");
    const { agent } = await makeAgent("Pending Agent");
    const { devApp } = await registerDevApp({ userId: developer.id, name: "App" });

    const { grant, consentUrl } = await requestGrant({
      devAppId: devApp.id,
      agentId: agent.id,
      scopes: ["wallet:read"],
      baseUrl: "http://localhost:3000",
    });

    assert.equal(grant.status, GrantStatus.pending);
    assert.equal(consentUrl, `http://localhost:3000/consent/${grant.id}`);
  });

  it("refuses unknown scopes", async () => {
    const developer = await makeUser("dev");
    const { agent } = await makeAgent("Scope Agent");
    const { devApp } = await registerDevApp({ userId: developer.id, name: "App" });

    await assert.rejects(
      requestGrant({
        devAppId: devApp.id,
        agentId: agent.id,
        scopes: ["wallet:read", "wallet:drain"],
        baseUrl: "http://localhost:3000",
      }),
      (e: GrantError) => e.code === "INVALID_SCOPE",
    );
  });

  it("refuses a live-mode grant while live mode is gated", async () => {
    const developer = await makeUser("dev");
    const { agent } = await makeAgent("Live Grant Agent");
    const { devApp } = await registerDevApp({ userId: developer.id, name: "App" });

    await assert.rejects(
      requestGrant({
        devAppId: devApp.id,
        agentId: agent.id,
        scopes: ["wallet:read"],
        mode: "live",
        baseUrl: "http://localhost:3000",
      }),
      (e: GrantError) => e.code === "LIVE_MODE_UNAVAILABLE",
    );
  });

  it("lets only the handle's owner approve", async () => {
    const developer = await makeUser("dev");
    const { agent } = await makeAgent("Owned Agent");
    const stranger = await makeUser("stranger");
    const { devApp } = await registerDevApp({ userId: developer.id, name: "App" });

    const { grant } = await requestGrant({
      devAppId: devApp.id,
      agentId: agent.id,
      scopes: ["wallet:read"],
      baseUrl: "http://localhost:3000",
    });

    await assert.rejects(
      approveGrant({ grantId: grant.id, approvingUserId: stranger.id }),
      (e: GrantError) => e.code === "NOT_GRANT_OWNER" && e.status === 403,
    );
  });
});

describe("token exchange", () => {
  it("refuses to issue a token for an unapproved grant", async () => {
    const developer = await makeUser("dev");
    const { agent } = await makeAgent("Unapproved Agent");
    const { devApp, clientSecret } = await registerDevApp({ userId: developer.id, name: "App" });

    const { grant } = await requestGrant({
      devAppId: devApp.id,
      agentId: agent.id,
      scopes: ["wallet:read"],
      baseUrl: "http://localhost:3000",
    });

    await assert.rejects(
      exchangeGrantForTokens({ clientId: devApp.clientId, clientSecret, grantId: grant.id }),
      (e: GrantError) => e.code === "GRANT_PENDING",
    );
  });

  it("refuses another app's credentials for the same grant", async () => {
    const { grant } = await approvedGrant();
    const other = await makeUser("other-dev");
    const { devApp: otherApp, clientSecret: otherSecret } = await registerDevApp({
      userId: other.id,
      name: "Other App",
    });

    await assert.rejects(
      exchangeGrantForTokens({
        clientId: otherApp.clientId,
        clientSecret: otherSecret,
        grantId: grant.id,
      }),
      (e: GrantError) => e.code === "GRANT_MISMATCH" && e.status === 403,
    );
  });

  it("stores only hashes of the issued tokens", async () => {
    const { tokens } = await approvedGrant();
    const stored = await prisma.accessToken.findFirstOrThrow({
      where: { grantId: tokens.grantId },
    });

    assert.notEqual(stored.tokenHash, tokens.accessToken);
    assert.notEqual(stored.refreshTokenHash, tokens.refreshToken);
    assert.ok(!JSON.stringify(stored).includes(tokens.accessToken));
  });

  it("authenticates a bearer token to its grant", async () => {
    const { tokens, agent } = await approvedGrant();
    const grant = await authenticateBearer(tokens.accessToken);
    assert.equal(grant.agentId, agent.id);
  });

  it("rejects a made-up token", async () => {
    await assert.rejects(
      authenticateBearer("sky_at_not_a_real_token"),
      (e: GrantError) => e.code === "INVALID_TOKEN" && e.status === 401,
    );
  });

  it("rejects an expired token", async () => {
    const { tokens } = await approvedGrant();
    await prisma.accessToken.updateMany({
      where: { grantId: tokens.grantId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await assert.rejects(
      authenticateBearer(tokens.accessToken),
      (e: GrantError) => e.code === "TOKEN_EXPIRED",
    );
  });
});

describe("refresh", () => {
  it("rotates the pair, killing the old one", async () => {
    const { devApp, clientSecret, tokens } = await approvedGrant();

    const next = await refreshTokens({
      clientId: devApp.clientId,
      clientSecret,
      refreshToken: tokens.refreshToken,
    });

    assert.notEqual(next.accessToken, tokens.accessToken);
    assert.notEqual(next.refreshToken, tokens.refreshToken);

    // The new one works.
    await authenticateBearer(next.accessToken);

    // The old access token and old refresh token are both dead.
    await assert.rejects(authenticateBearer(tokens.accessToken));
    await assert.rejects(
      refreshTokens({ clientId: devApp.clientId, clientSecret, refreshToken: tokens.refreshToken }),
      (e: GrantError) => e.code === "INVALID_REFRESH_TOKEN",
    );
  });
});

describe("revocation", () => {
  it("kills every live token the instant the grant is revoked", async () => {
    const { grant, tokens, devApp, clientSecret } = await approvedGrant();

    // Working right up to the moment of revocation.
    await authenticateBearer(tokens.accessToken);

    await revokeGrantById(grant.id);

    await assert.rejects(
      authenticateBearer(tokens.accessToken),
      (e: GrantError) => e.code === "TOKEN_REVOKED",
    );
    await assert.rejects(
      refreshTokens({ clientId: devApp.clientId, clientSecret, refreshToken: tokens.refreshToken }),
      (e: GrantError) => e.code === "INVALID_REFRESH_TOKEN",
    );
    await assert.rejects(
      exchangeGrantForTokens({ clientId: devApp.clientId, clientSecret, grantId: grant.id }),
      (e: GrantError) => e.code === "GRANT_REVOKED",
    );
  });

  it("leaves no usable token behind after revocation", async () => {
    const { grant, devApp, clientSecret } = await approvedGrant();
    // Mint several, as a long-running integration would.
    for (let i = 0; i < 3; i += 1) {
      await exchangeGrantForTokens({ clientId: devApp.clientId, clientSecret, grantId: grant.id });
    }

    await revokeGrantById(grant.id);

    const live = await prisma.accessToken.count({
      where: { grantId: grant.id, revokedAt: null },
    });
    assert.equal(live, 0);
  });
});

export { approvedGrant };
