/**
 * Seeds a Phase 1 sandbox: two humans, three agents with handles and wallets,
 * a couple of ledger entries, and one DevApp so the Phase 4 tables are not
 * empty when the Auth API lands.
 *
 * Idempotent — safe to re-run. `npm run db:seed`.
 */

import { randomBytes, createHash } from "node:crypto";

import { GrantStatus, LedgerDirection, LedgerEntryType, Mode, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

import {
  handleDiscriminator,
  handleEmailFor,
  internalPhoneNumber,
  slugifyAgentName,
} from "../src/server/handles";

const prisma = new PrismaClient();

const DEMO_PASSWORD = "skyborn-sandbox";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function upsertUser(email: string, name: string) {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  return prisma.user.upsert({
    where: { email },
    update: { name },
    create: { email, name, passwordHash },
  });
}

async function upsertAgent(userId: string, name: string) {
  const slug = slugifyAgentName(name);
  const existing = await prisma.agent.findUnique({
    where: { userId_slug: { userId, slug } },
    include: { handle: true, wallet: true },
  });
  if (existing) return existing;

  return prisma.agent.create({
    data: {
      userId,
      name,
      slug,
      handle: {
        create: {
          email: handleEmailFor(slug, handleDiscriminator()),
          phone: internalPhoneNumber(),
          mode: Mode.sandbox,
        },
      },
      wallet: { create: { mode: Mode.sandbox } },
    },
    include: { handle: true, wallet: true },
  });
}

/** Writes a ledger entry and moves the cached balance in the same transaction. */
async function credit(walletId: string, amountPaise: bigint, description: string) {
  const already = await prisma.ledgerEntry.findFirst({
    where: { walletId, description },
  });
  if (already) return;

  await prisma.$transaction([
    prisma.ledgerEntry.create({
      data: {
        walletId,
        amount: amountPaise,
        direction: LedgerDirection.credit,
        type: LedgerEntryType.manual_credit,
        counterparty: "skyborn:sandbox",
        description,
      },
    }),
    prisma.wallet.update({
      where: { id: walletId },
      data: { balance: { increment: amountPaise } },
    }),
  ]);
}

async function main() {
  const ada = await upsertUser("ada@example.com", "Ada Lovelace");
  const dev = await upsertUser("dev@example.com", "Dev Sharma");

  const groceries = await upsertAgent(ada.id, "Groceries Buyer");
  const travel = await upsertAgent(ada.id, "Travel Booker");
  const ops = await upsertAgent(dev.id, "Ops Runner");

  if (groceries.wallet) {
    await credit(groceries.wallet.id, 500_000n, "Seed float");
    await credit(groceries.wallet.id, 125_050n, "Weekly allowance");
  }
  if (travel.wallet) {
    await credit(travel.wallet.id, 2_000_000n, "Trip budget");
  }

  // A DevApp so Phase 4's Auth API has something to issue Grants against.
  // Secrets are hashed here exactly as the real registration flow will hash them.
  const clientId = "sky_app_seeded_demo";
  const clientSecret = randomBytes(24).toString("hex");
  const sandboxKeyId = "sky_sk_sandbox_seeded_demo";
  const sandboxKeySecret = randomBytes(24).toString("hex");

  const devApp = await prisma.devApp.upsert({
    where: { clientId },
    update: {},
    create: {
      userId: dev.id,
      name: "Demo Concierge",
      clientId,
      clientSecretHash: sha256(clientSecret),
      sandboxKeyId,
      sandboxKeySecretHash: sha256(sandboxKeySecret),
    },
  });

  const existingGrant = await prisma.grant.findFirst({
    where: { devAppId: devApp.id, agentId: ops.id },
  });
  if (!existingGrant) {
    await prisma.grant.create({
      data: {
        devAppId: devApp.id,
        agentId: ops.id,
        scopes: ["wallet:read", "wallet:transfer", "messages:send"],
        spendingCap: 1_000_000n,
        mode: Mode.sandbox,
        // Still `pending`: no consent flow exists until Phase 4, and nothing
        // should behave as though a human has approved anything.
        status: GrantStatus.pending,
      },
    });
  }

  console.log("Seeded sandbox data.");
  console.log(`  Sign in as ada@example.com or dev@example.com`);
  console.log(`  Password: ${DEMO_PASSWORD}`);
  console.log(`  Demo DevApp client secret (shown once): ${clientSecret}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
