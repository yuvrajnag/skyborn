import { KycStatus, Mode } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { kycProvider } from "@/server/providers/kyc";

/**
 * KYC (Phase 9) and the live-mode gate (Phase 10).
 *
 * Two rules hold the whole thing together:
 *   - Skyborn stores the vendor's verdict, reference and a masked tail. Never
 *     the number itself. The provider interface has nowhere to put one, so
 *     this is structural rather than a convention someone has to remember.
 *   - Live mode requires both a verified human and a configured custody
 *     partner. Either one missing is a hard refusal, never a downgrade to
 *     sandbox behaviour on real money.
 */

export class KycError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export async function startKyc(params: { userId: string; redirectUrl: string }) {
  const provider = kycProvider();
  const { vendorRef, verificationUrl } = await provider.startVerification({
    userId: params.userId,
    redirectUrl: params.redirectUrl,
  });

  await prisma.user.update({
    where: { id: params.userId },
    data: {
      kycStatus: KycStatus.pending,
      kycVendor: provider.id,
      kycVendorRef: vendorRef,
    },
  });

  return { vendorRef, verificationUrl };
}

export async function completeKyc(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.kycVendorRef) {
    throw new KycError("No verification has been started for this account.", "NO_VERIFICATION");
  }

  const verdict = await kycProvider().checkVerification(user.kycVendorRef);

  return prisma.user.update({
    where: { id: userId },
    data: {
      kycStatus:
        verdict.status === "verified"
          ? KycStatus.verified
          : verdict.status === "rejected"
            ? KycStatus.rejected
            : KycStatus.pending,
      // Only ever the last four digits, and only for display.
      kycMaskedTail: verdict.maskedTail ?? null,
      kycVerifiedAt: verdict.status === "verified" ? new Date() : null,
    },
  });
}

/** Whether this deployment can hold real money at all. */
export function custodyPartnerConfigured(): boolean {
  return Boolean(
    process.env.CUSTODY_PARTNER_API_KEY &&
      process.env.RAZORPAY_KEY_ID_LIVE &&
      process.env.RAZORPAY_KEY_SECRET_LIVE,
  );
}

export type LiveModeCheck =
  | { allowed: true }
  | { allowed: false; code: string; reason: string };

/**
 * The Phase 10 gate. Both conditions are real: a verified human satisfies the
 * regulatory requirement, and a configured custody partner is what makes the
 * money actually exist somewhere. Passing one without the other is not
 * "partially live", it is a wallet with no money behind it.
 */
export async function canUseLiveMode(userId: string): Promise<LiveModeCheck> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { allowed: false, code: "NO_USER", reason: "No such account." };

  if (user.kycStatus !== KycStatus.verified) {
    return {
      allowed: false,
      code: "KYC_REQUIRED",
      reason:
        "Live mode needs a completed identity check. Sandbox works without one.",
    };
  }

  if (!custodyPartnerConfigured()) {
    return {
      allowed: false,
      code: "NO_CUSTODY_PARTNER",
      reason:
        "This deployment has no money-custody partner configured, so there is no nodal account for real funds to sit in. Skyborn never self-issues a wallet.",
    };
  }

  return { allowed: true };
}

/** Promotes an agent's handle and wallet to live mode, once both gates pass. */
export async function promoteToLiveMode(params: { userId: string; agentId: string }) {
  const check = await canUseLiveMode(params.userId);
  if (!check.allowed) throw new KycError(check.reason, check.code);

  const agent = await prisma.agent.findFirst({
    where: { id: params.agentId, userId: params.userId },
    include: { wallet: true },
  });
  if (!agent?.wallet) throw new KycError("No such agent.", "AGENT_NOT_FOUND");

  // A wallet holding sandbox money must not carry that balance into live mode:
  // the sandbox balance is not backed by anything at the custody partner.
  if (agent.wallet.balance !== 0n) {
    throw new KycError(
      "Empty the sandbox wallet before switching it to live. Sandbox money is not backed by real funds and cannot cross over.",
      "SANDBOX_BALANCE_PRESENT",
    );
  }

  return prisma.$transaction([
    prisma.wallet.update({ where: { id: agent.wallet.id }, data: { mode: Mode.live } }),
    prisma.handle.update({ where: { agentId: agent.id }, data: { mode: Mode.live } }),
  ]);
}
