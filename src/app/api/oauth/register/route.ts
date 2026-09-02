import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { OAuthError, registerOAuthClient } from "@/server/oauth";

/**
 * RFC 7591 dynamic client registration.
 *
 * Registration requires a signed-in human. Open registration would let anyone
 * mint a client id against this deployment; requiring a session means every
 * registered client is attributable to an account, and the client still cannot
 * do anything until a handle owner approves a grant for it.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      {
        error: "invalid_client",
        error_description:
          "Sign in to Skyborn in this browser first, then retry registration. Clients must be attributable to an account.",
      },
      { status: 401 },
    );
  }

  try {
    const body = (await request.json()) as {
      client_name?: string;
      redirect_uris?: string[];
    };

    const { clientId, clientSecret, redirectUris, devApp } = await registerOAuthClient({
      clientName: body.client_name ?? "MCP client",
      redirectUris: body.redirect_uris ?? [],
      ownerUserId: user.id,
    });

    return NextResponse.json(
      {
        client_id: clientId,
        client_secret: clientSecret,
        client_id_issued_at: Math.floor(devApp.createdAt.getTime() / 1000),
        client_name: devApp.name,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof OAuthError) {
      return NextResponse.json(
        { error: error.code, error_description: error.message },
        { status: error.status },
      );
    }
    console.error(error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
