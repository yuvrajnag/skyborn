import { NextResponse } from "next/server";

import { errorResponse, readJson, requireString } from "@/lib/api";
import { exchangeGrantForTokens } from "@/server/grants";

/** Step 5: approved Grant + client credentials → a short-lived access token. */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const tokens = await exchangeGrantForTokens({
      clientId: requireString(body, "client_id"),
      clientSecret: requireString(body, "client_secret"),
      grantId: requireString(body, "grant_id"),
    });

    return NextResponse.json({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: tokens.tokenType,
      expires_in: tokens.expiresIn,
      scope: tokens.scopes.join(" "),
      grant_id: tokens.grantId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
