# @nicia-ai/typegraph

## 0.36.0

### Minor Changes

- [#261](https://github.com/nicia-ai/typegraph/pull/261) [`5bc7b53`](https://github.com/nicia-ai/typegraph/commit/5bc7b5333d30392c31605161436441b3e8602447) Thanks [@pdlug](https://github.com/pdlug)! - Return a receipt from `store.withRecordedTransaction`, and add scoped write
  measurement with `tx.measure`.

  - **`store.withRecordedTransaction(externalTx, fn)` now returns
    `Promise<TransactionOutcome<T>>`** instead of `Promise<T>`. The adopted path
    is the only way to get exactly-once cursors and graph writes atomically on a
    history store, and it now surfaces the same receipt `transactionWithReceipt`
    does: `receipt.writes` for dropped-change detection and `receipt.recorded` as
    the per-transaction replay anchor (`undefined` for a read-only callback or a
    non-history store).

    **BREAKING:** the adopted path now returns the result under `.result`. Migrate
    by destructuring:

    ```typescript
    // Before
    const x = await store.withRecordedTransaction(externalTx, fn);
    // After
    const { result: x } = await store.withRecordedTransaction(externalTx, fn);
    ```

  - **Scoped receipts — `tx.measure((scoped) => ...)`.** On the receipt-enabled
    contexts (`transactionWithReceipt`, `withRecordedTransaction`), `tx.measure`
    runs its callback with a **scoped context** — a second view over the same
    transaction — and returns a `TransactionOutcome` whose receipt counts exactly
    the writes made **through that scoped context** (`scoped.nodes` /
    `scoped.edges`). So a framework can attribute writes to user code it invoked
    (e.g. a materializer measuring `project(scoped, change)` to detect a dropped
    change) while its own bookkeeping — written through the outer `tx` — stays out
    of the count. Attribution is by which context you write through, not by
    timing, which makes overlapping and concurrent measures safe by construction
    (two scopes racing under `Promise.all` never cross-count). Nesting composes;
    measured writes still count in the outer receipt; a scoped receipt's
    `recorded` is always `undefined`. Plain `store.transaction()` contexts have no
    `measure` (that path runs no recorder and stays zero-overhead). New exported
    types: `MeasurableTransactionContext`, `MeasurableHistoryTransactionContext`,
    `ScopedMeasure<Ctx>`.

  - **Adopted contexts seal on return.** A transaction context retained and
    written through _after_ its `withRecordedTransaction` callback resolves now
    fails loud on both paths — the history path's capture guard is checked
    _before_ the live write (so a swallowed error can no longer commit an
    uncaptured row), and the non-history path seals its receipt-tracked
    collections (so a post-return write can't persist a row the already-returned
    receipt never counted).

- [#262](https://github.com/nicia-ai/typegraph/pull/262) [`34468a0`](https://github.com/nicia-ai/typegraph/commit/34468a04f9cb6abff34177282d31f1240f1254d1) Thanks [@pdlug](https://github.com/pdlug)! - Add an opt-in `coalesceUnchangedUpserts` store option for at-least-once /
  replay materializers.

  Idempotent event-log projectors converge live state correctly, but every
  re-delivery of a byte-identical value still performed a real write:
  `upsertById` on an existing id called `updateNode` unconditionally, allocating
  a fresh recorded instant and a new history row. A full replay of an N-event log
  therefore rewrote every row and grew recorded history by N — the recovery /
  rebuild workload inflates history the most.

  With `createStore(graph, backend, { coalesceUnchangedUpserts: true })`, an
  `upsertById` (or `bulkUpsertById` item) whose validated props are
  value-identical to the existing **live** row performs **no write at all**: no
  `updateNode`, no recorded-time capture, no history row, no revision-anchor
  advance, and no `update` operation hooks. It resolves with the existing node.
  The dirty-check compares the storage-normalized representation (props run
  through the kind's Zod schema, key-order-independent), so it answers exactly
  "would the persisted value differ?".

  A write still happens (never coalesced) when the row is soft-deleted (an upsert
  resurrects it), when an explicit `validFrom` / `validTo` is passed, or when any
  prop differs. Default off, because some consumers want an audit row per
  re-delivery. Covered symmetrically for edge `bulkUpsertById` (props only —
  endpoints are the edge's identity).

  Receipt semantics are unchanged and need no new signal: a coalesced upsert
  still counts as one write intent (`writes.total`) but captures nothing
  (`recorded` stays `undefined`) — the same two-signal shape as a no-op delete,
  which at-least-once consumers already handle by carrying the prior anchor
  forward.

- [#260](https://github.com/nicia-ai/typegraph/pull/260) [`35d03ae`](https://github.com/nicia-ai/typegraph/commit/35d03ae0fd4647286927d617210f20a7e47df4b6) Thanks [@pdlug](https://github.com/pdlug)! - Make the store transaction surface tell the truth about raw SQL and history
  capture.

  - **New `tx.sqlAvailability` discriminant.** Every transaction context now
    carries a required `sqlAvailability: "available" | "history" |
"revisionTracking" | "unavailable"` field. Branch on it instead of
    truthiness-testing `tx.sql`: under `history: true` / `revisionTracking: true`
    the raw handle is present-but-throwing (so `if (tx.sql)` read truthy and then
    threw), and it is `undefined` only on the non-transactional fallback. `"available"`
    means `tx.sql` is a usable raw handle; `"history"` / `"revisionTracking"` mean
    raw SQL is disabled here; `"unavailable"` means the backend has no transactions
    (`tx.sql === undefined`, no atomicity).

  - **`store.withTransaction()` on a history-enabled store is now a compile error.**
    It always threw at runtime; the call site now rejects the argument with a
    message pointing at `store.withRecordedTransaction()`. The runtime guard is
    unchanged for suppressed calls.

  - **Branchable recorded-capture guard codes.** The `ConfigurationError`s these
    guards throw carry a stable `details.code`
    (`RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION`,
    `RECORDED_CAPTURE_RAW_SQL_DISABLED`, `REVISION_TRACKING_RAW_SQL_DISABLED`), now
    exported as `RECORDED_CAPTURE_GUARD_CODES` with a `RecordedCaptureGuardCode`
    type and an `isRecordedCaptureGuardError(error, code?)` type guard — so a
    portable caller can distinguish "history forbids raw SQL here" from "this
    backend has no transactions" without substring-matching the message.

  - **Fixed `withRecordedTransaction`'s JSDoc**, which incorrectly promised
    `tx.sql`; on the adopted path you already hold the pinned connection, so write
    your own relational tables through the external transaction handle you passed
    in.

## 0.35.0

### Minor Changes

- [#231](https://github.com/nicia-ai/typegraph/pull/231) [`839f536`](https://github.com/nicia-ai/typegraph/commit/839f53621998d41704537e45408872d49452cf1c) Thanks [@pdlug](https://github.com/pdlug)! - Aggregate queries now support `.orderBy()`. Previously `ExecutableAggregateQuery`
  exposed `limit()` but no way to order results, so `.aggregate({...}).limit(n)`
  returned an arbitrary `n` groups rather than the top `n` — the most common
  aggregate shape ("top N groups by count/sum") required fetching every group
  and sorting in JS.

  `.orderBy(key, direction?)` takes any output name from `.aggregate({...})` —
  either a grouped field or an aggregate alias — and can be chained for
  multi-key sorts:

  ```typescript
  store
    .query()
    .from("Author", "a")
    .traverse("wrote", "e")
    .to("Book", "b")
    .groupByNode("a")
    .aggregate({ author: field("a", "name"), bookCount: count("b") })
    .orderBy("bookCount", "desc")
    .limit(2)
    .execute();
  ```

  Ordering resolves against the projected SELECT-list output alias rather than
  recompiling the underlying expression, so it works uniformly for grouped
  fields and aggregates on both SQLite and PostgreSQL with no dialect-specific
  handling.

- [#212](https://github.com/nicia-ai/typegraph/pull/212) [`dcdd542`](https://github.com/nicia-ai/typegraph/commit/dcdd54246fef1e93839196d7029e4dbadbc72b42) Thanks [@pdlug](https://github.com/pdlug)! - Autocommit `bulkCreate` and `bulkInsert` calls (nodes and edges) now
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

- [#195](https://github.com/nicia-ai/typegraph/pull/195) [`e48dfa2`](https://github.com/nicia-ai/typegraph/commit/e48dfa2531148892ca7f5432a3ced6068b464807) Thanks [@pdlug](https://github.com/pdlug)! - `bulkCreate` now batches its round trips end to end instead of degenerating
  into per-row statements around one multi-row INSERT.

  - Validation probes: per-row existence checks collapse into one `getNodes`
    per kind, and per-row uniqueness pre-checks into one `checkUniqueBatch`
    per (constraint, kind) — the batch validation caches are primed up front,
    so the per-row checks run against memory. Validation now runs as a
    synchronous first pass, so a later row's validation error can surface
    before an earlier row's constraint error (both fail the whole batch).
  - Side effects: uniqueness entries write through a new `insertUniqueBatch`
    (multi-row conditional upsert with the same per-entry `UniquenessError`
    semantics), fulltext sync goes through the existing `upsertFulltextBatch`,
    and embedding sync through a new `upsertEmbeddingBatch` per
    (kind, field) — implemented for pgvector, sqlite-vec, and libSQL native
    vectors via an optional `VectorStrategy.buildUpsertBatch` seam with a
    per-row fallback for custom strategies.

  Measured on the write bench (in-memory SQLite, 100-row batches of nodes
  with searchable + embedding fields): ~1,600 → ~4,100 rows/s (~2.6×). The
  win compounds on per-statement-networked engines (Turso, D1, Neon), where
  each eliminated statement is a network round trip.

- [#194](https://github.com/nicia-ai/typegraph/pull/194) [`b3668c9`](https://github.com/nicia-ai/typegraph/commit/b3668c96db58127f983695fa6df8f39662ed761b) Thanks [@pdlug](https://github.com/pdlug)! - Default-path performance tuning for SQLite and bulk maintenance verbs.

  - `createLocalSqliteBackend` now applies connection pragmas at open:
    `journal_mode=WAL`, `synchronous=NORMAL`, and a 5s `busy_timeout`. On
    file-backed databases this makes single-operation writes roughly 5×
    faster than the better-sqlite3 driver defaults (rollback journal,
    `synchronous=FULL`), because each write no longer pays a full-durability
    fsync in journal mode. Override individual values via the new `pragmas`
    option, or pass `pragmas: false` to keep driver defaults.
  - The SQLite backend now detects the connection's real bound-parameter
    budget instead of assuming the historic 999: better-sqlite3 compiles in
    `SQLITE_MAX_VARIABLE_NUMBER=32766` (probed via `PRAGMA compile_options`,
    with a `sqlite_version() >= 3.32` fallback), Cloudflare D1 is capped at
    its documented 100, and undetectable async drivers keep the conservative
    999 floor. Batch chunk math derives from the detected budget, so bulk
    inserts on better-sqlite3 use ~33× fewer statements (111-row chunks →
    3,640-row chunks), and batched writes on D1 no longer exceed its
    per-statement limit. `capabilities.maxBindParameters` reports the
    detected value and remains overridable.
  - `importGraph()` now refreshes planner statistics (`ANALYZE`)
    automatically after an import that created or updated rows, and
    `store.materializeIndexes()` does the same on SQLite after creating
    indexes. Stale statistics after bulk loads previously degraded
    traversals ~10× on PostgreSQL and some FTS5 queries ~30× on SQLite until
    the engine caught up on its own. Both verbs accept
    `refreshStatistics: false` to opt out. On PostgreSQL,
    `materializeIndexes()` builds with `CREATE INDEX CONCURRENTLY` and skips
    the automatic refresh (concurrent same-index builds from two callers can
    deadlock when a refresh shifts their timing) — call
    `store.refreshStatistics()` after materializing.
  - PostgreSQL `refreshStatistics()` now issues one `ANALYZE (SKIP_LOCKED)`
    per table instead of a single multi-table `ANALYZE`. A multi-table
    ANALYZE is one transaction acquiring several ShareUpdateExclusive locks
    in sequence, and ANALYZE's lock class conflicts with in-flight
    `CREATE INDEX CONCURRENTLY` builds — the old shape could deadlock
    against concurrent index DDL; the new one can never join a lock-wait
    cycle (a locked table is skipped and covered by the next refresh or
    autovacuum).

- [#247](https://github.com/nicia-ai/typegraph/pull/247) [`191e877`](https://github.com/nicia-ai/typegraph/commit/191e877796fde30ad606993948decea7305fd367) Thanks [@pdlug](https://github.com/pdlug)! - Declare, as a typed capability, whether a backend's filtered approximate vector
  search can silently return a short page.

  Every approximate (ANN) search TypeGraph issues carries at least one row filter —
  the liveness predicate that hides soft-deleted and out-of-validity rows — and a
  `.where(...)` predicate narrows it further. Where the engine applies that filter
  relative to the index traversal decides whether the page fills:

  - **`sqlite-vec`** pushes the filter into the `vec0` KNN candidate set. Exact —
    the only engine here that guarantees a full page.
  - **`pgvector` ≥ 0.8** re-enters the index for more candidates
    (`hnsw.iterative_scan` / `ivfflat.iterative_scan`, applied automatically).
    Much better recall than a post-filter, but **not** a guarantee: the iterative
    scan stops at `hnsw.max_scan_tuples` / `ivfflat.max_probes`, and on
    **pgvector < 0.8** there is no iterative scan at all — the backend detects
    that at runtime, warns once, and the search stays `ef_search`-bounded.
  - **`libsql-native`** cannot do either: DiskANN's `vector_top_k` is a table
    function with no filter pushdown. TypeGraph over-fetches `4 × (limit + offset)`
    neighbors and post-filters, so once more than that headroom is filtered out the
    search returns **fewer than `limit` rows even though more matches exist**.
    Heavy tombstone drift — routine in a temporal store — is what makes this real
    rather than theoretical.

  That asymmetry was previously only a code comment. `VectorCapabilities` now
  carries a required `filteredApproximateSearch: { mode, guaranteesFullPage }`.
  **Read `guaranteesFullPage`, not `mode`** — `mode`
  (`"filter-pushdown" | "iterative-scan" | "post-filter"`) names the mechanism the
  strategy asks for, but only `guaranteesFullPage` reflects the runtime-dependent,
  scan-bounded reality (it is `true` for `sqlite-vec` alone). It is documented in
  the backend parity matrix, and boundary tests execute the difference against real
  libSQL, sqlite-vec, and pgvector: the same 200-vector fixture, the same filter,
  the same `limit`.

  **Breaking for custom vector strategies only.** `VectorCapabilities` gained a
  required field, so a hand-written `VectorStrategy` must now declare both its mode
  and whether it guarantees a full page. That is deliberate: an omitted declaration
  would inherit an engine promise the strategy may not keep.

- [#198](https://github.com/nicia-ai/typegraph/pull/198) [`a9477bb`](https://github.com/nicia-ai/typegraph/commit/a9477bb28ee887a1a93c103a64912e8563de9d76) Thanks [@pdlug](https://github.com/pdlug)! - Property filters that a btree can never serve now have a declarative index
  story: `defineNodeIndex` / `defineEdgeIndex` accept
  `method: "gin" | "trigram"` (default `"btree"`, unchanged).

  - `method: "gin"` emits a PostgreSQL expression GIN (`jsonb_path_ops`) over
    the field's jsonb extraction, serving the array containment predicates
    (`contains` / `containsAll` / `containsAny` on array fields). Verified to
    match TypeGraph's compiled `(props #> ARRAY[…]) @> $1` form under
    parameterized prepared statements — note that a hand-written
    whole-column `GIN (props)` never matches these expressions (the previous
    docs guidance recommended one; corrected).
  - `method: "trigram"` emits an expression GIN with `gin_trgm_ops` over the
    field's text extraction, serving substring and case-insensitive matches
    (`contains` / `startsWith` / `endsWith` / `like` / `ilike` on string
    fields). `materializeIndexes()` installs `pg_trgm`
    (`CREATE EXTENSION IF NOT EXISTS`) on first use.

  Both are materialize-only (like vector ANN indexes) and PostgreSQL-only:
  `materializeIndexes()` reports them as `skipped` on SQLite, whose
  substring-search story is FTS5 fulltext. GIN-family declarations take
  exactly one field and reject `unique`, `coveringFields`, and `where`;
  `method: "btree"` is canonicalized by absence so existing stored schema
  documents and materialization signatures are unchanged. `bulkFindByIndex`
  rejects GIN-family indexes (it compiles equality probes, which only btree
  declarations serve).

- [#204](https://github.com/nicia-ai/typegraph/pull/204) [`94eea90`](https://github.com/nicia-ai/typegraph/commit/94eea90ead38c69c0ac5b55bad34036f45578b87) Thanks [@pdlug](https://github.com/pdlug)! - perf: `store.search.hybrid` now runs as a single SQL statement on the built-in backends — both sources, weighted RRF fusion, liveness, and node hydration composed into one round trip (previously two search statements plus an id-hydration fetch, with fusion in JS). Results are identical to the previous path; the saving scales with per-statement cost (serverless drivers, D1/Durable Objects, remote databases). `GraphBackend` gains an optional `hybridSearch` member; backends without it (custom backends, capability profiles without window functions) keep the multi-statement fallback.

- [#223](https://github.com/nicia-ai/typegraph/pull/223) [`a161d70`](https://github.com/nicia-ai/typegraph/commit/a161d70895da5101706602ac13e4cca4b7fc6a62) Thanks [@pdlug](https://github.com/pdlug)! - Add `asNodeId` and `asEdgeId` constructors for branding persisted ids that
  round-trip through untyped storage before being passed back to read, update, or
  delete APIs.

- [#241](https://github.com/nicia-ai/typegraph/pull/241) [`8f3e772`](https://github.com/nicia-ai/typegraph/commit/8f3e7727dde0d46415b90e715138c0a9766cd2b5) Thanks [@pdlug](https://github.com/pdlug)! - Fixes `implies(edgeA, edgeB)` silently accepting endpoint-incompatible edge
  pairs. Previously an ontology declaration like `implies(about, writes)` — where
  `about` connects `Paper -> Topic` and `writes` connects `Author -> Paper` —
  was accepted without complaint, and `expand: "implying"` query traversal
  would then silently fold `about` rows into a `writes` traversal even though
  the two edges connect entirely different node kinds.

  `implies()` relations are now validated wherever a query-capable
  `KindRegistry` is built — `createStore()`/`createStoreWithSchema()` for a
  live graph definition, and `deserializeSchema(...).buildRegistry()` for a
  persisted schema — including relations authored through
  `store.evolve({ ontology })`. A relation is accepted when every kind the
  implying edge allows on a side (`from`/`to`) is assignable — equal, or a
  `subClassOf` descendant — to at least one kind the implied edge allows on
  that same side; otherwise construction throws a `ConfigurationError`
  describing the incompatible kinds and how to fix the declaration.

  **Breaking change — two things to know before upgrading.**

  _It breaks the load path, not just graph definition._ `deserializeSchema(...)`
  runs the same endpoint check inside `buildRegistry()`, so a schema **already
  persisted** under 0.34 that carries a now-rejected `implies()` relation throws
  at the first `buildRegistry()` after the upgrade — no code change of yours
  required to trigger it. Audit persisted schemas before rolling out, not only
  the graph definitions in source.

  _It rejects superset domains, not only disjoint ones._ A relation is accepted
  only when every kind the implying edge allows on a side is assignable to at
  least one kind the implied edge allows on that side. So `implies(a, b)` where
  `a` is declared `from: [Person]` and `b` is declared `from: [Employee]` (with
  `Employee subClassOf Person`) is **rejected**, even though every `a` row on
  disk might in fact start at an `Employee`: `Person` is not assignable to
  `Employee`. The declaration, not the data, is what the traversal folds on, and
  a `Person`-rooted `a` row folded into a `b` traversal would be unsound. The
  same rule is what makes the previously-silent disjoint case (`Paper -> Topic`
  implying `Author -> Paper`) an error.

  Fix such relations by narrowing the implying edge's endpoints, adding a
  `subClassOf` relation to bridge the mismatch, or removing the `implies()`
  declaration.

- [#195](https://github.com/nicia-ai/typegraph/pull/195) [`e48dfa2`](https://github.com/nicia-ai/typegraph/commit/e48dfa2531148892ca7f5432a3ced6068b464807) Thanks [@pdlug](https://github.com/pdlug)! - `importGraph` now processes each `batchSize` slice with batched round trips
  instead of fully single-row statements. Nodes: one `getNodes` per kind for
  existence, one `checkUniqueBatch` per (constraint, kind) for uniqueness
  pre-checks, one multi-row insert, and one batched side-effect pass
  (uniqueness entries, fulltext, embeddings) for the accepted creates.
  Edges: one `getNodes` per endpoint kind for reference liveness, one
  `getEdges` for existence, and one multi-row insert.

  Per-row semantics are unchanged: conflicts route by `onConflict`, a
  uniqueness conflict is recorded as a per-row error entry (the rest of the
  import proceeds), reference validation still rejects missing or tombstoned
  endpoints, and rows repeating an id within a slice fall back to the
  per-row path so they observe the first occurrence's row exactly as before.

  Measured on the write bench (in-memory SQLite, 500 nodes + 500 edges per
  import): ~26k → ~96k entities/s (~4×). The win compounds on
  per-statement-networked engines (Turso, D1, Neon), where the old path paid
  one round trip per row and the new one pays a handful per slice.

- [#236](https://github.com/nicia-ai/typegraph/pull/236) [`31aee82`](https://github.com/nicia-ai/typegraph/commit/31aee82608518411e4e9f905c96c52348f7cf08f) Thanks [@pdlug](https://github.com/pdlug)! - `defineNodeIndex` accepts a new `keySystemColumns` option: system columns
  (e.g. `"id"`) to include in the index key, positioned after the `scope`
  prefix and before `fields`/`coveringFields`. `fields` is now optional (was
  a required non-empty tuple) — an index must declare at least one of
  `fields`, `coveringFields`, or `keySystemColumns`.

  This closes a real gap: a covering index can only serve a query's join
  index-only (avoiding a heap fetch per candidate row) if the index's key
  matches the join's actual predicate. Queries that join on a system column
  directly (e.g. TypeGraph's compiled `n.id = e.from_id` for a reverse
  traversal) had no way to declare a matching index, since `fields`/
  `coveringFields` only ever accept the node's own schema properties.
  `keySystemColumns: ["id"]` (plus `coveringFields` for whatever the query
  also projects) now lets that same join be served index-only.

  Rejects edge-only system columns (`from_kind`/`from_id`/`to_kind`/
  `to_id`) on a node index, and rejects any column already implied by
  `scope`. Not supported with `method: "gin" | "trigram"` (same restriction
  as `coveringFields`). Also rejects `unique: true` combined with
  `keySystemColumns: ["id"]` — every node's `id` is already unique per
  row, so a unique index keyed on `id` plus other columns can never
  enforce a meaningful constraint across those other columns. Canonicalized
  by absence, like `method`: indexes that don't use it produce byte-identical
  names/hashes to before this field existed, so existing stored schema
  documents and materialization signatures are unaffected.

- [#208](https://github.com/nicia-ai/typegraph/pull/208) [`586b2b0`](https://github.com/nicia-ai/typegraph/commit/586b2b05f3f501f3d53db1dbb2ec247e17a67294) Thanks [@pdlug](https://github.com/pdlug)! - fix: `materializeIndexes` serializes same-index builds across callers on PostgreSQL via a durable claim in the status table (two concurrent same-name expression-index `CREATE INDEX CONCURRENTLY` builds can deadlock — no safe-snapshot exemption). Losers wait and converge as `alreadyMaterialized`; a crashed builder's claim expires after a 15-minute lease and the takeover drops the INVALID index leftover before rebuilding (relational indexes now self-heal instead of requiring manual repair). With same-index builds serialized, the automatic post-create `ANALYZE` is re-enabled on PostgreSQL.

- [#201](https://github.com/nicia-ai/typegraph/pull/201) [`b52ae3b`](https://github.com/nicia-ai/typegraph/commit/b52ae3b3358435de9774f348fc94ab7140bdc7eb) Thanks [@pdlug](https://github.com/pdlug)! - perf: eliminate the PostgreSQL JSONB parse→stringify→parse round trip per row.

  **Public backend row contract change:** rows returned by `GraphBackend` read methods now carry `props` as `RowProps = string | Readonly<Record<string, unknown>>` — JSON text on SQLite, the driver-parsed object on PostgreSQL. Code that consumed backend rows directly with `JSON.parse(row.props)` must switch to the new `rowPropsToObject(row.props)` (or `rowPropsToJsonText` when text is required); both helpers and the `RowProps` type are exported from the package root. Store-level APIs (`store.nodes.*`, `store.query()`, search, export) are unaffected — they already return parsed objects.

- [#249](https://github.com/nicia-ai/typegraph/pull/249) [`d2a6feb`](https://github.com/nicia-ai/typegraph/commit/d2a6feb8a99aaafa247c7bf97f9670c56608a870) Thanks [@pdlug](https://github.com/pdlug)! - Add revision-anchored graph branches and streaming interchange. Stores can opt
  into `revisionTracking: true` (or use `history: true`) so branch and merge
  validation read a durable per-graph origin and revision instead of
  fingerprinting every live row or accepting a coincident revision from another
  store. Physical branch clones now stream bounded interchange batches, enabling
  large branch copies, exports, and imports without materializing the full graph
  in memory. Direct backend writes remain outside the revision-tracking contract;
  tracked stores fail loudly if `tx.sql` would bypass that contract.

- [#203](https://github.com/nicia-ai/typegraph/pull/203) [`801768d`](https://github.com/nicia-ai/typegraph/commit/801768d2e1a63a0d3bda9d40a46a7f03deddffbd) Thanks [@pdlug](https://github.com/pdlug)! - feat: facade search scoping — `store.search.{vector,fulltext,hybrid}` accept `where` (a property predicate compiled by the shared query compiler into the search statement's candidate set), `offset` (rank-relative pagination pushed into the engine), and `includeSubClasses` (search `subClassOf` descendants and merge into one ranking). Filters compile into the search statement's candidate set — exact on pgvector, sqlite-vec, tsvector, and FTS5, where a filtered search returns `limit` hits whenever enough matches exist; libSQL DiskANN post-filters a 4× over-fetched ANN set, so its recall against the filter is bounded by that headroom. Search now applies full current-read semantics (validity windows, not just tombstones), matching `find()`.

- [#205](https://github.com/nicia-ai/typegraph/pull/205) [`17bbe54`](https://github.com/nicia-ai/typegraph/commit/17bbe5419a246c95bbab9f6bc7da64f6691e159e) Thanks [@pdlug](https://github.com/pdlug)! - feat: `.similarTo(vector, k, { approximate: true })` — opt-in approximate retrieval for the inline vector predicate. Each declaring kind's relevance branch compiles to the engine's native ANN search form (vec0 `MATCH … k=`, libSQL `vector_top_k`, pgvector's index-eligible scan), scoped to the query's candidate nodes via the same pushdown the search facade uses, so composed predicates and traversals still constrain results. Never applied silently: the default remains the exact distance scan, and slots declared `indexType: "none"` keep it even with the opt-in.

- [#245](https://github.com/nicia-ai/typegraph/pull/245) [`ef6def6`](https://github.com/nicia-ai/typegraph/commit/ef6def6b67e306a9cdb40e78723dad6d36f89647) Thanks [@pdlug](https://github.com/pdlug)! - `createLocalSqliteBackend`'s `pragmas` option accepts two new fields:
  `cacheSizeKib` (`PRAGMA cache_size`) and `mmapSizeBytes` (`PRAGMA
mmap_size`). Both default to `undefined`, leaving SQLite's own built-in
  defaults (a 2MiB page cache, mmap disabled) untouched — existing callers
  are unaffected.

  SQLite's 2MiB default cache is fine for a small embedded database, but
  once a database's working set exceeds it, every page a query touches past
  that point pays a fresh disk read instead of a cache hit — including pages
  an otherwise fully covering index would have served from cache alone. Set
  `cacheSizeKib` (and optionally `mmapSizeBytes`) once a database's working
  set is known to exceed the default, the same way you'd size a page cache
  for any other embedded or server database engine.

- [#197](https://github.com/nicia-ai/typegraph/pull/197) [`f420a92`](https://github.com/nicia-ai/typegraph/commit/f420a922a1f168891ee4de54e91cc9ca1638deed) Thanks [@pdlug](https://github.com/pdlug)! - SQLite CRUD statements now reuse the prepared-statement cache. The
  operation backend's read/write helpers previously executed through
  drizzle's `db.all()` / `db.run()`, which re-prepares every statement on
  every call — only the query engine's `backend.execute` path used the
  prepared-statement LRU. On synchronous drivers (better-sqlite3,
  bun:sqlite) CRUD statements and the per-write transaction frames
  (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`) now route through the
  execution adapter's compiled path, so a repeated operation shape re-binds
  parameters against a cached prepared statement. A warmed CRUD cycle
  re-prepares nothing. Async drivers (remote libsql/Turso, D1) have no
  statement cache and keep the existing execution path.

  Measured on the write bench (in-memory SQLite, order-controlled A/B):
  single-op creates ~18.3k → ~28.8k ops/s (~1.6×), transaction-batched
  creates ~23.9k → ~36k ops/s (~1.5×).

- [#251](https://github.com/nicia-ai/typegraph/pull/251) [`f23f7a5`](https://github.com/nicia-ai/typegraph/commit/f23f7a5d15fd5fb59de3667c7d7b10e1975690d4) Thanks [@pdlug](https://github.com/pdlug)! - `createLocalSqliteBackend`'s `pragmas` option accepts a new field:
  `walAutocheckpointPages` (`PRAGMA wal_autocheckpoint`). Defaults to
  `undefined`, leaving SQLite's own built-in default (1,000 pages, ~4MiB)
  untouched — existing callers are unaffected.

  SQLite's default checkpoints WAL back into the main database file every
  ~4MiB. That's fine for a normal read/write mix, but a large bulk load pays
  increasingly expensive checkpoints as the database file grows over the
  course of the load — each checkpoint has to flush WAL frames into a B-tree
  that's larger, and less page-cache-resident, than the one before it. A
  local repro (real `bulkInsert()` calls, 100K/500K/2M synthetic rows)
  confirmed this: raising `walAutocheckpointPages` cut a 2M-row bulk load's
  wall-clock time by over 50% at the largest scale tested, with the effect
  growing at larger row counts. Set `walAutocheckpointPages` for a
  bulk-insert-heavy workload; `0` disables automatic checkpointing entirely
  for callers that would rather run one explicit `PRAGMA wal_checkpoint`
  after the load finishes.

- [#222](https://github.com/nicia-ai/typegraph/pull/222) [`7588634`](https://github.com/nicia-ai/typegraph/commit/758863402ec69b3724acb93f07a51eaf23132dc7) Thanks [@pdlug](https://github.com/pdlug)! - Add `store.transactionWithReceipt()`, which runs a transaction and returns a
  receipt summarizing completed collection write intents and, for
  history-enabled stores, the recorded commit instant allocated by the
  transaction.

- [#233](https://github.com/nicia-ai/typegraph/pull/233) [`e0e6304`](https://github.com/nicia-ai/typegraph/commit/e0e6304bc17b6d9c004376fd77ddf8cc3b0cc252) Thanks [@pdlug](https://github.com/pdlug)! - Every `TypeGraphError` subclass with a fixed-shape `details` payload now
  declares a narrowed `readonly details` type (e.g.
  `RestrictedDeleteError.details` is `RestrictedDeleteErrorDetails`, not the
  base class's `Readonly<Record<string, unknown>>`), so reading structured
  fields like `error.details.edgeCount` no longer requires a cast. The new
  `XxxErrorDetails` types (`NodeNotFoundErrorDetails`,
  `EdgeNotFoundErrorDetails`, `KindNotFoundErrorDetails`,
  `NodeConstraintNotFoundErrorDetails`, `NodeIndexNotFoundErrorDetails`,
  `EndpointNotFoundErrorDetails`, `EndpointErrorDetails`,
  `UniquenessErrorDetails`, `CardinalityErrorDetails`, `DisjointErrorDetails`,
  `RestrictedDeleteErrorDetails`, `VersionConflictErrorDetails`,
  `SchemaMismatchErrorDetails`, `MigrationErrorDetails`,
  `EagerMaterializationErrorDetails`, `StaleVersionErrorDetails`,
  `SchemaContentConflictErrorDetails`, `StoreNotInitializedErrorDetails`,
  `DatabaseOperationErrorDetails`, `EmbeddingDimensionChangedErrorDetails`) are
  exported from the package root alongside the existing
  `ValidationErrorDetails`. Classes with intentionally open, per-call-site
  details (`ConfigurationError`, `UnsupportedPredicateError`,
  `CompilerInvariantError`, `BackendDisposedError`) are unchanged.

- [#206](https://github.com/nicia-ai/typegraph/pull/206) [`995b964`](https://github.com/nicia-ai/typegraph/commit/995b9643927f498deabb157113bcb5ecb5883ca9) Thanks [@pdlug](https://github.com/pdlug)! - perf: cascade deletes batch their edge removals — new optional `GraphBackend.deleteEdgesBatch` / `hardDeleteEdgesBatch` members issue one statement per bind-budget chunk instead of one per connected edge (50-edge cascade on local PostgreSQL: 24.4ms → 3.6ms), with recorded-time capture preserved. `getOrCreate` variants no longer run the full Zod parse twice on the create leg.

### Patch Changes

- [#247](https://github.com/nicia-ai/typegraph/pull/247) [`191e877`](https://github.com/nicia-ai/typegraph/commit/191e877796fde30ad606993948decea7305fd367) Thanks [@pdlug](https://github.com/pdlug)! - Fix: the synthetic CTE column names that carry selectively-extracted `props`
  fields are now bounded to PostgreSQL's identifier limit.

  A selected top-level `props` field is extracted once inside the CTE that owns it,
  under a generated column name encoding the query alias and the field name. The
  encoding was unambiguous but unbounded, and PostgreSQL silently truncates
  identifiers at 63 **bytes** — so two distinct `(alias, field)` pairs sharing a
  long prefix could collapse onto one column name after truncation, yielding an
  ambiguous-column error or the wrong value.

  Long names are now truncated on a UTF-8 character boundary and disambiguated with
  a hash of the full, untruncated pair — the same guard the sibling subgraph
  projection path already used, now extracted into one shared helper. Names that
  already fit are emitted unchanged, so compiled SQL for ordinary queries is
  byte-for-byte what it was.

- [#247](https://github.com/nicia-ai/typegraph/pull/247) [`191e877`](https://github.com/nicia-ai/typegraph/commit/191e877796fde30ad606993948decea7305fd367) Thanks [@pdlug](https://github.com/pdlug)! - Document a semantic consequence of batched writes: within **one backend batch
  call**, every row whose timestamp TypeGraph generates shares a single instant,
  sampled once for that call — not once per row, and not once per bind-budget
  chunk. `bulkCreate()` and `bulkInsert()` issue one such call, so all of their
  rows tie.

  Creating the same rows one at a time through `create()` gives each its own
  timestamp, so `ORDER BY created_at` was a total order there and is only a
  partial one after a bulk write. Two things it is **not** safe to conclude:

  - **`importGraph()` is not one instant.** It slices nodes and edges into
    `batchSize` batches and drives one backend call per slice, so each slice
    samples its own timestamp. Rows that carry an explicit `validFrom` in the
    import payload keep it verbatim; only generated defaults are affected.
  - **Ids are not a sequence.** The default generator is a random NanoID, and
    callers may supply arbitrary ids, so `ORDER BY id` is not insertion order.
    `(created_at, id)` is a _deterministic_ tiebreak, not a chronology. If input
    order matters, persist an explicit sequence column.

  One instant per batch call is the intended semantics — it is what makes a bulk
  write a single point in valid time rather than a smear — and it is the same
  choice `valid_from` already made. Nothing changes in behavior; this note exists
  because the batching work that landed this release moved several paths onto it.

- [#248](https://github.com/nicia-ai/typegraph/pull/248) [`c379045`](https://github.com/nicia-ai/typegraph/commit/c37904505ee0cf17a9a62f4f7e6769be61319670) Thanks [@pdlug](https://github.com/pdlug)! - Perf: cache compiled query SQL across executions again, without freezing the
  read instant.

  The read-freshness fix recompiled a query's full AST to SQL on every
  `execute()` so a reused or prepared query would always see the latest rows.
  That kept results fresh but made the recommended `.prepare()`-once-`.execute()`-
  many pattern pay a full compile per call (a point lookup ~58µs, a three-hop
  traversal ~450µs of pure JS compilation).

  Only the bound "current" read instant varies between two compilations of the
  same query; the SQL text is identical. So a query now compiles once into a
  cached statement whose read instant is a reserved execution-time placeholder,
  and each execution fills a fresh instant into it and runs the cached text
  directly. Repeated point-query execution drops from ~47µs to ~2.4µs (near the
  raw-execution floor) while staying just as fresh — a row created after
  `prepare()` or the first `execute()` is still visible on the next call.

  The cache applies to `ExecutableQuery`, prepared queries, aggregate queries,
  and set operations, on backends that can compile and run raw SQL text
  (synchronous SQLite and PostgreSQL backends); other backends — including async
  SQLite profiles that do not expose `executeRaw` — fall back to per-call
  recompilation unchanged. Statements whose execution depends on the compiled
  SQL object — pgvector approximate-scan GUC tuning and parameter-blind-plan
  avoidance — keep running through the standard execution path. `param()` now
  rejects the reserved read-instant name, and aggregate queries (which have no
  `.prepare()`) reject `param()` with clear guidance instead of a downstream
  binding error.

- [#244](https://github.com/nicia-ai/typegraph/pull/244) [`b38a537`](https://github.com/nicia-ai/typegraph/commit/b38a537d1f0abcb5925a94b7e0845fb1184509ff) Thanks [@pdlug](https://github.com/pdlug)! - Fix: "current" temporal reads now evaluate validity against the application
  clock, not the database clock — repairing a read-after-write consistency
  violation on Postgres.

  `valid_from` is stamped from the application clock (`Date.toISOString()`) on
  write, but a "current" read compiled its validity filter against the database
  clock (`valid_from <= NOW()` on Postgres). On any deployment where the
  application-server clock runs ahead of the database-server clock — i.e. the
  app and database on separate hosts, which is the norm — a freshly-created node
  or edge could be missing from the very "current" read that immediately
  followed its creation, until the database clock caught up. SQLite (a single
  in-process clock) was never exposed.

  The "current" read now binds the application clock (`nowIso()`) as a
  parameter — the same clock `valid_from`, the facade search-currency filter,
  and the recorded/logical clock already use — across every current-read path
  (standard and recursive queries, subgraph extraction, graph algorithms, and
  recorded-time reads). The temporal-visibility clock is now a single source.
  Because the current-read instant is no longer dialect-specific, the internal
  `DialectAdapter.currentTimestamp()` seam has been removed.

  **Know the consistency model this buys you.** Reads and writes now share one
  clock — _the clock of the process that issued them_. Read-after-write
  consistency therefore holds **per application process**: a node you just
  created is visible to the very next current read from that same process,
  which is the guarantee the bug broke. It does **not** extend across processes.
  Two application servers with skewed clocks, writing to one PostgreSQL
  database, can still miss each other's fresh rows: a row stamped
  `valid_from = T` by the server that runs ahead stays invisible to a current
  read from the server that runs behind until its own clock passes `T`. The
  window equals the skew between the two application hosts, not between an
  application host and the database. If you need cross-process read-after-write
  consistency, keep application clocks disciplined (NTP), or read at an explicit
  `asOf` coordinate rather than `current`.

- [#247](https://github.com/nicia-ai/typegraph/pull/247) [`191e877`](https://github.com/nicia-ai/typegraph/commit/191e877796fde30ad606993948decea7305fd367) Thanks [@pdlug](https://github.com/pdlug)! - Fix: `store.algorithms.degree()` undercounted edges written before an endpoint
  declaration changed.

  To let the composite edge indexes seek — both lead with the endpoint kind
  column, so a bare `from_id = ?` cannot — the direction filter supplied the
  missing kind equality by enumerating the endpoint kinds the _graph declaration_
  permits for the counted edge kinds. That enumeration is complete only for rows
  written under the current declaration. Narrow `knows` from `from: [Person]` to
  `from: [Employee]`, and every `Person`-rooted `knows` edge already on disk drops
  out of the filter: `degree()` silently returns a number too small, with no error
  and no warning.

  The filter now derives the kind from the counted node itself, via an
  uncorrelated scalar subquery. This is exact by construction: an edge row stores
  the _actual_ kind of each endpoint node (the write path copies it off the
  endpoint reference) and a node's kind is immutable for the life of its id, so
  for any edge incident to a node, the endpoint kind on that node's side is that
  node's kind and nothing else — however the declaration later evolves.

  It is also a better filter. An equality on one kind replaces an `IN` list over
  every declared endpoint and its `subClassOf` descendants, and both engines hoist
  the uncorrelated subquery to a constant (a Postgres InitPlan, a SQLite one-shot
  scalar subquery), so the seek is unchanged. `EXPLAIN QUERY PLAN` still shows
  `typegraph_edges_from_idx` / `_to_idx` seeks with no partition scan.

  `degree()` of an id that names no node is `0`, as before.

- [#200](https://github.com/nicia-ai/typegraph/pull/200) [`472ac1c`](https://github.com/nicia-ai/typegraph/commit/472ac1c20a6751a52121da8732f6c562fe5124c8) Thanks [@pdlug](https://github.com/pdlug)! - `degree()` direction filters are now shaped for the default edge indexes.
  The filters previously compiled to bare `from_id = ?` / `to_id = ?`, which
  neither composite edge index can seek (both lead with the endpoint kind
  column) — so degree counts relied on engine-specific rescue: SQLite
  skip-scan (only with fresh statistics) or PostgreSQL 18's new btree skip
  scan, and degenerated to partition scans everywhere else (PostgreSQL ≤ 17,
  SQLite with stale statistics).

  The filters now enumerate the endpoint kinds the graph declaration permits
  for the counted edge kinds, expanded through the subClassOf closure — the
  same set edge writes validate against — making `edges_from_idx` /
  `edges_to_idx` structurally seekable on every engine and version.
  Measured on PostgreSQL 18 (where the old form was already skip-scan
  rescued): 0.30ms → 0.06ms per call; on older PostgreSQL the old form
  could not use these indexes at all. An edge set that declares no endpoint
  kinds on the required side now returns 0 without a round trip.

  Behavior note: because the counted set is now restricted to edges whose
  stored endpoint kind falls within the declaration's `subClassOf` closure,
  `degree()` no longer counts an edge whose stored `from_kind` / `to_kind`
  lies _outside_ that closure — e.g. a row written before the endpoint
  declaration was narrowed, or written directly through the backend bypassing
  endpoint validation. This matches how typed traversals already treat such
  rows (invisible to a schema-consistent read), but it is a change from the
  previous "count every edge touching this node regardless of stored kind"
  behavior.

- [#220](https://github.com/nicia-ai/typegraph/pull/220) [`7b48543`](https://github.com/nicia-ai/typegraph/commit/7b4854310fc042410e31f2e14abc19a9e61e44a2) Thanks [@pdlug](https://github.com/pdlug)! - Edge delete, edge hard delete, and node hard delete no longer re-read
  the row inside the write transaction. The in-transaction preflight was
  pure round-trip fat on these paths: nothing consumed the row, and the
  writes are already concurrency-correct on their own — the tombstone
  UPDATE is guarded by `deleted_at IS NULL` and the hard deletes are
  id-keyed and idempotent, so a row deleted concurrently between the
  outside gate and the write lock degrades to a 0-row no-op with
  identical observable behavior (verified including recorded-time history
  under a deliberately staled gate). One less statement per delete
  (~20% of the per-op round trips on client/server engines). Node SOFT
  delete keeps its preflight deliberately: its pipeline consumes the
  pre-image for uniqueness-key cleanup, now documented in place.

- [#227](https://github.com/nicia-ai/typegraph/pull/227) [`09754a6`](https://github.com/nicia-ai/typegraph/commit/09754a6e4435425e8a55e9a0b991fcbd66daccbf) Thanks [@pdlug](https://github.com/pdlug)! - Batches edge creation's endpoint-existence checks in `bulkCreate`/`bulkInsert`
  into one `getNodes` call per distinct (kind) referenced across the whole
  batch, instead of an individual `getNode` probe per edge (mirroring the
  batched existence/uniqueness pre-check node creation already had via
  `primeBatchValidationCaches`). Found while investigating why a real
  LDBC SNB SF1 bulk load (millions of nodes and edges) was far slower than
  expected: a controlled 1M-row reproduction showed `bulkInsert` edge-batch
  time growing from ~90ms to ~630ms per 2,000-row batch as the graph grew,
  while an equivalent node-only batch (no edges) stayed roughly flat. The
  edge batch path validated each edge's `from`/`to` endpoints with a
  `getNode` call per edge — for a batch with mostly-unique endpoints, that's
  thousands of individual round trips per batch instead of one batched
  fetch per distinct node kind. With the fix, the same 1M-edge reproduction's
  per-batch time drops to roughly ~90-160ms and its growth curve flattens
  substantially (the residual growth matches the same mild index-maintenance
  cost already seen on plain node inserts). No behavior change: this is a
  pure internal optimization to `executeEdgeCreateNoReturnBatch`/
  `executeEdgeCreateBatch`; callers observe identical results, just fewer
  round trips.

- [#245](https://github.com/nicia-ai/typegraph/pull/245) [`ef6def6`](https://github.com/nicia-ai/typegraph/commit/ef6def6b67e306a9cdb40e78723dad6d36f89647) Thanks [@pdlug](https://github.com/pdlug)! - The default edge traversal indexes (`{table}_from_idx` / `{table}_to_idx`,
  created for every graph on both SQLite and PostgreSQL) were missing two
  things a traversal join needs to be served fully index-only:

  - **`valid_from`** — one of the three system columns every compiled
    query's soft-delete / temporal-validity predicate checks (`deleted_at`
    and `valid_to` were already covered; `valid_from` wasn't).
  - **The join's target-id column** — a compiled traversal reads `n.id =
e.to_id` for an outgoing traversal, or `n.id = e.from_id` for an
    incoming one (`standard-builders.ts`), but neither index carried the
    _other_ endpoint's id column, so the join to the target node still
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
  `CREATE INDEX IF NOT EXISTS` under the _same index name_, and that is a
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

- [#217](https://github.com/nicia-ai/typegraph/pull/217) [`fce0a0f`](https://github.com/nicia-ai/typegraph/commit/fce0a0f18b90e7b6f5b5d395681231865b21fb52) Thanks [@pdlug](https://github.com/pdlug)! - Non-approximate `.similarTo()` is now genuinely exact when an ANN index
  exists. pgvector serves any `ORDER BY embedding <=> q LIMIT k` from a
  matching HNSW/IVFFlat index, so after `materializeIndexes()` the
  default (non-approximate) inline vector predicate silently returned
  approximate results — measured recall 0.980 unfiltered and 0.000 under
  a selective filter at 50k docs, where the index frontier starves at the
  default ef_search and returns entirely wrong rows. The exact branch now
  orders by `(distance + 0.0)`, which the index opclass cannot match,
  forcing the true flat scan on every engine (numerically identity;
  inert on SQLite/libSQL whose ANN forms are opt-in constructs).

  Behavior change: exact queries that were silently index-served get
  correct results and flat-scan latency (50k x 384 dims: ~39ms instead of
  ~23ms-but-wrong). The sanctioned fast path remains
  `similarTo(..., { approximate: true })`, which is unchanged. The
  `bench:vector` lane's `vector:exact-postindex-recall` and
  `vector:exact-filtered-postindex-recall` rows now read 1.000.

- [#210](https://github.com/nicia-ai/typegraph/pull/210) [`76422c6`](https://github.com/nicia-ai/typegraph/commit/76422c64189baa2c83287a99a1fea6a13bbfe976) Thanks [@pdlug](https://github.com/pdlug)! - perf: PostgreSQL fulltext queries are now parsed with the kind's DECLARED language as a plan-time constant (the same winning-language rule the write path applies to rows), instead of referencing the per-row `language` column. The per-row form made every tsquery non-constant, so the GIN index on `tsv` could never serve a match and every search re-parsed the query per row — measured 12.9ms → 2.3ms at 5,000 docs for the parse elimination alone, with GIN service now possible as corpora grow. Applies to the facade and the inline `$fulltext` predicate; mixed-language subclass aliases and explicit per-query overrides behave as before.

- [#207](https://github.com/nicia-ai/typegraph/pull/207) [`5cbcb35`](https://github.com/nicia-ai/typegraph/commit/5cbcb35f9df972a6f36975b43adad2d7b110bfd1) Thanks [@pdlug](https://github.com/pdlug)! - perf: recorded-time capture acquires the PostgreSQL graph-write advisory lock once per transaction instead of once per captured write (`pg_advisory_xact_lock` is reentrant and held to transaction end, so the repeats were pure round trips). A 50-write recorded transaction drops from N+1 lock round trips to 1; measured 1.7× on the transaction shape.

- [#215](https://github.com/nicia-ai/typegraph/pull/215) [`0eb2fd8`](https://github.com/nicia-ai/typegraph/commit/0eb2fd8ba778fb6e9cf6469481805a1c8cd86647) Thanks [@pdlug](https://github.com/pdlug)! - The single-statement hybrid search now emits the candidates set
  (liveness/currency filter, or the compiled `where` predicate query)
  once, as a CTE shared by the vector and fulltext legs, instead of
  embedding — and re-executing — a private copy inside each leg. The
  duplicate evaluation was most expensive with a `where` filter, whose
  compiled candidates query ran twice per search: measured on PostgreSQL,
  filtered hybrid drops 26.5ms → 17.1ms at 5k docs (bench shape
  11.8ms → 8.6ms; unfiltered 6.1ms → 4.9ms). This also removes a subtle
  inconsistency where each leg stamped its own currency instant. SQLite
  is unchanged within noise (in-process re-execution was cheap).

- [#247](https://github.com/nicia-ai/typegraph/pull/247) [`191e877`](https://github.com/nicia-ai/typegraph/commit/191e877796fde30ad606993948decea7305fd367) Thanks [@pdlug](https://github.com/pdlug)! - Fix: hybrid search's two execution paths agreed on scores but not on ties, and
  neither was deterministic across PostgreSQL databases.

  Relevance ranking breaks a score tie on `node_id`. Left bare, PostgreSQL sorts
  that under the database's default text collation: an `en_US.UTF-8` database
  orders `a, A, b, B` where byte order gives `A, B, a, b`. So the same query
  returned different pages on two databases whose `datcollate` differed, and
  disagreed with SQLite (whose `BINARY` collation is byte order) throughout.

  Three seams had to move together, because a hybrid search's tiebreak decides the
  page twice — once in the per-source ranks, and again in the fused ordering the
  ranks produce:

  - The single-statement hybrid search now renders `node_id COLLATE "C"` in both
    per-source `ROW_NUMBER()` windows and in the final `ORDER BY`.
  - The standalone fulltext search's `ORDER BY … , node_id` is C-collated too, so
    the multi-statement fallback's fulltext ranks match.
  - The fallback now re-ranks each leg's rows before assigning ranks, rather than
    trusting the order the source SQL happened to return for a single kind. The
    vector source breaks a distance tie arbitrarily — it carries no `node_id`
    tiebreak, because a second sort key would cost pgvector its ordered index scan
    — so its arrival order was never a sound basis for a rank. That re-rank sorts
    with a new code-point comparator rather than JavaScript's UTF-16 code-unit
    `<`, which disagrees with byte order for astral characters such as emoji.

  All three orderings now coincide, and the single-statement and multi-statement
  paths return identical hits, ranks, and scores even when every score ties.

  Results only change where they were previously non-deterministic.

- [#213](https://github.com/nicia-ai/typegraph/pull/213) [`a243f3b`](https://github.com/nicia-ai/typegraph/commit/a243f3bc323f8d7377454f06c2349fb87386963c) Thanks [@pdlug](https://github.com/pdlug)! - `importGraph`'s default `batchSize` is now 1,000 (was 100), and the
  default now actually applies: options are parsed through
  `ImportOptionsSchema` at the function boundary, so direct calls that
  omit fields with schema defaults (e.g. `{ onConflict: "error" }`)
  resolve them instead of reading `undefined`. `ImportOptions` is now the
  schema's input type — fields with defaults are optional for callers.

  Each import batch pays fixed per-round-trip costs (existence probe,
  unique pre-check, one multi-row insert), so the old default dominated
  import time on client/server engines: a 20k-node + 5k-edge import on
  PostgreSQL drops from 1,515ms to 781ms (16.5k → 32k entities/s).
  SQLite imports are insensitive to the value (in-process, no round
  trips). Explicit `batchSize` values are unaffected.

  Fulltext batch upserts and deletes are now split by the driver's
  bind-parameter budget in the backend wrappers, like node/edge/unique
  inserts already were. Previously a searchable import slice emitted ONE
  FTS5 (or tsvector) statement over every row — 6 binds per row, so a
  1,000-row slice overflowed SQLite's 999-bind fallback ceiling and D1's
  ~100-bind cap, and 6,000-row slices overflowed even better-sqlite3's
  32,766 budget ("too many SQL variables").

- [#221](https://github.com/nicia-ai/typegraph/pull/221) [`9b61809`](https://github.com/nicia-ai/typegraph/commit/9b618098b6c6f4917f79a23f4b1f0477428de0b3) Thanks [@pdlug](https://github.com/pdlug)! - Inline `.similarTo(..., { approximate: true })` now actually uses the
  ANN index on PostgreSQL. Two defects compounded: the candidates
  membership subquery carried a `DISTINCT` that kept the planner off the
  ordered index scan entirely (even `enable_seqscan = off` could not
  rescue it — duplicates are irrelevant to `IN` membership, so the
  DISTINCT bought nothing), and the inline path never applied the
  pgvector GUCs the search facade uses, so even an index-served filtered
  scan would have starved at the default ef_search frontier. The compiler
  now emits duplicate-tolerant membership candidates for the engine-form
  branch and brands ANN-bearing statements; the PostgreSQL backend wraps
  branded statements with the facade's GUC overrides
  (`hnsw.iterative_scan = strict_order` / `ivfflat.iterative_scan =
relaxed_order` on transaction-capable drivers with pgvector >= 0.8;
  the settings are transaction-scoped, so non-transactional backends
  such as neon-http keep the plain bounded scan). Set operations merge
  operand brands onto the combined statement, so a union with an
  approximate operand is wrapped too. Measured at 50k x 384 dims:
  unfiltered approximate 174ms -> 2.1ms (recall 0.995), filtered
  approximate 3.8ms at recall 1.000 on filter-independent corpora. The
  JOIN consumers of the scoped candidates (exact branch, fulltext CTE)
  keep their DISTINCT — a join does multiply rows on duplicates — and the
  non-approximate path's exactness guarantee is untouched.

- [#224](https://github.com/nicia-ai/typegraph/pull/224) [`b5886cd`](https://github.com/nicia-ai/typegraph/commit/b5886cdad183dcba80586344935278a79f9ed795) Thanks [@pdlug](https://github.com/pdlug)! - Document external event-log materialization patterns and verify the
  export/import bulk-copy path into graph-merge branches.

- [#199](https://github.com/nicia-ai/typegraph/pull/199) [`d01d6c7`](https://github.com/nicia-ai/typegraph/commit/d01d6c76be56efb393a3cd5506e6a5690995c409) Thanks [@pdlug](https://github.com/pdlug)! - Subgraph extraction is ~4× faster on PostgreSQL. The final node/edge
  fetches filtered ids with `IN (SELECT id FROM included_ids)`; PostgreSQL
  pulls that form up into a join whose recursive-CTE row estimate (~10 rows
  for a single-row seed) drives the planner into a nested-loop join filter —
  measured at ~10 million discarded rows on the depth-3 benchmark shape.
  PostgreSQL now evaluates membership against the materialized closure ids
  with a parameterized `text[]` semi-join
  (`EXISTS (SELECT 1 FROM unnest($ids) AS t(id) WHERE t.id = column)`) rather
  than pulling the recursive CTE into that join; SQLite keeps `IN (subquery)`,
  which it already evaluates optimally.

  Measured (benchmark suite, 1,200 users / depth-3 stress shape): PostgreSQL
  subgraph full hydration 322ms → 82ms, depth-2 11.5ms → 7.1ms; SQLite
  unchanged.

- [#247](https://github.com/nicia-ai/typegraph/pull/247) [`191e877`](https://github.com/nicia-ai/typegraph/commit/191e877796fde30ad606993948decea7305fd367) Thanks [@pdlug](https://github.com/pdlug)! - Fix: serialize the statements TypeGraph issues on a transaction's pinned
  Postgres connection, so its own graph writes never present two queries to one
  connection at once.

  A transaction pins one connection, and the PostgreSQL wire protocol carries one
  statement at a time. node-postgres hid that behind an internal queue, deprecated
  it in `pg@8.22` ("Calling client.query() when the client is already executing a
  query is deprecated and will be removed in pg@9.0. Use async/await or an
  external async flow control mechanism instead"), and removes the queue in
  `pg@9`. TypeGraph overlapped statements on a pinned connection in two ways:

  - **Always on, no user concurrency required.** The node write pipeline issues
    `Promise.all([syncEmbeddings, syncFulltext])` for any schema that has both a
    `searchable()` field and an `embedding()` field, so every single `create()`,
    `update()`, or resurrect on such a schema put two statements on the wire.
  - **User-driven.** `store.transaction(async (tx) => { await Promise.all([...]) })`
    is a documented, recommended pattern.

  Transaction-scoped backends now run every statement they issue through a
  per-connection queue. Concurrency at the API surface is unchanged — a
  `Promise.all` of graph writes still works, and on a pooled (non-transactional)
  backend the statements still run genuinely concurrently. The queue serializes
  only what already had to be serial. A multi-statement `SET LOCAL`-scoped vector
  search (snapshot / set / select / restore) runs as one exclusive group, so two
  concurrent searches can no longer interleave and apply each other's `efSearch`.

  The transaction boundary also **drains and closes** the queue before the driver
  emits `COMMIT` / `ROLLBACK`. Those control statements do not travel through the
  queue, so without the drain a rollback could overlap a live statement. And a
  callback that rejects out of a `Promise.all` leaves its siblings running: their
  statements would otherwise land on the connection _after_ the pool had reclaimed
  it, executing inside an unrelated transaction. Such a statement is now refused
  with a new `TransactionClosedError` (normally invisible — `Promise.all` has
  already rejected with the original failure and discards this one).

  **Scope: the queue mediates only TypeGraph's own statements.** The raw Drizzle
  handle exposed as `tx.sql` (for writing your own relational tables in the same
  atomic boundary) bypasses it. Running a raw statement concurrently with a graph
  write — or with another raw statement — still races on the one pinned
  connection, and `drainAndClose` cannot wait for a raw statement it never saw.
  Await each `tx.sql` statement before the next write; this is inherent to a
  single-connection transaction, not something TypeGraph can enforce over a handle
  it doesn't mediate. `adoptTransaction()` likewise serializes the statements it
  issues but never closes the queue — the caller owns that transaction's end.

- [#219](https://github.com/nicia-ai/typegraph/pull/219) [`ee93b77`](https://github.com/nicia-ai/typegraph/commit/ee93b77581e6bcbddccf5256dbb2b321b827e361) Thanks [@pdlug](https://github.com/pdlug)! - Statements whose good plan depends on their parameter values (the
  subgraph id-array fetches, marked internally with the custom-plan
  brand) now opt out of statement preparation per call on the postgres-js
  driver too, via `sql.unsafe(text, params, { prepare: false })`.
  Previously postgres-js prepared them like everything else, so after
  five executions PostgreSQL flipped them to a generic, parameter-blind
  plan — the same cliff fixed for node-postgres in the subgraph
  shared-traversal change (measured there: 21ms → 310ms on the edge
  fetch). Scalar-parameter statements keep the driver's prepared default.

- [#246](https://github.com/nicia-ai/typegraph/pull/246) [`d5aafe8`](https://github.com/nicia-ai/typegraph/commit/d5aafe845f95a503070ac485994afb46b3a82cac) Thanks [@pdlug](https://github.com/pdlug)! - **Critical fix**: `.prepare()`d queries, and any `ExecutableQuery`/`UnionableQuery`/`ExecutableAggregateQuery` instance whose `.execute()` was called more than once, could silently miss rows created after the query was first compiled.

  A "current" (live) temporal-validity read binds its read instant (`currentReadInstant()`) at SQL compile time. All four query-builder classes cached their compiled SQL text across calls — `.prepare()` compiled once and every subsequent `execute({...})` reused that same SQL text, and a reused `ExecutableQuery`/`UnionableQuery`/`ExecutableAggregateQuery` instance cached its first `.execute()`'s compilation the same way. Both patterns froze "now" at the moment of first compilation: any row created afterward had a `valid_from` later than the frozen instant, so `valid_from <= now` silently evaluated to false for it, for the query's entire remaining lifetime.

  This is a regression introduced by the `current-read-app-clock` fix (the [#242](https://github.com/nicia-ai/typegraph/issues/242) clock-skew correction): the prior behavior (`NOW()` / `strftime('now')`, evaluated fresh by the database on every execution) did not have this problem. It is more severe than [#242](https://github.com/nicia-ai/typegraph/issues/242) — that bug required app/DB clock skew across separate hosts; this one reproduces unconditionally, in a single process, on the very next insert after a query is prepared or first executed. `.prepare()`-once-`.execute()`-many is this library's own documented, recommended pattern, so this affected the common case, not an edge case.

  **Fix**: none of the four classes cache compiled SQL text across calls anymore — each `execute()`/`compile()`/`toSQL()` call recompiles fresh, so `currentReadInstant()` is re-evaluated every time. `.prepare()` still builds and structurally validates the query AST once (so a malformed query still fails fast, before the first `execute()`); only the SQL-text compilation moved from prepare-time to each execute-time call. `param()`-bound values are unaffected — those were already correctly re-bound per call.

- [#209](https://github.com/nicia-ai/typegraph/pull/209) [`5e24882`](https://github.com/nicia-ai/typegraph/commit/5e24882536a242d75a2ec9973bfb0301027da92c) Thanks [@pdlug](https://github.com/pdlug)! - perf: facade search candidate handling planned poorly at scale. The hybrid statement's fused CTE is now MATERIALIZED (PostgreSQL inlines single-use CTEs, re-executing the fusion subtree once per candidate node row under a nested-loop join), and unfiltered facade searches use a flat, parameter-bound current-read candidates subquery instead of a compiled builder query whose per-row SQL clock calls dominated on SQLite. Semantics are unchanged — validity windows and tombstones are still enforced, with the instant bound as a parameter. Only searches with a `where` predicate compile a builder query as candidates; `includeSubClasses` expands at the store level and each concrete kind uses the flat form.

- [#202](https://github.com/nicia-ai/typegraph/pull/202) [`b45cfc3`](https://github.com/nicia-ai/typegraph/commit/b45cfc3e6d141a6f037544572f862f00c27d5571) Thanks [@pdlug](https://github.com/pdlug)! - fix: facade search (`store.search.vector` / `fulltext` / `hybrid`) now computes top-k over live nodes in SQL. Previously the search statement ranked side-table rows alone and hydration dropped tombstoned ids afterward, silently returning fewer than `limit` hits under index drift. Liveness is pushed into the KNN/MATCH SQL on every engine — exact on pgvector ≥0.8 (HNSW via `hnsw.iterative_scan = strict_order`; IVFFlat via `ivfflat.iterative_scan = relaxed_order` with an in-statement re-sort), sqlite-vec (vec0 primary-key `IN` pushdown), tsvector, and FTS5; libSQL DiskANN over-fetches 4× and post-filters (documented recall bound).

- [#237](https://github.com/nicia-ai/typegraph/pull/237) [`48f324b`](https://github.com/nicia-ai/typegraph/commit/48f324b905c9d0e2aa52371780e3c443b596040a) Thanks [@pdlug](https://github.com/pdlug)! - Fixes `.select()` query projections losing the `NodeId<N>` brand on node `id`
  fields. Previously `ctx.alias.id` in a `.select()` callback was typed as plain
  `string`, so feeding a projected node id back into `getById`/`getByIds`
  required an unsafe cast (`as never` or worse). `SelectableNode<N>.id` is now
  typed `NodeId<N>`, matching what `getById`/`getByIds` already require — no
  runtime change, no cast needed.

  Edge ids from `.select()` stay plain `string` on purpose: `traverse()`
  defaults to `expand: "inverse"`, which can back an edge alias with a row of
  the registered _inverse_ edge kind, so the alias's static edge type doesn't
  reliably describe the row. Use `asEdgeId` to re-brand a projected edge id
  before a point read.

- [#247](https://github.com/nicia-ai/typegraph/pull/247) [`191e877`](https://github.com/nicia-ai/typegraph/commit/191e877796fde30ad606993948decea7305fd367) Thanks [@pdlug](https://github.com/pdlug)! - Fix: a set operation now binds one "current" read instant across all of its
  operands.

  `UNION` / `INTERSECT` / `EXCEPT` compile each operand independently, and each
  operand compiled its own temporal-validity filter from a fresh `nowIso()`
  sample. A compound `SELECT` is evaluated against a single snapshot, so two
  samples microseconds apart let the two halves of an `INTERSECT` or `EXCEPT`
  disagree about whether a row created between them is current — a row could
  satisfy the left operand's `valid_from <= now` and not the right's.

  Compilation of a set operation (including nested ones) now runs under a single
  pinned instant. Ordinary single-leaf queries were already consistent — they bind
  one instant per compile — and are unaffected.

- [#226](https://github.com/nicia-ai/typegraph/pull/226) [`4cd6b4c`](https://github.com/nicia-ai/typegraph/commit/4cd6b4ca8275c2dad53d85c085347814528b3074) Thanks [@pdlug](https://github.com/pdlug)! - Fixes a scaling bug in the SQLite backend's `refreshStatistics()` (the
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

- [#218](https://github.com/nicia-ai/typegraph/pull/218) [`b601484`](https://github.com/nicia-ai/typegraph/commit/b601484e95f11f61d4b086f493a95e2b0c4f9c18) Thanks [@pdlug](https://github.com/pdlug)! - Non-approximate `.similarTo()` on SQLite now routes through sqlite-vec's
  vec0 KNN form. vec0's KNN is brute-force in C — exact by construction —
  so the default path keeps identical results (pinned against
  JS-computed ground truth) while dropping from the SQL distance scan to
  engine speed: 489ms → 124ms for top-10 over 50k 384-dim embeddings.
  Declared via a new `searchIsExact` flag on the vector-strategy
  contract; pgvector and libSQL leave it unset (their engine forms are
  approximate) and are unchanged. The metric gate still applies: an
  explicit metric override that differs from the slot's declared metric
  falls back to the SQL scan, which is correct for any metric.

- [#211](https://github.com/nicia-ai/typegraph/pull/211) [`a216569`](https://github.com/nicia-ai/typegraph/commit/a21656906eec3cfc532200b1709d6356e6047d71) Thanks [@pdlug](https://github.com/pdlug)! - Subgraph extraction on PostgreSQL now runs the recursive traversal once
  instead of twice. The node and edge fetches previously each embedded the
  full recursive CTE; the closure ids are now fetched in one statement and
  passed to both fetches as a single `text[]` parameter, filtered via an
  `EXISTS` semi-join over `unnest`. Those id-filtered fetches execute as
  unnamed statements so PostgreSQL plans them against the actual array on
  every call — a named prepared statement flips to a generic plan after
  five executions, which mis-plans array-cardinality-dependent filters
  (measured 21ms → 310ms on the edge fetch). Depth-3 stress subgraph
  (1,109 nodes / 4,513 edges, wide payloads): 82.9ms → 30.9ms full
  hydration, 72.3ms → 15.6ms with SQL projection. SQLite keeps its
  existing single-statement-per-fetch form, which is already optimal for
  an in-process engine.

- [#234](https://github.com/nicia-ai/typegraph/pull/234) [`d042a30`](https://github.com/nicia-ai/typegraph/commit/d042a304979ea32f5777480b2cd28a8a02b1f339) Thanks [@pdlug](https://github.com/pdlug)! - perf: push selected top-level `props` field extractions into the
  start/traversal CTEs instead of carrying the whole raw `props` JSONB/JSON
  column outward for later extraction at the final projection. Each
  selected field is extracted once, inline, as its own typed CTE column
  (named from a length-prefixed encoding of its alias and field, so
  distinct alias/field pairs can never collide on the same column name);
  the outer projection and any matching `ORDER BY` on the same field just
  reference that column directly instead of re-extracting from a
  carried-forward `<alias>_props` column.

  Found while investigating why a covering index on a system column (see
  `keySystemColumns`) still couldn't get Postgres to serve an indexed join
  index-only: the compiled query was asking for the entire `props` column
  in the join step even though the final `.select()` only needed one
  extracted field, so the specific indexed expression was never actually
  what got read from the table. No behavior change: compiled query results
  are identical; this only changes which columns each CTE carries and
  where field extraction happens.

- [#242](https://github.com/nicia-ai/typegraph/pull/242) [`6b884b6`](https://github.com/nicia-ai/typegraph/commit/6b884b66b3f642bfc2a65064f51c63ce317c4cc9) Thanks [@pdlug](https://github.com/pdlug)! - Fix: creating a node or edge without an explicit `validFrom` now stamps the
  operation's own creation timestamp instead of storing SQL `NULL`.

  `NULL` is interpreted by temporal filters as open-left validity ("valid
  since forever"), so a record created without `validFrom` was visible at
  _any_ historical `asOf` instant — including ones before the record existed.
  This contradicted the documented contract ("omitted `validFrom` defaults to
  now") and is fixed at the insert layer for every write path: `create`,
  `createFromRecord`, `upsertById`/`upsertByIdFromRecord` (create branch),
  `bulkCreate`, `bulkInsert`, `bulkUpsertById`, and get-or-create, for both
  nodes and edges.

  `branch()`'s working-copy clone now also exports with `includeTemporal:
true`, so a fork's `validFrom`/`validTo` exactly match the base's — without
  this, the clone would re-stamp any implicit `validFrom` to the fork's own
  (later) creation time, narrowing the fork's valid-time window relative to
  the base it was cloned from. This includes rows that still have a `NULL`
  `valid_from` (predating this fix, or written directly via the backend):
  `exportGraph`/`importGraph` now round-trip a confirmed open-left window as
  an explicit `null` rather than silently dropping it, so a legacy row's
  "valid since forever" semantics survive a clone unchanged instead of being
  narrowed to the clone's own creation time.

  `exportGraph`/`importGraph` round trips still default `includeTemporal` to
  `false`; without it, imported records get a fresh `validFrom` at import
  time rather than the source's original value (see the Interchange docs).

  Custom `GraphBackend` implementations that build their own inserts (rather
  than reusing the bundled Drizzle operation builders) should apply the same
  rule: an omitted `validFrom` defaults to the row's creation instant, and an
  explicit `null` is preserved as SQL `NULL` (open-left).

- [#214](https://github.com/nicia-ai/typegraph/pull/214) [`583fbb3`](https://github.com/nicia-ai/typegraph/commit/583fbb3782d78b16e07f92082da37ab299c3d966) Thanks [@pdlug](https://github.com/pdlug)! - PostgreSQL ANN index builds (`materializeIndexes()` on pgvector
  HNSW/IVFFlat) now retry serially when the parallel build exhausts
  shared memory. Parallel builds stage the index graph in dynamic shared
  memory, and resource-constrained hosts — e.g. containers with the 64MB
  `/dev/shm` default — reject the allocation with SQLSTATE class 53
  (observed: 53100 from `dsm_impl_posix` on a 50k x 384-dim HNSW build).
  The retry drops the INVALID leftover from the failed CONCURRENTLY
  build, pins the vector table to `parallel_workers = 0`, rebuilds in
  local memory, and restores the setting. Non-resource failures still
  surface as before. Serial builds are slower — raise `/dev/shm` and
  `maintenance_work_mem` where you control the host — but a slow index
  beats a silently missing one.

## 0.34.0

### Minor Changes

- [#188](https://github.com/nicia-ai/typegraph/pull/188) [`0b0f4ea`](https://github.com/nicia-ai/typegraph/commit/0b0f4ea23ee2310cc2c160d24385eb94ebfdc5a8) Thanks [@pdlug](https://github.com/pdlug)! - Add the `@nicia-ai/typegraph/provenance` subpath for provenance-backed source
  retraction. The first slice maps user graph kinds to source, justification,
  fact, premise, and derivation roles; supports multiple source node kinds and
  terminal fact kinds; requires `{ history: true }`; applies TypeGraph-managed
  belief transitions by making unsupported facts non-current; and keeps
  recorded-time replay available before and after retraction. A transition only
  touches facts reachable from the flipped sources, and closing a fact's currency
  is a belief-status change rather than a domain delete — the fact's edges are
  left untouched (no `restrict`/`cascade`/`disconnect` enforcement), so
  `unRetract` is an exact inverse of `retract`. PostgreSQL transitions serialize
  with TypeGraph-managed history writes on the same graph; out-of-band SQL
  remains outside recorded capture.

### Patch Changes

- [#188](https://github.com/nicia-ai/typegraph/pull/188) [`0b0f4ea`](https://github.com/nicia-ai/typegraph/commit/0b0f4ea23ee2310cc2c160d24385eb94ebfdc5a8) Thanks [@pdlug](https://github.com/pdlug)! - Stop opening a write transaction on `getOrCreateByConstraint`'s found path.
  The single-item node getOrCreate wrapped its whole body — probe included — in
  a transaction, so the common "already exists" case paid for `BEGIN IMMEDIATE`
  on SQLite (and, under history capture, the per-graph advisory lock on
  Postgres), and the nested create's operation hooks fired inside that outer
  transaction, reporting success before a COMMIT that could still fail. The
  probe now runs as a pure read; the create and update/resurrect legs each open
  their own (hooked) transaction, so `onOperationEnd` means durably committed. A
  concurrent create that reserves the key between the probe and the insert
  surfaces as a uniqueness conflict and is converged by a single re-probe. The
  bulk variant keeps its one enclosing transaction (atomic batch, hooks skipped
  by design). Edge `getOrCreateByEndpoints` gets the same probe-first shape.

- [#191](https://github.com/nicia-ai/typegraph/pull/191) [`2cad229`](https://github.com/nicia-ai/typegraph/commit/2cad2293f2d937aff7f53a1318525814eeb05533) Thanks [@pdlug](https://github.com/pdlug)! - Guard `mergeIncremental()` against inherited-row lost updates. The incremental
  commit path re-checked new-row identity resolution and per-row resurrect/strip
  hazards, but not whether a committed row the plan mutates still held the value
  the plan merged against — so a concurrent write to an inherited row between
  planning (reads taken outside the transaction) and commit was silently
  discarded. The commit now re-reads, in-transaction, every committed target row
  the plan will change and aborts with a retryable `BaseVersionMismatchError` if it
  drifted, matching the snapshot merge path's TOCTOU contract. This covers all four
  mutating paths: node writes and node deletions (checked by `version`), and edge
  upserts and edge deletions (checked by a content signature over endpoints,
  liveness, and canonical props, since edges carry no version column).

- [#188](https://github.com/nicia-ai/typegraph/pull/188) [`0b0f4ea`](https://github.com/nicia-ai/typegraph/commit/0b0f4ea23ee2310cc2c160d24385eb94ebfdc5a8) Thanks [@pdlug](https://github.com/pdlug)! - `importGraph(..., { onConflict: "update" })` now skips soft-deleted target rows
  instead of failing. Import never resurrects a tombstone: a node or edge that
  exists only as a tombstone counts as `skipped`, keeps its tombstone, and gets no
  uniqueness/embedding/fulltext side effects (a uniqueness reservation held by a
  tombstoned node would block live creates of the same value). Previously the
  update path attempted a live-row update that threw and aborted the whole
  import. `onUnknownProperty: "allow"` is also pinned as the fidelity-preserving
  strategy: it validates known fields but persists the given properties
  byte-for-byte — no transform re-application, no default injection — so an
  export→import round trip cannot corrupt values whose schema transforms are not
  idempotent; use `"strip"` for a normalizing import.

- [#188](https://github.com/nicia-ai/typegraph/pull/188) [`0b0f4ea`](https://github.com/nicia-ai/typegraph/commit/0b0f4ea23ee2310cc2c160d24385eb94ebfdc5a8) Thanks [@pdlug](https://github.com/pdlug)! - Fix a uniqueness-reservation corruption on a conflicting node update.
  `updateUniquenessEntries` mutated one constraint's sidecar at a time — releasing
  the old key before proving the new one free — so a caller that catches the
  resulting `UniquenessError` and still commits the transaction (notably
  `importGraph(..., { onConflict: "update" })`, which reports the conflict per row)
  left the node's already-mutated sidecars in a corrupt state: an earlier
  constraint's old key released (letting a later create silently duplicate it) or a
  new key wrongly reserved, while the row itself stayed unchanged. The update now
  runs in two passes — preflight every changed constraint's new key first, then
  apply all sidecar deletes and inserts only after every key is proven free — so a
  conflict throws with zero partial writes, for every caller of the shared
  node-write pipeline and for nodes with any number of unique constraints.

- [#188](https://github.com/nicia-ai/typegraph/pull/188) [`0b0f4ea`](https://github.com/nicia-ai/typegraph/commit/0b0f4ea23ee2310cc2c160d24385eb94ebfdc5a8) Thanks [@pdlug](https://github.com/pdlug)! - Make in-memory libsql databases safe across transactions, and fail loud on
  re-entrant root access. Local `@libsql/client` connections (`file:` paths and
  `file::memory:`) now frame transactions with raw `BEGIN IMMEDIATE`/`COMMIT` on
  the client's single stable connection instead of `client.transaction()`, which
  permanently hands that connection to the transaction and lazily opens a fresh —
  for `:memory:`, empty — database afterwards
  (tursodatabase/libsql-client-ts#229). Remote Turso connections keep using the
  driver's per-stream transactions. Separately, a store-level operation awaited
  from inside a `store.transaction` callback on the same SQLite backend (root
  store instead of the `tx` context) used to deadlock permanently — the open
  transaction holds the backend's serialized execution slot — and is now rejected
  with a `ConfigurationError` that points at the transaction-scoped context.

- [#189](https://github.com/nicia-ai/typegraph/pull/189) [`fe21158`](https://github.com/nicia-ai/typegraph/commit/fe2115836d084a86613ae94a4403651d8316713a) Thanks [@pdlug](https://github.com/pdlug)! - Classify incompatible property-schema changes as breaking schema migrations. The
  migration diff previously compared only the top-level JSON-Schema token of each
  property, so a changed property type (e.g. `string` → `number`), a changed array
  item type (`string[]` → `number[]`), a narrowed enum, or a type change nested
  inside an object all auto-migrated silently as a non-blocking warning, leaving
  stored rows that no longer satisfy the declared schema; edge property changes
  were unconditionally treated as safe. Node and edge property diffs now share one
  recursive, conservative classifier: a change is `safe` only when it can be proven
  non-breaking (a new optional property, a metadata-only edit, or an additive
  optional field nested inside an object). Everything else — a removed property, a
  newly required property, an in-place type change, a changed array item schema, an
  enum/const/composition change, a same-type constraint change, or a breaking
  change nested inside an object — is `breaking` and blocks auto-migration. The
  `warning` severity is no longer emitted for property changes.

- [#190](https://github.com/nicia-ai/typegraph/pull/190) [`1bfa9c2`](https://github.com/nicia-ai/typegraph/commit/1bfa9c28d04f03b9f82e23bf0a97417aba544767) Thanks [@pdlug](https://github.com/pdlug)! - Fix two silent query-correctness bugs. Keyset pagination (`paginate`/`stream`)
  now appends a unique `id` tiebreaker to the ORDER BY so a non-unique sort no
  longer drops equal-key rows across pages. And every compiled `LIKE`/`ILIKE` now
  emits `ESCAPE '\'` — including the case-sensitive `like` path, which previously
  omitted it — so escaped `%`/`_`/`\` match literally on SQLite as they already
  did on PostgreSQL, in both the auto-escaped operators
  (`contains`/`startsWith`/`endsWith`) and raw `like`/`ilike` patterns, and
  whether the pattern is a literal or a bound parameter (previously SQLite had no
  default LIKE escape character, so the two backends — and the direct vs prepared
  paths — diverged).

- [#188](https://github.com/nicia-ai/typegraph/pull/188) [`0b0f4ea`](https://github.com/nicia-ai/typegraph/commit/0b0f4ea23ee2310cc2c160d24385eb94ebfdc5a8) Thanks [@pdlug](https://github.com/pdlug)! - Fix a uniqueness-reservation loss on node resurrection. Resurrecting a
  soft-deleted node through `getOrCreateByConstraint` (or any
  `clearDeleted: true` upsert) ran the diff-based uniqueness maintenance, which
  skips a key that did not change — but the soft delete had already removed the
  node's uniqueness entries, so the resurrected node held NO reservation and a
  later `create` with the same unique value silently succeeded, duplicating it.
  A resurrecting update now re-checks and re-inserts the entries for its new
  props, exactly as the provenance reopen path does.

- [#188](https://github.com/nicia-ai/typegraph/pull/188) [`0b0f4ea`](https://github.com/nicia-ai/typegraph/commit/0b0f4ea23ee2310cc2c160d24385eb94ebfdc5a8) Thanks [@pdlug](https://github.com/pdlug)! - Open SQLite business-write transactions with `BEGIN IMMEDIATE` on the sync
  (better-sqlite3) path, matching schema writes and the async libsql/Drizzle path.
  A deferred `BEGIN` acquired the reserved write lock only on the first write, so a
  read-then-write inside a transaction could fail with "database is locked" against
  a writer on another connection to the same file; taking the lock at the start of
  the transaction lets SQLite's busy timeout wait for it instead. The per-backend
  serialized write queue continues to order a single backend's own transactions.

- [#192](https://github.com/nicia-ai/typegraph/pull/192) [`2af3a06`](https://github.com/nicia-ai/typegraph/commit/2af3a065d9d54b0ac89c32dc27d637a4eedc58cf) Thanks [@pdlug](https://github.com/pdlug)! - Type-check the remaining StoreView read-name buckets. `CURRENT_ONLY_READ_NAMES`
  and `EDGE_BATCH_READ_NAMES` were plain `as const` arrays while every sibling
  bucket carried a `satisfies readonly (keyof Collection)[]` guard, so a renamed
  or mistyped method in those two would have gone uncaught at compile time. All
  six buckets are now checked against the live collection keys. Compile-time only.

- [#188](https://github.com/nicia-ai/typegraph/pull/188) [`0b0f4ea`](https://github.com/nicia-ai/typegraph/commit/0b0f4ea23ee2310cc2c160d24385eb94ebfdc5a8) Thanks [@pdlug](https://github.com/pdlug)! - Operation hooks now mean "durably committed" everywhere. `onOperationEnd`
  previously fired when an operation completed, even when that operation ran
  inside an enclosing transaction whose COMMIT later failed — so hook consumers
  (metrics, cache invalidation, audit logs) were told a rolled-back write
  succeeded. Operations inside `store.transaction` now defer their success
  hooks until the transaction commits, and a failed transaction converts every
  completed operation's pending success into `onError`. Edge
  `getOrCreateByEndpoints` no longer wraps its write legs in an outer
  transaction (each leg commits — and reports — on its own, with a
  probe/create race converged by one retry), and provenance transitions route
  their source-flip and per-fact hooks through the same deferred lifecycle.
  Inside an adopted transaction (`withTransaction` /
  `withRecordedTransaction`) the commit belongs to the caller and cannot be
  observed; hooks there keep firing at operation completion, as documented.

## 0.33.0

### Minor Changes

- [#186](https://github.com/nicia-ai/typegraph/pull/186) [`655407a`](https://github.com/nicia-ai/typegraph/commit/655407a9c225e8eca0aff5f636ed17ca99f3e382) Thanks [@pdlug](https://github.com/pdlug)! - Add recorded / system-time capture — TypeGraph's second temporal axis. Where valid time (`validFrom` / `validTo`, queried via `asOf` / `includeEnded`) records _when a fact was true in the world_, recorded time records _when TypeGraph captured a managed node/edge write_. Together they answer "what did TypeGraph reconstruct as true, as of a captured commit instant?" — surfacing values that were later corrected (à la SQL:2011 system-versioned tables).

  Enable capture per store with `createStore(graph, backend, { history: true })`. TypeGraph collection writes through that store are then captured into recorded-time relations (`typegraph_recorded_nodes` / `typegraph_recorded_edges`), stamped with a per-graph monotonic commit instant from a `typegraph_recorded_clock` (serialized on PostgreSQL via a per-graph advisory lock). Capture is opt-in and has **no backfill** — enable it on a fresh graph, since an entity that already exists is first recorded the next time it is written. It requires a transactional backend with statement execution (the built-in SQLite / PostgreSQL backends).

  Read at a recorded instant with `store.asOfRecorded(T)`, which returns a narrow read-only `RecordedStoreView`. Direct `store.asOfRecorded(T)` is diagonal bitemporal sugar (recorded _and_ valid axes both at `T`); chain `store.asOf(validT).asOfRecorded(recordedT)` to pin the two axes independently, or `store.view({ mode }).asOfRecorded(recordedT)` to compose recorded time with any valid-time mode (e.g. `includeTombstones`). `store.recordedNow()` returns the recorded high-water mark; after guarding the `undefined` case, passing that value to `store.asOfRecorded(...)` is a deterministic "as things stand now" anchor. Recorded instants are monotonic and can run briefly ahead of wall-clock time under bursty writes, so the wall clock is not a reliable anchor right after a write.

  The recorded view is a **reconstructing** lens that exposes only reads which can be faithfully rebuilt from the history relations: point reads (`nodes.<Kind>.getById` / `getByIds` and the edge equivalents), a sealed `query()`, `subgraph()`, and the graph algorithms (`reachable` / `canReach` / `shortestPath` / `degree`). Broad collection reads (`find` / `count` / `findFrom`), `search`, and fulltext / vector predicates refuse with a `ConfigurationError` / `UnsupportedPredicateError` — those indexes reflect current state only. `T` must be a canonical UTC ISO-8601 timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`).

  The public live-read and algorithm option types explicitly reject internal recorded coordinates, while recorded internals use a branded `RecordedInstant` so only validated canonical recorded instants can flow through the reconstructing paths.

  Recorded read binding is now explicit without exposing TypeGraph's internal capture binding. `history: true` enables TypeGraph-managed capture and binds the built-in recorded relations internally, while the factory-branded `recordedRelation({ schema })` / `recordedRead` path is the external-read-source API for hosts that populate a row-compatible recorded relation outside TypeGraph's writer wrapper. The store validates that runtime `recordedRead` values come from `recordedRelation({ schema })`, rejects `recordedRead` combined with `history: true`, and factory-brands/freezes SQL schema and recorded-read descriptors so they cannot be structurally forged as plain objects. Store overloads reflect that split: history-enabled stores expose `HistoryStore`, read-bound live stores expose `RecordedReadStore`, and captured-history stores expose `HistorySafeBackend` / `HistoryTransactionContext` types that hide raw statement / DDL write seams from the typed `backend`, `transaction()`, and `withRecordedTransaction()` surfaces.

  Writes under `history: true` flush capture at transaction commit, so they must go through the typed collections: raw `tx.sql` is disabled (it would bypass capture), and `store.withTransaction(externalTx)` is replaced by the callback form `store.withRecordedTransaction(externalTx, async (tx) => ...)`, which gives capture a flush point before the caller commits. `store.clear()` clears the recorded relations alongside the live tables.

  Node creates now run atomically on transactional backends with uniqueness, vector, and fulltext finalization, and node delete cascades now run atomically even without `history: true`. A failed finalize step rolls back the node row instead of leaving a partially indexed row behind. Overlapping PostgreSQL cascades may hold locks longer, so callers should keep normal deadlock-retry handling around concurrent deletes.

  Backend and SQL execution contracts are more explicit for maintainers and extension authors: backend role brands separate graph-write paths from raw/bulk paths, `execute` / `executeStatement` now require row-vs-statement SQL intent brands, transaction backends are composed from explicit backend facets instead of `Omit<GraphBackend, ...>`, and backend wrappers use an exact overlay helper that preserves prototype/proxy backends while catching typoed override keys at compile time.

  Exports `RecordedStoreView` and its collection types (`RecordedStoreViewNodeCollection` / `RecordedStoreViewNodeCollections`, `RecordedStoreViewEdgeCollection` / `RecordedStoreViewEdgeCollections`, `TypedRecordedStoreViewEdgeCollection`).

  **Performance:** recorded reads reconstruct from the history relations rather than the live tables, so they are slower than current-state reads — most noticeably for full-graph `subgraph` / algorithm reconstructions on PostgreSQL. Use `asOfRecorded` for audit and point-in-time reconstruction, not hot-path reads.

## 0.32.0

### Minor Changes

- [#182](https://github.com/nicia-ai/typegraph/pull/182) [`0f0e771`](https://github.com/nicia-ai/typegraph/commit/0f0e77161d473b5c3b2d2e224d930c611eb4b123) Thanks [@pdlug](https://github.com/pdlug)! - Close the TOCTOU windows in graph-merge commits. A merge resolves its plan from reads taken before the commit transaction, so a write landing on the target in between could previously be committed over. Now, inside the commit transaction: `merge()` and `mergeAgainstBase()` re-validate the target's base@V content fingerprint, and `mergeIncremental()` re-runs its new-vs-base identity resolution (the unique-constraint and block-index probes). All three fail with `BaseVersionMismatchError` — instead of committing a stale plan or a duplicate entity — when the target changed in that window. Merge commits run at `SERIALIZABLE` isolation with bounded retry on serialization failures and deadlocks, making the guards race-free on multi-writer Postgres. `Store.transaction()` accepts optional `TransactionOptions` (isolation level) and `TransactionContext` exposes the transaction-scoped `backend`.

- [#185](https://github.com/nicia-ai/typegraph/pull/185) [`4e23be8`](https://github.com/nicia-ai/typegraph/commit/4e23be8d6af94b965bdcf90e911dc0e1c49d2bad) Thanks [@pdlug](https://github.com/pdlug)! - Add `StoreView`, a read-only `(mode, asOf)` lens over a `Store` that pins a temporal coordinate and routes every supported read through it (the as-of database value, à la Datomic `(d/as-of db t)` / SQL:2011 `FOR SYSTEM_TIME AS OF`). Construct one with `store.asOf(T)` (valid-time) or `store.view({ mode, asOf })` for the other public modes (`current` / `includeEnded` / `includeTombstones`). The view exposes pinned `nodes` / `edges` collections (`getById` / `getByIds` / `find` / `count`, edge `findFrom` / `findTo`), a pre-pinned `query()`, `subgraph()`, and the graph algorithms (`reachable` / `canReach` / `shortestPath` / `neighbors` / `degree`). It is read-only by construction — writes and temporally-unscoped reads refuse with a clear error — and `search` refuses on a non-`current` pin (the fulltext / vector index reflects current state only).

  Internally every pinned surface injects a single opaque `ReadCoordinate` through one helper, so a future temporal axis (recorded / system time) lands on every surface at once instead of splitting per surface. The view's read surface is derived from a read/write split of the live collection types (`NodeTemporalReads` / `NodeCurrentReads` / `NodeWrites` and edge equivalents, now exported) with a `test-d` conformance check, so a new collection read cannot silently bypass the view's pinning decision.

  - **`store.snapshot()`.** Sugar for `store.asOf(new Date().toISOString())` — a read-only view pinned to the current instant captured once at construction. Unlike `store.view({ mode: "current" })` (which tracks "now" live), a snapshot is a stable point-in-time value where every surface observes the same instant. Mirrors Datomic's `(d/db conn)`.
  - **Sealed pinned query.** `view.query()` now returns a query builder whose temporal axis is sealed — calling `.temporal(...)` on it throws — so a pinned view cannot be silently re-coordinated per query.
  - **Current-only reads.** Constraint / index lookups (`findByConstraint`, `bulkFindByConstraint`, `bulkFindByIndex`), which have no temporal axis, are now available on a `current` view (delegating to the live store) and refuse with a clear error on a temporal pin — instead of being unavailable on every view.

  **Breaking — `find` / `count` signature:** `store.nodes.<kind>.find(...)` / `count(...)` and `store.edges.<kind>.find(...)` / `count(...)` now take the temporal coordinate as a **second** argument rather than inline in the filter object: `find(filter?, temporal?)` / `count(filter?, temporal?)`. For example, `nodes.Person.find({ where, temporalMode: "asOf", asOf })` becomes `nodes.Person.find({ where }, { temporalMode: "asOf", asOf })`, and `edges.worksAt.count({ temporalMode: "includeEnded" })` becomes `edges.worksAt.count(undefined, { temporalMode: "includeEnded" })`. Old call sites that inlined `temporalMode` / `asOf` are now type errors. `getById` / `getByIds` / `findFrom` / `findTo` / node `count` are unchanged (they already took a trailing temporal argument).

  **Breaking — canonical `validFrom` / `validTo` on write:** `create` / `update` / `bulk*` now require canonical fixed-width UTC ISO timestamps (`YYYY-MM-DDTHH:mm:ss.sssZ`) for `validFrom` / `validTo`, rejecting date-only, zoned-offset, variable/missing-millisecond, and rollover values with a `ValidationError`. This makes the _stored_ values that temporal filters compare as text always sort chronologically — the same contract the `asOf` read coordinate already enforces, applied uniformly to every timestamp in the system. Convert non-canonical inputs with `new Date(value).toISOString()`. There is no migration: pre-existing non-canonical rows are left as-is (recreate them if affected) — acceptable pre-1.0.

  **Behavior change:** `store.edges.<kind>.findFrom(...)` / `findTo(...)` / `findByEndpoints(...)` (and their `batchFindFrom` / `batchFindTo` / `batchFindByEndpoints` variants) now honor the temporal model like `getById` / `find` instead of returning every non-soft-deleted edge. With no temporal argument, the graph's default `temporalMode` applies — so under the default `"current"` mode, edges outside their `validFrom` / `validTo` window are now excluded. Pass `temporalMode` / `asOf` to read at another coordinate (e.g. `temporalMode: "includeEnded"` to recover the previous "all non-deleted" behavior). `findByEndpoints` / `batchFindByEndpoints` gain a trailing `temporal?` argument and are now pinnable on a `StoreView` (no longer refused on a temporal pin). The internal `getOrCreate*ByEndpoints` identity lookup is unaffected — it deliberately matches against all edges regardless of validity window.

  **Read coordinates:** `asOf`, `.temporal("asOf", T)`, algorithms, subgraph, and `StoreView` require canonical UTC ISO timestamps (`YYYY-MM-DDTHH:mm:ss.sssZ`) for the same lexicographic-comparison reason.

## 0.31.0

### Minor Changes

- [#178](https://github.com/nicia-ai/typegraph/pull/178) [`6b6e418`](https://github.com/nicia-ai/typegraph/commit/6b6e4186642c65d58c939250458b6521efbc40c7) Thanks [@pdlug](https://github.com/pdlug)! - Add `@nicia-ai/typegraph/graph-merge`, a TypeGraph-native branch and semantic merge subpath for deterministic entity-resolution merges across graph forks.

## 0.30.0

### Minor Changes

- [#171](https://github.com/nicia-ai/typegraph/pull/171) [`f5defd3`](https://github.com/nicia-ai/typegraph/commit/f5defd35b331e56f282d4eb501b98d3b9affe562) Thanks [@pdlug](https://github.com/pdlug)! - Add `store.nodes.<Kind>.bulkFindByIndex(indexName, items, options?)` — batched candidate retrieval against declared node indexes, including non-unique ones. For each input record it returns the live nodes that share that record's declared index key, for import reconciliation, dedup-candidate discovery, and joining records against the graph by a composite key. Each input yields its own array (candidate retrieval, not a uniqueness guarantee); buckets preserve input order and are ordered by node id.

  TypeGraph owns the index semantics: keys are computed from `index.fields` only (reusing the index's own extraction expressions), the partial `where` is applied to stored rows, and a missing/`undefined` indexed field matches a stored `NULL` via a new null-safe-equality dialect adapter. An optional `limitPerInput` caps each bucket — in SQL via `ROW_NUMBER()` when the backend supports window functions, otherwise capped in memory with the same result. Date-typed key fields are rejected with `ConfigurationError` because they can't compare identically across SQLite and PostgreSQL. Unknown index names throw `NodeIndexNotFoundError`.

  `createLocalSqliteBackend` also gains a `capabilities` override for simulating engine capability gaps (e.g. `windowFunctions: false`) in tests.

- [#173](https://github.com/nicia-ai/typegraph/pull/173) [`bd96cfb`](https://github.com/nicia-ai/typegraph/commit/bd96cfbeadde11c6986fb667f9a86b0ba0b5b1bd) Thanks [@pdlug](https://github.com/pdlug)! - Add the `backend.capabilities.windowFunctions` capability and reject relevance-ranking queries before SQL generation when a custom backend profile disables SQL window functions.

## 0.29.0

### Minor Changes

- [#161](https://github.com/nicia-ai/typegraph/pull/161) [`9e86269`](https://github.com/nicia-ai/typegraph/commit/9e862695c6a3341af5d8acbd4f652738bd7727ca) Thanks [@pdlug](https://github.com/pdlug)! - Add cross-backend vector and hybrid search through a pluggable
  `VectorStrategy`, closing [#157](https://github.com/nicia-ai/typegraph/issues/157). TypeGraph now has first-class vector storage and
  search for libSQL/Turso, sqlite-vec, and pgvector behind the same semantic
  search APIs.

  Backend highlights:
  - libSQL/Turso stores fixed-dimension embeddings in `F32_BLOB(N)` columns,
    supports cosine/L2 search, and can use DiskANN through `libsql_vector_idx`
    and `vector_top_k`.
  - sqlite-vec uses `vec0` KNN tables instead of brute-force vector scans.
  - pgvector uses graph-scoped, per-field `vector(N)` tables with HNSW/IVFFlat
    materialization.
  - Backends advertise vector metrics, index types, and dimension limits from the
    active strategy, and `createSqliteBackend` / `createPostgresBackend` accept a
    custom `vector?: VectorStrategy`.

  The release also adds migration and lifecycle tooling for the new storage model:
  - `migrateLegacyEmbeddings(...)` copies existing rows out of the legacy shared
    `typegraph_node_embeddings` table.
  - `store.reembedVectorField(kind, fieldPath, { embed? })` recreates a field's
    storage after an embedding dimension change and can re-embed existing rows.
  - `store.materializeRemovals()` reclaims vector tables for removed embedding
    fields and reports them in `MaterializeRemovalsResult.reclaimedVectorFields`.

  **Breaking storage change:** vector embeddings now live in graph-scoped,
  fixed-dimension per-field storage instead of the shared
  `typegraph_node_embeddings` table. Search no longer reads the legacy table.
  Deployments with existing embeddings must run `migrateLegacyEmbeddings(...)`
  once after upgrading; deployments without stored embeddings need no migration.

- [#165](https://github.com/nicia-ai/typegraph/pull/165) [`ae5bfdc`](https://github.com/nicia-ai/typegraph/commit/ae5bfdc55aae3531bcd75f0770cb2812ad9682d9) Thanks [@pdlug](https://github.com/pdlug)! - Reduce `BackendCapabilities` to the flags the library actually consumes:
  `transactions`, `vector`, and `fulltext`.

  The descriptive-only flags `jsonb`, `ginIndexes`, `partialIndexes`, `cte`, and
  `returning` were never read anywhere to gate a query feature or pick an index
  strategy. `jsonb`/`ginIndexes` additionally misrepresented SQLite, which has
  native JSON (`json_extract`/`json_each`) and supports B-tree expression indexes
  on scalar JSON properties at parity with PostgreSQL — the only real JSON
  difference (GIN containment acceleration) is a Postgres performance
  characteristic, not a gated capability.

  If you were reading any of these removed flags, branch on
  `backend.dialect === "postgres"` instead, or rely on the dialect layer
  (JSON-path predicates, `WITH` queries, `RETURNING`, partial indexes, and
  `defineNodeIndex`/`defineEdgeIndex` work the same on both backends).

- [#163](https://github.com/nicia-ai/typegraph/pull/163) [`0175a25`](https://github.com/nicia-ai/typegraph/commit/0175a2585029aa1b6ceabc9889074a72b8895d03) Thanks [@pdlug](https://github.com/pdlug)! - Add first-class support for [PGlite](https://pglite.dev/) (Postgres-in-WASM),
  closing [#160](https://github.com/nicia-ai/typegraph/issues/160).
  - **Execution fast-path fix.** `createPostgresBackend` now detects a PGlite
    `db.$client` and routes it to the unnamed positional query wrapper. PGlite's
    `.query` has no node-postgres named-statement config form — passing one
    desyncs its single connection (`08P01`), so under the default
    `prepareStatements: true` every query previously failed. PGlite works
    unchanged with `createPostgresBackend(drizzle(pglite))` now.
  - **`createLocalPgliteBackend`** — a batteries-included helper under the new
    `@nicia-ai/typegraph/postgres/pglite` entry, the Postgres analog of
    `createLocalSqliteBackend`. It constructs an in-process PGlite engine
    (in-memory by default, or any `dataDir`), loads pgvector, runs the schema
    DDL, and returns `{ backend, db, client }` whose `close()` disposes the
    engine. Pass `vector: false` to skip the extension, or `vector: <Extension>`
    to bring your own pgvector build.

  `@electric-sql/pglite` (and, for vector support, `@electric-sql/pglite-pgvector`
  on PGlite ≥ 0.5) are optional peer dependencies. The biggest payoff: the
  Postgres dialect and pgvector path can now be exercised in plain `pnpm test`
  with zero Docker.

- [#162](https://github.com/nicia-ai/typegraph/pull/162) [`48a6ffc`](https://github.com/nicia-ai/typegraph/commit/48a6ffc3e63459e7a2535a936a8c9c3fbcd29a99) Thanks [@pdlug](https://github.com/pdlug)! - Add `vector: false` to `createPostgresBackend` to disable the vector stack.

  The Postgres backend wires `pgvectorStrategy` by default, assuming a standalone
  Postgres server has the pgvector extension installed. An in-process Postgres
  (PGlite) built without that extension can't honor it — the default strategy's
  `vector(N)` DDL hard-fails the moment an embedding is written or
  `CREATE EXTENSION vector` runs. Passing `vector: false` turns the stack off:
  the backend advertises no `capabilities.vector` and omits the
  embedding/search methods, mirroring a SQLite connection without sqlite-vec, so
  the store never routes vector work to it.

  Real-Postgres behavior is unchanged — the default remains `pgvectorStrategy`.

- [#158](https://github.com/nicia-ai/typegraph/pull/158) [`bc07847`](https://github.com/nicia-ai/typegraph/commit/bc07847cbde20eedd01781062e0403856cb46079) Thanks [@pdlug](https://github.com/pdlug)! - Export the ontology transitive-closure utilities (`computeTransitiveClosure`, `invertClosure`, `isReachable`) from the package root. These were previously internal-only. Exposing them lets consumers reason over `subClassOf` / `equivalentTo` hierarchies — e.g. reconciling node types when merging graphs from independent sources.

- [#166](https://github.com/nicia-ai/typegraph/pull/166) [`a32d31f`](https://github.com/nicia-ai/typegraph/commit/a32d31f7bbe9fc4657eb956e86900eaf1c283ef9) Thanks [@pdlug](https://github.com/pdlug)! - Remove the `typegraph-cloud` source type from the interchange
  `GraphDataSourceSchema`.

  TypeGraph Cloud is not a publicly available product, so the `typegraph-cloud`
  variant has been dropped from the graph-data source discriminated union, and the
  corresponding interchange documentation has been removed. `GraphDataSource` now
  accepts only `typegraph-export` and `external`.

  **Breaking:** importing data whose `source.type` is `"typegraph-cloud"` now
  fails schema validation. Re-tag such payloads as `"external"` before importing.

- [#165](https://github.com/nicia-ai/typegraph/pull/165) [`ae5bfdc`](https://github.com/nicia-ai/typegraph/commit/ae5bfdc55aae3531bcd75f0770cb2812ad9682d9) Thanks [@pdlug](https://github.com/pdlug)! - Support the full query feature set inside SQLite set operations
  (`UNION`/`UNION ALL`/`INTERSECT`/`EXCEPT`).

  Previously the SQLite set-operation compiler hand-rolled a thin subset of leaf
  compilation and rejected leaves that used traversals, `EXISTS`/`IN` subqueries,
  vector or fulltext predicates, `GROUP BY`/`HAVING`, or per-leaf
  `ORDER BY`/`LIMIT`/`OFFSET` — throwing `UnsupportedPredicateError` at execution
  time. PostgreSQL accepted all of these. The result was a portability cliff: a
  combined query developed against PostgreSQL could throw the moment the backend
  was switched to SQLite.

  Both dialects now compile every leaf with the full query compiler and only
  differ in how each operand is wrapped. SQLite forbids parenthesized compound
  operands, but it does allow a `WITH` clause inside a FROM-subquery, so each
  operand is emitted as `SELECT * FROM (<leaf>)`. This keeps every leaf's CTEs
  (traversal joins, recursive expansions, vector/fulltext relevance) scoped to its
  own subquery and lets per-leaf `ORDER BY`/`LIMIT`/`OFFSET` live inside the wrap.
  Nested set operations are wrapped the same way, preserving the AST's grouping
  regardless of the dialect's native compound-operator associativity. As a
  side effect, vector/fulltext predicates in set-operation leaves now use the
  backend's configured relevance strategy instead of falling back to the dialect
  default.

  Note: `GROUP BY`/`HAVING` leaves are supported at the compiler level, but the
  query builder still does not expose `.union()`/`.intersect()`/`.except()` on
  aggregate queries — that builder gate is unchanged and applies equally to both
  backends.

### Patch Changes

- [#165](https://github.com/nicia-ai/typegraph/pull/165) [`ae5bfdc`](https://github.com/nicia-ai/typegraph/commit/ae5bfdc55aae3531bcd75f0770cb2812ad9682d9) Thanks [@pdlug](https://github.com/pdlug)! - Fix `ORDER BY`/`LIMIT`/`OFFSET` being silently dropped on a nested set-operation
  operand.

  When a set operation was nested inside another — e.g.
  `a.union(b).limit(10).intersect(c)` — the inner compound's suffix clauses were
  applied only at the top level, so the inner `limit`/`offset` were ignored and
  the outer operation ran over the full (unlimited) inner result. The compiler now
  emits each nested compound's own `ORDER BY`/`LIMIT`/`OFFSET` inside its operand
  subquery on both SQLite and PostgreSQL.

- [#165](https://github.com/nicia-ai/typegraph/pull/165) [`ae5bfdc`](https://github.com/nicia-ai/typegraph/commit/ae5bfdc55aae3531bcd75f0770cb2812ad9682d9) Thanks [@pdlug](https://github.com/pdlug)! - Validate set-operation leaf vector predicates against the configured vector
  strategy rather than only the dialect's fallback metric list, so a custom
  strategy's metric (e.g. `inner_product` on SQLite) is accepted inside
  `UNION`/`INTERSECT`/`EXCEPT` leaves exactly as it is in a standalone query.

  Reject a per-query fulltext `language` override on the query-builder path
  (`.$fulltext.matches(..., { language })`) when the strategy's tokenizer is fixed
  at table-create time (SQLite/FTS5), matching the store-level search guard
  instead of silently ignoring the option.

## 0.28.1

### Patch Changes

- [#154](https://github.com/nicia-ai/typegraph/pull/154) [`6703c88`](https://github.com/nicia-ai/typegraph/commit/6703c880d3d9047149f91d1db4a27b414983c632) Thanks [@pdlug](https://github.com/pdlug)! - Fix `isMissingTableError` missing DrizzleQueryError-wrapped Postgres
  "relation does not exist" errors, breaking fresh/partial Postgres boot ([#153](https://github.com/nicia-ai/typegraph/issues/153)).

  `isMissingTableError` (the shared "relation not bootstrapped yet"
  discriminant for `loadActiveSchemaWithBootstrap`, `readActiveSchemaPure`,
  and the [#135](https://github.com/nicia-ai/typegraph/issues/135) durable-marker gate) classified failures by inspecting only
  `error.message`. On Postgres, drizzle-orm wraps every query-builder call
  (`db.select()`, `db.insert()`, …) in a `DrizzleQueryError` whose `.message`
  is the failed SQL text; the real driver error — carrying both
  `relation "…" does not exist` and SQLSTATE `42P01` — is preserved on
  `error.cause`, which the helper never walked. So the helper returned
  `false` and a benign "not bootstrapped yet" surfaced as a hard fault.

  This regressed `createStoreWithSchema` after the [#149](https://github.com/nicia-ai/typegraph/issues/149)/[#152](https://github.com/nicia-ai/typegraph/issues/152) read-only
  pre-check: `ensureRuntimeContributions` now calls `getMarker` (a
  query-builder read) on the possibly-absent
  `typegraph_contribution_materializations` table _before_ `ensureMarkerTable()`.
  On Postgres that read throws a `DrizzleQueryError`, the helper missed it,
  and the open rethrew instead of materializing — breaking seed, first boot,
  and test global-setup on any fresh or partial Postgres database (base
  tables present, marker table absent — e.g. drizzle-kit-managed schemas).
  SQLite was unaffected because better-sqlite3 throws a raw error whose
  `.message` literally contains `no such table`.

  `isMissingTableError` now walks the `error.cause` chain (cycle-safe) and
  additionally keys on the locale-independent SQLSTATE `42P01`, rather than
  matching only the outermost `.message`. Existing message patterns are
  retained, so all prior matches still hold; the fix applies uniformly to
  all three call sites, including the latent slow-path blind spot in
  `loadActiveSchemaWithBootstrap` / `readActiveSchemaPure`.

## 0.28.0

### Minor Changes

- [#150](https://github.com/nicia-ai/typegraph/pull/150) [`f9b1300`](https://github.com/nicia-ai/typegraph/commit/f9b1300a031eb758ae456fcd97ba8cbfdf93a2b8) Thanks [@pdlug](https://github.com/pdlug)! - Add a per-search `efSearch` knob for tuning pgvector HNSW recall ([#148](https://github.com/nicia-ai/typegraph/issues/148)).

  `store.search.vector` and the vector half of `store.search.hybrid` now
  accept an optional `efSearch` — the HNSW search frontier
  (`hnsw.ef_search`, default 40). pgvector caps a single index scan at
  `ef_search` candidates, so the hybrid over-fetch (`vectorK = 4 * limit`
  by default) silently under-delivers once `vectorK` climbs past the
  session default; the floor is `efSearch >= vectorK` and ~2–4× is the
  high-recall target. Being per-search lets one connection pool serve both
  a latency-sensitive interactive path and a recall-sensitive batch path.

  The Postgres backend applies it transaction-locally
  (`SET LOCAL hnsw.ef_search`) around the vector `SELECT`, so it never
  leaks to the next query on a pooled connection — `SET LOCAL` issued in
  autocommit would roll off with the statement and the next pooled query
  would see the session default. Omitting `efSearch` opens no transaction
  and preserves today's behavior exactly. Validated as a positive integer
  ≤ 1000 (pgvector's ceiling).

  Scope: pgvector HNSW only. sqlite-vec has no equivalent frontier knob
  and treats it as a no-op; transaction-less Postgres drivers
  (`drizzle-orm/neon-http`) ignore it with a one-time warning. IVFFlat's
  `ivfflat.probes` is a follow-up.

### Patch Changes

- [#152](https://github.com/nicia-ai/typegraph/pull/152) [`761c672`](https://github.com/nicia-ai/typegraph/commit/761c672a991ea75454e441a4baf5939792da9505) Thanks [@pdlug](https://github.com/pdlug)! - Fix `ensureRuntimeContributions` running marker-table DDL on every store
  open ([#149](https://github.com/nicia-ai/typegraph/issues/149)).

  `createStoreWithSchema` → `ensureRuntimeContributions` previously ran the
  `typegraph_contribution_materializations` marker DDL
  (`ensureMarkerTable()` → `CREATE TABLE IF NOT EXISTS …`) on **every** open
  for any graph with runtime contributions (e.g. `searchable()` fields),
  even when every contribution was already materialized. The per-materializer
  `initializedGraphIds` cache is per-instance, so a deployment that builds a
  fresh backend per request (the norm on serverless Postgres) got an empty
  cache each time and re-ran the DDL on every open — which intermittently
  fails on connections that can't run it (observed on Cloudflare Workers +
  the Neon serverless driver) and surfaces as a wrapped `DrizzleQueryError`
  rather than a clean `MigrationError`.

  `ensureRuntimeContributions` now does a read-only pre-check first, mirroring
  the SELECT-only `assertInitialized`: when every runtime contribution is
  already materialized (marker present, signature matches, no recorded error)
  it returns without `ensureMarkerTable()` / `materializeOne`. A missing
  marker table, or any missing/stale/failed contribution, still falls through
  to the unchanged privileged first-materialization path. Warm per-request
  opens are now DDL-free.

  Note: the canonical runtime attach for the least-privilege / per-request
  deployment model remains `createVerifiedStore` (zero DDL by construction);
  `createStoreWithSchema` also runs bootstrap and auto-migration DDL and is
  still intended to run once under a privileged role. This change is
  defense-in-depth for the marker DDL specifically.

## 0.27.0

### Minor Changes

- [#144](https://github.com/nicia-ai/typegraph/pull/144) [`30a1cfd`](https://github.com/nicia-ai/typegraph/commit/30a1cfdba6f55240f3251de1ebdb05d69a66ea4c) Thanks [@pdlug](https://github.com/pdlug)! - Add `createVerifiedStore` and `assertSchemaCurrent` — the runtime
  counterparts of `createStoreWithSchema` for the least-privilege
  deployment model.

  `createStoreWithSchema()` runs DDL (bootstrap, safe auto-migrations,
  durable contribution materialization) and must run under a role with
  `CREATE` privileges. For applications that want their runtime under a
  least-privilege, DML-only role, the previous options were `createStore`
  (zero-DDL attach with no schema gate — drift goes undetected until a
  hot-path operation trips) or hand-rolling a SELECT-only verification
  dance from `getActiveSchema` + `getSchemaChanges`.

  This release adds two cleanly named entrypoints that share the same
  zero-DDL verification path:
  - **`createVerifiedStore(graph, backend, options?)`** — a SELECT-only
    attach (zero DDL) with a verification gate. Reads the active schema
    row and contribution markers, folds the persisted graph extension,
    and refuses to construct the Store unless the database is at the
    same schema version as the code graph. Returns
    `Promise<[Store<G>, SchemaValidationResult]>` mirroring
    `createStoreWithSchema`. Throws `MigrationError` on any drift (safe
    or breaking — the least-privilege runtime cannot migrate),
    `ConfigurationError` when no schema has been initialized, and
    `StoreNotInitializedError` when the schema is current but
    runtime-contribution markers (e.g. fulltext) are missing/stale.
  - **`assertSchemaCurrent(backend, graph)`** — the same verification gate
    exposed as a standalone predicate for readiness probes / healthchecks.
    Returns the `SchemaValidationResult` or throws the same errors.

  The recommended deployment shape is now:
  1. **Migration step** (privileged role with DDL/`CREATE`): run
     `createStoreWithSchema()` once at startup, or apply
     `generatePostgresMigrationSQL` / `generateSqliteMigrationSQL` plus a
     one-shot `createStoreWithSchema()` to materialize runtime
     contributions.
  2. **Runtime** (least-privilege, DML-only role): attach with
     `createVerifiedStore()`. Zero DDL on the runtime path; schema drift
     fails fast with a clean `MigrationError` instead of leaking into
     hot-path operations or 500ing on a permission error.

  Internal: factored a pure `mergeStoredGraphExtension` helper out of
  `loadAndMergeGraphExtensionDocument` so the SELECT-only verifier reuses
  the same parse + extension-merge + deprecated-kind logic without going
  through the bootstrap-capable loader. No behavior change for the
  existing schema entrypoints.

  Documentation: "Database roles & least privilege" in `backend-setup.md`
  now folds in `createVerifiedStore` as the canonical runtime attach;
  `schema-management.md` covers Basic / Managed / Verified stores side by
  side; `troubleshooting.md` adds entries for `MigrationError` from a
  verifying attach and `ConfigurationError` on uninitialized databases.

### Patch Changes

- [#144](https://github.com/nicia-ai/typegraph/pull/144) [`30a1cfd`](https://github.com/nicia-ai/typegraph/commit/30a1cfdba6f55240f3251de1ebdb05d69a66ea4c) Thanks [@pdlug](https://github.com/pdlug)! - Surface `MigrationError` before runtime-contribution DDL on a pending
  breaking migration ([#143](https://github.com/nicia-ai/typegraph/issues/143)).

  `loadActiveSchemaWithBootstrap` ran `ensureRuntimeContributions` (fulltext
  contribution DDL) **before** `ensureSchema` computed the schema diff and
  threw `MigrationError`. Contribution DDL is derived from the current code
  graph, so against a database still on the old schema version it was applied
  to a stale table shape. On Postgres the first failing statement aborts the
  surrounding transaction, and the error that escaped was the idempotent
  marker-table `CREATE TABLE IF NOT EXISTS
"typegraph_contribution_materializations"` (collateral damage), not a clean
  `MigrationError`. Consumers using the documented migrate-on-`MigrationError`
  recovery pattern never saw a `MigrationError`, so the first request after
  every breaking schema change 500'd until a concurrent boot won the migration
  race.

  `loadActiveSchemaWithBootstrap` no longer materializes runtime
  contributions. `createStoreWithSchema` remains the single canonical
  durable-marker writer and runs the materialization step **after**
  `ensureSchema`, so the breaking-change gate is always reached first and a
  pending breaking migration throws `MigrationError` on the first request —
  making the migrate-then-retry recovery path work as documented. The pre-[#129](https://github.com/nicia-ai/typegraph/issues/129)
  `ensureFulltextTable` fallback is preserved at the canonical writer. No API
  changes.

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
    asOf: "2023-01-15T00:00:00.000Z",
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
