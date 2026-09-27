-- P3-T4. Search: weighted tsvector, facets, zero-result log.
--
-- The `searchVector` column is hand-edited after generation. Prisma's `@default(dbgenerated())`
-- emits `DEFAULT <expr>`, and Postgres rejects a column reference in a DEFAULT
-- (`cannot use column reference in DEFAULT expression`) — so a generated column is not
-- expressible through Prisma's schema language and has to be written here. schema.prisma still
-- DECLARES the column, so `prisma migrate diff` sees the same column in both places; only the
-- GENERATED clause lives in this file, and `prisma db pull` would drop it on introspection.
--
-- Why a generated column and not a trigger: both make "forgot to update the vector"
-- impossible, and the generated column additionally cannot be bypassed by a raw SQL write.
-- The trigger version is the fallback if `migrate diff` ever objects, and it is a two-line
-- change rather than a redesign.

-- `pg_trgm` for the typo/substring fallback. Extension first: the GIN trigram indexes below
-- depend on the operator class it provides.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "bodyText" TEXT,
ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en-GB',
ADD COLUMN     "maxAge" INTEGER,
ADD COLUMN     "minAge" INTEGER,
ADD COLUMN     "tagText" TEXT;

-- `title > summary > tags > body`, as `plans/05` §6 specifies.
--
-- GENERATED ALWAYS ... STORED: Postgres recomputes it on every write, so no code path can
-- leave a row unsearchable. `to_tsvector(regconfig, text)` is IMMUTABLE, which a generated
-- column requires — the one-argument `to_tsvector(text)` is STABLE and is rejected here.
ALTER TABLE "Resource"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
      setweight(to_tsvector('english'::regconfig, coalesce("title", '')),    'A') ||
      setweight(to_tsvector('english'::regconfig, coalesce("summary", '')),  'B') ||
      setweight(to_tsvector('english'::regconfig, coalesce("tagText", '')),  'C') ||
      setweight(to_tsvector('english'::regconfig, coalesce("bodyText", '')), 'D')
  ) STORED;

-- The vector index. GIN, because the access pattern is `@@` containment, not ordering.
CREATE INDEX "Resource_searchVector_idx" ON "Resource" USING GIN ("searchVector");

-- The trigram fallback. `gin_trgm_ops` serves `ILIKE '%term%'` and `similarity()`, which is
-- what the fallback actually issues — a plain btree cannot serve a leading wildcard.
CREATE INDEX "Resource_title_idx" ON "Resource" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "Resource_summary_idx" ON "Resource" USING GIN ("summary" gin_trgm_ops);
CREATE INDEX "Resource_tagText_idx" ON "Resource" USING GIN ("tagText" gin_trgm_ops);

-- CreateTable
CREATE TABLE "ZeroResultQuery" (
    "id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "subjectSlug" TEXT,
    "kind" TEXT,
    "tags" JSONB,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZeroResultQuery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ZeroResultQuery_term_createdAt_idx" ON "ZeroResultQuery"("term", "createdAt");

-- CreateIndex
CREATE INDEX "ZeroResultQuery_createdAt_idx" ON "ZeroResultQuery"("createdAt");

-- CreateIndex
CREATE INDEX "Resource_language_idx" ON "Resource"("language");

-- CreateIndex
CREATE INDEX "Resource_minAge_maxAge_idx" ON "Resource"("minAge", "maxAge");
