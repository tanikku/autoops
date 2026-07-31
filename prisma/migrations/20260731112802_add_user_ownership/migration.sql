/*
  Warnings:

  - Added the required column `userId` to the `Routine` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `RunHistory` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Routine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "prompt" TEXT NOT NULL DEFAULT '',
    "schedule" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "frequency" TEXT NOT NULL DEFAULT 'manual',
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Routine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Routine" ("createdAt", "description", "frequency", "id", "name", "nextRunAt", "prompt", "schedule", "status", "updatedAt") SELECT "createdAt", "description", "frequency", "id", "name", "nextRunAt", "prompt", "schedule", "status", "updatedAt" FROM "Routine";
DROP TABLE "Routine";
ALTER TABLE "new_Routine" RENAME TO "Routine";
CREATE INDEX "Routine_userId_idx" ON "Routine"("userId");
CREATE TABLE "new_RunHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "routineId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "output" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "RunHistory_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RunHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_RunHistory" ("finishedAt", "id", "output", "routineId", "startedAt", "status") SELECT "finishedAt", "id", "output", "routineId", "startedAt", "status" FROM "RunHistory";
DROP TABLE "RunHistory";
ALTER TABLE "new_RunHistory" RENAME TO "RunHistory";
CREATE INDEX "RunHistory_routineId_idx" ON "RunHistory"("routineId");
CREATE INDEX "RunHistory_userId_idx" ON "RunHistory"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
