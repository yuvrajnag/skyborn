import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Credential handling for the Auth API.
 *
 * Nothing issued here is stored in the clear. Client secrets, API keys, access
 * tokens and refresh tokens are all shown exactly once at issue time and kept
 * only as SHA-256 hashes, so a database read cannot recover a working
 * credential.
 *
 * SHA-256 rather than bcrypt is deliberate for these: they are 256-bit random
 * strings, not passwords, so there is no dictionary to slow down, and they are
 * verified on every API call where a bcrypt round would be a real cost.
 * Human passwords still go through bcrypt (src/lib/auth.ts).
 */

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokensMatch(candidate: string, storedHash: string): boolean {
  const left = Buffer.from(hashToken(candidate), "hex");
  const right = Buffer.from(storedHash, "hex");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Access tokens are short-lived; refresh tokens carry the long tail. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function expiryFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}
