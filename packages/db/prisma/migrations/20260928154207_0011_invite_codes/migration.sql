-- P4-T3. The derivation counter for join codes.
--
-- A code is `HMAC(secret, classroomId || counter)`, so regenerating is a COUNTER BUMP rather
-- than a fresh random code -- instant, auditable, and impossible to leave the old code alive in
-- a photograph because there is no old code to forget. The bump is also what revokes the
-- previous code: its hash is replaced.

ALTER TABLE "ClassroomInvitation" ADD COLUMN "codeCounter" INTEGER NOT NULL DEFAULT 0;

-- P4-T3. Exactly one of an email address or a join code, as `plans/01` requires.
--
-- A row with NEITHER is an invitation to nobody. A row with BOTH is an invitation that can be
-- used two ways, by two people who may have been told different things about it — and the
-- second is the dangerous one, because a teacher who emailed a link to a code has told the
-- recipient their place in the room depends on a link that anyone with the mail could forward.
--
-- The plan says "exactly one of email / codeHash". The application can only be wrong about it,
-- so the database is the place that says so, and the CHECK is the statement rather than the
-- intent.
--
-- A code WITHOUT a hash is the worst of the three, so it is covered too: a code row that cannot
-- be verified is a row that either always fails or always succeeds, and neither is acceptable.
ALTER TABLE "ClassroomInvitation"
  ADD CONSTRAINT "Invitation_exactly_one_target"
  CHECK (
    ("email" IS NOT NULL AND "codeHash" IS NULL)
    OR ("email" IS NULL AND "codeHash" IS NOT NULL)
  );

-- A LOCKED code records WHEN it was locked. `failedAttempts` alone cannot distinguish "in
-- progress being ground on" from "finished and locked" without comparing a threshold, and a
-- threshold in application code is a threshold somebody will eventually raise without a review.
ALTER TABLE "ClassroomInvitation"
  ADD CONSTRAINT "Invitation_locked_has_no_code"
  CHECK ("lockedAt" IS NULL OR "codeHash" IS NOT NULL);
