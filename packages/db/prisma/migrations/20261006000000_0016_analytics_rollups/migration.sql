-- Analytics rollups: computed figures WITH their freshness and invalidation state.  (P11-T6, P11-T10, P11-T11)
--
-- `packages/analytics/src/rollups.ts` has defined `Rollup<T>` since P11-T11 -- computedAt, every invalidation since the
-- last computation, the value, and whether a recomputation is in flight -- and NOTHING PERSISTED IT. The form statistics
-- P11-T6 wants and the similarity clusters P11-T10 wants had nowhere to live with a freshness timestamp, which is exactly
-- what `plans/08` §6 requires on every figure ("a freshness timestamp on every figure, and an explicit 'recomputing'
-- state so a screen never serves a figure whose invalidation is in flight").
--
-- EVERY STATEMENT IS RETRYABLE (`IF NOT EXISTS`), which is the `0015` lesson: a migration that fails halfway must be
-- re-runnable, or a partial deployment needs a manual step nobody will remember.

-- THE ENUM NEEDS A GUARD BLOCK, AND THAT IS NOT OPTIONAL.
--
-- Postgres has NO `CREATE TYPE IF NOT EXISTS`. The first version of this file used a bare `CREATE TYPE`, and a partial run
-- left `AnalyticsRollupKind` behind -- so the retry -- which is the whole point of every other statement here being
-- `IF NOT EXISTS` -- died on `type already exists` before reaching the work it still had to do.
--
-- `0015` used `ALTER TYPE ... ADD VALUE IF NOT EXISTS` for exactly this reason, which works because ALTER on an existing
-- type is a no-op when the value is present. A brand-new enum has nothing to ALTER, so the guard has to be an existence
-- check in a DO block. **A migration whose retryability is asserted in a comment is worth nothing if its first statement
-- cannot survive a partial run.**
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AnalyticsRollupKind') THEN
        CREATE TYPE "AnalyticsRollupKind" AS ENUM ('FORM_STATS', 'SIMILARITY');
    END IF;
END
$$;

-- `computedAt` DEFAULTS TO THE EPOCH, and that default is load-bearing rather than cosmetic.
--
-- Zero means NEVER COMPUTED, which `freshness()` and `serve()` treat differently from "computed a long time ago" -- an
-- empty rollup has no figure at all, and a stale one has a figure plus a timestamp. Collapsing them would make "we have
-- never looked" indistinguishable from "we looked in March".
CREATE TABLE IF NOT EXISTS "AnalyticsRollup" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "kind" "AnalyticsRollupKind" NOT NULL,
    "value" JSONB,
    -- THE EXPLICIT LITERAL, AND `'epoch'` DOES NOT WORK HERE DESPITE BEING THE SAME INSTANT.
    --
    -- Postgres ACCEPTS `'epoch'` as a timestamp input and then NORMALISES it: the stored default comes back out of
    -- `information_schema` as `'1970-01-01 00:00:00+00'::timestamp with time zone`. So a schema written as
    -- `@default(dbgenerated("'epoch'"))` can never match a replay of this migration, and `gate:schema` fails forever
    -- on a difference that is not a difference.
    --
    -- **I CHANGED THIS FILE FIRST, ON THE GATE'S WORD, AND WAS WRONG.** `gate:schema` reported the disagreement and I
    -- assumed the migration was the side that had to move; the real cause was Postgres normalising the literal, and the
    -- schema is what has to carry the normalised spelling. Both now say `'1970-01-01 00:00:00+00'`.
    "computedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT '1970-01-01 00:00:00+00',
    -- THE WHOLE LIST, OLDEST FIRST, NOT THE LATEST REASON.
    --
    -- A rollup invalidated by a regrade and then by new responses is a different situation from one invalidated only by a
    -- regrade. `rollups.ts` appends rather than replaces for exactly that reason, and this column is where that decision
    -- has to survive a process restart. Storing only the latest reason would silently discard it.
    "invalidatedBy" JSONB NOT NULL DEFAULT '[]',
    "isRecomputing" BOOLEAN NOT NULL DEFAULT false,
    -- REVISION, so a concurrent recomputation cannot overwrite a newer one.
    --
    -- The pure `recompute` knows nothing about concurrency, so without a compare-and-set the last writer wins -- and a
    -- stale figure computed BEFORE a regrade lands AFTER the recompute that regrade triggered, with a fresh timestamp.
    -- That is the one wrong state `serve()` cannot detect, because every field it looks at says "current".
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NO DEFAULT, because `@updatedAt` IS CLIENT-APPLIED BY PRISMA -- exactly the trap `release-bulk-write.ts` had to
    -- handle explicitly for the release. A database default here would be a second source of truth for one column, and
    -- `gate:schema` flags the disagreement between it and the schema.
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AnalyticsRollup_pkey" PRIMARY KEY ("id")
);

-- ONE ROW PER (assignment, kind), ENFORCED BY THE DATABASE.
--
-- Without this unique, two workers inserting FORM_STATS produce two rows and every read has to decide which one is real.
-- The unique is also what makes `upsert` correct rather than hopeful.
CREATE UNIQUE INDEX IF NOT EXISTS "AnalyticsRollup_assignmentId_kind_key" ON "AnalyticsRollup"("assignmentId", "kind");

CREATE INDEX IF NOT EXISTS "AnalyticsRollup_kind_idx" ON "AnalyticsRollup"("kind");

DO $$
BEGIN
    -- `conrelid` AS WELL AS `conname`, because a constraint NAME is only unique per table and a bare name match could
    -- find an unrelated table's identically-named constraint and skip creating this one.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'AnalyticsRollup_assignmentId_fkey'
          -- QUOTED, AND THE SECOND TIME THIS FILE FOLDED CASE. `regclass` resolves an UNQUOTED name case-folded, so
          -- `'AnalyticsRollup'::regclass` looks for `analyticsrollup`, which does not exist -- the table is
          -- `"AnalyticsRollup"`. The failure is `relation "analyticsrollup" does not exist`, which names a relation
          -- nobody created and points nowhere near the cause.
          AND conrelid = '"AnalyticsRollup"'::regclass
    ) THEN
        ALTER TABLE "AnalyticsRollup"
            ADD CONSTRAINT "AnalyticsRollup_assignmentId_fkey"
            FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;