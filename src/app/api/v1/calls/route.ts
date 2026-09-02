import { NextResponse } from "next/server";

import { errorResponse, grantFromRequest, readJson, requireString } from "@/lib/api";
import { callsMake } from "@/server/core";

export async function POST(request: Request) {
  try {
    const grant = await grantFromRequest(request);
    const body = await readJson(request);
    return NextResponse.json(
      await callsMake(
        { grant },
        { to: requireString(body, "to"), script: requireString(body, "script") },
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
