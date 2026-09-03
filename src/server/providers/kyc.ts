import { randomUUID } from "node:crypto";

/**
 * Identity verification (spec Section 4).
 *
 * You cannot call UIDAI's Aadhaar API directly — that needs an AUA/KUA licence.
 * The realistic path is a licensed vendor doing Aadhaar Offline eKYC or
 * DigiLocker (Digio, Signzy, HyperVerge, IDfy), and for US users an equivalent
 * vendor (Persona, Trulioo, Plaid Identity). There is no public government API
 * for either.
 *
 * The single most important property of this interface is what it does *not*
 * carry: no method here accepts or returns a raw Aadhaar number or SSN. A
 * verification returns the vendor's verdict, its reference, and a masked tail
 * for display, because that is all Skyborn is allowed to keep. The full number
 * never reaches this process, so it cannot reach the database by accident.
 */

export type KycVerdict = {
  status: "verified" | "rejected" | "pending";
  /** The vendor's transaction id, for audit and dispute resolution. */
  vendorRef: string;
  /** Last four digits only, purely so the UI has something to show. */
  maskedTail?: string;
  /** Present when the vendor rejected. */
  reason?: string;
};

export interface KycProvider {
  readonly id: string;
  /**
   * Starts a verification. The identifier never passes through here — the
   * vendor collects it directly from the human in their own hosted flow, which
   * is what keeps it out of Skyborn entirely.
   */
  startVerification(params: {
    userId: string;
    redirectUrl: string;
  }): Promise<{ vendorRef: string; verificationUrl: string }>;

  /** Reads the vendor's verdict for a started verification. */
  checkVerification(vendorRef: string): Promise<KycVerdict>;
}

/**
 * Approves instantly and stores a fixed masked tail. Used whenever no vendor is
 * configured, which is the whole of sandbox. It never sees an identifier
 * either — there is nowhere in this interface to put one.
 */
export class SimulatedKycProvider implements KycProvider {
  readonly id = "simulated";

  async startVerification(params: { userId: string; redirectUrl: string }) {
    const vendorRef = `sim_kyc_${params.userId.slice(-8)}_${randomUUID().slice(0, 8)}`;
    return { vendorRef, verificationUrl: params.redirectUrl };
  }

  async checkVerification(vendorRef: string): Promise<KycVerdict> {
    return { status: "verified", vendorRef, maskedTail: "0000" };
  }
}

export class KycProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * A real vendor, deliberately unimplemented. Which one is a Phase 0 business
 * decision, and the API shapes differ enough between Digio, Signzy, HyperVerge
 * and IDfy that guessing one would be worse than refusing: a KYC integration
 * that silently approves is the single most dangerous stub in this codebase.
 */
export class VendorKycProvider implements KycProvider {
  readonly id = "vendor";

  constructor(private readonly apiKey: string) {}

  private notWired(operation: string): never {
    throw new KycProviderError(
      `KYC ${operation} is not wired up. A KYC_VENDOR_API_KEY is set, but no vendor was chosen in Phase 0 — ` +
        "refusing rather than approving an identity nobody checked.",
      "PROVIDER_NOT_IMPLEMENTED",
    );
  }

  async startVerification(): Promise<{ vendorRef: string; verificationUrl: string }> {
    this.notWired("start");
  }

  async checkVerification(): Promise<KycVerdict> {
    this.notWired("status check");
  }
}

export function kycProvider(): KycProvider {
  const apiKey = process.env.KYC_VENDOR_API_KEY;
  return apiKey ? new VendorKycProvider(apiKey) : new SimulatedKycProvider();
}

/** True when identity checks are backed by a real vendor. */
export function kycIsLive(): boolean {
  return kycProvider().id !== "simulated";
}
