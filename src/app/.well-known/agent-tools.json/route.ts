import { NextResponse } from "next/server";

import { ACTIONS, inputSchemaFor, scopeDescription } from "@/lib/catalogue";
import { SCOPES, SCOPE_DESCRIPTIONS } from "@/lib/scopes";

/**
 * Step 7 of Section 10 — the JSON Schema tool catalogue of every callable
 * action, so an agent can discover the surface without being told about it.
 */
export async function GET(request: Request) {
  const origin = process.env.NEXTAUTH_URL ?? new URL(request.url).origin;

  return NextResponse.json(
    {
      name: "Skyborn for Devs",
      description:
        "A verified human's agent acting on their behalf: money, email, SMS, calls and one-time codes, machine to machine.",
      version: "1.0",
      auth: {
        type: "oauth2-grant",
        grant_request: `${origin}/api/auth/grants`,
        token: `${origin}/api/auth/token`,
        refresh: `${origin}/api/auth/token/refresh`,
        note: "Request a grant, have the handle's owner approve it once at the returned consent_url, then exchange it for a bearer token. No human involvement after that.",
      },
      scopes: SCOPES.map((scope) => ({ name: scope, description: SCOPE_DESCRIPTIONS[scope] })),
      tools: ACTIONS.map((action) => ({
        name: action.toolName,
        action: action.name,
        description: action.description,
        scope: action.scope,
        scope_description: scopeDescription(action.scope),
        endpoint: { method: action.method, url: `${origin}${action.path}` },
        input_schema: inputSchemaFor(action),
        ...(action.irreversible !== undefined ? { irreversible: action.irreversible } : {}),
        ...(action.effects ? { effects: action.effects } : {}),
      })),
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
