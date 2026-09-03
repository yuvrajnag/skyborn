import { NextResponse } from "next/server";

import { timingSafeEquals } from "@/lib/webhook-auth";
import { runDueDeliveries } from "@/server/webhooks";

/**
 * The delivery worker, exposed so a scheduler can drive it — a cron, a
 * serverless timer, or a BullMQ worker calling straight into
 * runDueDeliveries().
 *
 * The retry schedule lives in the database rather than in a queue's memory, so
 * a restart cannot drop the backlog and this route is safe to call as often as
 * the scheduler likes: it only picks up deliveries that are actually due.
 */
export async function POST(request: Request) {
  const expected = process.env.WEBHOOK_WORKER_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "WEBHOOK_WORKER_SECRET is not configured on this deployment." },
      { status: 503 },
    );
  }

  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!timingSafeEquals(provided, expected)) {
    return NextResponse.json({ error: "Bad worker secret." }, { status: 401 });
  }

  const result = await runDueDeliveries();
  return NextResponse.json(result);
}
