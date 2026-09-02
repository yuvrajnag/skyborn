import { NextResponse } from "next/server";

import { errorResponse, grantFromRequest } from "@/lib/api";
import { CoreError, callStatus } from "@/server/core";

export async function GET(request: Request) {
  try {
    const grant = await grantFromRequest(request);
    const callId = new URL(request.url).searchParams.get("call_id");
    if (!callId) throw new CoreError("call_id is required.", "MISSING_FIELD");
    return NextResponse.json(await callStatus({ grant }, { callId }));
  } catch (error) {
    return errorResponse(error);
  }
}
