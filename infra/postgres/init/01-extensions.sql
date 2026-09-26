-- Extensions required by plans/02-DATA-MODEL.prisma.
--
-- Prisma cannot express extensions or partial indexes, so migration 0001 in
-- packages/db carries the same statements. They are repeated here because the
-- compose volume initialises once, before any migration has run.
--
-- citext   B4: case-insensitive email uniqueness. The schema uses @db.Citext.
-- pg_trgm P3-T4: trigram fallback for typo-tolerant search.
-- btree_gin  Full-text search with array/JSONB columns.
-- pg_stat_statements  18: index and query review with EXPLAIN (ANALYZE, BUFFERS).
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
