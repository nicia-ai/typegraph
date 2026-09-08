---
"@nicia-ai/typegraph": minor
---

`GraphBackend` gains an optional `lineage` member (`LineageMembers`): an opaque, whole-database
`revision()` an engine can report and compare, plus `changesSince(revision, graphId)`, which names
every node and edge of one graph that changed — inserted, updated, deleted, or resurrected — since
that revision, or admits `{ kind: "unbounded" }` when it cannot bound the answer. It is a query
surface only; nothing in it writes a row. `requireLineage` is the typed refusal for a caller that
needs it and finds it absent, in the same style as `requireCatalog`. `EngineProvisioning` gains a
matching optional `lineage` field, forwarded onto the backend unchanged; neither bundled Drizzle
profile supplies one, so a store's own recorded-relations derivation backs the capability instead
(below); the `lineage` member itself emits no SQL. The recorded relations it derives from are
already part of the schema regardless of `history`, and a DDL-running boot (`createStoreWithSchema`,
unless `systemIndexes: "skip"`) now materializes two new system indexes on them, history on or off —
see the parity-snapshot note below for exactly what moves.

`recordedRelationsLineage(store)` derives `lineage` from a store's own recorded relations for any
store constructed with `history: true`: `revision()` reports the graph's recorded-time clock;
`changesSince` covers every write shape a recorded relation can express — inserts, updates, soft
deletes, hard deletes, and resurrections — deduplicated, and reports `unbounded` for a revision it
cannot answer for (unrecognized, or predating a detectable pre-capture gap). `resolveLineage(store)`
is the one place graph-merge (and any other caller) picks a `lineage` source: the backend's own when
declared, else this recorded-relations one when history is on, else `undefined`. A new system index,
`since_idx (graph_id, recorded_from)`, backs `changesSince` on both recorded relations; existing
databases obtain it through the same index-materialization machinery that already backfills a
missing system index lazily, with no manual migration step. The parity snapshot moves by exactly
these two index declarations on both bundled backends — nothing else in the emitted DDL changes.

`base@V`'s anchor gains a third form, `engine:<revision>`, chosen when a store has no
`revisionTracking`/`history` but its backend declares `lineage` directly (a capturing store's
recorded-relations lineage never reaches this form — capture also turns revision tracking on, so
the per-graph anchor wins first). The precedence — revision anchor, then engine anchor, then the
compatibility content fingerprint — is documented once, in `base-version.ts`. Re-validating an
engine anchor confirms a raw revision mismatch through `changesSince` before refusing, since the
engine's revision is whole-database and an unrelated graph's commit must not fail this graph's
merge; an empty delta is tolerated as unchanged, and a non-empty delta or `unbounded` raises
`BaseVersionMismatchError` with `details: { expectedRevision, liveRevision, changedKeys? }`. One
known gap: `changesSince` names only node and edge keys, so a commit touching only a graph's current
identity assertions is invisible to an engine-anchored guard and tolerated as unchanged — the
content-fingerprint and revision-anchor forms do not share this gap.

`GraphBranch` gains an optional `forkRevision`, the fork's own `lineage.revision()` captured by
`branch()` right after the working copy is created. `diffAgainstBase` takes an optional `pruneTo`
lineage delta: when present, each node/edge kind is read by id set instead of a full keyset
enumeration, restricted to the union of what changed on the fork since `forkRevision` and on the
base since its own `base@V` anchor. A key absent from both deltas cannot have moved since the fork
point, so pruning cannot miss a change — it only narrows how much is read. Pruning applies only when
both sides can supply a bounded delta; a hand-built branch, a store with no `lineage`, or an
`unbounded` answer on either side falls back to the full diff exactly as before. Pruning is a pure
optimization: it never changes what a merge decides, only how much of the store it reads to decide
it.
