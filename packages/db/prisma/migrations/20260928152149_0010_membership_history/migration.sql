-- CreateEnum
CREATE TYPE "MembershipEventKind" AS ENUM ('JOINED', 'ROLE_CHANGED', 'REMOVED', 'LEFT', 'CLASSROOM_ARCHIVED');

-- CreateTable
CREATE TABLE "MembershipEvent" (
    "id" TEXT NOT NULL,
    "classroomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actorId" TEXT,
    "kind" "MembershipEventKind" NOT NULL,
    "fromRole" "ClassroomRole",
    "toRole" "ClassroomRole",
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MembershipEvent_classroomId_userId_createdAt_idx" ON "MembershipEvent"("classroomId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "MembershipEvent_classroomId_kind_createdAt_idx" ON "MembershipEvent"("classroomId", "kind", "createdAt");

-- AddForeignKey
ALTER TABLE "MembershipEvent" ADD CONSTRAINT "MembershipEvent_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "Classroom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- P4-T2. `fromRole`/`toRole` are constrained together, because half a role change is a lie.
--
-- The database is the only place that sees every write to this table — including the ones a
-- future script makes — so "a ROLE_CHANGED row that says what it changed FROM, or a row that
-- says it changed to nothing" has to be impossible here rather than merely discouraged in a
-- service. A history that can lie is worse than no history, because it is believed.
ALTER TABLE "MembershipEvent"
  ADD CONSTRAINT "MembershipEvent_role_change_has_both_ends"
  CHECK ("kind" <> 'ROLE_CHANGED' OR ("fromRole" IS NOT NULL AND "toRole" IS NOT NULL AND "fromRole" <> "toRole"));

-- A JOINED row has no previous role, and a departure has no next one. This is the other half of
-- the same claim.
ALTER TABLE "MembershipEvent"
  ADD CONSTRAINT "MembershipEvent_joined_has_no_previous_role"
  CHECK ("kind" <> 'JOINED' OR "fromRole" IS NULL);

-- `toRole` is meaningful only where a role was taken on or moved, and must be absent where one
-- was ended. A LEFT row carrying a `toRole` reads as though the person is still a student.
ALTER TABLE "MembershipEvent"
  ADD CONSTRAINT "MembershipEvent_departure_has_no_next_role"
  CHECK ("kind" NOT IN ('REMOVED', 'LEFT') OR "toRole" IS NULL);
