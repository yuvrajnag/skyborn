import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, it } from "node:test";

import { prisma } from "@/lib/prisma";
import { approveGrant, revokeGrantById } from "@/server/grants";
import {
  MAX_ATTEMPTS,
  WebhookError,
  attemptDelivery,
  createEndpoint,
  emitEvent,
  runDueDeliveries,
  signPayload,
  verifySignature,
} from "@/server/webhooks";
import { makeAgent } from "./helpers";
import { approvedGrant } from "./auth.test";

after(async () => {
  await prisma.$disconnect();
});

/** A receiver that records what arrived and answers with a chosen status. */
function receiver(status = 200) {
  const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(status);
      res.end("ok");
    });
  });
  const ready = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
  return { received, ready, close: () => server.close() };
}

describe("endpoint registration", () => {
  it("refuses plain http on a non-loopback host", async () => {
    const built = await approvedGrant();
    await assert.rejects(
      createEndpoint({
        devAppId: built.devApp.id,
        url: "http://hooks.example.com/x",
        events: ["grant.approved"],
      }),
      (e: WebhookError) => e.code === "INSECURE_URL",
    );
  });

  it("refuses an endpoint subscribed to nothing known", async () => {
    const built = await approvedGrant();
    await assert.rejects(
      createEndpoint({
        devAppId: built.devApp.id,
        url: "https://hooks.example.com/x",
        events: ["not.a.real.event"],
      }),
      (e: WebhookError) => e.code === "NO_EVENTS",
    );
  });

  it("returns a secret once", async () => {
    const built = await approvedGrant();
    const { endpoint, secret } = await createEndpoint({
      devAppId: built.devApp.id,
      url: "https://hooks.example.com/x",
      events: ["grant.approved", "wallet.transfer"],
    });
    assert.ok(secret.startsWith("sky_whsec_"));
    assert.equal(endpoint.events.length, 2);
  });
});

describe("signatures", () => {
  it("round-trips", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ hello: "world" });
    const header = signPayload({ secret: "sh", timestamp, body });
    assert.equal(verifySignature({ secret: "sh", header, body }), true);
  });

  it("rejects a tampered body", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signPayload({ secret: "sh", timestamp, body: '{"amount":"100"}' });
    assert.equal(
      verifySignature({ secret: "sh", header, body: '{"amount":"999999"}' }),
      false,
    );
  });

  it("rejects the wrong secret", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = "{}";
    const header = signPayload({ secret: "right", timestamp, body });
    assert.equal(verifySignature({ secret: "wrong", header, body }), false);
  });

  it("rejects a replay outside the tolerance window", () => {
    const old = Math.floor(Date.now() / 1000) - 10_000;
    const body = "{}";
    const header = signPayload({ secret: "sh", timestamp: old, body });
    assert.equal(verifySignature({ secret: "sh", header, body }), false);
    // Still verifiable if a receiver deliberately widens the window.
    assert.equal(
      verifySignature({ secret: "sh", header, body, toleranceSeconds: 20_000 }),
      true,
    );
  });
});

describe("delivery", () => {
  it("delivers a signed, verifiable payload", async () => {
    const built = await approvedGrant();
    const listener = receiver(200);
    const port = await listener.ready;

    const { endpoint, secret } = await createEndpoint({
      devAppId: built.devApp.id,
      url: `http://127.0.0.1:${port}/hook`,
      events: ["wallet.transfer"],
    });

    await emitEvent({
      agentId: built.agent.id,
      event: "wallet.transfer",
      data: { amountPaise: "5000" },
    });

    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { endpointId: endpoint.id },
    });
    const result = await attemptDelivery(delivery.id);

    assert.equal(result?.delivered, true);
    assert.equal(listener.received.length, 1);

    const sent = listener.received[0];
    assert.equal(sent.headers["skyborn-event"], "wallet.transfer");
    assert.ok(
      verifySignature({
        secret,
        header: String(sent.headers["skyborn-signature"]),
        body: sent.body,
      }),
      "receiver must be able to verify the signature",
    );

    const payload = JSON.parse(sent.body);
    assert.equal(payload.type, "wallet.transfer");
    assert.ok(payload.id.startsWith("evt_"));

    listener.close();
  });

  it("retries with backoff and gives up after the last attempt", async () => {
    const built = await approvedGrant();
    const listener = receiver(500);
    const port = await listener.ready;

    const { endpoint } = await createEndpoint({
      devAppId: built.devApp.id,
      url: `http://127.0.0.1:${port}/hook`,
      events: ["grant.revoked"],
    });

    await emitEvent({ agentId: built.agent.id, event: "grant.revoked", data: {} });
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { endpointId: endpoint.id },
    });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // Force it due, so the schedule does not have to be waited out.
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { nextAttemptAt: new Date() },
      });
      await attemptDelivery(delivery.id);
    }

    const final = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    assert.equal(final.attempts, MAX_ATTEMPTS);
    assert.equal(final.status, "failed");
    assert.equal(final.nextAttemptAt, null, "a failed delivery stops being due");
    assert.equal(listener.received.length, MAX_ATTEMPTS);

    listener.close();
  });

  it("does not retry one that already succeeded", async () => {
    const built = await approvedGrant();
    const listener = receiver(200);
    const port = await listener.ready;

    const { endpoint } = await createEndpoint({
      devAppId: built.devApp.id,
      url: `http://127.0.0.1:${port}/hook`,
      events: ["wallet.topup"],
    });
    await emitEvent({ agentId: built.agent.id, event: "wallet.topup", data: {} });

    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { endpointId: endpoint.id },
    });
    await attemptDelivery(delivery.id);
    await attemptDelivery(delivery.id);

    assert.equal(listener.received.length, 1);
    listener.close();
  });

  it("only reaches apps holding an active grant on that agent", async () => {
    const mine = await approvedGrant();
    const stranger = await approvedGrant();

    const listener = receiver(200);
    const port = await listener.ready;
    await createEndpoint({
      devAppId: stranger.devApp.id,
      url: `http://127.0.0.1:${port}/hook`,
      events: ["wallet.transfer"],
    });

    // An event on MY agent must not reach an app granted over a different one.
    const queued = await emitEvent({
      agentId: mine.agent.id,
      event: "wallet.transfer",
      data: {},
    });

    assert.equal(queued, 0);
    listener.close();
  });

  it("stops reaching an app once its grant is revoked", async () => {
    const built = await approvedGrant();
    const listener = receiver(200);
    const port = await listener.ready;

    await createEndpoint({
      devAppId: built.devApp.id,
      url: `http://127.0.0.1:${port}/hook`,
      events: ["wallet.transfer"],
    });

    assert.equal(
      await emitEvent({ agentId: built.agent.id, event: "wallet.transfer", data: {} }),
      1,
    );

    await revokeGrantById(built.grant.id);

    assert.equal(
      await emitEvent({ agentId: built.agent.id, event: "wallet.transfer", data: {} }),
      0,
      "a revoked grant must stop the event stream too",
    );

    listener.close();
  });

  it("never lets a webhook failure break the action that caused it", async () => {
    const built = await approvedGrant();
    // A URL that cannot resolve. emitEvent must still return cleanly.
    await createEndpoint({
      devAppId: built.devApp.id,
      url: "https://this-host-does-not-exist.invalid/hook",
      events: ["wallet.payout"],
    });

    const queued = await emitEvent({
      agentId: built.agent.id,
      event: "wallet.payout",
      data: {},
    });
    assert.equal(queued, 1);

    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { event: "wallet.payout", endpoint: { devAppId: built.devApp.id } },
    });
    const result = await attemptDelivery(delivery.id);
    assert.equal(result?.delivered, false);
  });
});

describe("grant.approved fires on approval", () => {
  it("reaches a subscribed endpoint", async () => {
    const { user, agent } = await makeAgent("Webhook Agent");
    const built = await approvedGrant();

    // Point the app at a receiver, then approve a fresh grant on its agent.
    const listener = receiver(200);
    const port = await listener.ready;
    await createEndpoint({
      devAppId: built.devApp.id,
      url: `http://127.0.0.1:${port}/hook`,
      events: ["grant.approved"],
    });

    const grant = await prisma.grant.create({
      data: {
        devAppId: built.devApp.id,
        agentId: agent.id,
        scopes: ["wallet:read"],
        status: "pending",
      },
    });
    await approveGrant({ grantId: grant.id, approvingUserId: user.id });

    const queued = await prisma.webhookDelivery.count({
      where: { event: "grant.approved", endpoint: { devAppId: built.devApp.id } },
    });
    assert.ok(queued >= 1, "approval must enqueue grant.approved");

    const { processed } = await runDueDeliveries(10);
    assert.ok(processed >= 1);

    listener.close();
  });
});
