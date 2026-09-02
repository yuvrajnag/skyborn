import { MessageChannel } from "@prisma/client";
import { NextResponse } from "next/server";

import { errorResponse, grantFromRequest } from "@/lib/api";
import { messagesLatestOtp } from "@/server/core";

function asChannel(value: string | null): MessageChannel | undefined {
  if (value === "email" || value === "sms" || value === "call") return value;
  return undefined;
}

export async function GET(request: Request) {
  try {
    const grant = await grantFromRequest(request);
    const params = new URL(request.url).searchParams;
    const within = Number(params.get("within_minutes") ?? 15);

    return NextResponse.json(
      await messagesLatestOtp(
        { grant },
        {
          channel: asChannel(params.get("channel")),
          from: params.get("from") ?? undefined,
          withinMinutes: Number.isFinite(within) ? within : 15,
        },
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
