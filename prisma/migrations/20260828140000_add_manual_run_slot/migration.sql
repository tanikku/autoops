-- CreateTable
CREATE TABLE "ManualRunSlot" (
    "userId" TEXT NOT NULL,
    "slotNumber" INTEGER NOT NULL,
    "owner" TEXT,
    "leaseUntil" TIMESTAMP(3),

    CONSTRAINT "ManualRunSlot_pkey" PRIMARY KEY ("userId","slotNumber")
);

-- AddForeignKey
ALTER TABLE "ManualRunSlot" ADD CONSTRAINT "ManualRunSlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
