-- AlterTable
ALTER TABLE "Routine" ADD COLUMN     "executionLeaseUntil" TIMESTAMP(3),
ADD COLUMN     "executionOwner" TEXT;
