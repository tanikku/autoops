-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "providerSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BillingEvent" ADD COLUMN     "observedAt" TIMESTAMP(3),
ADD COLUMN     "reconciliationRunId" TEXT;

-- CreateTable
CREATE TABLE "ProviderEventReceipt" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "providerEventType" TEXT NOT NULL,
    "providerSubscriptionId" TEXT NOT NULL,
    "providerCustomerId" TEXT,
    "providerOccurredAt" TIMESTAMP(3),
    "providerApiVersion" TEXT,
    "userId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reconciliationRunId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "outcome" TEXT,

    CONSTRAINT "ProviderEventReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingReconciliation" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSubscriptionId" TEXT NOT NULL,
    "userId" TEXT,
    "pendingSince" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "lastFailureReason" TEXT,
    "unpaidFirstSeenRunId" TEXT,

    CONSTRAINT "BillingReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderEventReceipt_provider_providerSubscriptionId_resolv_idx" ON "ProviderEventReceipt"("provider", "providerSubscriptionId", "resolvedAt");

-- CreateIndex
CREATE INDEX "ProviderEventReceipt_resolvedAt_receivedAt_idx" ON "ProviderEventReceipt"("resolvedAt", "receivedAt");

-- CreateIndex
CREATE INDEX "ProviderEventReceipt_userId_receivedAt_idx" ON "ProviderEventReceipt"("userId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderEventReceipt_provider_providerEventId_key" ON "ProviderEventReceipt"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "BillingReconciliation_pendingSince_idx" ON "BillingReconciliation"("pendingSince");

-- CreateIndex
CREATE INDEX "BillingReconciliation_leaseUntil_idx" ON "BillingReconciliation"("leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "BillingReconciliation_provider_providerSubscriptionId_key" ON "BillingReconciliation"("provider", "providerSubscriptionId");

-- AddForeignKey
ALTER TABLE "ProviderEventReceipt" ADD CONSTRAINT "ProviderEventReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingReconciliation" ADD CONSTRAINT "BillingReconciliation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

