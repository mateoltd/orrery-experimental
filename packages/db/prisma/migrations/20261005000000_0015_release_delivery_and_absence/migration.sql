ALTER TYPE "AttemptStatus" ADD VALUE IF NOT EXISTS 'MISSING';
ALTER TYPE "AttemptEventType" ADD VALUE IF NOT EXISTS 'MISSING';
ALTER TYPE "AttemptEventType" ADD VALUE IF NOT EXISTS 'LATE_MARKED';
ALTER TABLE "Assignment" ADD COLUMN IF NOT EXISTS "missingExcludedFromGradebook" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ExamAttempt" ADD COLUMN IF NOT EXISTS "showAccommodationOnResults" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ReleaseBatch" ADD COLUMN IF NOT EXISTS "notificationsCompletedAt" TIMESTAMPTZ(3);
-- Existing releases predate this job; migration must not send historical results again.
UPDATE "ReleaseBatch" SET "notificationsCompletedAt" = "releasedAt" WHERE status = 'RELEASED' AND "releasedAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ReleaseBatch_status_notificationsCompletedAt_idx" ON "ReleaseBatch"("status", "notificationsCompletedAt");
