import { NextResponse } from "next/server";

import { CoreError } from "@/server/core";
import { GrantError, authenticateBearer, bearerFromHeader } from "@/server/grants";
import { MoneyParseError } from "@/lib/money";
import { WalletError } from "@/server/wallet";
import { MessagingError } from "@/server/messaging";
import { PaymentProviderError } from "@/server/providers/payments";
import { MessagingProviderError } from "@/server/providers/messaging";

/**
 * Shared plumbing for the agent-facing REST surface.
 *
 * Note what this does not do: it never trusts an id in the body to decide which
 * wallet or handle is being acted on. The bearer token resolves to exactly one
 * Grant, and the Grant names the agent. Everything else in the request is
 * parameters, not authorization.
 */

export type ApiErrorBody = { error: { code: string; message: string } };

export function apiError(code: string, message: string, status: number) {
  return NextResponse.json<ApiErrorBody>({ error: { code, message } }, { status });
}

/** Maps a thrown domain error onto its wire status. */
export function errorResponse(error: unknown) {
  if (error instanceof GrantError || error instanceof CoreError) {
    return apiError(error.code, error.message, error.status);
  }
  if (error instanceof WalletError) {
    const status = error.code === "INSUFFICIENT_FUNDS" ? 409 : 400;
    return apiError(error.code, error.message, status);
  }
  if (error instanceof MessagingError) {
    return apiError(error.code, error.message, 400);
  }
  if (error instanceof MoneyParseError) {
    return apiError("INVALID_AMOUNT", error.message, 400);
  }
  if (error instanceof PaymentProviderError || error instanceof MessagingProviderError) {
    // The provider is not wired up or refused — the caller did nothing wrong.
    return apiError(error.code, error.message, 502);
  }

  console.error("Unhandled API error:", error);
  return apiError("INTERNAL_ERROR", "Something went wrong.", 500);
}

/** Resolves the request's bearer token to its Grant. */
export async function grantFromRequest(request: Request) {
  return authenticateBearer(bearerFromHeader(request.headers.get("authorization")));
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // An empty or malformed body is treated as no parameters; the field
    // validators below produce the specific complaint.
  }
  return {};
}

/**
 * Amounts cross the wire as integer paise strings, never as JSON numbers —
 * a rupee amount above 2^53 paise would silently lose precision as a double,
 * and a fractional paise is not a thing that exists.
 */
export function requirePaise(body: Record<string, unknown>, field = "amount_paise"): bigint {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === "") {
    throw new CoreError(`${field} is required.`, "MISSING_FIELD");
  }
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      throw new CoreError(`${field} must be a whole number of paise.`, "INVALID_AMOUNT");
    }
    return BigInt(raw);
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    throw new CoreError(
      `${field} must be a whole number of paise, as a string.`,
      "INVALID_AMOUNT",
    );
  }
  return BigInt(raw.trim());
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const raw = body[field];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new CoreError(`${field} is required.`, "MISSING_FIELD");
  }
  return raw.trim();
}

export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const raw = body[field];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** The idempotency key travels in a header, as it does everywhere else. */
export function idempotencyKey(request: Request): string | undefined {
  return request.headers.get("idempotency-key")?.trim() || undefined;
}
