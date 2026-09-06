-- CreateTable
CREATE TABLE "CreatorMemoryEvidence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "creatorMemoryId" TEXT NOT NULL,
    "creatorFeedbackId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreatorMemoryEvidence_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "CreatorMemoryEvidence_creatorFeedbackId_key" ON "CreatorMemoryEvidence"("creatorFeedbackId");
-- CreateIndex
CREATE INDEX "CreatorMemoryEvidence_userId_idx" ON "CreatorMemoryEvidence"("userId");
-- CreateIndex
CREATE INDEX "CreatorMemoryEvidence_creatorMemoryId_idx" ON "CreatorMemoryEvidence"("creatorMemoryId");
-- AddForeignKey
ALTER TABLE "CreatorMemoryEvidence" ADD CONSTRAINT "CreatorMemoryEvidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "CreatorMemoryEvidence" ADD CONSTRAINT "CreatorMemoryEvidence_creatorMemoryId_fkey" FOREIGN KEY ("creatorMemoryId") REFERENCES "CreatorMemory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "CreatorMemoryEvidence" ADD CONSTRAINT "CreatorMemoryEvidence_creatorFeedbackId_fkey" FOREIGN KEY ("creatorFeedbackId") REFERENCES "CreatorFeedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;
