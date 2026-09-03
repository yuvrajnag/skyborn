/**
 * Virtual card issuance (spec Section 11, Phase 11 — stretch).
 *
 * This file is an interface and a refusal, on purpose. Two things stop it being
 * anything more:
 *
 * 1. Issuing a card needs a licensed card-issuing partner (Zeta, M2P, Karbon in
 *    India) with real onboarding lead time. There is no sandbox that produces a
 *    card number a merchant will accept, so a "working" implementation here
 *    would be a fiction.
 *
 * 2. More importantly, this path cannot deliver the zero-touch guarantee the
 *    rest of the platform is built on, and no amount of implementation changes
 *    that. A genuinely arbitrary one-off card purchase at a merchant with no
 *    prior mandate relationship hits India's card-not-present AFA requirement,
 *    so the human is asked for an OTP. That is a rule about card rails, not a
 *    gap in this code — which is why global players in this space lean on
 *    non-card rails instead.
 *
 * So the honest shape is: define the interface, refuse clearly, and make sure
 * nothing in the product claims otherwise. wallet.transfer remains the primary
 * send-money primitive (Section 11) precisely because it has none of this
 * problem.
 */

export type VirtualCard = {
  cardId: string;
  /** Last four only. A full PAN must never reach this database. */
  maskedPan: string;
  expiryMonth: number;
  expiryYear: number;
  amountPaise: bigint;
  status: "active" | "used" | "expired" | "cancelled";
};

export interface CardIssuingProvider {
  readonly id: string;
  issueSingleUseCard(params: {
    walletId: string;
    amountPaise: bigint;
    merchantHint?: string;
  }): Promise<VirtualCard>;
  cancelCard(cardId: string): Promise<void>;
}

export class CardIssuingUnavailableError extends Error {
  readonly code = "CARD_ISSUING_UNAVAILABLE";
}

const UNAVAILABLE =
  "Virtual card issuance needs a licensed card-issuing partner, which is not connected. " +
  "Note also that a one-off card purchase at a merchant with no prior mandate relationship " +
  "still requires OTP under India's card-not-present rules, so this path cannot be zero-touch " +
  "even once a partner is connected. Use wallet.transfer for agent-to-agent and " +
  "agent-to-registered-merchant payments — it has no such ceiling.";

/** Always refuses, and says why in terms a caller can act on. */
export class UnavailableCardProvider implements CardIssuingProvider {
  readonly id = "unavailable";

  async issueSingleUseCard(): Promise<VirtualCard> {
    throw new CardIssuingUnavailableError(UNAVAILABLE);
  }

  async cancelCard(): Promise<void> {
    throw new CardIssuingUnavailableError(UNAVAILABLE);
  }
}

export function cardIssuingProvider(): CardIssuingProvider {
  return new UnavailableCardProvider();
}

export function cardIssuingAvailable(): boolean {
  return false;
}
