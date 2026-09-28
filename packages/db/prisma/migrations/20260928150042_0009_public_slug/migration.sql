-- P3-T6. The public URL namespace.
--
-- `canonicalResourcePath` is `/library/<slug>` -- deliberately WITHOUT the subject, so that
-- `moveSubject` (P3-T1, shipped and cycle-safe) cannot break the URL of every resource beneath
-- it. That choice makes the slug globally ambiguous, and this index is the thing that resolves
-- it.
--
-- PARTIAL, and that is the whole point:
--
--   · Uniqueness is required exactly where the URL is ambiguous -- a PUBLIC resource, whose
--     slug appears in a link anybody can share.
--   · It is NOT required in the authors' private libraries, where two teachers each having a
--     draft called `quadratics` is correct and expected.
--
-- A GLOBAL unique index on `slug` would have been the wrong constraint, and it is the kind of
-- wrong that looks right: enforced on a PRIVATE draft whose URL nobody can reach, so it blocks
-- ordinary authoring to protect an ambiguity that does not yet exist.
--
-- Re-evaluated on every write, so a resource moving PRIVATE -> PUBLIC that collides is rejected
-- by the database rather than by a rule somebody has to remember. That is the property that
-- matters: the constraint is where the data is, not where a request handler is.
--
-- IF NOT EXISTS because the schema gate's drift check replays this migration against a shadow
-- database that may already carry it.

CREATE UNIQUE INDEX IF NOT EXISTS "Resource_public_slug_key"
  ON "Resource" ("slug")
  WHERE "visibility" = 'PUBLIC';

-- The sitemap and the OG card both sort by `updatedAt` over the PUBLIC listing. Without this the
-- last query on a public page is a sort of every public resource, and the sort is invisible in
-- development and obvious in production.
CREATE INDEX IF NOT EXISTS "Resource_public_updated_idx"
  ON "Resource" ("updatedAt" DESC)
  WHERE "status" = 'PUBLISHED' AND "visibility" = 'PUBLIC';
