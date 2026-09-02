/**
 * Money is stored as paise (integer minor units) in BigInt columns everywhere.
 * Nothing in this codebase should ever hold a rupee amount in a float.
 */

export const PAISE_PER_RUPEE = 100n;

/** RBI e-mandate: recurring debits up to ₹15,000 need no OTP (spec Section 11). */
export const DEFAULT_MANDATE_CAP_PAISE = 1_500_000n;

/** Thrown when a user-typed amount is not a valid rupee figure. */
export class MoneyParseError extends Error {}

/** Parses a user-typed rupee string ("1234.50") into paise. */
export function rupeesToPaise(input: string | number): bigint {
  const raw = String(input).trim().replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new MoneyParseError(
      "Enter an amount in rupees, with at most two decimal places.",
    );
  }
  const [whole, fraction = ""] = raw.split(".");
  const paise = fraction.padEnd(2, "0");
  return BigInt(whole) * PAISE_PER_RUPEE + BigInt(paise);
}

/** "123456" -> "1,234.56" — digits only, no symbol. */
export function formatPaise(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = abs / PAISE_PER_RUPEE;
  const fraction = (abs % PAISE_PER_RUPEE).toString().padStart(2, "0");
  // Indian digit grouping: last three digits, then pairs.
  const digits = whole.toString();
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  const grouped = head
    ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${tail}`
    : tail;
  return `${negative ? "-" : ""}${grouped}.${fraction}`;
}

/** "₹1,234.56" */
export function formatRupees(paise: bigint): string {
  return `₹${formatPaise(paise)}`;
}
