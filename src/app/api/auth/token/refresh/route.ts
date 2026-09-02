import { NextResponse } from "next/server";

import { errorResponse, readJson, requireString } from "@/lib/api";
import { refreshTokens } from "@/server/grants";

/** Step 6: refresh, with rotation. No browser, no OTP, ever, from here on. */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const tokens = await refreshTokens({
      clientId: requireString(body, "client_id"),
      clientSecret: requireString(body, "client_secret"),
      refreshToken: requireString(body, "refresh_token"),
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
