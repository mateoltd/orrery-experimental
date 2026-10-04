-- P10-T1 + P10-T3: the `ReleaseBatch` state machine, the membership freeze, and an override somebody can audit.
--
-- ## WHAT WAS ALREADY HERE, AND WHAT WAS NOT
--
-- `ReleaseBatch`, `ReleaseBatchMember` and the five-value `ReleaseBatchStatus` enum have existed since `0001_init`.
-- What did not exist is anything connecting the five values. Measured against the database before this migration:
--
--   · a member could be inserted into a `RELEASED` batch -- and it could be an attempt from a DIFFERENT classroom;
--   · `RELEASED` could be updated back to `DRAFT`, re-sealing grades students had already read;
--   · a `CANCELED` batch was released by `releaseBatch`, which only ever asked "is it already RELEASED?".
--
-- So the enum was a vocabulary, not a machine. `plans/01` §10 says "membership is FROZEN on entering `RELEASING`", and
-- nothing froze it.
--
-- ## WHY TRIGGERS, IN A REPOSITORY THAT HAS NONE
--
-- Every earlier migration used a CHECK or a generated column, and `0007` says why it avoided a trigger. A CHECK
-- cannot do this job, for two separate reasons:
--
--   1. **a transition is a fact about TWO row versions.** A CHECK sees only the new one, so it can say "`RELEASED` is
--      a legal status" and cannot say "`RELEASED` may not become `DRAFT`";
--   2. **the freeze is a fact about ANOTHER TABLE.** Whether a `ReleaseBatchMember` row may be written depends on its
--      batch's status, and a CHECK cannot read a second table.
--
-- The alternative is to enforce both in `release-batch.ts` alone, and that is the convention this task exists to
-- replace: the two existing writers (`releaseBatch`, and a roster fixture) both wrote `status` with a bare
-- `update`, and neither would have called a helper. The database is the only place every writer passes through.
--
-- `prisma migrate diff` does not model triggers, functions or CHECK constraints, so the schema gate neither sees these
-- nor objects to them. `release-batch.integration.test.ts` is what asserts they exist and agree with the TypeScript
-- transition table, pair by pair.

-- ── the override: WHO and WHEN, beside the WHY that was already there ───────────────────────────────────────────

ALTER TABLE "ReleaseBatch" ADD COLUMN     "overrideAt" TIMESTAMPTZ(3),
ADD COLUMN     "overrideById" TEXT,
ADD COLUMN     "overrideWaived" JSONB;

CREATE INDEX "ReleaseBatch_overrideById_idx" ON "ReleaseBatch"("overrideById");

ALTER TABLE "ReleaseBatch" ADD CONSTRAINT "ReleaseBatch_overrideById_fkey" FOREIGN KEY ("overrideById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ALL FOUR OR NONE. An override with a reason and no author is the thing P10-T3 forbids, and "the service always
-- sets them together" is the sentence that stops being true the first time someone writes `overrideReason` directly.
--
-- `overrideWaived` must be a NON-EMPTY ARRAY: an override that waives nothing is a blank cheque for whatever blocker
-- turns up next, which is exactly how the old bare-string override behaved.
--
-- The 10-character floor is `MIN_OVERRIDE_REASON` in `release-batch.ts`, and a test writes a 9-character reason
-- through both so the two numbers cannot drift apart.
--
-- **`NOT VALID`, deliberately.** A row written before this migration with an `overrideReason` and nobody attached to
-- it cannot be given an author honestly, and inventing one would falsify the very record this constraint protects.
-- `NOT VALID` skips the check for rows that already exist and enforces it on every insert and every update from now
-- on -- so a legacy unattributed override is not honoured silently either: the next write to that batch is refused
-- until a person re-records it. (This database had 177 batches and none with an override.)
ALTER TABLE "ReleaseBatch" ADD CONSTRAINT "ReleaseBatch_override_complete" CHECK (
  (
    "overrideReason" IS NULL AND "overrideById" IS NULL AND "overrideAt" IS NULL AND "overrideWaived" IS NULL
  ) OR (
    "overrideReason" IS NOT NULL AND length(btrim("overrideReason", E' \t\n\r')) >= 10
    AND "overrideById" IS NOT NULL
    AND "overrideAt" IS NOT NULL
    AND "overrideWaived" IS NOT NULL
    AND (CASE WHEN jsonb_typeof("overrideWaived") = 'array'
              THEN jsonb_array_length("overrideWaived") > 0
              ELSE false END)
  )
) NOT VALID;

-- ── the state machine ───────────────────────────────────────────────────────────────────────────────────────────
--
--   DRAFT ──▶ READY ──▶ RELEASING ──▶ RELEASED
--     ▲─────────┘
--   DRAFT, READY, RELEASING ──▶ CANCELED
--
-- `RELEASED` and `CANCELED` are terminal. Three edges are refused that a reader might expect, and each for a reason:
--
--   · **`READY → RELEASED`.** `plans/07` §6.1 writes the release as `... WHERE status IN ('READY','RELEASING')`, which
--     admits this edge. It is refused here because a batch that jumps it has never been frozen: verification would
--     run against membership that is still open, and a member added between the check and the flip is released
--     unchecked. That is the B16 time-of-check window, moved from the grades to the membership. Both hops may share one
--     transaction, so the release is still atomic; what is lost is only the ability to skip the freeze.
--   · **`RELEASING → READY` / `→ DRAFT`.** There is no un-freeze. A batch that has started releasing either finishes
--     or is cancelled, and a cancelled batch costs one new batch. "Frozen until somebody reopens it" is not frozen.
--   · **anything out of `RELEASED`.** Visibility is `EXISTS(... status = 'RELEASED')`, so leaving `RELEASED` takes back
--     grades a student has already seen. There is no reason for it that is not better served by a regrade.
CREATE FUNCTION "orrery_release_batch_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Born DRAFT, always. A batch inserted as `RELEASED` has passed through no gate at all.
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'RELEASE_BATCH_MUST_START_DRAFT: a batch is created DRAFT, not %', NEW."status"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ReleaseBatch_starts_draft';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Deleting a RELEASED batch is `RELEASED → nothing`: every member is re-sealed, with no row left to say it ever
    -- happened. It is the same illegal edge as `RELEASED → DRAFT` by a different verb. The batch may go once it
    -- releases nobody -- that is, once its attempts are themselves gone (erasure, retention), which is the cascade the
    -- member guard below lets through.
    IF OLD."status" IN ('RELEASING', 'RELEASED')
       AND EXISTS (SELECT 1 FROM "ReleaseBatchMember" m WHERE m."batchId" = OLD."id") THEN
      RAISE EXCEPTION 'RELEASE_BATCH_DELETE_REFUSED: batch % is % and still has members', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ReleaseBatch_delete';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'DRAFT'     AND NEW."status" IN ('READY', 'CANCELED'))
    OR (OLD."status" = 'READY'     AND NEW."status" IN ('DRAFT', 'RELEASING', 'CANCELED'))
    OR (OLD."status" = 'RELEASING' AND NEW."status" IN ('RELEASED', 'CANCELED'))
  ) THEN
    RAISE EXCEPTION 'RELEASE_BATCH_ILLEGAL_TRANSITION: % -> % is not a transition', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ReleaseBatch_transition';
  END IF;

  -- The batch's scope is what its members were checked against when they were added. Moving the batch moves all of
  -- them at once, past that check.
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."assignmentId" IS DISTINCT FROM OLD."assignmentId"
     OR NEW."classroomId" IS DISTINCT FROM OLD."classroomId" THEN
    RAISE EXCEPTION 'RELEASE_BATCH_SCOPE_IMMUTABLE: a batch cannot be moved to another assignment or classroom'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ReleaseBatch_scope';
  END IF;

  -- A release has a time. Without it "when were results released?" has no answer for the one event students ask about.
  IF NEW."status" = 'RELEASED' AND NEW."releasedAt" IS NULL THEN
    RAISE EXCEPTION 'RELEASE_BATCH_RELEASED_WITHOUT_TIME: RELEASED requires releasedAt'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ReleaseBatch_released_at';
  END IF;
  IF OLD."status" = 'RELEASED' AND NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt" THEN
    RAISE EXCEPTION 'RELEASE_BATCH_RELEASED_AT_IMMUTABLE: the release time of a RELEASED batch does not change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ReleaseBatch_released_at';
  END IF;

  -- AN OVERRIDE IS REPLACED, NEVER ERASED. A second override supersedes the first (the audit log keeps both); what
  -- cannot happen is a batch that was overridden reading afterwards as though it never had been.
  IF OLD."overrideReason" IS NOT NULL AND NEW."overrideReason" IS NULL THEN
    RAISE EXCEPTION 'RELEASE_BATCH_OVERRIDE_ERASED: a recorded override cannot be cleared'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ReleaseBatch_override_durable';
  END IF;

  -- And once the batch is finished, the override it finished WITH is the record. Editing it afterwards would rewrite
  -- the justification for a release that has already happened.
  IF OLD."status" IN ('RELEASED', 'CANCELED') AND (
       NEW."overrideReason" IS DISTINCT FROM OLD."overrideReason"
    OR NEW."overrideById"   IS DISTINCT FROM OLD."overrideById"
    OR NEW."overrideAt"     IS DISTINCT FROM OLD."overrideAt"
    OR NEW."overrideWaived" IS DISTINCT FROM OLD."overrideWaived"
  ) THEN
    RAISE EXCEPTION 'RELEASE_BATCH_OVERRIDE_AFTER_TERMINAL: the override of a % batch cannot be changed', OLD."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ReleaseBatch_override_durable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ReleaseBatch_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "ReleaseBatch"
  FOR EACH ROW EXECUTE FUNCTION "orrery_release_batch_guard"();

-- ── the membership freeze ───────────────────────────────────────────────────────────────────────────────────────
--
-- Membership is writable while the batch is `DRAFT` or `READY` and at no other time.
--
-- ## `FOR SHARE` IS THE LOAD-BEARING PART
--
-- Reading the batch's status without a lock leaves the race the freeze is for:
--
--     A: INSERT member ............ reads status = READY
--     B: UPDATE batch SET status = 'RELEASING'; COMMIT     -- membership is now "frozen"
--     A: COMMIT                                            -- and has just changed
--
-- The foreign key does not close it. An insert takes `FOR KEY SHARE` on the parent, which does not conflict with a
-- non-key `UPDATE` of `status`, so the two commit in either order. `FOR SHARE` DOES conflict with that update: B waits
-- for A (and then releases a batch that visibly contains the member), or A waits for B and re-reads `RELEASING` under
-- READ COMMITTED and is refused. Either way no member arrives after the freeze.
--
-- ## A MEMBER BELONGS TO THE BATCH'S OWN ASSIGNMENT AND CLASSROOM
--
-- Permission to release is decided by the batch's classroom. If any attempt can be a member, a teacher of one class
-- can put another class's attempt in their batch and release it -- and the pre-release gate would list that attempt's
-- grading state to them on the way.
--
-- ## THE TWO DELETES THAT ARE NOT A MEMBERSHIP CHANGE
--
-- `ON DELETE CASCADE` arrives here as an ordinary DELETE, so the guard has to tell a cascade from a removal:
--
--   · the BATCH is gone -- the batch guard above already decided that was allowed;
--   · the ATTEMPT is gone -- an erased attempt cannot be "released to some students and not others"; there is no
--     attempt left to be visible. Refusing here would make a released grade un-erasable.
--
-- In both cases the parent row is already invisible to this statement, which is what the two lookups test.
CREATE FUNCTION "orrery_release_batch_member_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  batch_status     "ReleaseBatchStatus";
  batch_assignment TEXT;
  batch_classroom  TEXT;
  attempt_assignment TEXT;
  attempt_classroom  TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- A member row is a fact: this attempt is in this batch. It is added or removed, never re-pointed -- re-pointing
    -- is a removal from one batch and an insert into another that passes neither check.
    IF NEW."batchId" IS DISTINCT FROM OLD."batchId" OR NEW."attemptId" IS DISTINCT FROM OLD."attemptId" THEN
      RAISE EXCEPTION 'RELEASE_BATCH_MEMBER_IMMUTABLE: a member row cannot be re-pointed'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ReleaseBatchMember_immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT b."status", b."assignmentId", b."classroomId"
      INTO batch_status, batch_assignment, batch_classroom
      FROM "ReleaseBatch" b WHERE b."id" = NEW."batchId" FOR SHARE;
    -- No such batch: the foreign key refuses it, with the better message.
    IF NOT FOUND THEN RETURN NEW; END IF;

    IF batch_status NOT IN ('DRAFT', 'READY') THEN
      RAISE EXCEPTION 'RELEASE_BATCH_MEMBERSHIP_FROZEN: batch % is %, its membership cannot change', NEW."batchId", batch_status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ReleaseBatchMember_frozen';
    END IF;

    SELECT a."assignmentId", a."classroomId" INTO attempt_assignment, attempt_classroom
      FROM "ExamAttempt" a WHERE a."id" = NEW."attemptId";
    IF FOUND AND (attempt_assignment <> batch_assignment OR attempt_classroom <> batch_classroom) THEN
      RAISE EXCEPTION 'RELEASE_BATCH_MEMBER_OUT_OF_SCOPE: attempt % is not an attempt of batch %''s assignment and classroom', NEW."attemptId", NEW."batchId"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ReleaseBatchMember_scope';
    END IF;
    RETURN NEW;
  END IF;

  SELECT b."status" INTO batch_status FROM "ReleaseBatch" b WHERE b."id" = OLD."batchId" FOR SHARE;
  IF NOT FOUND OR batch_status IN ('DRAFT', 'READY') THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ExamAttempt" a WHERE a."id" = OLD."attemptId") THEN RETURN OLD; END IF;

  RAISE EXCEPTION 'RELEASE_BATCH_MEMBERSHIP_FROZEN: batch % is %, its membership cannot change', OLD."batchId", batch_status
    USING ERRCODE = 'check_violation', CONSTRAINT = 'ReleaseBatchMember_frozen';
END;
$$;

CREATE TRIGGER "ReleaseBatchMember_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "ReleaseBatchMember"
  FOR EACH ROW EXECUTE FUNCTION "orrery_release_batch_member_guard"();
