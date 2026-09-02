import { randomInt } from "node:crypto";

/**
 * Phase 1 Handle provisioning — internal only.
 *
 * These addresses are deliberately unroutable so nothing can mistake them for
 * a real inbox or a real phone line before Phase 3 wires up Postmark and
 * Twilio:
 *   - the email domain defaults to a `.local` domain (RFC 6762 reserved), and
 *   - the phone number uses country code +99, which E.164 does not assign.
 *
 * Phase 3 replaces both with real provider-issued values and flips
 * Handle.provisioned to true; the column shapes do not change.
 */

const EMAIL_DOMAIN = process.env.SKYBORN_HANDLE_EMAIL_DOMAIN ?? "agents.skyborn.local";

/** "Ada's Buyer Bot" -> "adas-buyer-bot" */
export function slugifyAgentName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "agent";
}

export function handleEmailFor(slug: string, discriminator: string): string {
  return `${slug}.${discriminator}@${EMAIL_DOMAIN}`;
}

/** An internal, non-dialable placeholder number in E.164 shape. */
export function internalPhoneNumber(): string {
  let digits = "";
  for (let i = 0; i < 10; i += 1) digits += randomInt(0, 10).toString();
  return `+99${digits}`;
}

/** Short random suffix that keeps handle emails unique across owners. */
export function handleDiscriminator(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 6; i += 1) out += alphabet[randomInt(0, alphabet.length)];
  return out;
}

export const HANDLE_EMAIL_DOMAIN = EMAIL_DOMAIN;
