---
"@nicia-ai/typegraph": patch
---

The default edge traversal indexes (`{table}_from_idx` / `{table}_to_idx`,
created for every graph on both SQLite and PostgreSQL) were missing two
things a traversal join needs to be served fully index-only:

- **`valid_from`** — one of the three system columns every compiled
  query's soft-delete / temporal-validity predicate checks (`deleted_at`
  and `valid_to` were already covered; `valid_from` wasn't).
- **The join's target-id column** — a compiled traversal reads `n.id =
  e.to_id` for an outgoing traversal, or `n.id = e.from_id` for an
  incoming one (`standard-builders.ts`), but neither index carried the
  *other* endpoint's id column, so the join to the target node still
  required a heap-row fetch even once the predicate columns above were
  covered.

Both gaps produce the same symptom: SQLite's plan reads `USING INDEX`,
never `USING COVERING INDEX`, so every candidate edge pays a heap-row
fetch. That fetch is free while the table fits in the page cache. Once it
doesn't — a real LDBC SNB benchmark run measured this at 10x data volume,
where the nodes table outgrew available cache — every one of those
fetches becomes a genuine random disk read, and with thousands of
candidates per traversal that alone produced a multi-second/minute
latency cliff on an otherwise sub-millisecond query shape. Both indexes
now carry all five columns beyond their existing seek prefix
(`deleted_at`, `valid_from`, `valid_to`, plus the other endpoint's id),
confirmed via `EXPLAIN QUERY PLAN` against the actual SQL `execute()`
sends (not `toSQL()`'s wider, unoptimized output) to flip to `USING
COVERING INDEX`.

**Existing databases get none of this until you rebuild the indexes.**
The widened indexes materialize on **fresh databases only**.
`generateSqliteMigrationSQL()` / `generatePostgresMigrationSQL()` emit
`CREATE INDEX IF NOT EXISTS` under the *same index name*, and that is a
no-op against an index that already exists — regardless of how the column
list changed. An upgraded deployment silently keeps its narrow index, and
keeps the latency cliff, until it runs the rebuild below. Upgrading the
package is not enough; there is no automatic migration.

```sql
-- SQLite: no CONCURRENTLY equivalent; drop and let the next migration
-- run (generateSqliteMigrationSQL(), or a createStoreWithSchema boot,
-- which re-issues idempotent DDL) recreate them.
DROP INDEX IF EXISTS typegraph_edges_from_idx;
DROP INDEX IF EXISTS typegraph_edges_to_idx;

-- PostgreSQL: CREATE INDEX CONCURRENTLY does not block writes, but it
-- cannot run inside a transaction and needs its own connection. Rename
-- the old index out of the way first so the new one can use the
-- production name without a window where neither exists.
ALTER INDEX typegraph_edges_from_idx RENAME TO typegraph_edges_from_idx_old;
CREATE INDEX CONCURRENTLY "typegraph_edges_from_idx" ON "typegraph_edges"
  ("graph_id", "from_kind", "from_id", "kind", "to_kind", "deleted_at", "valid_from", "valid_to", "to_id");
DROP INDEX CONCURRENTLY typegraph_edges_from_idx_old;

ALTER INDEX typegraph_edges_to_idx RENAME TO typegraph_edges_to_idx_old;
CREATE INDEX CONCURRENTLY "typegraph_edges_to_idx" ON "typegraph_edges"
  ("graph_id", "to_kind", "to_id", "kind", "from_kind", "deleted_at", "valid_from", "valid_to", "from_id");
DROP INDEX CONCURRENTLY typegraph_edges_to_idx_old;
```
