-- P4-T7. Notifications: dedupe, per-user email preferences, and an unsubscribe token.
--
-- `plans/12` §7 has four rules, and three of them want a constraint rather than an `if`:
--
--   · "Every notification is deduped on `(userId, kind, refId)` via `EmailOutbox.dedupeKey`."
--     `EmailOutbox.dedupeKey` was already UNIQUE, so the EMAIL half of dedupe was structural.
--     The IN-APP half had nothing, which is the half a user sees forty times on a re-import.
--
--   · "All sending is queued, never inline." Nothing to add: the outbox IS the queue, and the
--     absence of a send path in the request handler is what makes it a queue rather than a
--     column.
--
--   · "One-click unsubscribe on every email, and unsubscribing never disables in-app
--     notifications a user needs for their coursework." That last clause is a SCHEMA decision,
--     and it is the one worth being careful about: there is exactly one opt-out column, named
--     `emailOptOut`, and nothing else that can be set from a preferences screen. A single
--     `muted` boolean would have satisfied the first half of that sentence and quietly broken
--     the second.

-- ── in-app dedupe ─────────────────────────────────────────────────────────────

-- `refId` is the thing being notified about: an assignment id, an attempt id, an enrollment id.
-- It is NULLABLE, and that is deliberate rather than convenient. Several events are about the
-- classroom rather than about a row — "your membership changed" for a student who has been
-- removed has no row left to point at. A NOT NULL column would force a sentinel id onto those,
-- and a sentinel is a value that collides with itself the first time two of them meet.
--
-- Postgres treats NULLs as distinct in a unique index, so a notification with no `refId` is not
-- deduped against other ones. That is the correct behaviour: the "membership changed" event is
-- deduped by the service using the enrollment id, and the constraint is a BACKSTOP for the cases
-- that do have one, not the whole mechanism.
ALTER TABLE "Notification" ADD COLUMN "refId" TEXT;

-- The dedupe constraint the plan names, as a constraint. An application-level check is a
-- statement in a service that somebody can forget; this is a fact about the table.
CREATE UNIQUE INDEX "Notification_userId_kind_refId_key" ON "Notification" ("userId", "kind", "refId");

-- ── per-user email preferences ───────────────────────────────────────────────

-- One row per user, created lazily on first preference read. There is no backfill migration
-- inserting a row for every existing user: the read path treats a missing row as
-- `DEFAULT_EMAIL_PREFERENCES`, so a migration that wrote 40,000 identical rows would be 40,000
-- rows that exist only to be the default and that would then drift from it.
CREATE TABLE "NotificationPreference" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  -- THE ONLY OPT-OUT. Named for what it governs so that no future column can quietly become a
  -- global mute.
  "emailOptOut" BOOLEAN NOT NULL DEFAULT false,
  "digestIntervalMinutes" INTEGER NOT NULL DEFAULT 60,
  -- Minutes from local midnight. A wrapping window is `quietFrom > quietTo`; equality means the
  -- window is CLOSED, which is a decision the read path makes and the check below allows.
  "quietFromMinute" INTEGER NOT NULL DEFAULT 1260,
  "quietToMinute" INTEGER NOT NULL DEFAULT 420,
  -- The recipient's zone. On the User row already, and nullable here, because a preference that
  -- silently overrode the account's zone would be a preference about the wrong person.
  "timezone" TEXT,
  -- One token per user, not one per message, so an unsubscribe can be revoked once and covers
  -- every email the person has or will receive. UUID, because this is a BEARER CAPABILITY
  -- reachable from a URL: a time-ordered id would be enumerable from plans/01's own rule.
  "unsubscribeToken" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

  CONSTRAINT "NotificationPreference_userId_key" UNIQUE ("userId"),
  CONSTRAINT "NotificationPreference_unsubscribeToken_key" UNIQUE ("unsubscribeToken"),
  CONSTRAINT "NotificationPreference_minutes_check" CHECK (
    "digestIntervalMinutes" >= 0 AND "digestIntervalMinutes" <= 10080
    AND "quietFromMinute" >= 0 AND "quietFromMinute" <= 1440
    AND "quietToMinute" >= 0 AND "quietToMinute" <= 1440
  )
);

-- The outbox needs to know WHOSE email this is, for two reasons: to re-check the opt-out at
-- SEND time rather than only at enqueue time, and so an unsubscribe can find the queued messages
-- of a person who unsubscribed before the queue drained. Nullable, because an email to an
-- address with no account (a stale invitation) is still an email.
ALTER TABLE "EmailOutbox" ADD COLUMN "userId" TEXT;

-- The status is a bare String, so the allowed set is a constraint rather than a convention. The
-- one that matters is `SUPPRESSED`: a message that was queued and then should not be sent needs
-- a state that is neither pending nor sent, or the drain will pick it up again.
ALTER TABLE "EmailOutbox" ADD CONSTRAINT "EmailOutbox_status_check"
  CHECK ("status" IN ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SUPPRESSED'));

-- The "digest after 3 invitations to the same address" count is a count of this kind, to this
-- address, still QUEUED. Without the index it is a sequential scan of the outbox once per
-- invitation, and a school inviting a year group is 200 invitations at once.
CREATE INDEX "EmailOutbox_toEmail_template_status_idx" ON "EmailOutbox" ("toEmail", "template", "status");
