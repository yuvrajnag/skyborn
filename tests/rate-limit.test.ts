import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import { prisma } from "@/lib/prisma";
import { ACTIONS } from "@/lib/catalogue";
import { RateLimitError, consumeRateLimit, pruneRateLimitCounters } from "@/server/rate-limit";
import { walletBalance } from "@/server/core";
import { authenticateBearer } from "@/server/grants";
import { approvedGrant } from "./auth.test";

after(async () => {
  await prisma.$disconnect();
});

describe("rate limiting", () => {
  it("allows up to the limit and refuses the next call", async () => {
    const grantId = `test-grant-${Date.now()}`;

    for (let i = 0; i < 5; i += 1) {
      await consumeRateLimit({ grantId, action: "test.action", perMinute: 5 });
    }

    await assert.rejects(
      consumeRateLimit({ grantId, action: "test.action", perMinute: 5 }),
      (e: RateLimitError) => e.code === "RATE_LIMITED" && e.status === 429,
    );
  });

  it("tells the caller when to come back", async () => {
    const grantId = `retry-after-${Date.now()}`;
    await consumeRateLimit({ grantId, action: "a", perMinute: 1 });

    await assert.rejects(
      consumeRateLimit({ grantId, action: "a", perMinute: 1 }),
      (e: RateLimitError) => {
        assert.ok(e.retryAfterSeconds >= 1 && e.retryAfterSeconds <= 60);
        return true;
      },
    );
  });

  it("keeps buckets separate per action and per grant", async () => {
    const stamp = Date.now();
    const a = `grant-a-${stamp}`;
    const b = `grant-b-${stamp}`;

    await consumeRateLimit({ grantId: a, action: "one", perMinute: 1 });

    // A different action on the same grant has its own bucket.
    await consumeRateLimit({ grantId: a, action: "two", perMinute: 1 });
    // And a different grant is entirely unaffected.
    await consumeRateLimit({ grantId: b, action: "one", perMinute: 1 });

    await assert.rejects(consumeRateLimit({ grantId: a, action: "one", perMinute: 1 }));
  });

  it("holds under concurrent calls", async () => {
    const grantId = `race-${Date.now()}`;

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        consumeRateLimit({ grantId, action: "race", perMinute: 5 }),
      ),
    );

    const allowed = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(allowed, 5, `exactly 5 should pass, ${allowed} did`);
  });

  it("applies to a real action through the core layer", async () => {
    const built = await approvedGrant({ scopes: ["wallet:read"] });
    const grant = await authenticateBearer(built.tokens.accessToken);
    const limit = ACTIONS.find((a) => a.name === "wallet.balance")!.rateLimit.perMinute;

    for (let i = 0; i < limit; i += 1) {
      await walletBalance({ grant });
    }

    await assert.rejects(
      walletBalance({ grant }),
      (e: RateLimitError) => e.code === "RATE_LIMITED",
    );
  });

  it("prunes closed windows", async () => {
    await prisma.rateLimitCounter.create({
      data: {
        bucketKey: `old-${Date.now()}`,
        windowStart: new Date(Date.now() - 60 * 60_000),
        count: 1,
      },
    });
    assert.ok((await pruneRateLimitCounters(10)) >= 1);
  });
});

describe("the two surfaces agree on limits", () => {
  it("every REST limit matches its RATE_LIMIT line in auth.flow", () => {
    const flow = readFileSync(
      path.join(process.cwd(), "axl/flow/auth.flow"),
      "utf8",
    );

    // RATE_LIMIT wallet_transfer : 20/min
    const declared = new Map<string, number>();
    for (const match of flow.matchAll(/RATE_LIMIT\s+(\w+)\s*:\s*(\d+)\/min/g)) {
      declared.set(match[1], Number(match[2]));
    }

    assert.ok(declared.size > 0, "auth.flow must declare rate limits");

    for (const action of ACTIONS) {
      // wallet.transfer in the catalogue is wallet_transfer in .flow.
      const flowName = action.name.replace(/\./g, "_");
      const flowLimit = declared.get(flowName);

      assert.ok(
        flowLimit !== undefined,
        `${action.name} has no RATE_LIMIT in auth.flow — the AXL surface would run it unlimited`,
      );
      assert.equal(
        flowLimit,
        action.rateLimit.perMinute,
        `${action.name}: auth.flow says ${flowLimit}/min but the REST surface enforces ${action.rateLimit.perMinute}/min`,
      );
    }
  });

  it("declares a permission for every action, so none is reachable unauthenticated", () => {
    const flow = readFileSync(path.join(process.cwd(), "axl/flow/auth.flow"), "utf8");

    for (const action of ACTIONS) {
      const flowName = action.name.replace(/\./g, "_");
      const permission = flow.match(
        new RegExp(`PERMISSION\\s+${flowName}\\s*:\\s*(\\w+)`),
      );
      assert.ok(permission, `${action.name} has no PERMISSION line in auth.flow`);
      assert.notEqual(
        permission[1],
        "PUBLIC",
        `${action.name} is PUBLIC — that is an unauthenticated proxy to a wallet`,
      );
    }
  });
});

describe("REST and AXL are one surface, not two", () => {
  /**
   * The spec's central worry (Section 8) is the wallet logic existing more than
   * once. It does not: AXL holds no handlers, only declarations, and forwards
   * every call to the same /api/v1 route a direct caller hits, which is a thin
   * wrapper over the one core function.
   *
   * These tests pin that down, so nobody can add an action to one and not the
   * other, or point them at different endpoints.
   */
  const flowDir = path.join(process.cwd(), "axl/flow");
  const actionsFlow = readFileSync(path.join(flowDir, "actions.flow"), "utf8");
  const resourcesFlow = readFileSync(path.join(flowDir, "resources.flow"), "utf8");
  const flow = `${actionsFlow}\n${resourcesFlow}`;

  /** name -> "METHOD /path", parsed straight out of the .flow files. */
  function declaredEndpoints(): Map<string, string> {
    const out = new Map<string, string>();
    // ACTION wallet_transfer ... ENDPOINT POST /api/v1/wallet/transfer
    const blocks = flow.split(/^(?=ACTION |RESOURCE )/m);
    for (const block of blocks) {
      const name = block.match(/^(?:ACTION|RESOURCE)\s+(\w+)/)?.[1];
      const endpoint = block.match(/ENDPOINT\s+(GET|POST|PATCH|PUT|DELETE)\s+(\S+)/);
      if (name && endpoint) out.set(name, `${endpoint[1]} ${endpoint[2]}`);
    }
    return out;
  }

  it("declares exactly the actions the catalogue declares", () => {
    const declared = [...declaredEndpoints().keys()].sort();
    const catalogued = ACTIONS.map((a) => a.name.replace(/\./g, "_")).sort();

    assert.deepEqual(
      declared,
      catalogued,
      "an action exists on one surface but not the other",
    );
  });

  it("points every AXL action at the same endpoint the REST surface serves", () => {
    const declared = declaredEndpoints();

    for (const action of ACTIONS) {
      const flowName = action.name.replace(/\./g, "_");
      assert.equal(
        declared.get(flowName),
        `${action.method} ${action.path}`,
        `${action.name}: AXL forwards to "${declared.get(flowName)}" but the REST surface serves "${action.method} ${action.path}"`,
      );
    }
  });

  it("has a real route file behind every declared endpoint", () => {
    for (const action of ACTIONS) {
      // /api/v1/wallet/transfer -> src/app/api/v1/wallet/transfer/route.ts
      const routeFile = path.join(process.cwd(), "src/app", action.path, "route.ts");
      assert.ok(
        existsSync(routeFile),
        `${action.name} declares ${action.path} but ${routeFile} does not exist — AXL would forward into a 404`,
      );
    }
  });

  it("keeps every route a thin wrapper, with no business logic of its own", () => {
    for (const action of ACTIONS) {
      const source = readFileSync(
        path.join(process.cwd(), "src/app", action.path, "route.ts"),
        "utf8",
      );

      // A route may parse input and call core. It must not reach for the
      // database, or it has started being a second implementation.
      assert.ok(
        !/\bprisma\./.test(source),
        `${action.path} touches prisma directly — business logic belongs in the core layer`,
      );
      assert.ok(
        /@\/server\/core/.test(source),
        `${action.path} does not call the core service layer`,
      );
    }
  });

  it("holds no handler logic in the AXL project at all", () => {
    const files = readdirSync(flowDir);
    assert.deepEqual(
      files.filter((f) => !f.endsWith(".flow")).sort(),
      [],
      "axl/flow should contain only declarations",
    );
  });
});
