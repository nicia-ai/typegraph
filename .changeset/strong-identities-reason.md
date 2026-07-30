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
