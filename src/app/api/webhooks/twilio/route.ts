import { MessageChannel } from "@prisma/client";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { verifyTwilioSignature } from "@/lib/webhook-auth";
import { recordInboundMessage } from "@/server/messaging";

/** Inbound SMS from Twilio, verified against the request signature. */
export async function POST(request: Request) {
  const form = await request.formData();
  const body: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") body[key] = value;
  }

  const publicUrl = process.env.TWILIO_WEBHOOK_URL ?? request.url;
  const valid = verifyTwilioSignature({
    signature: request.headers.get("x-twilio-signature"),
    url: publicUrl,
    body,
    authToken: process.env.TWILIO_AUTH_TOKEN,
  });

  if (!valid) {
    return NextResponse.json({ error: "Bad Twilio signature." }, { status: 401 });
  }

  const to = body.To?.trim();
  if (!to) return NextResponse.json({ error: "Missing recipient." }, { status: 400 });

  const handle = await prisma.handle.findUnique({ where: { phone: to } });
  if (!handle) {
    return NextResponse.json({ status: "ignored", reason: "unknown handle" });
  }

  const message = await recordInboundMessage({
    agentId: handle.agentId,
    channel: MessageChannel.sms,
    from: body.From ?? "unknown",
    to,
    body: body.Body ?? "",
    providerRef: body.MessageSid,
  });

  return NextResponse.json({ status: "recorded", messageId: message.id });
}
