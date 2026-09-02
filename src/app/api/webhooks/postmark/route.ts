import { MessageChannel } from "@prisma/client";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { verifySharedSecret } from "@/lib/webhook-auth";
import { recordInboundMessage } from "@/server/messaging";

/**
 * Postmark inbound parsing (spec Section 6). Postmark does not sign requests,
 * so the URL carries a secret and every request must present it.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const check = verifySharedSecret(
    url.searchParams.get("secret"),
    process.env.POSTMARK_INBOUND_SECRET,
  );
  if (!check.ok) {
    return NextResponse.json({ error: check.reason }, { status: 401 });
  }

  const payload = (await request.json()) as {
    From?: string;
    To?: string;
    Subject?: string;
    TextBody?: string;
    HtmlBody?: string;
    MessageID?: string;
  };

  const to = payload.To?.trim().toLowerCase();
  if (!to) {
    return NextResponse.json({ error: "Missing recipient." }, { status: 400 });
  }

  // The recipient address is what identifies the agent. An address we did not
  // issue is dropped rather than guessed at.
  const handle = await prisma.handle.findUnique({ where: { email: to } });
  if (!handle) {
    return NextResponse.json({ status: "ignored", reason: "unknown handle" });
  }

  const body =
    payload.TextBody?.trim() ||
    payload.HtmlBody?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ||
    "";

  const message = await recordInboundMessage({
    agentId: handle.agentId,
    channel: MessageChannel.email,
    from: payload.From ?? "unknown",
    to,
    subject: payload.Subject ?? undefined,
    body,
    providerRef: payload.MessageID,
  });

  return NextResponse.json({ status: "recorded", messageId: message.id });
}
