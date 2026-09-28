/*
  Warnings:

  - The `status` column on the `Comment` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Added the required column `updatedAt` to the `Comment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Rating` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "CommentStatus" AS ENUM ('VISIBLE', 'PENDING_REVIEW', 'HIDDEN', 'REMOVED');

-- CreateEnum
CREATE TYPE "FlagReason" AS ENUM ('SAFEGUARDING', 'UNSAFE_OR_HARMFUL', 'OFFENSIVE', 'COPYRIGHT', 'MISINFORMATION', 'SPAM', 'PERSONAL_INFORMATION', 'OTHER');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('OPEN', 'CLAIMED', 'RESOLVED', 'DISMISSED');

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "gateReason" TEXT,
ADD COLUMN     "gatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "moderatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "moderatedById" TEXT,
ADD COLUMN     "moderationReason" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMPTZ(3) NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "CommentStatus" NOT NULL DEFAULT 'VISIBLE';

-- AlterTable
ALTER TABLE "Rating" ADD COLUMN     "updatedAt" TIMESTAMPTZ(3) NOT NULL;

-- CreateTable
CREATE TABLE "Flag" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "commentId" TEXT,
    "reporterId" TEXT NOT NULL,
    "reason" "FlagReason" NOT NULL,
    "detail" TEXT,
    "status" "FlagStatus" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
    "acknowledgedOverdueAt" TIMESTAMPTZ(3),
    "resolution" TEXT,
    "resolvedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Flag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Flag_status_dueAt_idx" ON "Flag"("status", "dueAt");

-- CreateIndex
CREATE INDEX "Flag_status_reason_idx" ON "Flag"("status", "reason");

-- CreateIndex
CREATE INDEX "Flag_resourceId_status_idx" ON "Flag"("resourceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Flag_reporterId_resourceId_commentId_key" ON "Flag"("reporterId", "resourceId", "commentId");

-- CreateIndex
CREATE INDEX "Comment_resourceId_status_createdAt_idx" ON "Comment"("resourceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_status_gatedAt_idx" ON "Comment"("status", "gatedAt");

-- CreateIndex
CREATE INDEX "Rating_resourceId_idx" ON "Rating"("resourceId");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Constraints the schema language cannot express ────────────────────────────────
--
-- Three of them, and each one is a place where the application was the only thing holding a
-- line. A constraint holds when the write comes from a script, a backfill, or the next endpoint
-- somebody adds; an application check holds only until then.

-- `Rating.value` is 1..5. The column was a bare `Int`, and a rating feeds an AVERAGE, where
-- one outlier is a corrupted average rather than a rejected write — the failure is silent and
-- it poisons the number rather than the row.
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_value_range" CHECK ("value" BETWEEN 1 AND 5);

-- A HIDDEN or REMOVED comment must say why. A moderation action with no recorded reason cannot
-- be audited, and "who hid this and why" is the first question anybody asks of a queue.
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_hidden_needs_reason"
  CHECK ("status" NOT IN ('HIDDEN', 'REMOVED') OR ("moderationReason" IS NOT NULL AND length(trim("moderationReason")) > 0));

-- A PENDING_REVIEW comment must record WHEN it was gated and WHY, for the same reason: a
-- minor's comment sitting unreviewed with no timestamp is an unbounded hold, and an
-- unrecorded hold is indistinguishable from a comment that was never submitted.
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_gated_needs_reason"
  CHECK ("status" <> 'PENDING_REVIEW' OR ("gatedAt" IS NOT NULL AND "gateReason" IS NOT NULL));

-- A resolved flag must say what was decided. Without this, `status = 'RESOLVED'` and
-- `status = 'DISMISSED'` are the only distinction, and a resolution string of NULL records
-- nothing about which.
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_resolved_needs_resolution"
  CHECK ("status" NOT IN ('RESOLVED', 'DISMISSED') OR ("resolvedAt" IS NOT NULL AND "resolution" IS NOT NULL));

-- `FlagReason = OTHER` requires the reporter's own words. A moderation queue cannot act on
-- "other", so a flag with no detail is a flag nobody can work.
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_other_needs_detail"
  CHECK ("reason" <> 'OTHER' OR ("detail" IS NOT NULL AND length(trim("detail")) > 0));

-- `dueAt` must be AFTER the flag was raised. A deadline in the past at write time is an
-- instantly-overdue flag, and it is the shape a clock bug produces; the constraint turns a
-- silent misconfiguration into a failed write.
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_due_after_created"
  CHECK ("dueAt" >= "createdAt");
