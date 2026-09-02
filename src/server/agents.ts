import { Mode, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  handleDiscriminator,
  handleEmailFor,
  internalPhoneNumber,
  slugifyAgentName,
} from "@/server/handles";

/**
 * Agent birth (spec Section 1). Creating an Agent, its Handle and its Wallet is
 * one atomic act — an agent without a Handle or without a Wallet is not a thing
 * that should ever exist in the database.
 */

export const MAX_AGENTS_PER_USER = 25;

export class AgentBirthError extends Error {}

export async function birthAgent(params: {
  userId: string;
  name: string;
  mode?: Mode;
}) {
  const name = params.name.trim();
  if (name.length < 2 || name.length > 60) {
    throw new AgentBirthError("Give the agent a name between 2 and 60 characters.");
  }

  // Phase 1 is sandbox-only: live mode is gated behind KYC (Sections 14, 16).
  const mode = params.mode ?? Mode.sandbox;
  if (mode === Mode.live) {
    throw new AgentBirthError(
      "Live mode is not available yet — it unlocks with identity verification in a later phase.",
    );
  }

  const existing = await prisma.agent.count({ where: { userId: params.userId } });
  if (existing >= MAX_AGENTS_PER_USER) {
    throw new AgentBirthError(`You can hold at most ${MAX_AGENTS_PER_USER} agents.`);
  }

  const baseSlug = slugifyAgentName(name);

  // Retry on the (userId, slug) and Handle uniqueness constraints rather than
  // pre-checking, so two concurrent births cannot both pass the same check.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
    const discriminator = handleDiscriminator();

    try {
      return await prisma.agent.create({
        data: {
          userId: params.userId,
          name,
          slug,
          handle: {
            create: {
              email: handleEmailFor(slug, discriminator),
              phone: internalPhoneNumber(),
              mode,
              provisioned: false,
            },
          },
          wallet: { create: { balance: 0n, mode } },
        },
        include: { handle: true, wallet: true },
      });
    } catch (error) {
      const isUniqueViolation =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      if (!isUniqueViolation) throw error;
    }
  }

  throw new AgentBirthError(
    "Could not allocate a unique handle for that name — try a slightly different one.",
  );
}

export async function listAgentsForUser(userId: string) {
  return prisma.agent.findMany({
    where: { userId },
    include: { handle: true, wallet: true },
    orderBy: { createdAt: "desc" },
  });
}

/** Loads one agent, scoped to its owner — never trust an id from the URL alone. */
export async function getAgentForUser(userId: string, agentId: string) {
  return prisma.agent.findFirst({
    where: { id: agentId, userId },
    include: { handle: true, wallet: true },
  });
}
