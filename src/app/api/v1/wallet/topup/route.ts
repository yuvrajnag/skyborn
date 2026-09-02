import { NextResponse } from "next/server";

import { errorResponse, grantFromRequest, idempotencyKey, readJson, requirePaise } from "@/lib/api";
import { walletTopup } from "@/server/core";

export async function POST(request: Request) {
  try {
    const grant = await grantFromRequest(request);
    const body = await readJson(request);
    return NextResponse.json(
      await walletTopup(
        { grant },
        { amountPaise: requirePaise(body), idempotencyKey: idempotencyKey(request) },
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
