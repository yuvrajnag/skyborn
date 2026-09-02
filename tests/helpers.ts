import { Mode, PrismaClient } from "@prisma/client";

import { birthAgent } from "@/server/agents";
import { creditWalletManually } from "@/server/wallet";
import { prisma } from "@/lib/prisma";

let counter = 0;

export async function makeUser(prefix = "test") {
  counter += 1;
  return prisma.user.create({
    data: {
      email: `${prefix}-${Date.now()}-${counter}@test.local`,
      name: "Test Human",
      passwordHash: "not-a-real-hash",
    },
  });
}

export async function makeAgent(name = "Test Agent", mode: Mode = Mode.sandbox) {
  const user = await makeUser();
  const agent = await birthAgent({ userId: user.id, name, mode });
  return { user, agent, wallet: agent.wallet!, handle: agent.handle! };
}

/**
 * Forces a wallet to live mode, bypassing the Phase 1 birth guard.
 *
 * Any starting balance is credited while the wallet is still sandbox, so it is
 * backed by a real ledger entry — writing `balance` directly would leave the
 * cache disagreeing with the entries it is supposed to be a cache of.
 */
export async function makeLiveWallet(name = "Live Agent", fundPaise = 0n) {
  const { user, agent, wallet } = await makeAgent(name);
  if (fundPaise > 0n) {
    await creditWalletManually({ walletId: wallet.id, amountPaise: fundPaise });
  }
  const live = await prisma.wallet.update({
    where: { id: wallet.id },
    data: { mode: Mode.live },
  });
  return { user, agent, wallet: live };
}

export async function disconnect(client: PrismaClient = prisma) {
  await client.$disconnect();
}
