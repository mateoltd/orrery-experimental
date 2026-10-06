-- In-exam incident reports: the channel pilot defects arrive through.  (P17-T5)
--
-- EVERY STATEMENT IS RETRYABLE (`IF NOT EXISTS`), per the 0015/0016/0017 convention.

-- Postgres has NO `CREATE TYPE IF NOT EXISTS`: the guard block below is load-bearing, per the 0016 lesson.
-- A retry after a partial run must not die on `type already exists` before reaching the table.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ExamIncidentReason') THEN
        CREATE TYPE "ExamIncidentReason" AS ENUM ('BROKEN_QUESTION', 'SIM_WONT_LOAD', 'TYPO', 'TIMING', 'OTHER');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ExamIncidentStatus') THEN
        CREATE TYPE "ExamIncidentStatus" AS ENUM ('OPEN', 'TRIAGED', 'RESOLVED');
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "ExamIncident" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT,
    "reporterId" TEXT NOT NULL,
    "reason" "ExamIncidentReason" NOT NULL,
    "detail" TEXT,
    "status" "ExamIncidentStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamIncident_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExamIncident_attemptId_fkey') THEN
        ALTER TABLE "ExamIncident" ADD CONSTRAINT "ExamIncident_attemptId_fkey"
            FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExamIncident_reporterId_fkey') THEN
        ALTER TABLE "ExamIncident" ADD CONSTRAINT "ExamIncident_reporterId_fkey"
            FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "ExamIncident_attemptId_createdAt_idx" ON "ExamIncident"("attemptId", "createdAt");
CREATE INDEX IF NOT EXISTS "ExamIncident_status_createdAt_idx" ON "ExamIncident"("status", "createdAt");
