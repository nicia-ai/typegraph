---
"@nicia-ai/typegraph": patch
---

PostgreSQL stores gain a partial index on each of the nodes and edges tables, `(graph_id, kind, created_at, id) WHERE deleted_at IS NULL` (`typegraph_nodes_live_created_idx`, `typegraph_edges_live_created_idx`). With it, `nodes.find()`, `edges.find()`, query-builder `orderBy(alias, "meta.createdAt")` and `paginate()` read a kind's live rows in index order instead of sorting the whole live kind on every page. PostgreSQL does not treat `deleted_at IS NULL` as an ordering equality, so `kind_created_idx` could not serve that order. At 2M rows of a kind, the first `find()` page went from 285 ms to 0.31 ms.

The cost is about 65 MB of index per million live rows on each table, and a bulk `INSERT ... SELECT` of nodes that is 43% slower. Store-API writes stayed within measurement noise.

Existing databases build the indexes with `CREATE INDEX CONCURRENTLY` the next time `createStoreWithSchema()` opens them, or through `store.materializeSystemIndexes()`. drizzle-kit users get two plain `CREATE INDEX` statements in their next generated migration. Those block writes while they build, so edit them to `CREATE INDEX CONCURRENTLY IF NOT EXISTS` and run them outside a transaction. SQLite is unchanged: it already serves this order from `kind_created_idx`.

System-index declarations can now be partial (`predicate`) and scoped to dialects (`dialects`). The runtime DDL, the Drizzle schema and the drift signature all derive from those fields.
