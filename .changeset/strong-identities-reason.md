---
"@nicia-ai/typegraph": minor
---

Add the opt-in TypeGraph Identity Profile with typed store, transaction, and
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
the identity simulation against that exact snapshot (its classes union in
as pre-linked groups), so drift landing between planning and the snapshot
fails as a typed plan-time conflict instead of becoming the guard's
baseline. Fingerprints are structurally encoded (injective for ids
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
