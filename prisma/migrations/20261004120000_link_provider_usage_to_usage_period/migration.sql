-- AlterTable
ALTER TABLE "ProviderUsageEvent" ADD COLUMN     "usagePeriodId" TEXT;

-- CreateIndex
CREATE INDEX "ProviderUsageEvent_usagePeriodId_idx" ON "ProviderUsageEvent"("usagePeriodId");

-- AddForeignKey
ALTER TABLE "ProviderUsageEvent" ADD CONSTRAINT "ProviderUsageEvent_usagePeriodId_fkey" FOREIGN KEY ("usagePeriodId") REFERENCES "UsagePeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

