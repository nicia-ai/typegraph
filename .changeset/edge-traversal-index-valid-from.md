---
"@nicia-ai/typegraph": patch
---

The default edge traversal indexes (`{table}_from_idx` / `{table}_to_idx`,
created for every graph on both SQLite and PostgreSQL) included `deleted_at`
and `valid_to` but were missing `valid_from` — one of the three system
columns every compiled query's soft-delete / temporal-validity predicate
checks. A traversal join could therefore never be served fully index-only:
SQLite's plan read `USING INDEX`, never `USING COVERING INDEX`, so every
candidate edge required a heap-row fetch just to evaluate `valid_from`.

That fetch is free while the table fits in the page cache. Once it doesn't
— a real LDBC SNB benchmark run measured this at 10x data volume, where the
nodes table outgrew available cache — every one of those fetches becomes a
genuine random disk read, and with thousands of candidates per traversal
that alone produced a multi-second/minute latency cliff on an otherwise
sub-millisecond query shape. Both indexes now carry all three system
columns (`deleted_at`, `valid_from`, `valid_to`), confirmed via `EXPLAIN
QUERY PLAN` to flip to `USING COVERING INDEX`.

**Existing databases**: this only changes the DDL emitted for new tables —
`generateSqliteMigrationSQL()` / `generatePostgresMigrationSQL()` emit
`CREATE INDEX IF NOT EXISTS`, which is a no-op against an index that
already exists under that name, regardless of column-list changes.
Databases bootstrapped before this fix need a manual rebuild to pick it up:

```sql
-- SQLite
DROP INDEX IF EXISTS typegraph_edges_from_idx;
DROP INDEX IF EXISTS typegraph_edges_to_idx;
-- then re-run generateSqliteMigrationSQL() (or restart under
-- createStoreWithSchema, which re-issues idempotent DDL on boot)

-- PostgreSQL — CONCURRENTLY avoids blocking writes during the rebuild
DROP INDEX CONCURRENTLY IF EXISTS typegraph_edges_from_idx;
DROP INDEX CONCURRENTLY IF EXISTS typegraph_edges_to_idx;
-- then re-run generatePostgresMigrationSQL()
```
