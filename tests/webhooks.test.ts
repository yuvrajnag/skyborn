import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { after, describe, it } from "node:test";

import { prisma } from "@/lib/prisma";
import { approveGrant, revokeGrantById } from "@/server/grants";
import {
  MAX_ATTEMPTS,
  WebhookError,
  assertPublicDestination,
  postSignedJson,
  resolvePublicDestination,
  attemptDelivery,
  createEndpoint,
  emitEvent,
  isPrivateAddress,
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
        url: "https://example.com/hook",
        events: ["not.a.real.event"],
      }),
      (e: WebhookError) => e.code === "NO_EVENTS",
    );
  });

  it("returns a secret once", async () => {
    const built = await approvedGrant();
    const { endpoint, secret } = await createEndpoint({
      devAppId: built.devApp.id,
      url: "https://example.com/hook",
      events: ["grant.approved", "wallet.transfer"],
    });
    assert.ok(secret.startsWith("sky_whsec_"));
    assert.equal(endpoint.events.length, 2);
  });
});

describe("SSRF protection", () => {
  it("classifies internal address ranges as private", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // carrier-grade NAT
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1", // ipv4-mapped
      "not-an-ip",
    ]) {
      assert.equal(isPrivateAddress(ip), true, `${ip} must be treated as private`);
    }
  });

  it("lets real public addresses through", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"]) {
      assert.equal(isPrivateAddress(ip), false, `${ip} must be treated as public`);
    }
  });

  it("refuses a destination inside the network", async () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/internal",
      "https://192.168.1.1/admin",
      "https://172.16.0.1/x",
    ]) {
      await assert.rejects(
        assertPublicDestination(url),
        (e: WebhookError) => e.code === "PRIVATE_DESTINATION",
        `${url} must be refused`,
      );
    }
  });

  it("refuses to register a webhook pointed at cloud metadata", async () => {
    const built = await approvedGrant();
    await assert.rejects(
      createEndpoint({
        devAppId: built.devApp.id,
        url: "https://169.254.169.254/latest/meta-data/",
        events: ["grant.approved"],
      }),
      (e: WebhookError) => e.code === "PRIVATE_DESTINATION",
    );
  });

  it("refuses a host that does not resolve at all", async () => {
    await assert.rejects(
      assertPublicDestination("https://this-host-does-not-exist.invalid/hook"),
      (e: WebhookError) => e.code === "UNRESOLVABLE_HOST",
    );
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
    // A loopback port with nothing listening: registration passes, the delivery
    // fails, and emitEvent must still return cleanly either way.
    await createEndpoint({
      devAppId: built.devApp.id,
      url: "http://127.0.0.1:1/hook",
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

describe("DNS rebinding cannot redirect a delivery", () => {
  /**
   * Validating a hostname and then letting an HTTP client resolve it again is a
   * window, not a check: an attacker controlling the record with a short TTL
   * answers the validation with a public address and the connection with a
   * private one moments later.
   *
   * This proves the send uses the address that was validated. Two servers are
   * started on different loopback addresses; the URL's hostname resolves to the
   * first, but the second is pinned. If the pin is honoured, only the second
   * ever sees the request.
   */
  function listenOn(host: string) {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? "/");
      res.writeHead(200);
      res.end("ok");
    });
    const ready = new Promise<number>((resolve) =>
      server.listen(0, host, () => resolve((server.address() as { port: number }).port)),
    );
    return { hits, ready, close: () => server.close() };
  }

  it("sends to the validated address, not a fresh resolution", async () => {
    const resolved = listenOn("127.0.0.1"); // what the hostname resolves to
    const rebound = listenOn("127.0.0.2"); // where a rebind would send it
    const port = await resolved.ready;
    await rebound.ready;
    rebound.close();

    // Same port on the pinned address, so only the address differs.
    const attacker = http.createServer((req, res) => {
      rebound.hits.push(req.url ?? "/");
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => attacker.listen(port, "127.0.0.2", () => r()));

    const response = await postSignedJson({
      url: `http://localhost:${port}/hook`, // resolves to 127.0.0.1
      address: "127.0.0.2", // but this is what was validated
      family: 4,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ probe: true }),
      timeoutMs: 5_000,
    });

    assert.equal(response.status, 200);
    assert.equal(rebound.hits.length, 1, "the pinned address must receive the request");
    assert.equal(
      resolved.hits.length,
      0,
      "the address the hostname resolves to must not be contacted",
    );

    resolved.close();
    attacker.close();
  });

  it("returns the address it validated, so the caller can pin it", async () => {
    const destination = await resolvePublicDestination("https://example.com/hook");
    assert.ok(destination.address.length > 0);
    assert.equal(isPrivateAddress(destination.address), false);
    assert.ok(destination.family === 4 || destination.family === 6);
  });

  it("refuses before dialing when the validated address is internal", async () => {
    await assert.rejects(
      resolvePublicDestination("https://10.0.0.5/hook"),
      (e: WebhookError) => e.code === "PRIVATE_DESTINATION",
    );
  });

  it("preserves the hostname for SNI rather than swapping in the IP", async () => {
    // A URL rewritten to https://<ip>/ would fail certificate verification;
    // the pin must live in the lookup, not in the URL. Asserted structurally:
    // postSignedJson takes the address separately from the URL it is given.
    const source = readFileSync("src/server/webhooks.ts", "utf8");
    assert.match(source, /host: url\.hostname/);
    assert.ok(
      !/new URL\(`https?:\/\/\$\{.*address/.test(source),
      "the address must never be substituted into the URL",
    );
  });
});
