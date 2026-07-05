---
"@nicia-ai/typegraph": patch
---

Fixes a scaling bug in the SQLite backend's `refreshStatistics()` (the
planner-statistics refresh `bulkCreate`/`bulkInsert` trigger automatically
after a large autocommit write — see the `autoRefreshStatistics` store
option). It ran a bare, unscoped `ANALYZE`, which does two things wrong on
SQLite: it re-analyzes every table in the database file (not just
TypeGraph's own tables — already fixed on the Postgres backend), and it
does a full, unbounded table/index scan per call (Postgres's `ANALYZE`
samples a fixed-size set of rows regardless of table size; SQLite's does
not unless bounded). A caller streaming a bulk load through repeated
`bulkInsert()` calls — the only practical way to load a multi-million-row
dataset without holding it all in memory — re-triggers this once each
batch's row count crosses the threshold; with unbounded per-call cost
growing with total table size, total load time integrated to O(n²)
instead of O(n) (observed: a 2M-row bulk load that never finished after
4.5+ hours). `refreshStatistics()` on SQLite now scopes ANALYZE to
TypeGraph's own tables and sets `PRAGMA analysis_limit` first, bounding
each call's cost the way Postgres's already was. A 100k-row reproduction
of the original shape now completes in ~8s with load time growing
log-ishly with table size (2x from first batch to last), not
quadratically.
