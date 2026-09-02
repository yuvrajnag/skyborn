import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Inbound provider webhooks are unauthenticated HTTP until proven otherwise:
 * anyone who learns the URL can POST to it, and a forged inbound message would
 * put an attacker-chosen OTP in front of an agent. So every inbound route
 * verifies a shared secret before it writes anything.
 */

export function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Postmark has no request signing, so a secret in the URL is the mechanism. */
export function verifySharedSecret(provided: string | null, expected: string | undefined) {
  if (!expected) {
    return { ok: false as const, reason: "Webhook secret is not configured on this deployment." };
  }
  if (!provided || !timingSafeEquals(provided, expected)) {
    return { ok: false as const, reason: "Bad webhook secret." };
  }
  return { ok: true as const };
}

/**
 * Twilio signs each request: base64(HMAC-SHA1(authToken, url + sorted params)).
 * Verified here rather than trusting the body.
 */
export function verifyTwilioSignature(params: {
  signature: string | null;
  url: string;
  body: Record<string, string>;
  authToken: string | undefined;
}): boolean {
  if (!params.signature || !params.authToken) return false;

  const payload = Object.keys(params.body)
    .sort()
    .reduce((acc, key) => acc + key + params.body[key], params.url);

  const expected = createHmac("sha1", params.authToken).update(payload).digest("base64");
  return timingSafeEquals(params.signature, expected);
}
