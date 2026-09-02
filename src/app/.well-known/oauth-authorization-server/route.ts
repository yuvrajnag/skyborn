import { NextResponse } from "next/server";

import { SCOPES } from "@/lib/scopes";

/** RFC 8414 authorization server metadata. */
export async function GET(request: Request) {
  const origin = process.env.NEXTAUTH_URL ?? new URL(request.url).origin;

  return NextResponse.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    // S256 only. `plain` defeats the point of PKCE for a public client, which
    // is every MCP client.
    code_challenge_methods_supported: ["S256"],
  });
}
