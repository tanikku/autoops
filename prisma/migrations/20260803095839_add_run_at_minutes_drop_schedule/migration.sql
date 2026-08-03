-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Routine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "prompt" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "frequency" TEXT NOT NULL DEFAULT 'manual',
    "runAtMinutes" INTEGER,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Routine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Routine" ("createdAt", "description", "frequency", "id", "name", "nextRunAt", "prompt", "status", "updatedAt", "userId") SELECT "createdAt", "description", "frequency", "id", "name", "nextRunAt", "prompt", "status", "updatedAt", "userId" FROM "Routine";
DROP TABLE "Routine";
ALTER TABLE "new_Routine" RENAME TO "Routine";
CREATE INDEX "Routine_userId_idx" ON "Routine"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

