import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { GrantError, refreshTokens } from "@/server/grants";
import { OAuthError, redeemAuthorizationCode } from "@/server/oauth";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  expiryFromNow,
  hashToken,
  randomToken,
} from "@/server/tokens";

/**
 * The OAuth token endpoint. Both grant types land in the same AccessToken table
 * the REST Auth API uses, so a token minted here is revoked by the same one-tap
 * revoke and shows the same audit trail.
 */

function oauthError(code: string, description: string, status = 400) {
  return NextResponse.json({ error: code, error_description: description }, { status });
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v ?? "")]));
  }
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export async function POST(request: Request) {
  try {
    const body = await readForm(request);
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      const grant = await redeemAuthorizationCode({
        code: body.code ?? "",
        clientId: body.client_id ?? "",
        clientSecret: body.client_secret || undefined,
        redirectUri: body.redirect_uri ?? "",
        codeVerifier: body.code_verifier ?? "",
      });

      const accessToken = randomToken("sky_at");
      const refreshToken = randomToken("sky_rt");

      await prisma.accessToken.create({
        data: {
          grantId: grant.id,
          tokenHash: hashToken(accessToken),
          refreshTokenHash: hashToken(refreshToken),
          expiresAt: expiryFromNow(ACCESS_TOKEN_TTL_SECONDS),
          refreshExpiresAt: expiryFromNow(REFRESH_TOKEN_TTL_SECONDS),
        },
      });

      return NextResponse.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: grant.scopes.join(" "),
      });
    }

    if (grantType === "refresh_token") {
      const devApp = await prisma.devApp.findUnique({
        where: { clientId: body.client_id ?? "" },
      });
      if (!devApp) return oauthError("invalid_client", "Unknown client_id.", 401);

      // A public client sends no secret: refreshTokens skips the secret check
      // for one, and the single-use refresh token is the credential instead.
      const tokens = await refreshTokens({
        clientId: devApp.clientId,
        clientSecret: body.client_secret || undefined,
        refreshToken: body.refresh_token ?? "",
      });

      return NextResponse.json({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: tokens.tokenType,
        expires_in: tokens.expiresIn,
        scope: tokens.scopes.join(" "),
      });
    }

    return oauthError("unsupported_grant_type", `grant_type "${grantType}" is not supported.`);
  } catch (error) {
    if (error instanceof OAuthError) {
      return oauthError(error.code, error.message, error.status);
    }
    if (error instanceof GrantError) {
      return oauthError("invalid_grant", error.message, error.status);
    }
    console.error(error);
    return oauthError("server_error", "Something went wrong.", 500);
  }
}
