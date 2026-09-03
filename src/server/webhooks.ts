import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { randomToken } from "@/server/tokens";

/**
 * Outbound webhooks (spec Sections 7 and 10).
 *
 * A developer's backend learns that a grant was approved without polling for
 * it, and learns about the money and messages its agent moved.
 *
 * Three properties matter more than the delivery itself:
 *
 *   - **Signed.** Every request carries an HMAC over the timestamp and body,
 *     so a receiver can tell a real delivery from anyone who guessed the URL.
 *   - **Timestamped.** The timestamp is inside the signed material, so a
 *     captured delivery cannot be replayed at a receiver days later.
 *   - **Recorded before sent.** A delivery row is written before the HTTP call
 *     and updated after, so a crash mid-flight leaves a pending row to retry
 *     rather than a webhook nobody knows was lost.
 *
 * Retries use exponential backoff with a cap. Redis and BullMQ are what the
 * spec names for the queue; the retry schedule lives in the database instead so
 * a restart cannot drop the backlog, and `runDueDeliveries()` is the worker
 * loop whichever scheduler ends up calling it.
 */

export const WEBHOOK_EVENTS = [
  "grant.approved",
  "grant.revoked",
  "wallet.transfer",
  "wallet.topup",
  "wallet.payout",
  "wallet.refund",
  "message.received",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** Attempt n waits this many seconds. Caps out rather than growing forever. */
const BACKOFF_SECONDS = [0, 30, 120, 600, 3_600, 21_600];
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

/** How long a receiver may take before we give up on one attempt. */
const DELIVERY_TIMEOUT_MS = 10_000;

export class WebhookError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Loopback destinations are only allowed outside production, so a developer can
 * point a webhook at their own machine while testing.
 */
function loopbackAllowed(): boolean {
  if (process.env.WEBHOOK_ALLOW_LOOPBACK === "1") return true;
  if (process.env.WEBHOOK_ALLOW_LOOPBACK === "0") return false;
  return process.env.NODE_ENV !== "production";
}

/**
 * Addresses that are not on the public internet.
 *
 * This is the SSRF boundary. Without it, anyone who can register a webhook can
 * make Skyborn issue POSTs from inside the network — at cloud metadata
 * (169.254.169.254), at the database, at any internal admin endpoint — and read
 * the outcome through the recorded response code. The body never comes back,
 * but a blind request that mutates internal state is still a request.
 */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (lower === "::1" || lower === "::") return true;
    if (/^f[cd]/.test(lower)) return true; // unique local
    if (lower.startsWith("fe80")) return true; // link-local
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  // Anything we cannot classify is refused rather than allowed.
  return true;
}

function isLoopback(ip: string): boolean {
  if (net.isIPv4(ip)) return ip.startsWith("127.");
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  return lower === "::1";
}

/**
 * Resolves the host and refuses anything internal.
 *
 * Checked at registration *and* again immediately before each delivery: a name
 * that resolved publicly when it was registered can be re-pointed at an
 * internal address afterwards, and only the check at send time sees that.
 */
export async function assertPublicDestination(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");

  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      const resolved = await lookup(host, { all: true });
      addresses = resolved.map((entry) => entry.address);
    } catch {
      throw new WebhookError(
        `Could not resolve "${url.hostname}".`,
        "UNRESOLVABLE_HOST",
      );
    }
  }

  if (addresses.length === 0) {
    throw new WebhookError(`Could not resolve "${url.hostname}".`, "UNRESOLVABLE_HOST");
  }

  for (const address of addresses) {
    if (!isPrivateAddress(address)) continue;
    if (isLoopback(address) && loopbackAllowed()) continue;

    throw new WebhookError(
      `"${url.hostname}" resolves to ${address}, which is not a public address. ` +
        "Webhook destinations must be reachable on the public internet.",
      "PRIVATE_DESTINATION",
    );
  }
}

export async function createEndpoint(params: {
  devAppId: string;
  url: string;
  events: string[];
}) {
  let parsed: URL;
  try {
    parsed = new URL(params.url);
  } catch {
    throw new WebhookError("That is not a valid URL.", "INVALID_URL");
  }

  // https only, except on loopback where a developer is testing locally.
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new WebhookError(
      "Webhook URLs must use https, or http on loopback for local testing.",
      "INSECURE_URL",
    );
  }

  const events = [...new Set(params.events)].filter(isWebhookEvent);
  if (events.length === 0) {
    throw new WebhookError("Subscribe to at least one known event.", "NO_EVENTS");
  }

  // Refuse anything that points inside the network. Last, because it is the
  // only check here that costs a DNS lookup.
  await assertPublicDestination(params.url);

  // Returned once. The receiver needs it to verify signatures.
  const secret = randomToken("sky_whsec");

  const endpoint = await prisma.webhookEndpoint.create({
    data: { devAppId: params.devAppId, url: params.url, secret, events },
  });

  return { endpoint, secret };
}

/** `t=<unix>,v1=<hex>` — the timestamp is signed, so a capture cannot be replayed. */
export function signPayload(params: {
  secret: string;
  timestamp: number;
  body: string;
}): string {
  const mac = createHmac("sha256", params.secret)
    .update(`${params.timestamp}.${params.body}`)
    .digest("hex");
  return `t=${params.timestamp},v1=${mac}`;
}

/**
 * Verifies a signature the way a receiver should. Exported so the docs can
 * point at a real implementation rather than describing one.
 */
export function verifySignature(params: {
  secret: string;
  header: string;
  body: string;
  toleranceSeconds?: number;
}): boolean {
  const parts = Object.fromEntries(
    params.header.split(",").map((part) => part.split("=").map((s) => s.trim()) as [string, string]),
  );
  const timestamp = Number(parts.t);
  const provided = parts.v1;
  if (!Number.isFinite(timestamp) || !provided) return false;

  const tolerance = params.toleranceSeconds ?? 300;
  if (Math.abs(Date.now() / 1000 - timestamp) > tolerance) return false;

  const expected = createHmac("sha256", params.secret)
    .update(`${timestamp}.${params.body}`)
    .digest("hex");

  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Queues an event to every endpoint of every app holding an active grant on
 * this agent, and subscribed to it.
 *
 * Enqueueing never throws into the caller: a webhook that cannot be recorded
 * must not roll back the money movement that triggered it.
 */
export async function emitEvent(params: {
  agentId: string;
  event: WebhookEvent;
  data: Record<string, unknown>;
}): Promise<number> {
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: {
        active: true,
        events: { has: params.event },
        devApp: {
          grants: { some: { agentId: params.agentId, status: "active" } },
        },
      },
    });

    if (endpoints.length === 0) return 0;

    const payload = {
      id: `evt_${randomUUID()}`,
      type: params.event,
      created_at: new Date().toISOString(),
      data: params.data,
    };

    await prisma.webhookDelivery.createMany({
      data: endpoints.map((endpoint) => ({
        endpointId: endpoint.id,
        event: params.event,
        payload: payload as Prisma.InputJsonValue,
        status: "pending",
        nextAttemptAt: new Date(),
      })),
    });

    return endpoints.length;
  } catch (error) {
    console.error("Failed to enqueue webhook:", error);
    return 0;
  }
}

/** Sends one delivery and records the outcome. Never throws. */
export async function attemptDelivery(deliveryId: string) {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });
  if (!delivery || delivery.status === "delivered") return;

  const attempt = delivery.attempts + 1;
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);

  let responseCode: number | null = null;
  let delivered = false;

  try {
    // Re-checked here, not just at registration: a hostname that resolved
    // publicly then can be re-pointed at an internal address afterwards.
    await assertPublicDestination(delivery.endpoint.url);

    const response = await fetch(delivery.endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Skyborn-Signature": signPayload({
          secret: delivery.endpoint.secret,
          timestamp,
          body,
        }),
        "Skyborn-Event": delivery.event,
        "Skyborn-Delivery": delivery.id,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    responseCode = response.status;
    delivered = response.ok;
  } catch {
    // Timeout, DNS failure, refused connection, or a destination that now
    // resolves somewhere internal — all just a failed attempt.
    responseCode = null;
  }

  const exhausted = !delivered && attempt >= MAX_ATTEMPTS;

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts: attempt,
      status: delivered ? "delivered" : exhausted ? "failed" : "pending",
      responseCode,
      lastAttemptAt: new Date(),
      nextAttemptAt:
        delivered || exhausted
          ? null
          : new Date(Date.now() + BACKOFF_SECONDS[attempt] * 1000),
    },
  });

  return { delivered, attempt, responseCode };
}

/**
 * The worker loop. Whatever schedules it — BullMQ, a cron, a serverless timer —
 * calls this; the retry schedule itself lives in the database so a restart
 * cannot lose the backlog.
 */
export async function runDueDeliveries(limit = 50) {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: "pending", nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: { id: true },
  });

  const results = await Promise.allSettled(due.map((d) => attemptDelivery(d.id)));
  return {
    processed: due.length,
    delivered: results.filter(
      (r) => r.status === "fulfilled" && r.value?.delivered,
    ).length,
  };
}

export async function listDeliveries(devAppId: string, limit = 50) {
  return prisma.webhookDelivery.findMany({
    where: { endpoint: { devAppId } },
    include: { endpoint: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
