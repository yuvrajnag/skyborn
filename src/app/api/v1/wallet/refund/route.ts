import { NextResponse } from "next/server";

import {
  errorResponse,
  grantFromRequest,
  idempotencyKey,
  optionalString,
  readJson,
  requireString,
} from "@/lib/api";
import { walletRefund } from "@/server/core";

export async function POST(request: Request) {
  try {
    const grant = await grantFromRequest(request);
    const body = await readJson(request);
    return NextResponse.json(
      await walletRefund(
        { grant },
        {
          originalEntryId: requireString(body, "original_entry_id"),
          reason: optionalString(body, "reason"),
          idempotencyKey: idempotencyKey(request),
        },
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
