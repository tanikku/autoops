-- CreateTable
CREATE TABLE "CreatorProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT '',
    "goals" TEXT NOT NULL DEFAULT '',
    "voiceInstructions" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreatorProfile_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ContentItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentItem_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "EditorialDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "targetChannel" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditorialDecision_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ContentDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "editorialDecisionId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentDraft_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "CreatorFeedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "editorialDecisionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "editedBody" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreatorFeedback_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "CreatorMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "creatorProfileId" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "derivedFromCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreatorMemory_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "CreatorProfile_userId_key" ON "CreatorProfile"("userId");
-- CreateIndex
CREATE INDEX "ContentItem_userId_idx" ON "ContentItem"("userId");
-- CreateIndex
CREATE INDEX "ContentItem_creatorProfileId_idx" ON "ContentItem"("creatorProfileId");
-- CreateIndex
CREATE INDEX "EditorialDecision_userId_idx" ON "EditorialDecision"("userId");
-- CreateIndex
CREATE UNIQUE INDEX "EditorialDecision_contentItemId_targetChannel_key" ON "EditorialDecision"("contentItemId", "targetChannel");
-- CreateIndex
CREATE UNIQUE INDEX "ContentDraft_editorialDecisionId_key" ON "ContentDraft"("editorialDecisionId");
-- CreateIndex
CREATE INDEX "ContentDraft_userId_idx" ON "ContentDraft"("userId");
-- CreateIndex
CREATE UNIQUE INDEX "CreatorFeedback_editorialDecisionId_key" ON "CreatorFeedback"("editorialDecisionId");
-- CreateIndex
CREATE INDEX "CreatorFeedback_userId_idx" ON "CreatorFeedback"("userId");
-- CreateIndex
CREATE UNIQUE INDEX "CreatorMemory_creatorProfileId_key" ON "CreatorMemory"("creatorProfileId");
-- CreateIndex
CREATE INDEX "CreatorMemory_userId_idx" ON "CreatorMemory"("userId");
-- AddForeignKey
ALTER TABLE "CreatorProfile" ADD CONSTRAINT "CreatorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_creatorProfileId_fkey" FOREIGN KEY ("creatorProfileId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "EditorialDecision" ADD CONSTRAINT "EditorialDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "EditorialDecision" ADD CONSTRAINT "EditorialDecision_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ContentDraft" ADD CONSTRAINT "ContentDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ContentDraft" ADD CONSTRAINT "ContentDraft_editorialDecisionId_fkey" FOREIGN KEY ("editorialDecisionId") REFERENCES "EditorialDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "CreatorFeedback" ADD CONSTRAINT "CreatorFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "CreatorFeedback" ADD CONSTRAINT "CreatorFeedback_editorialDecisionId_fkey" FOREIGN KEY ("editorialDecisionId") REFERENCES "EditorialDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "CreatorMemory" ADD CONSTRAINT "CreatorMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "CreatorMemory" ADD CONSTRAINT "CreatorMemory_creatorProfileId_fkey" FOREIGN KEY ("creatorProfileId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
