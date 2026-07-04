---
"@nicia-ai/typegraph": patch
---

Autocommit `bulkCreate` and `bulkInsert` calls (nodes and edges) now
refresh planner
statistics automatically when a single call writes 1,000 rows or more,
closing the stale-statistics window after bulk loads where the planner
keeps pre-load row estimates until ANALYZE runs (observed 25-200x
slowdowns on traversal and fulltext shapes). Tune the threshold or
disable with the new `autoRefreshStatistics` store option
(`createStore(graph, backend, { autoRefreshStatistics: 5000 })` or
`false`). Bulk writes inside a caller-provided transaction never
auto-refresh — statistics cannot see uncommitted rows — and a refresh
failure degrades to a warning without failing the committed write.
`importGraph()` keeps its existing built-in refresh.
