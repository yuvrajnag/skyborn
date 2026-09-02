import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { LedgerEntryType, MandateStatus, PayoutStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { DEFAULT_MANDATE_CAP_PAISE, rupeesToPaise } from "@/lib/money";
import {
  MAX_MANDATE_PULL_PAISE,
  WalletError,
  createFundingMandate,
  createPayout,
  creditWalletManually,
  getBalance,
  reconcileBalance,
  refundTransaction,
  topupWallet,
  transferMoney,
} from "@/server/wallet";
import { makeAgent, makeLiveWallet } from "./helpers";

after(async () => {
  await prisma.$disconnect();
});

async function fundedWallet(amount = "10000") {
  const { wallet } = await makeAgent();
  await creditWalletManually({
    walletId: wallet.id,
    amountPaise: rupeesToPaise(amount),
  });
  return wallet;
}

describe("funding mandate", () => {
  it("defaults the cap to ₹15,000 and activates in sandbox", async () => {
    const { wallet } = await makeAgent();
    const mandate = await createFundingMandate({ walletId: wallet.id });

    assert.equal(mandate.capAmount, DEFAULT_MANDATE_CAP_PAISE);
    assert.equal(mandate.status, MandateStatus.active);
    assert.ok(mandate.providerRef?.startsWith("sim_mandate_"));
  });

  it("refuses a cap above ₹15,000, which would reintroduce OTP", async () => {
    const { wallet } = await makeAgent();
    await assert.rejects(
      createFundingMandate({
        walletId: wallet.id,
        capAmountPaise: MAX_MANDATE_PULL_PAISE + 1n,
      }),
      (e: WalletError) => e.code === "MANDATE_CAP_TOO_HIGH",
    );
  });

  it("refuses a second active mandate on one wallet", async () => {
    const { wallet } = await makeAgent();
    await createFundingMandate({ walletId: wallet.id });
    await assert.rejects(
      createFundingMandate({ walletId: wallet.id }),
      (e: WalletError) => e.code === "MANDATE_ALREADY_ACTIVE",
    );
  });
});

describe("topup", () => {
  it("pulls against the mandate with no OTP and credits the wallet", async () => {
    const { wallet } = await makeAgent();
    await createFundingMandate({ walletId: wallet.id });

    const { entry, replayed } = await topupWallet({
      walletId: wallet.id,
      amountPaise: rupeesToPaise("500"),
    });

    assert.equal(replayed, false);
    assert.equal(entry.type, LedgerEntryType.topup);
    assert.equal(await getBalance(wallet.id), 50_000n);
  });

  it("refuses without an active mandate", async () => {
    const { wallet } = await makeAgent();
    await assert.rejects(
      topupWallet({ walletId: wallet.id, amountPaise: 1000n }),
      (e: WalletError) => e.code === "NO_ACTIVE_MANDATE",
    );
  });

  it("refuses a pull above the mandate cap", async () => {
    const { wallet } = await makeAgent();
    await createFundingMandate({ walletId: wallet.id });
    await assert.rejects(
      topupWallet({ walletId: wallet.id, amountPaise: MAX_MANDATE_PULL_PAISE + 1n }),
      (e: WalletError) => e.code === "ABOVE_MANDATE_CAP",
    );
  });

  it("is idempotent — a retried key credits once", async () => {
    const { wallet } = await makeAgent();
    await createFundingMandate({ walletId: wallet.id });
    const key = `topup-${Date.now()}`;

    const first = await topupWallet({ walletId: wallet.id, amountPaise: 10_000n, idempotencyKey: key });
    const second = await topupWallet({ walletId: wallet.id, amountPaise: 10_000n, idempotencyKey: key });

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(first.entry.id, second.entry.id);
    assert.equal(await getBalance(wallet.id), 10_000n);
  });

  it("credits once when identical calls race", async () => {
    const { wallet } = await makeAgent();
    await createFundingMandate({ walletId: wallet.id });
    const key = `race-${Date.now()}`;

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        topupWallet({ walletId: wallet.id, amountPaise: 10_000n, idempotencyKey: key }),
      ),
    );

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
    assert.equal(await getBalance(wallet.id), 10_000n);
  });
});

describe("transfer", () => {
  it("moves money as a double-entry pair sharing one group id", async () => {
    const from = await fundedWallet("1000");
    const { wallet: to } = await makeAgent("Recipient");

    const { entry } = await transferMoney({
      fromWalletId: from.id,
      toWalletId: to.id,
      amountPaise: rupeesToPaise("250.50"),
    });

    assert.equal(await getBalance(from.id), 74_950n);
    assert.equal(await getBalance(to.id), 25_050n);

    const legs = await prisma.ledgerEntry.findMany({
      where: { transferGroupId: entry.transferGroupId! },
    });
    assert.equal(legs.length, 2);
    assert.deepEqual(
      legs.map((l) => l.type).sort(),
      [LedgerEntryType.transfer_in, LedgerEntryType.transfer_out],
    );
  });

  it("refuses to overdraw and leaves both wallets untouched", async () => {
    const from = await fundedWallet("100");
    const { wallet: to } = await makeAgent("Recipient");

    await assert.rejects(
      transferMoney({ fromWalletId: from.id, toWalletId: to.id, amountPaise: rupeesToPaise("500") }),
      (e: WalletError) => e.code === "INSUFFICIENT_FUNDS",
    );

    assert.equal(await getBalance(from.id), 10_000n);
    assert.equal(await getBalance(to.id), 0n);
    assert.equal(await prisma.ledgerEntry.count({ where: { walletId: to.id } }), 0);
  });

  it("refuses to cross sandbox and live", async () => {
    const from = await fundedWallet("1000");
    const { wallet: live } = await makeLiveWallet();

    await assert.rejects(
      transferMoney({ fromWalletId: from.id, toWalletId: live.id, amountPaise: 1000n }),
      (e: WalletError) => e.code === "MODE_MISMATCH",
    );
  });

  it("refuses a self-transfer", async () => {
    const wallet = await fundedWallet("1000");
    await assert.rejects(
      transferMoney({ fromWalletId: wallet.id, toWalletId: wallet.id, amountPaise: 1000n }),
      (e: WalletError) => e.code === "SELF_TRANSFER",
    );
  });

  it("never lets concurrent transfers overdraw the source", async () => {
    const from = await fundedWallet("100"); // ₹100
    const targets = await Promise.all(
      Array.from({ length: 6 }, (_, i) => makeAgent(`Target ${i}`)),
    );

    // Six concurrent ₹30 transfers against a ₹100 balance: at most three fit.
    const results = await Promise.allSettled(
      targets.map((t) =>
        transferMoney({
          fromWalletId: from.id,
          toWalletId: t.wallet.id,
          amountPaise: rupeesToPaise("30"),
        }),
      ),
    );

    const ok = results.filter((r) => r.status === "fulfilled").length;
    assert.ok(ok <= 3, `expected at most 3 to succeed, ${ok} did`);

    const balance = await getBalance(from.id);
    assert.ok(balance >= 0n, "balance went negative");
    assert.equal(balance, 10_000n - BigInt(ok) * 3_000n);
    assert.equal(balance, await reconcileBalance(from.id));
  });
});

describe("refund", () => {
  it("reverses a topup with a refund_out debit, leaving the original intact", async () => {
    const { wallet } = await makeAgent();
    await createFundingMandate({ walletId: wallet.id });
    const { entry } = await topupWallet({ walletId: wallet.id, amountPaise: 20_000n });

    const { entries } = await refundTransaction({ originalEntryId: entry.id });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, LedgerEntryType.refund_out);
    assert.equal(entries[0].originalEntryId, entry.id);
    assert.equal(await getBalance(wallet.id), 0n);

    const untouched = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: entry.id } });
    assert.equal(untouched.amount, 20_000n);
    assert.equal(untouched.type, LedgerEntryType.topup);
  });

  it("reverses both legs of a transfer together", async () => {
    const from = await fundedWallet("1000");
    const { wallet: to } = await makeAgent("Recipient");
    const { entry } = await transferMoney({
      fromWalletId: from.id,
      toWalletId: to.id,
      amountPaise: rupeesToPaise("400"),
    });

    const { entries } = await refundTransaction({ originalEntryId: entry.id });

    assert.equal(entries.length, 2);
    assert.equal(await getBalance(from.id), 100_000n);
    assert.equal(await getBalance(to.id), 0n);
  });

  it("fails the whole refund if the recipient has already spent it", async () => {
    const from = await fundedWallet("1000");
    const { wallet: to } = await makeAgent("Recipient");
    const { wallet: elsewhere } = await makeAgent("Elsewhere");

    const { entry } = await transferMoney({
      fromWalletId: from.id,
      toWalletId: to.id,
      amountPaise: rupeesToPaise("400"),
    });
    await transferMoney({
      fromWalletId: to.id,
      toWalletId: elsewhere.id,
      amountPaise: rupeesToPaise("400"),
    });

    await assert.rejects(
      refundTransaction({ originalEntryId: entry.id }),
      (e: WalletError) => e.code === "INSUFFICIENT_FUNDS",
    );

    // Neither leg was written — no half-applied refund.
    assert.equal(await getBalance(from.id), 60_000n);
    assert.equal(await getBalance(to.id), 0n);
  });

  it("refuses to refund twice", async () => {
    const { wallet } = await makeAgent();
    await createFundingMandate({ walletId: wallet.id });
    const { entry } = await topupWallet({ walletId: wallet.id, amountPaise: 20_000n });

    await refundTransaction({ originalEntryId: entry.id });
    await assert.rejects(
      refundTransaction({ originalEntryId: entry.id }),
      (e: WalletError) => e.code === "ALREADY_REFUNDED",
    );
  });

  it("refuses to refund a refund", async () => {
    const { wallet } = await makeAgent();
    await createFundingMandate({ walletId: wallet.id });
    const { entry } = await topupWallet({ walletId: wallet.id, amountPaise: 20_000n });
    const { entries } = await refundTransaction({ originalEntryId: entry.id });

    await assert.rejects(
      refundTransaction({ originalEntryId: entries[0].id }),
      (e: WalletError) => e.code === "CANNOT_REFUND_REFUND",
    );
  });
});

describe("payout", () => {
  it("debits the wallet and settles instantly in sandbox", async () => {
    const wallet = await fundedWallet("1000");

    const { payout, entry } = await createPayout({
      walletId: wallet.id,
      amountPaise: rupeesToPaise("300"),
      destination: "ada@upi",
    });

    assert.equal(payout?.status, PayoutStatus.settled);
    assert.equal(payout?.ledgerEntryId, entry.id);
    assert.equal(entry.type, LedgerEntryType.withdrawal);
    assert.equal(await getBalance(wallet.id), 70_000n);
  });

  it("refuses to pay out more than the balance", async () => {
    const wallet = await fundedWallet("100");
    await assert.rejects(
      createPayout({ walletId: wallet.id, amountPaise: rupeesToPaise("500"), destination: "ada@upi" }),
      (e: WalletError) => e.code === "INSUFFICIENT_FUNDS",
    );
    assert.equal(await getBalance(wallet.id), 10_000n);
  });

  it("puts the money back when the provider refuses", async () => {
    const { wallet } = await makeLiveWallet("Live Payout Agent", 100_000n);

    // Live mode with no live keys configured: the provider must refuse rather
    // than silently simulate, and the debit must be reversed.
    await assert.rejects(
      createPayout({ walletId: wallet.id, amountPaise: 30_000n, destination: "ada@upi" }),
    );

    assert.equal(await getBalance(wallet.id), 100_000n);
    assert.equal(await reconcileBalance(wallet.id), 100_000n);

    const payout = await prisma.payout.findFirst({ where: { walletId: wallet.id } });
    assert.equal(payout?.status, PayoutStatus.failed);
  });
});

describe("ledger invariants", () => {
  it("keeps the cached balance equal to the sum of entries", async () => {
    const a = await fundedWallet("1000");
    const { wallet: b } = await makeAgent("Wallet B");
    await createFundingMandate({ walletId: a.id });

    await topupWallet({ walletId: a.id, amountPaise: 5_000n });
    const { entry } = await transferMoney({ fromWalletId: a.id, toWalletId: b.id, amountPaise: 20_000n });
    await createPayout({ walletId: a.id, amountPaise: 1_000n, destination: "x@upi" });
    await refundTransaction({ originalEntryId: entry.id });

    for (const id of [a.id, b.id]) {
      const cached = await getBalance(id);
      const summed = await reconcileBalance(id);
      assert.equal(cached, summed, `wallet ${id} cache drifted`);
    }
  });

  it("never updates or deletes an existing entry", async () => {
    const wallet = await fundedWallet("500");
    const before = await prisma.ledgerEntry.findMany({ where: { walletId: wallet.id } });

    await createPayout({ walletId: wallet.id, amountPaise: 10_000n, destination: "y@upi" });

    const after = await prisma.ledgerEntry.findMany({
      where: { id: { in: before.map((e) => e.id) } },
    });
    assert.equal(after.length, before.length);
    assert.deepEqual(
      after.map((e) => `${e.id}:${e.amount}:${e.type}:${e.direction}`).sort(),
      before.map((e) => `${e.id}:${e.amount}:${e.type}:${e.direction}`).sort(),
    );
  });
});
