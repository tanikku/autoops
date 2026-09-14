-- CreateTable
CREATE TABLE "DiscoverySource" (
    "id" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "maxResults" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscoverySource_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "DiscoverySeenItem" (
    "id" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscoverySeenItem_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "DiscoverySource_routineId_key" ON "DiscoverySource"("routineId");
-- CreateIndex
CREATE INDEX "DiscoverySeenItem_routineId_selectedAt_idx" ON "DiscoverySeenItem"("routineId", "selectedAt");
-- CreateIndex
CREATE UNIQUE INDEX "DiscoverySeenItem_routineId_itemKey_key" ON "DiscoverySeenItem"("routineId", "itemKey");
-- AddForeignKey
ALTER TABLE "DiscoverySource" ADD CONSTRAINT "DiscoverySource_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "DiscoverySeenItem" ADD CONSTRAINT "DiscoverySeenItem_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
