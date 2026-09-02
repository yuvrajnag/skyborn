/**
 * Mints a ready-to-use agent token against the local database, so the REST,
 * AXL and MCP surfaces can be exercised without clicking through the consent
 * page by hand.
 *
 *   npx tsx scripts/dev-grant.ts
 *
 * Sandbox only — it approves the grant on the owner's behalf, which is exactly
 * the step a human is supposed to perform, so it must never be reachable from
 * anything but a developer's own machine.
 */

import { MessageChannel, Mode } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { birthAgent } from "@/server/agents";
import {
  approveGrant,
  exchangeGrantForTokens,
  registerDevApp,
  requestGrant,
} from "@/server/grants";
import { recordInboundMessage } from "@/server/messaging";
import { createFundingMandate, creditWalletManually } from "@/server/wallet";
import { SCOPES } from "@/lib/scopes";

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("dev-grant.ts approves a grant without a human. Never run it in production.");
  }

  const stamp = Date.now();
  const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

  const owner = await prisma.user.create({
    data: { email: `dev-owner-${stamp}@local`, name: "Dev Owner", passwordHash: "unusable" },
  });
  const developer = await prisma.user.create({
    data: { email: `dev-builder-${stamp}@local`, name: "Dev Builder", passwordHash: "unusable" },
  });

  const agent = await birthAgent({ userId: owner.id, name: `Dev Agent ${stamp}`, mode: Mode.sandbox });
  const recipient = await birthAgent({ userId: owner.id, name: `Dev Recipient ${stamp}` });

  await creditWalletManually({ walletId: agent.wallet!.id, amountPaise: 500_000n });
  await createFundingMandate({ walletId: agent.wallet!.id });

  await recordInboundMessage({
    agentId: agent.id,
    channel: MessageChannel.sms,
    from: "VM-DEMO",
    to: agent.handle!.phone,
    body: "Your OTP is 778899 for your transaction of Rs 1,200",
  });

  const { devApp, clientSecret } = await registerDevApp({
    userId: developer.id,
    name: `Dev App ${stamp}`,
  });

  const { grant } = await requestGrant({
    devAppId: devApp.id,
    agentId: agent.id,
    scopes: [...SCOPES],
    spendingCapPaise: 200_000n,
    baseUrl,
  });

  await approveGrant({ grantId: grant.id, approvingUserId: owner.id });

  const tokens = await exchangeGrantForTokens({
    clientId: devApp.clientId,
    clientSecret,
    grantId: grant.id,
  });

  console.log(
    JSON.stringify(
      {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        client_id: devApp.clientId,
        client_secret: clientSecret,
        grant_id: grant.id,
        agent_id: agent.id,
        handle: agent.handle!.email,
        recipient_handle: recipient.handle!.email,
        spending_cap_paise: "200000",
        try_it: `curl -H 'Authorization: Bearer ${tokens.accessToken}' ${baseUrl}/api/v1/wallet/balance`,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
