import { NextResponse } from "next/server";

import { errorResponse, grantFromRequest } from "@/lib/api";
import { walletBalance } from "@/server/core";

export async function GET(request: Request) {
  try {
    const grant = await grantFromRequest(request);
    return NextResponse.json(await walletBalance({ grant }));
  } catch (error) {
    return errorResponse(error);
  }
}
