/**
 * The scope vocabulary (spec Section 7). A Grant carries a subset of these,
 * and every action names exactly one it requires.
 */
export const SCOPES = [
  "wallet:read",
  "wallet:transfer",
  "wallet:topup",
  "wallet:payout",
  "wallet:refund",
  "messages:send",
  "messages:read",
  "calls:make",
] as const;

export type Scope = (typeof SCOPES)[number];

/** Scopes that can move money out of a wallet, and so hit the spending cap. */
export const MONEY_OUT_SCOPES: readonly Scope[] = [
  "wallet:transfer",
  "wallet:payout",
];

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

export function parseScopes(input: unknown): Scope[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/[\s,]+/)
      : [];

  const cleaned = raw
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);

  const unknown = cleaned.filter((value) => !isScope(value));
  if (unknown.length > 0) {
    throw new Error(`Unknown scope(s): ${unknown.join(", ")}`);
  }

  return [...new Set(cleaned as Scope[])];
}

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  "wallet:read": "Read the wallet balance and transaction history",
  "wallet:transfer": "Send money to another handle",
  "wallet:topup": "Pull funds from the standing mandate",
  "wallet:payout": "Withdraw to an external bank account or UPI handle",
  "wallet:refund": "Reverse a prior transfer or top-up",
  "messages:send": "Send email and SMS from the handle",
  "messages:read": "Read the handle's inbox, including one-time codes",
  "calls:make": "Place voice calls from the handle's number",
};
