import { LedgerDirection, MessageChannel, Mode } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { formatRupees } from "@/lib/money";
import { MONEY_OUT_SCOPES, type Scope } from "@/lib/scopes";
import { GrantError, type AuthenticatedGrant } from "@/server/grants";
import {
  getLatestOtp,
  makeCall as makeCallRaw,
  readInbox,
  sendEmail as sendEmailRaw,
  sendSms as sendSmsRaw,
} from "@/server/messaging";
import {
  createPayout,
  getBalance,
  listTransactions,
  refundTransaction,
  topupWallet,
  transferMoney,
} from "@/server/wallet";

/**
 * The core service layer (spec Section 8, Phase 5).
 *
 * Every action exists exactly once, here. The REST routes, the AXL-fronted
 * surface and the MCP adapter are all thin callers of these functions — none of
 * them re-implements a rule, and none of them is trusted to apply one.
 *
 * Three things happen on every call, in this order:
 *   1. Scope check — does the Grant actually cover this action.
 *   2. Spending-cap check — for money-out actions, server-side, against the cap
 *      the human set when they approved the Grant. Never a UI-layer check.
 *   3. Audit write — the action, its parameters and its outcome land in
 *      GrantAuditLog whether it succeeded or failed, because nothing here was
 *      approved in the moment and the dashboard is the only place a human ever
 *      sees what their agent did (Section 15).
 */

export class CoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type CoreContext = {
  grant: AuthenticatedGrant;
};

function requireScope(grant: AuthenticatedGrant, scope: Scope) {
  if (!grant.scopes.includes(scope)) {
    throw new GrantError(
      `This grant does not carry the ${scope} scope.`,
      "INSUFFICIENT_SCOPE",
      403,
    );
  }
}

function walletOf(grant: AuthenticatedGrant) {
  const wallet = grant.agent.wallet;
  if (!wallet) throw new CoreError("That agent has no wallet.", "WALLET_NOT_FOUND", 404);
  return wallet;
}

/**
 * Total already spent under this Grant — the sum of every money-out entry it
 * has written. Computed from the ledger rather than a running counter, so it
 * cannot drift from what actually happened.
 */
export async function spentUnderGrant(grantId: string): Promise<bigint> {
  const logs = await prisma.grantAuditLog.findMany({
    where: { grantId, resultStatus: "ok", action: { in: ["wallet.transfer", "wallet.payout"] } },
    select: { paramsSummary: true },
  });

  return logs.reduce((total, log) => {
    const summary = log.paramsSummary as { amountPaise?: string } | null;
    return total + BigInt(summary?.amountPaise ?? "0");
  }, 0n);
}

/**
 * Server-side spending-cap enforcement (Section 11, Section 15). Checked before
 * every money-out call, against the cap set when the human approved the Grant.
 */
async function enforceSpendingCap(grant: AuthenticatedGrant, amountPaise: bigint) {
  if (grant.spendingCap === null) return;

  const alreadySpent = await spentUnderGrant(grant.id);
  if (alreadySpent + amountPaise > grant.spendingCap) {
    throw new CoreError(
      `That would take this grant past its ${formatRupees(grant.spendingCap)} spending cap ` +
        `(${formatRupees(alreadySpent)} already spent).`,
      "SPENDING_CAP_EXCEEDED",
      403,
    );
  }
}

/**
 * Runs an action with scope, cap and audit handling around it. Every public
 * function below goes through this — there is no path that skips the audit log.
 */
async function withAudit<T>(
  ctx: CoreContext,
  action: string,
  scope: Scope,
  paramsSummary: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  try {
    requireScope(ctx.grant, scope);

    if (MONEY_OUT_SCOPES.includes(scope)) {
      const amount = paramsSummary.amountPaise;
      if (typeof amount === "string") {
        await enforceSpendingCap(ctx.grant, BigInt(amount));
      }
    }

    const result = await run();

    await prisma.grantAuditLog.create({
      data: {
        grantId: ctx.grant.id,
        action,
        paramsSummary: paramsSummary as never,
        resultStatus: "ok",
      },
    });

    return result;
  } catch (error) {
    // A refused action is exactly what a human most needs to see, so failures
    // are audited too — with the reason, not just the fact.
    await prisma.grantAuditLog.create({
      data: {
        grantId: ctx.grant.id,
        action,
        paramsSummary: paramsSummary as never,
        resultStatus: "error",
        errorCode:
          error instanceof CoreError || error instanceof GrantError
            ? error.code
            : ((error as { code?: string }).code ?? "UNKNOWN"),
      },
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export async function walletBalance(ctx: CoreContext) {
  const wallet = walletOf(ctx.grant);
  return withAudit(ctx, "wallet.balance", "wallet:read", {}, async () => ({
    walletId: wallet.id,
    balancePaise: (await getBalance(wallet.id)).toString(),
    mode: wallet.mode,
  }));
}

export async function walletTransactions(ctx: CoreContext, params: { limit?: number }) {
  const wallet = walletOf(ctx.grant);
  return withAudit(
    ctx,
    "wallet.transactions",
    "wallet:read",
    { limit: params.limit ?? 50 },
    async () => {
      const entries = await listTransactions(wallet.id, Math.min(params.limit ?? 50, 200));
      return entries.map((entry) => ({
        id: entry.id,
        amountPaise: entry.amount.toString(),
        direction: entry.direction,
        type: entry.type,
        counterparty: entry.counterparty,
        description: entry.description,
        createdAt: entry.createdAt.toISOString(),
      }));
    },
  );
}

export async function walletTopup(
  ctx: CoreContext,
  params: { amountPaise: bigint; idempotencyKey?: string },
) {
  const wallet = walletOf(ctx.grant);
  return withAudit(
    ctx,
    "wallet.topup",
    "wallet:topup",
    { amountPaise: params.amountPaise.toString() },
    async () => {
      const { entry, replayed } = await topupWallet({
        walletId: wallet.id,
        amountPaise: params.amountPaise,
        idempotencyKey: params.idempotencyKey,
      });
      return {
        entryId: entry.id,
        amountPaise: entry.amount.toString(),
        balancePaise: (await getBalance(wallet.id)).toString(),
        replayed,
      };
    },
  );
}

export async function walletTransfer(
  ctx: CoreContext,
  params: { toHandle: string; amountPaise: bigint; description?: string; idempotencyKey?: string },
) {
  const wallet = walletOf(ctx.grant);

  return withAudit(
    ctx,
    "wallet.transfer",
    "wallet:transfer",
    { toHandle: params.toHandle, amountPaise: params.amountPaise.toString() },
    async () => {
      const destination = await resolveHandle(params.toHandle, wallet.mode);

      const { entry, replayed } = await transferMoney({
        fromWalletId: wallet.id,
        toWalletId: destination.walletId,
        amountPaise: params.amountPaise,
        description: params.description,
        idempotencyKey: params.idempotencyKey,
      });

      return {
        entryId: entry.id,
        amountPaise: entry.amount.toString(),
        toHandle: destination.email,
        balancePaise: (await getBalance(wallet.id)).toString(),
        replayed,
      };
    },
  );
}

export async function walletRefund(
  ctx: CoreContext,
  params: { originalEntryId: string; reason?: string; idempotencyKey?: string },
) {
  const wallet = walletOf(ctx.grant);
  return withAudit(
    ctx,
    "wallet.refund",
    "wallet:refund",
    { originalEntryId: params.originalEntryId },
    async () => {
      // A grant may only reverse an entry on its own wallet.
      const original = await prisma.ledgerEntry.findUnique({
        where: { id: params.originalEntryId },
      });
      if (!original || original.walletId !== wallet.id) {
        throw new CoreError("No such entry on this wallet.", "ENTRY_NOT_FOUND", 404);
      }

      const { entries, replayed } = await refundTransaction({
        originalEntryId: params.originalEntryId,
        reason: params.reason,
        idempotencyKey: params.idempotencyKey,
      });

      return {
        entryIds: entries.map((entry) => entry.id),
        balancePaise: (await getBalance(wallet.id)).toString(),
        replayed,
      };
    },
  );
}

export async function walletPayout(
  ctx: CoreContext,
  params: { amountPaise: bigint; destination: string; idempotencyKey?: string },
) {
  const wallet = walletOf(ctx.grant);
  return withAudit(
    ctx,
    "wallet.payout",
    "wallet:payout",
    { amountPaise: params.amountPaise.toString(), destination: params.destination },
    async () => {
      const { entry, payout } = await createPayout({
        walletId: wallet.id,
        amountPaise: params.amountPaise,
        destination: params.destination,
        idempotencyKey: params.idempotencyKey,
      });
      return {
        payoutId: payout?.id,
        entryId: entry.id,
        status: payout?.status,
        balancePaise: (await getBalance(wallet.id)).toString(),
      };
    },
  );
}

/** Resolves a handle email (or agent id) to the wallet behind it. */
async function resolveHandle(identifier: string, expectedMode: Mode) {
  const value = identifier.trim().toLowerCase();

  const handle = await prisma.handle.findFirst({
    where: { OR: [{ email: value }, { agentId: identifier.trim() }] },
    include: { agent: { include: { wallet: true } } },
  });

  if (!handle?.agent.wallet) {
    throw new CoreError(`No handle matches "${identifier}".`, "HANDLE_NOT_FOUND", 404);
  }
  if (handle.agent.wallet.mode !== expectedMode) {
    throw new CoreError(
      `That handle is in ${handle.agent.wallet.mode} mode; this grant is ${expectedMode}.`,
      "MODE_MISMATCH",
    );
  }

  return { walletId: handle.agent.wallet.id, email: handle.email };
}

// ---------------------------------------------------------------------------
// Messages and calls
// ---------------------------------------------------------------------------

export async function messagesSend(
  ctx: CoreContext,
  params: { channel: "email" | "sms"; to: string; subject?: string; body: string },
) {
  const agentId = ctx.grant.agentId;
  return withAudit(
    ctx,
    "messages.send",
    "messages:send",
    { channel: params.channel, to: params.to },
    async () => {
      const message =
        params.channel === "email"
          ? await sendEmailRaw({
              agentId,
              to: params.to,
              subject: params.subject ?? "(no subject)",
              body: params.body,
            })
          : await sendSmsRaw({ agentId, to: params.to, body: params.body });

      return {
        messageId: message.id,
        channel: message.channel,
        status: message.status,
        from: message.from,
      };
    },
  );
}

export async function messagesRead(
  ctx: CoreContext,
  params: { channel?: MessageChannel; limit?: number },
) {
  const agentId = ctx.grant.agentId;
  return withAudit(
    ctx,
    "messages.read",
    "messages:read",
    { channel: params.channel, limit: params.limit ?? 50 },
    async () => {
      const messages = await readInbox({
        agentId,
        channel: params.channel,
        limit: params.limit,
      });
      return messages.map((message) => ({
        id: message.id,
        direction: message.direction,
        channel: message.channel,
        from: message.from,
        to: message.to,
        subject: message.subject,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      }));
    },
  );
}

export async function messagesLatestOtp(
  ctx: CoreContext,
  params: { channel?: MessageChannel; from?: string; withinMinutes?: number },
) {
  const agentId = ctx.grant.agentId;
  return withAudit(
    ctx,
    "messages.otp_latest",
    "messages:read",
    { channel: params.channel, from: params.from },
    async () => {
      const otp = await getLatestOtp({ agentId, ...params });
      if (!otp) return { found: false as const };
      return {
        found: true as const,
        code: otp.code,
        confidence: otp.confidence,
        channel: otp.channel,
        from: otp.from,
        receivedAt: otp.receivedAt.toISOString(),
      };
    },
  );
}

export async function callsMake(ctx: CoreContext, params: { to: string; script: string }) {
  const agentId = ctx.grant.agentId;
  return withAudit(ctx, "calls.make", "calls:make", { to: params.to }, async () => {
    const message = await makeCallRaw({ agentId, to: params.to, script: params.script });
    return { callId: message.id, status: message.status, from: message.from };
  });
}

export async function callStatus(ctx: CoreContext, params: { callId: string }) {
  const agentId = ctx.grant.agentId;
  return withAudit(ctx, "calls.status", "calls:make", { callId: params.callId }, async () => {
    const message = await prisma.message.findFirst({
      where: { id: params.callId, agentId, channel: MessageChannel.call },
    });
    if (!message) throw new CoreError("No such call.", "CALL_NOT_FOUND", 404);
    return {
      callId: message.id,
      status: message.status,
      to: message.to,
      transcript: message.body,
      createdAt: message.createdAt.toISOString(),
    };
  });
}

/** Everything the audit viewer needs about what a grant has done. */
export async function grantActivity(grantId: string, limit = 100) {
  return prisma.grantAuditLog.findMany({
    where: { grantId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export { LedgerDirection };
