-- ════════════════════════════════════════════════════════════════════════════════
-- 0001_init — EXTENSIONS FIRST, AND THIS FILE MUST BE SELF-CONTAINED.
--
-- The compose init script in infra/postgres/init/ creates these extensions too, and the
-- comment there used to claim this migration also carried them. IT DID NOT. The first
-- `migrate dev` appeared to succeed only because the compose volume had already created
-- citext, and the failure surfaced on the SECOND migration, when `migrate dev` validated
-- 0001 against a freshly-created SHADOW database that had no extensions at all:
--
--     P3006: Migration `0001_init` failed to apply cleanly to the shadow database.
--     ERROR:  type "citext" does not exist
--
-- That is a real deployment bug, not a local annoyance: a staging database, a CI database
-- or a new developer's machine created by `migrate deploy` would have failed on the very
-- first migration. It only worked here by accident of a volume that initialised once.
--
-- Duplicated from infra/postgres/init/01-extensions.sql on purpose. The init script cannot
-- be the source of truth for a migration, because a database restored from a dump, or one
-- created by `migrate deploy` in CI, never runs it.
--
-- IF NOT EXISTS throughout, so this is safe on a database where the init script already
-- ran. `pg_stat_statements` additionally needs shared_preload_libraries, which is a server
-- setting rather than a per-database one, so it is tolerated as optional here — a failure to
-- load a query-statistics extension must not block a schema migration.
-- ════════════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS citext;      -- B4: case-insensitive email. @db.Citext.
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- P3-T4: trigram fallback for typo-tolerant search.
CREATE EXTENSION IF NOT EXISTS btree_gin;   -- full-text search over array/JSONB columns.

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION WHEN OTHERS THEN
  -- 18: index and query review with EXPLAIN (ANALYZE, BUFFERS). Requires
  -- shared_preload_libraries, set in the container command rather than per-database. A
  -- database created outside that container legitimately cannot have it, and losing query
  -- statistics is not a reason to refuse to create a schema.
  RAISE NOTICE 'pg_stat_statements unavailable: %', SQLERRM;
END
$$;

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETING', 'DELETED');

-- CreateEnum
CREATE TYPE "ResourceKind" AS ENUM ('LESSON', 'QUIZ', 'EXAM');

-- CreateEnum
CREATE TYPE "ResourceStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PRIVATE', 'UNLISTED', 'PUBLIC');

-- CreateEnum
CREATE TYPE "GradingMode" AS ENUM ('AUTO', 'MANUAL', 'HYBRID');

-- CreateEnum
CREATE TYPE "ResponseProcess" AS ENUM ('RECOGNITION', 'RECALL', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "QuestionPoolStrategy" AS ENUM ('RANDOM_WITHOUT_REPLACEMENT', 'QUOTA_TOPICS', 'QUOTA_RESPONSE_PROCESS', 'FIXED');

-- CreateEnum
CREATE TYPE "SimulationStatus" AS ENUM ('REGISTERED', 'DEPRECATED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ClassroomRole" AS ENUM ('OWNER', 'TEACHER', 'REVIEWER', 'STUDENT');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'REMOVED', 'LEFT');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AssignmentMode" AS ENUM ('ASSIGNMENT', 'EXAM');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'FROZEN', 'SUBMITTED', 'EXPIRED', 'TERMINATED', 'PENDING_REVIEW', 'GRADED', 'RELEASED', 'EXCUSED', 'VOIDED');

-- CreateEnum
CREATE TYPE "AttemptSource" AS ENUM ('CLIENT', 'CRON', 'TEACHER');

-- CreateEnum
CREATE TYPE "AttemptPurpose" AS ENUM ('PRACTICE', 'GRADED');

-- CreateEnum
CREATE TYPE "AttemptEventType" AS ENUM ('STARTED', 'RESUMED', 'SAVED', 'LATE_SAVE_REJECTED', 'QUESTION_OPENED', 'QUESTION_WINDOW_CLOSED', 'SUBMITTED', 'AUTO_SUBMITTED', 'EXPIRED', 'AUTO_GRADED', 'MANUAL_GRADED', 'GRADED', 'RELEASED', 'REGRADED', 'TERMINATED', 'REINSTATED', 'FROZEN', 'VOIDED', 'EXCUSED', 'DEADLINE_EXTENDED', 'PAUSED', 'RESUMED_FROM_PAUSE', 'POLICY_OVERRIDDEN', 'ACCOMMODATION_APPLIED', 'VIOLATION_THRESHOLD_REACHED', 'SEAL_ESCALATED');

-- CreateEnum
CREATE TYPE "AnswerSource" AS ENUM ('CLIENT', 'TEACHER', 'GRADE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ReviewTaskStatus" AS ENUM ('PENDING', 'CLAIMED', 'DONE');

-- CreateEnum
CREATE TYPE "ReleaseBatchStatus" AS ENUM ('DRAFT', 'READY', 'RELEASING', 'RELEASED', 'CANCELED');

-- CreateEnum
CREATE TYPE "FeedbackVisibility" AS ENUM ('TEACHER_ONLY', 'STUDENT_AFTER_RELEASE');

-- CreateEnum
CREATE TYPE "EventSeverity" AS ENUM ('INFO', 'WARN', 'VIOLATION');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "email" CITEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "locale" TEXT NOT NULL DEFAULT 'en-GB',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "isMinor" BOOLEAN NOT NULL DEFAULT false,
    "guardianEmail" TEXT,
    "guardianConsentAt" TIMESTAMPTZ(3),
    "deletingAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "anonymisedAt" TIMESTAMPTZ(3),
    "suspendedReason" TEXT,
    "lastLoginAt" TIMESTAMPTZ(3),
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecretEnc" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "dedupeKey" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "refreshTokenExpiresAt" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subject" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "colour" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "parentId" TEXT,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "ownerId" TEXT NOT NULL,
    "kind" "ResourceKind" NOT NULL DEFAULT 'LESSON',
    "status" "ResourceStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "summary" TEXT,
    "subjectId" TEXT,
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceVersion" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "blocks" JSONB NOT NULL,
    "blocksChecksum" TEXT NOT NULL,
    "meta" JSONB NOT NULL,
    "assessmentPolicy" JSONB,
    "blueprintId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceTag" (
    "resourceId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "ResourceTag_pkey" PRIMARY KEY ("resourceId","tagId")
);

-- CreateTable
CREATE TABLE "ResourceSimRef" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "resourceVersionId" TEXT,
    "blockId" TEXT NOT NULL,
    "simId" TEXT NOT NULL,
    "simVersion" TEXT NOT NULL,

    CONSTRAINT "ResourceSimRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionBank" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "sharedWithClassroomIds" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "QuestionBank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "bankId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "points" DECIMAL(9,2) NOT NULL DEFAULT 1,
    "gradingMode" "GradingMode" NOT NULL DEFAULT 'AUTO',
    "partialCreditMethod" TEXT,
    "timeLimitSec" INTEGER,
    "shuffleOptions" BOOLEAN NOT NULL DEFAULT false,
    "estimatedSeconds" INTEGER,
    "modelAnswer" TEXT,
    "rubric" JSONB,
    "language" TEXT NOT NULL DEFAULT 'en-GB',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "topic" TEXT,
    "cognitiveDemand" TEXT,
    "responseProcess" "ResponseProcess",
    "retiredFromSummativeUse" BOOLEAN NOT NULL DEFAULT false,
    "simId" TEXT,
    "simVersion" TEXT,
    "simConfig" JSONB,
    "scoringSurface" TEXT,
    "isSnapshot" BOOLEAN NOT NULL DEFAULT false,
    "resourceVersionId" TEXT,
    "snapshotOfId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionTag" (
    "questionId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "QuestionTag_pkey" PRIMARY KEY ("questionId","tagId")
);

-- CreateTable
CREATE TABLE "QuestionPool" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "bankId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "strategy" "QuestionPoolStrategy" NOT NULL DEFAULT 'RANDOM_WITHOUT_REPLACEMENT',
    "drawCount" INTEGER NOT NULL,
    "filter" JSONB,
    "expectedCohortSize" INTEGER NOT NULL DEFAULT 30,
    "minDistinct" INTEGER NOT NULL DEFAULT 1,
    "incompatibleItemPairs" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "QuestionPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionPoolItem" (
    "poolId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "QuestionPoolItem_pkey" PRIMARY KEY ("poolId","questionId")
);

-- CreateTable
CREATE TABLE "Blueprint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "matrix" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Blueprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlueprintCheck" (
    "id" TEXT NOT NULL,
    "blueprintId" TEXT NOT NULL,
    "resourceVersionId" TEXT,
    "pass" BOOLEAN NOT NULL,
    "blocksAllDraws" BOOLEAN NOT NULL DEFAULT false,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlueprintCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentSlot" (
    "id" TEXT NOT NULL,
    "resourceVersionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "questionId" TEXT,
    "poolId" TEXT,
    "drawCount" INTEGER,
    "strategy" "QuestionPoolStrategy",

    CONSTRAINT "AssessmentSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Simulation" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" "SimulationStatus" NOT NULL DEFAULT 'REGISTERED',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "subjects" TEXT[],
    "tags" TEXT[],
    "subjectId" TEXT,
    "manifest" JSONB NOT NULL,
    "bundlePath" TEXT NOT NULL,
    "bundleSha256" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "graderEntry" TEXT,
    "capturesPath" TEXT,
    "licence" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "provenanceRef" TEXT,
    "authors" TEXT[],
    "replacedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "Simulation_pkey" PRIMARY KEY ("id","version")
);

-- CreateTable
CREATE TABLE "SimulationDraft" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "compiled" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SimulationDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Classroom" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "archivedAt" TIMESTAMPTZ(3),
    "deletingAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Classroom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "classroomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ClassroomRole" NOT NULL DEFAULT 'STUDENT',
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "displayNameOverride" TEXT,
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),
    "invitedById" TEXT,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassroomInvitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "classroomId" TEXT NOT NULL,
    "role" "ClassroomRole" NOT NULL DEFAULT 'STUDENT',
    "email" CITEXT,
    "codeHash" TEXT,
    "codeHint" TEXT,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMPTZ(3),
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "sentById" TEXT NOT NULL,
    "acceptedById" TEXT,
    "acceptedAt" TIMESTAMPTZ(3),
    "resendCount" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassroomInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RosterImport" (
    "id" TEXT NOT NULL,
    "classroomId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "summary" JSONB NOT NULL,
    "errors" JSONB NOT NULL,
    "appliedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RosterImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewerGrant" (
    "id" TEXT NOT NULL,
    "classroomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'GRADING',
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ReviewerGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "classroomId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceVersionId" TEXT NOT NULL,
    "mode" "AssignmentMode" NOT NULL DEFAULT 'ASSIGNMENT',
    "status" "AssignmentStatus" NOT NULL DEFAULT 'DRAFT',
    "titleOverride" TEXT,
    "instructions" JSONB,
    "availableFrom" TIMESTAMPTZ(3),
    "availableUntil" TIMESTAMPTZ(3),
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "weight" DECIMAL(9,2) NOT NULL DEFAULT 100,
    "latePenaltyPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "policyOverride" JSONB,
    "moderationSampleSize" INTEGER NOT NULL DEFAULT 0,
    "moderationPercent" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "withdrawnAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentStudentOverride" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "availableFrom" TIMESTAMPTZ(3),
    "availableUntil" TIMESTAMPTZ(3),
    "maxAttempts" INTEGER,
    "extraTimePercent" DECIMAL(5,2),
    "policyOverride" JSONB,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignmentStudentOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Accommodation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "classroomId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "relaxations" TEXT[],
    "extraTimePercent" DECIMAL(5,2),
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Accommodation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccommodationRequest" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "classroomId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "requestedRelaxations" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "statement" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionReason" TEXT,
    "respondBy" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccommodationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamAttempt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "assignmentId" TEXT NOT NULL,
    "classroomId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "simId" TEXT,
    "simVersion" TEXT,
    "attemptNumber" INTEGER NOT NULL,
    "purpose" "AttemptPurpose" NOT NULL DEFAULT 'GRADED',
    "status" "AttemptStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "policySnapshot" JSONB,
    "rngSeed" TEXT,
    "variantMap" JSONB,
    "variantSource" TEXT NOT NULL DEFAULT 'VERSION',
    "startedAt" TIMESTAMPTZ(3),
    "deadlineAt" TIMESTAMPTZ(3),
    "gracePeriodSec" INTEGER NOT NULL DEFAULT 60,
    "pausedAccumSec" INTEGER NOT NULL DEFAULT 0,
    "frozenAt" TIMESTAMPTZ(3),
    "frozenReason" TEXT,
    "submittedAt" TIMESTAMPTZ(3),
    "submittedBy" "AttemptSource",
    "submissionReceipt" TEXT,
    "keysHash" TEXT,
    "isLate" BOOLEAN NOT NULL DEFAULT false,
    "releasedAt" TIMESTAMPTZ(3),
    "regradeNoticePendingAt" TIMESTAMPTZ(3),
    "terminatedReason" TEXT,
    "voidedReason" TEXT,
    "sealedEscalatedAt" TIMESTAMPTZ(3),
    "autoScore" DECIMAL(9,2),
    "manualScore" DECIMAL(9,2),
    "finalScore" DECIMAL(9,2),
    "maxScore" DECIMAL(9,2),
    "percentage" DECIMAL(6,3),
    "latePenaltyApplied" DECIMAL(5,2),
    "accommodationId" TEXT,
    "preflight" JSONB,
    "relaxationsApplied" TEXT[],
    "droppedEventCount" INTEGER NOT NULL DEFAULT 0,
    "clientInfo" JSONB,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExamAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttemptEventRecord" (
    "id" BIGSERIAL NOT NULL,
    "attemptId" TEXT NOT NULL,
    "type" "AttemptEventType" NOT NULL,
    "actorId" TEXT,
    "serverTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "AttemptEventRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttemptSeq" (
    "attemptId" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AttemptSeq_pkey" PRIMARY KEY ("attemptId")
);

-- CreateTable
CREATE TABLE "AttemptDeadlineExtension" (
    "id" BIGSERIAL NOT NULL,
    "attemptId" TEXT NOT NULL,
    "addedSec" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "triggerEventTypes" TEXT[],
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttemptDeadlineExtension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttemptSession" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tabId" TEXT,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" TEXT,
    "userAgent" TEXT,
    "ipHash" TEXT,

    CONSTRAINT "AttemptSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttemptStrikeCounter" (
    "attemptId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AttemptStrikeCounter_pkey" PRIMARY KEY ("attemptId","kind")
);

-- CreateTable
CREATE TABLE "QuestionResponse" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "answer" JSONB NOT NULL,
    "simStateRef" TEXT,
    "simState" JSONB,
    "simStateBytes" INTEGER,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "isOmitted" BOOLEAN NOT NULL DEFAULT false,
    "notReached" BOOLEAN NOT NULL DEFAULT false,
    "isExcused" BOOLEAN NOT NULL DEFAULT false,
    "isLate" BOOLEAN NOT NULL DEFAULT false,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "timeSpentMs" INTEGER,
    "editCount" INTEGER NOT NULL DEFAULT 0,
    "questionOpenedAt" TIMESTAMPTZ(3),
    "questionDeadlineAt" TIMESTAMPTZ(3),
    "questionClosedReason" TEXT,
    "lastSavedAt" TIMESTAMPTZ(3),
    "saveState" TEXT NOT NULL DEFAULT 'UNSAVED',
    "autoScore" DECIMAL(9,2),
    "autoRawScore" DECIMAL(9,2),
    "autoCorrect" BOOLEAN,
    "autoGradedAt" TIMESTAMPTZ(3),
    "autoRationale" JSONB,
    "autoGraderVersion" TEXT,
    "manualScore" DECIMAL(9,2),
    "manualFeedback" TEXT,
    "rubricScores" JSONB,
    "wasQuickScored" BOOLEAN NOT NULL DEFAULT false,
    "graderId" TEXT,
    "gradedAt" TIMESTAMPTZ(3),
    "needsHuman" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "QuestionResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimStateBlob" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimStateBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnswerRevision" (
    "id" BIGSERIAL NOT NULL,
    "responseId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "source" "AnswerSource" NOT NULL,
    "actorId" TEXT,
    "previousHash" TEXT,
    "answerHash" TEXT NOT NULL,
    "answerBytes" TEXT,
    "serverTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientTs" TIMESTAMPTZ(3),
    "idemKey" TEXT,
    "responseStatus" INTEGER,
    "responseBody" JSONB,

    CONSTRAINT "AnswerRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewTask" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "graderId" TEXT,
    "status" "ReviewTaskStatus" NOT NULL DEFAULT 'PENDING',
    "claimedAt" TIMESTAMPTZ(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ReviewTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewAssignment" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "responseId" TEXT,
    "assigneeId" TEXT NOT NULL,
    "isSecondMarker" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "assignedById" TEXT NOT NULL,
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ReviewAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleaseBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "assignmentId" TEXT NOT NULL,
    "classroomId" TEXT NOT NULL,
    "label" TEXT,
    "status" "ReleaseBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "minHoldUntil" TIMESTAMPTZ(3),
    "overrideReason" TEXT,
    "releasedById" TEXT,
    "releasedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ReleaseBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleaseBatchMember" (
    "batchId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReleaseBatchMember_pkey" PRIMARY KEY ("batchId","attemptId")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "responseId" TEXT,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "FeedbackVisibility" NOT NULL DEFAULT 'STUDENT_AFTER_RELEASE',
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "disputedByCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeChange" (
    "id" TEXT NOT NULL,
    "responseId" TEXT,
    "attemptId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GradeChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrityEvent" (
    "id" BIGSERIAL NOT NULL,
    "attemptId" TEXT NOT NULL,
    "sessionId" TEXT,
    "clientSeq" INTEGER,
    "seq" INTEGER,
    "type" TEXT NOT NULL,
    "severity" "EventSeverity" NOT NULL DEFAULT 'INFO',
    "serverTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" TIMESTAMPTZ(3),
    "clientTs" TIMESTAMPTZ(3),
    "payload" JSONB NOT NULL,
    "receivedBy" TEXT,
    "dropped" BOOLEAN NOT NULL DEFAULT false,
    "accommodationRelaxed" BOOLEAN NOT NULL DEFAULT false,
    "protected" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "IntegrityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrityVerdict" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "consideredAccessibilityContext" BOOLEAN NOT NULL DEFAULT false,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrityVerdict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" BIGSERIAL NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "classroomId" TEXT,
    "meta" JSONB NOT NULL,
    "ipHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT,
    "data" JSONB,
    "readAt" TIMESTAMPTZ(3),
    "emailedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "altText" TEXT,
    "checksum" TEXT NOT NULL,
    "scanStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "scannedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rating" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'VISIBLE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "EmailOutbox" (
    "id" TEXT NOT NULL,
    "toEmail" CITEXT NOT NULL,
    "template" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentCounter" (
    "assignmentId" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "started" INTEGER NOT NULL DEFAULT 0,
    "submitted" INTEGER NOT NULL DEFAULT 0,
    "pendingReview" INTEGER NOT NULL DEFAULT 0,
    "released" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AssignmentCounter_pkey" PRIMARY KEY ("assignmentId")
);

-- CreateTable
CREATE TABLE "ExternalBinding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "localType" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMPTZ(3),
    "lastHash" TEXT,
    "meta" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExternalBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_emailNormalized_key" ON "User"("emailNormalized");

-- CreateIndex
CREATE INDEX "User_status_createdAt_idx" ON "User"("status", "createdAt");

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE INDEX "User_emailNormalized_idx" ON "User"("emailNormalized");

-- CreateIndex
CREATE INDEX "SecurityEvent_userId_createdAt_idx" ON "SecurityEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_kind_createdAt_idx" ON "SecurityEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_reviewedAt_createdAt_idx" ON "SecurityEvent"("reviewedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityEvent_dedupeKey_key" ON "SecurityEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Session_familyId_idx" ON "Session"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "Subject_slug_key" ON "Subject"("slug");

-- CreateIndex
CREATE INDEX "Subject_parentId_position_idx" ON "Subject"("parentId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_slug_key" ON "Tag"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_currentVersionId_key" ON "Resource"("currentVersionId");

-- CreateIndex
CREATE INDEX "Resource_kind_status_visibility_updatedAt_idx" ON "Resource"("kind", "status", "visibility", "updatedAt");

-- CreateIndex
CREATE INDEX "Resource_subjectId_kind_status_idx" ON "Resource"("subjectId", "kind", "status");

-- CreateIndex
CREATE INDEX "Resource_tenantId_status_idx" ON "Resource"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_ownerId_slug_key" ON "Resource"("ownerId", "slug");

-- CreateIndex
CREATE INDEX "ResourceVersion_resourceId_version_idx" ON "ResourceVersion"("resourceId", "version");

-- CreateIndex
CREATE INDEX "ResourceVersion_blueprintId_idx" ON "ResourceVersion"("blueprintId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceVersion_resourceId_version_key" ON "ResourceVersion"("resourceId", "version");

-- CreateIndex
CREATE INDEX "ResourceTag_tagId_idx" ON "ResourceTag"("tagId");

-- CreateIndex
CREATE INDEX "ResourceSimRef_simId_simVersion_idx" ON "ResourceSimRef"("simId", "simVersion");

-- CreateIndex
CREATE INDEX "ResourceSimRef_resourceId_version_idx" ON "ResourceSimRef"("resourceId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceSimRef_resourceId_version_blockId_key" ON "ResourceSimRef"("resourceId", "version", "blockId");

-- CreateIndex
CREATE INDEX "QuestionBank_ownerId_idx" ON "QuestionBank"("ownerId");

-- CreateIndex
CREATE INDEX "QuestionBank_tenantId_idx" ON "QuestionBank"("tenantId");

-- CreateIndex
CREATE INDEX "Question_resourceVersionId_idx" ON "Question"("resourceVersionId");

-- CreateIndex
CREATE INDEX "Question_bankId_type_idx" ON "Question"("bankId", "type");

-- CreateIndex
CREATE INDEX "Question_bankId_isSnapshot_idx" ON "Question"("bankId", "isSnapshot");

-- CreateIndex
CREATE INDEX "Question_simId_idx" ON "Question"("simId");

-- CreateIndex
CREATE INDEX "Question_snapshotOfId_idx" ON "Question"("snapshotOfId");

-- CreateIndex
CREATE INDEX "Question_topic_idx" ON "Question"("topic");

-- CreateIndex
CREATE INDEX "Question_retiredFromSummativeUse_idx" ON "Question"("retiredFromSummativeUse");

-- CreateIndex
CREATE UNIQUE INDEX "Question_resourceVersionId_snapshotOfId_key" ON "Question"("resourceVersionId", "snapshotOfId");

-- CreateIndex
CREATE INDEX "QuestionTag_tagId_idx" ON "QuestionTag"("tagId");

-- CreateIndex
CREATE INDEX "QuestionPool_bankId_idx" ON "QuestionPool"("bankId");

-- CreateIndex
CREATE INDEX "QuestionPool_tenantId_idx" ON "QuestionPool"("tenantId");

-- CreateIndex
CREATE INDEX "QuestionPoolItem_questionId_idx" ON "QuestionPoolItem"("questionId");

-- CreateIndex
CREATE INDEX "Blueprint_tenantId_idx" ON "Blueprint"("tenantId");

-- CreateIndex
CREATE INDEX "BlueprintCheck_blueprintId_createdAt_idx" ON "BlueprintCheck"("blueprintId", "createdAt");

-- CreateIndex
CREATE INDEX "AssessmentSlot_poolId_idx" ON "AssessmentSlot"("poolId");

-- CreateIndex
CREATE INDEX "AssessmentSlot_questionId_idx" ON "AssessmentSlot"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentSlot_resourceVersionId_position_key" ON "AssessmentSlot"("resourceVersionId", "position");

-- CreateIndex
CREATE INDEX "Simulation_status_idx" ON "Simulation"("status");

-- CreateIndex
CREATE INDEX "Simulation_subjects_idx" ON "Simulation"("subjects");

-- CreateIndex
CREATE INDEX "SimulationDraft_authorId_status_idx" ON "SimulationDraft"("authorId", "status");

-- CreateIndex
CREATE INDEX "Classroom_tenantId_archivedAt_idx" ON "Classroom"("tenantId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Classroom_ownerId_slug_key" ON "Classroom"("ownerId", "slug");

-- CreateIndex
CREATE INDEX "Enrollment_userId_status_idx" ON "Enrollment"("userId", "status");

-- CreateIndex
CREATE INDEX "Enrollment_classroomId_role_status_idx" ON "Enrollment"("classroomId", "role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_classroomId_userId_key" ON "Enrollment"("classroomId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassroomInvitation_codeHash_key" ON "ClassroomInvitation"("codeHash");

-- CreateIndex
CREATE INDEX "ClassroomInvitation_classroomId_status_idx" ON "ClassroomInvitation"("classroomId", "status");

-- CreateIndex
CREATE INDEX "ClassroomInvitation_email_status_idx" ON "ClassroomInvitation"("email", "status");

-- CreateIndex
CREATE INDEX "RosterImport_classroomId_createdAt_idx" ON "RosterImport"("classroomId", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewerGrant_userId_revokedAt_idx" ON "ReviewerGrant"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewerGrant_classroomId_userId_key" ON "ReviewerGrant"("classroomId", "userId");

-- CreateIndex
CREATE INDEX "Assignment_classroomId_status_idx" ON "Assignment"("classroomId", "status");

-- CreateIndex
CREATE INDEX "Assignment_status_availableFrom_availableUntil_idx" ON "Assignment"("status", "availableFrom", "availableUntil");

-- CreateIndex
CREATE INDEX "Assignment_tenantId_status_idx" ON "Assignment"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AssignmentStudentOverride_studentId_idx" ON "AssignmentStudentOverride"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentStudentOverride_assignmentId_studentId_key" ON "AssignmentStudentOverride"("assignmentId", "studentId");

-- CreateIndex
CREATE INDEX "Accommodation_studentId_status_idx" ON "Accommodation"("studentId", "status");

-- CreateIndex
CREATE INDEX "Accommodation_assignmentId_idx" ON "Accommodation"("assignmentId");

-- CreateIndex
CREATE INDEX "Accommodation_classroomId_status_idx" ON "Accommodation"("classroomId", "status");

-- CreateIndex
CREATE INDEX "AccommodationRequest_status_respondBy_idx" ON "AccommodationRequest"("status", "respondBy");

-- CreateIndex
CREATE INDEX "AccommodationRequest_studentId_status_idx" ON "AccommodationRequest"("studentId", "status");

-- CreateIndex
CREATE INDEX "AccommodationRequest_classroomId_status_idx" ON "AccommodationRequest"("classroomId", "status");

-- CreateIndex
CREATE INDEX "ExamAttempt_assignmentId_status_idx" ON "ExamAttempt"("assignmentId", "status");

-- CreateIndex
CREATE INDEX "ExamAttempt_classroomId_studentId_idx" ON "ExamAttempt"("classroomId", "studentId");

-- CreateIndex
CREATE INDEX "ExamAttempt_status_deadlineAt_idx" ON "ExamAttempt"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "ExamAttempt_releasedAt_idx" ON "ExamAttempt"("releasedAt");

-- CreateIndex
CREATE INDEX "ExamAttempt_tenantId_status_idx" ON "ExamAttempt"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ExamAttempt_simId_simVersion_idx" ON "ExamAttempt"("simId", "simVersion");

-- CreateIndex
CREATE INDEX "ExamAttempt_status_sealedEscalatedAt_idx" ON "ExamAttempt"("status", "sealedEscalatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttempt_assignmentId_studentId_attemptNumber_purpose_key" ON "ExamAttempt"("assignmentId", "studentId", "attemptNumber", "purpose");

-- CreateIndex
CREATE INDEX "AttemptEventRecord_attemptId_id_idx" ON "AttemptEventRecord"("attemptId", "id");

-- CreateIndex
CREATE INDEX "AttemptEventRecord_type_serverTs_idx" ON "AttemptEventRecord"("type", "serverTs");

-- CreateIndex
CREATE INDEX "AttemptDeadlineExtension_attemptId_id_idx" ON "AttemptDeadlineExtension"("attemptId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AttemptSession_tokenHash_key" ON "AttemptSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AttemptSession_attemptId_revokedAt_idx" ON "AttemptSession"("attemptId", "revokedAt");

-- CreateIndex
CREATE INDEX "AttemptSession_expiresAt_idx" ON "AttemptSession"("expiresAt");

-- CreateIndex
CREATE INDEX "QuestionResponse_attemptId_position_idx" ON "QuestionResponse"("attemptId", "position");

-- CreateIndex
CREATE INDEX "QuestionResponse_questionId_autoCorrect_idx" ON "QuestionResponse"("questionId", "autoCorrect");

-- CreateIndex
CREATE INDEX "QuestionResponse_needsHuman_idx" ON "QuestionResponse"("needsHuman");

-- CreateIndex
CREATE INDEX "QuestionResponse_isOmitted_notReached_idx" ON "QuestionResponse"("isOmitted", "notReached");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionResponse_attemptId_questionId_key" ON "QuestionResponse"("attemptId", "questionId");

-- CreateIndex
CREATE INDEX "SimStateBlob_attemptId_idx" ON "SimStateBlob"("attemptId");

-- CreateIndex
CREATE INDEX "AnswerRevision_attemptId_revision_idx" ON "AnswerRevision"("attemptId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "AnswerRevision_responseId_revision_key" ON "AnswerRevision"("responseId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "AnswerRevision_attemptId_idemKey_key" ON "AnswerRevision"("attemptId", "idemKey");

-- CreateIndex
CREATE INDEX "ReviewTask_status_priority_createdAt_idx" ON "ReviewTask"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewTask_graderId_status_idx" ON "ReviewTask"("graderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewTask_attemptId_key" ON "ReviewTask"("attemptId");

-- CreateIndex
CREATE INDEX "ReviewAssignment_assigneeId_status_idx" ON "ReviewAssignment"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "ReviewAssignment_attemptId_idx" ON "ReviewAssignment"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewAssignment_attemptId_responseId_assigneeId_key" ON "ReviewAssignment"("attemptId", "responseId", "assigneeId");

-- CreateIndex
CREATE INDEX "ReleaseBatch_assignmentId_status_idx" ON "ReleaseBatch"("assignmentId", "status");

-- CreateIndex
CREATE INDEX "ReleaseBatch_classroomId_status_idx" ON "ReleaseBatch"("classroomId", "status");

-- CreateIndex
CREATE INDEX "ReleaseBatch_tenantId_status_idx" ON "ReleaseBatch"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ReleaseBatch_status_minHoldUntil_idx" ON "ReleaseBatch"("status", "minHoldUntil");

-- CreateIndex
CREATE INDEX "ReleaseBatchMember_attemptId_idx" ON "ReleaseBatchMember"("attemptId");

-- CreateIndex
CREATE INDEX "Feedback_attemptId_visibility_idx" ON "Feedback"("attemptId", "visibility");

-- CreateIndex
CREATE INDEX "Feedback_responseId_disputedByCount_idx" ON "Feedback"("responseId", "disputedByCount");

-- CreateIndex
CREATE INDEX "GradeChange_attemptId_createdAt_idx" ON "GradeChange"("attemptId", "createdAt");

-- CreateIndex
CREATE INDEX "GradeChange_responseId_idx" ON "GradeChange"("responseId");

-- CreateIndex
CREATE INDEX "IntegrityEvent_attemptId_seq_idx" ON "IntegrityEvent"("attemptId", "seq");

-- CreateIndex
CREATE INDEX "IntegrityEvent_attemptId_severity_serverTs_idx" ON "IntegrityEvent"("attemptId", "severity", "serverTs");

-- CreateIndex
CREATE INDEX "IntegrityEvent_type_serverTs_idx" ON "IntegrityEvent"("type", "serverTs");

-- CreateIndex
CREATE INDEX "IntegrityEvent_protected_dropped_idx" ON "IntegrityEvent"("protected", "dropped");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrityEvent_attemptId_sessionId_clientSeq_key" ON "IntegrityEvent"("attemptId", "sessionId", "clientSeq");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrityVerdict_attemptId_key" ON "IntegrityVerdict"("attemptId");

-- CreateIndex
CREATE INDEX "IntegrityVerdict_outcome_decidedAt_idx" ON "IntegrityVerdict"("outcome", "decidedAt");

-- CreateIndex
CREATE INDEX "AuditEvent_targetType_targetId_createdAt_idx" ON "AuditEvent"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_classroomId_createdAt_idx" ON "AuditEvent"("classroomId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_key_key" ON "Asset"("key");

-- CreateIndex
CREATE INDEX "Asset_ownerId_kind_idx" ON "Asset"("ownerId", "kind");

-- CreateIndex
CREATE INDEX "Asset_scanStatus_idx" ON "Asset"("scanStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Rating_resourceId_userId_key" ON "Rating"("resourceId", "userId");

-- CreateIndex
CREATE INDEX "Comment_resourceId_status_createdAt_idx" ON "Comment"("resourceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_scope_createdAt_idx" ON "IdempotencyKey"("scope", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailOutbox_dedupeKey_key" ON "EmailOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "EmailOutbox_status_scheduledAt_idx" ON "EmailOutbox"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "ExternalBinding_localType_localId_idx" ON "ExternalBinding"("localType", "localId");

-- CreateIndex
CREATE INDEX "ExternalBinding_tenantId_idx" ON "ExternalBinding"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalBinding_kind_externalId_localType_localId_key" ON "ExternalBinding"("kind", "externalId", "localType", "localId");

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ResourceVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceVersion" ADD CONSTRAINT "ResourceVersion_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceVersion" ADD CONSTRAINT "ResourceVersion_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "Blueprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceVersion" ADD CONSTRAINT "ResourceVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceTag" ADD CONSTRAINT "ResourceTag_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceTag" ADD CONSTRAINT "ResourceTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceSimRef" ADD CONSTRAINT "ResourceSimRef_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceSimRef" ADD CONSTRAINT "ResourceSimRef_resourceVersionId_fkey" FOREIGN KEY ("resourceVersionId") REFERENCES "ResourceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionBank" ADD CONSTRAINT "QuestionBank_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "QuestionBank"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_resourceVersionId_fkey" FOREIGN KEY ("resourceVersionId") REFERENCES "ResourceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_snapshotOfId_fkey" FOREIGN KEY ("snapshotOfId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionTag" ADD CONSTRAINT "QuestionTag_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionTag" ADD CONSTRAINT "QuestionTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionPool" ADD CONSTRAINT "QuestionPool_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "QuestionBank"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionPoolItem" ADD CONSTRAINT "QuestionPoolItem_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "QuestionPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionPoolItem" ADD CONSTRAINT "QuestionPoolItem_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Blueprint" ADD CONSTRAINT "Blueprint_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlueprintCheck" ADD CONSTRAINT "BlueprintCheck_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "Blueprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlueprintCheck" ADD CONSTRAINT "BlueprintCheck_resourceVersionId_fkey" FOREIGN KEY ("resourceVersionId") REFERENCES "ResourceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentSlot" ADD CONSTRAINT "AssessmentSlot_resourceVersionId_fkey" FOREIGN KEY ("resourceVersionId") REFERENCES "ResourceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentSlot" ADD CONSTRAINT "AssessmentSlot_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentSlot" ADD CONSTRAINT "AssessmentSlot_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "QuestionPool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Simulation" ADD CONSTRAINT "Simulation_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationDraft" ADD CONSTRAINT "SimulationDraft_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Classroom" ADD CONSTRAINT "Classroom_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "Classroom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomInvitation" ADD CONSTRAINT "ClassroomInvitation_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "Classroom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomInvitation" ADD CONSTRAINT "ClassroomInvitation_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomInvitation" ADD CONSTRAINT "ClassroomInvitation_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterImport" ADD CONSTRAINT "RosterImport_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "Classroom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewerGrant" ADD CONSTRAINT "ReviewerGrant_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "Classroom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewerGrant" ADD CONSTRAINT "ReviewerGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "Classroom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_resourceVersionId_fkey" FOREIGN KEY ("resourceVersionId") REFERENCES "ResourceVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentStudentOverride" ADD CONSTRAINT "AssignmentStudentOverride_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentStudentOverride" ADD CONSTRAINT "AssignmentStudentOverride_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Accommodation" ADD CONSTRAINT "Accommodation_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "Classroom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Accommodation" ADD CONSTRAINT "Accommodation_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Accommodation" ADD CONSTRAINT "Accommodation_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Accommodation" ADD CONSTRAINT "Accommodation_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccommodationRequest" ADD CONSTRAINT "AccommodationRequest_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccommodationRequest" ADD CONSTRAINT "AccommodationRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "Classroom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_simId_simVersion_fkey" FOREIGN KEY ("simId", "simVersion") REFERENCES "Simulation"("id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptEventRecord" ADD CONSTRAINT "AttemptEventRecord_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptSeq" ADD CONSTRAINT "AttemptSeq_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptDeadlineExtension" ADD CONSTRAINT "AttemptDeadlineExtension_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptSession" ADD CONSTRAINT "AttemptSession_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptStrikeCounter" ADD CONSTRAINT "AttemptStrikeCounter_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionResponse" ADD CONSTRAINT "QuestionResponse_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionResponse" ADD CONSTRAINT "QuestionResponse_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionResponse" ADD CONSTRAINT "QuestionResponse_graderId_fkey" FOREIGN KEY ("graderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimStateBlob" ADD CONSTRAINT "SimStateBlob_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerRevision" ADD CONSTRAINT "AnswerRevision_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "QuestionResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerRevision" ADD CONSTRAINT "AnswerRevision_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_graderId_fkey" FOREIGN KEY ("graderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewAssignment" ADD CONSTRAINT "ReviewAssignment_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewAssignment" ADD CONSTRAINT "ReviewAssignment_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseBatch" ADD CONSTRAINT "ReleaseBatch_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseBatch" ADD CONSTRAINT "ReleaseBatch_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "Classroom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseBatch" ADD CONSTRAINT "ReleaseBatch_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseBatchMember" ADD CONSTRAINT "ReleaseBatchMember_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ReleaseBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseBatchMember" ADD CONSTRAINT "ReleaseBatchMember_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "QuestionResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeChange" ADD CONSTRAINT "GradeChange_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrityEvent" ADD CONSTRAINT "IntegrityEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrityVerdict" ADD CONSTRAINT "IntegrityVerdict_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrityVerdict" ADD CONSTRAINT "IntegrityVerdict_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
