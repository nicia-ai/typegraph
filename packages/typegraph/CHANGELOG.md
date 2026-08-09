# @nicia-ai/typegraph

## 0.46.2

### Patch Changes

- [#459](https://github.com/nicia-ai/typegraph/pull/459) [`0e2afe2`](https://github.com/nicia-ai/typegraph/commit/0e2afe2d76381b5bc8309485d3a7e84c7bda092e) Thanks [@pdlug](https://github.com/pdlug)! - Extend `onImmutableLowerBound: "preserve"` to endpoint-matched edge writes.
  `getOrCreateByEndpoints` accepts the policy in its options, and
  `bulkGetOrCreateByEndpoints` accepts it per item alongside `validFrom` and
  `validTo`. The policy applies a stated `validFrom` on create or resurrection,
  while a live `ifExists: "update"` preserves the stored lower bound and still
  applies properties and `validTo`. Strict refusal remains the default.

- [#462](https://github.com/nicia-ai/typegraph/pull/462) [`44f60cf`](https://github.com/nicia-ai/typegraph/commit/44f60cfbfaa6290323b02fb33fad2ca3541b1127) Thanks [@pdlug](https://github.com/pdlug)! - Surface lost fulltext contribution storage on gated operations as a typed `ContributionUnavailableError` with `state: "physical-storage-missing"` and rebuild guidance. Healthy operations retain the cached marker fast path; the error path translates only a missing-relation failure whose same driver error names the declared fulltext table.

## 0.46.1

### Patch Changes

- [#456](https://github.com/nicia-ai/typegraph/pull/456) [`a091902`](https://github.com/nicia-ai/typegraph/commit/a091902264fcbcd8336179c893a1e0a16eab528c) Thanks [@pdlug](https://github.com/pdlug)! - Add an explicit event-materializer policy for node upserts. Passing
  `onImmutableLowerBound: "preserve"` applies `validFrom` when the upsert creates
  or resurrects a row, but preserves a live row's stored lower bound while still
  applying props and `validTo`. The strict `IMMUTABLE_VALIDITY_LOWER_BOUND`
  refusal remains the default. The policy is available on `upsertById`,
  `upsertByIdFromRecord`, and each `bulkUpsertById` item, including unchanged
  coalescing replays.

  Widen the optional `better-sqlite3` peer range through 13.x and exercise 13.0.3
  in this repository. Correct the event-log projector guidance to update existing
  endpoint-matched edges, document historical replay window requirements, and
  clarify that `MergeReport.validityEnds` only reports inherited-row claims.

## 0.46.0

### Minor Changes

- [#427](https://github.com/nicia-ai/typegraph/pull/427) [`facef56`](https://github.com/nicia-ai/typegraph/commit/facef560d14c38607d6414818c65e43dc65a88d2) Thanks [@pdlug](https://github.com/pdlug)! - Add `signal` to `exportGraphStream`, and keep a streaming import's statistics refresh inside its connection lease.

  An export stream holds one `repeatable_read` / `read_only` transaction for its whole life, and on a single-connection backend it holds that connection's exclusive interchange-stream lease with it. Every cooperative exit already settled both, because each runs the generator's `finally`: `break` or `throw` out of a `for await`, and an explicit `iterator.return()`. A consumer that pulls `next()` and then simply DROPS the iterator — the `Promise.race([iterator.next(), timeout])` pattern — has no cooperative exit, because async-generator `finally` blocks do not run on garbage collection. That leaked the snapshot transaction for the life of the process, and with it the lease, so every later export and every later import on that connection was refused for a stream nobody was reading.

  `ExportOptionsSchema` now accepts `signal?: AbortSignal`, so both `exportGraph` and `exportGraphStream` take it, on both capability arms — a non-transactional export holds no snapshot and no lease, but it still owes its consumer an answer rather than a silent stall, and the same cancellation path gives it one. On a transactional backend, aborting rolls the snapshot transaction back and releases the lease whether or not anyone is waiting on `next()`; the pull that is in flight when the abort lands — and a pull from a consumer that walked away and came back — rejects with the new `ExportStreamCancelledError` (`code: "INTERCHANGE_EXPORT_STREAM_ABORTED"`), carrying the signal's own `reason` as `cause`. A signal that is already aborted refuses the export before any transaction is opened or any lease claimed. The listener is subscribed before anything is claimed or opened and `signal.aborted` is re-checked immediately after subscribing, so an abort at any instant is either seen by that re-check or delivered to the listener — including one raised synchronously by a driver inside `backend.transaction(...)`, which an `AbortSignal` never replays to a listener that arrives later. Everything else is unchanged: an export without a signal behaves exactly as before, and a cooperative exit still reports a clean end rather than a cancellation.

  There is deliberately no garbage-collection fallback. A `FinalizationRegistry` on the iterable cannot work here — not merely unreliably, but never: the producer is interruptible only where it is parked waiting for the consumer, so any cleanup state able to settle an abandoned stream must reach the stream's internal channel, and a registry holds its held value strongly, so holding anything that reaches that channel keeps the abandoned stream permanently reachable and the entry can never fire. The signal is the mechanism, and it is a contract rather than a hint.

  Separately, `importGraphStream` now holds its target connection's stream lease across the trailing planner-statistics refresh instead of releasing it when the chunk loop ends. That `ANALYZE` is a write like the chunks were, and running it outside the lease left it to be stranded by an export snapshot opening in that window — swallowed as a warning, because the refresh is best-effort. `importGraph` never had the hole (`withImportStreamLease` spans its whole call), so this also removes a divergence between the two import surfaces. The lease is still released on every exit, including the error paths.

  Also fixes a silent cross-kind edge overwrite in import. Edge ids are unique per graph but the import's existence probe (`getEdge` / `getEdges`) is keyed on `(graph_id, id)` with no kind comparison, so a document edge of kind A whose id was already held by a kind-B row matched that row: `onConflict: "update"` wrote A's properties onto the kind-B row with nothing in `result.errors`, and `onConflict: "skip"` counted the document's edge as already present when no edge of its kind existed. Both are now reported as a per-row `ImportError` prefixed `INTERCHANGE_EDGE_KIND_CONFLICT`, naming the stored kind and the stated one, with the stored row left untouched — the check runs before the conflict strategy, so all three strategies answer alike. `backend.updateEdge` is additionally called with `kind`, which `UpdateEdgeParams` documents as MUST-apply, so the predicate lives in the UPDATE's own `WHERE` and the check cannot be raced by a concurrent hard-delete-and-recreate; a write that consequently matches no row is reported as the same per-row error rather than aborting the import. Nodes were never affected — their probe is kind-scoped.

  The export's snapshot guarantee is now stated as the capability-scoped fact it is, in the API docs, the option docs, the error class, and the abort message: a backend reporting `capabilities.transactions` reads the whole export inside one repeatable-read transaction, while one without (SQLite `transactionMode: "none"`, session-less HTTP Postgres drivers) paginates statement by statement and can show a mid-stream write in later pages. `ExportStreamCancelledError`'s message now says which of the two it is describing, so a cancelled non-transactional export no longer claims to have rolled back a snapshot it never opened.

- [#417](https://github.com/nicia-ai/typegraph/pull/417) [`9d3014c`](https://github.com/nicia-ai/typegraph/commit/9d3014c05f2936fcdadb3fa50950445a0d8e2652) Thanks [@pdlug](https://github.com/pdlug)! - graph-merge: judge the edge fold's property union against base, and report a
  target-precedence window discard

  Two adjacent gaps in the edge repoint/window path. One is a bug fix, the other
  adds an optional field to a report type, so this ships at the higher `minor`
  bump and covers both.

  The repoint fold's property union had no base to compare against, unlike the
  node path's three-way merge, so a staged copy of an INHERITED edge contributed
  its whole fork property bag as first-class `(branch, value)` claims — including
  the values it never touched. Under any rank-based `onPropertyConflict` an
  untouched base value could therefore outvote a value a branch actually authored,
  decided by whichever branch label happened to ride on the untouched copy. The
  window-only carrier made it observable: an inherited row whose only change is
  its end-of-validity is staged solely to give that ending somewhere to ride, its
  properties ARE the base's, and its branch is merely whichever sorted first in
  staging. The union now filters every contributor to the properties it CHANGED
  from its own base — a branch-created edge has no base, so everything it carries
  stays a full claim — which means a carrier contributes no claim and raises no
  conflict at any rank. Genuine disagreements are unaffected: two members that
  changed one property differently still conflict, over their real values alone.

  Filtering claims does not erase content: the folded row commits the same property
  set as before, and a key only a non-survivor carries keeps the value held by the
  member with the minimum edge ID — the row, never the branch label riding on it,
  since for these keys no branch claimed anything and an arbitrary label deciding
  the committed value is the very thing being fixed.

  `MergeReport.validityEnds` now also reports the window claims that target
  precedence discards. When the incremental target had already moved an inherited
  row's end, the reconciler took the row out of the resolution and the branch
  claims vanished from the report entirely — less visible than a claim that merely
  lost the least-claim rule, which stays named in `claimedBy`. Such a row now gets
  a resolution naming the target's own committed instant, its discarded claimants,
  and the new optional `ValidityEndResolution.precedence` field set to the
  exported `VALIDITY_END_TARGET_PRECEDENCE`. The field is absent on every entry
  the merge itself decided, so existing consumers read what they always read; no
  write is staged and no provenance credit is minted for such a row, and a row no
  branch claimed still produces no entry at all.

- [#364](https://github.com/nicia-ai/typegraph/pull/364) [`fb29816`](https://github.com/nicia-ai/typegraph/commit/fb2981664c77d704b7f78933b8f887222c796091) Thanks [@pdlug](https://github.com/pdlug)! - Add optional `topK` to `pageRank()` and `personalizedPageRank()`, and optional
  `minComponentSize` to `weaklyConnectedComponents()`. Both bound only result
  extraction: the limit and the inclusive component-size filter are applied in
  extraction SQL after the existing deterministic ordering, so bounded rows never
  reach the driver. Default results and ordering are unchanged, and the graph
  computation itself still runs over the whole visible induced subgraph.

- [#415](https://github.com/nicia-ai/typegraph/pull/415) [`b68e643`](https://github.com/nicia-ai/typegraph/commit/b68e6437a337cdcd2e3c166754deb87008e25152) Thanks [@pdlug](https://github.com/pdlug)! - Refuse non-canonical validity-window timestamps in trusted import.

  `trustedImportGraph` / `trustedImportGraphStream` accept a pre-typed stream and
  never re-parse it, so a `validFrom` / `validTo` that TypeScript types as `string`
  but is not canonical fixed-width UTC ISO 8601 used to flow straight to SQL. Every
  temporal filter compares those values AS TEXT against an `asOf` coordinate, so a
  stored `"2021-01-01"`, `"...T00:00:00Z"`, `"...:00.1Z"` or `"...+01:00"` mis-sorts
  and silently includes or excludes the wrong rows — and it mis-decided the
  negative-width window check that the same path performs on the way in.

  Both window fields of every streamed node and edge are now format-checked with
  the same `isCanonicalIsoDate` decision the untrusted import schema and the store's
  own writes make. A violation refuses the WHOLE stream with a `TrustedImportError`
  carrying the existing reason `invalid_stream`, naming the offending field, row and
  value; the session's transaction rolls back, so chunks already streamed are not
  left behind. This is a behavior change: a stream that previously imported and
  stored an unsortable timestamp now fails loudly. Convert such values with
  `new Date(value).toISOString()`. The check is format-only — trusted import still
  skips property, reference and conflict validation — and it leaves an absent field
  and an explicitly `null` (confirmed open-left) `validFrom` untouched.

  Also documents a pre-existing bulk-API limitation, with no behavior change:
  `bulkUpsertById` groups every create ahead of every update, so one batch cannot
  hand a constrained value from one row to another (releasing a `unique` value or a
  `oneActive` edge slot and claiming it in the same batch throws `UniquenessError` /
  `CardinalityError`, where the equivalent sequential upserts succeed). The
  workaround is two batches, or sequential upserts.

- [#374](https://github.com/nicia-ai/typegraph/pull/374) [`fadf932`](https://github.com/nicia-ai/typegraph/commit/fadf93297df40bd619a1ca45b165edc04ef6ebfe) Thanks [@pdlug](https://github.com/pdlug)! - graph-merge: stage cascade retractions with their cause instead of inferring intent

  A node soft-delete ends every open identity assertion touching the node, so a
  branch that deletes a node stages retractions it never asked for. The merge
  previously separated those cascade endings from a branch's own retraction with
  a conservative branch-level heuristic, which deliberately over-dropped the
  same-branch case: a branch that retracted an assertion and LATER deleted one of
  its endpoints looked exactly like a pure cascade, so its retraction was dropped
  whenever the deletion was overruled — silently keeping truth the branch had
  explicitly ended.

  The soft-delete cascade now ends assertions at the deleted node's own
  `deleted_at`, which makes the cause derivable: the state-diff compares each
  retracted assertion's end instant to the deletion instants of its endpoints and
  stages the retraction as either a cascade naming the deleted node or the
  branch's own act. The merge planner drops a retraction only when EVERY branch
  staged it as the cascade of a deletion that delete/modify resolution then
  overruled, so an explicit retraction survives even when it comes from the
  deleting branch. Two cases stay conservative because nothing distinguishes them
  at the stored resolution — a hard delete (which removes the assertion rows) and
  a retraction issued in the same millisecond as the delete that followed it.

- [#387](https://github.com/nicia-ai/typegraph/pull/387) [`71361d7`](https://github.com/nicia-ai/typegraph/commit/71361d70b1fda83ad8539228c8e133abd0ce57f9) Thanks [@pdlug](https://github.com/pdlug)! - Complete the contribution health lifecycle with a read-only readiness probe and
  an explicit destructive rebuild, so the three maintenance operations form one
  escalation ladder: `probeContributions()` (writes nothing) →
  `repairContributions()` (non-destructive, already shipped) →
  `rebuildContribution()` (drops and recreates storage).

  `store.probeContributions()` answers "is search coherent with the graph right
  now" without mutating anything — safe on a read path, on a replica, and under a
  least-privilege role. It returns one `ready` / `degraded` entry per search
  projection plus the durable `graphRevision` the assessment was taken at on a
  revision-tracked Store. It shares the detection logic of
  `verifyContributions()` rather than reimplementing it, so a health check can
  never disagree with the gate the hot path actually consults. A projection with
  no declared contributions is omitted rather than reported `ready`, and a backend
  that provisions contributions but cannot probe its catalog refuses instead of
  answering — "assessed and healthy" and "never looked" never share a return
  value.

  `store.rebuildContribution("fulltext")` is the repair that was missing for a
  `stale` contribution, whose table exists at a shape the current `createDdl` no
  longer produces: the ensure path's `CREATE ... IF NOT EXISTS` no-ops against it,
  so re-stamping the marker would leave it blessing storage of the wrong shape.
  The rebuild drops the storage, recreates it, reconstructs the content from the
  node rows, and stamps the marker inside one transaction under the schema-write
  fence, so an interrupted rebuild rolls back rather than leaving storage attested
  but empty. It is reachable only by name — never from `repairContributions()`,
  which continues to report these findings as `requires-rebuild`.

  Vector contributions are not rebuildable, and the call refuses with
  `ContributionRebuildUnsupportedError` rather than dropping them: TypeGraph
  stores the vectors callers supply and never the inputs that produced them, so
  the embeddings exist only in the storage a rebuild would destroy.
  `reembedVectorField(kind, fieldPath, { embed })` remains the sanctioned
  destructive path, because it takes the callback that can regenerate them. The
  same typed error covers a fulltext strategy that declares no `dropDdl` and a
  backend with no transactional schema fence; all three refuse before anything is
  dropped, and all three are declared ahead of time on the new
  `backend.capabilities.contributions` capability.

  Fixes the drift guard so the ladder can actually be climbed: when the guard
  refused a shape change it recorded the failed attempt at the _new_ signature,
  overwriting the only evidence of the shape the table really had. The verdict
  then read as `missing-marker` rather than `stale`, so `repairContributions()`
  reported it repaired — re-stamping the marker over the unchanged old-shape table
  — and the next boot skipped the guard entirely. The guard now preserves the
  recorded signature, so a `stale` contribution stays `stale` across restarts,
  `repairContributions()` keeps reporting `requires-rebuild`, and the refusal
  persists until `rebuildContribution("fulltext")` fixes the shape. Reach that
  call from a `createStore()` / `createVerifiedStore()` Store: the managed
  factory's boot step is what the guard refuses.

  Also adds optional `dropDdl` to `TableContribution` — declared by both bundled
  fulltext strategies — which is what opts a strategy into the rebuild.

- [#376](https://github.com/nicia-ai/typegraph/pull/376) [`8c3a8e6`](https://github.com/nicia-ai/typegraph/commit/8c3a8e6af5ec2813a26d0aa13bf58da2c50fbaa3) Thanks [@pdlug](https://github.com/pdlug)! - Add a database-level contradiction backstop for Operational Identity.

  A `different` assertion and a `same` assertion that would place both of its
  endpoints in one identity class are a contradiction, and until now only
  application code stood between such a write and a committed graph: the
  plan-time simulation and the identity applier's validation both decide by
  reading state and comparing, so a bug in either commits the contradiction
  silently.

  Identity now also maintains a derived **separation relation** — one row per
  pair of identity classes a current `different` assertion holds apart, keyed by
  the two class keys under a `CHECK (class_key_low < class_key_high)`
  constraint. Every transaction that fuses two classes relabels the affected
  separation rows in the same statement batch, so fusing two separated classes
  relabels both sides of their shared row to one key and the database aborts the
  transaction. A write that reached the ledger through a path that skipped
  identity validation can no longer commit a contradictory graph; it fails with
  the new typed `IdentitySeparationViolationError`.

  The relation is derived and requires no application changes: it is maintained
  wherever the identity closure is (assert, retract, fold, delete, merge,
  import, rebuild), `rebuildIdentityClosure(store)` recomputes it from the
  assertion ledger, and store-open identity validation checks it against that
  recomputation.

  Upgrading an existing identity-enabled database needs no manual step. A store
  opened with `createStoreWithSchema` / `createAdapterStoreWithSchema` creates
  the new `typegraph_identity_separation` relation through the same idempotent
  identity DDL path as the other identity relations and recomputes it from the
  ledger once, before anything reads it. A missing assertion ledger or closure
  relation is still refused as data loss.

  Custom backend authors: the resolved table-name types (`ResolvedSqlTableNames`,
  `SqliteTableNames`, `PostgresTableNames`) and the `ensureIdentityTables`
  parameter each gained a required `identitySeparation` entry, so an
  implementation that builds one of those objects needs the new name added. Code
  that only reads `backend.tableNames`, or that passes a partial name override to
  `createSqliteTables` / `createPostgresTables` / `createSqlSchema`, is
  unaffected — an omitted name still resolves to the default
  `typegraph_identity_separation`.

- [#397](https://github.com/nicia-ai/typegraph/pull/397) [`d2b935e`](https://github.com/nicia-ai/typegraph/commit/d2b935ed071fc2eb8e4310cfb1bdeecca64072b0) Thanks [@pdlug](https://github.com/pdlug)! - Graph Merge now keeps the **inherited** edge when a repoint-induced collapse folds a
  committed row together with a branch-created one, instead of keeping the
  lexicographically-minimal edge id.

  Previously the survivor of such a collapse was whichever edge id sorted lowest. A
  collapse rewrites the row it keeps and ends none of the rows folded into it, so when a
  branch-created id sorted below the committed one, the merge wrote the branch's row as a
  new edge and left the committed edge live beside it at its pre-merge properties — two
  live rows for one folded relationship, the edit staged for the committed row never
  written, and `merged.edges` counting one of them. Which of the two you got depended on
  an id sort, so it was not behavior a caller could depend on.

  The surviving edge id reported in `PropertyConflict.entityId`, window resolutions and
  provenance is consequently the inherited row's id whenever the collapse involved one.
  That is the id of the row that actually persists, and it no longer moves with
  branch-created id lexicographics. Collapses among branch-created edges alone are
  unchanged, as is the property/window reconciliation applied to the survivor.

- [#427](https://github.com/nicia-ai/typegraph/pull/427) [`facef56`](https://github.com/nicia-ai/typegraph/commit/facef560d14c38607d6414818c65e43dc65a88d2) Thanks [@pdlug](https://github.com/pdlug)! - `store.rebuildContribution("fulltext")` is now scoped to the graph it is called on. The fulltext projection is one physical table holding every graph's rows keyed by `graph_id`, while the rebuild runs under the per-graph schema fence — so the old unconditional `DROP TABLE` destroyed every other graph's search index on the same database, with no concurrency required: a neighbouring graph's `fulltext` marker survived the drop (markers are keyed by `graph_id`), so `probeContributions()` and `verifyContributions()` went on reporting it `ready` while every search it served returned nothing. The rebuild now removes only the calling graph's rows, through the same `DELETE ... WHERE graph_id` statement `clear()` uses — one exported builder both call — and escalates to dropping and recreating the shared table only when that table holds no other graph's rows. That drop remains the one repair for storage provisioned at a shape the current DDL no longer produces, and the lock scope now matches the decision it authorizes. Two locks, protecting different resources: a constant-keyed advisory lock (`typegraph:contribution-ddl`) serializes the contribution's DDL across graphs — it survives the drop and exists even when the table does not, which is what a relation lock cannot do — and, on the path that may drop, `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` excludes ordinary writers, which take no advisory lock at all and could otherwise commit a row between the probe and the `DROP TABLE` that the probe had already decided was safe. The verdict is re-established under that lock before any drop; the cheap unlocked probe ahead of it exists only to keep the graph-scoped path off the relation lock, and can only err toward keeping the table. Both are no-ops on SQLite, whose `BEGIN IMMEDIATE` fence already holds the database's single writer slot from probe through commit.

  When the recorded shape is `stale` — the state only a recreate repairs — and the storage that would have to be recreated holds another graph's rows, the rebuild refuses with `ContributionRebuildUnsupportedError` and the new reason `shared-storage-in-use` instead of either destroying content it cannot reconstruct or re-stamping this graph's marker over a physical shape nothing verified. The refusal names the other graph ids and the sanctioned maintenance-window sequence. Vector contributions are unaffected: their storage is per-`(graph, kind, field)`, so no other graph's data is ever in reach.

- [#427](https://github.com/nicia-ai/typegraph/pull/427) [`facef56`](https://github.com/nicia-ai/typegraph/commit/facef560d14c38607d6414818c65e43dc65a88d2) Thanks [@pdlug](https://github.com/pdlug)! - Harden the Operational Identity release and adjacent write paths found during its adversarial review. Identity interchange now exports one repeatable-read snapshot, uses target-bound keyset pagination pinned to code-point order via the dialect adapter's `binaryText` seam so a `base@V` content token minted on 0.45 still matches its recomputation on PostgreSQL, cancels cleanly, and refuses streams that would deadlock a serialized connection — a PGlite connection, a bare `pg`/neon `Client` (including a checked-out `PoolClient`), a `Pool` explicitly configured with `max: 1`, a postgres-js client built with `{ max: 1 }`, a better-sqlite3 handle, a `bun:sqlite` database, a sql.js database, a local (`file:`/`:memory:`) libSQL client, or Cloudflare Durable Object storage, whose transaction frame is ambient on the storage object. The refusal is one EXCLUSIVE long-lived-stream lease per serialized resource, not a one-time observation and not a cross-kind-only exclusion: at most one interchange stream of any kind holds a given connection, so all four pairings are refused rather than only the two that mix kinds — an import behind an export snapshot (including through a user-wrapped stream that no longer identifies its source backend), an export snapshot behind a streaming import, and now export-behind-export and import-behind-import too, which previously reached the driver as a nested `BEGIN` after chunks had already committed. Whichever long-lived stream starts second gets a typed `ConfigurationError` instead of both hanging: `details.code` names the condition that holds the connection (`INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT` behind an export snapshot, `INTERCHANGE_SAME_SQLITE_BACKEND_SNAPSHOT` when the object-identity detector is what answered, or the new `INTERCHANGE_SERIALIZED_IMPORT_IN_PROGRESS` behind another import), while the new `details.requested` and `details.heldBy` name which pairing was actually refused, so a same-kind refusal is never reported as something it is not. `"import-stream"` is the kind of EVERY long-lived import, not only the chunk-streaming one: `importGraph` takes the lease for the whole call and `trustedImportGraphStream` / `trustedImportGraph` hold it for the whole trusted session, so both APIs can now throw these serialized-connection `ConfigurationError` codes — a new error TYPE on a trusted-import surface that previously threw only `TrustedImportError`. Every exit releases the lease, including a mid-stream producer failure and a synchronous throw out of `backend.transaction(...)` (a closed handle, a refused pool checkout), which would otherwise strand the connection for the life of the process. Relatedly, SQLite's manually framed transactions no longer let a failing `ROLLBACK` mask the failure that caused it: SQLite auto-rolls-back on `SQLITE_FULL` / `SQLITE_IOERR` / `SQLITE_NOMEM`, so the unwinding `ROLLBACK` can itself fail with "cannot rollback - no transaction is active" — the caller now receives the ORIGINAL error and the rollback failure is warned instead of thrown. Graph merge uses injective composite keys, preflights provenance sidecar collisions, and refuses merge options it cannot honor instead of ignoring them.

  Edge identity checks now include kind and endpoint kind on every create, delete, and get-or-create path, including tombstoned rows, and that check is carried by the write statement itself rather than re-derived beside it: `UpdateEdgeParams`, `DeleteEdgeParams`, and `HardDeleteEdgeParams` each gain an optional `kind`, and a backend that receives it MUST scope the statement to that kind. Both bundled Drizzle backends satisfy that contract through one shared predicate, but a hand-written `GraphBackend` has to honor it or it will silently widen a write it was told to narrow. Because a kind-scoped statement that also requires `deleted_at IS NULL` is its own recheck, the redundant in-transaction re-read that used to precede each edge delete and hard delete is gone — the statement either matches the edge the caller named or affects nothing. Node `bulkDelete` remains one atomic, hookless bulk operation exactly as in 0.45. Edge `bulkDelete` changes behavior in 0.46: 0.45.x looped single deletes and fired per-item `onOperationStart`/`onOperationEnd` hooks for each one, and 0.46 makes it one atomic single-transaction batch that emits NO hook events at all — neither per-item nor bulk, since `onBulkOperationStart`/`onBulkOperationEnd` fire only for node `updateWhere` and no bulk-hook coverage for deletes exists yet — so a consumer that relied on those per-item events for audit or metrics must either keep deleting individually (single `delete` still fires per-item hooks) or capture the deletions another way, such as from the ids it passes in and the rows it reads back; an id in the batch that belongs to another edge kind is refused with `ValidationError` carrying `EDGE_IDENTITY_MISMATCH_CODE`, rolling back every delete already applied earlier in the same batch.

  Constrained writes no longer take their decision from a read the write cannot vouch for. Every write whose correctness rests on a check-then-write — edge cardinality `one`, `unique`, and `oneActive` (including the create and resurrect legs of `getOrCreateByEndpoints`, single and bulk), node-kind disjointness on create, and a `kindWithSubClasses` uniqueness constraint that actually expands to more than one kind (a scope covering a single kind probes exactly the row the uniques table's own primary key then reserves, so that key IS its fence) — now runs its probe and its write under the same per-graph mutual exclusion, whether or not the store enables `history` or `revisionTracking`. That exclusion previously arrived only as a SIDE EFFECT of recorded capture's advisory lock, so the DEFAULT PostgreSQL store — no history, no revision tracking — raced: two writers each probed a graph that satisfied the constraint and each committed, producing exactly the duplicate the constraint exists to prevent, with no error on either side. On PostgreSQL the fence is that same transaction-scoped advisory lock, now taken for the constraint's sake rather than the clock's; on SQLite it is the `BEGIN IMMEDIATE` writer slot the backend already holds. Writes with nothing to check — an unconstrained create, any delete, a cardinality-`many` edge — take no lock at all, so the cost tracks the constraints a graph actually declares rather than becoming a blanket serialization.

  A backend running WITHOUT transactions has no fence to take, and a constrained write there is now REFUSED rather than run unfenced. Both halves of the fence are transaction-scoped constructs — SQLite's `BEGIN IMMEDIATE`, PostgreSQL's `pg_advisory_xact_lock`, which outside a transaction is acquired and dropped inside its own implicit single-statement one and excludes nothing — so "can this backend fence" and "does this write run inside a transaction" are the same question, and the refusal is keyed on exactly that. It is a `ConfigurationError` with `details.code` `CONSTRAINT_WRITE_FENCE_UNSUPPORTED` and `details.constraint` naming WHICH declared constraint needed the fence — `edgeCardinality`, `edgeMatchKeyConvergence`, `nodeDisjointness`, or `nodeUniquenessScope` — because "this backend cannot fence constrained writes" is unusable advice while "your `cardinality: 'one'` edge cannot be enforced here" is actionable; the `suggestion` carries the per-class way forward. The blast radius is Cloudflare D1 (auto-detected as `transactionMode: "none"`), `drizzle-orm/neon-http`, and any SQLite backend explicitly built with `transactionMode: "none"` — Durable Objects are NOT affected, since `do-sqlite` reports `capabilities.transactions: true` and fences normally. On those three, a declared-constraint write that previously raced silently now throws: a `cardinality` other than `many` cannot be created or resurrected, a `disjointWith` kind cannot be created, a `kindWithSubClasses` unique that actually expands past one kind refuses on create AND update, and `getOrCreateByEndpoints` can no longer take its CREATE leg (a call that FINDS an existing edge still returns it, and a `many` resurrection is an id-keyed UPDATE re-deriving no verdict, so both keep working; the BULK form fences its whole batch and therefore refuses whatever the outcome would have been). Everything unconstrained is untouched — a `many` edge created, updated and deleted, any node delete including one whose kind participates in a disjointness axiom, and a `scope: "kind"` unique whose uniques primary key IS its fence — so this is not a blanket loss of write access on those engines. Refused rather than degraded, per the accepted-or-refused rule: a constraint enforced only when nothing races is the exact defect the fence exists to close, and reporting it as enforced would make the invariant above false precisely where it matters.

  A store created with `coalesceUnchangedUpserts` likewise stopped letting an optimization change an answer. A single-node `upsertById` decided to skip its write from an autocommit read, so a writer committing between that read and the skip left the caller told its props were stored while the store in fact held the other writer's — a DIFFERENT outcome from the same call with the flag off, where the update's own in-transaction re-read merges the caller's props over whatever it finds. The skip is now taken only on evidence re-read inside a transaction after that first observation, and a losing verdict falls through to the ordinary write path; only an upsert that is about to coalesce pays the second read, so a store without the flag, or one whose props differ, keeps the single read and single write it always had.

  `getOrCreateByEndpoints` now converges rather than retrying once and hoping. Its single-shot retry became a bounded loop of three attempts whose ordinary case is cheaper than before — under the fence a losing writer learns of the winner from its own in-transaction lookup instead of from a `CardinalityError` — and whose exhaustion is a typed refusal rather than a livelock or a stray constraint error leaking out of a lost race: a competitor that repeatedly creates and removes the same match key ends in a `DatabaseOperationError` naming that pattern and telling the caller to serialize or retry. The bulk edge `getOrCreateByEndpoints` and bulk node `getOrCreate` paths, which had no retry at all and surfaced a concurrent winner as a raw constraint violation, gained one.

  `efSearch` is now refused everywhere it cannot be applied, not only on PostgreSQL. The guarantee that vector search never silently drops an accepted option held only for the PostgreSQL path: every SQLite backend accepted `efSearch` and ignored it, on the vector path and the hybrid path alike (the hybrid path dropped it in a second place, while rebuilding the vector parameters), so a caller tuning recall got the default frontier and no indication. All of them now ask one owner, and an engine with no per-search ANN frontier refuses with `UnsupportedBackendCapabilityError` — `details.capability` `vector.searchFrontierTuning`, `details.reason` naming the limitation (`sqlite-vec`'s `vec0` KNN takes only `k`, the page size; libSQL's DiskANN `vector_top_k` fixes `search_l` at index-creation time). PostgreSQL is unchanged, including its existing refusals for a non-HNSW slot and a driver that cannot scope `SET LOCAL`, which now come from that same owner instead of from a second spelling of the same decision.

  Separately, sql.js backends could not execute a compiled query at all. The compiled-execution adapter recognized any client exposing `prepare()` and then called `all()` on the resulting statement, but sql.js's `Statement` has no `all()` — it is a `bind`/`step`/`getAsObject`/`free` cursor — so the first prepared statement threw. Client detection is now shape-specific, sql.js is excluded from the compiled path, and it runs through Drizzle's own session, which drives that cursor correctly; `bun:sqlite`, whose statement DOES expose `all()`, keeps the compiled path.

  The merge-provenance sidecar now claims its graph id MARKER-FIRST instead of inferring ownership from circumstantial evidence: the durable `ProvenanceOwner` marker is the sidecar's FIRST write of any kind, committed inside the schema fence (`schemaWriteTransaction` — the same per-graph fence every schema commit and schema-managed write already respects) and BEFORE the sidecar schema is registered, which is possible because the marker is a plain node row needing no per-graph DDL. A competing writer therefore either commits first and is seen, or waits until the claim has committed; a refused open leaves the occupant byte-identical, writing no schema row, no marker, and no provenance row. Because the marker precedes the schema, the resumable interrupted state is marker-WITHOUT-schema (or marker beside a pre-marker legacy schema), which resumes by registering or migrating the schema — while a graph carrying the exact current sidecar schema with NO marker is a state this module cannot produce and is refused UNCONDITIONALLY as `unowned-exact-schema-graph`, contents never consulted: empty and provenance-shaped occupants are refused exactly like any other, since contents an application could have written are not evidence of authorship. Freedom is judged by occupancy across EVERY per-graph row table the backend names through its `tableNames` port — nodes and edges, but equally recorded-time history, the revision clock and origins, identity assertions with their recorded ledger, closure and separation, fulltext, and unique keys — so a graph id holding only, say, identity or fulltext rows is occupied and refused, and an unregistered schema is never taken as evidence of a free namespace. Only the exact validated live marker counts as ownership: a tombstoned, malformed, wrong-target, or non-canonical `ProvenanceOwner` row refuses with the reason `corrupt-ownership-marker` and is never overwritten or resurrected. Refusals report one of five typed reasons under `GRAPH_MERGE_PROVENANCE_ID_COLLISION` — `application-graph`, `empty-legacy-sidecar`, `unupgradeable-legacy-sidecar`, `unowned-exact-schema-graph`, or `corrupt-ownership-marker` — each carrying remediation specific to the state actually found, and a backend that exposes no schema fence refuses an unclaimed sidecar with `GRAPH_MERGE_PROVENANCE_CLAIM_UNFENCED` rather than claiming without atomicity (an already-owned sidecar needs no claim and still opens there). One writer class takes neither the per-graph advisory lock nor the active schema row — a schema-LESS raw `createStore` writer, or a direct `backend.insertNode` / `insertEdge` — and at PostgreSQL's READ COMMITTED its insert could commit between the claim's fenced re-inspection and the claim's commit, leaving the marker on a graph id an application had just made its own. That window is closed rather than accepted: on PostgreSQL the claim issues `LOCK TABLE <nodes>, <edges> IN SHARE ROW EXCLUSIVE MODE` inside the fence and before the re-inspection, draining in-flight row writers and holding new ones off until the marker commits. `SHARE ROW EXCLUSIVE` and not `SHARE` because the mode must be SELF-exclusive: two concurrent claims on different sidecar ids hold different advisory locks, so under `SHARE` both would acquire it and then both request `ROW EXCLUSIVE` for their own marker INSERT — a lock-upgrade deadlock PostgreSQL resolves by aborting one. The cost is real and bounded: while a claim runs, every node and edge write on the whole DATABASE waits, for the duration of a few probes and one INSERT with no caller code inside — and the lock is taken only when a sidecar is created, upgraded from the pre-marker schema, or resumed after a crash, never on the common path where an already-owned sidecar opens with no fence at all. SQLite takes no such lock; `BEGIN IMMEDIATE` already owns the single writer slot.

  `persistProvenance: true` is now honored or refused, never dropped: the sidecar is opened and claimed PRE-COMMIT, so an occupied sidecar graph id or a backend that cannot fence the claim refuses the whole merge as `InvalidMergeOptionsError` (`details.option` `"persistProvenance"`, with the originating `ConfigurationError` as `cause` and its code echoed as `details.provenanceErrorCode`) and leaves the target unmodified — where 0.45 would have committed the merge and reported the same configuration verdict as a `warnings` entry. Those verdicts are as true before the merge as after it, so reporting them post-commit left the caller with a committed graph and a stated option TypeGraph had silently ignored. The post-commit best-effort warning path survives only for what is genuinely transient — a row write failing against a sidecar this library already owns. One visible consequence of claiming early: after a `persistProvenance` merge the sidecar (marker and schema) exists even if the merge itself later fails, holding an owned, empty sidecar and no target change. `mergeIncremental`'s refusal of a non-`"flag"` `onBasePropertyConflict` is now a typed `InvalidMergeOptionsError` (`MERGE_ERROR_CODES.invalidOptions`, category `user`) instead of a plain `MergeError`, so it is catchable the same way every other refused merge option is. `mergeIncremental` additionally refuses a fork point that moved under it. Its plan is a set of diffs against one `base@V`, and only the TARGET was ever allowed to advance while the merge ran — but nothing checked, so a write landing on the fork-point store mid-call left the commit applying diffs against an ancestor that no longer existed. The fork point is now frozen for the duration of the call: the version read before planning is carried into the commit and re-compared as the first act of the commit transaction, and a mismatch raises `BaseVersionMismatchError` (`GRAPH_MERGE_BASE_VERSION_MISMATCH`) naming the expected and live fork-point bases rather than committing. And `branch()` no longer leaks the working copy's backend when the post-transfer schema-anchor read fails — ownership of that engine transfers to `branch()` on the strategy's success path, and a `branch()` that reports failure as `err(...)` hands the caller no handle to close.

  Operational Identity's derived separation relation is never published in a state that under-reports separations. The relation is created INSIDE the transaction that fills it — the fenced path issues its DDL under `schemaWriteTransaction`, the schema-commit path returns the DDL as data for the commit transaction to issue — so a commit refused by the `IDENTITY_PROFILE_MIGRATION_PENDING` gate, a stale CAS, or a contradiction now creates nothing at all, where previously it stranded a readable, empty relation that the next open skipped because "present" was what suppressed the rebuild. What that cannot undo, a per-graph predicate heals: the fill decision is "does THIS graph hold live `different` assertions and no separation rows", not "does the table exist", so a relation left empty by an older version or by another graph's provisioning is rebuilt at the next open of the graph that owns the assertions. The predicate is exact in both directions — it shares the fill's registry kind filter and additionally requires the assertion's two endpoints to resolve to DIFFERENT identity classes, since a contradicted ledger projects to a degenerate pair the relation's CHECK refuses, which is its own fault with its own error rather than an unfilled relation. Identity DDL is serialized database-wide by a constant-keyed advisory lock (`typegraph:identity-ddl`; a no-op on SQLite, whose writer slot already serializes the database), taken inside the per-graph schema fence and outside the per-graph identity locks, because the identity relations are shared by every graph while the fence is not. A backend that cannot publish that upgrade atomically — missing `schemaWriteTransaction` or `identityTableDdl` on the fenced path, or `executeSchemaDdl` on the commit path — is refused with the new `ConfigurationError` code `IDENTITY_UPGRADE_REQUIRES_ATOMIC_DDL` naming the missing ports, but only when a fill is actually owed; both bundled Drizzle backends implement all three when transactions are enabled. Finally, `isSeparated` no longer trusts an empty read: a graph with zero separation rows whose ledger holds a live, kind-filtered `different` assertion across two distinct classes raises `IDENTITY_STORAGE_MISSING` with the new `details.reason` `"unfilled"` rather than answering "not separated". That is the state a Store handle opened while the relation did not exist would otherwise slide into the moment another graph's upgrade created the shared relation mid-session; the remedy is to reopen the Store, which runs the fill, and the error says so. That proof is taken once per Store handle rather than once per read: it settles a property of the graph, not of the pair, and the assertion ledger has no index that answers it cheaply — proving it per read cost a 200-assertion same-only import 32% and eight concurrent `assertSame` 56% on SQLite, on the workload class whose separation relation is legitimately empty forever. A handle opened while the relation was absent still refuses, because a handle that cannot read the relation never records a proof; what a kept proof no longer re-detects is a relation truncated out of band midway through one handle's life, which `validateIdentity()` reports and the CHECK constraint still refuses at the next fusing write.

  Three smaller guards join that one. The recorded revision clock can no longer move backward: its upsert advances the stored row only WHERE the stored revision is strictly less than the one being written, so a late allocation cannot rewind a clock other readers have already passed, and a caller that supplies an explicit stale `previousRevision` now gets a `ConfigurationError` stating that the write would have moved the graph's revision clock backward — carrying the graph id and both revisions — instead of quietly winning. Operational Identity's SQLite writes now name the one state they cannot recover from: an identity mutation inside a transaction the CALLER began and TypeGraph adopted (`store.withTransaction(externalTx)` / `store.withRecordedTransaction(externalTx)`) can find its read snapshot invalidated before it ever takes the writer slot if that transaction was opened `BEGIN DEFERRED` and another connection committed first, and SQLite cannot upgrade a stale snapshot in place. That surfaces as a `ConfigurationError` with `details.code` `IDENTITY_TRANSACTION_NOT_WRITE_FENCED` and `details.sqliteCode` `SQLITE_BUSY_SNAPSHOT`, telling the caller to roll back and reopen with `BEGIN IMMEDIATE`; TypeGraph's own transactions already open that way, so the state is unreachable without an adopted frame. And the three PostgreSQL error shapes a concurrent `CREATE ... IF NOT EXISTS` race can take — SQLSTATE `23505`, `42701`, and `XX000` carrying "tuple concurrently updated" — are now classified by one shared predicate rather than by each call site's own partial spelling of the set, so a race one site tolerated is no longer a hard failure at the next.

  Edge `matchOn` composite-key construction and its per-field match comparison, embedding/fulltext field extraction, and the uniqueness path — both the unique-key computation and the `where` predicate's evaluation — now read a props bag by declared own key rather than plain property access, so a field named after an `Object.prototype` member (`toString`, `constructor`, `valueOf`) can no longer resolve to the inherited prototype member instead of the field's actual (absent) value: a unique constraint over an absent field named `toString` keyed on the inherited function, producing the empty key under `binary` collation and throwing `TypeError` under `caseInsensitive`, where it must key as absent like every other missing value. The remaining NUL-joined cache and bucket keys in edge and node operations, and legacy provenance record ids, are now built with the same injective tuple encoding already used elsewhere, closing the last collision-prone key constructions.

  That own-key discipline now extends past reads of a props bag. A prototype-named field the schema DECLARES is projected and returned as its stored value instead of being short-circuited as prototype noise, so selecting a field called `toString` or `valueOf` answers with what was written rather than with the inherited function; the field tracker asks the schema introspector whether the name is declared before deciding, and an UNDECLARED prototype name still resolves exactly as it always did. Schema canonicalization builds its sorted form on a null-prototype bag, so a schema carrying a `__proto__` property is no longer canonicalized — and therefore hashed and diffed — identically to one where the property is absent; the output is byte-identical for every schema without such a key, so no existing schema's hash moves. Graph merge's property bags got the same treatment, which is what lets a fork-side DELETION of a `__proto__` property record as a deletion: the deletion marker is an assignment, and on an ordinary object literal `Object.prototype`'s setter swallowed it, silently reverting the delete to the base value. A graph-extension document that declares a PROPERTY named `__proto__` is refused outright with `RESERVED_PROPERTY_NAME`, because schema validation cannot carry it — at any depth, so a NESTED object field named `__proto__` is refused on the same grounds rather than only a top-level one. `defineNode` / `defineEdge` refuse the identical declaration at definition time (`ConfigurationError`, `details.conflicts`) — at ANY nesting depth, walking nested object schemas and every wrapper (optional, nullable, default, arrays, records, unions, lazy) structurally through Zod's public `def`, with a dotted path in the error — so the two authoring paths no longer disagree about the same unstorable field: it was a typed refusal on the document path and silent data loss on the typed one. It is reachable only through a computed key — `z.object({ __proto__: … })` written literally sets the shape object's prototype instead of creating an entry, while `z.object({ ["__proto__"]: z.string() })` yields a shape whose `Object.keys` really does contain it — and it is UNSTORABLE rather than merely reserved, because Zod drops the key from every parse result and reports success even when the field is required.

  The same misreading has a WRITE side, and it is now closed as a class rather than case by case. `bag[key] = value` on a `{}` literal does not create an entry when `key` is `__proto__`: it invokes `Object.prototype`'s `__proto__` setter, which reparents the bag for an object value and does nothing at all for a primitive, so the value is dropped and every later own-key read agrees the writer never wrote it. Kind names (`isValidKindName` admits `__proto__` exactly as it admits `toString`), schema property names, JSON-Schema keywords, query aliases and `JSON.parse`d document keys are all data, and all of them admit it. `normalizeEdges` in `defineGraph` and every other data-keyed accumulator in the tree now build through one owner, `createDataKeyedBag`, so an EDGE kind named `__proto__` survives `defineGraph`, schema serialization, and a live store round trip instead of vanishing between the config and the registration. Because the class had already recurred twice from an incomplete enumeration, it is made self-enforcing: a ratchet test scans `src/**` for statement-position `{}` initializations and fails on any that is not allowlisted with a stated reason. Behavior note for callers: none of this is observable on returned values — every record TypeGraph hands back (serialized schema maps, aggregate rows, select contexts, migration counters, extension documents) accumulates on a null-prototype bag internally and is spread into an ordinary object at the public boundary, which preserves an own `__proto__` alias as data while restoring `Object.prototype`, so `row.toString()` and `record instanceof Object` behave exactly as before. Relatedly, the field tracker and the selective projection now track a DECLARED field named `toJSON` as the stored data it is, instead of exempting the name unconditionally; the exemption survives, unchanged, for kinds that do NOT declare it, where it exists only to keep an incidental `JSON.stringify` of the tracking context from being recorded as a field access.

  Two remaining leaks of that internal null prototype are closed, and one of them was a behavior that depended on which query plan ran. A smart-selected alias object and its `meta` are guarded PROXIES, and a proxy's target is caller-observable — `instanceof`, `Object.getPrototypeOf` and every other internal method resolve against it, and no `get` trap can disguise it — so `ctx.p instanceof Object` answered `false` under a selective projection and `true` under the full mapper, for the same query. The boundary spread now happens inside the guard, so both mappers hand back objects rooted at `Object.prototype` while a projected field named `__proto__` survives as an own key; the tracking context handed to the `select` callback on the field-tracking pass got the same treatment, so the probe and the engine agree. `TransactionReceipt`'s `writes.nodes` and `writes.edges` are likewise ordinary objects now, matching `writes.identity`, which always was — a `__proto__` kind still reads back as an own key with its count. And the builder handed to an index `where:` callback is no longer built on a null prototype either.

  `defineNode` / `defineEdge` now REFUSE a schema containing a `z.lazy()` whose getter cannot run yet, with a `ConfigurationError` naming the kind and the dotted path. This is reachable from one shape: a mutually recursive pair declared AROUND the definition call, so the second `z.object()` const is still in its temporal dead zone when the first one's getter fires. Previously that branch was skipped, and skipping it was a fail-open — a definition is validated exactly once, so a `__proto__` nested under the unreadable subtree was accepted at definition time and then silently dropped by every parse, which is the precise outcome the unstorable-name refusal exists to prevent. Recursion itself is not refused: declaring both consts before the definition — which the error message asks for — resolves every getter, and the walk then reports the real conflict at its full nested path. Note that a `z.lazy` property field is typed `unknown` by the query introspector regardless, so predicates over it degrade; recursive property schemas are not a supported shape, and this makes the one silently-wrong case loud.

  An import UPDATE now asserts every component its verdict read, closing the temporal half of the class rounds 6 and 7 closed for edge kind and endpoints. `UpdateNodeParams` and `UpdateEdgeParams` each gain an optional `expectedValidFrom`, with the same MUST-apply contract as `UpdateEdgeParams.kind` — a backend that receives it has to put it in the statement's own `WHERE`, and the three states are distinct: omitted asserts nothing, `null` asserts `IS NULL` (an open-left window), a string asserts equality. Both bundled Drizzle backends satisfy it through one shared NULL-safe predicate builder; a hand-written `GraphBackend` must honor it or it will silently widen a write it was told to narrow. All four import update legs — node and edge, batched and per-row — now state the bound they validated the document's window against, so a concurrent hard-delete-and-recreate between the probe and the write matches no row instead of ignoring a `validFrom` the document stated or persisting a `validTo` below the new row's `validFrom`. They state it on exactly the terms the store paths do, because it is the same verdict object: a document naming neither `validFrom` nor `validTo` made the verdict read no bound, so its properties update is fenced on identity and liveness alone and a concurrent recreate that only moved the bound no longer refuses it. A node write that consequently matches nothing is reported per row with the new message prefix `INTERCHANGE_NODE_UPDATE_TARGET_CHANGED`; the edge equivalent keeps the published `INTERCHANGE_EDGE_KIND_CONFLICT` prefix, with the validity bound added to its message text. `ImportError` still carries no `code` field, so the prefix is the branchable token. Relatedly, a node update's row write and its uniqueness transition now commit or fail as ONE unit: the new keys are claimed before the row write (the claim upsert reports the key's final owner, so it IS the conflict gate, and a transaction holding the key cannot lose it to a peer), the row write follows, and the old keys are released only once it lands — with the claims compensated away if it does not. Import is the reason this has to hold on its own terms rather than on the transaction's: `onConflict: "update"` catches a per-row `UniquenessError`, records it, and commits everything else, so an ordering where the claim can fail AFTER the row changed reported `updated: 0` for a row whose props HAD changed, whose old reservation was released, and whose new reservation belonged to another node. The fulltext and embedding syncs still run after the row write, since a write that lands on nothing must not re-derive them.

  The same fence now covers the STORE update paths, which read the probed row's `valid_from` for exactly the same verdict. `store.nodes.*.update` / `upsertById` and `store.edges.*.update` / `upsertById` carry `expectedValidFrom` into the statement's own `WHERE` — but only when the window verdict actually consulted the row's bound, which is when the caller stated a `validFrom` to compare against it or a lone `validTo` to invert against it. A plain `update({ props })` names no window, reads no bound, and is fenced by nothing extra; that conditionality is not an optimization but the same "only what it asserted" rule the edge identity components already followed, since predicating a write on a component the caller never claimed refuses writes that are legitimate. The decision has one owner, and it hands over the predicate rather than a flag: `assertWritableValidityWindow` now RETURNS the `expectedValidFrom` fence its verdict obliges the write to carry — empty when the verdict read no stored bound — so the answer comes from the branches the guard actually took and there is nothing left for a caller to re-derive. Interchange import had re-derived it, asserting the probed `valid_from` unconditionally and over-fencing exactly the props-only updates the store paths left alone; that second spelling is gone rather than corrected. When the assertion does catch a replaced row the update CONVERGES rather than failing: it re-reads, re-merges the caller's partial props over the current props, and re-judges the window against the current bound, so a stated window that no longer fits is refused with the same typed `ValidationError` it would have raised on the first attempt, and one that still fits is applied to the row that really exists. Convergence is bounded at one retry; a peer that keeps replacing the row ends in a `DatabaseOperationError` naming the contention instead of a livelock or a false "not found". Two adjacent defects in the same paragraph of code are fixed with it: `applyNodeResurrect` reserved its uniqueness keys before the gating `deleted_at IS NOT NULL` update and kept them when the gate refused, so a resurrection that lost its race left reservations behind for a revival it never performed (it now runs through the same claim/gate/release transition as `applyNodeUpdate`, which gives the reservations back when the gate matches nothing); and the bulk `getOrCreateByConstraint` decided whether to resurrect from the uniques row its batch probe captured, while the single-item path decided from the node row it was about to write — one decision with two owners, now read from the node row on both.

  Relatedly, the builder a uniqueness `where` clause names fields on now answers for every declared field rather than only the fields the props bag happens to carry — which is what its type has always promised (`-?` makes every schema field required on the builder, precisely so a partial constraint can ask whether an OPTIONAL field is present). Naming an absent field previously hit the builder object's prototype instead: an everyday partial constraint over an absent optional field threw `TypeError: Expected a defined value` for every node written without it, and a field named `toString` found `Object.prototype.toString` and threw `isNull is not a function`. Such a field now evaluates as null, which is what a partial constraint means by absent — the same builder shape schema serialization has always captured a `where` clause with. `defineGraph` also refuses a `where` clause it can already see is broken, at definition time rather than on the first write it distorts: a callback that returns something other than a predicate, or a predicate naming a field the kind's schema does not declare, throws a `ConfigurationError` naming the kind, the constraint, and — for the undeclared field — the fields the kind actually declares. A statically typed caller could express neither mistake, so this bites generated or untyped definitions, where the old behavior was a constraint that quietly matched every row or partitioned on a field that was absent forever. A third state joins those two: a constraint carrying a `where` on a kind whose schema exposes no `.shape` — not an object schema, so there is no declared-field set to check the clause against — is REFUSED rather than left unvalidated, because skipping the check silently would disable the guard for exactly the untyped callers it was written for, who are also the only callers able to put a non-`ZodObject` there. Narrowly so: a plain `unique: [{ fields }]` on such a schema needs no shape to be meaningful and still works. And the same malformed clause is refused at EVALUATION too, not only at definition — `checkWherePredicate` throws the equivalent `ConfigurationError` for a callback that returns a non-predicate, so the third reader of a `where` clause now agrees with the other two (definition-time validation and persistence-time capture, all three reading the clause through one owner) instead of quietly treating a broken constraint as one that applies to every row. That matters for constraints built outside `defineGraph`, which never passed the definition-time gate. Because the check evaluates the clause, a `where` callback now runs one extra time when the graph is defined, so it must be pure — which it already had to be, since the uniqueness path evaluates it per write. This validates node kinds whose schema exposes an object shape; edge `unique` constraints are not covered.

  This adds public API surface — `InvalidMergeOptionsError`, `ExportStreamCancelledError`, `EDGE_IDENTITY_MISMATCH_CODE`, `MERGE_ERROR_CODES.invalidOptions`, the `GraphBackend.identityTableDdl` port with its `IdentityTableNames` type, the `VectorSearchFrontierTuning` type, `ExportOptionsSchema`'s `signal?: AbortSignal` (accepted by both `exportGraph` and `exportGraphStream`), the optional `kind` on `UpdateEdgeParams` / `DeleteEdgeParams` / `HardDeleteEdgeParams` from the `@nicia-ai/typegraph/backend` entry point plus the four optional endpoint assertions `fromKind` / `fromId` / `toKind` / `toId` on `UpdateEdgeParams` alone (one assertion that moves together or not at all, under the same MUST-apply contract as `kind`), the `"shared-storage-in-use"` member of `ContributionRebuildRefusal`, `ValidationErrorDetails.operation` widened with `"delete"` and `"hardDelete"`, the `details.requested` / `details.heldBy` pairing on every serialized-connection interchange refusal, and the new error codes: `INTERCHANGE_EXPORT_STREAM_ABORTED` on `ExportStreamCancelledError`, the `vector.searchFrontierTuning` value of `UnsupportedBackendCapabilityError`'s `details.capability`, and the interchange, identity, and provenance `ConfigurationError` codes (`INTERCHANGE_SERIALIZED_IMPORT_IN_PROGRESS`, `INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT`, `INTERCHANGE_SAME_SQLITE_BACKEND_SNAPSHOT`, `IDENTITY_UPGRADE_REQUIRES_ATOMIC_DDL`, `IDENTITY_TRANSACTION_NOT_WRITE_FENCED`, `IDENTITY_STORAGE_MISSING`'s new `details.reason` `"unfilled"`, `GRAPH_MERGE_PROVENANCE_ID_COLLISION` with its five refusal reasons, `GRAPH_MERGE_PROVENANCE_CLAIM_UNFENCED`, and `CONSTRAINT_WRITE_FENCE_UNSUPPORTED`, whose `details.constraint` carries one of `edgeCardinality` / `edgeMatchKeyConvergence` / `nodeDisjointness` / `nodeUniquenessScope` — the four members of the internal `ConstraintFenceReason` union, which is not itself exported; branch on the string values).

  Three refusals join the surface without a stable `details.code`, so match them by class plus `details` rather than by code. `assertApproximateMetricSupported` throws a `ConfigurationError` when `similarTo(..., { approximate: true })` is combined with a `metric` override that differs from the slot's declared metric, carrying `details` `{ nodeKind, fieldPath, requestedMetric, declaredMetric, indexType }`. `defineNode` / `defineEdge` throw a `ConfigurationError` for a schema property named `__proto__`, carrying `details.conflicts` and a `nodeType` / `edgeType` key. And a per-row import failure whose message is prefixed `INTERCHANGE_EDGE_KIND_CONFLICT` appears in `result.errors` when an interchange edge's id belongs to another kind — `ImportError` has no `code` field, so the message prefix is the branchable token, following the existing `windowErrorOf` idiom used by the validity-window import errors.

  Two of those are BREAKING for callers who reach past the bundled implementations. `VectorCapabilities.searchFrontierTuning` is REQUIRED, not optional: a hand-written vector strategy must now state whether its engine has a per-search ANN frontier knob — `{ tunable: true, parameter, indexType, requiresTransactionScope }` or `{ tunable: false, reason }` — rather than inheriting silence, which is the exact defect the field closes, and a strategy that omits it no longer compiles. And a hand-written `GraphBackend` must apply the new `kind` on the three edge params when it is present, and the four endpoint assertions on `UpdateEdgeParams` alongside it; a backend that accepts and ignores either turns a write the caller narrowed into an unscoped one, and nothing above it re-reads to catch that any more. Kind alone is not enough for the update: an edge's endpoints are immutable for a given row but its id is not, so a concurrent hard-delete-and-recreate under the SAME kind with DIFFERENT endpoints satisfies a kind-only predicate, and an upsert that resolved the id BY endpoints would write to an edge pointing somewhere it never looked. The endpoint fields are stated only by a write that actually checked them — a plain `update` on a kind-scoped collection resolved the edge by id and kind and states none of them, because predicating on endpoints it never checked would refuse legitimate writes. `tests/edge-write-self-verification.test.ts` asserts the contract against the bundled backends.

  It also changes behavior callers can observe: edge `bulkDelete`'s hooks; `importGraph` / `trustedImportGraph` / `trustedImportGraphStream` newly throwing the serialized-connection `ConfigurationError` codes (a new error type on the trusted-import surface); `persistProvenance`'s new pre-commit refusal turning a merge that previously committed-and-warned into one that refuses without touching the target; `mergeIncremental` refusing a commit whose fork point moved mid-call, where it previously committed diffs against a vanished ancestor; a stale explicit `previousRevision` now refused instead of rewinding the recorded clock; a SQLite vector or hybrid search that supplies `efSearch` now throwing `UnsupportedBackendCapabilityError` where it previously searched at the default frontier and said nothing; `defineGraph` throwing on a unique `where` clause that names an undeclared field, returns a non-predicate, or sits on a kind whose schema is not an object schema, and evaluating every such callback once at definition time; a graph-extension property named `__proto__` refused with `RESERVED_PROPERTY_NAME` at any nesting depth, and the same name in a `defineNode` / `defineEdge` schema refused with a `ConfigurationError`; a constrained write on D1, `neon-http`, or a `transactionMode: "none"` SQLite backend now refused with `CONSTRAINT_WRITE_FENCE_UNSUPPORTED` where it previously committed unfenced; `similarTo` with `approximate: true` and a mismatched `metric` override now refused where it previously served the exact scan and dropped one of the two options silently (`store.search.vector` / `hybrid` already refused every mismatched override on their own broader rule, and the builder's EXACT path stays deliberately wider — only the silent half is closed); an interchange edge whose id belongs to a row with a different kind OR different endpoints now reported as a per-row `INTERCHANGE_EDGE_KIND_CONFLICT` error naming the mismatched components, under `onConflict: "update"` (which previously overwrote the other row's properties while silently keeping its endpoints) and `"skip"` (which previously counted it present and silently lost it) — and the import's `updateEdge` statements carry the full identity assertion in their own `WHERE`, closing the concurrent-recreate window for endpoints exactly as it was closed for kind; and `MergeIncrementalArgs.options` narrowed to `Omit<MergeOptions, "target">` — a compile error for code that passed `options.target` to `mergeIncremental`, and a runtime `InvalidMergeOptionsError` for untyped callers that still do, where the named `target` argument previously won and `options.target` was silently ignored. So this release ships as a `minor`, not a `patch`.

- [#426](https://github.com/nicia-ai/typegraph/pull/426) [`eb4b9c1`](https://github.com/nicia-ai/typegraph/commit/eb4b9c1076eb67d54cf3a7692ebe8f9a3b203453) Thanks [@pdlug](https://github.com/pdlug)! - Refuse a `validFrom` that a live row's update cannot store, instead of accepting
  it and writing without it.

  An in-place update never rewrites `valid_from`; only a resurrection does. Stating
  a bound that named a different instant used to block coalescing, so the upsert
  wrote — bumping the version and capturing a history row — while the bound itself
  was dropped at the SQL builder and the row's window never moved. It now raises a
  `ValidationError` whose issue carries the new exported code
  `IMMUTABLE_VALIDITY_LOWER_BOUND`, naming both the stated instant and the one the
  row holds so the caller can restate it without a second read.

  This reaches every path that accepts `validFrom` against a live row: `upsertById`
  and `bulkUpsertById` (nodes and edges, including a repeated id in one batch, which
  is judged against the row the batch just queued), `getOrCreateByEndpoints` and
  `bulkGetOrCreateByEndpoints` with `ifExists: "update"` — which previously dropped
  the option before it reached any guard — and interchange import's
  `onConflict: "update"` legs, where it is recorded as a per-row error prefixed with
  the code rather than aborting the import.

  What stays legal: restating the bound a row already holds (nothing to apply, so
  nothing is ignored); a create or a resurrection, both of which store a stated
  bound and are the way to give a row a different one; zero-width windows; and
  `getOrCreateByEndpoints` returning an existing edge, which performs no write at
  all.

  Previously-accepted writes now refuse, so this is a MINOR bump — the same
  precedent as the window refusals in the two releases before it.

  Note for temporal imports: replaying an `includeTemporal: true` export over rows
  that were created separately now reports those rows instead of updating their
  props under a lower bound it ignored. Omit `validFrom` from the update document,
  export with `includeTemporal: false`, or import into a fresh graph.

- [#383](https://github.com/nicia-ai/typegraph/pull/383) [`bab0752`](https://github.com/nicia-ai/typegraph/commit/bab075213b480d61c91be06a2c833e510ab61a18) Thanks [@pdlug](https://github.com/pdlug)! - Merge an inherited row's end-of-validity instead of discarding it

  `update(id, {}, { validTo })` on a branch is an ordinary write, but the merge
  silently dropped it: modification detection compared properties only, so a
  branch that ended an inherited node's or edge's validity merged as a no-op.
  There was no workaround preserving row identity and history — deleting the row
  was the only statement the merge honored, and it is a strictly stronger one.

  An end-of-validity is now treated as a **sibling of deletion**:

  - one branch ends a row → that end is committed, including a _later_ end that
    extends the window;
  - several branches end it differently → no conflict; the **earliest** end wins
    (a fixed, commutative rule, so the merge stays order-independent);
  - `mergeIncremental()`'s target already ended it → the target's end stands, the
    same committed-target precedence identity survivors already get;
  - one branch ends it and another deletes it → deleted, with **no**
    `DeleteModifyConflict` — the stronger statement absorbs the weaker one;
  - a branch re-states the end the target holds → nothing is staged at all: no
    write, no version bump, no history row.

  `MergeReport` gains `validityEnds`, listing every row whose end the merge
  changed and the branches that claimed it — the arbitration is silent by design,
  so this is how a caller sees it happened. Window deltas the commit cannot apply
  to a live row (a fork `validFrom` divergence, or a `validTo` cleared back to
  open — both reachable only by soft-delete + resurrect inside a fork) are now
  reported in `dropped` with reason `"window-not-applicable"` instead of being
  ignored.

  **Behavior change.** Merges where a branch ended an inherited row now write that
  end, so new version bumps, history rows, and recorded-time entries appear where
  a no-op used to be. There is no opt-out flag: a permanent knob for "does the
  merge lose data" is worse than this note. Nothing that previously succeeded now
  fails.

  Also hardens `coalesceUnchangedUpserts`: the requested and stored valid-time
  bounds are compared as instants rather than as raw text, so the decision cannot
  come to depend on a dialect's timestamp rendering. A bound that is not a
  representable instant still counts as a change, so it reaches the write path
  that rejects it rather than being coalesced away.

- [#426](https://github.com/nicia-ai/typegraph/pull/426) [`eb4b9c1`](https://github.com/nicia-ai/typegraph/commit/eb4b9c1076eb67d54cf3a7692ebe8f9a3b203453) Thanks [@pdlug](https://github.com/pdlug)! - Report a non-canonical validity bound whether or not `coalesceUnchangedUpserts`
  is on.

  A parseable-but-non-canonical bound equal to the stored instant —
  `"2100-06-01T00:00:00Z"` against a stored `"2100-06-01T00:00:00.000Z"` — compared
  as "unchanged" with coalescing on, so the write was skipped and the
  `ValidationError` the same call raises with coalescing off was swallowed. An
  unrelated performance flag decided whether malformed input was reported.

  A non-canonical REQUESTED bound now counts as a window change, so it reaches the
  write path and raises identically either way. Re-stating a window in canonical
  form still coalesces, including against a driver that renders the stored value as
  an equivalent zoned string: only the stored side needs canonicalizing, because
  the requested side is held to canonical form by the write validation this no
  longer hides.

- [#394](https://github.com/nicia-ai/typegraph/pull/394) [`6dd43c4`](https://github.com/nicia-ai/typegraph/commit/6dd43c40bbb988fc8d112f177f03caab86c18359) Thanks [@pdlug](https://github.com/pdlug)! - graph-merge: scope the edge repoint/dedupe fold to collisions repointing caused

  A TypeGraph store is a multigraph: nothing enforces uniqueness on
  `(from, kind, to)`, `create()` makes a parallel edge, and
  `getOrCreateByEndpoints()` is the opt-in set-semantics accessor. The merge's edge
  fold nevertheless grouped **every** staged edge by `(from, kind, to)` and collapsed
  each group onto its lowest-sorting edge id, so a branch that created a parallel
  edge lost one of the two rows — and _which_ one it lost depended on how the
  branch-created id happened to sort against the existing one.

  The fold is now restricted to what it was designed for. It groups staged edges by
  the endpoint pair they named **before** repointing, and collapses one row per pair —
  so a collision the canonicalization itself induced (`x → a` and `x → b` both becoming
  `x → c*`) still folds to a single edge, keeping the existing min-id-survivor,
  property-reconciliation, and end-of-validity behavior. Edges that already shared
  their endpoints are no longer folded together: each distinct edge id commits as its
  own parallel row, and a valid-time end lands on the row whose author claimed it
  rather than migrating to an unrelated survivor.

  A group that mixes the two folds only **across** the pairs. A repointed `x → b`
  joining two parallel `x → a` rows merges into one of them, and the other row still
  commits with the edit its author made — repointing said nothing about the rows that
  were already there. Previously the whole group collapsed, which dropped that edit
  silently: a folded-away row is never rewritten.

  What makes two staged edges "the same row" is their **edge id**, not equal
  properties. One inherited edge staged by several branches still folds into a single
  write with its property disagreements reconciled; a branch-created edge is a new
  parallel row even when its properties coincide with an existing one's.

  Merges that previously collapsed parallel edges will now commit both, and the
  spurious `PropertyConflict` those collapses reported between two rows that were
  never the same row is gone.

- [#406](https://github.com/nicia-ai/typegraph/pull/406) [`248f56a`](https://github.com/nicia-ai/typegraph/commit/248f56ab2c8bc849fe9385157f02344c7ceb612d) Thanks [@pdlug](https://github.com/pdlug)! - Refuse valid-time windows of negative width. A write whose `validTo` precedes
  the row's effective `validFrom` describes a row that stopped being true before
  it started — observable at no `asOf` coordinate, and unrepairable by any later
  write — and it used to be accepted silently on every path except a node update.
  It now raises a `ValidationError` whose issue carries the new exported code
  `INVERTED_VALIDITY_WINDOW`.

  This is a behavior change: writes that previously succeeded now fail. Two shapes
  refuse where they did not before.

  - A stated `validFrom` / `validTo` PAIR must be ordered, on node and edge
    `create`, `upsertById`, `bulkUpsertById`, `getOrCreateByEndpoints` and its bulk
    form, and on an imported document. `getOrCreateByEndpoints` judges the pair
    before its existence probe, so whether a call is valid no longer depends on
    whether the edge happens to exist yet.
  - An UPDATE's lone `validTo` must not precede the lower bound the row carries.
    Nodes already enforced this; edges did not, which is how a graph merge could
    hand a committed edge an end predating its start and still report success. This
    covers a resurrecting write too: an edge RETAINS its `valid_from` across
    resurrection, so reviving one into a window that closed before it began now
    means restating the start — pass `validFrom` alongside `validTo`. Landing a
    revived edge in the ENDED state is otherwise unchanged.

  `getOrCreateByEndpoints` and its bulk form now honor `validFrom` on the
  `"resurrected"` branch, where they previously accepted it and silently dropped
  it — which is what left the refusal above with no way to satisfy it. As the
  backend has always documented for a resurrecting write, naming `validFrom`
  asserts the COMPLETE window, so an accompanying `validTo` is applied and an
  omitted one REOPENS the revived row rather than leaving the tombstoned
  incarnation's end in place. A `"found"` or `"updated"` live edge is unaffected:
  its stored lower bound is history and still stays put.

  Interchange import records the refusal as a per-row error prefixed with
  `INVERTED_VALIDITY_WINDOW`, so one bad row does not abort the import; its
  `onConflict: "update"` legs are held to the existing row's `valid_from` exactly
  as a direct `update` is. Trusted import refuses the whole stream with reason
  `invalid_stream`.

  Two shapes stay legal, deliberately. A ZERO-width window
  (`validTo === validFrom`) is what a same-instant retraction produces at
  millisecond precision, so the store's own output still round-trips. An INSERT
  carrying a lone historical `validTo` still means "born already ended": the write
  instant stamped as `valid_from` is a storage convention rather than a caller
  assertion, and such a row is read back through `includeEnded`.

- [#380](https://github.com/nicia-ai/typegraph/pull/380) [`2c5dd29`](https://github.com/nicia-ai/typegraph/commit/2c5dd29d9c23024119589d5360b265a0c3ab49da) Thanks [@pdlug](https://github.com/pdlug)! - Store the cause of an identity assertion's ending instead of deriving it.

  The identity assertion relation and its recorded mirror gain nullable
  `ended_by_kind` / `ended_by_id` columns. A node soft-delete cascade stamps the
  deleted node's `(kind, id)` onto every assertion it ends, in the same statement
  that closes the row; `NULL` means the row was retracted explicitly. Graph
  merge's `RetractionCause` now reads that column instead of comparing an
  assertion's `valid_to` against a deleted endpoint's `deleted_at`.

  This removes the derivation's same-millisecond residue: a retraction issued in
  the same millisecond as the delete that followed it is now classified as
  `explicit` and survives a merge whose deletion is overruled, where the
  timestamp comparison could only read the tie as a cascade and drop the
  branch's intent. The hard-delete residue remains by design — a hard delete
  removes the assertion rows outright, so no evidence survives to read.

  Archival interchange carries the cause as an optional `endedBy` on each
  assertion, so an export/import round-trip preserves why an assertion ended.
  Import rejects an `endedBy` on an open assertion
  (`IDENTITY_IMPORT_ENDED_BY_WITHOUT_END`) or one naming a node that is not an
  endpoint of the assertion (`IDENTITY_IMPORT_ENDED_BY_NOT_ENDPOINT`); a CHECK
  constraint on the relation backs both rules at the database.

  Operational Identity has not shipped in a release, so the relation changes
  shape with no migration path.

- [#268](https://github.com/nicia-ai/typegraph/pull/268) [`9721ba2`](https://github.com/nicia-ai/typegraph/commit/9721ba2854f6e5504018ee8c3b7a0eaaf87314bb) Thanks [@pdlug](https://github.com/pdlug)! - Add the opt-in TypeGraph Identity Profile with typed store, transaction, and
  temporal-view APIs; configurable same-ID folding or assertion-only identity;
  kind-branded and hydrated member reads; idempotent assertion receipts; ended
  assertion retraction results; assertion history; interchange and graph
  merge propagation; identity-expanded traversal; cross-backend closure storage;
  and fail-fast capability errors for non-transactional D1 and neon-http drivers.

  Harden ontology construction and reload validation: propagate disjointness
  through interleaved subclass and equivalence closure, validate inverse endpoint
  compatibility and partner uniqueness, reject unresolved extension edge names in
  `inverseOf` and `implies` while retaining absolute external IRIs, recompute
  serialized closures, and deprecate the type-level `sameAs` and `differentFrom`
  factories in favor of Operational Identity.

  **Behavior changes.** Ontology and registry validation is now stricter and runs
  both at graph construction and when a persisted schema is loaded, so a few
  patterns earlier versions silently accepted now throw a `ConfigurationError`:
  duplicate ontology relations, hierarchical self-loops, disjointness
  contradictions (a kind disjoint with itself, with a subclass ancestor, a common
  subclass of two disjoint parents, or a kind declared both `equivalentTo` and
  `disjointWith`), multiple distinct `inverseOf` partners for one edge, inverse
  endpoint incompatibility, and unresolved extension edge names in `inverseOf`
  or `implies`. To
  recover, fix the graph definition; for a persisted extension document, correct
  the stored document before upgrading (or rewrite it through the previous minor,
  which still accepts it). Interchange documents remain readable across versions —
  `1.0` documents are still accepted on import, and exports write `2.0`.
  Trusted import rejects identity-enabled target stores (`identity_unsupported`)
  and identity-bearing input (`invalid_stream`) rather than silently dropping
  assertions or leaving the derived closure empty; use `importGraphStream` for an
  export that carries identity truth.
  Bundled SQLite and PostgreSQL backends provision the three identity relations,
  including effective custom `SqlSchema` names, before first-enable preflight. An
  already-enabled graph with missing identity storage instead fails with
  `IDENTITY_STORAGE_MISSING`; restore missing ledgers from backup, or recreate a
  missing derived closure and rebuild it before serving traffic.
  `create()`/`upsertById()` of a soft-deleted same-`(kind, id)` row now resurrects that
  row on every graph (properties replaced, validity window reset so `validFrom`
  becomes the resurrection instant) rather than leaking a storage constraint
  error. These are additive-strictness and semantics-pinning changes on top of
  the new opt-in profile, hence the minor bump.

  **Type-level breaking notes for backend and tooling authors.**

  1. `ResolvedSqlTableNames` gained three required fields
     (`identityAssertions`, `recordedIdentityAssertions`, `identityClosure`).
     Out-of-tree `GraphBackend` implementations must supply them; the
     `SqlTableNames` input type keeps these optional, so only the resolved
     type is total.
  2. `SqlSchema` (the abstract class) gained three abstract members
     (`identityAssertionsTable`, `identityClosureTable`,
     `recordedIdentityAssertionsTable`). External subclasses must add them;
     the `createSqlSchema` factory path is unaffected.
  3. `FORMAT_VERSION`'s literal type changed from `"1.0"` to `"2.0"`.
     Comparisons like `FORMAT_VERSION === "1.0"` are now type errors; both
     versions remain accepted on import.

  **Behavioral note.** `revisionNow()` now returns
  `Promise<RecordedInstant | undefined>` (a branded string, assignable to
  `string`; use `asRecordedInstant` to round-trip).

  **Review-hardening pass (same release).**

  - `store.identity` and the read-only view `identity` surfaces now use the same
    conditional presence as `tx.identity`: the property does not exist on
    identity-disabled graph types, so misuse is a compile error. The
    `IdentityFacadeFor` / `IdentityReadFacadeFor` helper aliases and the
    duplicate `IdentityNodeRef` type are gone (use `IdentityFacade`,
    `IdentityReadFacade`, and `GraphNodeReference`); the loose input type
    formerly named `GraphNodeRef` is now `IdentityNodeRefInput`.
  - `StoreView` and `RecordedStoreView` are now type aliases over an
    implementation class plus `ViewIdentityAccess`, exported alongside a
    construction-compatible `const`. `new StoreView(...)` and
    `instanceof StoreView` keep working; subclassing them does not.
  - `MergeReport.merged` gained an `identity: { asserted, retracted }` section
    (`MergedCounts`), and `DroppedItem` is now a discriminated union
    (`kind: "node" | "edge" | "identity"`) so dropped identity assertions are
    enumerable in the report.
  - Identity merge conflicts — including transitive `same`/`different`
    contradictions, retract/reassert races, and assertions over merge-deleted
    nodes — are detected at plan time and surface as `IdentityMergeConflictError`
    (`GRAPH_MERGE_IDENTITY_CONFLICT`) through `merge()`'s returned `Result`.
    Convergent edits (the re-asserting branch itself also retracted the pair)
    merge cleanly.
  - `ImportError.entityType` widened to `"node" | "edge" | "identity"`; identity
    import failures are recorded in `result.errors` instead of throwing.
    Archival identity imports now bound validity windows (`validTo` must not be
    in the future for ended rows, `validFrom` must not be for open rows) with
    `IDENTITY_IMPORT_FUTURE_VALID_TO` / `IDENTITY_IMPORT_FUTURE_VALID_FROM`.
  - Changing `identity.sameIdAcrossKinds` is now classified a breaking schema
    change requiring explicit migration; explicit `migrateSchema()` rebuilds the
    identity closure atomically with the schema commit, and an unapplied
    identity-only breaking change surfaces `IDENTITY_PROFILE_MIGRATION_PENDING`
    rather than a generic `MigrationError`.

  **Performance.** Current-coordinate identity reads (`membersOf`, `areSame`,
  `areDifferent`, `representativeOf`, `nodesOf`) were O(total graph size) on
  SQLite — the class-members lookup defeated the closure's class index and the
  planner scanned every live node per read. The rewritten statement is
  O(class size): ~40x faster on a populated graph (0.013 ms vs 0.56 ms per
  read at ~6,000 nodes), with a smaller improvement on PostgreSQL.

  **Follow-up hardening (same release).** `ValidationIssue` gained an optional
  `assertionId` field carrying the offending identity assertion structurally;
  identity import failures (self-assertions included) attribute their
  `result.errors` entries by that id, never by message parsing. The identity
  enablement preflight is derived inside `initializeSchema()` itself, so every
  public first-commit path — bare `ensureSchema`/`initializeSchema` included —
  builds and validates the closure atomically with version 1. Identity reads on
  `includeTombstones` views hydrate soft-deleted rows the coordinate makes
  visible instead of silently dropping them.

  **Import error attribution.** The import coordinator tags rethrown errors
  with the id of the assertion it was applying, so `ImportResult.errors`
  attribution for contradictions and missing endpoints identifies the failing
  assertion rather than the first assertion sharing its endpoints.

  **The identity preflight is not substitutable.** `initializeSchema()` and
  `SchemaManagerOptions` no longer accept a schema-commit preflight callback —
  a no-op callback could suppress the mandatory closure build at version 1.
  Both (and `MigrateSchemaOptions`) instead accept the effective `SqlSchema`
  (`schema`), and every identity-enabled schema commit derives the closure
  preflight internally from it.

  **One schema source in the batteries-included constructors.** The nested
  `schemaManagement` option no longer accepts `schema` (typed out and stripped
  at runtime): the effective `SqlSchema` has exactly one source, `store.schema`,
  which also drives physical table provisioning — a second schema could name
  tables that were never created. The manager brand-validates the `schema`
  option with `requireSqlSchema()` before any DDL or version commit, so a
  schema-shaped plain object is rejected (`INVALID_SQL_SCHEMA`) instead of
  committing a closure into tables the Store never reads.

  **Historical bridges must exist; plan-time simulation knows the profile.**
  Archival identity imports now require every ended assertion's endpoints to
  exist structurally (soft-deleted rows qualify; the store's own exports
  already satisfy this), so a hand-built document can no longer conduct
  historical identity through a node that never existed. The graph-merge
  plan-time contradiction check now simulates the target's identity semantics
  — implicit same-id folds under `sameIdAcrossKinds: "fold"` and ontology
  `disjointWith` between class member kinds — so those contradictions surface
  as `GRAPH_MERGE_IDENTITY_CONFLICT` at plan time instead of a generic commit
  failure. Counterfeit schema objects are rejected before any identity DDL
  runs, on fresh and already-enabled graphs alike.

  **Assertion-free nodes join the plan-time simulation.** The merge planner's
  contradiction check now seeds its universe with every post-merge canonical
  node and the live target peers sharing their ids (one kind-free indexed
  probe, only under `sameIdAcrossKinds: "fold"`), so a node no assertion
  names — newly created, retyped, or an existing same-id peer — can no longer
  fold into a disjoint-kind class undetected and fail at commit as a generic
  merge error.

  **Universe seeding, precisely.** The plan-time simulation seeds retyped
  canonical nodes under the kind the commit writes (not their pre-retype
  kind), the live same-id peer probe reads the merge TARGET when it differs
  from the diff source (`mergeAgainstBase`, `mergeIncremental`), and the
  incremental commit revalidates the probed peer set inside its transaction —
  a same-id peer landing in the plan→commit window is refused as the same
  typed replan error the other window guards raise.

  **The window guard ranges over the committed plan.** The incremental
  fold-peer revalidation compares only ids the final plan folds on —
  commit-ready canonical nodes and remapped assertion endpoints — so a window
  row at an id canonicalization dropped is tolerated as an ordinary target
  advance instead of raising a spurious replan error.

  **The window guard is class-transitive.** The incremental fold-peer guard
  also snapshots each final seed's structural identity class at plan time and
  revalidates the fingerprints inside the commit transaction — a window row
  or assertion that joins a seed's class through another member (leaving the
  seed's direct same-id peers untouched) is refused as the typed replan
  error, and a rerun surfaces the contradiction as a plan-time
  `GRAPH_MERGE_IDENTITY_CONFLICT`.

  **A validated baseline, exactly.** The incremental identity guard now
  re-probes and snapshots the final seeds' classes AFTER planning and re-runs
  the identity simulation against that exact snapshot — its members join the
  simulation universe unlinked, with connectivity rebuilt from the
  deletion-filtered fresh ledger and fold unions — so drift landing between
  planning and the snapshot fails as a typed plan-time conflict instead of
  becoming the guard's baseline. Fingerprints are structurally encoded (injective for ids
  containing any character) and carry a liveness bit, so a planned assertion
  endpoint deleted in the commit window is refused as the typed replan error
  rather than failing generically.

  **Negative truth in the baseline.** The post-plan identity recheck consumes
  the target's FRESH assertion ledger (not the pre-planning staging capture),
  and the transaction guard carries a deterministic fingerprint of the
  `different` assertions touching the guarded universe — a `different`
  committed in either window is refused typed instead of surfacing as a
  generic commit failure.

  **The identity guard covers both profiles.** The incremental identity
  baseline, class/liveness fingerprints, and negative-ledger guard run for
  every identity-enabled merge — under `sameIdAcrossKinds: "ignore"` too,
  where explicit assertions still change plan legality. Only the same-id
  fold expansion stays profile-gated; the plan-time simulation additionally
  models the profile-independent create-time constraint that one id cannot
  be shared by ontology-disjoint kinds, and the direct-peer window check
  refuses a disjoint same-id arrival under `"ignore"` while tolerating a
  benign one.

  **Replacement is legal.** Planned node deletions are excluded from both
  sides of the incremental identity guard (peers, liveness, class members,
  and the ledger slice), and `applyMergePlan` soft-deletes nodes BEFORE the
  node writes — so a plan replacing a node with a disjoint same-id one (the
  order the create-time constraint permits, and the order the same
  operations run directly on a store) commits instead of being falsely
  rejected or failing at apply.

  **Deleting a bridge splits the class.** The incremental recheck derives
  connectivity from the deletion-filtered fresh ledger and the checker's
  fold unions — never by pre-linking the old closure's filtered member
  lists — so a plan that deletes an identity bridge and asserts its former
  ends `different` commits instead of being falsely rejected. Snapshot class
  members still join the simulation universe (unlinked) so fold links at
  unprobed ids keep participating.

  **The transaction re-derives legality.** The incremental commit guard's
  final step re-runs the full identity simulation on transaction reads —
  fresh deletion-filtered ledger, snapshot members, fold unions — so drift
  that leaves every fingerprint unchanged (a redundant `same(a, b)` that
  becomes the surviving link once the plan removes the pair's bridge) is
  refused as the typed replan error instead of failing generically at apply.

  **One assertion id, one truth — validated where it can be typed.** The
  planner refuses one id staged for two different complete truths and any
  staged id already identifying different truth among the target's stored
  rows (ended included, exactly the set the import coordinator compares);
  the commit transaction revalidates every planned id against transaction
  reads (both commit modes), so a window row reusing a planned id — even with
  endpoints entirely outside the guarded universe — refuses as the typed
  replan error instead of a generic id-conflict at apply.

  **Retractions carry their complete truth.** A merge plan's identity
  retractions are full expected rows, never bare ids: the planner validates
  each one against the row its id identifies on the target and SKIPS —
  reported as `identity:retraction-target-mismatch` in `dropped` — a
  retraction whose id the target reuses for different truth, instead of
  ending a row the branch never saw. The commit transaction revalidates the
  surviving retractions (and every planned assertion id) by id in BOTH
  commit modes; snapshot commits need this explicitly because the legacy
  base@V token fingerprints only CURRENT assertions, so an ended window row
  claiming a planned id would otherwise slip through to a generic apply
  failure. The raw staged assertions are also checked one-id-one-truth
  BEFORE the semantic survivor dedupe, closing the validity-only collision
  (same id, same pair, different `validFrom`) that dedupe used to collapse
  silently while the report listed the id as both applied and dropped.

  **The applier is the completeness backstop, typed.** Any identity refusal
  that still escapes the commit — an invariant the plan-time simulation
  does not (yet) mirror — is translated into the typed
  `IdentityMergeConflictError` with the applier's error as its cause,
  instead of surfacing as the generic merge wrapper. Identity-typed
  environment errors (missing profile, non-atomic backend) pass through
  unchanged. A property-based law suite additionally quantifies the merge
  contract over randomized identity histories on both backends: refusals
  are always typed, a committed ledger is internally consistent, pre-merge
  truth survives unless a branch retracted it or deleted an endpoint, and
  the report never lists an id as both dropped-as-duplicate and newly
  current.

  **Truth replacement is visible to the diff.** The identity diff compares
  ids present on both sides by COMPLETE truth, not presence: a branch that
  hard-deletes an assertion's endpoint (physically removing the row),
  recreates it, and imports the same id for different truth used to diff as
  empty — the merge silently kept the base truth the branch had replaced.
  The replacement now stages as a retraction plus a new assertion, and
  because the applier never reuses an ended row's id, the merge refuses
  typed instead of silently preserving either side.

  **Identity semantics extracted; translation at the applier boundary.**
  The plan-time identity derivation, contradiction simulation, and commit
  guards now live in `graph-merge/merge-identity.ts` with a one-directional
  dependency from the merge orchestrator (functions take a structural
  `IdentityPlanSlice`, never the full plan type). The typed-conflict
  translation wraps exactly the identity-apply call inside the commit, so
  it also classifies refusals whose identity code lives in nested
  validation issues (`details.issues[].code`) and — because only identity
  rows are applied at that boundary — a missing-node error there can only
  mean a vanished assertion endpoint, which now translates too instead of
  surfacing as the generic wrapper. Exact-duplicate staging (two branches
  importing one identical row) no longer reports the id as dropped while
  applying it.

  **Five laws, three lanes.** The property suite now also holds every
  successful merge to BRANCH-EFFECT accounting — every truth a branch holds
  is applied with equal complete truth, enumerated as dropped, retracted,
  or invalidated by an endpoint deletion; silent loss is a law violation —
  and runs the whole law set in three lanes: snapshot `merge()` under both
  identity profiles (with hard-delete/recreate and same-id fold peers in
  the operation alphabet) and `mergeIncremental()` against a target that
  ADVANCED after the fork, where branch truth meets independently-moved
  target truth. Truth-preservation and branch-effect exclusions are
  truth-aware: a retraction excuses a row's death only when the retracted
  COMPLETE truth matches, and a hard-delete/recreate excuses exactly the
  rows it physically killed, not everything ever touching the node. A
  dropped-as-duplicate id must never be current post-merge. The generator
  skips only expected semantic refusals (contradiction, missing node); any
  other error fails the run rather than silently emptying the histories.
  Independent-target merge semantics are now documented in the identity
  guide.

  **The survivor pick respects committed truth.** The law suite caught its
  first live defect within a day: a branch-minted assertion id could win
  the semantic-pair dedupe against the target's own committed row — the
  applier (idempotent per pair) then skipped the write, so the report
  claimed an id as applied that never landed while listing the target's
  committed row as dropped. Ids already committed on the target with the
  exact staged truth now always win the survivor pick, pinned by a
  deterministic incremental test alongside the law.

  **The simulation uses the plan's REAL canonical map.** Both closure
  re-runs (post-plan and in-transaction) previously reconstructed the
  member→survivor map from the report-shaped resolutions, which drops pure
  ontology-retype clusters and mis-keys mixed-kind members — degrading the
  decisive in-transaction backstop into judging endpoints at pre-merge
  identities (a false negative) and enabling an unresolvable replan loop (a
  false refusal). The plan now carries the exact `canonicalOf` map the
  commit repoints edges with, and the reconstruction is deleted. The
  simulated base ledger is also deletion-filtered inside the checker
  itself, so all three call sites share one post-deletion rule.

  **An overruled deletion no longer ends identity truth.** A node
  soft-delete cascades — it ends every open assertion touching the node —
  so the deleting branch's diff stages those endings as retractions
  indistinguishable from intent. When the delete/modify resolution keeps
  the modification (the default `"flag"` and `"modifyWins"` policies), the
  node survives, and the cascaded retraction is now dropped with it —
  reported as `identity:deletion-overruled` — instead of ending the
  resurrected node's assertions anyway.

  **Identity-only merges advance the revision clock.** The interchange
  import records capture touches through its own recorded binding, so a
  merge whose only effect was creating assertions never marked the mutation
  as written: the durable revision clock stayed unmoved and every base@V
  token went stale, letting a later commit's target-unchanged guard pass
  against a target that DID move. The apply now marks the write from the
  import summary, with a regression test on a revision-tracking store.

  **Guard structure hardened.** The by-id freshness check is invoked
  directly by BOTH commit paths (never through the peer-probe guard's early
  return), the environment-code passthrough covers the identity
  environment/corruption codes that must never be translated into replan
  advice, and one id staged as both a new assertion and a retraction — an
  applier-refusing shape currently unreachable through any supported
  staging path — refuses typed defensively at plan time.

  **External-review hardening (cross-model pass).** An independent review
  with a different model produced six verified fixes: (1) the
  deletion-overruled retraction filter is provenance-aware — a retraction
  is dropped only when EVERY contributing branch is explained by an
  overruled endpoint deletion, so a branch that retracted independently
  keeps its effect (the earlier filter silently suppressed it); (2)
  committed-row precedence in the survivor dedupe is RE-DERIVED after
  endpoint canonicalization, closing the collision the first fix missed
  when reconciliation collapses a branch pair onto a committed target
  pair; (3) merges refuse, typed, any branch whose store ran a schema
  operation after forking (its committed schema hash no longer matches the
  fork source's) — schema side effects can no longer be smuggled into a
  data merge as bare identity changes; (4) a kind-dropping
  `migrateSchema()` now cascades the assertion ledger exactly as
  `Store.removeKinds()` does, instead of stranding current assertions on
  unregistered kinds where a later "no-op" merge would end them; (5) a
  staged survivor's valid-time window travels with the commit write, so a
  branch-authored — possibly already ended — window survives resurrection
  instead of being reset to merge time and silently joining a live fold
  class; (6) `merged.identity` reports rows the applier actually created
  and ended (idempotent skips excluded) instead of planned intents, and
  the replan-vs-conflict error suggestions are path-specific. Temporal
  windows on MODIFIED inherited nodes remain outside merge state — a
  documented boundary.

  **Second cross-model pass: the fixes' own compositions.** A follow-up
  external review of the previous round's fixes produced seven more
  verified corrections. The schema-drift guard now anchors on the branch's
  AT-FORK `(version, hash)` row — a round-trip migration that restores the
  document hash still advances the monotonic version and is refused, and
  unmanaged fork sources are no longer falsely rejected; revision-anchored
  `base@V` tokens bake in the active schema version, fencing the same
  round-trip on the target side (the legacy content fingerprint already
  covered it). Kind-dropping schema operations cascade the assertion
  ledger even when identity is DISABLED at drop time (the ledger, not the
  schema profile, is the signal), and first enablement purges assertions
  naming unregistered kinds, so historical orphans cannot be adopted into
  a fresh closure. Node resurrection carries `validFrom` through the
  internal update path (a branch-authored ended window no longer inverts
  into merge-time-start), merged edges carry their staged windows exactly
  as nodes do, and when the live incremental target itself contributed the
  surviving member, the TARGET's committed window wins over a branch
  re-window. Canonicalization that would move a COMMITTED assertion's own
  endpoints refuses with a specific typed conflict (committed rows cannot
  be rewritten), and window-identical upserts coalesce again instead of
  rewriting version and history state.

  **Final pre-merge pass.** A last scoped external review of the previous
  hardening commit returned three refinements, all applied: the
  disabled-identity cascade's outside-transaction emptiness probe is
  skipped when THIS commit is the one disabling identity (writers on the
  still-enabled prior schema could otherwise slip an assertion in between
  probe and lock — the locked cascade always runs for that shape); node
  writes validate the EFFECTIVE validity lower bound, so a lone historical
  `validTo` on a resurrecting upsert refuses typed instead of persisting a
  born-inverted, permanently invisible window (edge resurrection keeps its
  sanctioned resurrect-as-ended contract — edges retain their stored lower
  bound, so the node-side corruption cannot arise there); and bulk edge
  coalescing compares explicit windows against the stored window, so
  no-op incremental merges stop rewriting byte-identical target edges.
  The property law lanes carry explicit five-minute test budgets sized
  for coverage-instrumented CI shards.

- [#375](https://github.com/nicia-ai/typegraph/pull/375) [`fc6075d`](https://github.com/nicia-ai/typegraph/commit/fc6075ddca02de4c0fa9d15167c124868ab947b5) Thanks [@pdlug](https://github.com/pdlug)! - **The merge commit proves its own identity result.** After a merge commit's
  identity DML, and inside the same transaction, the applier now re-derives the
  identity classes the merge TOUCHED and refuses a contradiction there — a class
  whose member kinds the ontology declares disjoint, or a current `different`
  assertion whose endpoints share a class. Both commit modes run it, seeded from
  the planned assertion and retraction endpoints plus (under
  `sameIdAcrossKinds: "fold"`) the node identities the commit writes, so the cost
  is proportional to the affected classes rather than the graph.

  This makes a committed identity ledger correct independently of the plan-time
  simulation, which reasons about state read before any write. The simulation and
  the commit-window fingerprints remain as the diagnosability layer: they refuse
  early, before anything is written, naming exactly what drifted.

  Because the scans resolve classes through the materialized closure — the same
  authority every current identity read uses — a closure that lags its ledger can
  hide a contradiction as easily as invent one. On any inconsistency the closure
  is rebuilt from the base relations inside the commit transaction and the scans
  re-run against it: a clean second pass means the closure was stale and is now
  repaired atomically with the merge, while a repeated contradiction aborts the
  whole merge. There is no partial commit either way.

  `IdentityContradictionErrorDetails.operation` gained a `"merge"` member for
  this refusal, which reaches callers as the existing
  `IdentityMergeConflictError` (`GRAPH_MERGE_IDENTITY_CONFLICT`) with the
  contradiction as its cause.

### Patch Changes

- [#418](https://github.com/nicia-ai/typegraph/pull/418) [`5795127`](https://github.com/nicia-ai/typegraph/commit/57951275ee6310bcbfebadb1e3bdc46204769052) Thanks [@pdlug](https://github.com/pdlug)! - store: coalesce a bulk upsert that re-states a row's own validity window

  `bulkUpsertById` now decides whether a requested `validFrom` / `validTo` is a
  change the same way `upsertById` does, through one shared comparison, so a batch
  and the same items applied one at a time write the same rows.

  Two defects met in that comparison. The node bulk path refused to coalesce
  whenever an item named a bound AT ALL, so any caller that re-stated a row
  together with the window it already holds — a merge commit, or any
  read-modify-write loop that round-trips `meta.validFrom` — bumped the row's
  version and wrote a history and revision entry for a row that did not change.
  The edge bulk path did compare, but compared the bounds as DRIVER TEXT: a
  Postgres driver that renders `timestamptz` as a zoned string rather than a
  `Date` yields text that is equivalent to the caller's canonical ISO bound
  without being identical to it, so the same batch could coalesce on one backend
  and write on another. Both paths now compare INSTANTS, and an unrepresentable
  bound still counts as a change so the write path raises the `ValidationError`
  the caller is owed rather than coalescing it away.

  The bulk paths also track the window each queued write leaves behind, so a
  repeated id in one batch is compared against the batch's own pending state
  rather than the once-prefetched row. Previously an edge item that re-stated the
  window the row held BEFORE the batch was read as unchanged and skipped, dropping
  a write the sequential path performs. A later copy that re-states the window a
  queued write established coalesces; one that names a bound the backend was left
  to stamp (an omitted `validFrom` on a create) writes, since that instant is not
  knowable batch-locally.

- [#363](https://github.com/nicia-ai/typegraph/pull/363) [`cdc904b`](https://github.com/nicia-ai/typegraph/commit/cdc904b574d4aa5a4ef10f3378b1ca4079373209) Thanks [@pdlug](https://github.com/pdlug)! - Chunk iterative graph-algorithm node-kind initialization within each backend's bind-parameter budget.

- [#396](https://github.com/nicia-ai/typegraph/pull/396) [`994c7da`](https://github.com/nicia-ai/typegraph/commit/994c7da9aff06d995680381e3b43c4a05bece5a3) Thanks [@pdlug](https://github.com/pdlug)! - Reach the candidate edge of a current-coordinate identity-expanded traversal by
  an equi-join instead of a correlated membership scan

  An identity-expanded hop at the current coordinate read the materialized closure
  from inside a correlated `EXISTS`, so nothing in the join condition linked the
  frontier row to the edge row. Both engines were free to enumerate
  _frontier rows × edges of the matching kind_ and probe the closure per pair, which
  cost quadratically in graph size.

  Each traversal step now widens its frontier onto the closure's class members with
  an outer join, so the candidate edge is reached by the same ordinary indexed
  equality a traversal without identity expansion uses. One compiler path serves
  both coordinates and both emitters. On SQLite a hop over 100,000 matching edges
  from a 500-row frontier drops from 51.6 s to 77 ms, and `EXPLAIN QUERY PLAN`
  seeks `typegraph_edges_from_idx` where it used to scan every matching edge per
  source row; PostgreSQL drops from 9.2 s to 61 ms.

  A traversal at a **historical** coordinate reaches its candidate edge through the
  same step, so it gains the same join order: on SQLite an `asOf` hop over 100,000
  matching edges drops from 31.3 s to 241 ms. That coordinate's own remaining cost
  is the ledger reconstruction, still tracked in typegraph#310.

  Results are unchanged at every coordinate: physical edges stay deduplicated, and
  member visibility, the `sameIdAcrossKinds` profile and the read instant are all
  resolved exactly where they were. The class members a current-coordinate step
  joins are reached by seeking the closure from the frontier row, so the cost of
  the widening tracks the frontier and its classes rather than the identity
  population — see the follow-up changeset, which replaced the graph-wide relation
  this change first shipped with that seek.

- [#400](https://github.com/nicia-ai/typegraph/pull/400) [`05af68d`](https://github.com/nicia-ai/typegraph/commit/05af68d122371ddeab03269536f2c7484ccf1a74) Thanks [@pdlug](https://github.com/pdlug)! - graph-merge: record each provenance contribution once, so the persisted count is
  the rows actually written

  Several planning phases legitimately observe the same
  `(role, canonical, branch, source)` contribution. An inherited edge is credited
  once when its modification survives delete/modify and again when the repoint
  fold reads it as a source, and a fold set's `mergedIds` carries one entry per
  staged copy — so a row staged by several branches re-offered each of its
  branches once per copy. The tuple is exactly the sidecar row's identity, so
  those re-observations were never new information: they inflated
  `provenancePersisted.count`, and because a single `bulkUpsertById` batch cannot
  create the same id twice, the over-count was the milder half: with
  `persistProvenance: true`, a merge in which a single branch modified one
  inherited edge failed the whole best-effort persist, so `provenancePersisted`
  came back absent, a `provenance persistence failed …` warning was reported, and
  NO provenance rows were written at all.

  Contributions are now collapsed at the single recording funnel, so the record
  list, the in-memory `provenance.byBranch` index and the reported count all
  speak about distinct contributions. `persistProvenanceRecords` additionally
  collapses records that hash to one id before the batch, which makes its
  documented "row count written" true for any caller's record list. Every
  genuinely distinct contributing branch is still credited.

- [#384](https://github.com/nicia-ai/typegraph/pull/384) [`cc7af7b`](https://github.com/nicia-ai/typegraph/commit/cc7af7b1ef53458296f27b73484cd799667df13c) Thanks [@pdlug](https://github.com/pdlug)! - Report the real active schema version in `StaleVersionError.details.actual` when
  a PostgreSQL schema-managed write loses to a concurrent schema commit.

  The write fence takes a `FOR SHARE` lock on the active schema row. At `read
committed`, a locking read that blocks behind an in-flight schema commit
  rechecks only the row versions its own statement snapshot saw — so once the
  winner marked the old row inactive, the fence saw no active row at all and
  reported `actual: 0`, misrepresenting the database as having no active schema.
  The fence now settles an empty locked read with a non-locking read, which
  observes the committed winner, and reports `0` only when a graph genuinely has
  no active version. The write itself was always correctly rejected; only the
  error metadata was wrong.

- [#427](https://github.com/nicia-ai/typegraph/pull/427) [`facef56`](https://github.com/nicia-ai/typegraph/commit/facef560d14c38607d6414818c65e43dc65a88d2) Thanks [@pdlug](https://github.com/pdlug)! - Bound current-coordinate identity expansion by the frontier instead of the
  identity population

  An identity-expanded traversal at the current coordinate built its class relation
  by self-joining the whole identity closure into a materialized CTE, before any
  frontier predicate applied. The relation's size is the sum of the squares of
  every class in the graph, so a hop from a single start row paid for identity
  classes it never touched: nine unrelated classes of 501 members materialize
  2,259,009 seed/member pairs, and the hop measured 564 ms on SQLite and 568 ms on
  PostgreSQL where the equivalent traversal without expansion costs microseconds.
  Doubling an unrelated class quadrupled the cost.

  Each step now seeks the closure from its own frontier rows — the frontier row's
  class through the closure primary key, that class's members through the class
  index, each member's node for its visibility — so the peer relation is never
  built for classes the query does not touch. The same hop measures 0.5 ms on
  SQLite and 2.4 ms on PostgreSQL, and PostgreSQL's `EXPLAIN (ANALYZE)` reports 18
  rows visited against 4,522,557. A single-start-row hop over 50,000 folded triples
  drops from 387 ms to 1 ms on SQLite. Wide-frontier hops are unchanged: 500 source
  rows over 100,000 matching edges measures 325 ms against 331 ms, because that
  shape was already paying for a population it used.

  The **historical** coordinate keeps its hoisted, materialized relation. Its rows
  come from a recursive fixed point over the assertion ledger that no frontier row
  narrows, so evaluating it once per statement is still the win, and the two
  coordinates are now deliberately different strategies behind one interface rather
  than one relation with two sources. Both remain a single compilation path across
  dialects.

  Results are unchanged at both coordinates: physical edges stay deduplicated,
  member visibility is still resolved against the read instant, and a frontier row
  in no class still expands to itself.

- [#391](https://github.com/nicia-ai/typegraph/pull/391) [`8eafebd`](https://github.com/nicia-ai/typegraph/commit/8eafebdae8d28fc48343fcd5d498f47b1684311f) Thanks [@pdlug](https://github.com/pdlug)! - Evaluate the historical identity-class reconstruction once per query instead of
  once per candidate edge

  An identity-expanded traversal hop under a historical coordinate (`asOf`,
  `asOfRecorded`, or a non-current `view()`) has no materialized closure to read,
  so it rebuilds classes from the assertion ledger. That rebuild used to sit inside
  the correlated edge predicate, where SQLite re-materialized it for every
  candidate _(source row, edge)_ pair, and under `sameIdAcrossKinds: "fold"` each
  rebuild also scanned the structural same-id relation across the graph — a
  quadratic term that quadrupled per doubling of graph size.

  The reconstruction is now a single materialized query-level relation of
  `(seed_kind, seed_id, kind, id)` rows, seeded by the nodes that have identity
  peers rather than by the frontier, so it depends on nothing a traversal step
  carries and is built once for the whole statement. Each step widens its frontier
  onto that relation with an outer join, which turns the candidate-edge lookup into
  the same ordinary indexed equality a traversal without identity expansion uses.
  On the narrow-edge fixture (SQLite, all _n_ nodes acting as source rows) the hop
  drops from 122/486/1984/8261 ms at _n_ = 250/500/1000/2000 to 7/7/14/28 ms, and
  grows linearly rather than quadratically.

  Results are unchanged at every coordinate. Current-coordinate traversal still
  reads the materialized closure through its existing correlated predicate.

- [#425](https://github.com/nicia-ai/typegraph/pull/425) [`92354bf`](https://github.com/nicia-ai/typegraph/commit/92354bfb559c255a03b4b5e91741b87b98de5777) Thanks [@pdlug](https://github.com/pdlug)! - Ask props bags whether they carry a key with `Object.hasOwn` rather than `in`.

  A props bag is data: its keys come from a JSON column, so a schema may declare a
  field named after an `Object.prototype` member — `toString`, `constructor`,
  `valueOf` — and such a field is ordinary data that survives Zod validation and
  the JSON round-trip untouched. `in` cannot answer "does this row carry this
  property" for such a bag, because `"toString" in {}` is `true`: a row that does
  not carry the key reads as though it does, and the read that follows yields the
  inherited prototype member instead of stored data.

  This is a lost-write fix, not only hardening. In a graph merge, a fork's bag is
  its full intended state, so a base property absent from it was deleted by that
  fork. Under `in` that deletion was never detected for a prototype-named field:
  no deletion tombstone was written and the base value survived the merge, silently
  discarding the fork's write. The same misclassification credited a branch that
  does not carry such a property with the inherited prototype member as if it were
  a stored value, letting an invented claim compete in conflict resolution and be
  reported to the caller as that branch's value. A schema diff also reported a
  removed prototype-named property as an incompatible schema change rather than a
  removal, because the absent field resolved to a function that was then compared
  as though it were the field's new schema.

  The edge fold and the node cluster union were affected in the same way, and their
  worst outcome was a committed function. For a property the SURVIVING row does not
  carry, both ask that row's bag for the value to keep, so under `in` they took the
  inherited `Object.prototype` member and wrote that function into the merged row
  instead of the value a member actually carried. The cluster union additionally
  routed such a property through the separate base-property-conflict policy on the
  strength of a base member that does not carry it, so the wrong policy decided the
  committed value. The edge fold's claim filter separately counted a member that says
  NOTHING about such a field as having AUTHORED it; the shared value collector
  discarded that phantom claim, so the two agreed only by one absorbing the other's
  mistake.

  Two guards were quietly weakened rather than corrupted. Graph-extension validation
  accepted a unique constraint on an undeclared field named after a prototype
  member — it answered "declared" against the prototype — and went on to index a
  field that does not exist. The evolve guard that refuses re-adding a kind whose
  data cleanup is still pending never counted such a kind as added, so it skipped
  the refusal.

  The convention now has one owner, `hasOwnKey`, applied across graph-merge node and
  edge property resolution, schema-diff property classification, schema-removal
  reconciliation, interchange unknown-property stripping, graph-extension document
  validation, query and index schema-field validation, the evolve pending-removal
  guard, edge `matchOn` composite-key and match-comparison reads, and
  embedding/fulltext field extraction. `in` remains correct, and still in use,
  when both the key and membership question are internal: a discriminated union's
  tag, a capability probe, a brand check, and the deliberate `Object.prototype`
  lookup in selective projection. A user-supplied field name is always checked as
  an own key, even when the schema shape itself is statically known, so names such
  as `__proto__` and `constructor` cannot masquerade as declared fields through
  `Object.prototype`.

  A plain `bag[field]` walks the prototype chain exactly as `field in bag` does, so
  the same misreading reached two more read paths that never used `in` at all. An
  edge's `matchOn` composite key and its per-field match comparison
  (`getOrCreateByEndpoints`, edge upsert dedup) read a caller's stored and input
  props by a schema-declared field name; a field named after a prototype member
  that neither bag carries as an own key now reads as `undefined` on both sides
  instead of the same inherited function, so a match or non-match decision is never
  made on a phantom shared value. `syncEmbeddings` and `computeFulltextContent`
  read a declared embedding or searchable field the same way, so an undeclared
  row no longer surfaces a prototype function as if it were the field's stored
  value there either.

  `then` and `toJSON` complete the same class from the other end. They are the two
  names JavaScript itself probes — the thenable check and the `JSON.stringify` hook
  — so every proxy standing in for a row resolved them to `undefined` up front to
  stay safe to await and to serialize. They are also legal schema field names, and
  answering them by NAME before consulting the data made the read side lie: a
  declared field called `toJSON` came back `undefined` through smart selection while
  the full mapper returned the stored string, so the same query answered differently
  depending on whether the optimizer engaged — exactly the equivalence selective
  projection exists to preserve. The predicate builders (query, traversal,
  collection, and index WHERE) made such a field unaddressable outright, and field
  tracking dropped a declared `then`, so the projection could not have carried it.

  **A declared `then` or `toJSON` field is now tracked, projected, readable through
  smart selection, and usable in a predicate.** The rule is the one the surrounding
  fixes already follow: ask the data question first — `hasOwnKey` for a
  materialized row, `hasDeclaredField` for a proxy whose key set is the schema —
  and fall back to the probe exemption only once the answer is "not data", which is
  what keeps `await` and `JSON.stringify` working on a partially projected row.
  Returning an own `then` is safe as well as correct: props decode from a JSON
  column, so the value can never be callable, and the thenable check ignores a
  non-callable `then` exactly as it does on the plain objects the full path returns.
  `isInteropProbeKey` owns which names those are, and an ESLint rule bans the bare
  name comparison that used to stand in for the decision.

  `__proto__`, the case originally reported, is the NARROW variant. Every VALIDATED
  write path blocks it: Zod drops an own `__proto__` key, and `bag["__proto__"] = value`
  assigns a prototype rather than creating a key, so an assignment-built bag cannot
  carry one either. It is still reachable through `trustedImportGraph`, which by
  contract does not validate properties and writes a caller's bag verbatim — the
  stored JSON parses back with `__proto__` as an own key on both dialects. Recorded
  here so the two are not confused: a prototype-named field needs nothing unusual at
  all, while `__proto__` needs the trusted path.

- [#381](https://github.com/nicia-ai/typegraph/pull/381) [`e6fb356`](https://github.com/nicia-ai/typegraph/commit/e6fb35669ed0bfeab1cfce64aafc72afaf5698a2) Thanks [@pdlug](https://github.com/pdlug)! - identity: answer current different-ness with one probe on the separation relation

  `identity.areDifferent()` and the `assertSame` contradiction precheck resolved
  both identity classes and then loaded every current `different` assertion
  touching one of them, scanning in JS for one that spanned the pair. That scan
  grew with class size and, past the backend's bind budget, took more than one
  statement. Both now probe the derived separation relation on its primary key
  `(graph_id, class_key_low, class_key_high)` instead: `areDifferent` reads the
  assertion ledger not at all, and the precheck reads it only to name the
  conflicting assertion in the typed error it is already about to throw.

  Results and typed errors are unchanged. Reads at a valid-time `asOf` or a
  recorded coordinate still reconstruct from the ledger, since the separation
  relation projects current assertions onto current classes. A probe never
  answers "not separated" when it could not read: a missing relation refuses with
  `IDENTITY_STORAGE_MISSING`, and any other driver failure propagates unchanged so
  transient conflicts stay classifiable.

- [#404](https://github.com/nicia-ai/typegraph/pull/404) [`479ca78`](https://github.com/nicia-ai/typegraph/commit/479ca783781d9449a7b20422446c68fd702f516b) Thanks [@pdlug](https://github.com/pdlug)! - Fix `bulkUpsertById` throwing on a repeated id whose row does not exist yet.

  `bulkUpsertById` applies items in order, so a repeated id in one batch is
  last-write-wins — but that only held for an id that already existed. The create
  branch queued its create without registering the id in the batch-local pending
  map, so a second copy of a **new** id queued a second create and the batch failed
  with `Node already exists` / `Edge already exists` (a unique-constraint violation
  on some paths). Callers feeding a batch straight from a stream or a changeset,
  where a key can legitimately appear twice, hit this on first delivery of a key.

  A queued create is now registered like a queued update: a later copy of the id
  takes the update path over the queued create, which runs after the batch's
  creates, so the final row is exactly what the equivalent sequence of `upsertById`
  calls produces — the later copy's props merged over the created row, one version
  bump per real write, and the created row's validity lower bound. With
  `coalesceUnchangedUpserts` enabled, a value-identical second copy of a new id now
  coalesces against the queued create instead of writing a second time. Nodes and
  edges are both fixed; for edges, as for an id that already existed, a later
  copy's `from` / `to` are ignored because an update never repoints an edge.

  Two smaller consequences of routing every queued write through the same state: a
  repeated id whose dirty check rejected an earlier item's props no longer reports
  the wrong error, and no later copy can coalesce against a stale prefetched row
  after an earlier item queued a write.

- [#362](https://github.com/nicia-ai/typegraph/pull/362) [`9982960`](https://github.com/nicia-ai/typegraph/commit/9982960e66343c6980b8d6e87e0cb159a981e72a) Thanks [@pdlug](https://github.com/pdlug)! - Translate PostgreSQL read-only and missing-`TEMP` failures during graph
  analytics into `UnsupportedBackendCapabilityError`, preserving the driver error
  as the cause. Both refusal points are covered: a standby that rejects the
  read-write working-table transaction, and a role that cannot create the
  temporary table inside it.

- [#420](https://github.com/nicia-ai/typegraph/pull/420) [`d82fdaf`](https://github.com/nicia-ai/typegraph/commit/d82fdaf369109fe791be00ffe330351fb8aa4d00) Thanks [@pdlug](https://github.com/pdlug)! - Harden two failures at the operations/backend boundary: a create the engine
  refuses now reports the condition it actually hit, and the last UPDATE path that
  could store an inverted valid-time window no longer can.

  **A create refused by the engine reports "already exists", not a raw driver
  error.** A create learns an id is taken either from its own existence probe or
  from the engine refusing the INSERT, and the second used to escape as a
  `DrizzleQueryError` whose `.message` is the raw INSERT text. One condition
  therefore surfaced as a typed user error down one path and an opaque system error
  down the other, and callers could not branch on it at all. The engine's report is
  now classified structurally and both routes raise the same `ValidationError`, on
  the single and batch create paths for nodes and edges alike.

  Two things reach the engine's path. A NODE create probes first, but the probe and
  the INSERT are two statements and PostgreSQL's default READ COMMITTED does not
  serialize the two write transactions, so a concurrent create of the same new id
  can commit in between — the issue's reproduction. An EDGE create has no existence
  probe at all, so the engine's refusal is its only report of a taken id, on every
  backend and with no race involved.

  Classification is structural, never message text: SQLSTATE 23505 plus the
  PostgreSQL protocol's own constraint and relation fields, and SQLite's extended
  result code, which distinguishes a primary-key duplicate (1555) from any other
  unique-index duplicate (2067) in the code itself.

  Every such refusal, from either route, now carries the new exported issue code
  `ENTITY_ALREADY_EXISTS`, so a caller can recognize it without matching on the
  message. `details.entityType` and `details.kind` say what was refused;
  `details.id` names the taken id, and is absent only when the refused statement
  inserted more than one row, because the engine reports that the statement
  collided without saying which row did. No race is needed to reach that: a bulk
  create of edges, whose ids the caller supplied and which nothing probes, is
  refused this way on every backend.

  The classification is scoped to the primary key on purpose. A `unique: true`
  index declaration materializes a UNIQUE INDEX on the same relation, and violating
  that is a declared-uniqueness failure about the row's VALUES rather than a
  duplicate identity — PostgreSQL reports it under the index's own name and SQLite
  under a different extended code, so it never matches and is unaffected. Neither is
  a declared `unique` constraint conflict, which still raises `UniquenessError`.

  SQLite never reached the node race: `BEGIN IMMEDIATE` gives the writer slot to
  one transaction at a time, so a second create cannot sit between its probe and its
  INSERT while the first commits. Its probe is authoritative there, and the refusal
  was already the typed error — it now carries the code too. A duplicate EDGE id on
  SQLite did surface as a raw `SqliteError`, and now raises the same error as it
  does on PostgreSQL.

  **A node resurrection stores the bound its window guard measured against.** A
  resurrection rewrites `valid_from` rather than retaining it, so the guard that
  refuses inverted windows has no stored bound to check and used the write instant
  instead — sampled in the operations layer, while the backend went on to stamp its
  own, strictly later, sample. A `validTo` at the guard's instant passed as
  zero-width and committed as NEGATIVE width a millisecond later, the exact shape
  the previous release exists to refuse. The operations layer now passes the
  instant it validated against explicitly, so the bound that is checked is the
  bound that is stored. Stating both endpoints is unaffected; the only change to a
  successful write is that a resurrection's `valid_from` is the operations layer's
  instant rather than the backend's — sampled a moment earlier inside the same
  locked write, before the uniqueness entries it re-checks and re-inserts.

  Edge resurrection was never exposed: an edge RETAINS its stored `valid_from`
  unless the write names a new one, so its guard measures against a value already
  on disk and predicts nothing.

- [#403](https://github.com/nicia-ai/typegraph/pull/403) [`c0279fc`](https://github.com/nicia-ai/typegraph/commit/c0279fc9cafac91b7a6ec31c343bd8fbdd12d743) Thanks [@pdlug](https://github.com/pdlug)! - graph-merge: credit the branch that authored a merged row's end-of-validity

  Ending a row's validity is authored state, but a branch whose only change to a
  row was its window could contribute the instant the merge committed and still be
  absent from the merge's provenance. An identity is staged once, so a branch that
  merely moved an inherited edge's window had its staged copy skipped whenever
  another branch's property edit already staged that edge — and the provenance for
  edges is derived from the staged copies. Nodes were worse: a window change had no
  provenance path at all, so a window-only node ending was credited to nobody even
  when no other branch touched the row.

  The credit now comes from the window resolution itself, which is the only phase
  that knows whose claim was committed. It credits exactly the branches whose claim
  IS the resolved end — a claim that lost the least-claim rule contributed nothing
  to the committed row, and remains visible in `MergeReport.validityEnds` under
  `claimedBy`. A branch that both edited a row's properties and moved its window
  stays one contribution.

  The staged copy that carries a window-only ending is no longer credited for
  carrying it: that copy exists only to give the ending a row to write, its
  properties are the base's, and the branch holding it is whichever sorted first —
  possibly one whose claim the merge discarded. Which branch carries the row is
  left exactly as it was, because that branch also labels the base's properties in
  the repoint fold's property union, where a relabelled contribution can change
  which value a fold commits. Merge outcomes are unchanged; only the provenance is.

## 0.45.0

### Minor Changes

- [#355](https://github.com/nicia-ai/typegraph/pull/355) [`2882b23`](https://github.com/nicia-ai/typegraph/commit/2882b23ef6daed20041ccea56e3cfa76a8435c7a) Thanks [@pdlug](https://github.com/pdlug)! - Add `store.nodes.<Kind>.updateWhere()` for typed, transactional set-based node
  updates selected by property and independent relationship predicates. The
  operation validates complete after-images and atomically maintains uniqueness,
  fulltext, vector, history, and revision state on SQLite and PostgreSQL. Its
  cross-backend storage primitive returns every updated after-image and provides
  bind-budgeted, graph- and concrete-kind-scoped uniqueness cleanup so rebuilding
  reservations cannot clear same-id nodes of another kind.

- [#352](https://github.com/nicia-ai/typegraph/pull/352) [`872d196`](https://github.com/nicia-ai/typegraph/commit/872d1960b470352cdcf5412a1303e59b776ce1ed) Thanks [@pdlug](https://github.com/pdlug)! - Add `store.repairContributions()`, a privileged, idempotent repair pass for
  strategy-owned contribution storage. It re-audits declarations from the active
  persisted graph, non-destructively retries `missing-marker` and
  `failed-materialization` findings, reports `stale` and `orphaned-marker` as
  `requires-rebuild`, and returns a fresh post-repair diagnostic result. Repair
  targets remain backend-owned so callers do not need access to TypeGraph-managed
  tables, physical names, or DDL.

- [#353](https://github.com/nicia-ai/typegraph/pull/353) [`c225605`](https://github.com/nicia-ai/typegraph/commit/c22560576e2e22f5808ead72e552ead4b7f8743c) Thanks [@pdlug](https://github.com/pdlug)! - Add Store-level heterogeneous bulk edge reads that keep database round trips independent of schema breadth.

### Patch Changes

- [#351](https://github.com/nicia-ai/typegraph/pull/351) [`ff8e428`](https://github.com/nicia-ai/typegraph/commit/ff8e4280456b21985033977ec9be553bad06d63c) Thanks [@pdlug](https://github.com/pdlug)! - Ensure the kind-removal status table before `evolve()` checks it, so databases
  created before TypeGraph 0.44 can evolve without manual backend initialization.
  Concurrent PostgreSQL focused-table ensures also retry the catalog uniqueness
  race that `CREATE TABLE IF NOT EXISTS` can surface during replica startup.

- [#350](https://github.com/nicia-ai/typegraph/pull/350) [`f752543`](https://github.com/nicia-ai/typegraph/commit/f752543749ac6914592e5f765f6e153b69e72518) Thanks [@pdlug](https://github.com/pdlug)! - Clarify that schema-managed Stores are immutable schema snapshots. After
  `evolve()` changes the schema, callers must use the returned Store or the
  updated `StoreRef.current` for subsequent work; a previously captured Store is
  not mutated and its managed writes are rejected by the schema-version fence.
  Document how long-lived caches detect schema commits from other processes with
  `getCommittedSchemaVersion()` and refresh through a verified Store open.

  Correct the `StoreRef` contract to say that the replacement is installed before
  a successful schema-changing call resolves, rather than claiming that the
  in-memory ref update is atomic with the persisted schema commit.

## 0.44.0

### Minor Changes

- [#331](https://github.com/nicia-ai/typegraph/pull/331) [`a1f1fde`](https://github.com/nicia-ai/typegraph/commit/a1f1fdec1be98dcbf243db738fb43cf634cae278) Thanks [@pdlug](https://github.com/pdlug)! - Add batched multi-source edge reads: `bulkFindFrom` / `bulkFindTo`

  `EdgeCollection` could only read the edges of ONE endpoint at a time, so
  rendering a page of N nodes with their relationships cost N statements. The new
  `store.edges.<kind>.bulkFindFrom(froms, options?)` and `bulkFindTo(tos,
options?)` read a whole SET of endpoints in set-oriented statements per
  endpoint kind and bind-budget chunk,
  returning the edges grouped per input (index `i` holds the edges of input `i`,
  empty array when an endpoint has none).

  This widens the predicate rather than batching the calls: `from_id = ?` becomes
  `from_id IN (...)`, the same prefix seek on the edge relation's system index.
  Temporal semantics are identical to `findFrom` / `findTo` — same default mode,
  same `temporalMode` / `asOf` options, same soft-delete filtering, same
  per-endpoint ordering — and a `StoreView` exposes both methods pinned to its
  coordinate. Pass `limitPerInput` to bound each endpoint's fan-out (applied in
  SQL via `ROW_NUMBER()` where the backend supports window functions). Inputs
  larger than the backend's bound-parameter budget are split across statements
  transparently.

  Backend authors: this adds a new **optional** `GraphBackend` operation,
  `findEdgesByEndpointSet(params)`, with its own `FindEdgesByEndpointSetParams`.
  `FindEdgesByKindParams` is unchanged.

  It is a separate operation rather than optional fields on `findEdgesByKind` so
  that a backend which does not implement it cannot degrade silently. Optional
  params would have left an existing backend type-correct while it ignored the id
  list and returned every edge of the kind — which the collection would rebucket
  into a correct-looking answer at unbounded cost. Support is now detected by the
  method's presence, before any read is issued, and `bulkFindFrom` / `bulkFindTo`
  refuse with a typed `ConfigurationError` on a backend without it rather than
  looping `findFrom` per input.

  The parameter shape also makes the previously-validated illegal states
  unrepresentable: one `side` instead of two id lists, no scalar `fromId` /
  `toId` to disagree with a set, and no `limit` / `offset` / `after` to slice a
  read the backend splits into bind-budget chunks.

- [#334](https://github.com/nicia-ai/typegraph/pull/334) [`7a2e16b`](https://github.com/nicia-ai/typegraph/commit/7a2e16b70685609b19cda6683dc1d545d5aa5f9a) Thanks [@pdlug](https://github.com/pdlug)! - Add `store.verifyContributions()`, an owner-agnostic diagnostic that crosses
  each contribution currently expected by the active graph and backend strategies
  against its durable marker and the physical catalog. Nothing on the open path
  probes the catalog — boot and the runtime asserts short-circuit on a per-instance
  signature cache and then on the marker row alone — so a database whose
  strategy-owned tables were dropped out of band opened completely clean and
  failed at the first fulltext or vector read. The diagnostic reports detected
  problems as `orphaned-marker` (marker records a success, table absent),
  `missing-marker` (table present, nothing attests it), `failed-materialization`
  (the marker records a failed attempt and no table was produced — marker and
  catalog agree, and it is broken anyway), or `stale` (marker recorded at a
  different shape), with the `owner` / `logicalName` /
  `physicalName` and, for vector slots, the `kind` and `fieldPath` needed to route
  to the state-specific repair without reconstructing internal marker strings.
  For vector slots, `missing-marker` and `failed-materialization` use the
  non-destructive forced ensure; only `orphaned-marker` and `stale` rebuild vector
  storage with `store.reembedVectorField`. `lastError` carries the reason the
  marker recorded, when it recorded one: `state` says which repair to run,
  `lastError` says why it broke. A contribution with neither a marker nor a table
  was never attempted and is omitted, as are retired markers and unsupported
  vector slots, so an empty result is not proof of initialization. It is read-only
  (one existence query per contribution table, no DDL, no writes) and deliberately
  not a boot step; the fast-path caching stays the default. Backends that cannot
  probe their own catalog throw `ConfigurationError` rather than reporting a clean
  bill of health.

- [#335](https://github.com/nicia-ai/typegraph/pull/335) [`7950bb0`](https://github.com/nicia-ai/typegraph/commit/7950bb0de0b2cb93fd71c4cf6644df0b65126b6b) Thanks [@pdlug](https://github.com/pdlug)! - Support list-valued parameters in `in()` / `notIn()`

  `field.in(param("ids"))` now binds the whole list at
  `.prepare().execute({ ids: [...] })`, so the canonical "fetch these ids"
  query can finally be prepared. The list rides on a single bound parameter
  that the dialect unpacks (`json_each` on SQLite, `jsonb_array_elements_text`
  on PostgreSQL), which keeps arity out of the SQL text: one compiled statement
  serves every list length, and a list of any size costs one bound parameter
  instead of one per element. An empty list is valid — `in([])` matches nothing,
  `notIn([])` matches everything.

  A `ParameterRef` passed among the _elements_ of a literal list
  (`in(["a", param("b")])`) was previously coerced to a literal and silently
  produced wrong results. It now throws `UnsupportedPredicateError` naming the
  supported form. A name used both as a list and as a scalar in one query is
  rejected at `prepare()`.

  List elements are validated against the field's type before binding, so
  `[1, "a"]` against a number field is rejected with a `ConfigurationError`
  rather than failing on PostgreSQL and silently matching nothing on SQLite.
  This matches the literal form, which already refuses a mixed list.

  Non-finite numbers (`NaN`, `±Infinity`) are now rejected in any parameter
  binding, list or scalar. `JSON.stringify` turns them into `null`, so a list
  binding became SQL NULL — `notIn(param("x"))` with `[NaN]` filtered out every
  row — and SQLite binds a scalar `NaN` as NULL, so `eq(param("x"))` with `NaN`
  quietly matched nothing. Both now throw.

  `DialectAdapter` gains two members, `inListParameter` and `packListValue`;
  custom dialect adapters must implement them.

- [#329](https://github.com/nicia-ai/typegraph/pull/329) [`03e87bd`](https://github.com/nicia-ai/typegraph/commit/03e87bd1d370408af7dcb640729e9579508db29f) Thanks [@pdlug](https://github.com/pdlug)! - Export the committed-schema reads from the package root. `getActiveSchema`,
  `isSchemaInitialized`, and the `SerializedSchema` type now sit next to
  `getCommittedSchemaVersion` in `@nicia-ai/typegraph`, so answering "what kinds
  does this database already have?" no longer requires finding the
  `@nicia-ai/typegraph/schema` subpath or querying `typegraph_schema_versions`
  by hand. `getActiveSchema` and `getCommittedSchemaVersion` now cross-reference
  each other in their docstrings.

- [#332](https://github.com/nicia-ai/typegraph/pull/332) [`2fb8925`](https://github.com/nicia-ai/typegraph/commit/2fb89258b2047fe8ae6d2ce97cb7f219200285e5) Thanks [@pdlug](https://github.com/pdlug)! - Fix `migrateSchema()` silently dropping runtime-committed kinds

  `migrateSchema(backend, graph, currentVersion)` committed `graph` verbatim. It
  did not fold the persisted graph extension, so kinds committed at runtime by
  `Store.evolve()` — which live in `schema_doc.extension`, not in the
  compile-time graph — were erased from the active schema document while their
  rows stayed in `typegraph_nodes` / `typegraph_edges`, reachable by nothing.
  The persisted `deprecatedKinds` set was erased the same way.

  This was reachable by following the library's own advice: the `MigrationError`
  raised for a breaking change told callers to "use `getSchemaChanges()` to
  review, then `migrateSchema()` to apply", and doing so with the graph they
  passed to `createStoreWithSchema` destroyed every `evolve()`-committed kind.

  Two changes:

  - **The persisted graph extension (and deprecated-kind set) is now folded in**,
    exactly as `createStoreWithSchema` and `getSchemaChanges` already did.
    `migrateSchema` was the last commit path that did not. Callers pass the graph
    they have; runtime-committed kinds survive.
  - **A commit that would drop a kind still holding rows is refused** with a
    `MigrationError` whose `details.reason` is the new `"kind-removal"`
    discriminant and whose `details.droppedKinds` names them. Pass
    `{ discardDroppedKindRows: true }` if losing those rows is the intent — the
    name says what the flag does, because the next reconcile deletes them.

  The guard fires on the actual harm — rows the next reconcile would delete —
  not on kind removal as such. Dropping an _empty_ kind is unaffected, so the documented three-deploy
  removal flow (stop writing → delete the rows → drop from `defineGraph()` and
  migrate) still works exactly as written; Deploy 2 is now what makes Deploy 3
  legal instead of being merely advisory. Live rows only, matching the
  `excludeDeleted` default of the equivalent probe in `Store.evolve()`.

  Breaking property changes — the documented reason to reach for
  `migrateSchema()` — are unaffected.

  `MaterializeRemovalsEntry` gains a `"skipped"` variant, carrying
  `reason: "kind-is-live"`. `materializeRemovals()` returns it when a queued
  removal names a kind the active schema declares again, so the decline is
  reported rather than leaving the queue at a non-zero depth with nothing
  explaining why. Consumers that switch exhaustively on `status` must handle it.
  The type is now a discriminated union, so `"failed"` carries a required
  `error` and `"skipped"` a required `reason`.

  `Store.evolve()` refuses to re-add a kind whose data cleanup is still pending,
  with a `ConfigurationError` naming the kind and pointing at
  `materializeRemovals()`. Reads filter only by `(graph_id, kind)`, so re-adding
  before cleanup made the previous incarnation's rows visible alongside the new
  ones — and the cleanup was then declined because the kind was live, so they
  were never reclaimed. The documented cycle (remove → `materializeRemovals` →
  re-add) is unaffected.

  Two further corrections found while reviewing the above:

  - **A stale store can no longer resurrect a removed kind.** The fold now
    strips the supplied graph's own extension slice before applying the
    persisted one, so the committed document is a function of the database
    alone. Previously `migrateSchema(backend, store.graph, v)` — `store.graph`
    is public and returns the merged graph — unioned a stale slice back in and
    silently undid `Store.removeKinds()`, leaving a kind the schema called live
    while its `typegraph_kind_removals` row stayed queued for a later
    hard-delete. `Store.#catchUpToStored` has stripped for this exact reason;
    the schema layer now matches it.
  - **`discardDroppedKindRows`'s documentation was wrong.** It claimed the dropped
    kind's rows stay and that `materializeRemovals` "will never clean them up".
    `materializeRemovals` re-derives removals by walking schema-version history,
    so the next reconcile hard-deletes them regardless. The flag buys a
    committed schema, not retained data; the docstring now says so and points
    callers at copying the rows out first.

### Patch Changes

- [#328](https://github.com/nicia-ai/typegraph/pull/328) [`dc2a386`](https://github.com/nicia-ai/typegraph/commit/dc2a386fa2b6275b7d0f3d6d80e2959ea094365b) Thanks [@pdlug](https://github.com/pdlug)! - State `store.batch()`'s real cost where callers see it. `batch()` runs its
  queries in sequence, keeping at most one in flight — at least one statement
  each, and two for a query whose selective-field mapping falls back after its
  statement has already executed. So it caps concurrency at best and will not fix
  an N+1. It is also not a snapshot: PostgreSQL's default read-committed isolation
  lets a later query in the batch observe a commit the earlier ones did not, and
  there is no public way to get one across fluent queries, since a transaction
  context exposes no query builder.

  The docstrings for `batch()`, `BatchableQuery`, `executeOn`, and the edge
  `batchFind*` methods now lead with that, and point at the set-oriented and
  chunked alternatives, described by what they actually do: `.traverse()` compiles
  a chain to one statement, `store.subgraph()` costs 2 statements on SQLite and 3
  on PostgreSQL, `getByIds()` issues one statement per bind-limit chunk (falling
  back to concurrent per-id lookups where the backend exposes no batch read), and
  `bulkFindByIndex()` costs a probe plus that same chunked hydration.

  The docs site is corrected to match, including claims that `batch()` "minimizes
  round-trips for reads", that `batchFind*` collapses N reads into "a single
  transactional round-trip", that `subgraph()` is a single statement, and that
  `getByIds()` is a single query. Transaction support no longer implies a
  transport shape anywhere: Durable Objects use an ambient transaction with no
  framing statements, and the non-transactional path may still reuse one client.
  The changelog entry that shipped `batch()` carries a correction note rather than
  a silent rewrite.

  Execution semantics are unchanged. One public diagnostic changes: the
  `ConfigurationError` message for a batch endpoint read on a read-only
  `StoreView` no longer calls `batch()` a "batch loader".

- [#344](https://github.com/nicia-ai/typegraph/pull/344) [`ea05d0d`](https://github.com/nicia-ai/typegraph/commit/ea05d0da9f4956062b895138be03ad3b36fa289b) Thanks [@pdlug](https://github.com/pdlug)! - Fence deferred kind cleanup against concurrent schema re-adds. Removal now
  rechecks the active schema and atomically deletes live rows, recorded-time
  intervals, vector storage, and contribution markers under the schema lock.
  Custom backends that implement the optional `schemaWriteTransaction` capability
  must expose transaction-bound statement execution, table-existence probing,
  schema DDL, and vector-contribution marker deletion on its callback target.

- [#347](https://github.com/nicia-ai/typegraph/pull/347) [`1616e93`](https://github.com/nicia-ai/typegraph/commit/1616e9380de834afa4912c91b79e45ed8edcd122) Thanks [@pdlug](https://github.com/pdlug)! - Fence schema-version commits against concurrent schema-managed Store writes.
  SQLite uses its immediate writer transaction; PostgreSQL locks the active schema
  row in shared mode for managed writes and exclusive mode for schema commits.
  Managed writes revalidate their Store schema version while holding the fence, so
  stale queued writes fail instead of landing against a schema that no longer
  accepts them. Snapshot-isolated PostgreSQL transactions may raise the database's
  native serialization failure; callers retry the whole transaction, and graph
  merge does so automatically. Schema-managed Stores on non-transactional or
  custom backends without the fence now fail closed on writes. Raw `createStore()`
  instances, direct backend writes, and Stores whose schema metadata was reset by
  `clear()` remain outside the versioned guarantee.

- [#342](https://github.com/nicia-ai/typegraph/pull/342) [`d481054`](https://github.com/nicia-ai/typegraph/commit/d481054ebbac7fd6ec06b8d0b5cfd28313efab89) Thanks [@pdlug](https://github.com/pdlug)! - Make the documented store query hooks fire for query-builder statements,
  including prepared queries, batched queries, and selective-projection retries.
  Each submitted statement now reports its SQL, parameters, row count, duration,
  and failures through the existing `StoreHooks` callbacks.

- [#343](https://github.com/nicia-ai/typegraph/pull/343) [`347d5e3`](https://github.com/nicia-ai/typegraph/commit/347d5e3ba1c634697b873044a9770436a119604b) Thanks [@pdlug](https://github.com/pdlug)! - Avoid repeated selective-projection fallback queries. Smart-select planning now
  covers common high-value threshold branches, and prepared queries remember a
  missing-field fallback so later executions fetch the full row directly.

## 0.43.0

### Minor Changes

- [#320](https://github.com/nicia-ai/typegraph/pull/320) [`010132a`](https://github.com/nicia-ai/typegraph/commit/010132a6ce2625b83f6256ef78bbc9bbd78867ee) Thanks [@pdlug](https://github.com/pdlug)! - Allow idempotent endpoint-based edge writes to set application-time validity.
  `getOrCreateByEndpoints` now accepts `validFrom` and `validTo`, while
  `bulkGetOrCreateByEndpoints` accepts them per item. Creation applies both
  fields, updates and resurrections apply `validTo`, and pure found results leave
  the existing window unchanged.

## 0.42.1

### Patch Changes

- [#317](https://github.com/nicia-ai/typegraph/pull/317) [`8024711`](https://github.com/nicia-ai/typegraph/commit/80247111bde9282dbbe1a9ef3c31ca66bd16ae39) Thanks [@pdlug](https://github.com/pdlug)! - Prevent large PGlite bulk writes from silently leaving the connection unable
  to return rows. PGlite backends now advertise their safe 32,767-parameter
  limit, PostgreSQL batch sizes follow the active backend capability, and
  over-budget statements fail before driver dispatch.

## 0.42.0

### Minor Changes

- [#313](https://github.com/nicia-ai/typegraph/pull/313) [`a797a8b`](https://github.com/nicia-ai/typegraph/commit/a797a8b1ebe077869e42a334816b172314cb0132) Thanks [@pdlug](https://github.com/pdlug)! - Expose the schema-commit surface's decisions as data instead of prose, so
  callers can pre-flight a proposal and classify a failure without matching
  message text.

  `MigrationError` now carries a stable `details.reason` discriminant —
  `"schema-behind" | "breaking-change" | "no-active-version" |
"version-not-found"` (exported as `MIGRATION_FAILURE_REASONS`) — plus the
  structured `details.diff` for the outcomes that computed one. Branch on
  `details.diff.hasBreakingChanges` to tell an additive change from an
  incompatible one, with no re-query and no substring matching. Note that
  `MigrationErrorDetails.reason` is now required rather than an optional free-text
  string.

  For pre-flight, `classifySchemaChanges(diff)` reduces a diff to
  `"identical" | "additive" | "incompatible"`, and the existing SELECT-only
  `getSchemaChanges` is now reachable from a store handle: `store.schemaChanges()`
  returns the diff and `store.requiresMigration()` answers the boolean predicate
  (also `true` when nothing has been committed yet). A least-privilege runtime can
  detect that it needs the privileged bootstrap instead of discovering the
  migration wall partway through a request.

  Documents two operational facts that were previously invisible at the call site:
  kinds are scoped to the `graph_id` (a namespace _is_ a graph id — separate
  declaration sites do not isolate kinds), and running many `graph_id`s with
  divergent schemas in one database is a supported multi-tenant pattern, including
  the one cross-graph coupling (SQL index names are database-global, so identical
  kind+index shapes share a physical index and divergent shapes fail loudly).

  Also fixes `getSchemaChanges` to fold in the persisted graph-extension before
  diffing, matching what the commit path already does. Without it a compile-time
  graph was compared against a stored schema that also contains runtime-committed
  kinds, so those kinds read as removals and an unchanged schema was reported as
  requiring a breaking migration.

### Patch Changes

- [#313](https://github.com/nicia-ai/typegraph/pull/313) [`a797a8b`](https://github.com/nicia-ai/typegraph/commit/a797a8b1ebe077869e42a334816b172314cb0132) Thanks [@pdlug](https://github.com/pdlug)! - Stop reporting a reordered declaration as a schema change. Restating a kind
  with its properties, enum members, or edge endpoints listed in a different
  order is a semantic no-op, but the diff compared those arrays positionally and
  reported the kind as `modified` — forcing callers into a privileged migration
  for a schema that had not actually changed. A reordered `enum` was even
  classified `breaking`, i.e. a pure reordering demanded a destructive-migration
  decision.

  `required`, `enum`, and edge `fromKinds` / `toKinds` are now compared as the
  sets they are, in both the modified-vs-unmodified decision and the
  breaking-change severity classification. Genuine changes — added or removed
  properties, newly required properties, changed enum members, different edge
  endpoints — are detected exactly as before.

  The normalization is deliberately scoped to diff comparison and is **not**
  applied to the canonical form behind `computeSchemaHash`, so no schema hash
  already committed to a database changes.

  The normalization walks the document as JSON Schema rather than as plain JSON,
  because a key's meaning depends on where it appears. Recursion is an
  **allowlist** of known schema-valued keywords; everything else is preserved
  verbatim:

  - Instance data (`default`, `const`, `examples`) and unknown extension keys —
    Zod's `.meta()` merges arbitrary keys straight into the generated schema — are
    compared verbatim. Recursing into them would sort a nested key merely _named_
    `required`, silently normalizing away a real change to a stored value.
  - Keys under `properties`, `patternProperties`, `dependentSchemas`, `$defs`, and
    `definitions` are user-chosen field names, not keywords, so a field _named_
    `default` still has its subschema normalized like any other.
  - `dependentRequired` maps a name to a set of names, so each set is
    order-normalized.

  The allowlist fails in the safe direction: an unrecognized schema-valued keyword
  is left unsorted, so a reordering inside it reads as a change rather than being
  hidden.

## 0.41.0

### Minor Changes

- [#311](https://github.com/nicia-ai/typegraph/pull/311) [`008fa20`](https://github.com/nicia-ai/typegraph/commit/008fa2008d199f997f45af967ba2f1a1fbad4970) Thanks [@pdlug](https://github.com/pdlug)! - Make verified adapter stores reusable across connections so serverless/edge
  deployments that open a fresh database connection per request can verify once
  per isolate instead of paying a schema-reconcile round-trip on every request.

  `AdapterStore` now exposes `reconciledSchema`, an opaque snapshot of a store's
  reconciled (compile-time + runtime-committed) graph and committed schema
  version. Pass it to a synchronous `createAdapterStore(graph, backend,
{ reconciled })` — which issues **zero** database queries and still validates
  reads and writes against runtime-committed kinds — or call
  `store.withBackend(freshBackend)` to rebind an already-verified store onto a new
  connection with no re-verify (the store's connection is captured immutably, so
  this returns a new equivalent store rather than mutating in place). The new
  `getCommittedSchemaVersion(backend, graphId)` reads the committed version with a
  single indexed SELECT, the cheap cross-isolate probe for detecting when another
  process committed a schema change and the cached snapshot must be refreshed.

## 0.40.0

### Minor Changes

- [#308](https://github.com/nicia-ai/typegraph/pull/308) [`db2dc31`](https://github.com/nicia-ai/typegraph/commit/db2dc31e2a66f3195c0d5d7e3df19864cb64672c) Thanks [@pdlug](https://github.com/pdlug)! - Replace timestamp-only `RecordedInstant` values with versioned anchors that
  encode a strict per-graph logical revision alongside a non-decreasing physical
  wall-time high-water mark. Recorded relations store numeric revisions while the
  public anchor remains one durable string. Upgrade timestamp-only preview tables
  with `migrateLegacyRecordedTime()` and remap external checkpoints with
  `migrateRecordedAnchor()`. Driver timestamps are normalized without host-local
  timezone parsing, migration integrity failures are typed, and the retained
  anchor map can be dropped automatically after its final graph is cleaned up.
  History-enabled async store factories now reject an unmigrated recorded schema
  at open, including when the legacy tables are empty.

## 0.39.0

### Minor Changes

- [#306](https://github.com/nicia-ai/typegraph/pull/306) [`cd4e0eb`](https://github.com/nicia-ai/typegraph/commit/cd4e0ebf1fa8a51e8a965e667801941a5360e097) Thanks [@pdlug](https://github.com/pdlug)! - Add bounded, deterministic `scan()` pagination to recorded-time node and edge collections so adapters can reconstruct complete historical snapshots without retaining a separate identity inventory.

- [#305](https://github.com/nicia-ai/typegraph/pull/305) [`4349766`](https://github.com/nicia-ai/typegraph/commit/4349766fc9d5db7046f05cefab6e56f4dd4d655a) Thanks [@pdlug](https://github.com/pdlug)! - Harden adapter capability surfaces and document their migrations.

  This is source-breaking for adapter code that reads `tx.sql` without first
  narrowing `tx.sqlAvailability === "available"`: non-available union arms now
  omit `sql` instead of exposing it as an optional `never`/`undefined` property.
  The runtime history and revision-tracking guards remain fail-loud for JavaScript
  and type-suppressed callers.

  Add `openProvenanceStore(targetStore)` as the preferred graph-merge provenance
  API while retaining `openProvenanceStore(backend, targetGraphId)` for standalone
  inspection tools. On Cloudflare D1 and Durable Object SQLite, ignore only a
  recognized `SQLITE_AUTH` rejection of the performance-only `analysis_limit`
  PRAGMA and continue with scoped `ANALYZE`; unexpected maintenance failures stay
  visible.

## 0.38.0

### Minor Changes

- [#297](https://github.com/nicia-ai/typegraph/pull/297) [`474afe6`](https://github.com/nicia-ai/typegraph/commit/474afe602f44ef60e313015d853c4705b30e8790) Thanks [@pdlug](https://github.com/pdlug)! - Add global and weighted multi-seed personalized PageRank with induced-subgraph,
  temporal-view, direction, convergence-tolerance, and working-memory options.

- [#303](https://github.com/nicia-ai/typegraph/pull/303) [`58855f7`](https://github.com/nicia-ai/typegraph/commit/58855f7b9e4f808805aecb4d1169fadd8e6aaab1) Thanks [@pdlug](https://github.com/pdlug)! - Move query compilation behind TypeGraph-owned backend and SQL-fragment
  abstractions so strict consumers no longer typecheck unused Drizzle dialect
  declarations. Add a Drizzle-free `core` entrypoint and managed full-Store
  entrypoints for local SQLite and PGlite, with packed TypeScript 5 and 6
  regression coverage for both databases.

  The portable `@nicia-ai/typegraph/indexes` entrypoint is also Drizzle-free.
  Direct Drizzle index-builder helpers moved to
  `@nicia-ai/typegraph/adapters/drizzle/indexes`.

  Advanced adapter APIs now use TypeGraph's `SqlFragment` instead of Drizzle
  `SQL`: this includes query `compile()` results, custom `GraphBackend`
  implementations, and custom fulltext/vector strategies. Use `toSQL()` for a
  dialect-rendered `{ sql, params }` result, or `renderSqlite()` /
  `renderPostgres()` when rendering a fragment directly.

  Custom backend and strategy authors can import the complete, Drizzle-free
  contract vocabulary from `@nicia-ai/typegraph/backend`. This entrypoint names
  every operation parameter, row, strategy payload, dialect port, SQL fragment
  chunk, and supporting schema/index type referenced by those contracts. API
  Extractor enforces zero forgotten exports for new entrypoints and fingerprints
  the complete pre-existing debt set so added or removed leaks cannot pass
  silently.

  The default `Store<G>` is now the portable TypeGraph surface. It keeps the full
  graph API and graph-owned transactions while omitting adapter-native handles and
  caller-owned transaction adoption. Drizzle integration entrypoints return
  `AdapterStore<G, TNativeTransaction>` when precisely typed `tx.sql`,
  `withTransaction`, or `withRecordedTransaction` interoperability is required.
  `createStore`, `createStoreWithSchema`, and `createVerifiedStore` now return the
  portable contract; use their `createAdapterStore`,
  `createAdapterStoreWithSchema`, and `createVerifiedAdapterStore` counterparts
  when the application deliberately needs adapter-native interoperability.

  Migration map:

  | 0.37 use                                          | 0.38 replacement                                                                                                            |
  | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
  | `createStoreWithSchema(...)` followed by `tx.sql` | `createAdapterStoreWithSchema(...)`                                                                                         |
  | `Store<G, TNativeTransaction>`                    | `AdapterStore<G, TNativeTransaction>`                                                                                       |
  | `TransactionContext<G, TNativeTransaction>`       | `AdapterTransactionContext<G, TNativeTransaction>`                                                                          |
  | `HistoryTransactionContext<G>`                    | `TransactionContext<G>` for portable history stores, or `AdapterHistoryTransactionContext<G>` for adapter history stores    |
  | `AdoptedTransaction`                              | The adapter's concrete native-handle type, such as `AnySqliteDatabase` or `AnyPgTransaction`, passed as the adapter generic |

  `HistoryTransactionContext` and `MeasurableHistoryTransactionContext` were
  removed rather than retained as aliases. Portable stores have one SQL-free
  transaction context across live and history modes. Adapter contexts expose
  `sql` only after `sqlAvailability === "available"`; the other discriminated
  union arms omit the property. Store evolution is now generic over the exact
  Store flavor, so adapter/history/recorded-read surfaces and compatible
  `StoreRef` values are preserved without downstream casts. Remove casts that
  existed only to restore the old widened evolution result.

  Requiring the `sqlAvailability` check is source-breaking for adapter code that
  previously read `tx.sql` from the unnarrowed union. Narrow on the discriminant
  before passing the handle to even an `unknown`-typed sink.

  `GraphBackend` is now the portable TypeGraph backend port. Native transaction
  adoption lives on `AdapterBackend<TNativeTransaction>`, so a capability-less
  backend cannot be passed to an adapter-store factory. Portable transaction
  contexts and adapter transaction contexts both expose the same runtime-enforced
  read-only `TransactionReadBackend`. Adapter contexts add only the precisely
  typed native `sql` handle; TypeGraph internals reach the full transaction
  backend through a non-public, non-enumerable runtime port. Backend functions
  are now receiver-free (`this: void`); custom backends must close over their
  state instead of depending on method receivers.

  PostgreSQL adapter stores now expose and accept `AnyPgTransaction` for native
  transaction interoperability. A root Drizzle PostgreSQL database is rejected
  at compile time and runtime; pass only the transaction handle received by a
  caller-owned `db.transaction(...)`. SQLite adoption remains database-handle
  based so its documented manual-`BEGIN` integration continues to work.

  Public `TransactionOptions` now contains only caller-selectable isolation and
  access modes. TypeGraph's temporary-write authorization is an internal,
  globally branded capability and is no longer expressible through the public
  transaction contract. Fulltext and vector strategy members are readonly
  function properties, closing TypeScript's method-bivariance loophole for
  third-party implementations. Dialect adapter members use the same receiver-free
  function-property contract, and `TransactionOptions` is exported from the root
  entrypoint for portable transaction consumers.

  Managed SQLite and PGlite factories preserve the precise live, history, or
  recorded-read Store flavor selected by their options, including when options
  are widened before the call. This keeps unavailable write and native-adapter
  capabilities unrepresentable instead of relying on runtime failures.

  Every Store flavor exposes the safe, Drizzle-free `store.capabilities`
  descriptor for runtime feature checks without exposing backend operations.
  `AdapterHistoryStore.backend` exposes the narrower `HistoryStoreBackend`, which
  omits raw SQL, native import, graph clearing, and nested backend transactions so
  capture-bypassing writes are absent at both type and runtime levels.

  Backend capability narrowing now uses an exhaustive runtime allowlist instead
  of default-forwarding proxy overlays. New `GraphBackend` members must be
  classified explicitly, preventing adapter capabilities from leaking through a
  history wrapper. Store evolution also preserves each refined Store flavor and
  accepts invariant `StoreRef` values for that exact replacement surface.

  Add checked-in API Extractor reports derived from every package export. CI now
  fails when the emitted public declaration surface changes without an
  intentional report update.

  Direct SQL fragment values now pass through the same dialect binding
  normalization as placeholders and compiled queries. Runtime store,
  transaction, schema, and recorded-read ports use versioned global symbols so
  mixed ESM/CJS or duplicated bundle instances interoperate safely. Dialect
  policies outside the compiler are exhaustive records or switches, so adding a
  new SQL dialect cannot silently inherit SQLite behavior.

  Remove the transitional `SQL`, `SqlRenderDialect`, and `AdoptedTransaction`
  aliases. Import `SqlFragment` and `SqlDialect` directly. The constructors that
  brand arbitrary fragments as executable SQL are now internal; public compiled
  SQL values come from TypeGraph's query compiler. Managed local stores now live
  at `/sqlite/local` and `/postgres/pglite`; bring-your-own-connection APIs live
  under `/adapters/drizzle/sqlite...` and `/adapters/drizzle/postgres...`.

  The old `@nicia-ai/typegraph/sqlite` and
  `@nicia-ai/typegraph/postgres` entrypoints were removed. They are not
  compatibility aliases because those names now distinguish the managed Store
  API from bring-your-own-connection adapters. Move imports as follows:

  | 0.37 entrypoint                                   | 0.38 entrypoint                     |
  | ------------------------------------------------- | ----------------------------------- |
  | `/sqlite`                                         | `/adapters/drizzle/sqlite`          |
  | `/sqlite/local` for `createLocalSqliteBackend`    | `/adapters/drizzle/sqlite/local`    |
  | `/sqlite/libsql`                                  | `/adapters/drizzle/sqlite/libsql`   |
  | `/postgres`                                       | `/adapters/drizzle/postgres`        |
  | `/postgres/pglite` for `createLocalPgliteBackend` | `/adapters/drizzle/postgres/pglite` |

  The managed `/sqlite/local` and `/postgres/pglite` entrypoints keep Drizzle
  out of their public declarations, but their built-in database implementation
  still uses Drizzle internally. `drizzle-orm` therefore remains a required peer
  of the 0.38 package; declaration isolation does not imply installation
  isolation.

- [#298](https://github.com/nicia-ai/typegraph/pull/298) [`f178663`](https://github.com/nicia-ai/typegraph/commit/f1786634e7867b892805349dc922269e155d1d65) Thanks [@pdlug](https://github.com/pdlug)! - Add deterministic synchronous label propagation with exact binary tie-breaking,
  induced node-kind scope, temporal and recorded-time views, bind-independent
  neighbor voting, early period-two oscillation detection, and an
  `onMaxIterations` completion contract: `"throw"` (default) returns only a
  converged labeling, while `"return"` yields the exact fixed-round Graphalytics
  CDLP labeling.

## 0.37.1

### Patch Changes

- [#292](https://github.com/nicia-ai/typegraph/pull/292) [`0152c3b`](https://github.com/nicia-ai/typegraph/commit/0152c3bf4a0bd3c047931041d1505b69a25fa05a) Thanks [@pdlug](https://github.com/pdlug)! - Restore graph algorithms on Cloudflare Durable Objects SQLite. The
  auto-detected `do-sqlite` profile now marks temporary-table graph analytics as
  unsupported, routes shortest-path and reachability algorithms through their
  inline fallback, and rejects temporary-table-only algorithms with the existing
  typed capability error instead of leaking workerd's `SQLITE_AUTH` failure.

- [#293](https://github.com/nicia-ai/typegraph/pull/293) [`9309ec3`](https://github.com/nicia-ai/typegraph/commit/9309ec3f839b53474d389b9376f7851c87753e28) Thanks [@pdlug](https://github.com/pdlug)! - Speed up exact weakly connected components with indexed changed-label
  frontiers, changed-row-only writes, and one fewer working-table join. Preserve
  synchronous convergence across bind-limited edge-kind chunks, and align
  shortest-path identity tie-breaks with portable binary ordering.

## 0.37.0

### Minor Changes

- [#269](https://github.com/nicia-ai/typegraph/pull/269) [`92479d4`](https://github.com/nicia-ai/typegraph/commit/92479d44ba7f0fc76985d51174cb9801c055fd4d) Thanks [@pdlug](https://github.com/pdlug)! - Vector storage now rides the [#135](https://github.com/nicia-ai/typegraph/issues/135) durable-contribution machinery, so the
  runtime never issues DDL on the embedding hot path.

  Previously every vector op (`upsertEmbedding` / `deleteEmbedding` /
  `vectorSearch` / `createVectorIndex`) lazily ran `CREATE TABLE IF NOT EXISTS`
  for its per-`(kind, field)` table on whatever connection it executed on. On a
  least-privilege Postgres role (USAGE on `public`, full DML, but no `CREATE`)
  this failed with `permission denied for schema public` (SQLSTATE 42501) — even
  when the table already existed, because Postgres runs the schema aclcheck before
  the `IF NOT EXISTS` short-circuit. The fulltext path already avoided this via
  durable markers; vectors now do too.

  What changed:

  - **Boot (privileged):** `createStoreWithSchema` provisions every embedding
    `(kind, field)` table + a durable contribution marker, enumerated from the
    graph. `evolve()` provisions any embedding fields it introduces. A slot
    already provisioned at a _different_ shape (the declared dimension changed)
    is warned about and left untouched — boot stays reachable so
    `store.reembedVectorField()` can recreate it; until then, writes to that
    field fail with a `stale` `StoreNotInitializedError` that points at
    `reembedVectorField`.
  - **Runtime writes (DML-only):** `upsertEmbedding` (single and batch) and
    `deleteEmbedding` assert the durable marker with a cached, signature-checked
    SELECT and run DML — never DDL. `createVerifiedStore` verifies vector markers
    at attach, alongside fulltext.
  - **Vector reads are not marker-gated:** `store.search.vector`,
    `store.search.hybrid`, and query-builder `.similarTo()` predicates compile to
    SQL against the per-field table directly (searches may override the metric at
    query time, so their slot legitimately differs from the provisioned shape);
    against an un-provisioned database they surface the engine's missing-relation
    error, which `createVerifiedStore` catches at attach.
  - `reembedVectorField` re-stamps the marker after recreating storage at a new
    dimension; vector-field reclaim (`materializeRemovals`) clears the marker when
    it drops a table.

  **Breaking:** vector ops now require a prior privileged `createStoreWithSchema`
  (exactly as fulltext already does). A plain `createStore` + embedding write with
  no provisioning step throws `StoreNotInitializedError` instead of lazily
  creating the table.

  **Migration:** after upgrading, run `createStoreWithSchema(graph, adminBackend)`
  once under the schema-owner role. It creates the per-field vector tables +
  markers; least-privilege runtimes then assert markers (SELECT) and run vector
  DML with zero DDL — no `GRANT CREATE` required.

  Consumers that boot manually (raw DDL + the sync `createStore` attach +
  `backend.ensureRuntimeContributions`) provision vectors the same way: the new
  `resolveGraphVectorSlots(graph)` export enumerates every embedding
  `(kind, field)` slot, and `backend.ensureVectorSlotContribution(slot)`
  materializes each — the exact step `createStoreWithSchema` performs. Batch
  counterparts (`backend.ensureVectorSlotContributions(slots)` /
  `backend.assertVectorSlotsInitialized(slots)`) resolve every slot's markers
  with one graph-scoped query — what boot and verified attach use, and the
  right choice for many embedding fields over a remote connection.

- [#284](https://github.com/nicia-ai/typegraph/pull/284) [`26f5b4a`](https://github.com/nicia-ai/typegraph/commit/26f5b4a3f129353e0ec92040497ddca685563c7f) Thanks [@pdlug](https://github.com/pdlug)! - TypeGraph's base-relation indexes are now **system-index declarations** — a
  single declared list (`SYSTEM_INDEX_DECLARATIONS`) that both dialect schemas
  derive from and that materializes onto already-initialized databases.

  Previously the base indexes were hand-written twice (once per dialect schema)
  and applied only by first-boot bootstrap DDL, so an index added in a newer
  library version never reached an existing database without manual DDL (the
  gap [#282](https://github.com/nicia-ai/typegraph/issues/282) exposed). Now:

  - **Single source, parity by construction.** `createSqliteTables` /
    `createPostgresTables` build their node/edge/recorded-relation indexes from
    the same declarations, and a cross-dialect extraction test asserts the two
    generated DDL scripts' full index sets stay identical.
  - **Upgrade path.** `createStoreWithSchema` brings a database's system
    indexes up to the running library version at boot — `CREATE INDEX
CONCURRENTLY` on PostgreSQL, riding the same status table, drift
    signatures, invalid-leftover healing, and cross-caller claim protocol as
    graph-declared indexes. A database whose indexes all exist settles from
    three concurrent catalog/status reads (scoped to the session
    `search_path`, so schema-per-tenant databases never observe each other's
    indexes) with no index DDL and no status writes — the only DDL on that
    warm path is the idempotent status-table `CREATE TABLE IF NOT EXISTS`
    ensure step every materialize verb runs. A system index that is
    physically absent or invalid is rebuilt
    even when a stale success row survives (dump/restore, manual drop).
    Failures — including status-table infrastructure errors — degrade to a
    warning: indexes are a performance concern and the store still boots.
    Deployments that must not run index builds inline at boot pass
    `systemIndexes: "skip"` to `createStoreWithSchema` and materialize
    out-of-band.
  - **New API: `store.materializeSystemIndexes()`** for deployments that boot
    without `createStoreWithSchema` (zero-DDL attach) — call once under a
    DDL-capable role after upgrading. Strict where the boot path is lenient:
    throws `ConfigurationError` on backends without DDL/status primitives.
  - `IndexEntity` gains a `"system"` member; system status rows carry the
    relation key (e.g. `"recordedNodes"`) in their `kind` column.

  Generated DDL is unchanged for default and short custom table names — same
  index names, columns, and order — so existing databases and drizzle-kit
  migrations are unaffected. Names that would exceed PostgreSQL's 63-char
  identifier bound (very long custom table names) are now deterministically
  truncated + hash-suffixed instead of being silently truncated by the engine
  into collisions. System index names are reserved: a graph-declared index
  using one is rejected at table definition and by `materializeIndexes()`
  (previously its `CREATE INDEX IF NOT EXISTS` silently no-opped against the
  differently-shaped system index while recording success). Legacy databases
  that predate the recorded relations skip those indexes cleanly instead of
  attempting failing DDL at every boot.

- [#273](https://github.com/nicia-ai/typegraph/pull/273) [`42f6941`](https://github.com/nicia-ai/typegraph/commit/42f6941fdb601629c0f45ec54fa9f3e50bd028ae) Thanks [@pdlug](https://github.com/pdlug)! - Add `trustedImportGraph` and `trustedImportGraphStream` for atomic initial loads
  into a fresh, dedicated database. The distinct trusted surface bypasses schema,
  reference, cardinality, and conflict validation; uses prepared SQLite writes or
  PostgreSQL `UNNEST` ingestion; defers rebuildable secondary indexes; refreshes
  planner statistics; and rolls the complete stream back on any failure.

  The first version rejects non-empty TypeGraph data tables, recorded history,
  revision tracking, uniqueness constraints, searchable fields, vector fields,
  and backends without the required native transactional path.

- [#279](https://github.com/nicia-ai/typegraph/pull/279) [`c44eeac`](https://github.com/nicia-ai/typegraph/commit/c44eeac36805be144b25123fafb5c52ae30b73a4) Thanks [@pdlug](https://github.com/pdlug)! - Add exact `store.algorithms.weaklyConnectedComponents()` for transactional
  SQLite and PostgreSQL backends. Results include deterministic component
  representatives and sizes, honor valid/recorded temporal views, and fail with a
  typed convergence error instead of returning partial labels when the configured
  iteration budget is exhausted. Callers can restrict WCC to a `nodeKinds`
  induced subgraph, retaining isolated in-scope nodes without seeding unrelated
  node kinds.

  PostgreSQL iterative operations now refresh temporary-table planner statistics
  after sufficiently large seeds and multiplicative growth, avoiding plans based
  on the engine's initial one-row estimate. The policy also covers growing BFS
  working tables and is a no-op on SQLite.

  Set-based reachability now deduplicates edge targets before target-node
  visibility checks and avoids computing unused predecessor paths. This reduces
  dense-frontier work while preserving minimum-depth results and cross-backend
  semantics.

- [#288](https://github.com/nicia-ai/typegraph/pull/288) [`17a3f83`](https://github.com/nicia-ai/typegraph/commit/17a3f83d806e0b77748c346f5c320d8d55080b91) Thanks [@pdlug](https://github.com/pdlug)! - Add `store.algorithms.weightedShortestPath` — a minimum-total-weight path
  search weighting each traversed edge by a numeric edge property (LDBC
  Interactive IC14 shape). Runs frontier-based relaxation on the shared
  iterative substrate with best-target pruning, works on both execution paths
  (temporary working table and inline fallback), and honors valid-time and
  recorded-time coordinates including pinned StoreViews. Edge weights are
  audited up front: negative, non-numeric, out-of-range, or (without
  `defaultWeight`) missing weights throw the new typed
  `InvalidEdgeWeightError`. Weight arithmetic is IEEE 754 double precision on
  both backends, so total weights are backend-identical; among
  equal-total-weight paths the returned node sequence is too, except when the
  `edges` list exceeds the backend's bind-parameter budget (hundreds of edge
  kinds in one call).

### Patch Changes

- [#282](https://github.com/nicia-ai/typegraph/pull/282) [`923219d`](https://github.com/nicia-ai/typegraph/commit/923219d6854a0a97cc186c2f4f27e6564bb935be) Thanks [@pdlug](https://github.com/pdlug)! - Add a `(graph_id, id)` index to the live and recorded node tables so bare-id
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

- [#265](https://github.com/nicia-ai/typegraph/pull/265) [`35ab2a0`](https://github.com/nicia-ai/typegraph/commit/35ab2a02af728df9059750518ddbdd12e489450e) Thanks [@pdlug](https://github.com/pdlug)! - Docs: scope the `coalesceUnchangedUpserts` benefit correctly. Coalescing
  eliminates _re-delivery_ churn (an already-applied change delivered again,
  value-identical to the live row). It does not make a full replay-from-zero
  free when the stream supersedes values in place: re-applying an older value
  over the live row is a genuine change, and restoring the current value
  afterwards is another, so such a replay still writes — and leaves a spurious
  back-and-forth band in the live store's recorded history. Churn-free rebuilds
  replay into a fresh store instead. Clarified in the option's TSDoc and in the
  "Materializing external event logs" guide; no behavior change.

- [#289](https://github.com/nicia-ai/typegraph/pull/289) [`199b33a`](https://github.com/nicia-ai/typegraph/commit/199b33aabffa304b6a11f34ad7ca9b0e5f449218) Thanks [@pdlug](https://github.com/pdlug)! - Cap SQLite-backed Durable Object statements at Cloudflare's 100-bound-parameter
  limit. Structural client detection now makes platform identity authoritative
  over stale execution hints, and capability overrides cannot raise the hard
  ceiling. Recorded-history capture and every capability-driven SQLite batch path
  chunk large writes before workerd rejects the query, while SQLite literal list
  predicates use one JSON-bound parameter instead of one bind per element.

- [#285](https://github.com/nicia-ai/typegraph/pull/285) [`9949562`](https://github.com/nicia-ai/typegraph/commit/99495623057610e502671515709c29d8f5139ae2) Thanks [@pdlug](https://github.com/pdlug)! - Cut three overheads out of the iterative graph algorithms, root-caused with
  `EXPLAIN (ANALYZE, BUFFERS)` against LDBC SNB SF1 on PostgreSQL.

  Weakly connected components no longer re-validates node visibility per edge in
  its propagate rounds. The working table is seeded through the same
  graph/kind/temporal filters inside the same snapshot and both edge endpoints
  are already joined against it, so membership is the visibility proof; the
  per-edge `typegraph_nodes` index loops (hundreds of thousands per round on
  SF1) added nothing. Results are byte-identical.

  Traversal rounds now carry their own bookkeeping instead of issuing follow-up
  statements: seeding returns the frontier through `INSERT … RETURNING`, and
  bidirectional shortest-path rounds detect the frontier meeting inside the
  expansion statement rather than with a separate probe per round. A
  shortest-path traversal that used to issue two to three statements per round
  now issues one, roughly halving round-trip latency on latency-bound
  connections. The working-table `ANALYZE` policy is unchanged in its
  thresholds but no longer runs when no further round will read the table.
  When several equal-depth meetings exist, the tie now breaks by node id then
  kind in code-unit order on both backends — previously the selection followed
  the database collation, so a PostgreSQL cluster with a linguistic default
  collation could pick a different (equally shortest) path.

  New option: iterative algorithm calls (`reachable`, `shortestPath`,
  `canReach`, `neighbors`, `weaklyConnectedComponents`) accept
  `workingMemory?: string`, an opt-in, transaction-scoped override of the
  session's `work_mem`, applied on PostgreSQL with `SET LOCAL` semantics via
  parameterized `set_config`. By default (option omitted) operations inherit
  the server's configured `work_mem` — nothing is overridden. `work_mem` is a
  threshold each sort/hash operator (and each parallel worker) may allocate up
  to, not a per-operation budget, and concurrent calls multiply it; set it
  deliberately (e.g. `"64MB"`) for large single-tenant analytical runs where
  the configured default spills whole-graph sorts to disk (measured ~106MB
  external merges per WCC round on SF1). The override never touches the
  session or server setting, is validated as `<digits>kB|MB|GB` within
  PostgreSQL's accepted `work_mem` range (64kB–2147483647kB) with the same
  typed error on both backends, and is ignored by SQLite.

- [#290](https://github.com/nicia-ai/typegraph/pull/290) [`247c1b7`](https://github.com/nicia-ai/typegraph/commit/247c1b77b8c30d2f03520d52214bfaebbf1a0e6c) Thanks [@pdlug](https://github.com/pdlug)! - Fix PostgreSQL pointer-level `pathIsNull()` / `pathIsNotNull()` predicates
  misclassifying two stored value shapes. The previous text-comparison form
  (`#>> path = 'null'`) went three-valued on a stored JSON `null` — so
  `pathIsNull()` silently failed to match those rows on PostgreSQL while
  matching them on SQLite — and misread the JSON _string_ `"null"` as null,
  falsely matching it with `pathIsNull()` and excluding it from
  `pathIsNotNull()`. Both predicates are now type-based (`jsonb_typeof`) and
  never SQL NULL, converging on SQLite's (correct) semantics. Field-level
  `isNull()` / `isNotNull()` predicates were already correct and are unchanged.
  Behavior change on PostgreSQL for affected data: rows holding a JSON `null`
  now match `pathIsNull()`, and rows holding the string `"null"` no longer do.

- [#283](https://github.com/nicia-ai/typegraph/pull/283) [`8306680`](https://github.com/nicia-ai/typegraph/commit/830668032328e5fdc031deccfaf0c452f466a15c) Thanks [@pdlug](https://github.com/pdlug)! - Selective `ORDER BY … LIMIT` queries now compile with late materialization:
  the query sorts and limits a lean candidate set carrying only identity, sort
  keys, and predicate columns, then re-fetches the deferred projection columns
  by primary key for only the surviving rows — instead of extracting every
  projected column for every candidate and discarding all but the `LIMIT`
  survivors after the sort. At LDBC SNB SF1, IC9's top-20 over a 1.18M-comment
  fan-out stops extracting `content` 1.18M times, ~30–37% faster on SQLite.

  The transform fires only on the selective `.select()` path with `ORDER BY`
  and a positive `LIMIT` at the live coordinate. Aggregates, vector/fulltext,
  optional (LEFT JOIN) traversals, edge-field projections, non-selective
  queries, and recorded-time reads keep the flat plan unchanged.

- [#274](https://github.com/nicia-ai/typegraph/pull/274) [`2a889aa`](https://github.com/nicia-ai/typegraph/commit/2a889aaea095a842fdd6f1b4a97feba5e6026d82) Thanks [@pdlug](https://github.com/pdlug)! - Replace path-enumerating recursive CTEs in `reachable`, `neighbors`,
  `shortestPath`, and `canReach` with set-based breadth-first search.

  Transactional SQLite and PostgreSQL backends now execute graph iterations
  against a connection-local temporary working table, de-duplicated by node kind
  and ID on every round. Non-transactional backends retain parity through a
  bind-limit-aware inline frontier. Traversals run in one snapshot where the
  backend supports transactions, preserve temporal filtering, and clean up
  temporary state on success or failure.

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

  > **Correction (see #325).** The "snapshot consistency" bullet above was never
  > accurate and is retained only as the historical record. `batch()` opens its
  > implicit transaction without an isolation option, so PostgreSQL runs it at the
  > default read-committed isolation and a later query in the batch _can_ observe a
  > commit the earlier ones did not. The "single connection" bullet describes the
  > transactional path; connection reuse is otherwise the adapter's business, not a
  > consequence of `capabilities.transactions`. `batch()` also never pipelined,
  > despite the original issue specifying it.
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
  - `store.clear()` — hard-delete all data for the current graph (nodes, edges, uniques, embeddings, schema versions). Resets collection caches so the store is immediately reusable with raw, unversioned semantics; reopen it through a managed factory before relying on schema-version fencing.

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
