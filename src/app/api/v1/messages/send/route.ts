import { NextResponse } from "next/server";

import {
  errorResponse,
  grantFromRequest,
  optionalString,
  readJson,
  requireString,
} from "@/lib/api";
import { CoreError, messagesSend } from "@/server/core";

export async function POST(request: Request) {
  try {
    const grant = await grantFromRequest(request);
    const body = await readJson(request);

    const channel = requireString(body, "channel");
    if (channel !== "email" && channel !== "sms") {
      throw new CoreError('channel must be "email" or "sms".', "INVALID_CHANNEL");
    }

    return NextResponse.json(
      await messagesSend(
        { grant },
        {
          channel,
          to: requireString(body, "to"),
          subject: optionalString(body, "subject"),
          body: requireString(body, "body"),
        },
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
