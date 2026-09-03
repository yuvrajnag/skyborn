import { SCOPE_DESCRIPTIONS, type Scope } from "@/lib/scopes";

/**
 * The single description of every callable action.
 *
 * This one array feeds the `/.well-known/agent-tools.json` catalogue, the MCP
 * tool list and the developer docs page. Adding an action in one place and
 * forgetting another is the failure mode it exists to prevent — the whole point
 * of Section 8 is that the action list has exactly one definition.
 */

export type ActionParameter = {
  name: string;
  type: "string" | "integer" | "number" | "boolean";
  required: boolean;
  description: string;
  enum?: string[];
};

/** Requests allowed per minute, per grant. Mirrored by RATE_LIMIT in auth.flow. */
export type RateLimit = { perMinute: number };

export type ActionDefinition = {
  /** Dotted name, as used by AXL and the audit log. */
  name: string;
  /** MCP tool name — snake_case, as MCP clients expect. */
  toolName: string;
  scope: Scope;
  description: string;
  method: "GET" | "POST";
  path: string;
  parameters: ActionParameter[];
  /** Surfaced to a calling model so it can decide whether to ask first. */
  irreversible?: boolean;
  effects?: string;
  /**
   * Per-grant rate limit. Tightest on what moves money or reaches a third
   * party. A test asserts these match the RATE_LIMIT lines in axl/flow/auth.flow,
   * so the two surfaces cannot quietly diverge.
   */
  rateLimit: RateLimit;
};

const PAISE = "Amount in paise (integer minor units) as a string. ₹1 is \"100\".";

export const ACTIONS: ActionDefinition[] = [
  {
    name: "wallet.balance",
    toolName: "check_balance",
    scope: "wallet:read",
    description: "Read the handle's current wallet balance.",
    method: "GET",
    path: "/api/v1/wallet/balance",
    parameters: [],
    rateLimit: { perMinute: 60 },
  },
  {
    name: "wallet.transactions",
    toolName: "list_transactions",
    scope: "wallet:read",
    description: "List recent ledger entries for the handle's wallet, newest first.",
    method: "GET",
    path: "/api/v1/wallet/transactions",
    parameters: [
      { name: "limit", type: "integer", required: false, description: "How many entries to return, up to 200." },
    ],
    rateLimit: { perMinute: 60 },
  },
  {
    name: "wallet.topup",
    toolName: "request_topup",
    scope: "wallet:topup",
    description:
      "Pull funds into the wallet from the standing funding mandate. No card entry and no OTP — the human authorized this once, in advance.",
    method: "POST",
    path: "/api/v1/wallet/topup",
    parameters: [{ name: "amount_paise", type: "string", required: true, description: PAISE }],
    effects: "Debits the human's bank account through the registered mandate.",
    rateLimit: { perMinute: 10 },
  },
  {
    name: "wallet.transfer",
    toolName: "transfer_money",
    scope: "wallet:transfer",
    description:
      "Send money to another Skyborn handle. Internal double-entry transfer — instant, free, and never near a card network.",
    method: "POST",
    path: "/api/v1/wallet/transfer",
    parameters: [
      { name: "to_handle", type: "string", required: true, description: "The recipient handle's email address, or its agent id." },
      { name: "amount_paise", type: "string", required: true, description: PAISE },
      { name: "description", type: "string", required: false, description: "Note stored on both ledger entries." },
    ],
    irreversible: false,
    effects: "Moves money out of this wallet immediately. Reversible only via wallet.refund, and only while the recipient still holds the funds.",
    rateLimit: { perMinute: 20 },
  },
  {
    name: "wallet.refund",
    toolName: "refund",
    scope: "wallet:refund",
    description:
      "Reverse a prior transfer or top-up. Writes new refund entries; the original is never altered. Internal reversals are instant — a card refund follows the network's own 3-7 business day timeline.",
    method: "POST",
    path: "/api/v1/wallet/refund",
    parameters: [
      { name: "original_entry_id", type: "string", required: true, description: "The ledger entry id being reversed." },
      { name: "reason", type: "string", required: false, description: "Note stored on the refund entries." },
    ],
    rateLimit: { perMinute: 10 },
  },
  {
    name: "wallet.payout",
    toolName: "payout",
    scope: "wallet:payout",
    description: "Withdraw from the wallet to an external bank account or UPI handle.",
    method: "POST",
    path: "/api/v1/wallet/payout",
    parameters: [
      { name: "amount_paise", type: "string", required: true, description: PAISE },
      { name: "destination", type: "string", required: true, description: "UPI VPA or bank account reference." },
    ],
    irreversible: true,
    effects: "Sends money outside Skyborn. Once settled at the bank this cannot be reversed from here.",
    rateLimit: { perMinute: 5 },
  },
  {
    name: "messages.send",
    toolName: "send_message",
    scope: "messages:send",
    description: "Send an email or SMS from the handle's own address or number.",
    method: "POST",
    path: "/api/v1/messages/send",
    parameters: [
      { name: "channel", type: "string", required: true, description: "email or sms", enum: ["email", "sms"] },
      { name: "to", type: "string", required: true, description: "Recipient email address or E.164 phone number." },
      { name: "subject", type: "string", required: false, description: "Email subject. Ignored for SMS." },
      { name: "body", type: "string", required: true, description: "Message body." },
    ],
    irreversible: true,
    effects: "Delivers a message to a third party. It cannot be unsent.",
    rateLimit: { perMinute: 30 },
  },
  {
    name: "messages.read",
    toolName: "read_inbox",
    scope: "messages:read",
    description: "Read the handle's messages, newest first.",
    method: "GET",
    path: "/api/v1/messages/read",
    parameters: [
      { name: "channel", type: "string", required: false, description: "Restrict to one channel.", enum: ["email", "sms", "call"] },
      { name: "limit", type: "integer", required: false, description: "How many messages to return, up to 200." },
    ],
    rateLimit: { perMinute: 60 },
  },
  {
    name: "messages.otp_latest",
    toolName: "get_latest_otp",
    scope: "messages:read",
    description:
      "Return the most recent one-time code sent to the handle. Only inbound messages are searched, and only recent ones — a stale code would be rejected by whatever asked for it.",
    method: "GET",
    path: "/api/v1/messages/otp/latest",
    parameters: [
      { name: "channel", type: "string", required: false, description: "Restrict to one channel.", enum: ["email", "sms"] },
      { name: "from", type: "string", required: false, description: "Only consider messages from senders matching this." },
      { name: "within_minutes", type: "integer", required: false, description: "How far back to look. Defaults to 15." },
    ],
    rateLimit: { perMinute: 30 },
  },
  {
    name: "calls.make",
    toolName: "make_call",
    scope: "calls:make",
    description: "Place a voice call from the handle's number.",
    method: "POST",
    path: "/api/v1/calls",
    parameters: [
      { name: "to", type: "string", required: true, description: "E.164 phone number to call." },
      { name: "script", type: "string", required: true, description: "What the agent should say." },
    ],
    irreversible: true,
    effects: "Places a real phone call to a third party.",
    rateLimit: { perMinute: 5 },
  },
  {
    name: "calls.status",
    toolName: "call_status",
    scope: "calls:make",
    description: "Check the status and transcript of a call this handle placed.",
    method: "GET",
    path: "/api/v1/calls/status",
    parameters: [{ name: "call_id", type: "string", required: true, description: "Id returned by calls.make." }],
    rateLimit: { perMinute: 60 },
  },
];

export function actionByToolName(toolName: string) {
  return ACTIONS.find((action) => action.toolName === toolName);
}

/** JSON Schema for one action's parameters, as MCP and the catalogue want it. */
export function inputSchemaFor(action: ActionDefinition) {
  const properties: Record<string, unknown> = {};
  for (const parameter of action.parameters) {
    properties[parameter.name] = {
      type: parameter.type,
      description: parameter.description,
      ...(parameter.enum ? { enum: parameter.enum } : {}),
    };
  }

  return {
    type: "object" as const,
    properties,
    required: action.parameters.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  };
}

export function scopeDescription(scope: Scope) {
  return SCOPE_DESCRIPTIONS[scope];
}
