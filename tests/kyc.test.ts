import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { KycStatus, Mode } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  KycError,
  canUseLiveMode,
  completeKyc,
  custodyPartnerConfigured,
  promoteToLiveMode,
  startKyc,
} from "@/server/kyc";
import { cardIssuingAvailable, cardIssuingProvider } from "@/server/providers/cards";
import { creditWalletManually } from "@/server/wallet";
import { makeAgent, makeUser } from "./helpers";

after(async () => {
  await prisma.$disconnect();
});

describe("KYC", () => {
  it("stores the verdict, reference and masked tail — and nothing else", async () => {
    const user = await makeUser("kyc");
    await startKyc({ userId: user.id, redirectUrl: "http://localhost:3000/dashboard/verify" });
    const verified = await completeKyc(user.id);

    assert.equal(verified.kycStatus, KycStatus.verified);
    assert.equal(verified.kycVendor, "simulated");
    assert.ok(verified.kycVendorRef?.startsWith("sim_kyc_"));
    assert.equal(verified.kycMaskedTail, "0000");
    assert.equal(verified.kycMaskedTail?.length, 4);
    assert.ok(verified.kycVerifiedAt);
  });

  it("has no column a raw identifier could be written to", async () => {
    // The guarantee is structural: if a field for it existed, something would
    // eventually put one there.
    const columns: Array<{ column_name: string }> = await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'User'`,
    );
    const names = columns.map((c) => c.column_name.toLowerCase());

    for (const forbidden of ["aadhaar", "aadhar", "ssn", "nationalid", "national_id", "pan"]) {
      assert.ok(
        !names.some((n) => n.includes(forbidden)),
        `User table must not have a column matching "${forbidden}" — found ${names.join(", ")}`,
      );
    }
  });

  it("refuses to complete a verification that was never started", async () => {
    const user = await makeUser("kyc-none");
    await assert.rejects(
      completeKyc(user.id),
      (e: KycError) => e.code === "NO_VERIFICATION",
    );
  });
});

describe("live mode gate", () => {
  it("refuses an unverified human", async () => {
    const user = await makeUser("unverified");
    const check = await canUseLiveMode(user.id);
    assert.equal(check.allowed, false);
    assert.equal(check.allowed === false && check.code, "KYC_REQUIRED");
  });

  it("still refuses a verified human with no custody partner", async () => {
    const user = await makeUser("verified");
    await startKyc({ userId: user.id, redirectUrl: "http://localhost:3000/x" });
    await completeKyc(user.id);

    // No CUSTODY_PARTNER_API_KEY in this environment, which is the point: a
    // verified human alone does not make a wallet that holds real money.
    assert.equal(custodyPartnerConfigured(), false);

    const check = await canUseLiveMode(user.id);
    assert.equal(check.allowed, false);
    assert.equal(check.allowed === false && check.code, "NO_CUSTODY_PARTNER");
  });

  it("refuses to promote an agent while the gate is closed", async () => {
    const { user, agent } = await makeAgent("Promote Agent");
    await assert.rejects(
      promoteToLiveMode({ userId: user.id, agentId: agent.id }),
      (e: KycError) => e.code === "KYC_REQUIRED",
    );

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { agentId: agent.id } });
    assert.equal(wallet.mode, Mode.sandbox);
  });

  it("refuses to carry a sandbox balance into live mode", async () => {
    const { user, agent, wallet } = await makeAgent("Balance Carry Agent");
    await startKyc({ userId: user.id, redirectUrl: "http://localhost:3000/x" });
    await completeKyc(user.id);
    await creditWalletManually({ walletId: wallet.id, amountPaise: 100_000n });

    // Fails on custody first here, but the balance rule is the one that matters
    // once a partner exists: sandbox money is backed by nothing.
    await assert.rejects(promoteToLiveMode({ userId: user.id, agentId: agent.id }));
  });
});

describe("virtual cards", () => {
  it("refuses clearly rather than pretending", async () => {
    assert.equal(cardIssuingAvailable(), false);

    await assert.rejects(
      cardIssuingProvider().issueSingleUseCard({ walletId: "w", amountPaise: 10_000n }),
      (e: Error & { code?: string }) => {
        assert.equal(e.code, "CARD_ISSUING_UNAVAILABLE");
        // The refusal has to say the OTP limit is a rule about card rails, not
        // a gap in the code, or someone will wait for a fix that cannot come.
        assert.match(e.message, /OTP/);
        assert.match(e.message, /wallet\.transfer/);
        return true;
      },
    );
  });
});
