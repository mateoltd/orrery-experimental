-- Extensions required by plans/02-DATA-MODEL.prisma.
--
-- Prisma cannot express extensions, so migration 0001 in packages/db ALSO carries these
-- statements. This file is kept because the compose volume initialises once, BEFORE any
-- migration has run, and `prisma migrate dev` needs citext to exist in order to build its
-- shadow database at all.
--
-- 0001 used to claim the duplication was belt-and-braces when in fact it carried NOTHING and
-- only worked by luck of this file having run. A staging database or a CI database created by
-- `migrate deploy` never runs this file and would have failed on the first migration. Both
-- copies are now real, and both use IF NOT EXISTS so running them in either order is safe.
--
-- citext   B4: case-insensitive email uniqueness. The schema uses @db.Citext.
-- pg_trgm P3-T4: trigram fallback for typo-tolerant search.
-- btree_gin  Full-text search with array/JSONB columns.
-- pg_stat_statements  18: index and query review with EXPLAIN (ANALYZE, BUFFERS).
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
