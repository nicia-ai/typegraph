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
