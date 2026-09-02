-- CreateEnum
CREATE TYPE "Mode" AS ENUM ('sandbox', 'live');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('unverified', 'pending', 'verified', 'rejected');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('credit', 'debit');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('topup', 'withdrawal', 'transfer_in', 'transfer_out', 'refund_in', 'refund_out', 'virtual_card_charge', 'manual_credit');

-- CreateEnum
CREATE TYPE "MandateStatus" AS ENUM ('pending', 'active', 'paused', 'revoked');

-- CreateEnum
CREATE TYPE "GrantStatus" AS ENUM ('pending', 'active', 'revoked');

-- CreateEnum
CREATE TYPE "GrantIssuedVia" AS ENUM ('rest', 'mcp', 'axl');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('email', 'sms', 'call');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'unverified',
    "kycVendor" TEXT,
    "kycVendorRef" TEXT,
    "kycMaskedTail" TEXT,
    "kycVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Handle" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "mode" "Mode" NOT NULL DEFAULT 'sandbox',
    "provisioned" BOOLEAN NOT NULL DEFAULT false,
    "emailProviderRef" TEXT,
    "phoneProviderRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Handle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "mode" "Mode" NOT NULL DEFAULT 'sandbox',
    "custodyPartnerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundingMandate" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "providerRef" TEXT,
    "capAmount" BIGINT NOT NULL DEFAULT 1500000,
    "capPeriod" TEXT NOT NULL DEFAULT 'per_transaction',
    "status" "MandateStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundingMandate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "counterparty" TEXT,
    "externalRef" TEXT,
    "description" TEXT,
    "originalEntryId" TEXT,
    "transferGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevApp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "sandboxKeyId" TEXT NOT NULL,
    "sandboxKeySecretHash" TEXT NOT NULL,
    "liveKeyId" TEXT,
    "liveKeySecretHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Grant" (
    "id" TEXT NOT NULL,
    "devAppId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "scopes" TEXT[],
    "spendingCap" BIGINT,
    "mode" "Mode" NOT NULL DEFAULT 'sandbox',
    "status" "GrantStatus" NOT NULL DEFAULT 'pending',
    "issuedVia" "GrantIssuedVia" NOT NULL DEFAULT 'rest',
    "issuedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessToken" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "refreshTokenHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrantAuditLog" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "paramsSummary" JSONB,
    "resultStatus" TEXT NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrantAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "devAppId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "responseCode" INTEGER,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Agent_userId_idx" ON "Agent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_userId_slug_key" ON "Agent"("userId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Handle_agentId_key" ON "Handle"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "Handle_email_key" ON "Handle"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Handle_phone_key" ON "Handle"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_agentId_key" ON "Wallet"("agentId");

-- CreateIndex
CREATE INDEX "FundingMandate_walletId_idx" ON "FundingMandate"("walletId");

-- CreateIndex
CREATE INDEX "LedgerEntry_walletId_createdAt_idx" ON "LedgerEntry"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_transferGroupId_idx" ON "LedgerEntry"("transferGroupId");

-- CreateIndex
CREATE INDEX "LedgerEntry_originalEntryId_idx" ON "LedgerEntry"("originalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "DevApp_clientId_key" ON "DevApp"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "DevApp_sandboxKeyId_key" ON "DevApp"("sandboxKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "DevApp_liveKeyId_key" ON "DevApp"("liveKeyId");

-- CreateIndex
CREATE INDEX "DevApp_userId_idx" ON "DevApp"("userId");

-- CreateIndex
CREATE INDEX "Grant_devAppId_idx" ON "Grant"("devAppId");

-- CreateIndex
CREATE INDEX "Grant_agentId_idx" ON "Grant"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessToken_tokenHash_key" ON "AccessToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "AccessToken_refreshTokenHash_key" ON "AccessToken"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "AccessToken_grantId_idx" ON "AccessToken"("grantId");

-- CreateIndex
CREATE INDEX "GrantAuditLog_grantId_createdAt_idx" ON "GrantAuditLog"("grantId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_agentId_createdAt_idx" ON "Message"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_devAppId_idx" ON "WebhookEndpoint"("devAppId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handle" ADD CONSTRAINT "Handle_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingMandate" ADD CONSTRAINT "FundingMandate_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_originalEntryId_fkey" FOREIGN KEY ("originalEntryId") REFERENCES "LedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevApp" ADD CONSTRAINT "DevApp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grant" ADD CONSTRAINT "Grant_devAppId_fkey" FOREIGN KEY ("devAppId") REFERENCES "DevApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grant" ADD CONSTRAINT "Grant_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessToken" ADD CONSTRAINT "AccessToken_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "Grant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantAuditLog" ADD CONSTRAINT "GrantAuditLog_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "Grant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_devAppId_fkey" FOREIGN KEY ("devAppId") REFERENCES "DevApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
