import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { GrantIssuedVia, GrantStatus, Mode } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { parseScopes, type Scope } from "@/lib/scopes";
import { GrantError } from "@/server/grants";
import { hashToken, randomToken, tokensMatch } from "@/server/tokens";

/**
 * OAuth 2.1 for the MCP adapter (spec Section 13).
 *
 * MCP clients speak OAuth, so Skyborn does too — but nothing new is invented
 * underneath. An authorization code redeems into exactly the same Grant and
 * AccessToken rows a plain REST integration uses, which is what makes the
 * dashboard promise true: a grant approved through ChatGPT and one approved
 * through curl are indistinguishable, and equally revocable.
 *
 * PKCE is mandatory, not optional. MCP clients are public clients running on
 * someone's laptop with no secret they can keep, so the code challenge is the
 * only thing binding an authorization code to the client that requested it.
 */

const AUTHORIZATION_CODE_TTL_SECONDS = 600; // 10 minutes

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** RFC 7591 dynamic client registration. */
export async function registerOAuthClient(params: {
  clientName: string;
  redirectUris: string[];
  ownerUserId: string;
}) {
  const redirectUris = params.redirectUris.map((uri) => uri.trim()).filter(Boolean);
  if (redirectUris.length === 0) {
    throw new OAuthError("At least one redirect_uri is required.", "invalid_redirect_uri");
  }

  for (const uri of redirectUris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new OAuthError(`"${uri}" is not a valid URI.`, "invalid_redirect_uri");
    }
    // http is only ever acceptable for a loopback redirect, which is how a
    // desktop MCP client receives its code.
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      throw new OAuthError(
        `Redirect URIs must use https, or http on loopback. Got "${uri}".`,
        "invalid_redirect_uri",
      );
    }
  }

  const clientId = randomToken("sky_mcp", 12);
  // A public client is issued a secret it is not required to use, so the same
  // DevApp row serves both confidential and public clients.
  const clientSecret = randomToken("sky_secret");

  const devApp = await prisma.devApp.create({
    data: {
      userId: params.ownerUserId,
      name: params.clientName.trim().slice(0, 60) || "MCP client",
      clientId,
      clientSecretHash: hashToken(clientSecret),
      sandboxKeyId: randomToken("sky_sk_sandbox", 12),
      sandboxKeySecretHash: hashToken(randomToken("sky_sksec_sandbox")),
      redirectUris,
      isPublicClient: true,
    },
  });

  return { devApp, clientId, clientSecret, redirectUris };
}

export function verifyRedirectUri(registered: string[], candidate: string) {
  // Exact match only. Prefix matching on redirect URIs is how authorization
  // codes get delivered to somebody else's server.
  if (!registered.includes(candidate)) {
    throw new OAuthError(
      "redirect_uri does not exactly match a registered URI.",
      "invalid_redirect_uri",
    );
  }
}

/**
 * Creates the pending Grant an authorization request is asking about. The human
 * approves it on the ordinary consent page — the same one the REST flow uses.
 */
export async function beginAuthorization(params: {
  clientId: string;
  agentId: string;
  redirectUri: string;
  scopes: unknown;
  codeChallenge: string;
  codeChallengeMethod: string;
  spendingCapPaise?: bigint | null;
}) {
  const devApp = await prisma.devApp.findUnique({ where: { clientId: params.clientId } });
  if (!devApp) throw new OAuthError("Unknown client_id.", "invalid_client", 401);

  verifyRedirectUri(devApp.redirectUris, params.redirectUri);

  if (params.codeChallengeMethod !== "S256") {
    throw new OAuthError(
      "code_challenge_method must be S256. Plain PKCE is not accepted.",
      "invalid_request",
    );
  }
  if (!params.codeChallenge || params.codeChallenge.length < 43) {
    throw new OAuthError("A valid PKCE code_challenge is required.", "invalid_request");
  }

  let scopes: Scope[];
  try {
    scopes = parseScopes(params.scopes);
  } catch (error) {
    throw new OAuthError((error as Error).message, "invalid_scope");
  }
  if (scopes.length === 0) throw new OAuthError("At least one scope is required.", "invalid_scope");

  const grant = await prisma.grant.create({
    data: {
      devAppId: devApp.id,
      agentId: params.agentId,
      scopes,
      spendingCap: params.spendingCapPaise ?? null,
      mode: Mode.sandbox,
      status: GrantStatus.pending,
      // Recorded so the dashboard can show which surface asked, even though the
      // grant behaves identically whichever one it was.
      issuedVia: GrantIssuedVia.mcp,
    },
  });

  return { devApp, grant };
}

/** Mints the one-time code handed back to the client's redirect URI. */
export async function issueAuthorizationCode(params: {
  grantId: string;
  devAppId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
}) {
  const code = randomToken("sky_code");

  await prisma.oAuthAuthorizationCode.create({
    data: {
      codeHash: hashToken(code),
      devAppId: params.devAppId,
      grantId: params.grantId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes,
      expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000),
    },
  });

  return code;
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const left = Buffer.from(computed);
  const right = Buffer.from(challenge);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Redeems an authorization code. Single use, PKCE-verified, and bound to the
 * client and redirect URI it was issued for.
 */
export async function redeemAuthorizationCode(params: {
  code: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier: string;
}) {
  const devApp = await prisma.devApp.findUnique({ where: { clientId: params.clientId } });
  if (!devApp) throw new OAuthError("Unknown client_id.", "invalid_client", 401);

  // A confidential client must still present its secret; a public one is
  // authenticated by PKCE alone.
  if (!devApp.isPublicClient) {
    if (!params.clientSecret || !tokensMatch(params.clientSecret, devApp.clientSecretHash)) {
      throw new OAuthError("Bad client credentials.", "invalid_client", 401);
    }
  }

  const record = await prisma.oAuthAuthorizationCode.findUnique({
    where: { codeHash: hashToken(params.code) },
    include: { grant: true },
  });
  if (!record) throw new OAuthError("Unknown authorization code.", "invalid_grant");

  if (record.usedAt) {
    // A replayed code means the code leaked. Kill the grant it belongs to
    // rather than merely refusing this one exchange.
    await prisma.grant.update({
      where: { id: record.grantId },
      data: { status: GrantStatus.revoked, revokedAt: new Date() },
    });
    await prisma.accessToken.updateMany({
      where: { grantId: record.grantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new OAuthError(
      "That authorization code was already used. The grant has been revoked.",
      "invalid_grant",
    );
  }

  if (record.expiresAt < new Date()) {
    throw new OAuthError("That authorization code has expired.", "invalid_grant");
  }
  if (record.devAppId !== devApp.id) {
    throw new OAuthError("That code was issued to a different client.", "invalid_grant");
  }
  if (record.redirectUri !== params.redirectUri) {
    throw new OAuthError("redirect_uri does not match the authorization request.", "invalid_grant");
  }
  if (!verifyPkce(params.codeVerifier, record.codeChallenge)) {
    throw new OAuthError("PKCE verification failed.", "invalid_grant");
  }
  if (record.grant.status !== GrantStatus.active) {
    throw new OAuthError("That grant is not active.", "invalid_grant");
  }

  await prisma.oAuthAuthorizationCode.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  return record.grant;
}

/** Non-secret random string, for state and nonce values in tests and docs. */
export function randomState() {
  return randomBytes(16).toString("base64url");
}

export { GrantError };
