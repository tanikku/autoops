-- CreateIndex
CREATE INDEX "Routine_status_nextRunAt_idx" ON "Routine"("status", "nextRunAt");
