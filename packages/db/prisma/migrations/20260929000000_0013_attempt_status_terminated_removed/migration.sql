-- P8-T11, `V-12`: remove `TERMINATED` from `AttemptStatus`.
--
-- `FROZEN` and `TERMINATED` have been side by side since `0001_init`. The `V-12` review concluded that `TERMINATED`
-- is unusable -- it set the attempt to TERMINATED, submitted "held answers", and so **irreversibly discarded every
-- unwritten item**, reducing the grade -- and added the requirement that no rung ends an attempt automatically. The
-- correction was written into the plan, the engine and the documentation, and the enum member was left behind.
--
-- ## WHY THIS RECREATES THE TYPE INSTEAD OF ALTERING IT
--
-- **PostgreSQL has no `ALTER TYPE ... DROP VALUE`.** I wrote that statement, and the schema gate's shadow replay
-- failed on it with `ERROR: syntax error at or near "VALUE"` (42601) on PostgreSQL 16.15. There is no version of
-- PostgreSQL that accepts it -- enum values cannot be dropped in place, because a column's type would change under
-- every index, constraint and row that references it. The supported route is to create a replacement type, move the
-- column across, and drop the old one.
--
-- So this is not a migration written to work around a missing feature. It is the only way to remove an enum value,
-- and the failure was caught by the drift gate replaying the history against a real database rather than by a test.
--
-- ## WHY `TERMINATED` ROWS BECOME `FROZEN` RATHER THAN FAILING
--
-- `USING "status"::text::"AttemptStatus_new"` would raise on any row still holding `TERMINATED`, so the `CASE` maps
-- them first. `FROZEN` is the correct landing state and not merely the least-wrong available one:
--
--   · it submits what the student WROTE, which is what TERMINATED claimed to do;
--   · it leaves the attempt reviewable, and a teacher can reinstate it with a recorded reason;
--   · it keeps the attempt out of `PENDING_REVIEW`, so an ordinary grading pass does not silently begin disposing of
--     attempts that were escalated for integrity reasons and need a person.
--
-- Any attempt terminated under the old scheme has therefore been **under-crediting that student this whole time**, and
-- this migration is what makes those attempts gradeable at all. Moving the rows is not housekeeping for the enum
-- change; it is the actual repair.
--
-- The DEFAULT must be dropped before the column changes type, because a default of `'NOT_STARTED'::AttemptStatus`
-- cannot be carried to a type that no longer exists, and restored afterwards.
--
-- `AttemptEventType.TERMINATED` is deliberately KEPT. An audit log is append-only history: rows written before this
-- correction still say TERMINATED, and deleting the member would make the record of what happened unreadable -- which
-- is how a correction quietly becomes unreviewable. What that enum cannot do is cause a termination, because no
-- writer transitions an attempt there any more.

CREATE TYPE "AttemptStatus_new" AS ENUM (
  'NOT_STARTED', 'IN_PROGRESS', 'FROZEN', 'SUBMITTED', 'EXPIRED',
  'PENDING_REVIEW', 'GRADED', 'RELEASED', 'EXCUSED', 'VOIDED'
);

ALTER TABLE "ExamAttempt" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "ExamAttempt"
  ALTER COLUMN "status" TYPE "AttemptStatus_new"
  USING (CASE WHEN "status"::text = 'TERMINATED' THEN 'FROZEN' ELSE "status"::text END)::"AttemptStatus_new";

ALTER TABLE "ExamAttempt" ALTER COLUMN "status" SET DEFAULT 'NOT_STARTED';

DROP TYPE "AttemptStatus";

ALTER TYPE "AttemptStatus_new" RENAME TO "AttemptStatus";