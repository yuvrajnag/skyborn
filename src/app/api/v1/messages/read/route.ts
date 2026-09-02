import { MessageChannel } from "@prisma/client";
import { NextResponse } from "next/server";

import { errorResponse, grantFromRequest } from "@/lib/api";
import { messagesRead } from "@/server/core";

function asChannel(value: string | null): MessageChannel | undefined {
  if (value === "email" || value === "sms" || value === "call") return value;
  return undefined;
}

export async function GET(request: Request) {
  try {
    const grant = await grantFromRequest(request);
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get("limit") ?? 50);

    return NextResponse.json({
      messages: await messagesRead(
        { grant },
        {
          channel: asChannel(params.get("channel")),
          limit: Number.isFinite(limit) ? limit : 50,
        },
      ),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
