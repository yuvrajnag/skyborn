import { randomUUID } from "node:crypto";

import {
  LedgerDirection,
  LedgerEntryType,
  MandateStatus,
  Mode,
  PayoutStatus,
  Prisma,
  type LedgerEntry,
  type Wallet,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { DEFAULT_MANDATE_CAP_PAISE, formatRupees } from "@/lib/money";
import {
  PaymentProviderError,
  paymentProviderFor,
} from "@/server/providers/payments";

/**
 * The wallet. Every rule the ledger depends on lives here:
 *
 *   - The ledger is append-only. Nothing in this file updates or deletes a
 *     LedgerEntry. A reversal is a new refund_in/refund_out row pointing at the
 *     entry it reverses.
 *   - Wallet.balance is a cache. It is only ever written in the same
 *     transaction as the entry that moved it, and reconcileBalance() can
 *     rebuild it from the entries alone.
 *   - Debits are conditional. Funds are removed with an UPDATE guarded by
 *     `balance >= amount`, so two concurrent debits cannot both pass a check
 *     that was true when each of them read it.
 *   - Money-moving calls are idempotent. A caller-supplied key is stored on the
 *     entry under a unique constraint, so a retried request returns the
 *     original entry rather than moving money a second time.
 */

export class WalletError extends Error {
  constructor(
    message: string,
    readonly code: string = "WALLET_ERROR",
  ) {
    super(message);
  }
}

/** ₹1,00,000 — a guard rail on fake sandbox money, not a regulatory limit. */
export const MAX_MANUAL_CREDIT_PAISE = 10_000_000n;

/**
 * RBI's Digital Payments E-Mandate Framework: a recurring debit at or below
 * ₹15,000 needs no OTP once the mandate is registered. Above it, AFA is
 * required again — which would put a human back in the loop and break the
 * zero-touch guarantee. So a single pull is capped here, and an agent needing
 * more calls topup repeatedly instead (spec Section 11).
 */
export const MAX_MANDATE_PULL_PAISE = DEFAULT_MANDATE_CAP_PAISE;

export function signedAmount(entry: Pick<LedgerEntry, "amount" | "direction">): bigint {
  return entry.direction === LedgerDirection.credit ? entry.amount : -entry.amount;
}

type Tx = Prisma.TransactionClient;

/** Credits a wallet and writes its entry in one transaction. */
async function creditInTx(
  tx: Tx,
  params: {
    walletId: string;
    amountPaise: bigint;
    type: LedgerEntryType;
    counterparty?: string;
    description?: string;
    externalRef?: string;
    originalEntryId?: string;
    transferGroupId?: string;
    idempotencyKey?: string;
  },
) {
  const entry = await tx.ledgerEntry.create({
    data: {
      walletId: params.walletId,
      amount: params.amountPaise,
      direction: LedgerDirection.credit,
      type: params.type,
      counterparty: params.counterparty,
      description: params.description,
      externalRef: params.externalRef,
      originalEntryId: params.originalEntryId,
      transferGroupId: params.transferGroupId,
      idempotencyKey: params.idempotencyKey,
    },
  });
  await tx.wallet.update({
    where: { id: params.walletId },
    data: { balance: { increment: params.amountPaise } },
  });
  return entry;
}

/**
 * Debits a wallet, refusing if the balance would go negative.
 *
 * The guard is the `balance: { gte: amount }` filter, not a prior read: two
 * concurrent debits that each read a sufficient balance would both pass a
 * read-then-write check, and only one can satisfy this one.
 */
async function debitInTx(
  tx: Tx,
  params: {
    walletId: string;
    amountPaise: bigint;
    type: LedgerEntryType;
    counterparty?: string;
    description?: string;
    externalRef?: string;
    originalEntryId?: string;
    transferGroupId?: string;
    idempotencyKey?: string;
  },
) {
  const updated = await tx.wallet.updateMany({
    where: { id: params.walletId, balance: { gte: params.amountPaise } },
    data: { balance: { decrement: params.amountPaise } },
  });

  if (updated.count === 0) {
    const wallet = await tx.wallet.findUnique({ where: { id: params.walletId } });
    if (!wallet) throw new WalletError("Wallet not found.", "WALLET_NOT_FOUND");
    throw new WalletError(
      `Insufficient balance: the wallet holds ${formatRupees(wallet.balance)} and this needs ${formatRupees(params.amountPaise)}.`,
      "INSUFFICIENT_FUNDS",
    );
  }

  return tx.ledgerEntry.create({
    data: {
      walletId: params.walletId,
      amount: params.amountPaise,
      direction: LedgerDirection.debit,
      type: params.type,
      counterparty: params.counterparty,
      description: params.description,
      externalRef: params.externalRef,
      originalEntryId: params.originalEntryId,
      transferGroupId: params.transferGroupId,
      idempotencyKey: params.idempotencyKey,
    },
  });
}

function assertPositive(amountPaise: bigint) {
  if (amountPaise <= 0n) {
    throw new WalletError("Enter an amount greater than zero.", "INVALID_AMOUNT");
  }
}

/**
 * Returns the entry a previous identical call already wrote, if any. Callers
 * check this before doing any provider work, so a retry never re-charges.
 */
async function findByIdempotencyKey(key: string | undefined) {
  if (!key) return null;
  return prisma.ledgerEntry.findUnique({ where: { idempotencyKey: key } });
}

async function loadWallet(walletId: string): Promise<Wallet> {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw new WalletError("Wallet not found.", "WALLET_NOT_FOUND");
  return wallet;
}

// ---------------------------------------------------------------------------
// Phase 1 — manual sandbox credit
// ---------------------------------------------------------------------------

export async function creditWalletManually(params: {
  walletId: string;
  amountPaise: bigint;
  description?: string;
}) {
  assertPositive(params.amountPaise);
  if (params.amountPaise > MAX_MANUAL_CREDIT_PAISE) {
    throw new WalletError(
      "Sandbox top-ups are capped at ₹1,00,000 per credit.",
      "AMOUNT_TOO_LARGE",
    );
  }

  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { id: params.walletId } });
    if (!wallet) throw new WalletError("Wallet not found.", "WALLET_NOT_FOUND");
    if (wallet.mode !== Mode.sandbox) {
      // Live balances only ever move through the custody partner (Section 5).
      throw new WalletError(
        "Only sandbox wallets can be credited by hand.",
        "LIVE_WALLET_NOT_MANUALLY_CREDITABLE",
      );
    }

    const entry = await creditInTx(tx, {
      walletId: wallet.id,
      amountPaise: params.amountPaise,
      type: LedgerEntryType.manual_credit,
      counterparty: "skyborn:sandbox",
      description: params.description?.trim() || "Manual sandbox credit",
    });

    const updated = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    return { entry, wallet: updated };
  });
}

// ---------------------------------------------------------------------------
// Phase 2 — funding mandate
// ---------------------------------------------------------------------------

/**
 * Registers the standing authorization an agent later pulls against. This is
 * the human's second and last moment of involvement (spec Section 2) — the
 * one-time AFA/OTP happens here, never at top-up time.
 */
export async function createFundingMandate(params: {
  walletId: string;
  capAmountPaise?: bigint;
  capPeriod?: string;
}) {
  const wallet = await loadWallet(params.walletId);
  const capAmount = params.capAmountPaise ?? DEFAULT_MANDATE_CAP_PAISE;

  assertPositive(capAmount);
  if (capAmount > MAX_MANDATE_PULL_PAISE) {
    throw new WalletError(
      `A per-transaction cap above ${formatRupees(MAX_MANDATE_PULL_PAISE)} would require OTP on every pull under RBI's e-mandate rules, ` +
        "which breaks the zero-touch guarantee. Keep the cap at or below that and let the agent call topup more than once.",
      "MANDATE_CAP_TOO_HIGH",
    );
  }

  const existing = await prisma.fundingMandate.findFirst({
    where: { walletId: wallet.id, status: MandateStatus.active },
  });
  if (existing) {
    throw new WalletError(
      "This wallet already has an active funding mandate.",
      "MANDATE_ALREADY_ACTIVE",
    );
  }

  const provider = paymentProviderFor(wallet.mode);
  const registered = await provider.createMandate({
    walletId: wallet.id,
    capAmountPaise: capAmount,
    capPeriod: params.capPeriod ?? "per_transaction",
  });

  return prisma.fundingMandate.create({
    data: {
      walletId: wallet.id,
      providerRef: registered.providerRef,
      capAmount,
      capPeriod: params.capPeriod ?? "per_transaction",
      // A mandate the human has not finished registering is not usable yet.
      status: registered.requiresHumanRegistration
        ? MandateStatus.pending
        : MandateStatus.active,
    },
  });
}

export async function revokeFundingMandate(mandateId: string) {
  return prisma.fundingMandate.update({
    where: { id: mandateId },
    data: { status: MandateStatus.revoked },
  });
}

export async function getActiveMandate(walletId: string) {
  return prisma.fundingMandate.findFirst({
    where: { walletId, status: MandateStatus.active },
    orderBy: { createdAt: "desc" },
  });
}

// ---------------------------------------------------------------------------
// Phase 2 — topup, transfer, refund, payout
// ---------------------------------------------------------------------------

/**
 * Pulls against the standing mandate. The agent supplies an amount and nothing
 * else — no checkout page, no card fields, no OTP.
 */
export async function topupWallet(params: {
  walletId: string;
  amountPaise: bigint;
  idempotencyKey?: string;
  description?: string;
}) {
  assertPositive(params.amountPaise);

  const replay = await findByIdempotencyKey(params.idempotencyKey);
  if (replay) return { entry: replay, replayed: true as const };

  const wallet = await loadWallet(params.walletId);
  const mandate = await getActiveMandate(wallet.id);
  if (!mandate) {
    throw new WalletError(
      "This wallet has no active funding mandate. A human has to register one before an agent can top up.",
      "NO_ACTIVE_MANDATE",
    );
  }

  if (params.amountPaise > mandate.capAmount) {
    throw new WalletError(
      `That is above the mandate's ${formatRupees(mandate.capAmount)} per-pull cap. Call topup more than once instead of raising the cap.`,
      "ABOVE_MANDATE_CAP",
    );
  }

  const idempotencyKey = params.idempotencyKey ?? randomUUID();
  const provider = paymentProviderFor(wallet.mode);

  const charge = await provider.chargeMandate({
    mandateRef: mandate.providerRef ?? mandate.id,
    amountPaise: params.amountPaise,
    idempotencyKey,
  });

  if (charge.status !== "captured") {
    throw new WalletError(
      `The mandate pull failed at the provider${charge.failureCode ? ` (${charge.failureCode})` : ""}.`,
      "MANDATE_CHARGE_FAILED",
    );
  }

  try {
    const entry = await prisma.$transaction((tx) =>
      creditInTx(tx, {
        walletId: wallet.id,
        amountPaise: params.amountPaise,
        type: LedgerEntryType.topup,
        counterparty: mandate.providerRef ?? "mandate",
        externalRef: charge.providerRef,
        description: params.description?.trim() || "Top-up against funding mandate",
        idempotencyKey,
      }),
    );
    return { entry, replayed: false as const };
  } catch (error) {
    // Two identical calls raced past the pre-check; the loser returns the
    // winner's entry rather than a second credit.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await findByIdempotencyKey(idempotencyKey);
      if (winner) return { entry: winner, replayed: true as const };
    }
    throw error;
  }
}

/**
 * Moves money between two Handles. A pure internal double-entry write against
 * the shared custody partner's nodal account — instant, free, and never near a
 * card network, so no AFA/OTP ceiling applies (spec Section 11).
 */
export async function transferMoney(params: {
  fromWalletId: string;
  toWalletId: string;
  amountPaise: bigint;
  idempotencyKey?: string;
  description?: string;
}) {
  assertPositive(params.amountPaise);

  if (params.fromWalletId === params.toWalletId) {
    throw new WalletError("A wallet cannot transfer to itself.", "SELF_TRANSFER");
  }

  const replay = await findByIdempotencyKey(params.idempotencyKey);
  if (replay) return { entry: replay, replayed: true as const };

  const [from, to] = await Promise.all([
    loadWallet(params.fromWalletId),
    loadWallet(params.toWalletId),
  ]);

  // Sandbox money must never cross into a live wallet, in either direction.
  if (from.mode !== to.mode) {
    throw new WalletError(
      `Cannot transfer between a ${from.mode} wallet and a ${to.mode} one.`,
      "MODE_MISMATCH",
    );
  }

  const idempotencyKey = params.idempotencyKey ?? randomUUID();
  const transferGroupId = randomUUID();
  const description = params.description?.trim() || "Transfer between handles";

  try {
    const entry = await prisma.$transaction(async (tx) => {
      const out = await debitInTx(tx, {
        walletId: from.id,
        amountPaise: params.amountPaise,
        type: LedgerEntryType.transfer_out,
        counterparty: to.id,
        description,
        transferGroupId,
        idempotencyKey,
      });

      await creditInTx(tx, {
        walletId: to.id,
        amountPaise: params.amountPaise,
        type: LedgerEntryType.transfer_in,
        counterparty: from.id,
        description,
        transferGroupId,
      });

      return out;
    });

    return { entry, replayed: false as const };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await findByIdempotencyKey(idempotencyKey);
      if (winner) return { entry: winner, replayed: true as const };
    }
    throw error;
  }
}

/**
 * Reverses a prior entry by writing new ones — never by touching the original.
 *
 * Reversing a credit writes a `refund_out` debit; reversing a debit writes a
 * `refund_in` credit. A transfer is reversed as a pair, so the two legs can
 * never end up half-refunded.
 */
export async function refundTransaction(params: {
  originalEntryId: string;
  idempotencyKey?: string;
  reason?: string;
}) {
  const replay = await findByIdempotencyKey(params.idempotencyKey);
  if (replay) return { entries: [replay], replayed: true as const };

  const original = await prisma.ledgerEntry.findUnique({
    where: { id: params.originalEntryId },
  });
  if (!original) {
    throw new WalletError("No such ledger entry.", "ENTRY_NOT_FOUND");
  }

  if (
    original.type === LedgerEntryType.refund_in ||
    original.type === LedgerEntryType.refund_out
  ) {
    throw new WalletError("A refund cannot itself be refunded.", "CANNOT_REFUND_REFUND");
  }

  // Both legs of a transfer are reversed together, or neither is.
  const legs = original.transferGroupId
    ? await prisma.ledgerEntry.findMany({
        where: { transferGroupId: original.transferGroupId },
        orderBy: { createdAt: "asc" },
      })
    : [original];

  const alreadyReversed = await prisma.ledgerEntry.findFirst({
    where: { originalEntryId: { in: legs.map((leg) => leg.id) } },
  });
  if (alreadyReversed) {
    throw new WalletError("That entry has already been refunded.", "ALREADY_REFUNDED");
  }

  const idempotencyKey = params.idempotencyKey ?? randomUUID();
  const description = params.reason?.trim() || "Refund";

  try {
    const entries = await prisma.$transaction(async (tx) => {
      const written: LedgerEntry[] = [];

      // Debit the legs that were credits first: if a recipient has already
      // spent the money, the whole refund fails rather than half-applying.
      const ordered = [...legs].sort((a, b) =>
        a.direction === LedgerDirection.credit ? -1 : b.direction === LedgerDirection.credit ? 1 : 0,
      );

      for (const [index, leg] of ordered.entries()) {
        const shared = {
          walletId: leg.walletId,
          amountPaise: leg.amount,
          counterparty: leg.counterparty ?? undefined,
          description,
          originalEntryId: leg.id,
          transferGroupId: leg.transferGroupId ?? undefined,
          // The key can only sit on one row, so it anchors the first.
          idempotencyKey: index === 0 ? idempotencyKey : undefined,
        };

        written.push(
          leg.direction === LedgerDirection.credit
            ? await debitInTx(tx, { ...shared, type: LedgerEntryType.refund_out })
            : await creditInTx(tx, { ...shared, type: LedgerEntryType.refund_in }),
        );
      }

      return written;
    });

    return { entries, replayed: false as const };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await findByIdempotencyKey(idempotencyKey);
      if (winner) return { entries: [winner], replayed: true as const };
    }
    throw error;
  }
}

/**
 * Withdraws to an external bank account or UPI handle. Sandbox settles
 * instantly against the simulator; live mode goes through RazorpayX and is
 * KYC-gated. Same API shape either way.
 */
export async function createPayout(params: {
  walletId: string;
  amountPaise: bigint;
  destination: string;
  idempotencyKey?: string;
}) {
  assertPositive(params.amountPaise);

  const destination = params.destination.trim();
  if (!destination) {
    throw new WalletError("A payout needs a destination.", "MISSING_DESTINATION");
  }

  const replay = await findByIdempotencyKey(params.idempotencyKey);
  if (replay) {
    const payout = await prisma.payout.findUnique({
      where: { ledgerEntryId: replay.id },
    });
    return { entry: replay, payout, replayed: true as const };
  }

  const wallet = await loadWallet(params.walletId);
  const idempotencyKey = params.idempotencyKey ?? randomUUID();

  // Debit first. If the provider then fails, the debit is reversed by a refund
  // entry rather than by deleting anything — the ledger stays append-only even
  // on the failure path.
  let entry: LedgerEntry;
  try {
    entry = await prisma.$transaction((tx) =>
      debitInTx(tx, {
        walletId: wallet.id,
        amountPaise: params.amountPaise,
        type: LedgerEntryType.withdrawal,
        counterparty: destination,
        description: `Payout to ${destination}`,
        idempotencyKey,
      }),
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await findByIdempotencyKey(idempotencyKey);
      if (winner) {
        const payout = await prisma.payout.findUnique({
          where: { ledgerEntryId: winner.id },
        });
        return { entry: winner, payout, replayed: true as const };
      }
    }
    throw error;
  }

  const payout = await prisma.payout.create({
    data: {
      walletId: wallet.id,
      amount: params.amountPaise,
      destination,
      status: PayoutStatus.pending,
      ledgerEntryId: entry.id,
    },
  });

  try {
    const provider = paymentProviderFor(wallet.mode);
    const result = await provider.createPayout({
      amountPaise: params.amountPaise,
      destination,
      idempotencyKey,
    });

    const settled = await prisma.payout.update({
      where: { id: payout.id },
      data: {
        status:
          result.status === "settled"
            ? PayoutStatus.settled
            : result.status === "failed"
              ? PayoutStatus.failed
              : PayoutStatus.processing,
        providerRef: result.providerRef,
        failureCode: result.failureCode,
        settledAt: result.status === "settled" ? new Date() : null,
      },
    });

    if (result.status === "failed") {
      await refundTransaction({
        originalEntryId: entry.id,
        reason: `Payout failed${result.failureCode ? ` (${result.failureCode})` : ""}`,
      });
    }

    return { entry, payout: settled, replayed: false as const };
  } catch (error) {
    // The provider never accepted it — put the money back with a refund entry.
    await prisma.payout.update({
      where: { id: payout.id },
      data: {
        status: PayoutStatus.failed,
        failureCode: error instanceof PaymentProviderError ? error.code : "PROVIDER_ERROR",
      },
    });
    await refundTransaction({
      originalEntryId: entry.id,
      reason: "Payout could not be submitted",
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getBalance(walletId: string): Promise<bigint> {
  const wallet = await loadWallet(walletId);
  return wallet.balance;
}

export async function listTransactions(walletId: string, take = 50) {
  return prisma.ledgerEntry.findMany({
    where: { walletId },
    orderBy: { createdAt: "desc" },
    take,
  });
}

/**
 * Sums the append-only entries and rewrites the cached balance. The ledger is
 * the source of truth; Wallet.balance is only ever a cache of this sum.
 */
export async function reconcileBalance(walletId: string): Promise<bigint> {
  const [credits, debits] = await Promise.all([
    prisma.ledgerEntry.aggregate({
      where: { walletId, direction: LedgerDirection.credit },
      _sum: { amount: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: { walletId, direction: LedgerDirection.debit },
      _sum: { amount: true },
    }),
  ]);

  const balance = (credits._sum.amount ?? 0n) - (debits._sum.amount ?? 0n);
  await prisma.wallet.update({ where: { id: walletId }, data: { balance } });
  return balance;
}
