import { NextResponse } from "next/server";

import {
  errorResponse,
  grantFromRequest,
  idempotencyKey,
  readJson,
  requirePaise,
  requireString,
} from "@/lib/api";
import { walletPayout } from "@/server/core";

export async function POST(request: Request) {
  try {
    const grant = await grantFromRequest(request);
    const body = await readJson(request);
    return NextResponse.json(
      await walletPayout(
        { grant },
        {
          amountPaise: requirePaise(body),
          destination: requireString(body, "destination"),
          idempotencyKey: idempotencyKey(request),
        },
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
