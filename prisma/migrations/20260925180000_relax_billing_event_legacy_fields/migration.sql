-- AlterTable
ALTER TABLE "BillingEvent" ALTER COLUMN "providerEventId" DROP NOT NULL,
ALTER COLUMN "occurredAt" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_reconciliationRunId_kind_key" ON "BillingEvent"("reconciliationRunId", "kind");

