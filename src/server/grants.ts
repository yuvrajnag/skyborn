import { GrantIssuedVia, GrantStatus, Mode, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { type Scope, parseScopes } from "@/lib/scopes";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  expiryFromNow,
  hashToken,
  randomToken,
  tokensMatch,
} from "@/server/tokens";

/**
 * The Auth API (spec Section 10).
 *
 * The trust model, in full: an agent has no identity of its own. It carries a
 * bearer token issued off a Grant, and that Grant only exists because a human
 * who already passed identity verification approved it once. Every call is
 * checked against — is the token valid and unexpired, is its Grant still
 * active, does its scope cover this action, and for money, is it within the
 * cap. That is the entirety of "agent verification" (Section 3).
 *
 * The single human moment is approving the Grant. Everything after it is
 * machine-to-machine, with no browser and no OTP, until the human revokes.
 */

export class GrantError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// DevApp registration
// ---------------------------------------------------------------------------

export type RegisteredDevApp = {
  devApp: Awaited<ReturnType<typeof prisma.devApp.create>>;
  /** Shown once, never recoverable. */
  clientSecret: string;
  sandboxKeySecret: string;
};

export async function registerDevApp(params: {
  userId: string;
  name: string;
}): Promise<RegisteredDevApp> {
  const name = params.name.trim();
  if (name.length < 2 || name.length > 60) {
    throw new GrantError("Give the app a name between 2 and 60 characters.", "INVALID_NAME");
  }

  const clientId = randomToken("sky_app", 12);
  const clientSecret = randomToken("sky_secret");
  const sandboxKeyId = randomToken("sky_sk_sandbox", 12);
  const sandboxKeySecret = randomToken("sky_sksec_sandbox");

  const devApp = await prisma.devApp.create({
    data: {
      userId: params.userId,
      name,
      clientId,
      clientSecretHash: hashToken(clientSecret),
      sandboxKeyId,
      sandboxKeySecretHash: hashToken(sandboxKeySecret),
      // Live keys are only minted once the owner is KYC-verified (Phase 9/10).
    },
  });

  return { devApp, clientSecret, sandboxKeySecret };
}

export async function authenticateDevApp(clientId: string, clientSecret: string) {
  const devApp = await prisma.devApp.findUnique({ where: { clientId } });
  if (!devApp || !tokensMatch(clientSecret, devApp.clientSecretHash)) {
    throw new GrantError("Bad client credentials.", "INVALID_CLIENT", 401);
  }
  return devApp;
}

/**
 * Authenticates the app behind a refresh request.
 *
 * A confidential app proves itself with its client secret. A public one — every
 * MCP client, running on someone's laptop with no secret it can keep — cannot,
 * so RFC 6749 §6 makes the refresh token itself the credential. That is safe
 * here because refresh tokens are single-use: rotation means a stolen one stops
 * working the moment the legitimate holder refreshes, and the theft surfaces as
 * the victim being logged out rather than going unnoticed.
 */
async function authenticateForRefresh(clientId: string, clientSecret: string | undefined) {
  const devApp = await prisma.devApp.findUnique({ where: { clientId } });
  if (!devApp) throw new GrantError("Bad client credentials.", "INVALID_CLIENT", 401);

  if (devApp.isPublicClient) return devApp;

  if (!clientSecret || !tokensMatch(clientSecret, devApp.clientSecretHash)) {
    throw new GrantError("Bad client credentials.", "INVALID_CLIENT", 401);
  }
  return devApp;
}

// ---------------------------------------------------------------------------
// Grant request → consent → approval
// ---------------------------------------------------------------------------

/**
 * Step 2 of Section 10: a developer asks for a Grant over one Handle and gets
 * back a consent URL. Nothing is authorized yet — the Grant is `pending` until
 * the Handle's owner approves it.
 */
export async function requestGrant(params: {
  devAppId: string;
  agentId: string;
  scopes: unknown;
  spendingCapPaise?: bigint | null;
  mode?: Mode;
  issuedVia?: GrantIssuedVia;
  baseUrl: string;
}) {
  let scopes: Scope[];
  try {
    scopes = parseScopes(params.scopes);
  } catch (error) {
    throw new GrantError((error as Error).message, "INVALID_SCOPE");
  }
  if (scopes.length === 0) {
    throw new GrantError("Ask for at least one scope.", "INVALID_SCOPE");
  }

  const agent = await prisma.agent.findUnique({ where: { id: params.agentId } });
  if (!agent) throw new GrantError("No such agent.", "AGENT_NOT_FOUND", 404);

  const mode = params.mode ?? Mode.sandbox;
  if (mode === Mode.live) {
    throw new GrantError(
      "Live-mode grants are not available yet — live mode unlocks with identity verification.",
      "LIVE_MODE_UNAVAILABLE",
    );
  }

  if (params.spendingCapPaise !== undefined && params.spendingCapPaise !== null) {
    if (params.spendingCapPaise <= 0n) {
      throw new GrantError("A spending cap must be greater than zero.", "INVALID_CAP");
    }
  }

  const grant = await prisma.grant.create({
    data: {
      devAppId: params.devAppId,
      agentId: params.agentId,
      scopes,
      spendingCap: params.spendingCapPaise ?? null,
      mode,
      status: GrantStatus.pending,
      issuedVia: params.issuedVia ?? GrantIssuedVia.rest,
    },
  });

  return {
    grant,
    consentUrl: `${params.baseUrl.replace(/\/$/, "")}/consent/${grant.id}`,
  };
}

/** The Handle owner's one click. Everything after this is machine-to-machine. */
export async function approveGrant(params: { grantId: string; approvingUserId: string }) {
  const grant = await prisma.grant.findUnique({
    where: { id: params.grantId },
    include: { agent: true },
  });
  if (!grant) throw new GrantError("No such grant.", "GRANT_NOT_FOUND", 404);

  // Only the human who owns the Handle may approve a Grant over it.
  if (grant.agent.userId !== params.approvingUserId) {
    throw new GrantError("That grant is not yours to approve.", "NOT_GRANT_OWNER", 403);
  }
  if (grant.status === GrantStatus.revoked) {
    throw new GrantError("That grant was revoked.", "GRANT_REVOKED");
  }
  if (grant.status === GrantStatus.active) return grant;

  return prisma.grant.update({
    where: { id: grant.id },
    data: { status: GrantStatus.active, issuedAt: new Date() },
  });
}

export async function denyGrant(params: { grantId: string; approvingUserId: string }) {
  const grant = await prisma.grant.findUnique({
    where: { id: params.grantId },
    include: { agent: true },
  });
  if (!grant) throw new GrantError("No such grant.", "GRANT_NOT_FOUND", 404);
  if (grant.agent.userId !== params.approvingUserId) {
    throw new GrantError("That grant is not yours to deny.", "NOT_GRANT_OWNER", 403);
  }

  return revokeGrantById(grant.id);
}

/**
 * One-tap revoke (spec Section 15). Killing the Grant and every token issued
 * off it happens in one transaction, so there is no window in which a token
 * outlives the authorization it was minted from.
 */
export async function revokeGrantById(grantId: string) {
  const [, grant] = await prisma.$transaction([
    prisma.accessToken.updateMany({
      where: { grantId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.grant.update({
      where: { id: grantId },
      data: { status: GrantStatus.revoked, revokedAt: new Date() },
    }),
  ]);
  return grant;
}

/** Revoke scoped to the owning human — used by the dashboard. */
export async function revokeGrantForUser(params: { grantId: string; userId: string }) {
  const grant = await prisma.grant.findUnique({
    where: { id: params.grantId },
    include: { agent: true },
  });
  if (!grant) throw new GrantError("No such grant.", "GRANT_NOT_FOUND", 404);
  if (grant.agent.userId !== params.userId) {
    throw new GrantError("That grant is not yours to revoke.", "NOT_GRANT_OWNER", 403);
  }
  return revokeGrantById(grant.id);
}

// ---------------------------------------------------------------------------
// Token issue / refresh
// ---------------------------------------------------------------------------

export type IssuedTokens = {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  scopes: string[];
  grantId: string;
};

async function mintTokens(grantId: string, scopes: string[]): Promise<IssuedTokens> {
  const accessToken = randomToken("sky_at");
  const refreshToken = randomToken("sky_rt");

  await prisma.accessToken.create({
    data: {
      grantId,
      tokenHash: hashToken(accessToken),
      refreshTokenHash: hashToken(refreshToken),
      expiresAt: expiryFromNow(ACCESS_TOKEN_TTL_SECONDS),
      refreshExpiresAt: expiryFromNow(REFRESH_TOKEN_TTL_SECONDS),
    },
  });

  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scopes,
    grantId,
  };
}

/** Step 5 of Section 10: approved Grant + client credentials → access token. */
export async function exchangeGrantForTokens(params: {
  clientId: string;
  clientSecret: string;
  grantId: string;
}): Promise<IssuedTokens> {
  const devApp = await authenticateDevApp(params.clientId, params.clientSecret);

  const grant = await prisma.grant.findUnique({ where: { id: params.grantId } });
  if (!grant) throw new GrantError("No such grant.", "GRANT_NOT_FOUND", 404);

  // A Grant belongs to one DevApp; another app's credentials cannot redeem it.
  if (grant.devAppId !== devApp.id) {
    throw new GrantError("That grant belongs to a different app.", "GRANT_MISMATCH", 403);
  }
  if (grant.status !== GrantStatus.active) {
    throw new GrantError(
      grant.status === GrantStatus.pending
        ? "That grant has not been approved yet."
        : "That grant was revoked.",
      grant.status === GrantStatus.pending ? "GRANT_PENDING" : "GRANT_REVOKED",
      403,
    );
  }

  return mintTokens(grant.id, grant.scopes);
}

export async function refreshTokens(params: {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}): Promise<IssuedTokens> {
  const devApp = await authenticateForRefresh(params.clientId, params.clientSecret);

  const record = await prisma.accessToken.findUnique({
    where: { refreshTokenHash: hashToken(params.refreshToken) },
    include: { grant: true },
  });

  if (!record || record.revokedAt) {
    throw new GrantError("That refresh token is not valid.", "INVALID_REFRESH_TOKEN", 401);
  }
  if (record.refreshExpiresAt && record.refreshExpiresAt < new Date()) {
    throw new GrantError("That refresh token has expired.", "REFRESH_TOKEN_EXPIRED", 401);
  }
  if (record.grant.devAppId !== devApp.id) {
    throw new GrantError("That token belongs to a different app.", "GRANT_MISMATCH", 403);
  }
  if (record.grant.status !== GrantStatus.active) {
    throw new GrantError("That grant is no longer active.", "GRANT_REVOKED", 403);
  }

  // Rotate: the old pair dies as the new one is minted, so a stolen refresh
  // token stops working the moment the legitimate holder uses theirs.
  await prisma.accessToken.update({
    where: { id: record.id },
    data: { revokedAt: new Date() },
  });

  return mintTokens(record.grantId, record.grant.scopes);
}

// ---------------------------------------------------------------------------
// Bearer-token authentication
// ---------------------------------------------------------------------------

export type AuthenticatedGrant = Prisma.GrantGetPayload<{
  include: { agent: { include: { handle: true; wallet: true } }; devApp: true };
}>;

/**
 * Resolves a bearer token to its Grant, or throws. This is the check every
 * agent-facing call runs first.
 */
export async function authenticateBearer(token: string): Promise<AuthenticatedGrant> {
  const record = await prisma.accessToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      grant: {
        include: {
          agent: { include: { handle: true, wallet: true } },
          devApp: true,
        },
      },
    },
  });

  if (!record) throw new GrantError("Invalid access token.", "INVALID_TOKEN", 401);
  if (record.revokedAt) throw new GrantError("That token was revoked.", "TOKEN_REVOKED", 401);
  if (record.expiresAt < new Date()) {
    throw new GrantError("That token has expired.", "TOKEN_EXPIRED", 401);
  }
  if (record.grant.status !== GrantStatus.active) {
    throw new GrantError("The grant behind this token is no longer active.", "GRANT_REVOKED", 403);
  }

  return record.grant;
}

/** Pulls the bearer token out of an Authorization header. */
export function bearerFromHeader(header: string | null): string {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new GrantError("Missing or malformed Authorization header.", "MISSING_TOKEN", 401);
  }
  return match[1].trim();
}

/** Access tokens minted by this service all carry this prefix. */
const ACCESS_TOKEN_PREFIX = "sky_at_";

/**
 * Reads the agent's token from a request.
 *
 * Direct REST and MCP callers send `Authorization: Bearer <token>`. A call
 * arriving through the AXL engine does not: AXL takes the client's bearer token
 * and re-shapes it into `Cookie: sid=<token>` on the outbound call to us
 * (packages/runtime/backend-adapter.js — its docs describe the header as
 * forwarded "unchanged", but the code wraps it). So the cookie is a second
 * accepted carrier for the same credential.
 *
 * Accepting a credential from a cookie is normally a CSRF risk. It is not one
 * here, and deliberately so: Skyborn never sets a `sid` cookie on any browser
 * response, so no browser ever holds one to send, and a third-party site cannot
 * set a cookie on this domain. The value is additionally required to look like
 * a token this service minted, so an arbitrary cookie cannot even reach the
 * lookup.
 */
export function bearerFromRequest(request: Request): string {
  const header = request.headers.get("authorization");
  if (header) return bearerFromHeader(header);

  const cookie = request.headers.get("cookie");
  const sid = cookie?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1]?.trim();
  if (sid && sid.startsWith(ACCESS_TOKEN_PREFIX)) return sid;

  throw new GrantError("Missing or malformed Authorization header.", "MISSING_TOKEN", 401);
}

export async function listGrantsForUser(userId: string) {
  return prisma.grant.findMany({
    where: { agent: { userId } },
    include: {
      agent: true,
      devApp: true,
      _count: { select: { auditLogs: true, accessTokens: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getGrantForUser(params: { grantId: string; userId: string }) {
  return prisma.grant.findFirst({
    where: { id: params.grantId, agent: { userId: params.userId } },
    include: { agent: true, devApp: true },
  });
}
