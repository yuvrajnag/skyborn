/** Builds a rich, realistic state so every screen has something to show. */
import bcrypt from "bcryptjs";
import { GrantStatus, MessageChannel } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { birthAgent } from "@/server/agents";
import { approveGrant, registerDevApp, requestGrant, exchangeGrantForTokens } from "@/server/grants";
import { recordInboundMessage, sendEmail, sendSms, makeCall } from "@/server/messaging";
import { createFundingMandate, creditWalletManually, topupWallet, transferMoney, createPayout, refundTransaction } from "@/server/wallet";
import { createEndpoint, emitEvent, runDueDeliveries } from "@/server/webhooks";
import { completeKyc, startKyc } from "@/server/kyc";
import { walletTransfer, walletTopup, messagesSend, messagesLatestOtp, walletBalance, walletPayout } from "@/server/core";
import { authenticateBearer } from "@/server/grants";

async function main() {
  const email = "demo@skyborn.dev";
  await prisma.user.deleteMany({ where: { email } });

  const user = await prisma.user.create({
    data: { email, name: "Ada Lovelace", passwordHash: await bcrypt.hash("skyborn-demo-2026", 12) },
  });

  // --- Mode A: the human's agents -----------------------------------------
  const groceries = await birthAgent({ userId: user.id, name: "Groceries Buyer" });
  const travel = await birthAgent({ userId: user.id, name: "Travel Booker" });
  const bills = await birthAgent({ userId: user.id, name: "Bills Payer" });

  await creditWalletManually({ walletId: groceries.wallet!.id, amountPaise: 2_500_000n, description: "Seed float" });
  await createFundingMandate({ walletId: groceries.wallet!.id });
  await topupWallet({ walletId: groceries.wallet!.id, amountPaise: 1_500_000n });
  await topupWallet({ walletId: groceries.wallet!.id, amountPaise: 750_000n });

  await creditWalletManually({ walletId: travel.wallet!.id, amountPaise: 4_000_000n, description: "Trip budget" });
  await creditWalletManually({ walletId: bills.wallet!.id, amountPaise: 900_000n, description: "Monthly float" });

  const t1 = await transferMoney({ fromWalletId: groceries.wallet!.id, toWalletId: bills.wallet!.id, amountPaise: 320_000n, description: "Electricity share" });
  await transferMoney({ fromWalletId: groceries.wallet!.id, toWalletId: travel.wallet!.id, amountPaise: 150_050n, description: "Cab reimbursement" });
  await createPayout({ walletId: groceries.wallet!.id, amountPaise: 500_000n, destination: "ada@okhdfcbank" });
  await refundTransaction({ originalEntryId: t1.entry.id, reason: "Wrong recipient" });

  // Messages, including a real OTP for the parser to find.
  await sendEmail({ agentId: groceries.id, to: "orders@bigbasket.example", subject: "Weekly order", body: "Repeat last week's basket." });
  await sendSms({ agentId: groceries.id, to: "+919876543210", body: "Delivery at 6pm please" });
  await makeCall({ agentId: groceries.id, to: "+919876543210", script: "Confirm the delivery window." });
  await recordInboundMessage({ agentId: groceries.id, channel: MessageChannel.sms, from: "VM-HDFCBK", to: groceries.handle!.phone, body: "552104 is your OTP for a transaction of Rs 3,200 at BigBasket. Valid 10 minutes." });
  await recordInboundMessage({ agentId: groceries.id, channel: MessageChannel.email, from: "orders@bigbasket.example", to: groceries.handle!.email, subject: "Order confirmed", body: "Your order will arrive between 6 and 8pm." });

  // Identity verified, so the live-mode gate shows the custody half failing.
  await startKyc({ userId: user.id, redirectUrl: "http://localhost:3000/dashboard/verify" });
  await completeKyc(user.id);

  // --- Mode B: Skyborn for Devs -------------------------------------------
  const { devApp, clientSecret } = await registerDevApp({ userId: user.id, name: "Groceries Concierge" });

  const { grant } = await requestGrant({
    devAppId: devApp.id,
    agentId: groceries.id,
    scopes: ["wallet:read", "wallet:transfer", "wallet:topup", "messages:send", "messages:read", "calls:make"],
    spendingCapPaise: 500_000n,
    baseUrl: "http://localhost:3000",
  });
  await approveGrant({ grantId: grant.id, approvingUserId: user.id });

  // Real agent activity, so the audit log has successes and a refusal.
  const tokens = await exchangeGrantForTokens({ clientId: devApp.clientId, clientSecret, grantId: grant.id });
  const ctx = { grant: await authenticateBearer(tokens.accessToken) };
  await walletBalance(ctx);
  await walletTopup(ctx, { amountPaise: 200_000n });
  await walletTransfer(ctx, { toHandle: travel.handle!.email, amountPaise: 120_000n, description: "Split the cab" });
  await messagesSend(ctx, { channel: "sms", to: "+919876543210", body: "On my way" });
  await messagesLatestOtp(ctx, {});
  await walletTransfer(ctx, { toHandle: travel.handle!.email, amountPaise: 80_000n });
  try { await walletPayout(ctx, { amountPaise: 400_000n, destination: "ada@okhdfcbank" }); } catch { /* no payout scope — shows as refused */ }
  try { await walletTransfer(ctx, { toHandle: travel.handle!.email, amountPaise: 900_000n }); } catch { /* over cap */ }

  // A second app, pending, so the grants list shows more than one state.
  const second = await registerDevApp({ userId: user.id, name: "Travel Assistant" });
  await requestGrant({
    devAppId: second.devApp.id,
    agentId: travel.id,
    scopes: ["wallet:read", "messages:read"],
    spendingCapPaise: 100_000n,
    baseUrl: "http://localhost:3000",
  });

  // A revoked one.
  const third = await registerDevApp({ userId: user.id, name: "Old Integration" });
  const { grant: oldGrant } = await requestGrant({
    devAppId: third.devApp.id, agentId: bills.id, scopes: ["wallet:read"], baseUrl: "http://localhost:3000",
  });
  await approveGrant({ grantId: oldGrant.id, approvingUserId: user.id });
  await prisma.grant.update({ where: { id: oldGrant.id }, data: { status: GrantStatus.revoked, revokedAt: new Date() } });

  // Webhook endpoint + deliveries in mixed states.
  await createEndpoint({ devAppId: devApp.id, url: "https://example.com/skyborn/hook", events: ["grant.approved", "wallet.transfer", "wallet.topup", "message.received"] });
  await emitEvent({ agentId: groceries.id, event: "wallet.transfer", data: { amountPaise: "120000" } });
  await emitEvent({ agentId: groceries.id, event: "wallet.topup", data: { amountPaise: "200000" } });
  await emitEvent({ agentId: groceries.id, event: "message.received", data: { channel: "sms" } });
  await runDueDeliveries(10);

  // An OAuth (MCP) client, for the authorize screen.
  const mcpClient = await prisma.devApp.create({
    data: {
      userId: user.id, name: "Claude Desktop",
      clientId: "sky_mcp_demoscreenshot01",
      clientSecretHash: "x", sandboxKeyId: "sky_sk_sandbox_demo01", sandboxKeySecretHash: "x",
      redirectUris: ["http://127.0.0.1:9876/callback"], isPublicClient: true,
    },
  });

  // A pending grant for the consent screen.
  const { grant: pending } = await requestGrant({
    devAppId: second.devApp.id, agentId: bills.id,
    scopes: ["wallet:read", "wallet:transfer", "messages:read", "calls:make"],
    spendingCapPaise: 250_000n, baseUrl: "http://localhost:3000",
  });

  console.log(JSON.stringify({
    email, password: "skyborn-demo-2026",
    agentId: groceries.id,
    grantId: grant.id,
    pendingGrantId: pending.id,
    mcpClientId: mcpClient.clientId,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
