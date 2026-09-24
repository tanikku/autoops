-- AlterTable
-- Nullable and with no default: an account that may still be offered a trial
-- has nothing recorded here, which is the ordinary case.
ALTER TABLE "Subscription" ADD COLUMN     "trialForfeitedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_provider_providerEventId_key" ON "BillingEvent"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "BillingEvent_userId_occurredAt_idx" ON "BillingEvent"("userId", "occurredAt");

-- AddForeignKey
ALTER TABLE "BillingEvent" ADD CONSTRAINT "BillingEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: accounts that were given the beta allowance are permanently
-- ineligible for a trial, and until this column existed that fact was readable
-- only from `plan` and `source` — both of which change the moment such an
-- account buys a plan.
--
-- **The timestamp is the grant's own, not the migration's.** `createdAt` on
-- these rows is the instant `grantBetaSubscription` wrote them, which is
-- exactly the instant the account stopped being owed a trial. Using now()
-- would record when this migration ran, which is true of the migration and not
-- of the account.
--
-- **Only admin-granted beta.** A `beta` plan from a billing provider is not a
-- grant and keeps whatever eligibility it had; `source = 'admin'` is what
-- makes a row one of the carried-over cohort.
--
-- **Nothing else is touched.** `trialConsumedAt` is not written: these accounts
-- never consumed a trial, and saying they did would be false about people who
-- never had one. Rows already carrying a forfeit date are left as they are.
UPDATE "Subscription"
SET "trialForfeitedAt" = "createdAt"
WHERE "plan" = 'beta'
  AND "source" = 'admin'
  AND "trialForfeitedAt" IS NULL;
