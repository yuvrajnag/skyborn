import { randomUUID } from "node:crypto";

import { Mode } from "@prisma/client";

/**
 * Money custody (spec Section 5).
 *
 * Skyborn does not hold customer money itself — a licensed payment
 * aggregator/BaaS partner's nodal account does, and Skyborn's ledger tracks
 * each Handle's claim on it. This module is the seam that partner sits behind,
 * so picking one in Phase 0 is a configuration change rather than a rewrite.
 *
 * Two drivers ship today:
 *   - `simulated` — settles instantly, moves no real money. Used whenever the
 *     relevant Razorpay keys are absent, which is the whole of sandbox mode.
 *   - `razorpay`  — the real Orders/e-mandate/RazorpayX calls. Selected as soon
 *     as keys are configured for the mode being used.
 *
 * Both satisfy the same interface so the wallet service never branches on which
 * one is live — only on `mode`, which it must (Section 14).
 */

export type ProviderMandate = {
  providerRef: string;
  /** Whether the human still has to complete the one-time AFA/OTP registration. */
  requiresHumanRegistration: boolean;
  registrationUrl?: string;
};

export type ProviderCharge = {
  providerRef: string;
  status: "captured" | "failed";
  failureCode?: string;
};

export type ProviderPayout = {
  providerRef: string;
  status: "processing" | "settled" | "failed";
  failureCode?: string;
};

export interface PaymentProvider {
  readonly id: string;
  /** Registers a standing UPI Autopay / e-mandate authorization. */
  createMandate(params: {
    walletId: string;
    capAmountPaise: bigint;
    capPeriod: string;
  }): Promise<ProviderMandate>;
  /** Pulls against an already-registered mandate. No OTP at call time. */
  chargeMandate(params: {
    mandateRef: string;
    amountPaise: bigint;
    idempotencyKey: string;
  }): Promise<ProviderCharge>;
  /** Withdraws to an external bank account or UPI handle. */
  createPayout(params: {
    amountPaise: bigint;
    destination: string;
    idempotencyKey: string;
  }): Promise<ProviderPayout>;
}

/** Settles everything instantly. Moves no real money, ever. */
export class SimulatedPaymentProvider implements PaymentProvider {
  readonly id = "simulated";

  async createMandate(params: {
    walletId: string;
    capAmountPaise: bigint;
    capPeriod: string;
  }): Promise<ProviderMandate> {
    return {
      providerRef: `sim_mandate_${params.walletId.slice(-8)}_${randomUUID().slice(0, 8)}`,
      // Sandbox skips the one-time AFA step; the real thing cannot.
      requiresHumanRegistration: false,
    };
  }

  async chargeMandate(params: {
    mandateRef: string;
    amountPaise: bigint;
    idempotencyKey: string;
  }): Promise<ProviderCharge> {
    return {
      providerRef: `sim_pay_${params.idempotencyKey.slice(0, 12)}`,
      status: "captured",
    };
  }

  async createPayout(params: {
    amountPaise: bigint;
    destination: string;
    idempotencyKey: string;
  }): Promise<ProviderPayout> {
    return {
      providerRef: `sim_payout_${params.idempotencyKey.slice(0, 12)}`,
      // Sandbox settles instantly; live mode would sit in `processing`.
      status: "settled",
    };
  }
}

/**
 * Razorpay-backed driver. Deliberately unimplemented rather than faked: a stub
 * that silently pretended to move real money is the one failure mode this whole
 * seam exists to prevent. Every method throws until Phase 10 wires the real
 * Orders / e-mandate / RazorpayX calls against a chosen custody partner.
 */
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly id = "razorpay";

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly mode: Mode,
  ) {}

  private notWired(operation: string): never {
    throw new PaymentProviderError(
      `Razorpay ${operation} is not wired up yet (Phase 10). ` +
        `Keys are present for ${this.mode} mode but no live call is implemented — ` +
        `refusing rather than silently simulating a real money movement.`,
      "PROVIDER_NOT_IMPLEMENTED",
    );
  }

  async createMandate(): Promise<ProviderMandate> {
    this.notWired("e-mandate registration");
  }

  async chargeMandate(): Promise<ProviderCharge> {
    this.notWired("mandate charge");
  }

  async createPayout(): Promise<ProviderPayout> {
    this.notWired("payout");
  }
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Picks the driver for a mode. Sandbox always simulates. Live requires real
 * keys — it never silently falls back to the simulator, because a live wallet
 * quietly running on fake money is strictly worse than a hard failure.
 */
export function paymentProviderFor(mode: Mode): PaymentProvider {
  if (mode === Mode.sandbox) {
    const keyId = process.env.RAZORPAY_KEY_ID_TEST;
    const keySecret = process.env.RAZORPAY_KEY_SECRET_TEST;
    if (keyId && keySecret) {
      return new RazorpayPaymentProvider(keyId, keySecret, Mode.sandbox);
    }
    return new SimulatedPaymentProvider();
  }

  const keyId = process.env.RAZORPAY_KEY_ID_LIVE;
  const keySecret = process.env.RAZORPAY_KEY_SECRET_LIVE;
  if (!keyId || !keySecret) {
    throw new PaymentProviderError(
      "Live mode needs real Razorpay live keys and a custody partner. Refusing to fall back to the simulator.",
      "LIVE_PROVIDER_UNCONFIGURED",
    );
  }
  return new RazorpayPaymentProvider(keyId, keySecret, Mode.live);
}
