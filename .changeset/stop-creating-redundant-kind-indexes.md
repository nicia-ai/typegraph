---
"@nicia-ai/typegraph": patch
---

New stores no longer create `typegraph_nodes_kind_idx` or `typegraph_edges_kind_idx`. Both index `(graph_id, kind)`, which is a prefix of an index TypeGraph keeps (`kind_created_idx`, and on nodes the primary key `(graph_id, kind, id)`), so no query loses an index. Maintaining them cost inserts: on PostgreSQL, a store without them inserted 7 to 11% faster (node bulk insert −11%, single-row node insert −9%, edge bulk insert −7%).

Existing stores keep both indexes. Upgrading removes nothing and takes no lock on the nodes or edges tables, and a store that still has them opens, verifies, materializes system indexes, reads and writes exactly as before. Dropping them is optional:

```sql
-- PostgreSQL: run each statement outside a transaction
DROP INDEX CONCURRENTLY IF EXISTS "typegraph_nodes_kind_idx";
DROP INDEX CONCURRENTLY IF EXISTS "typegraph_edges_kind_idx";

-- SQLite
DROP INDEX IF EXISTS "typegraph_nodes_kind_idx";
DROP INDEX IF EXISTS "typegraph_edges_kind_idx";
```

If you manage the schema with drizzle-kit, the next `drizzle-kit generate` produces a migration with two plain `DROP INDEX` statements for these indexes. On PostgreSQL they take an `ACCESS EXCLUSIVE` lock inside the migration transaction, which queues behind long-running reads and blocks every query queued after it. Either delete the two statements from the generated migration (harmless: the indexes are redundant), or delete them and run the concurrent form above separately.

This changes the shape of base schema version 9, which no release has shipped yet, so there is no new base-schema version and no adoption step. See [Redundant kind indexes on upgraded databases](https://typegraph.dev/performance/indexes#redundant-kind-indexes-on-upgraded-databases).
