import { NextResponse } from "next/server";

import { errorResponse, grantFromRequest } from "@/lib/api";
import { walletTransactions } from "@/server/core";

export async function GET(request: Request) {
  try {
    const grant = await grantFromRequest(request);
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    return NextResponse.json({
      transactions: await walletTransactions({ grant }, {
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
