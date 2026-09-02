import {
  MessageChannel,
  MessageDirection,
  type Message,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { extractOtp, type OtpCandidate } from "@/server/otp";
import { emailProvider, phoneProvider } from "@/server/providers/messaging";
import { slugifyAgentName } from "@/server/handles";

/**
 * The handle's email, SMS and voice (spec Section 12, Phase 3).
 *
 * Everything here is transport-agnostic and takes an agentId — the caller has
 * already established that the caller may act on that agent. Scope checks live
 * one layer up, in the core service layer.
 */

export class MessagingError extends Error {
  constructor(
    message: string,
    readonly code: string = "MESSAGING_ERROR",
  ) {
    super(message);
  }
}

/**
 * Replaces a Phase 1 placeholder handle with provider-issued values, or
 * re-provisions one whose provider changed. Flips Handle.provisioned so the UI
 * stops warning that the address is internal.
 */
export async function provisionHandle(agentId: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { handle: true },
  });
  if (!agent?.handle) throw new MessagingError("Agent has no handle.", "HANDLE_NOT_FOUND");

  const email = emailProvider();
  const phone = phoneProvider();

  const [address, number] = await Promise.all([
    email.provisionAddress({ slug: slugifyAgentName(agent.name), agentId: agent.id }),
    phone.provisionNumber({ agentId: agent.id }),
  ]);

  return prisma.handle.update({
    where: { id: agent.handle.id },
    data: {
      email: address.address,
      phone: number.address,
      emailProviderRef: address.providerRef,
      phoneProviderRef: number.providerRef,
      // Only a real provider makes a handle genuinely reachable. The simulated
      // driver leaves this false so nothing claims an internal address can
      // receive mail.
      provisioned: email.id !== "simulated" && phone.id !== "simulated",
    },
  });
}

async function handleFor(agentId: string) {
  const handle = await prisma.handle.findUnique({ where: { agentId } });
  if (!handle) throw new MessagingError("Agent has no handle.", "HANDLE_NOT_FOUND");
  return handle;
}

export async function sendEmail(params: {
  agentId: string;
  to: string;
  subject: string;
  body: string;
}) {
  const handle = await handleFor(params.agentId);
  const provider = emailProvider();

  const result = await provider.send({
    from: handle.email,
    to: params.to,
    subject: params.subject,
    body: params.body,
  });

  return prisma.message.create({
    data: {
      agentId: params.agentId,
      direction: MessageDirection.out,
      channel: MessageChannel.email,
      from: handle.email,
      to: params.to,
      subject: params.subject,
      body: params.body,
      status: result.status,
      providerRef: result.providerRef,
    },
  });
}

export async function sendSms(params: { agentId: string; to: string; body: string }) {
  const handle = await handleFor(params.agentId);
  const provider = phoneProvider();

  const result = await provider.sendSms({
    from: handle.phone,
    to: params.to,
    body: params.body,
  });

  return prisma.message.create({
    data: {
      agentId: params.agentId,
      direction: MessageDirection.out,
      channel: MessageChannel.sms,
      from: handle.phone,
      to: params.to,
      body: params.body,
      status: result.status,
      providerRef: result.providerRef,
    },
  });
}

export async function makeCall(params: { agentId: string; to: string; script: string }) {
  const handle = await handleFor(params.agentId);
  const provider = phoneProvider();

  const result = await provider.placeCall({
    from: handle.phone,
    to: params.to,
    script: params.script,
  });

  return prisma.message.create({
    data: {
      agentId: params.agentId,
      direction: MessageDirection.out,
      channel: MessageChannel.call,
      from: handle.phone,
      to: params.to,
      // The transcript replaces this once the call completes.
      body: params.script,
      status: result.status,
      providerRef: result.providerRef,
    },
  });
}

/**
 * Records an inbound message. Called by the provider webhooks, and directly by
 * tests and the sandbox simulator.
 */
export async function recordInboundMessage(params: {
  agentId: string;
  channel: MessageChannel;
  from: string;
  to: string;
  subject?: string;
  body: string;
  providerRef?: string;
  receivedAt?: Date;
}) {
  return prisma.message.create({
    data: {
      agentId: params.agentId,
      direction: MessageDirection.in,
      channel: params.channel,
      from: params.from,
      to: params.to,
      subject: params.subject,
      body: params.body,
      status: "received",
      providerRef: params.providerRef,
      ...(params.receivedAt ? { createdAt: params.receivedAt } : {}),
    },
  });
}

export async function readInbox(params: {
  agentId: string;
  channel?: MessageChannel;
  direction?: MessageDirection;
  limit?: number;
}) {
  return prisma.message.findMany({
    where: {
      agentId: params.agentId,
      ...(params.channel ? { channel: params.channel } : {}),
      ...(params.direction ? { direction: params.direction } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(params.limit ?? 50, 200),
  });
}

export type LatestOtp = OtpCandidate & {
  messageId: string;
  channel: MessageChannel;
  from: string;
  receivedAt: Date;
};

/**
 * The newest one-time code across the agent's inbound messages.
 *
 * Only inbound messages are searched — a code the agent itself sent out is not
 * a code it received. Anything older than `withinMinutes` is ignored, because a
 * stale OTP is worse than none: it will be rejected by whatever asked for it,
 * and the agent will not know why.
 */
export async function getLatestOtp(params: {
  agentId: string;
  channel?: MessageChannel;
  from?: string;
  withinMinutes?: number;
  scan?: number;
}): Promise<LatestOtp | null> {
  const withinMinutes = params.withinMinutes ?? 15;
  const since = new Date(Date.now() - withinMinutes * 60_000);

  const messages: Message[] = await prisma.message.findMany({
    where: {
      agentId: params.agentId,
      direction: MessageDirection.in,
      createdAt: { gte: since },
      ...(params.channel ? { channel: params.channel } : {}),
      ...(params.from ? { from: { contains: params.from, mode: "insensitive" } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: params.scan ?? 25,
  });

  for (const message of messages) {
    const found = extractOtp(
      [message.subject, message.body].filter(Boolean).join(" — "),
    );
    if (found) {
      return {
        ...found,
        messageId: message.id,
        channel: message.channel,
        from: message.from,
        receivedAt: message.createdAt,
      };
    }
  }

  return null;
}
