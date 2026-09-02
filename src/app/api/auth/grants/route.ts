import { NextResponse } from "next/server";

import {
  apiError,
  errorResponse,
  optionalString,
  readJson,
  requireString,
} from "@/lib/api";
import { GrantIssuedVia } from "@prisma/client";
import { authenticateDevApp, requestGrant } from "@/server/grants";

/**
 * Step 2 of the Auth API (spec Section 10): a developer requests a Grant over a
 * Handle and gets back a consent URL. This authorizes nothing on its own — the
 * Grant sits `pending` until the Handle's human owner approves it, which is the
 * only human-in-the-loop step in the entire flow.
 */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);

    const devApp = await authenticateDevApp(
      requireString(body, "client_id"),
      requireString(body, "client_secret"),
    );

    const capRaw = optionalString(body, "spending_cap_paise");
    if (capRaw && !/^\d+$/.test(capRaw)) {
      return apiError("INVALID_CAP", "spending_cap_paise must be whole paise.", 400);
    }

    const issuedVia = optionalString(body, "issued_via");
    const { grant, consentUrl } = await requestGrant({
      devAppId: devApp.id,
      agentId: requireString(body, "agent_id"),
      scopes: body.scopes,
      spendingCapPaise: capRaw ? BigInt(capRaw) : null,
      issuedVia:
        issuedVia === "mcp"
          ? GrantIssuedVia.mcp
          : issuedVia === "axl"
            ? GrantIssuedVia.axl
            : GrantIssuedVia.rest,
      baseUrl: process.env.NEXTAUTH_URL ?? new URL(request.url).origin,
    });

    return NextResponse.json(
      {
        grant_id: grant.id,
        status: grant.status,
        scopes: grant.scopes,
        spending_cap_paise: grant.spendingCap?.toString() ?? null,
        mode: grant.mode,
        consent_url: consentUrl,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
