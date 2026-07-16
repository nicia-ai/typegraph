---
"@nicia-ai/typegraph": patch
---

Add a `(graph_id, id)` index to the live and recorded node tables so bare-id
lookups (a node's `id` without its `kind`) seek instead of scanning the
graph's node partition — the composite keys lead with `kind`, so they can't
serve that probe. `store.algorithms.degree()`'s node-kind subquery is the
main consumer: ~95 ms → sub-millisecond at LDBC SNB SF1 (3.16M nodes) on
SQLite, at the live and recorded coordinates alike.

New databases get both indexes at bootstrap. Existing databases adopt them
with a one-time `await backend.bootstrapTables()` — every statement is
`CREATE … IF NOT EXISTS`, so the call is idempotent and only creates what's
missing. On PostgreSQL this issues a plain `CREATE INDEX` (briefly locks
writes on large tables); schedule it, or apply the equivalent
`CREATE INDEX CONCURRENTLY` statements manually.
