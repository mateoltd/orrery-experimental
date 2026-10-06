-- xAPI statement outbox.  (P16-T5)
--
-- Mirrors `EmailOutbox`: same five statuses, same claim-before-send, same give-up count. The statement
-- id IS the dedupe key (`${attemptId}:${event}`), so a retried emission dedupes locally AND at the
-- consumer. `status` leads the drain index; the `(status, verb)` index serves the per-verb dead-letter
-- review, because a dead-letter queue nobody inspects is a second outbox.
--
-- EVERY STATEMENT IS RETRYABLE (`IF NOT EXISTS`), per the `0015`/`0016` convention: a migration that
-- fails halfway must be re-runnable.

CREATE TABLE IF NOT EXISTS "XapiOutbox" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "verb" TEXT NOT NULL,
    "statement" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "attemptId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XapiOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "XapiOutbox_statementId_key" ON "XapiOutbox"("statementId");
CREATE UNIQUE INDEX IF NOT EXISTS "XapiOutbox_dedupeKey_key" ON "XapiOutbox"("dedupeKey");
CREATE INDEX IF NOT EXISTS "XapiOutbox_status_scheduledAt_idx" ON "XapiOutbox"("status", "scheduledAt");
CREATE INDEX IF NOT EXISTS "XapiOutbox_status_verb_idx" ON "XapiOutbox"("status", "verb");
