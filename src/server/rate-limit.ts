import { prisma } from "@/lib/prisma";

/**
 * Per-grant rate limiting for the REST surface.
 *
 * AXL declares RATE_LIMIT for every action, but those limits only apply to
 * traffic that actually goes through the AXL engine. `/api/v1` is the canonical
 * surface and is reachable directly, so without this the declared limits are a
 * fiction for anyone calling it — and Section 8's whole point is that the two
 * surfaces cannot differ on a rule.
 *
 * Counters live in the database rather than in memory because the limit has to
 * hold across every instance serving the API; an in-memory counter silently
 * multiplies the real limit by however many instances are running.
 *
 * The window is fixed rather than sliding. A fixed window lets a caller send up
 * to 2× the limit across a boundary, which is an accepted cost here: this is a
 * blast-radius control, not an authorization check, and the spending cap is
 * what actually bounds financial damage.
 */

export class RateLimitError extends Error {
  readonly code = "RATE_LIMITED";
  readonly status = 429;

  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
  }
}

const WINDOW_MS = 60_000;

export async function consumeRateLimit(params: {
  grantId: string;
  action: string;
  perMinute: number;
}): Promise<void> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
  const bucketKey = `${params.grantId}:${params.action}`;

  // Upsert-with-increment is atomic on the unique (bucketKey, windowStart) row,
  // so concurrent calls cannot both read a count below the limit and both pass.
  const counter = await prisma.rateLimitCounter.upsert({
    where: { bucketKey_windowStart: { bucketKey, windowStart } },
    create: { bucketKey, windowStart, count: 1 },
    update: { count: { increment: 1 } },
  });

  if (counter.count > params.perMinute) {
    const retryAfter = Math.ceil((windowStart.getTime() + WINDOW_MS - now) / 1000);
    throw new RateLimitError(
      `Rate limit of ${params.perMinute}/min for ${params.action} exceeded.`,
      Math.max(retryAfter, 1),
    );
  }
}

/**
 * Drops counters for windows that have closed. Nothing reads them once the
 * window passes, so they are pure growth until something removes them.
 */
export async function pruneRateLimitCounters(olderThanMinutes = 10) {
  const cutoff = new Date(Date.now() - olderThanMinutes * WINDOW_MS);
  const { count } = await prisma.rateLimitCounter.deleteMany({
    where: { windowStart: { lt: cutoff } },
  });
  return count;
}
