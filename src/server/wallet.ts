import {
  LedgerDirection,
  LedgerEntryType,
  Mode,
  type LedgerEntry,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Phase 1 wallet. Sandbox only, credited by hand — Razorpay, the e-mandate and
 * the custody partner all arrive in Phase 2/Phase 10.
 *
 * The ledger is append-only: nothing here ever updates or deletes a
 * LedgerEntry. Wallet.balance is a cache written in the same transaction as the
 * entry, and reconcileBalance() can always rebuild it from the entries alone.
 */

export class WalletError extends Error {}

/** ₹1,00,000 — a guard rail on fake sandbox money, not a regulatory limit. */
export const MAX_MANUAL_CREDIT_PAISE = 10_000_000n;

export function signedAmount(entry: Pick<LedgerEntry, "amount" | "direction">): bigint {
  return entry.direction === LedgerDirection.credit ? entry.amount : -entry.amount;
}

export async function creditWalletManually(params: {
  walletId: string;
  amountPaise: bigint;
  description?: string;
}) {
  if (params.amountPaise <= 0n) {
    throw new WalletError("Enter an amount greater than zero.");
  }
  if (params.amountPaise > MAX_MANUAL_CREDIT_PAISE) {
    throw new WalletError("Sandbox top-ups are capped at ₹1,00,000 per credit.");
  }

  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { id: params.walletId } });
    if (!wallet) throw new WalletError("Wallet not found.");
    if (wallet.mode !== Mode.sandbox) {
      // Live balances only ever move through the custody partner (Section 5).
      throw new WalletError("Only sandbox wallets can be credited by hand.");
    }

    const entry = await tx.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        amount: params.amountPaise,
        direction: LedgerDirection.credit,
        type: LedgerEntryType.manual_credit,
        counterparty: "skyborn:sandbox",
        description: params.description?.trim() || "Manual sandbox credit",
      },
    });

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: params.amountPaise } },
    });

    return { entry, wallet: updated };
  });
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
