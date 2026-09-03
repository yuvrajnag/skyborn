import { MessageChannel } from "@prisma/client";

import { ACTIONS, actionByToolName, inputSchemaFor } from "@/lib/catalogue";
import type { AuthenticatedGrant } from "@/server/grants";
import {
  CoreError,
  callStatus,
  callsMake,
  messagesLatestOtp,
  messagesRead,
  messagesSend,
  walletBalance,
  walletPayout,
  walletRefund,
  walletTopup,
  walletTransactions,
  walletTransfer,
} from "@/server/core";

/**
 * The MCP adapter (spec Section 13).
 *
 * It calls the core service layer in process rather than proxying to REST, so
 * there is exactly one implementation of every rule. A tool call from Claude or
 * ChatGPT goes through the same scope check, the same server-side spending cap
 * and the same audit write as a curl against /api/v1 — which is what makes a
 * grant approved through an MCP connector indistinguishable from any other in
 * the dashboard, and just as revocable.
 */

export type McpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: ReturnType<typeof inputSchemaFor>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};

/**
 * The tool list, filtered to what this grant can actually do.
 *
 * Advertising a tool the grant has no scope for would invite the model to try
 * it and fail — worse, it would suggest a capability the human never approved.
 */
export function toolsFor(grant: AuthenticatedGrant): McpTool[] {
  return ACTIONS.filter((action) => grant.scopes.includes(action.scope)).map((action) => ({
    name: action.toolName,
    title: action.name,
    description: action.effects
      ? `${action.description}\n\nEffects: ${action.effects}`
      : action.description,
    inputSchema: inputSchemaFor(action),
    annotations: {
      readOnlyHint: action.method === "GET",
      destructiveHint: action.irreversible === true,
      // Money-moving calls take an idempotency key, but a repeat without one is
      // a second real movement, so this is honest rather than optimistic.
      idempotentHint: action.method === "GET",
      openWorldHint: action.scope === "messages:send" || action.scope === "calls:make",
    },
  }));
}

function asChannel(value: unknown): MessageChannel | undefined {
  if (value === "email" || value === "sms" || value === "call") return value;
  return undefined;
}

/**
 * Same rule as the REST surface: paise as a string, never a JSON number. The
 * tool schema published in tools/list already declares amount_paise a string,
 * so a compliant client sends one.
 */
function paise(args: Record<string, unknown>, field = "amount_paise"): bigint {
  const raw = args[field];
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return BigInt(raw.trim());
  throw new CoreError(
    `${field} must be a whole number of paise, as a string. ₹1 is "100".`,
    "INVALID_AMOUNT",
  );
}

function text(args: Record<string, unknown>, field: string): string {
  const raw = args[field];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new CoreError(`${field} is required.`, "MISSING_FIELD");
  }
  return raw.trim();
}

function optional(args: Record<string, unknown>, field: string): string | undefined {
  const raw = args[field];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function count(args: Record<string, unknown>, field: string): number | undefined {
  const raw = args[field];
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Dispatches one MCP tool call into the core service layer. */
export async function callTool(
  grant: AuthenticatedGrant,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const action = actionByToolName(toolName);
  if (!action) throw new CoreError(`Unknown tool "${toolName}".`, "UNKNOWN_TOOL", 404);

  const ctx = { grant };

  switch (action.name) {
    case "wallet.balance":
      return walletBalance(ctx);
    case "wallet.transactions":
      return { transactions: await walletTransactions(ctx, { limit: count(args, "limit") }) };
    case "wallet.topup":
      return walletTopup(ctx, { amountPaise: paise(args) });
    case "wallet.transfer":
      return walletTransfer(ctx, {
        toHandle: text(args, "to_handle"),
        amountPaise: paise(args),
        description: optional(args, "description"),
      });
    case "wallet.refund":
      return walletRefund(ctx, {
        originalEntryId: text(args, "original_entry_id"),
        reason: optional(args, "reason"),
      });
    case "wallet.payout":
      return walletPayout(ctx, {
        amountPaise: paise(args),
        destination: text(args, "destination"),
      });
    case "messages.send": {
      const channel = text(args, "channel");
      if (channel !== "email" && channel !== "sms") {
        throw new CoreError('channel must be "email" or "sms".', "INVALID_CHANNEL");
      }
      return messagesSend(ctx, {
        channel,
        to: text(args, "to"),
        subject: optional(args, "subject"),
        body: text(args, "body"),
      });
    }
    case "messages.read":
      return {
        messages: await messagesRead(ctx, {
          channel: asChannel(args.channel),
          limit: count(args, "limit"),
        }),
      };
    case "messages.otp_latest":
      return messagesLatestOtp(ctx, {
        channel: asChannel(args.channel),
        from: optional(args, "from"),
        withinMinutes: count(args, "within_minutes"),
      });
    case "calls.make":
      return callsMake(ctx, { to: text(args, "to"), script: text(args, "script") });
    case "calls.status":
      return callStatus(ctx, { callId: text(args, "call_id") });
    default:
      throw new CoreError(`Tool "${toolName}" has no handler.`, "UNKNOWN_TOOL", 404);
  }
}

/** Read-only MCP resources — currently the wallet balance. */
export function resourcesFor(grant: AuthenticatedGrant) {
  if (!grant.scopes.includes("wallet:read")) return [];
  return [
    {
      uri: "skyborn://wallet/balance",
      name: "wallet_balance",
      title: "Wallet balance",
      description: "The handle's current wallet balance, in paise.",
      mimeType: "application/json",
    },
  ];
}

export async function readResource(grant: AuthenticatedGrant, uri: string) {
  if (uri !== "skyborn://wallet/balance") {
    throw new CoreError(`Unknown resource "${uri}".`, "UNKNOWN_RESOURCE", 404);
  }
  return walletBalance({ grant });
}
