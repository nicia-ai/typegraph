# @nicia-ai/typegraph

## 0.26.0

### Minor Changes

- [#139](https://github.com/nicia-ai/typegraph/pull/139) [`f1ea17c`](https://github.com/nicia-ai/typegraph/commit/f1ea17cafab281d61741b1d2ad0b26a769efaa5a) Thanks [@pdlug](https://github.com/pdlug)! - Cross-store atomicity: share one transaction across the TypeGraph store and an
  external Drizzle connection ([#134](https://github.com/nicia-ai/typegraph/issues/134)).

  Applications that persist into the same database through two layers — Drizzle
  for relational rows and TypeGraph for graph nodes/edges — previously had no way
  to make a write that spans both layers all-or-nothing. `store.transaction()`
  and `db.transaction()` each opened a _separate_ transaction on a _separate_
  connection, so a failure between the two writes left either a stray relational
  row or a committed graph node with a dangling foreign reference.

  **What ships (additive — no breaking changes):**
  - New `Store.withTransaction(externalTx): TransactionContext<G>`. The caller
    owns the transaction; `store.withTransaction(sqlTx)` returns a
    transaction-scoped `{ nodes, edges }` bound to that _exact_ connection, so
    both layers commit or roll back together. It is driver-agnostic; how you
    open the transaction is not.

    Async drivers (node-postgres, `neon-serverless` Pool, libsql):

    ```ts
    await db.transaction(async (sqlTx) => {
      const connector = await createConnectorRow(sqlTx, input); // Drizzle
      const txStore = store.withTransaction(sqlTx);
      await txStore.nodes.ArtifactSource.create({
        // TypeGraph
        connectorId: connector.id,
      });
    }); // one COMMIT / ROLLBACK
    ```

    Synchronous `better-sqlite3` cannot use `db.transaction(async …)` (its
    driver rejects an `async` callback); open the transaction with explicit
    `BEGIN`/`COMMIT`/`ROLLBACK` instead and pass the connection to
    `withTransaction`. See the "Cross-Store Transactions" recipe for both
    shapes.

  - New optional `GraphBackend.adoptTransaction(externalTx)` member, implemented
    by the Drizzle Postgres and SQLite backends, plus the new `AdoptedTransaction`
    type.

  **Guarantees.** The adopted context reuses the parent store's already-resolved
  schema: it runs no `createStoreWithSchema` / `evolve` / `migrateSchema` and
  emits **no DDL inside the caller's business transaction**. Building on [#135](https://github.com/nicia-ai/typegraph/issues/135),
  fulltext operations assert the durable materialization marker (a cached
  `SELECT`, never DDL) and throw `StoreNotInitializedError` on a
  missing/stale/failed marker rather than migrating mid-transaction — so boot the
  parent store via `createStoreWithSchema` once at startup. When the backend
  cannot provide real rollback (`backend.capabilities.transactions === false`:
  `drizzle-orm/neon-http`, Cloudflare D1, SQLite `transactionMode: "none"`),
  `withTransaction` throws `ConfigurationError` rather than silently degrading —
  a non-atomic fallback is safe for graph-only writes but dangerous for
  cross-store flows, where the caller's relational write _would_ still commit.

- [#142](https://github.com/nicia-ai/typegraph/pull/142) [`02c98a9`](https://github.com/nicia-ai/typegraph/commit/02c98a9933c888fcd732053e8cb47991614d2ec9) Thanks [@pdlug](https://github.com/pdlug)! - Transactional writes for Cloudflare Durable Objects SQLite (`do-sqlite`)
  ([#140](https://github.com/nicia-ai/typegraph/issues/140)).

  A store backed by `drizzle(ctx.storage)` previously fell back to
  non-transactional behavior, so TypeGraph mutations could not be composed
  atomically with a product's own relational ledger tables (e.g.
  `document_versions`, `change_events`) inside a Durable Object.

  **What ships (additive — no breaking changes):**
  - New SQLite `transactionMode: "do-sqlite"`, **auto-detected** for
    `drizzle(ctx.storage)`. Such backends now advertise
    `capabilities.transactions: true`.
  - `store.transaction(async (tx) => …)` and the caller-owned
    `store.withTransaction(db)` shape both work on Durable Objects. TypeGraph
    delegates to the async storage runner `ctx.storage.transaction(async …)`
    (surfaced by Drizzle as `db.$client.transaction`), which rolls back SQL
    writes across `await`. Drizzle's own `db.transaction()` on DO is
    `ctx.storage.transactionSync` and cannot span an `await`, so it is
    deliberately not used. There is no Drizzle transaction handle on DO — the
    storage transaction is ambient on the object — so the tx-scoped backend
    binds the outer `db`.

    ```ts
    await ctx.storage.transaction(async () => {
      const txStore = store.withTransaction(db);
      await txStore.nodes.Document.update(documentId, props);
      await db.insert(documentVersions).values(versionRow);
      await db.insert(changeEvents).values(eventRow);
    }); // one storage-transaction COMMIT / ROLLBACK across both layers
    ```

  - A latent detection bug is fixed: drizzle's Durable Objects session class is
    `SQLiteDOSession` (not the previously-checked `SQLiteDurableObjectSession`),
    so a real `drizzle(ctx.storage)` store was misclassified.
  - New `TransactionContext.sql` — the raw Drizzle handle bound to the same
    transaction — for graph-owned cross-store writes across **all**
    transactional backends (Postgres, libsql, better-sqlite3, do-sqlite):

    ```ts
    await store.transaction(async (tx) => {
      await tx.nodes.Document.update(documentId, props);
      // tx.sql is the AdoptedTransaction union — cast to your concrete
      // Drizzle database type at the call site.
      const sqlTx = tx.sql as NodePgDatabase;
      await sqlTx.insert(documentVersions).values(versionRow);
      await sqlTx.insert(changeEvents).values(eventRow);
    });
    ```

    This is the graph-owned counterpart of `store.withTransaction` (where the
    caller owns the boundary). On Postgres/libsql it is a correctness
    requirement — the outer `db` would write on a different connection and
    escape the transaction. `tx.sql` is `undefined` only on the
    non-transactional fallback. Its static type is the `AdoptedTransaction`
    union; cast to your concrete Drizzle database type at the call site.

  **Guarantees.** Building on [#135](https://github.com/nicia-ai/typegraph/issues/135), no schema/bootstrap/fulltext DDL ever runs
  inside the business transaction: `bootstrapTables` and the durable
  materialization marker run outside any storage transaction, while the
  schema-version commit uses the `do-sqlite` runner (data only). Boot the parent
  store via `createStoreWithSchema` once at object startup.

  **Out of scope.** Cloudflare D1 stays `transactionMode: "none"`:
  `D1Database.batch(...)` is transactional but not an interactive runner. A
  batch-only D1 mode is tracked separately.

- [#138](https://github.com/nicia-ai/typegraph/pull/138) [`bcf1e48`](https://github.com/nicia-ai/typegraph/commit/bcf1e4819754f1839a236d350d70bab9103607ce) Thanks [@pdlug](https://github.com/pdlug)! - Durable, enforced fulltext materialization ([#135](https://github.com/nicia-ai/typegraph/issues/135)).

  Strategy-owned fulltext table/index DDL was materialized lazily, guarded by an
  **in-memory, per-backend-instance boolean latch** (`fulltextEnsured`), and
  interleaved into the read/write data path. That was correct only by accident
  (idempotent DDL + a warm process) and at the wrong durability scope; it was
  inconsistent with how vector indexes are tracked and it blocked cross-store
  transaction adoption ([#134](https://github.com/nicia-ai/typegraph/issues/134)). "Is this graph's fulltext storage materialized?"
  is now a **durable, queryable database fact** instead of a process boolean.

  **Breaking (behavioral): fulltext now requires an explicit boot step.**
  `createStore()` is a synchronous, zero-I/O _attach_ — it never creates tables,
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
    table is deliberately left unchanged). Keyed by [#129](https://github.com/nicia-ai/typegraph/issues/129) contribution identity
    `(graph_id, logical_name, owner, table_name)`; `signature` is a separate
    content-hash column, so a same-identity row with a drifted signature is a
    loud error, never a silent re-materialize. Failed re-attempts preserve the
    prior success timestamp via the same COALESCE rule as index
    materializations.
  - New backend primitives (SQLite + Postgres):
    `ensureContributionMaterializationsTable`, `getContributionMaterialization`,
    `recordContributionMaterialization`, and
    `assertRuntimeContributionsInitialized`. `ensureRuntimeContributions`
    and `ensureFulltextTable` now take a `graphId` and
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

  This makes [#134](https://github.com/nicia-ai/typegraph/issues/134) (cross-store transaction adoption) sound by construction: a
  transaction-adopting primitive consults the durable fact and refuses with a
  clear `StoreNotInitializedError` if the store was never initialized, instead
  of emitting `CREATE INDEX` inside the caller's business transaction.

- [#136](https://github.com/nicia-ai/typegraph/pull/136) [`9aa2d31`](https://github.com/nicia-ai/typegraph/commit/9aa2d31b8beddbf8f0dea08c4d9435ab3255b580) Thanks [@pdlug](https://github.com/pdlug)! - Unified `TableContribution` contract for strategy-owned tables ([#129](https://github.com/nicia-ai/typegraph/issues/129)).

  "What tables does TypeGraph own?" was previously split across four
  uncoordinated surfaces (Drizzle named exports, tables-factory
  recursion, strategy raw DDL, per-table `ensureXTable` methods). Adding
  a new strategy- or backend-owned table without also wiring an
  `ensureXTable` + bootstrap probe re-opened the gap [#128](https://github.com/nicia-ai/typegraph/issues/128) closed. This
  refactor routes every owned table through one shape.

  **Breaking (custom `FulltextStrategy` implementers only):**
  `FulltextStrategy.generateDdl(tableName): string[]` is replaced by
  `ownedTables(primaryTableName): readonly StrategyTableContribution[]`.
  A strategy now _declares_ its tables, Drizzle-free, as already
  authoritative contributions (`logicalName`, `owner`, resolved
  `tableName`, idempotent `createDdl` for the table **and its supporting
  indexes**, `runtimeEnsure`). The two shipped strategies
  (`tsvectorStrategy`, `fts5Strategy`) and all internal callers are
  migrated; consumers using only the shipped strategies need no changes.

  **What ships:**
  - New `@nicia-ai/typegraph` export: `TableContribution` and
    `StrategyTableContribution` (its strategy-declaration alias). Each
    contribution carries a stable, deployment-independent `logicalName`
    plus the resolved physical `tableName` (distinct identity vs.
    drift-signature inputs) — the prerequisite that lets [#135](https://github.com/nicia-ai/typegraph/issues/135) make
    fulltext materialization a durable, decidable fact instead of an
    in-memory per-backend latch.
  - `postgresContributions()` / `sqliteContributions()` are the single
    source of truth for DDL generation and the bootstrap ensure.
    `generatePostgresDDL` / `generateSqliteDDL` iterate contributions;
    the `table === tables.fulltext` reference-identity hack is gone from
    DDL generation. drizzle-kit visibility for the default Postgres
    strategy comes from the schema barrel exporting the matching
    `tables.fulltext` object (one object, not two); a non-default
    strategy exports its own.
  - New backend method `ensureRuntimeContributions()`, which runs each
    `runtimeEnsure` contribution's full idempotent `createDdl` (table +
    supporting indexes) so a partial state (table present, index
    missing) self-heals — not a probe-and-skip.
    `loadActiveSchemaWithBootstrap` calls it scoped to `runtimeEnsure`
    contributions only (the strategy-owned fulltext table today), so
    startup does not regress into broad DDL/probing across every table.
    `ensureFulltextTable` is retained as a thin back-compat wrapper.

  DDL statement ordering changes from "all CREATE TABLE, then all CREATE
  INDEX, then fulltext" to per-contribution "table then its own
  indexes". Safe because TypeGraph's tables carry no cross-table foreign
  keys; raw migration SQL byte output differs accordingly.

  Prerequisite for [#135](https://github.com/nicia-ai/typegraph/issues/135) (durable fulltext materialization), which is in
  turn the prerequisite for [#134](https://github.com/nicia-ai/typegraph/issues/134) (cross-store transaction adoption).

## 0.25.1

### Patch Changes

- [#130](https://github.com/nicia-ai/typegraph/pull/130) [`dbe52dc`](https://github.com/nicia-ai/typegraph/commit/dbe52dc5d1346543b5aab5b4380df85bdbf66750) Thanks [@pdlug](https://github.com/pdlug)! - Fix drizzle-kit-managed fulltext bootstrap gap on both Postgres and SQLite ([#128](https://github.com/nicia-ai/typegraph/issues/128)).

  Consumers managing typegraph storage via `drizzle-kit push` /
  `drizzle-kit generate` (`export * from "@nicia-ai/typegraph/postgres"`
  or `…/sqlite"`) got every typegraph table EXCEPT
  `typegraph_node_fulltext`. The fulltext table was strategy-owned raw
  DDL — the schema modules exposed only `fulltextTableName: string`,
  not a Drizzle table — so drizzle-kit silently skipped it. The
  `bootstrapTables` fallback in `loadActiveSchemaWithBootstrap` only
  fires on a missing-table error from `getActiveSchema`; once
  drizzle-kit had created `typegraph_schema_versions`, that branch
  stopped triggering and `searchable()` writes failed at runtime with
  `relation/table "typegraph_node_fulltext" does not exist`.

  Two fixes ship together:
  - **`backend.ensureFulltextTable()` (both backends).** A focused
    narrow-ensure that mirrors the existing
    `ensureIndexMaterializationsTable` /
    `ensureKindRemovalsTable` /
    `ensureReconciliationMarkersTable` idiom — single-table
    `CREATE … IF NOT EXISTS`, no Postgres SHARE-lock deadlock under
    concurrent replica startup. The backend wraps every method that
    emits fulltext SQL (`upsertFulltext` / `deleteFulltext` and their
    batch variants, `fulltextSearch`, and `hardDeleteNode` whose
    cascade unconditionally deletes from the fulltext table) to call
    the ensure first. A per-backend latch makes the per-call cost a
    single boolean check after the first invocation, so the wrapping
    is safe on the hot path. `loadActiveSchemaWithBootstrap` also
    calls the ensure as a belt-and-suspenders for the
    `createStoreWithSchema` path. Together these cover both async
    schema-aware boot AND the sync `createStore` path — the bare
    bootstrap-load probe alone would miss the latter. This is the
    canonical fix and the **only** viable one for SQLite (FTS5
    virtual tables aren't drizzle-kit-modelable).
  - **Typed Drizzle pg-core table for `tsvectorStrategy` (Postgres
    only).** `createPostgresTables()` now returns
    `tables.fulltext` — a typed `pgTable` for the default
    `tsvector` + GIN stack — alongside `tables.fulltextTableName`.
    The new `fulltext` named export is included in
    `@nicia-ai/typegraph/postgres`, so `export *` lets drizzle-kit
    generate migrations for the fulltext table the same way it does
    for `nodes`/`edges`/etc. Custom `tsvector`/`regconfig` column
    types are exported alongside the existing `vector` column.

        `generatePostgresDDL` deliberately skips the typed Drizzle table
        (the column-walker can't reproduce the `GENERATED ALWAYS AS (…)

    STORED`clause) and continues to defer to
   `tsvectorStrategy.generateDdl()` for the runtime DDL emit. The
    two paths agree byte-for-byte; a drift sentinel test catches any
    divergence.

        Alternate Postgres fulltext strategies (pg_trgm, ParadeDB,
        pgroonga) still own their own DDL via
        `FulltextStrategy.generateDdl()` and the bootstrap probe runs it.
        Drizzle-kit consumers using a non-default strategy must override
        `tables.fulltext` in their schema barrel with their strategy's
        own table.

  Documented the SQLite FTS5 virtual-table caveat and the new
  Postgres `tables.fulltext` export in
  `apps/docs/src/content/docs/integration.md`.

## 0.25.0

### Minor Changes

0.25.0 is the runtime schema evolution release. It adds graph extensions,
unified index declarations and materialization, dynamic queries over
runtime-declared kinds, runtime access to compiled props schemas, and a safer
transactional schema-version commit path.

#### Highlights

- Graph extensions let applications commit reviewed JSON schema proposals as
  durable TypeGraph schema versions without redeploying application code.
- Compile-time, graph-extension, relational, and vector indexes now share one
  canonical declaration channel and flow through `Store.materializeIndexes()`.
- Dynamic query builder methods let typed queries traverse runtime-declared node
  and edge kinds while still validating kind names, endpoints, and field
  predicates at query-build time.
- `Store` now exposes compiled Zod props schemas for compile-time and
  graph-extension kinds through `getNodePropsSchema`, `getEdgePropsSchema`, and
  their `OrThrow` variants.
- Node and edge definitions now accept JSON-serializable `annotations` for
  consumer-owned metadata such as UI hints, audit policy, and provenance.

#### New APIs

- `defineGraphExtension(input)` and `validateGraphExtension(input, options?)`.
- `Store.evolve`, `Store.deprecateKinds`, `Store.undeprecateKinds`,
  `Store.removeKinds`, `Store.materializeRemovals`, and dynamic collection
  accessors for graph-extension kinds.
- `defineGraph({ indexes })`, `defineNodeIndex`, `defineEdgeIndex`, `andWhere`,
  `orWhere`, `notWhere`, and the `@nicia-ai/typegraph/indexes` subpath for
  advanced index tooling.
- `Store.materializeIndexes(options?)` plus `MaterializeIndexesResult` status
  reporting.
- `embedding(dimensions, options?)` vector index options and exported vector
  index declaration/configuration types.
- `fromDynamic`, `traverseDynamic`, `optionalTraverseDynamic`, and `toDynamic`
  on the query builder.
- `SchemaValidationResult.initialized` and `.migrated` now include
  `committedRow: SchemaVersionRow`.
- `SqlTableNames` now includes `uniques` so cleanup paths can honor custom
  physical table names.

#### Performance and reliability

- Schema commits now use a transactional `commitSchemaVersion` backend primitive
  instead of the old insert-then-activate sequence, fixing the orphan schema-row
  crash window.
- `materializeIndexes` bulk-loads materialization status in one round trip and
  records per-index drift/failure state in `typegraph_index_materializations`.
- `materializeRemovals` records a reconciliation watermark, honors custom table
  names, and cleans secondary embedding/fulltext/unique rows for removed node
  kinds.
- Schema hash and parsed-schema caches avoid repeated serialization, SHA-256,
  and Zod parse work on no-change startup and repeated store creation.
- Graph-extension merge/compile paths share caches and fast paths for idempotent
  or partially overlapping evolves.
- Postgres vector-index drops now run per-metric DDL concurrently.

#### Breaking changes for backend implementers

These changes affect custom `GraphBackend` implementations and advanced index
consumers; ordinary `createStoreWithSchema`, query, and collection callers
should not need code changes.

- `insertSchema` and `setActiveSchema` were removed from `GraphBackend`.
  Implement `commitSchemaVersion` and `setActiveVersion` instead.
- `commitSchemaVersion` and `setActiveVersion` require transactional behavior.
  Non-transactional drivers such as Cloudflare D1, Durable Objects,
  `drizzle-orm/neon-http`, and SQLite backends configured with
  `transactionMode: "none"` refuse these primitives for schema commits.
- `createFulltextIndex` and `dropFulltextIndex` were removed from
  `GraphBackend`; fulltext storage remains owned by the active backend fulltext
  strategy.
- The old `NodeIndex`, `EdgeIndex`, and `TypeGraphIndex` types were removed from
  `@nicia-ai/typegraph/indexes`. Use `NodeIndexDeclaration`,
  `EdgeIndexDeclaration`, or `IndexDeclaration`.
- Custom backends should add the new optional materialization/removal primitives
  when they want first-class support for index status loading, removal
  reconciliation markers, and vector index materialization.

#### Upgrade notes

- Existing deployments with manually managed schemas should add the one-active
  schema-version partial unique index:
  `typegraph_schema_versions_one_active_per_graph_idx` on `(graph_id)` where
  `is_active` is true (`TRUE` on Postgres, `1` on SQLite).
- Manually managed schemas should also sync the generated DDL for the new
  TypeGraph status tables, including `typegraph_index_materializations`,
  `typegraph_kind_removals`, and `typegraph_reconciliation_markers`.
- Run schema migrations from a transactional backend. Edge or HTTP-only
  non-transactional drivers can continue serving normal reads and writes after
  the schema is established.
- Tests that deep-compare the full `SchemaValidationResult` object may need to
  switch to partial matching because `initialized` and `migrated` now include
  `committedRow`.

#### Pull requests

- [#103](https://github.com/nicia-ai/typegraph/pull/103) - Add per-kind
  `annotations`.
- [#106](https://github.com/nicia-ai/typegraph/pull/106) - Add atomic schema
  version commits.
- [#107](https://github.com/nicia-ai/typegraph/pull/107) - Add compile-time
  index declarations to graph definitions and serialized schemas.
- [#112](https://github.com/nicia-ai/typegraph/pull/112) - Add
  `Store.materializeIndexes`.
- [#117](https://github.com/nicia-ai/typegraph/pull/117) - Unify vector indexes
  with the index declaration channel.
- [#118](https://github.com/nicia-ai/typegraph/pull/118) - Add graph
  extensions.
- [#125](https://github.com/nicia-ai/typegraph/pull/125) - Add dynamic query
  traversal methods.
- [#126](https://github.com/nicia-ai/typegraph/pull/126) - Expose runtime Zod
  props schemas.
- [#127](https://github.com/nicia-ai/typegraph/pull/127) - Pre-release cleanup
  and performance pass.

## 0.24.1

### Patch Changes

- [#99](https://github.com/nicia-ai/typegraph/pull/99) [`755df5a`](https://github.com/nicia-ai/typegraph/commit/755df5a8d8114fbc72047f436132bfe105d02823) Thanks [@pdlug](https://github.com/pdlug)! - Internal: dependency bump pass (patch/minor only — TypeScript and `@types/node` held back as separate majors).

  Notable runtime/peer-relevant moves: `nanoid` 5.1.9 → 5.1.11 (only published runtime dep); dev/peer `zod` 4.3.6 → 4.4.3, `@libsql/client` 0.17.2 → 0.17.3.

  Also drops the `export` keyword on 14 types that were never reachable through any public entry point (`src/index.ts`, `./schema`, `./indexes`, `./sqlite`, `./postgres`, etc.) and had no internal importers. These were leaked-internal types surfaced by a sensitivity change in `knip` 6.11. No symbol on the documented API surface changed; consumers importing only via the package's declared `exports` paths are unaffected.

## 0.24.0

### Minor Changes

- [#97](https://github.com/nicia-ai/typegraph/pull/97) [`8747df8`](https://github.com/nicia-ai/typegraph/commit/8747df8c003589f985e86ca654cf796fa5230e34) Thanks [@pdlug](https://github.com/pdlug)! - SQLite: implement `backend.vectorSearch`, unblocking `store.search.hybrid()` on SQLite.

  The hybrid retrieval facade has been Postgres-only since [#88](https://github.com/nicia-ai/typegraph/issues/88): SQLite shipped fulltext (`fulltextSearch`) and embedding persistence (`upsertEmbedding` / `deleteEmbedding`), but never the `vectorSearch` method that `executeHybridSearch` requires for RRF fusion. `.similarTo()` on SQLite still worked because the predicate path goes through the query compiler, not the backend facade — but anyone reaching for `store.search.hybrid()` on SQLite hit `ConfigurationError: Backend does not support vector search`.

  This release wires up the SQLite half of that contract:
  - `buildVectorSearchSqlite` issues `vec_distance_cosine` / `vec_distance_l2` against the embeddings BLOB column, mirroring the Postgres SQL shape (same WHERE / ORDER BY / score expression / minScore semantics).
  - `createSqliteBackend` exposes `vectorSearch` on the backend object whenever `hasVectorEmbeddings` is true (parallel to the existing `upsertEmbedding` gate).
  - `inner_product` is rejected — sqlite-vec has no `vec_distance_ip` function.

  ```typescript
  import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";

  const { backend } = createLocalSqliteBackend(); // sqlite-vec auto-loaded
  const store = createStore(graph, backend);

  const ranked = await store.search.hybrid("Document", {
    limit: 10,
    vector: { fieldPath: "embedding", queryEmbedding },
    fulltext: { query: "climate adaptation" },
  });
  ```

  **Performance.** On the standard search-shapes bench (500 docs, 384-dim), SQLite hybrid clocks in at **0.8ms** — about 3× faster than PostgreSQL's 2.5ms on the same shape. The bench harness now measures it on both backends; the previously-blank SQLite cell in the search comparison table is filled in.

## 0.23.0

### Minor Changes

- [#95](https://github.com/nicia-ai/typegraph/pull/95) [`6f3bf30`](https://github.com/nicia-ai/typegraph/commit/6f3bf30b4ac7c51a5528e1001dc97e05146801b7) Thanks [@pdlug](https://github.com/pdlug)! - PostgreSQL: official postgres-js / Neon support, server-side prepared statements on the fast path, and a `refreshStatistics()` API.

  **Four drivers supported.** `createPostgresBackend` has always been driver-agnostic, but only `node-postgres` was covered in CI. This release adds:
  - **`drizzle-orm/postgres-js`** — full adapter + integration suite coverage (~250 tests run against both `pg` and `postgres-js` against a real PostgreSQL).
  - **`drizzle-orm/neon-serverless`** — `@neondatabase/serverless` Pool over WebSockets. Wiring smoke tests verify driver detection, fast-path routing, Date→string normalization, and capability surface; the shared code paths are exercised by the `pg` integration suite since this driver is pg-Pool-protocol-compatible.
  - **`drizzle-orm/neon-http`** — `@neondatabase/serverless` `neon(url)` over HTTP. Auto-detected so `capabilities.transactions` is set to `false` (HTTP can't hold a session); single-statement reads, writes, and migrations work normally. Smoke tests verify the detection and capability override.

  Same `createPostgresBackend(db)` entry point regardless of driver.

  ```typescript
  // postgres-js
  import postgres from "postgres";
  import { drizzle } from "drizzle-orm/postgres-js";
  const backend = createPostgresBackend(
    drizzle(postgres(process.env.DATABASE_URL)),
  );

  // Neon serverless (edge runtimes)
  import { Pool } from "@neondatabase/serverless";
  import { drizzle } from "drizzle-orm/neon-serverless";
  const backend = createPostgresBackend(
    drizzle(new Pool({ connectionString: env.NEON_DATABASE_URL })),
  );
  ```

  **On Neon HTTP vs WebSockets:** both work. The HTTP driver (`drizzle-orm/neon-http`) is best for stateless edge workloads — TypeGraph auto-disables transactions since HTTP can't hold a session, and `store.transaction(...)` falls through to non-transactional sequential execution. Use the WebSocket driver (`drizzle-orm/neon-serverless`) when you need atomic multi-statement writes.

  **~6× faster on multi-hop traversals via server-side prepared statements.** The execution adapter now uses `node-postgres`'s named prepared statements transparently — each unique compiled SQL string gets a stable counter-derived statement name (cached by SQL text), so PostgreSQL caches the plan after first execution. Combined with routing `execute()` through the fast path directly (skipping Drizzle's session wrapper), this drops the 3-hop benchmark from ~7.5ms to ~0.8ms median, putting TypeGraph-on-PostgreSQL at parity with Neo4j on every single-query and multi-hop shape we measure.

  The change is invisible to callers; existing code keeps working. postgres-js is unchanged (it handles its own preparation internally).

  **New `store.refreshStatistics()` / `backend.refreshStatistics()` API.** Call once after a large initial import or bulk backfill. Without fresh stats, the planner can pick suboptimal execution plans — on PostgreSQL this is the difference between a 0.5ms and 5ms forward traversal; on SQLite it's the difference between 0.9ms and 23ms fulltext search. Autovacuum / background statistics catch up eventually, but explicit invocation gives correct latencies immediately.

  ```typescript
  for (const batch of batches) {
    await store.nodes.Document.bulkCreate(batch);
  }
  await store.refreshStatistics();
  ```

  Implementations: SQLite runs `ANALYZE`; PostgreSQL runs `ANALYZE` on TypeGraph-managed tables only. Costs ~20ms on SQLite, ~80ms on PostgreSQL at the sizes this library is designed for.

  **Type surface changes:**
  - `GraphBackend` now requires a `refreshStatistics(): Promise<void>` method. `TransactionBackend` still excludes it (statistics refresh isn't meaningful inside a transaction). External `GraphBackend` implementations (uncommon) need to add a no-op or proper implementation.
  - `PostgresBackendOptions` adds an optional `capabilities?: Partial<BackendCapabilities>` for users who need to override capability flags (e.g., for custom HTTP-style drivers).
  - `PostgresBackendOptions` also adds `prepareStatements?: boolean` (default `true`) and `preparedStatementCacheMax?: number` (default `256`). The prepared-statement name cache is now LRU-bounded so high-cardinality SQL text doesn't grow unbounded in either the Node process or in PostgreSQL's per-session prepared-statement memory. Set `prepareStatements: false` when pooling through pgbouncer in transaction-pool mode.

  See [`backend-setup`](https://typegraph.dev/backend-setup#choosing-a-postgresql-driver) for the runtime-to-driver matrix, per-driver setup snippets, and post-bulk-load guidance.

## 0.22.0

### Minor Changes

- [#93](https://github.com/nicia-ai/typegraph/pull/93) [`1e9ae18`](https://github.com/nicia-ai/typegraph/commit/1e9ae18c0219c8168f0584b65b41a9ec2c564b60) Thanks [@pdlug](https://github.com/pdlug)! - Add `countEdges(edgeAlias)` and `countDistinctEdges(edgeAlias)` — edge-count aggregators that skip the target-node join in the count aggregate fast path.

  The default `count(targetAlias)` counts edges whose target node is currently live under the query's temporal mode, which requires joining the edges to the target node table on every aggregation. For the common "how many follow relationships does this user have?" question, that join is unnecessary work: you want to count edges, not reach through each edge to validate the target.

  ```typescript
  import { count, countEdges, field } from "@nicia-ai/typegraph";

  const result = await store
    .query()
    .from("User", "u")
    .optionalTraverse("follows", "e", { expand: "none" })
    .to("User", "target")
    .groupByNode("u")
    .aggregate({
      name: field("u", "name"),
      // Counts live edges, regardless of target-node validity.
      // Skips the typegraph_nodes join entirely — ~1.7x faster on
      // SQLite, ~1.35x on PostgreSQL at benchmark scale.
      followCount: countEdges("e"),
      // Counts edges to live targets. Keeps the target-node join
      // so the target's temporal window is honored.
      liveFollowCount: count("target"),
    })
    .execute();
  ```

  **When to use which:**
  - `count(targetAlias)` — when the semantic question is "how many of this user's follows point to a live user?" The target-node join enforces the target's `validTo` / `deleted_at` filters.
  - `countEdges(edgeAlias)` — when the semantic question is "how many follow relationships does this user have?" The edge's own temporal and deletion filters are enforced; target validity is not consulted.
  - `countDistinctEdges(edgeAlias)` — same semantics as `countEdges` but with `COUNT(DISTINCT ...)`. Useful under ontology-driven expansions where the same edge can appear multiple times in join output.

  The two can be mixed in one aggregate. When present together, the compiler keeps the target-node join but switches it to a `LEFT JOIN` with node-side filters pushed into the `ON` clause so edge counts reflect all live edges while node counts only reflect edges to live targets.

  No change to existing `count(...)` behavior. This is purely additive — code that currently uses `count("targetAlias")` continues to count live targets exactly as before.

### Patch Changes

- [#93](https://github.com/nicia-ai/typegraph/pull/93) [`1e9ae18`](https://github.com/nicia-ai/typegraph/commit/1e9ae18c0219c8168f0584b65b41a9ec2c564b60) Thanks [@pdlug](https://github.com/pdlug)! - Push `LIMIT` past `GROUP BY` in the count aggregate fast path when it's safe.

  When `groupByNode(...).aggregate({ x: count(alias) })` is paired with an optional traversal and a `.limit(n)` that doesn't depend on the aggregate (no `ORDER BY`, or an `ORDER BY` restricted to group keys), the compiler now emits the `LIMIT` inside the start CTE. The `GROUP BY` runs over `n` rows instead of the full start set — `O(limit)` grouping work instead of `O(|start|)`. When `OFFSET` is also set, it rides along with the `LIMIT` into the start CTE and the outer `SELECT` drops its own `LIMIT`/`OFFSET` so neither clause is double-applied.

  The fast path also picks `INNER JOIN` over `LEFT JOIN` for the target-node join whenever a `whereNode()` predicate applies to the target alias, so those predicates constrain every aggregate — including `countEdges(...)`. `LEFT JOIN` remains the strategy when only temporal/delete filters apply to the target, so `countEdges` and `count(target)` can coexist in one query with divergent semantics.

  No change to query semantics — aggregate counts still reflect the same `count(target)` as before, including the target node's temporal and deletion filters. No change to aggregate queries without a `LIMIT`. No change on SQLite or PostgreSQL query shapes outside the fast path.

  Measured impact: scopes down group-by work for "top-N by count"-style aggregate queries. No impact on the blog-post benchmark's full-graph aggregate (which measures the ungrouped 1,200-user case and intentionally runs without a `LIMIT`).

- [#93](https://github.com/nicia-ai/typegraph/pull/93) [`1e9ae18`](https://github.com/nicia-ai/typegraph/commit/1e9ae18c0219c8168f0584b65b41a9ec2c564b60) Thanks [@pdlug](https://github.com/pdlug)! - Fix `generateSqliteDDL` and `generatePostgresMigrationSQL` emitting `(unknown, unknown, ...)` for indexes threaded through `createSqliteTables({}, { indexes })` or `createPostgresTables({}, { indexes })`.

  The DDL generator's SQL-chunk flattener didn't handle two cases that appear inside index expression keys: Drizzle column references nested inside a SQL stream (whose `.getSQL()` wraps the column back inside a self-referential SQL object, causing the previous logic to recurse and fall through to `"unknown"`), and `StringChunk` values stored as single-element arrays (`[""]`).

  Expression indexes now emit correctly in both dialects, e.g.

  ```sql
  CREATE INDEX IF NOT EXISTS "idx_tg_node_user_city_cov_name_…" ON "typegraph_nodes"
    ("graph_id", "kind", (json_extract("props", '$."city"')), (json_extract("props", '$."name"')));
  ```

  Added a regression test in `tests/indexes.test.ts` asserting that DDL from `createSqliteTables`/`createPostgresTables` never contains `(unknown` and includes the expected column and `json_extract` / `ARRAY['…']` expressions.

- [#93](https://github.com/nicia-ai/typegraph/pull/93) [`1e9ae18`](https://github.com/nicia-ai/typegraph/commit/1e9ae18c0219c8168f0584b65b41a9ec2c564b60) Thanks [@pdlug](https://github.com/pdlug)! - Emit `NOT MATERIALIZED` on PostgreSQL traversal and start CTEs so the planner can inline them and see their inner row statistics.

  PostgreSQL defaults to materializing any CTE referenced more than once. TypeGraph's traversal compilation references each CTE twice — once from the next hop's join, once from the final SELECT — which triggers materialization under the default rules. Materialized CTEs have opaque statistics to the planner, causing poor join orderings and wildly off row estimates on multi-hop queries over larger graphs.

  Introduces a `emitNotMaterializedHint` dialect capability (`true` for PostgreSQL, `false` for SQLite, which ignores the hint entirely) and threads it through the start-CTE and traversal-CTE emitters. The hint matches what an expert would write by hand for the same query shape.

  Impact on the TypeGraph benchmark suite:
  - Multi-hop traversal plans no longer carry opaque materializations, so the planner picks index-scan orderings appropriate to the starting row's selectivity.
  - No visible change on SQLite (the hint is not emitted).
  - Guards against regressions on larger graphs where materialized CTE plans degenerate into cross-product-plus-filter.

- [#93](https://github.com/nicia-ai/typegraph/pull/93) [`1e9ae18`](https://github.com/nicia-ai/typegraph/commit/1e9ae18c0219c8168f0584b65b41a9ec2c564b60) Thanks [@pdlug](https://github.com/pdlug)! - Persist vector embeddings on the SQLite backend when sqlite-vec is loaded.

  Previously, `store.nodes.X.create({ ..., embedding: [...] })` on SQLite validated the embedding and inserted the node, but the embedding itself was silently dropped — the SQLite backend didn't implement `upsertEmbedding`/`deleteEmbedding`, so the store's embedding-sync path quietly no-op'd. Vector predicates like `d.embedding.similarTo(q, 20, { metric: "cosine" })` then ran against an empty `typegraph_node_embeddings` table and returned zero rows without error.

  This release wires up both methods on the SQLite backend. They encode embeddings to `vec_f32('[...]')` BLOBs on write and rely on sqlite-vec at query time — same storage shape the existing `.similarTo()` compilation already targets. Activation is opt-in via a new `hasVectorEmbeddings` option on `createSqliteBackend` so callers that haven't loaded sqlite-vec don't hit `no such function: vec_f32` at write time. `createLocalSqliteBackend` best-effort-loads sqlite-vec at startup and flips the option automatically, so the common local setup works without configuration.

  ```typescript
  // Local backend: sqlite-vec is loaded automatically when installed.
  const { backend } = createLocalSqliteBackend();

  // BYO drizzle connection: pass hasVectorEmbeddings after loading sqlite-vec.
  import sqliteVec from "sqlite-vec";
  sqliteVec.load(sqlite);
  const backend = createSqliteBackend(drizzle(sqlite), {
    tables,
    hasVectorEmbeddings: true,
  });
  ```

  `getEmbedding` and the hybrid-search facade (`store.search.hybrid(...)`) remain PostgreSQL-only — decoding the raw BLOB back to `number[]` via `vec_to_json` and exposing a hybrid-search backend method are tracked separately.

## 0.21.0

### Minor Changes

- [#88](https://github.com/nicia-ai/typegraph/pull/88) [`6f681d5`](https://github.com/nicia-ai/typegraph/commit/6f681d59f16ef7d7651627999cce6cada01d024e) Thanks [@pdlug](https://github.com/pdlug)! - Add fulltext search and hybrid (vector + fulltext) retrieval. Declare `searchable()` string fields on any node schema and TypeGraph keeps a native FTS index in sync — `tsvector` + GIN on PostgreSQL, FTS5 on SQLite. Query it through a node-level `n.$fulltext.matches()` predicate that composes with metadata filters, graph traversal, and vector similarity in one SQL statement.

  ```typescript
  import { defineNode, searchable, embedding } from "@nicia-ai/typegraph";

  const Document = defineNode("Document", {
    schema: z.object({
      title: searchable({ language: "english" }),
      body: searchable({ language: "english" }),
      tenantId: z.string(),
      embedding: embedding(1536),
    }),
  });

  // Fulltext + metadata filter in a single query
  const results = await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) =>
      d.$fulltext.matches("climate change", 20).and(d.tenantId.eq(tenant)),
    )
    .select((ctx) => ctx.d)
    .execute();

  // Hybrid: vector + fulltext fused with Reciprocal Rank Fusion at the SQL layer
  const hybrid = await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) =>
      d.$fulltext
        .matches("climate", 50)
        .and(d.embedding.similarTo(queryVector, 50))
        .and(d.tenantId.eq(tenant)),
    )
    .select((ctx) => ctx.d)
    .limit(10)
    .execute();

  // Store-level helper with tunable RRF weights and snippets
  const tuned = await store.search.hybrid("Document", {
    limit: 10,
    vector: { fieldPath: "embedding", queryEmbedding: queryVector },
    fulltext: { query: "climate change", includeSnippets: true },
    fusion: { method: "rrf", k: 60, weights: { vector: 1, fulltext: 1.5 } },
  });
  ```

  Query modes cover `websearch` (Google-style syntax — default), `phrase`, `plain`, and `raw` (dialect-native tsquery / FTS5 MATCH). Highlighting via `ts_headline` / `snippet()` is opt-in per query. No extensions required: Postgres uses the built-in `tsvector` + GIN (works on every managed provider); SQLite uses FTS5 which is statically linked into the standard `better-sqlite3` / `libsql` / `bun:sqlite` distributions. See `/fulltext-search` for the full guide.

  ### Added
  - `n.$fulltext` — node-level fulltext accessor; `.matches(query, k?, options?)` composes against the combined `searchable()` content. `$fulltext` is exposed on every `NodeAccessor`; a runtime guard throws a clear error if the node kind has no `searchable()` fields. `k` defaults to 50.
  - `store.search` facade — `store.search.fulltext()`, `store.search.hybrid()`, and `store.search.rebuildFulltext()` grouped under one namespace. Lazy-initialized and cached on first access.
  - `FulltextSearchHit`, `VectorSearchHit`, and `HybridSearchHit` are generic over the node type (`FulltextSearchHit<N = Node>`). `store.search.fulltext("Document", ...)` returns hits with `hit.node` narrowed to the Document node shape — no cast required.
  - `backend.upsertFulltextBatch` + `backend.deleteFulltextBatch` — symmetric batched fulltext primitives. Homogeneous batch shape, duplicate-nodeId dedupe last-write-wins, per-row fallback when unset.
  - `store.search.rebuildFulltext(nodeKind?, { pageSize?, maxSkippedIds? })` — rebuilds the fulltext index from existing node data using keyset pagination on `id` (stable under shared timestamps and light concurrent writes). Transacts per page; cleans stale rows for soft-deleted nodes; validates `pageSize` as a positive integer; counts corrupt / non-object props as `skipped` and surfaces offending IDs via `skippedIds` without aborting. `maxSkippedIds` (default 10,000) lets operators investigating systemic corruption collect the full list. Concurrent hard-deletes between pages may be missed — document as maintenance operation.
  - Keyset pagination on `findNodesByKind` via new `{ orderBy, after }` params.
  - `QueryBuilder.fuseWith({ k?, weights? })` — tunable RRF on the query-builder path. Flat `HybridFusionOptions` shape, identical to `store.search.hybrid`'s `fusion` option. Throws at compile time if the query lacks either a `.similarTo()` or `n.$fulltext.matches()`. Shares its validator with `store.search.hybrid({ fusion })` so `method`, `k`, and per-source weights are checked identically on both paths.
  - `FulltextStrategy` — pluggable abstraction (exported from the top-level entry) that owns the **entire** SQL pipeline for a dialect's fulltext support: DDL, upsert (single + batch), delete (single + batch), MATCH condition, rank expression, and snippet expression. Ships `tsvectorStrategy` (Postgres built-in `tsvector`) and `fts5Strategy` (SQLite FTS5); dialect adapters expose `fulltext: FulltextStrategy | undefined`. Alternate Postgres stacks (pg_trgm, ParadeDB / pg_search, pgroonga) choose their own column layout, index type, and projection — TypeGraph's operation layer just delegates to the active strategy. Strategies declare prefix-query support explicitly via `FulltextStrategy.supportsPrefix`, so capability discovery stays correct for strategies that support prefix matching via dedicated syntax without advertising raw-mode pass-through.
  - Backend-level fulltext strategy override: `createPostgresBackend(db, { fulltext })` and `createSqliteBackend(db, { fulltext })` accept a `FulltextStrategy` that takes precedence over the dialect default. Threaded through to compiler passes, backend-direct search SQL, all write SQL, DDL generation, and capability discovery — so a ParadeDB-backed Postgres `store.search.hybrid()` fuses the same way a tsvector-backed one does, without any call-site changes.
  - Option validation: `store.search.fulltext` and `store.search.hybrid` validate caller options against the active `FulltextStrategy` (falling back to `BackendCapabilities.fulltext.{phraseQueries, highlighting, languages}` when no strategy is attached). A `mode` outside `strategy.supportedModes` throws, `includeSnippets: true` on a strategy whose `supportsSnippets` is false throws, and a per-query `language` override on a strategy whose `supportsLanguageOverride` is false (e.g. SQLite FTS5) throws. Advisory warning for unknown languages on strategies that honor overrides. `$fulltext.matches()` is validated against the dialect strategy's `supportedModes` at compile time.
  - One-time `console.warn` when a node kind has multiple `searchable()` fields with conflicting `language` values. The first field's language wins on the stored row; the warning makes the silent collapse visible so users know to split multilingual content across dedicated node kinds.
  - Snippet highlighting uses `<mark>…</mark>` consistently across both shipped strategies (`ts_headline` on Postgres, `snippet()` on SQLite). One stylesheet applies everywhere.
  - `FulltextSearchResult.score` is always `number`. The Postgres adapter coerces `numeric`-as-string driver returns at the backend boundary so downstream code never sees a union type.
  - Hybrid SQL emitter uses a deterministic `COALESCE(fulltext.node_id, embeddings.node_id) ASC` tiebreak, matching the JS-side `localeCompare(nodeId)` tiebreak used by `store.search.hybrid` — both hybrid paths produce identical top-k under RRF score ties.
  - Postgres fulltext table schema: `language` is `regconfig` (not `TEXT`) and `tsv` is a `GENERATED ALWAYS AS (to_tsvector("language", "content")) STORED` column. Postgres owns the `content / language → tsv` invariant; the strategy's write SQL doesn't recompute `tsv` inline. The `content` column is populated verbatim, and the per-query `language` override path still accepts a text parameter (cast to `regconfig` at query time). SQLite's FTS5 virtual table is unchanged.

  ### Changed
  - **`defineNode()` / `defineEdge()` reject `$`-prefixed property names.** The `$` namespace is reserved for node-level accessors (starting with `$fulltext`). A `ConfigurationError` is raised at graph-definition time instead of silently shadowing user fields at query time. Rename any such fields before upgrading.
  - **`findNodesByKind` offset pagination now has a deterministic tiebreaker** (`ORDER BY created_at DESC, id DESC`). Row order was previously under-specified when `created_at` values collided; callers that happened to rely on an implementation-dependent order may see different tie-breaking.

## 0.20.0

### Minor Changes

- [#85](https://github.com/nicia-ai/typegraph/pull/85) [`12055d0`](https://github.com/nicia-ai/typegraph/commit/12055d053b22cfadd1439c9a667307fae77af6a2) Thanks [@pdlug](https://github.com/pdlug)! - Add Tier 1 graph algorithms on `store.algorithms.*`: `shortestPath`, `reachable`, `canReach`, `neighbors`, and `degree`.

  ```typescript
  // Find the shortest path through a set of edge kinds
  const path = await store.algorithms.shortestPath(alice, bob, {
    edges: ["knows"],
    maxHops: 6,
  });

  // Enumerate reachable nodes within a depth bound
  const reachable = await store.algorithms.reachable(alice, {
    edges: ["knows"],
    maxHops: 3,
  });

  // Fast existence check
  const connected = await store.algorithms.canReach(alice, bob, {
    edges: ["knows"],
  });

  // k-hop neighborhood (source always excluded)
  const twoHop = await store.algorithms.neighbors(alice, {
    edges: ["knows"],
    depth: 2,
  });

  // Count incident edges
  const total = await store.algorithms.degree(alice, { edges: ["knows"] });
  ```

  All traversal algorithms compile to a single recursive-CTE query and share the dialect primitives used by `.recursive()` and `store.subgraph()`, so SQLite and PostgreSQL yield identical semantics. Node arguments accept either a raw ID string or any object with an `id` field — `Node`, `NodeRef`, and the lightweight records returned by the algorithms themselves all work. See `/graph-algorithms` for the full reference.

- [#85](https://github.com/nicia-ai/typegraph/pull/85) [`12055d0`](https://github.com/nicia-ai/typegraph/commit/12055d053b22cfadd1439c9a667307fae77af6a2) Thanks [@pdlug](https://github.com/pdlug)! - Graph algorithms (`store.algorithms.*`) and `store.subgraph()` now honor the store's temporal model.

  **New:** Every algorithm and `store.subgraph()` accept `temporalMode` and `asOf` options, matching the shape already used by `store.query()` and collection reads. When neither is supplied, the resolved mode falls back to `graph.defaults.temporalMode` (typically `"current"`).

  ```typescript
  // Snapshot at a point in time
  await store.algorithms.shortestPath(alice, bob, {
    edges: ["knows"],
    temporalMode: "asOf",
    asOf: "2023-01-15T00:00:00Z",
  });

  await store.subgraph(rootId, {
    edges: ["has_task"],
    temporalMode: "includeEnded",
  });
  ```

  The filter applies to both nodes and edges along the traversal, is orthogonal to `cyclePolicy`, and is honored by the shortest-path self-path short-circuit.

  **BREAKING:** `store.subgraph()` previously ignored graph temporal settings and filtered only by `deleted_at IS NULL` (equivalent to `"includeEnded"`). It now defaults to `graph.defaults.temporalMode`. Callers that relied on walking through validity-ended rows must pass `temporalMode: "includeEnded"` explicitly. Soft-delete filtering is unchanged under the default `"current"` mode, so most callers see no difference.

### Patch Changes

- [#87](https://github.com/nicia-ai/typegraph/pull/87) [`f52bba6`](https://github.com/nicia-ai/typegraph/commit/f52bba63befe8111d13d04cfb9659371f7061625) Thanks [@pdlug](https://github.com/pdlug)! - Fix SQLite temporal filter timestamp format in graph algorithms and subgraph.

  `buildReachableCte`, `resolveTemporalFilter`, and `fetchSubgraphEdges` compiled
  temporal filters without passing `dialect.currentTimestamp()`, so on SQLite they
  fell back to raw `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS`). Stored
  `valid_from` / `valid_to` use ISO-8601 (`YYYY-MM-DDTHH:MM:SS.sssZ`), and because
  `T` sorts above space, same-day ISO timestamps compare incorrectly against raw
  `CURRENT_TIMESTAMP`. Under `temporalMode: "current"` this caused
  `reachable` / `canReach` / `neighbors` / `shortestPath` / `degree` and the
  `subgraph` edge hydration to misclassify rows whose `valid_from` or `valid_to`
  fell on today's date, disagreeing with `store.query()` and collection reads.

  All three call sites now inject the dialect-specific current timestamp
  (`strftime('%Y-%m-%dT%H:%M:%fZ','now')` on SQLite, `NOW()` on PostgreSQL),
  matching the query compiler.

## 0.19.0

### Minor Changes

- [#83](https://github.com/nicia-ai/typegraph/pull/83) [`206f464`](https://github.com/nicia-ai/typegraph/commit/206f46467342eee6a060c83e057bbf1befb31c1a) Thanks [@pdlug](https://github.com/pdlug)! - **BREAKING:** `store.subgraph()` now returns an indexed result instead of flat arrays.

  The result shape changes from `{ nodes: Node[], edges: Edge[] }` to:

  ```typescript
  {
    root: Node | undefined;
    nodes: ReadonlyMap<string, Node>;
    adjacency: ReadonlyMap<string, ReadonlyMap<EdgeKind, Edge[]>>;
    reverseAdjacency: ReadonlyMap<string, ReadonlyMap<EdgeKind, Edge[]>>;
  }
  ```

  This eliminates the indexing boilerplate every consumer had to write before traversing the subgraph. Nodes are keyed by ID for O(1) lookup, and edges are organized into forward/reverse adjacency maps keyed by `nodeId → edgeKind`.

  Migration:
  - `result.nodes` is now a `Map` — use `.size` instead of `.length`, `.values()` instead of direct iteration, `.has(id)` / `.get(id)` instead of `.find()`
  - `result.edges` is removed — access edges via `result.adjacency.get(fromId)?.get(edgeKind)` or `result.reverseAdjacency.get(toId)?.get(edgeKind)`
  - `result.root` provides the root node directly (no lookup needed)

## 0.18.0

### Minor Changes

- [#80](https://github.com/nicia-ai/typegraph/pull/80) [`0845fa9`](https://github.com/nicia-ai/typegraph/commit/0845fa92a653ed107057cf350414e13745fff8d8) Thanks [@pdlug](https://github.com/pdlug)! - Add first-class libsql backend at `@nicia-ai/typegraph/sqlite/libsql`

  ### New convenience export

  `createLibsqlBackend(client, options?)` wraps `@libsql/client` with automatic DDL
  execution and correct async execution profile. The caller retains ownership of the
  client, enabling shared-driver setups. Works with local files, in-memory databases,
  and remote Turso URLs.

  ```typescript
  import { createClient } from "@libsql/client";
  import { createLibsqlBackend } from "@nicia-ai/typegraph/sqlite/libsql";

  const client = createClient({ url: "file:app.db" });
  const { backend, db } = await createLibsqlBackend(client);
  const store = createStore(graph, backend);
  ```

  ### Bug fixes for async SQLite drivers
  - **`db.get()` crash on empty results** — switched to `db.all()[0]` to work around
    Drizzle's `normalizeRow` crash when libsql returns no rows
    ([drizzle-team/drizzle-orm#1049](https://github.com/drizzle-team/drizzle-orm/issues/1049))
  - **`instanceof Promise` check fails for Drizzle thenables** — all SQLite exec helpers
    now use unconditional `await` since Drizzle returns `SQLiteRaw` objects that are
    thenable but not `Promise` instances
    ([drizzle-team/drizzle-orm#2275](https://github.com/drizzle-team/drizzle-orm/issues/2275))

  ### Internal improvements
  - Extracted `wrapWithManagedClose()` helper for idempotent backend close with teardown
  - Shared adapter and integration test suites now accept async backend factories
  - libsql backend runs the full shared test suite (214 tests)

## 0.17.0

### Minor Changes

- [#77](https://github.com/nicia-ai/typegraph/pull/77) [`b9fc057`](https://github.com/nicia-ai/typegraph/commit/b9fc057e0dd62bd0f059bb78a20d18d91b1b87be) Thanks [@pdlug](https://github.com/pdlug)! - feat: support orderBy on edge properties in query builder

  The `orderBy` method now accepts edge aliases in addition to node aliases, allowing results to be ordered by properties on traversed edges. This eliminates the need to denormalize ordering fields onto nodes or sort in memory.

  ```typescript
  store
    .query()
    .from("Person", "p")
    .traverse("worksAt", "e")
    .to("Company", "c")
    .orderBy("e", "salary", "asc") // order by edge property
    .select((ctx) => ({ name: ctx.p.name, salary: ctx.e.salary }))
    .execute();
  ```

  Also fixes CTE alias resolution for edge aliases in `groupBy` and vector order-by compilation paths.

  Closes [#76](https://github.com/nicia-ai/typegraph/issues/76)

## 0.16.2

### Patch Changes

- [#73](https://github.com/nicia-ai/typegraph/pull/73) [`1c95d8e`](https://github.com/nicia-ai/typegraph/commit/1c95d8ec641442cecb38e00fab4c6d10eb162c2c) Thanks [@pdlug](https://github.com/pdlug)! - fix: dispose serialized execution queue on backend close to prevent unhandled rejections

  When the SQLite backend's underlying database is destroyed while operations are still queued (e.g., during Cloudflare Workers test teardown), the serialized execution queue now properly disposes pending promises. Calling `backend.close()` signals the queue to suppress errors from in-flight tasks and reject new operations with `BackendDisposedError`.

  Fixes [#72](https://github.com/nicia-ai/typegraph/issues/72)

## 0.16.1

### Patch Changes

- [#70](https://github.com/nicia-ai/typegraph/pull/70) [`cebf681`](https://github.com/nicia-ai/typegraph/commit/cebf681c76820db9d63c29f2eb64ed92b1eb3ad5) Thanks [@pdlug](https://github.com/pdlug)! - Widen ID parameters on `DynamicNodeCollection` and `DynamicEdgeCollection` to accept plain `string` instead of branded `NodeId`/`EdgeId` types, removing the need for casts when using the dynamic collection API with IDs from edge metadata, snapshots, or external input.

## 0.16.0

### Minor Changes

- [#66](https://github.com/nicia-ai/typegraph/pull/66) [`2f241a9`](https://github.com/nicia-ai/typegraph/commit/2f241a98fc6ec78702bcaa609e1fce9b5a1ae4f4) Thanks [@pdlug](https://github.com/pdlug)! - Add `store.getNodeCollection(kind)` and `store.getEdgeCollection(kind)` methods for runtime string-keyed collection access. Returns the full collection API with widened generics (`DynamicNodeCollection` / `DynamicEdgeCollection`), or `undefined` if the kind is not registered. Eliminates the need for `Reflect.get(store.nodes, kind) as SomeType` patterns when iterating kinds, resolving nodes from edge metadata, or building generic graph tooling like snapshots and summaries.

## 0.15.0

### Minor Changes

- [#63](https://github.com/nicia-ai/typegraph/pull/63) [`546a7eb`](https://github.com/nicia-ai/typegraph/commit/546a7eb3693141fa8ad236c9aad3333abf635893) Thanks [@pdlug](https://github.com/pdlug)! - `createStoreWithSchema()` now auto-creates base tables on a fresh database. Previously, calling it against a database without pre-existing TypeGraph tables (e.g. a new Cloudflare Durable Object) would throw a raw "no such table" error. The function now detects missing tables and bootstraps them automatically via the new optional `bootstrapTables` method on `GraphBackend`. Both SQLite and PostgreSQL backends implement this method. `createStore()` remains unchanged for users who manage DDL manually.

- [#64](https://github.com/nicia-ai/typegraph/pull/64) [`6b84b42`](https://github.com/nicia-ai/typegraph/commit/6b84b42bd9e626ca01f48d8a5bd3c18c5bfee80d) Thanks [@pdlug](https://github.com/pdlug)! - Add `StoreProjection<G, N, E>` utility type for typing reusable helpers that work across graphs sharing a common subgraph. The type projects a store's collection surface onto a subset of node and edge keys, with node constraint names erased so that graphs registering the same node types with different unique constraints remain cross-assignable. Both `Store<G>` and `TransactionContext<G>` are structurally assignable to any `StoreProjection` whose keys are a subset of `G`. Also exports `GraphNodeCollections<G>` and `GraphEdgeCollections<G>` shared mapped types.

### Patch Changes

- [#59](https://github.com/nicia-ai/typegraph/pull/59) [`36742a1`](https://github.com/nicia-ai/typegraph/commit/36742a11f47b2e1903c13ce6abce3e72285f0dbf) Thanks [@pdlug](https://github.com/pdlug)! - Reject empty `fields` arrays at the type level in `defineNodeIndex` and `defineEdgeIndex`. Previously, passing `fields: []` was accepted by TypeScript but threw at runtime. The `fields` property now requires a non-empty tuple, surfacing the error at compile time.

- [#60](https://github.com/nicia-ai/typegraph/pull/60) [`dca5aba`](https://github.com/nicia-ai/typegraph/commit/dca5abad98cdb4df0ca546796f89c6470bdcf680) Thanks [@pdlug](https://github.com/pdlug)! - Export `SchemaValidationResult` and `SchemaManagerOptions` types from the root package entry point so users can type the return value of `createStoreWithSchema()` without reaching into internal subpaths.

## 0.14.0

### Minor Changes

- [#54](https://github.com/nicia-ai/typegraph/pull/54) [`bf6997a`](https://github.com/nicia-ai/typegraph/commit/bf6997afd5889556961977f45bdc9c8d38021902) Thanks [@pdlug](https://github.com/pdlug)! - ### Breaking: default recursive traversal depth lowered from 100 to 10

  Unbounded `.recursive()` traversals are now capped at 10 hops instead of 100. Graphs with branching factor _B_ produce O(_B_^depth) rows before cycle detection can prune them — the previous default of 100 made exponential blowup easy to trigger accidentally.

  If your traversals relied on the implicit 100-hop cap, add an explicit `.maxHops(100)` call. The `MAX_EXPLICIT_RECURSIVE_DEPTH` ceiling (1000) is unchanged.

  ### Schema parse validation

  Serialized schema documents read from the database are now validated against a Zod schema at the parse boundary. Malformed, truncated, or incompatible schema documents will throw a `DatabaseOperationError` with path-level detail instead of propagating silently. Enum fields (`temporalMode`, `cardinality`, `deleteBehavior`, etc.) are validated against the known literal unions.

  ### Type safety improvements
  - Added `useUnknownInCatchVariables`, `noFallthroughCasesInSwitch`, and `noImplicitReturns` to tsconfig
  - Drizzle row mappers now use runtime type checks (`asString`/`asNumber`) instead of unsafe `as` casts
  - `NodeMeta` and `EdgeMeta` are now derived from row types via mapped types
  - All non-null assertions (`!`) eliminated from source code
  - Hardcoded constants extracted to shared `constants.ts`
  - Duplicate `fnv1aBase36` function consolidated into `utils/hash.ts`

## 0.13.0

### Minor Changes

- [#52](https://github.com/nicia-ai/typegraph/pull/52) [`1e3da4a`](https://github.com/nicia-ai/typegraph/commit/1e3da4aa814f3baf67a0cb54c9c753508eecf0f0) Thanks [@pdlug](https://github.com/pdlug)! - Add `batchFindFrom`, `batchFindTo`, and `batchFindByEndpoints` to edge collections for use with `store.batch()`.

  Edge collection lookup methods (`findFrom`, `findTo`, `findByEndpoints`) execute immediately and cannot participate in `store.batch()`. The new `batchFind*` variants return a `BatchableQuery` instead, enabling edge lookups to share a single transactional connection alongside fluent queries.

  ```typescript
  const [skills, employer, colleague] = await store.batch(
    store.edges.hasSkill.batchFindFrom(alice),
    store.edges.worksAt.batchFindFrom(alice),
    store.edges.knows.batchFindByEndpoints(alice, bob),
  );
  ```

  - **`batchFindFrom(from)`** — deferred variant of `findFrom`
  - **`batchFindTo(to)`** — deferred variant of `findTo`
  - **`batchFindByEndpoints(from, to, options?)`** — deferred variant of `findByEndpoints`, returns 0-or-1 element array

  All three preserve the same endpoint type constraints as their immediate counterparts.

  Closes [#51](https://github.com/nicia-ai/typegraph/issues/51).

## 0.12.0

### Minor Changes

- [#50](https://github.com/nicia-ai/typegraph/pull/50) [`a59416d`](https://github.com/nicia-ai/typegraph/commit/a59416d8cbc641fd7611ee5d5b0fb115aea59450) Thanks [@pdlug](https://github.com/pdlug)! - Add `store.batch()` for executing multiple queries over a single connection with snapshot consistency.
  - **Single connection**: Acquires one connection via an implicit transaction, eliminating pool pressure from parallel `Promise.all` patterns (N connections → 1).
  - **Snapshot consistency**: All queries see the same database state — no interleaved writes between results.
  - **Typed tuple results**: Returns a mapped tuple preserving each query's independent result type, projection, filtering, sorting, and pagination.
  - **`BatchableQuery` interface**: Satisfied by both `ExecutableQuery` (from `.select()`) and `UnionableQuery` (from set operations like `.union()`, `.intersect()`). Exposes `executeOn()` for backend-delegated execution.
  - **Minimum 2 queries**: Enforced at the type level — single queries should use `.execute()` directly.

  ```typescript
  const [people, companies] = await store.batch(
    store
      .query()
      .from("Person", "p")
      .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name })),
    store
      .query()
      .from("Company", "c")
      .select((ctx) => ({ id: ctx.c.id, name: ctx.c.name }))
      .orderBy("c", "name", "asc")
      .limit(5),
  );
  // people:    readonly { id: string; name: string }[]
  // companies: readonly { id: string; name: string }[]
  ```

  Closes [#47](https://github.com/nicia-ai/typegraph/issues/47).

- [#48](https://github.com/nicia-ai/typegraph/pull/48) [`753d9eb`](https://github.com/nicia-ai/typegraph/commit/753d9ebc6aa02f0f01bc52abc1de255b2d1bbd91) Thanks [@pdlug](https://github.com/pdlug)! - Add field-level projection to `store.subgraph()` via a declarative `project` option.
  - **Declarative field selection**: Specify which properties to keep per node/edge kind. Projected nodes always retain `kind` and `id`; projected edges always retain structural endpoint fields. Kinds omitted from `project` remain fully hydrated.
  - **SQL-level extraction**: Projected property fields are extracted via `json_extract()` / JSONB path expressions directly in the query, avoiding full `props` blob transfer for projected kinds.
  - **All-or-nothing metadata**: Include `"meta"` in the field list for the full metadata object, or omit it entirely. No partial metadata selection — the struct is small enough that subsetting adds complexity without meaningful savings.
  - **`defineSubgraphProject()` helper**: Curried identity function that preserves literal types for reusable projection configs. Without it, storing a projection in a variable widens field arrays to `string[]`, defeating compile-time narrowing.
  - **Type-safe results**: Result types narrow per-kind based on the projection — accessing omitted fields is a compile-time error. Works through both inline literals and `defineSubgraphProject()`.

  ```typescript
  const result = await store.subgraph(rootId, {
    edges: ["has_task", "uses_skill"],
    maxDepth: 2,
    project: {
      nodes: {
        Task: ["title", "meta"],
        Skill: ["name"],
      },
      edges: {
        uses_skill: ["priority"],
      },
    },
  });
  // result.nodes — Task has { kind, id, title, meta }; Skill has { kind, id, name }
  // result.edges — uses_skill has { id, kind, fromKind, fromId, toKind, toId, priority }
  ```

  Closes [#46](https://github.com/nicia-ai/typegraph/issues/46) (alternative implementation — declarative arrays instead of callbacks).

## 0.11.1

### Patch Changes

- [#41](https://github.com/nicia-ai/typegraph/pull/41) [`68d5432`](https://github.com/nicia-ai/typegraph/commit/68d5432f830978bc05f888134ed1a69644ed97b9) Thanks [@pdlug](https://github.com/pdlug)! - Fix `.paginate()` dropping `id` from selective query results and `orderBy()` mishandling system fields.
  - **Fix silent data loss in `.paginate()` + `.select()`**: `FieldAccessTracker.record()` no longer allows a system field (`id`, `kind`) to be downgraded to a props field, which caused the SQL projection to extract from `props->>'id'` (nonexistent) instead of the `id` column.
  - **Fix `orderBy()` for system fields**: `orderBy("alias", "id")` now emits `ORDER BY cte.alias_id` instead of `ORDER BY json_extract(cte.alias_props, '$.id')`.
  - **Add `gt`/`gte`/`lt`/`lte` to `StringFieldAccessor`**: Enables keyset cursor pagination via `whereNode("a", (a) => a.id.lt(cursor))`.

  Fixes [#40](https://github.com/nicia-ai/typegraph/issues/40).

## 0.11.0

### Minor Changes

- [#38](https://github.com/nicia-ai/typegraph/pull/38) [`e26e4a5`](https://github.com/nicia-ai/typegraph/commit/e26e4a5282d9e59ab517a68dede37c38bea2a1e9) Thanks [@pdlug](https://github.com/pdlug)! - Add `createFromRecord()` and `upsertByIdFromRecord()` to `NodeCollection`.

  These methods accept `Record<string, unknown>` instead of `z.input<N["schema"]>`, providing an escape hatch for dynamic-data scenarios (changesets, migrations, imports) where the data shape is determined at runtime. Runtime Zod validation is unchanged — only the compile-time type gate is relaxed. The return type remains fully typed as `Node<N>`.

  Closes [#37](https://github.com/nicia-ai/typegraph/issues/37).

## 0.10.0

### Minor Changes

- [#33](https://github.com/nicia-ai/typegraph/pull/33) [`da14806`](https://github.com/nicia-ai/typegraph/commit/da14806b665418c7761b5db37641b23eb2914304) Thanks [@pdlug](https://github.com/pdlug)! - Add `store.subgraph()` for typed BFS neighborhood extraction from a root node.

  Given a root node ID, traverses specified edge kinds using a recursive CTE and returns all reachable nodes and connecting edges as fully typed discriminated unions.

  **Options:**
  - `edges` — edge kinds to traverse (required)
  - `maxDepth` — maximum traversal depth (default: 10)
  - `direction` — `"out"` (default) or `"both"` for undirected traversal
  - `includeKinds` — filter returned nodes to specific kinds (traversal still follows all reachable nodes)
  - `excludeRoot` — omit the root node from results
  - `cyclePolicy` — cycle detection strategy (default: `"prevent"`)

  **Type utilities exported:**
  - `AnyNode<G>` / `AnyEdge<G>` — discriminated unions of all node/edge runtime types in a graph
  - `SubsetNode<G, K>` / `SubsetEdge<G, K>` — narrowed unions for a subset of kinds
  - `SubgraphOptions<G, EK, NK>` / `SubgraphResult<G, NK, EK>` — fully generic option and result types

- [#35](https://github.com/nicia-ai/typegraph/pull/35) [`0ebc59c`](https://github.com/nicia-ai/typegraph/commit/0ebc59cf1f8d714b0d63c0759d08ed88face022c) Thanks [@pdlug](https://github.com/pdlug)! - Add runtime discriminated union types: `AnyNode<G>`, `AnyEdge<G>`, `SubsetNode<G, K>`, `SubsetEdge<G, K>`.

  These pure type-level utilities produce discriminated unions of runtime node/edge instances from a graph definition. Unlike `AllNodeTypes<G>` (union of type _definitions_), `AnyNode<G>` gives the union of runtime `Node<T>` values — discriminated by `kind` for exhaustive `switch` narrowing. `SubsetNode<G, K>` narrows the union to a specific set of kinds.

## 0.9.2

### Patch Changes

- [#27](https://github.com/nicia-ai/typegraph/pull/27) [`c2f0811`](https://github.com/nicia-ai/typegraph/commit/c2f0811863a61608c16901ce1fc61fdfbc26cb3f) Thanks [@pdlug](https://github.com/pdlug)! - Fix `count(alias, field)` and `countDistinct(alias, field)` ignoring the field argument in SQL compilation.

  Both functions always compiled to `COUNT(alias_id)` / `COUNT(DISTINCT alias_id)` regardless of the field argument, because:
  1. The aggregate emitters in `standard-builders.ts` and `set-operations.ts` hardcoded `_id` for count/countDistinct instead of calling `compileFieldValue()` like sum/avg/min/max do.
  2. `collectRequiredColumnsByAlias` in `standard-pass-pipeline.ts` explicitly skipped marking the field as required for count/countDistinct, so the CTE wouldn't include the `_props` column even if the emitter were fixed.

  Now `count("p", "email")` correctly compiles to `COUNT(json_extract(p_props, '$."email"'))` and `countDistinct("b", "genre")` compiles to `COUNT(DISTINCT json_extract(b_props, '$."genre"'))`.

## 0.9.1

### Patch Changes

- [#24](https://github.com/nicia-ai/typegraph/pull/24) [`733bf8a`](https://github.com/nicia-ai/typegraph/commit/733bf8abfd7b0fa9901a08ff67ce1c9343a2e961) Thanks [@pdlug](https://github.com/pdlug)! - Fix `checkUniqueBatch` exceeding SQL bind parameter limit on SQLite/D1/Durable Objects.

  Bulk constraint operations (`bulkGetOrCreateByConstraint`, `bulkFindByConstraint`) passed all keys in a single `IN (...)` clause. With hundreds of unique keys, this exceeded SQLite's 999 bind parameter limit, causing `SQLITE_ERROR: too many SQL variables`.

  The fix chunks the keys array in `checkUniqueBatch` using the same pattern already used by `getNodes`, `insertNodesBatch`, and other batch operations. SQLite chunks at 996 keys per query (999 max − 3 fixed params), PostgreSQL at 65,532.

## 0.9.0

### Minor Changes

- [#21](https://github.com/nicia-ai/typegraph/pull/21) [`88beee4`](https://github.com/nicia-ai/typegraph/commit/88beee42ce0ecfe2064b0b3889653e889b0c74aa) Thanks [@pdlug](https://github.com/pdlug)! - Add `transactionMode` to SQLite execution profile, fixing Cloudflare Durable Object compatibility.

  `createSqliteBackend` previously used raw `BEGIN`/`COMMIT`/`ROLLBACK` SQL for all sync SQLite drivers. This crashes on Cloudflare Durable Object SQLite (via `drizzle-orm/durable-sqlite`) because the driver does not support raw transaction SQL through `db.run()`.

  The new `transactionMode` option (`"sql"` | `"drizzle"` | `"none"`) controls how transactions are managed:
  - `"sql"` — TypeGraph issues `BEGIN`/`COMMIT`/`ROLLBACK` directly (default for better-sqlite3, bun:sqlite)
  - `"drizzle"` — delegates to Drizzle's `db.transaction()` (default for async drivers)
  - `"none"` — transactions disabled (default for D1 and Durable Objects)

  D1 and Durable Object sessions are auto-detected by Drizzle session name. Users can override via `executionProfile: { transactionMode: "..." }`.

  **Breaking:** `isD1` removed from `SqliteExecutionProfileHints` and `SqliteExecutionProfile`. Use `transactionMode: "none"` instead. `D1_CAPABILITIES` removed — capabilities are now derived from `transactionMode`.

## 0.8.0

### Minor Changes

- [#19](https://github.com/nicia-ai/typegraph/pull/19) [`5b1dec6`](https://github.com/nicia-ai/typegraph/commit/5b1dec64f280a2ec638c69b6fa5a1bc08ba92e88) Thanks [@pdlug](https://github.com/pdlug)! - Support unconstrained edges in `defineGraph`.

  Edges defined without `from`/`to` constraints (e.g., `defineEdge("sameAs")`) can now be passed directly to `defineGraph` without an `EdgeRegistration` wrapper. They are automatically allowed to connect any node type in the graph to any other.
  - **`EdgeEntry` widened** — accepts any `EdgeType`, not just those with endpoints
  - **`NormalizedEdges`** — falls back to all graph node types when `from`/`to` are undefined
  - Constrained edges, `EdgeRegistration` wrappers, and narrowing validation are unchanged

## 0.7.0

### Minor Changes

- [#16](https://github.com/nicia-ai/typegraph/pull/16) [`0a2f08f`](https://github.com/nicia-ai/typegraph/commit/0a2f08fa7d755ee6adb59db4d34a26a3863c0c79) Thanks [@pdlug](https://github.com/pdlug)! - Tighten type safety across store and collection APIs.

  **Breaking:** `TypedNodeRef<N>` has been renamed to `NodeRef<N>` and the old untyped `NodeRef` has been removed. Replace `TypedNodeRef<N>` with `NodeRef<N>` — the type is structurally identical. Unparameterized `NodeRef` (with the new default) covers the old untyped usage.
  - **`EdgeId<E>`** — branded edge ID type, mirroring `NodeId<N>`. Prevents mixing IDs from different edge types at compile time.
  - **`Edge<E, From, To>`** — edge instances now carry endpoint node types. `edge.fromId` is `NodeId<From>`, `edge.toId` is `NodeId<To>`, and `edge.id` is `EdgeId<E>`.
  - **`getNodeKinds` / `getEdgeKinds`** — return `readonly (keyof G["nodes"] & string)[]` instead of `readonly string[]`.
  - **`constraintName` literal unions** — `findByConstraint`, `getOrCreateByConstraint`, and their bulk variants now only accept constraint names that exist on the node registration, catching typos at compile time.

## 0.6.0

### Minor Changes

- [#14](https://github.com/nicia-ai/typegraph/pull/14) [`45624e0`](https://github.com/nicia-ai/typegraph/commit/45624e0ef5caf28c5a7bf8931f0ae96ce542c20d) Thanks [@pdlug](https://github.com/pdlug)! - Restructure SQLite/Postgres entry points to decouple DDL generation from native dependencies.

  **Breaking changes:**
  - `./drizzle`, `./drizzle/sqlite`, `./drizzle/postgres`, `./drizzle/schema/sqlite`, `./drizzle/schema/postgres` entry points are removed. Import backend factories, schema tables/factories, and DDL helpers from `./sqlite` and `./postgres`.
  - `createLocalSqliteBackend` moves from `./sqlite` to `./sqlite/local`. The `./sqlite` entry point no longer depends on `better-sqlite3`.
  - `getSqliteMigrationSQL` is renamed to `generateSqliteMigrationSQL`.
  - `getPostgresMigrationSQL` is renamed to `generatePostgresMigrationSQL`.
  - Individual table type aliases (`NodesTable`, `EdgesTable`, `UniquesTable`, `SchemaVersionsTable`, `EmbeddingsTable`) are removed from both schema modules. Use `SqliteTables["nodes"]` or `PostgresTables["edges"]` instead.

  **Migration guide:**

  | Before                                                                               | After                                                                              |
  | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
  | `import { ... } from "@nicia-ai/typegraph/drizzle/sqlite"`                           | `import { ... } from "@nicia-ai/typegraph/sqlite"`                                 |
  | `import { ... } from "@nicia-ai/typegraph/drizzle/postgres"`                         | `import { ... } from "@nicia-ai/typegraph/postgres"`                               |
  | `import { ... } from "@nicia-ai/typegraph/drizzle/schema/sqlite"`                    | `import { ... } from "@nicia-ai/typegraph/sqlite"`                                 |
  | `import { ... } from "@nicia-ai/typegraph/drizzle/schema/postgres"`                  | `import { ... } from "@nicia-ai/typegraph/postgres"`                               |
  | `import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite"`              | `import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local"`      |
  | `getSqliteMigrationSQL()`                                                            | `generateSqliteMigrationSQL()`                                                     |
  | `getPostgresMigrationSQL()`                                                          | `generatePostgresMigrationSQL()`                                                   |
  | `NodesTable`, `EdgesTable`, `UniquesTable`, `SchemaVersionsTable`, `EmbeddingsTable` | `SqliteTables["nodes"]` / `PostgresTables["nodes"]` (and corresponding table keys) |

## 0.5.0

### Minor Changes

- [#12](https://github.com/nicia-ai/typegraph/pull/12) [`c40b8a4`](https://github.com/nicia-ai/typegraph/commit/c40b8a4c99f5ccddaf1bceea8c927f6aeb0300f4) Thanks [@pdlug](https://github.com/pdlug)! - Add read-only lookup methods and store-level clear for graph data management.

  **New APIs:**
  - `findByConstraint` / `bulkFindByConstraint` — look up nodes by a named uniqueness constraint without creating. Returns `Node<N> | undefined` (or `(Node<N> | undefined)[]` for bulk). Soft-deleted nodes are excluded.
  - `findByEndpoints` — look up an edge by `(from, to)` with optional `matchOn` property fields without creating. Returns `Edge<E> | undefined`. Soft-deleted edges are excluded.
  - `store.clear()` — hard-delete all data for the current graph (nodes, edges, uniques, embeddings, schema versions). Resets collection caches so the store is immediately reusable.

## 0.4.0

### Minor Changes

- [#10](https://github.com/nicia-ai/typegraph/pull/10) [`550eec6`](https://github.com/nicia-ai/typegraph/commit/550eec6bbe34427be9095fe59571b55f75c68792) Thanks [@pdlug](https://github.com/pdlug)! - Add node and edge get-or-create operations with explicit API naming.

  **New APIs:**
  - `getOrCreateByConstraint` / `bulkGetOrCreateByConstraint` — deduplicate nodes by a named uniqueness constraint
  - `getOrCreateByEndpoints` / `bulkGetOrCreateByEndpoints` — deduplicate edges by `(from, to)` with optional `matchOn` property fields
  - `hardDelete` for node and edge collections
  - `action: "created" | "found" | "updated" | "resurrected"` result discriminant

  **Breaking changes:**
  - `upsert` → `upsertById`, `bulkUpsert` → `bulkUpsertById`
  - `onConflict: "skip" | "update"` → `ifExists: "return" | "update"`
  - `ConstraintNotFoundError` → `NodeConstraintNotFoundError`
  - Removed generic `FindOrCreate*` type exports in favor of explicit `NodeGetOrCreateByConstraint*` and `EdgeGetOrCreateByEndpoints*` types

## 0.3.1

### Patch Changes

- [#8](https://github.com/nicia-ai/typegraph/pull/8) [`4732792`](https://github.com/nicia-ai/typegraph/commit/4732792a9ff7ed665f55bb314029c06024f5b62e) Thanks [@pdlug](https://github.com/pdlug)! - Fix `AnyPgDatabase` type to accept standard Drizzle instances created without an explicit schema

## 0.3.0

### Minor Changes

- [#6](https://github.com/nicia-ai/typegraph/pull/6) [`4553aed`](https://github.com/nicia-ai/typegraph/commit/4553aedf3cd7390acb7509e1c321a42bed225f1e) Thanks [@pdlug](https://github.com/pdlug)! - Big performance increases, cleaner APIs, prepared queries, and batch collection
  APIs.

  ### Breaking Changes

  **Renamed APIs:**
  - `selectAggregate()` is now `aggregate()`
  - `EdgeTypeNames` / `NodeTypeNames` are now `EdgeKinds` / `NodeKinds` (including getter functions)

  **Traversal expansion:** `includeImplyingEdges` replaced with `expand` option supporting four modes: `"none"`, `"implying"`, `"inverse"`, and `"all"` (default: `"inverse"`)

  **Recursive traversal:** The chained methods `.maxHops()`, `.minHops()`, `.collectPath()`, and `.withDepth()` are consolidated into a single `recursive()` call with an options object:

  ```ts
  // Before
  .traverse("p", "knows", "friend").recursive().maxHops(5).collectPath()

  // After
  .traverse("p", "knows", "friend").recursive({ maxHops: 5, path: true })
  ```

  New `cyclePolicy: "prevent" | "allow"` option (default: `"prevent"`). Unbounded recursion capped at depth 100; explicit `maxHops` validated up to 1,000.

  **Store:** `Store` class is now a type-only export — use `createStore()`. `StoreConfig` replaced by `StoreOptions`.

  **Moved to `@nicia-ai/typegraph/schema`:** All schema management APIs (`serializeSchema`, `deserializeSchema`, `initializeSchema`, `ensureSchema`, `migrateSchema`, `computeSchemaDiff`, `getMigrationActions`, `isBackwardsCompatible`, and related types) are now imported from the new `@nicia-ai/typegraph/schema` entry point.

  **Removed from main entry:** `KindRegistry`, Result utilities (`ok`/`err`/`isOk`/`isErr`/`unwrap`/`unwrapOr`), date helpers (`encodeDate`/`decodeDate`), validation utilities, and compiler/profiler internals.

  ### New Features

  **Prepared queries** — precompile queries once and execute repeatedly with different bindings at zero recompilation cost:

  ```ts
  const prepared = store
    .query()
    .from("Person", "p")
    .whereNode("p", (p) => p.name.eq(param("name")))
    .select((ctx) => ctx.p)
    .prepare();

  const alice = await prepared.execute({ name: "Alice" });
  const bob = await prepared.execute({ name: "Bob" });
  ```

  **Batch collection APIs:**
  - `getByIds(ids)` — batched lookup preserving input order, returns `undefined` for missing IDs
  - `bulkInsert` — void-returning fire-and-forget ingestion
  - `bulkCreate` — multi-row `INSERT ... RETURNING` instead of per-item inserts
  - `bulkUpsert` (edges) — batch lookup instead of N+1 sequential calls

  **Node `find({ where })`** — filter nodes using the full query predicate system directly from collections.

  ### Performance
  - SQL compiler restructured into plan/passes/emitter pipeline with predicate pre-indexing, column pruning, and single-hop recursive lowering
  - Drizzle backend split into modular operations with dialect-driven strategy dispatch
  - SQLite prepared statement caching with LRU eviction
  - Compilation caching on immutable query builder instances
  - Bind-limit-aware batch chunking (SQLite: 999 params, PostgreSQL: 65,535 params)
  - Benchmark regression guardrails added to CI for both SQLite and PostgreSQL

## 0.2.0

### Minor Changes

- [`bdd5f34`](https://github.com/nicia-ai/typegraph/commit/bdd5f349453b19e9616f00d7591b436195feb925) Thanks [@pdlug](https://github.com/pdlug)! - Improve support for custom table names and use web crypto to support both node and edge runtimes.

## 0.1.1

### Patch Changes

- [`6f16bf9`](https://github.com/nicia-ai/typegraph/commit/6f16bf93ebd0811f386df63b80b8b80a3ee26c2f) Thanks [@pdlug](https://github.com/pdlug)! - Verify npmjs trusted publishing

## 0.1.0

### Minor Changes

- [`3d78324`](https://github.com/nicia-ai/typegraph/commit/3d78324472ac4cb4ac929b52c7501c08a5e7b6ca) Thanks [@pdlug](https://github.com/pdlug)! - Initial public release
