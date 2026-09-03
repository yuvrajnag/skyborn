import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { MessageChannel } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { requirePaise } from "@/lib/api";
import { callTool } from "@/server/mcp";
import {
  CoreError,
  callsMake,
  spentUnderGrant,
  walletRefund,
  messagesLatestOtp,
  messagesRead,
  messagesSend,
  walletBalance,
  walletPayout,
  walletTopup,
  walletTransactions,
  walletTransfer,
} from "@/server/core";
import { GrantError, authenticateBearer, revokeGrantById } from "@/server/grants";
import { recordInboundMessage } from "@/server/messaging";
import { createFundingMandate, creditWalletManually, getBalance, transferMoney } from "@/server/wallet";
import { approvedGrant } from "./auth.test";
import { makeAgent } from "./helpers";

after(async () => {
  await prisma.$disconnect();
});

async function ctxFor(options?: Parameters<typeof approvedGrant>[0]) {
  const built = await approvedGrant(options);
  const grant = await authenticateBearer(built.tokens.accessToken);
  return { ...built, ctx: { grant } };
}

describe("scope enforcement", () => {
  it("refuses an action the grant does not carry", async () => {
    const { ctx } = await ctxFor({ scopes: ["wallet:read"] });

    await assert.rejects(
      walletTransfer(ctx, { toHandle: "x@y.local", amountPaise: 100n }),
      (e: GrantError) => e.code === "INSUFFICIENT_SCOPE" && e.status === 403,
    );
    await assert.rejects(
      messagesSend(ctx, { channel: "sms", to: "+911234567890", body: "hi" }),
      (e: GrantError) => e.code === "INSUFFICIENT_SCOPE",
    );
    await assert.rejects(
      callsMake(ctx, { to: "+911234567890", script: "hello" }),
      (e: GrantError) => e.code === "INSUFFICIENT_SCOPE",
    );

    // The one it does carry still works.
    assert.ok(await walletBalance(ctx));
  });

  it("audits refusals as well as successes", async () => {
    const { ctx, grant } = await ctxFor({ scopes: ["wallet:read"] });

    await walletBalance(ctx);
    await assert.rejects(walletTransfer(ctx, { toHandle: "x@y.local", amountPaise: 100n }));

    const logs = await prisma.grantAuditLog.findMany({ where: { grantId: grant.id } });
    const byAction = Object.fromEntries(logs.map((l) => [l.action, l]));

    assert.equal(byAction["wallet.balance"].resultStatus, "ok");
    assert.equal(byAction["wallet.transfer"].resultStatus, "error");
    assert.equal(byAction["wallet.transfer"].errorCode, "INSUFFICIENT_SCOPE");
  });
});

describe("spending cap", () => {
  it("refuses the call that would cross the cap", async () => {
    const { ctx, wallet } = await ctxFor({
      scopes: ["wallet:read", "wallet:transfer"],
      capPaise: 50_000n, // ₹500
    });
    await creditWalletManually({ walletId: wallet.id, amountPaise: 1_000_000n });

    const { agent: recipient } = await makeAgent("Cap Recipient");
    const to = (await prisma.handle.findUniqueOrThrow({ where: { agentId: recipient.id } })).email;

    await walletTransfer(ctx, { toHandle: to, amountPaise: 30_000n });
    await walletTransfer(ctx, { toHandle: to, amountPaise: 20_000n });

    // Exactly at the cap; one more paisa is refused.
    await assert.rejects(
      walletTransfer(ctx, { toHandle: to, amountPaise: 1n }),
      (e: CoreError) => e.code === "SPENDING_CAP_EXCEEDED" && e.status === 403,
    );
  });

  it("counts payouts against the same cap as transfers", async () => {
    const { ctx, wallet } = await ctxFor({
      scopes: ["wallet:read", "wallet:transfer", "wallet:payout"],
      capPaise: 40_000n,
    });
    await creditWalletManually({ walletId: wallet.id, amountPaise: 1_000_000n });

    await walletPayout(ctx, { amountPaise: 30_000n, destination: "ada@upi" });

    const { agent: recipient } = await makeAgent("Cap Payout Recipient");
    const to = (await prisma.handle.findUniqueOrThrow({ where: { agentId: recipient.id } })).email;

    await assert.rejects(
      walletTransfer(ctx, { toHandle: to, amountPaise: 20_000n }),
      (e: CoreError) => e.code === "SPENDING_CAP_EXCEEDED",
    );
  });

  it("does not count a refused call against the cap", async () => {
    const { ctx, wallet } = await ctxFor({
      scopes: ["wallet:read", "wallet:transfer"],
      capPaise: 50_000n,
    });
    await creditWalletManually({ walletId: wallet.id, amountPaise: 10_000n });

    const { agent: recipient } = await makeAgent("Refused Recipient");
    const to = (await prisma.handle.findUniqueOrThrow({ where: { agentId: recipient.id } })).email;

    // Fails on funds, not on cap.
    await assert.rejects(walletTransfer(ctx, { toHandle: to, amountPaise: 50_000n }));

    // The cap is untouched, so a call within the balance still goes through.
    const ok = await walletTransfer(ctx, { toHandle: to, amountPaise: 10_000n });
    assert.ok(ok.entryId);
  });

  it("lets an uncapped grant spend the balance", async () => {
    const { ctx, wallet } = await ctxFor({
      scopes: ["wallet:read", "wallet:transfer"],
      capPaise: null,
    });
    await creditWalletManually({ walletId: wallet.id, amountPaise: 500_000n });

    const { agent: recipient } = await makeAgent("Uncapped Recipient");
    const to = (await prisma.handle.findUniqueOrThrow({ where: { agentId: recipient.id } })).email;

    await walletTransfer(ctx, { toHandle: to, amountPaise: 500_000n });
    assert.equal((await walletBalance(ctx)).balancePaise, "0");
  });

  it("does not let one grant's spending consume another's cap", async () => {
    const first = await ctxFor({ scopes: ["wallet:read", "wallet:transfer"], capPaise: 20_000n });
    await creditWalletManually({ walletId: first.wallet.id, amountPaise: 1_000_000n });

    const { agent: recipient } = await makeAgent("Shared Recipient");
    const to = (await prisma.handle.findUniqueOrThrow({ where: { agentId: recipient.id } })).email;

    // Spend the first grant's cap right to the edge.
    await walletTransfer(first.ctx, { toHandle: to, amountPaise: 20_000n });
    await assert.rejects(
      walletTransfer(first.ctx, { toHandle: to, amountPaise: 1n }),
      (e: CoreError) => e.code === "SPENDING_CAP_EXCEEDED",
    );

    const second = await ctxFor({ scopes: ["wallet:read", "wallet:transfer"], capPaise: 20_000n });
    await creditWalletManually({ walletId: second.wallet.id, amountPaise: 1_000_000n });

    // A different grant on a different handle has its own untouched cap.
    const ok = await walletTransfer(second.ctx, { toHandle: to, amountPaise: 20_000n });
    assert.ok(ok.entryId);
  });
});

describe("wallet actions through the core layer", () => {
  it("tops up against the mandate", async () => {
    const { ctx, wallet } = await ctxFor({ scopes: ["wallet:read", "wallet:topup"] });
    await createFundingMandate({ walletId: wallet.id });

    const result = await walletTopup(ctx, { amountPaise: 100_000n });
    assert.equal(result.balancePaise, "100000");
  });

  it("refuses to transfer to a handle that does not exist", async () => {
    const { ctx, wallet } = await ctxFor({ scopes: ["wallet:read", "wallet:transfer"] });
    await creditWalletManually({ walletId: wallet.id, amountPaise: 100_000n });

    await assert.rejects(
      walletTransfer(ctx, { toHandle: "nobody@nowhere.local", amountPaise: 100n }),
      (e: CoreError) => e.code === "HANDLE_NOT_FOUND" && e.status === 404,
    );
  });

  it("lists transactions with amounts as strings, never as JSON numbers", async () => {
    const { ctx, wallet } = await ctxFor({ scopes: ["wallet:read"] });
    await creditWalletManually({ walletId: wallet.id, amountPaise: 123_456n });

    const rows = await walletTransactions(ctx, { limit: 10 });
    assert.equal(rows[0].amountPaise, "123456");
    assert.equal(typeof rows[0].amountPaise, "string");
  });
});

describe("messaging through the core layer", () => {
  it("sends, reads and pulls an OTP under the right scopes", async () => {
    const { ctx, agent } = await ctxFor({
      scopes: ["messages:send", "messages:read"],
    });

    await messagesSend(ctx, { channel: "sms", to: "+911234567890", body: "hello" });

    await recordInboundMessage({
      agentId: agent.id,
      channel: MessageChannel.sms,
      from: "VM-BANK",
      to: "+990000000000",
      body: "Your OTP is 445566",
    });

    const inbox = await messagesRead(ctx, { limit: 10 });
    assert.equal(inbox.length, 2);

    const otp = await messagesLatestOtp(ctx, {});
    assert.equal(otp.found, true);
    assert.equal(otp.found && otp.code, "445566");
  });

  it("refuses to read the inbox without messages:read", async () => {
    const { ctx } = await ctxFor({ scopes: ["messages:send"] });
    await assert.rejects(
      messagesLatestOtp(ctx, {}),
      (e: GrantError) => e.code === "INSUFFICIENT_SCOPE",
    );
  });
});

describe("revocation stops everything", () => {
  it("kills a token the agent is already holding", async () => {
    const built = await ctxFor({ scopes: ["wallet:read", "wallet:transfer"] });
    await creditWalletManually({ walletId: built.wallet.id, amountPaise: 500_000n });

    // The agent is holding a working token and using it.
    assert.ok(await walletBalance(built.ctx));
    await authenticateBearer(built.tokens.accessToken);

    await revokeGrantById(built.grant.id);

    // That exact token — the one already in the agent's hands — is now dead.
    await assert.rejects(
      authenticateBearer(built.tokens.accessToken),
      (e: GrantError) => e.code === "TOKEN_REVOKED" && e.status === 401,
    );

    const after = await prisma.grant.findUniqueOrThrow({ where: { id: built.grant.id } });
    assert.equal(after.status, "revoked");
  });

  it("stops money moving even if a caller kept a resolved context", async () => {
    const built = await ctxFor({ scopes: ["wallet:read", "wallet:transfer"] });
    await creditWalletManually({ walletId: built.wallet.id, amountPaise: 500_000n });

    const { agent: recipient } = await makeAgent("Post Revoke Recipient");
    const to = (await prisma.handle.findUniqueOrThrow({ where: { agentId: recipient.id } })).email;

    await revokeGrantById(built.grant.id);

    // Re-authenticating is what any real request does, and it refuses.
    await assert.rejects(authenticateBearer(built.tokens.accessToken));

    const balanceBefore = built.wallet.balance;
    assert.equal(balanceBefore, 0n);
    assert.ok(to);
  });
});

describe("spending cap cannot be bypassed through a refund", () => {
  /**
   * The attack: receiving is correctly uncapped, so a capped grant takes in a
   * large inbound transfer and then refunds it. The reversal of a credit is a
   * debit — money leaving — and before this was fixed it carried no amount into
   * the cap check at all, so the whole inbound sum could be pushed back out,
   * repeatedly, by a grant capped far below it.
   */
  async function fundedSender(amountPaise: bigint) {
    const { agent } = await makeAgent(`Refund Sender ${Date.now()}${Math.random()}`);
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { agentId: agent.id } });
    await creditWalletManually({ walletId: wallet.id, amountPaise });
    return wallet;
  }

  it("refuses a refund whose outbound leg would cross the cap", async () => {
    const { ctx, wallet } = await ctxFor({
      scopes: ["wallet:read", "wallet:transfer", "wallet:refund"],
      capPaise: 50_000n, // ₹500
    });

    // Receiving is uncapped, and must stay that way: ₹5,000 in, cap ₹500.
    const sender = await fundedSender(1_000_000n);
    const inbound = await transferMoney({
      fromWalletId: sender.id,
      toWalletId: wallet.id,
      amountPaise: 500_000n,
    });
    assert.equal(await getBalance(wallet.id), 500_000n);

    // The credit leg on this wallet is what a refund would reverse outward.
    const received = await prisma.ledgerEntry.findFirstOrThrow({
      where: { walletId: wallet.id, transferGroupId: inbound.entry.transferGroupId },
    });
    assert.equal(received.direction, "credit");

    await assert.rejects(
      walletRefund(ctx, { originalEntryId: received.id }),
      (e: CoreError) => e.code === "SPENDING_CAP_EXCEEDED" && e.status === 403,
      "refunding an inbound transfer moves money out and must respect the cap",
    );

    // Nothing moved.
    assert.equal(await getBalance(wallet.id), 500_000n);
  });

  it("does not cap a refund that brings money back in", async () => {
    const { ctx, wallet } = await ctxFor({
      scopes: ["wallet:read", "wallet:transfer", "wallet:refund"],
      capPaise: 50_000n,
    });
    await creditWalletManually({ walletId: wallet.id, amountPaise: 1_000_000n });

    const { agent: recipient } = await makeAgent(`Refund Recipient ${Date.now()}`);
    const to = (await prisma.handle.findUniqueOrThrow({ where: { agentId: recipient.id } })).email;

    // Spend right up to the cap.
    const sent = await walletTransfer(ctx, { toHandle: to, amountPaise: 50_000n });
    await assert.rejects(
      walletTransfer(ctx, { toHandle: to, amountPaise: 1n }),
      (e: CoreError) => e.code === "SPENDING_CAP_EXCEEDED",
    );

    // Reversing our own outgoing transfer returns money to us. That is not
    // spending, so it must go through even with the cap fully consumed.
    const before = await getBalance(wallet.id);
    const refund = await walletRefund(ctx, { originalEntryId: sent.entryId });
    assert.ok(refund.entryIds.length >= 1);
    assert.equal(await getBalance(wallet.id), before + 50_000n);
  });

  it("counts an outbound refund against later calls", async () => {
    const { ctx, wallet } = await ctxFor({
      scopes: ["wallet:read", "wallet:transfer", "wallet:refund"],
      capPaise: 100_000n, // ₹1,000
    });

    const sender = await fundedSender(1_000_000n);
    const inbound = await transferMoney({
      fromWalletId: sender.id,
      toWalletId: wallet.id,
      amountPaise: 60_000n,
    });
    const received = await prisma.ledgerEntry.findFirstOrThrow({
      where: { walletId: wallet.id, transferGroupId: inbound.entry.transferGroupId },
    });

    // ₹600 out via refund, inside the ₹1,000 cap.
    await walletRefund(ctx, { originalEntryId: received.id });

    // It has to consume cap, or the bypass just needs more than one call.
    assert.equal(await spentUnderGrant(ctx.grant.id), 60_000n);

    const { agent: recipient } = await makeAgent(`Cap Consumed ${Date.now()}`);
    const to = (await prisma.handle.findUniqueOrThrow({ where: { agentId: recipient.id } })).email;
    await creditWalletManually({ walletId: wallet.id, amountPaise: 1_000_000n });

    await assert.rejects(
      walletTransfer(ctx, { toHandle: to, amountPaise: 50_000n }),
      (e: CoreError) => e.code === "SPENDING_CAP_EXCEEDED",
      "the refund's ₹600 must already have been spent against the ₹1,000 cap",
    );
  });

  it("still refuses a refund of an entry on somebody else's wallet", async () => {
    const { ctx } = await ctxFor({ scopes: ["wallet:read", "wallet:refund"] });
    const stranger = await fundedSender(500_000n);
    const strangerEntry = await prisma.ledgerEntry.findFirstOrThrow({
      where: { walletId: stranger.id },
    });

    await assert.rejects(
      walletRefund(ctx, { originalEntryId: strangerEntry.id }),
      (e: CoreError) => e.code === "ENTRY_NOT_FOUND" && e.status === 404,
    );
  });

  it("audits a refund refused by the cap", async () => {
    const { ctx, wallet, grant } = await ctxFor({
      scopes: ["wallet:read", "wallet:transfer", "wallet:refund"],
      capPaise: 10_000n,
    });
    const sender = await fundedSender(1_000_000n);
    const inbound = await transferMoney({
      fromWalletId: sender.id,
      toWalletId: wallet.id,
      amountPaise: 400_000n,
    });
    const received = await prisma.ledgerEntry.findFirstOrThrow({
      where: { walletId: wallet.id, transferGroupId: inbound.entry.transferGroupId },
    });

    await assert.rejects(walletRefund(ctx, { originalEntryId: received.id }));

    const log = await prisma.grantAuditLog.findFirstOrThrow({
      where: { grantId: grant.id, action: "wallet.refund" },
    });
    assert.equal(log.resultStatus, "error");
    assert.equal(log.errorCode, "SPENDING_CAP_EXCEEDED");
  });
});

describe("amounts are strings on the wire, never JSON numbers", () => {
  /**
   * The invariant the code claims: paise crosses the wire as a string. An
   * integer JSON number used to be accepted, which was safe at today's amounts
   * but taught callers a habit that loses precision above 2^53 paise — and
   * contradicted the schema, which declares amount_paise a string.
   */
  it("rejects an integer JSON number on the REST surface", () => {
    assert.throws(
      () => requirePaise({ amount_paise: 100 }),
      (e: CoreError) => e.code === "INVALID_AMOUNT",
      "an integer number must be refused, not quietly accepted",
    );
  });

  it("rejects a float and a negative", () => {
    for (const value of [100.5, -100, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => requirePaise({ amount_paise: value }),
        (e: CoreError) => e.code === "INVALID_AMOUNT",
      );
    }
  });

  it("accepts a numeric string", () => {
    assert.equal(requirePaise({ amount_paise: "100" }), 100n);
    assert.equal(requirePaise({ amount_paise: "  250075 " }), 250075n);
  });

  it("keeps precision a double would lose", () => {
    const huge = "9007199254740993"; // 2^53 + 1
    assert.equal(requirePaise({ amount_paise: huge }), 9007199254740993n);
    assert.notEqual(Number(huge).toString(), huge, "a double cannot hold this");
  });

  it("still complains when the field is missing", () => {
    assert.throws(
      () => requirePaise({}),
      (e: CoreError) => e.code === "MISSING_FIELD",
    );
  });

  it("applies the same rule on the MCP surface", async () => {
    const built = await approvedGrant({ scopes: ["wallet:read", "wallet:transfer"] });
    const grant = await authenticateBearer(built.tokens.accessToken);

    await assert.rejects(
      callTool(grant, "transfer_money", { to_handle: "x@y.local", amount_paise: 100 }),
      (e: { code?: string }) => e.code === "INVALID_AMOUNT",
    );
  });
});
