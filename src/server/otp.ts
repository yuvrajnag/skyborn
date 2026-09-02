/**
 * One-time-code extraction (spec Section 12, Phase 3).
 *
 * An agent pulling its own OTP is the difference between "autonomous" and
 * "needs a human at the worst moment", so this parser has one job it must not
 * get wrong: never hand back a number that is not a code. A missed code costs a
 * retry. A wrong one gets typed into somebody's login form.
 *
 * Two rules carry most of the weight:
 *
 *   1. A number is only ever a candidate if the message contains a code word at
 *      all. Bare numbers — order ids, amounts, tracking refs — are not codes no
 *      matter how code-shaped they look.
 *   2. A label binds tightly to the number that follows it. "order 45219" is an
 *      order even in a message that also carries an OTP, because the label sits
 *      immediately before the digits.
 *
 * Note what is deliberately *not* disqualifying: amounts, validity windows and
 * the word "transaction". Those are the hallmarks of a real bank OTP
 * ("550132 is the OTP for your transaction of Rs 2,499, valid 10 minutes"),
 * so treating them as negative signals would reject the most common message
 * of all.
 */

export type OtpCandidate = {
  code: string;
  /** 0-1. Only candidates at or above MIN_CONFIDENCE are returned. */
  confidence: number;
  /** The phrase the code was found in, for display in an audit log. */
  context: string;
};

const MIN_CONFIDENCE = 0.5;

/** Words that make a nearby number likely to be a one-time code. */
const CODE_WORDS = [
  "one-time password",
  "one time password",
  "one-time passcode",
  "one time passcode",
  "verification code",
  "confirmation code",
  "security code",
  "authentication code",
  "auth code",
  "access code",
  "login code",
  "log-in code",
  "sign-in code",
  "sign in code",
  "one-time",
  "one time",
  "onetime",
  "passcode",
  "password",
  "verification",
  "verify",
  "authenticate",
  "confirm",
  "sign in",
  "sign-in",
  "log in",
  "otp",
  "2fa",
  "mfa",
  "code",
  "pin",
];

/**
 * Labels that claim the number immediately after them. Matched against a short
 * window ending at the digits, so they cannot reach across a sentence and veto
 * an unrelated code.
 */
const LABEL_BEFORE =
  /\b(?:order|invoice|reference|ref|acct|account|tracking|awb|ticket|booking|pnr|txn|card\s+ending|ending|policy|complaint|receipt|bill|seat|flight|room)\s*(?:number|no\.?|id|#|:)?\s*$/i;

/** A run of 4-8 digits, optionally split once by a space or hyphen. */
const CANDIDATE_PATTERN = /\b(\d{3,4}[\s-]\d{1,4}|\d{4,8})\b/g;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function looksLikeMoney(text: string, start: number): boolean {
  return /(?:₹|rs\.?|inr|usd|\$|€|£)\s*$/i.test(text.slice(Math.max(0, start - 12), start));
}

function looksLikeYear(code: string): boolean {
  if (code.length !== 4) return false;
  const n = Number(code);
  return n >= 1900 && n <= 2100;
}

/**
 * True when the digits are a slice of a longer number. A trailing "." or ","
 * only continues the number if a digit follows it — otherwise it is just the
 * end of the sentence, which is where codes very often sit.
 */
function isPartOfLongerNumber(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  if (before !== undefined && /[\d+]/.test(before)) return true;
  if (before !== undefined && /[.,]/.test(before) && /\d/.test(text[start - 2] ?? "")) {
    return true;
  }

  const after = text[end];
  if (after !== undefined && /\d/.test(after)) return true;
  if (after !== undefined && /[.,]/.test(after) && /\d/.test(text[end + 1] ?? "")) return true;

  return false;
}

export function extractOtp(rawText: string): OtpCandidate | null {
  if (!rawText) return null;

  const text = normalize(rawText);
  const lower = text.toLowerCase();

  // Rule 1: no code word anywhere means no code, whatever the digits look like.
  if (!CODE_WORDS.some((word) => lower.includes(word))) return null;

  const candidates: OtpCandidate[] = [];

  for (const match of text.matchAll(CANDIDATE_PATTERN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const end = start + raw.length;
    const code = raw.replace(/[\s-]/g, "");

    if (code.length < 4 || code.length > 8) continue;
    if (isPartOfLongerNumber(text, start, end)) continue;
    if (looksLikeMoney(text, start)) continue;

    // Rule 2: a label immediately before the digits claims them.
    if (LABEL_BEFORE.test(lower.slice(Math.max(0, start - 24), start))) continue;

    const before = lower.slice(Math.max(0, start - 44), start);
    const after = lower.slice(end, end + 44);
    const near = `${before} ${after}`;

    let score = 0;

    const nearCodeWord = CODE_WORDS.some((word) => near.includes(word));
    if (nearCodeWord) score += 0.55;

    // The two dominant shapes: "<code> is your ..." and "... code is <code>".
    if (/\b(?:is|use|enter|using)\b[^.]{0,26}$/.test(before)) score += 0.2;
    if (/^[^.]{0,26}\bis\b/.test(after)) score += 0.2;

    // 6 digits is overwhelmingly the common length, then 4, then 8.
    if (code.length === 6) score += 0.2;
    else if (code.length === 4 || code.length === 8) score += 0.1;

    // A year-shaped number needs a code word right beside it to survive.
    if (looksLikeYear(code)) score -= 0.4;

    if (score >= MIN_CONFIDENCE) {
      candidates.push({
        code,
        confidence: Math.min(1, Number(score.toFixed(3))),
        context: text.slice(Math.max(0, start - 30), Math.min(text.length, end + 30)).trim(),
      });
    }
  }

  if (candidates.length === 0) return null;

  // Highest score wins; ties go to the earliest, which is the one the sender
  // led with.
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates[0];
}
