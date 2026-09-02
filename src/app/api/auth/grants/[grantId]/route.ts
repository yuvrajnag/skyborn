import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { GrantError, authenticateDevApp } from "@/server/grants";

/** Step 4: the developer polls for approval instead of taking a webhook. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ grantId: string }> },
) {
  try {
    const { grantId } = await params;
    const url = new URL(request.url);

    const devApp = await authenticateDevApp(
      url.searchParams.get("client_id") ?? "",
      url.searchParams.get("client_secret") ?? "",
    );

    const grant = await prisma.grant.findUnique({ where: { id: grantId } });
    if (!grant) throw new GrantError("No such grant.", "GRANT_NOT_FOUND", 404);
    if (grant.devAppId !== devApp.id) {
      throw new GrantError("That grant belongs to a different app.", "GRANT_MISMATCH", 403);
    }

    return NextResponse.json({
      grant_id: grant.id,
      status: grant.status,
      scopes: grant.scopes,
      spending_cap_paise: grant.spendingCap?.toString() ?? null,
      mode: grant.mode,
      issued_at: grant.issuedAt?.toISOString() ?? null,
      revoked_at: grant.revokedAt?.toISOString() ?? null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
