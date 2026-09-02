import { NextResponse } from "next/server";

import { SCOPES } from "@/lib/scopes";

/**
 * RFC 9728. An MCP client that gets a 401 from the MCP endpoint reads this to
 * learn which authorization server to talk to.
 */
export async function GET(request: Request) {
  const origin = process.env.NEXTAUTH_URL ?? new URL(request.url).origin;

  return NextResponse.json({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/docs`,
  });
}
