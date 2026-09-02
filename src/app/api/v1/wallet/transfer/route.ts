import { NextResponse } from "next/server";

import {
  errorResponse,
  grantFromRequest,
  idempotencyKey,
  optionalString,
  readJson,
  requirePaise,
  requireString,
} from "@/lib/api";
import { walletTransfer } from "@/server/core";

export async function POST(request: Request) {
  try {
    const grant = await grantFromRequest(request);
    const body = await readJson(request);
    return NextResponse.json(
      await walletTransfer(
        { grant },
        {
          toHandle: requireString(body, "to_handle"),
          amountPaise: requirePaise(body),
          description: optionalString(body, "description"),
          idempotencyKey: idempotencyKey(request),
        },
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
