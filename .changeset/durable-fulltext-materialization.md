---
"@nicia-ai/typegraph": minor
---

Durable, enforced fulltext materialization (#135).

Strategy-owned fulltext table/index DDL was materialized lazily, guarded by an
**in-memory, per-backend-instance boolean latch** (`fulltextEnsured`), and
interleaved into the read/write data path. That was correct only by accident
(idempotent DDL + a warm process) and at the wrong durability scope; it was
inconsistent with how vector indexes are tracked and it blocked cross-store
transaction adoption (#134). "Is this graph's fulltext storage materialized?"
is now a **durable, queryable database fact** instead of a process boolean.

**Breaking (behavioral): fulltext now requires an explicit boot step.**
`createStore()` is a synchronous, zero-I/O *attach* — it never creates tables,
repairs DDL, or writes materialization markers. The durable marker is written
exclusively by the async boot path, `createStoreWithSchema(graph, backend)`,
which must run once at application startup (outside request handlers and
adopted transactions). A fulltext read/write — or a transaction that touches
fulltext — against a database with no valid marker now throws the new
`StoreNotInitializedError` instead of lazily emitting DDL on the hot path.
Consumers already using `createStoreWithSchema` need no changes; consumers
relying on lazy fulltext creation via bare `createStore()` must add a
`createStoreWithSchema` call at boot.

**What ships:**

- New `@nicia-ai/typegraph` exports: `StoreNotInitializedError` and the
  `StoreNotInitializedReason` (`"missing" | "stale" | "failed"`) it carries in
  `details.reason`.
- New per-deployment table `typegraph_contribution_materializations`, a
  sibling of `typegraph_index_materializations` (the declared-index status
  table is deliberately left unchanged). Keyed by #129 contribution identity
  `(graph_id, logical_name, owner, table_name)`; `signature` is a separate
  content-hash column, so a same-identity row with a drifted signature is a
  loud error, never a silent re-materialize. Failed re-attempts preserve the
  prior success timestamp via the same COALESCE rule as index
  materializations.
- New backend primitives (SQLite + Postgres):
  `ensureContributionMaterializationsTable`, `getContributionMaterialization`,
  `recordContributionMaterialization`, and
  `assertRuntimeContributionsInitialized`. `ensureRuntimeContributions`,
  `ensureContribution`, and `ensureFulltextTable` now take a `graphId` and
  route through the durable-marker writer (short-circuiting when the recorded
  signature already matches). `createStoreWithSchema` records the marker after
  the schema version is resolved, covering the cold-initialize path.
- The six fulltext-touching methods (`upsertFulltext`, `deleteFulltext`,
  `upsertFulltextBatch`, `deleteFulltextBatch`, `fulltextSearch`,
  `hardDeleteNode`) stop ensuring and instead assert the durable marker
  (resolved once per backend instance, cached). The transaction path performs
  zero DDL: the tx-scoped backend's fulltext methods assert the cached marker
  at point of use (a `SELECT`, never `CREATE`), so a transaction that never
  touches fulltext requires no fulltext initialization and one that does runs
  pure DML on the adopted transaction.

This makes #134 (cross-store transaction adoption) sound by construction: a
transaction-adopting primitive consults the durable fact and refuses with a
clear `StoreNotInitializedError` if the store was never initialized, instead
of emitting `CREATE INDEX` inside the caller's business transaction.
