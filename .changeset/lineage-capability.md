---
"@nicia-ai/typegraph": minor
---

`GraphBackend` gains an optional `lineage` member (`LineageMembers`): an opaque, whole-database
`revision()` an engine can report and compare, plus `changesSince(revision, graphId)`, which names
every node and edge of one graph that changed — inserted, updated, deleted, or resurrected — since
that revision, or admits `{ kind: "unbounded" }` when it cannot bound the answer. It is a query
surface only; nothing in it writes a row. `requireLineage` is the typed refusal for a caller that
needs it and finds it absent, in the same style as `requireCatalog`. `TransactionBackend` gains the
same optional `lineage` member (through the new `LineageBackend` member type, mirroring
`CatalogBackend`), so a profile-supplied `lineage` is visible on a `transaction()` handle exactly as
`catalog` already was, not only on the root backend. `EngineProvisioning` gains a matching optional
`lineage` field, forwarded onto the backend unchanged; neither bundled Drizzle profile supplies one,
so a store's own recorded-relations derivation backs the capability instead (below); the `lineage`
member itself emits no SQL. The recorded relations it derives from are
already part of the schema regardless of `history`, and a DDL-running boot (`createStoreWithSchema`,
unless `systemIndexes: "skip"`) now materializes two new system indexes on them, history on or off,
plus a third structural index on the recorded identity-assertions relation. A caller that opted out
with `systemIndexes: "skip"` gets the two system indexes on the next explicit
`store.materializeSystemIndexes()` call instead of at boot — see the parity-snapshot note below for
exactly what moves.

`recordedRelationsLineage(store)` derives `lineage` from a store's own recorded relations for any
store constructed with `history: true`: `revision()` reports the graph's recorded-time clock;
`changesSince` covers every write shape a recorded relation can express — inserts, updates, soft
deletes, hard deletes, and resurrections — deduplicated, and reports `unbounded` for a revision it
cannot answer for (unrecognized, or predating a detectable pre-capture gap). `resolveLineage(store)`
is the one place graph-merge (and any other caller) picks a `lineage` source: the backend's own when
declared, else this recorded-relations one when history is on, else `undefined`. A new system index,
`since_idx (graph_id, recorded_from)`, backs `changesSince` on the two recorded relations, and the
recorded identity-assertions relation gains a matching `since_idx` of its own (structural, created
with the table, since it is not a `materializeIndexes`-managed system index) — `earliestRecordedFrom`
(the pre-capture-gap detector `changesSince` consults) folds that relation into the same
`MIN(recorded_from)` floor as the two recorded relations. A database already open when this ships
adopts all three indexes on its NEXT open, through the base-schema release-3 adoption step below
(`"lineage-since-index"`) — the same lazy backfill machinery a missing system index already goes
through for any OTHER caller (the two recorded-relation indexes; the identity-assertions index is
adopted only through the base-schema step, never through `store.materializeSystemIndexes()`), and
immediately for the two recorded-relation indexes when a caller opted out of boot-time materialization
with `systemIndexes: "skip"`, via its own explicit `store.materializeSystemIndexes()` call. The parity
snapshot moves by exactly these three index declarations, plus one extra version-marker
`INSERT`/`SELECT` round trip on each of four capture scenarios on both bundled backends (bootstrap
publishing the new base-schema release below) — no other statement, and no graph-data write SQL,
changes.

`GraphBackend` adopters that ship their own `EngineProvisioning` gain a required base-schema
release: `CURRENT_BASE_SCHEMA_VERSION` advances from 2 to 3, id `"lineage-since-index"`, adopting
the three `since_idx` indexes above through `CREATE INDEX IF NOT EXISTS` (idempotent, safe to run
concurrently, and a no-op on a fresh install whose generated DDL already carries them). The bump is
one-way — there is no downgrade path — and deployment-visible: a database already stamped 3 is
untouched, one stamped 2 is caught up in place on next open, and a store built against an
`EngineProvisioning` whose adoption-step registry stops at 2 fails to construct
(`CompilerInvariantError`, "adoption registry must end at the current version"). A zero-DDL
`createVerifiedStore` attach against a database still stamped 2 refuses with
`BaseSchemaMigrationError` until `adoptBaseSchema()` runs. A custom SQL engine profile must register
a version-3 adoption step (or accept the three indexes into its own fresh-install DDL and mark the
step `bootstrap: "covered-by-generated-ddl"`) before upgrading past this release.

`base@V`'s anchor gains a third form, `engine:<revision>`, chosen when a store has no
`revisionTracking`/`history` but its backend declares `lineage` directly (a capturing store's
recorded-relations lineage never reaches this form — capture also turns revision tracking on, so
the per-graph anchor wins first). The precedence — revision anchor, then engine anchor, then the
compatibility content fingerprint — is documented once, in `base-version.ts`. Re-validating an
engine anchor confirms a raw revision mismatch through `changesSince` before refusing, since the
engine's revision is whole-database and an unrelated graph's commit must not fail this graph's
merge; an empty delta is tolerated as unchanged, and a non-empty delta or `unbounded` raises
`BaseVersionMismatchError` with `details: { expectedRevision, liveRevision, changedKeys? }`, where
`changedKeys` (when present) is capped to the first 20 node keys and first 20 edge keys plus each
list's own total count, never the raw unbounded delta. One known gap: `changesSince` names only node
and edge keys, so a commit touching only a graph's current identity assertions is invisible to an
engine-anchored guard and tolerated as unchanged — the content-fingerprint and revision-anchor forms
do not share this gap.

`GraphBranch` gains an optional `forkRevision`, the fork's own `lineage.revision()` captured by
`branch()` right after the working copy is created. `diffAgainstBase` takes an optional `pruneTo`
lineage delta: when present, each node/edge kind is read by id set instead of a full keyset
enumeration, restricted to the union of what changed on the fork since `forkRevision` and on the
base since its own `base@V` anchor. A key absent from both deltas cannot have moved since the fork
point, so pruning cannot miss a change — it only narrows how much is read. Pruning applies only when
both sides can supply a bounded delta; a hand-built branch, a store with no `lineage`, an `unbounded`
answer on either side, or either side's `changesSince` REJECTING falls back to the full diff exactly
as before. Pruning is a pure optimization: it never changes what a merge decides, only how much of
the store it reads to decide it.

## Breaking

- `BaseSchemaRuntime` (and the `CreateBaseSchemaMembersDeps` it is derived from) requires its
  `sinceIndexDdl` field to carry three `CREATE INDEX IF NOT EXISTS` statements instead of two —
  `readonly [string, string, string]`, in `(recordedNodes, recordedEdges,
  recordedIdentityAssertions)` order — built from a dialect's own physical table names via
  `sinceIndexAdoptionDdl` (`src/indexes/system.ts`), which now also takes a
  `recordedIdentityAssertions` table name. A custom `SqlEngineProfile` that builds its own
  `baseSchemaRuntime` must pass the widened tuple; there is no longer a separate
  `identityAssertionsSinceIndexDdl` field to supply.
