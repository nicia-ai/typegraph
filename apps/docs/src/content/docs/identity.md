---
title: Operational Identity
description: Assert, retract, query, and historize identity between graph nodes
---

The TypeGraph Identity Profile records identity facts between **individual
nodes**. It is deliberately smaller than OWL: `same` is symmetric and
transitive, `different` is symmetric and class-lifted, and neither relation
substitutes properties or automatically expands every graph query.

## Enable the profile

Identity is graph-level and opt-in:

```typescript
const graph = defineGraph({
  id: "knowledge",
  nodes: { Person: { type: Person }, Author: { type: Author } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});
```

The option is serialized with the schema. Enabled graph types expose
`store.identity`, `tx.identity`, read-only `StoreView.identity`, and the
identity traversal option. All three use the same conditional-**presence**
encoding: on an identity-disabled graph type, `identity` does not exist on
`Store`, `TransactionContext`, or the read-only views at all — reaching for it
is a compile error, not a `never`-typed property. A runtime `ConfigurationError`
with details code `IDENTITY_NOT_ENABLED` backs every one of those getters too,
for the widened or `any`-typed handles TypeScript can't check (a JavaScript
caller, or a store handle that lost its precise graph type).

At runtime, a disabled graph does no identity work: no identity locks, probes,
closure computation, or identity SQL run. That guarantee is scoped to runtime
behavior — a bundled backend still provisions the identity tables' schema (not
work) when it bootstraps a fresh database, independent of whether the specific
graph passed to `createStore`/`createStoreWithSchema` declares `identity`.

`sameIdAcrossKinds: "fold"` preserves TypeGraph's structural ID rule: live
nodes of different kinds with the same ID belong to one identity class. No
assertion row is manufactured for that implicit membership. Use
`sameIdAcrossKinds: "ignore"` to enable the assertion ledger without joining
equal IDs across kinds; only explicit `same` assertions then join classes.

## Write and read identity

```typescript
const alice = await store.nodes.Person.create(
  { name: "Alice" },
  { id: "person-alice" },
);
const author = await store.nodes.Author.create(
  { penName: "A. Example" },
  { id: "author-alice" },
);

const result = await store.identity.assertSame(alice, author);
// result.action is "created" or "existing"; result.assertion is durable truth

await store.identity.membersOf(alice);
// [{ kind: "Author", id: "author-alice" },
//  { kind: "Person", id: "person-alice" }]

await store.identity.representativeOf(alice);
await store.identity.nodesOf(alice); // hydrated, kind-discriminated nodes
await store.identity.areSame(alice, author);
await store.identity.assertionsOf(alice);

const ended = await store.identity.retractAssertion(result.assertion.id);
// ended?.validTo is the exact assertion end instant
```

The complete write surface is:

- `assertSame(a, b)` and `assertDifferent(a, b)`
- `bulkAssertSame(pairs)` and `bulkAssertDifferent(pairs)`
- `retractAssertion(id)`
- `retractSameAssertion(a, b)` and `retractDifferentAssertion(a, b)`
- `bulkRetractAssertions(ids)`

Bulk methods are eager and, on PostgreSQL, run under one graph identity lock
(see [Operational notes](#operational-notes) — SQLite serializes through its
single-writer lock instead). `bulkAssertSame` and `bulkAssertDifferent`
preserve input order and return exactly one result per input pair. Reasserting
a current semantic pair is idempotent; assertion results distinguish
`action: "created"` from `action: "existing"`. Retraction methods return the
ended assertion (or `undefined` for a missing current assertion).
`bulkRetractAssertions` does **not** share that one-result-per-input shape: it
dedupes the input ids and returns only the assertions that were actually open,
in dense, first-occurrence input order — so the result does not align
index-by-index with the input array. Self-assertions are rejected.
Assertion IDs use the exported private-symbol-branded
`IdentityAssertionId` type so unrelated strings cannot be passed accidentally.
When you hold a plain assertion-ID string that came from persistence or an
interchange document, re-enter the branded type with the `asIdentityAssertionId(value)`
caster rather than a `as` assertion.

Runtime-evolved nodes carry a nominal dynamic-node type, so they flow through
the same identity surface without a cast:

```typescript
const evolved = await store.evolve(extension);
const person = await evolved.nodes.Person.create({ name: "Alice" });
const tag = await evolved
  .getNodeCollectionOrThrow("Tag")
  .create({ label: "author" });

await evolved.identity.assertSame(person, tag);
await evolved.identity.membersOf(tag);
```

Identity results include both compile-time graph references and dynamic node
references. This widening is necessary even when a read starts from `person`:
its class can contain `tag`. A plain `{ kind: string, id: string }` is not a
proof that the kind came through the evolved Store; pass the dynamic node, or a
nominal dynamic reference returned by an identity read. Unknown and removed
kinds still fail at runtime with `KindNotFoundError`.

Reference reads return `IdentityNodeReference<G>` values covering both
compile-time graph kinds and registered runtime kinds. Their IDs retain the
appropriate nominal brand. `nodesOf` hydrates the class into static
kind-discriminated members or `DynamicNode` values for runtime members. A
missing, deleted, or coordinate-invisible input returns `undefined`, `[]`, or
`false` according to the method. A visible singleton returns itself from `membersOf` and
`representativeOf`, and `areSame(ref, ref)` is true. `areDifferent` lifts an
explicit different assertion across both identity classes and also reflects
ontology `disjointWith` constraints. Representatives are deterministic: the
code-point-smallest `(kind, id)` visible member wins.

## Integrity and lifecycle

Assertions require live endpoints. `assertSame` fails when a current
`different` assertion spans the two classes or when any member kinds are
ontology-disjoint. `assertDifferent` fails when both endpoints are already in
one class. These checks, folding, node deletion, import, schema-transition
validation, and closure rebuild share one per-graph lock and one mutation
coordinator.

Soft-deleting a node ends its current assertions. Hard-deleting it removes
every current and ended assertion touching the node from the live assertion
ledger; when recorded history is enabled, earlier recorded coordinates remain
queryable. On every graph, a `create()` or `upsertById()` for a soft-deleted
same-`(kind, id)` row **resurrects** that row rather than erroring:
its properties are replaced and its validity window is reset, so `validFrom`
becomes the resurrection instant — unless the write carries an explicit
window, which is honored as given (this is how merge preserves
branch-authored windows). A resurrecting node write that supplies only a
historical `validTo` is refused as a `ValidationError` rather than
persisting a window that ends before it begins; pass both bounds for a
historical window. (Edge resurrection instead keeps its stored lower bound,
so `getOrCreateByEndpoints` can resurrect an edge directly into the ended
state — but the end it names is held to that retained bound, so reviving
an edge into a window that closed before the edge began likewise means
passing both.) This graph-wide rule does not depend on the
identity profile. Resurrection does not revive ended assertions, but folding
runs again over the resurrected node when configured. Kind removal
cascades assertion and closure rows for the removed kinds. Tightening ontology
disjointness is rejected when it would make a persisted class contradictory.

`rebuildIdentityClosure(store)` repairs the derived current closure from live
nodes and current assertions. It validates integrity and never advances the
content revision.

### The database-level backstop

The checks above are code deciding whether a write is legal, and code can be
wrong. Underneath them TypeGraph maintains a second derived relation — the
**separation relation** — that holds one row per pair of identity classes a
current `different` assertion keeps apart, keyed by the two class keys under a
`CHECK (class_key_low < class_key_high)` constraint.

Every transaction that fuses two identity classes relabels the affected
separation rows in the same statement batch. Fusing two classes that were
separated relabels both sides of their shared row to one key, the constraint
rejects it, and the transaction aborts — in the engine, with no application
code in the way. A write that reaches the ledger through a path that skipped
identity validation therefore still cannot commit a contradictory graph; it
fails with an `IdentitySeparationViolationError` naming the `different`
assertion it contradicts.

Nothing about the identity API changes. The relation is derived and
maintained wherever the closure is, `rebuildIdentityClosure(store)` recomputes
it from the ledger, and store-open validation checks it against that
recomputation the same way it checks the closure.

## Temporal identity

Integrity is **structural**; reads are **coordinate-visible**.

Current reads use a materialized closure and then filter members through the
same visibility predicate ordinary node reads use. `store.identity` and
`store.asOf(now).identity` therefore agree.

Non-current valid-time and recorded-time views reconstruct one fixed point over
both explicit `same` assertions and same-ID folding edges. A structurally
existing but coordinate-invisible bridge can conduct identity without being
returned as a member. Recorded assertions are captured in the same commit as
the truth-bearing write.

Identity profile and ontology rules are schema-level interpretation, not a
third temporal dimension. Historical views apply the Store's pinned
`sameIdAcrossKinds` mode and ontology to the assertions and nodes visible at the
requested coordinate. Changing those schema rules can therefore reinterpret
older coordinates; it does not rewrite the recorded assertion ledger.

```typescript
const before = await store.recordedNow();
const historical = store.asOfRecorded(before!);
await historical.identity.membersOf(alice);
```

### Folds and time

Implicit same-id folds (`sameIdAcrossKinds: "fold"`) conduct based on a node's
**lifecycle** — whether it currently exists and is not soft-deleted — not its
valid-time window. A node created today with a backdated `validFrom` is
valid-time visible in the past (an ordinary node read at that past coordinate
returns it), but it does not conduct a fold there: the fold only takes effect
once the node actually exists. Symmetrically, a node with a future `validFrom`
does not suppress its folds today — it already exists and is live, so it
folds now even though it is not yet valid-time visible. Explicit `same` and
`different` assertions are unaffected by this: they carry their own validity
windows and conduct exactly when they are current. This keeps the fold
computation tied to write events rather than to valid-time windows, so the
materialized closure used by current reads and by `asOf(now)` reads is
identical — a fixed-point reconstruction of "current" never needs to
special-case valid-time skew on the folding edge itself.

## Identity-expanded traversal

Traversal expansion is per hop and defaults off:

```typescript
const results = await store
  .query()
  .from("Person", "person")
  .traverse("authored", "edge", { includeIdentityMembers: true })
  .to("Document", "document")
  .select((ctx) => ({ edge: ctx.edge, document: ctx.document }))
  .execute();
```

The hop considers coordinate-visible members of the source class, returns the
physical edge and target rows, preserves their provenance, and deduplicates a
physical edge within the step — with one legitimate exception: a self-inverse
edge (`inverseOf(edgeKind, edgeKind)`) traversed with `expand` between two
identity-folded peers can yield the same physical edge twice, once per
direction/target it matches through the fold. That is not a dedup bug; the
edge genuinely satisfies the traversal from both of its endpoints. Recursive
traversal supports the same option.
TypeGraph does not perform automatic graph-wide expansion and collection reads
such as `getById` have no identity option.

Both coordinates reach the candidate edge the same way — an ordinary indexed
equality on the class member, never a membership test evaluated per candidate
edge. How each one reaches the class differs, because what a class costs to
compute differs.

At the **current** coordinate the maintained closure already *is* the class
relation, so each traversal step seeks into it from its own frontier rows: the
frontier row's class through the closure's primary key, that class's members
through the class index, each member's node for its visibility. Cost is
proportional to the frontier and the size of its classes — never to how many
identity classes the graph holds. Measured on SQLite with *n* Person nodes, each
folded with a Company and an Alias peer sharing its id (a three-member class per
source), all *n* acting as source rows and every edge leaving the Company peer:

| source rows | fan-out | matching edges | before | after |
| --- | --- | --- | --- | --- |
| 250 | 1 | 250 | 67 ms | 6 ms |
| 1000 | 1 | 1000 | 1077 ms | 9 ms |
| 2000 | 1 | 2000 | 4616 ms | 19 ms |
| 1000 | 8 | 8000 | 8611 ms | 13 ms |
| 500 | 200 | 100,000 | 51,602 ms | 77 ms |

Growth is linear in graph size where it used to quadruple per doubling: the hop
no longer evaluates membership per candidate *(source row, edge)* pair. The
number to plan around is the last row — a hundred thousand matching edges over a
five-hundred-row frontier is where the old per-source rescan dominated.

A **historical** hop — one under `asOf`, `asOfRecorded`, or a non-current
`view()` — cannot use the materialized closure, because the closure represents
only the present. Its rows come from a reconstruction of identity classes out of
the assertion ledger, and under `sameIdAcrossKinds: "fold"` that reconstruction
also has to consider the structural same-id relation, which is proportional to
the number of live nodes in the graph. No frontier row narrows that fixed point,
so it is built once per statement into a materialized relation every traversal
step joins. Measured on the narrow-edge fixture that isolates the term (SQLite,
*n* Person nodes each folded with a Company peer, all *n* acting as source rows,
fan-out 1):

| *n* | before | after |
| --- | --- | --- |
| 250 | 122 ms | 7 ms |
| 500 | 486 ms | 7 ms |
| 1000 | 1984 ms | 14 ms |
| 2000 | 8261 ms | 28 ms |

Growth is linear in graph size where it used to quadruple per doubling.

The caveat that remains is the historical one, and it is worth planning around: a
past-coordinate hop rebuilds the whole graph's classes even when you asked about
one node, so its floor is a pass over the identity population regardless of how
narrow the frontier is. A **current** hop has no such floor — a single-start-row
hop over 50,000 folded triples measures 1 ms on SQLite against 387 ms when the
class relation was still built graph-wide, and nine unrelated 501-member classes
cost it nothing at all (0.5 ms on SQLite, 2.4 ms on PostgreSQL, against 564 ms
and 568 ms). Pick the coordinate you actually need: reading the present is the
cheaper question by a wide margin.

## Interchange and branch merge

Interchange format `2.0` optionally carries an identity section. State export
(the default) includes current assertions. Import into a populated target is
target-oriented: an existing current semantic pair keeps its target assertion
ID and `validFrom`. Working-copy branch cloning imports into an empty target and
preserves source IDs and `validFrom` exactly.

```typescript
const state = await exportGraph(store, { includeTemporal: true });
const archive = await exportGraph(store, {
  identityMode: "archival",
  includeDeleted: true,
});
```

Archival mode also includes ended assertions. Those rows are restored after
shape validation and do not affect current closure. An ending a node deletion
caused carries that node as `endedBy`, so a round-trip preserves why each
assertion ended and not merely that it did; import rejects an `endedBy` on an
open assertion, or one naming a node that is not an endpoint of the assertion
it ends. Ended assertions can
reference soft-deleted nodes, and by default (`includeDeleted: false`) export
joins every assertion against its endpoints' live rows — an assertion with a
soft-deleted endpoint is silently **dropped from the export entirely**, not
carried with a dangling reference. Pair `identityMode: "archival"` with
`includeDeleted: true` to keep those assertions in the archive. Interchange
documents carry no `deletedAt` field, so a node exported only because of
`includeDeleted: true` re-imports as **live** — an `includeDeleted` archive
resurrects its soft-deleted nodes on import rather than restoring them as
deleted. Weigh that trade-off deliberately for a backup: without
`includeDeleted`, soft-deleted endpoints and the assertions that reference them
are silently absent; with it, those nodes come back alive. Recorded side
tables are not part of interchange.

Graph merge includes identity truth in staleness fingerprints and diffs.
Duplicate current assertions use the earliest `validFrom`, then the
code-point-smallest assertion ID — unless one candidate is already committed
on the target with the exact staged truth, which always wins: the applier is
idempotent per semantic pair, so a challenger could never actually be
written. A node deletion cascades into ending the assertions touching it, at
the node's own deletion instant, and records the deleted node on every row it
ends — so the diff reads which endings that deletion caused and stages each
one with its cause, however close in time the branch's own retractions
fell. When a delete/modify
conflict resolution keeps the node, an ending is dropped along with the
overruled deletion that caused it (reported as
`identity:deletion-overruled`), while a retraction a branch made itself
survives the deletion being overruled — including one the deleting branch
made before deleting the node, even in the deletion's own millisecond. A hard
delete removes the assertion rows outright, taking the recorded cause with
them and leaving nothing to separate cause from intent, so those endings count
as cascades. `merge()` detects identity conflicts at plan
time and returns them as a typed `IdentityMergeConflictError` — direct
opposing relations on one endpoint pair, transitive contradictions reached
through a chain of `same` assertions no single branch wrote, retract/reassert
races, and an assertion over a node another branch deleted. A branch that
retracts a pair and also reasserts it itself (convergent, not racing) merges
cleanly. This is mechanical truth propagation, not semantic entity
reconciliation. Plan time is the early surface, not the only one: any
identity refusal that still escapes to the applier inside the commit
transaction is translated into the same typed `IdentityMergeConflictError`,
with the original error preserved as its cause (identity environment and
storage-corruption codes pass through untranslated — they are not statements
about merge truth). See
[`IdentityMergeConflictError`](/errors/#identitymergeconflicterror)
for the exact `merge()` signature and how to catch it.

### Independent targets and assertion IDs

`mergeIncremental()` accepts a target that has moved on from the branches'
fork point, so a branch's assertion IDs can meet a ledger that assigned those
IDs independently. Snapshot `merge()` still requires its target to match the
branches' base@V exactly, but the same by-ID contract governs the divergence
a branch can create within its own lineage (hard-delete/recreate replacement)
and the plan→commit window. The contract is by ID, on complete truth:

- **One assertion ID, one complete truth.** A planned assertion whose ID the
  target's ledger — ended rows included — already binds to a different
  complete truth (relation, endpoints, validity) refuses at plan time as
  `IdentityMergeConflictError`. An exact match is applied idempotently.
- **Retractions carry the truth they retract.** A branch retraction ends the
  target's current row for its ID only when that row *is* the truth the
  branch retracted. When the target reuses the ID for different truth, the
  retraction is skipped and reported in `MergeReport.dropped` as
  `identity:retraction-target-mismatch` — the branch's own assertion is
  already absent from the target, and ending the target's unrelated row
  would delete truth the branch never saw.
- **Truth replacement is a conflict, not a silent keep.** Within one lineage
  a branch can legally rebind an assertion ID by hard-deleting an endpoint
  (which physically removes the row) and importing the ID for different
  truth. The diff stages that replacement as a retraction plus a new
  assertion; because the target's ledger still holds the ID's prior truth in
  an ended row, the plan-time one-ID-one-truth check refuses it typed rather
  than silently keeping either side's truth.
- **The commit re-verifies IDs.** Both commit modes re-read every planned
  assertion and retraction ID inside the commit transaction and refuse
  plan→commit drift as `BaseVersionMismatchError` — retrying recomputes the
  plan from current state. One deliberate exception: a planned retraction
  whose row another writer already ended is accepted as a no-op, not drift.
  `MergeReport.merged.identity` reports the rows the applier actually
  created and ended; idempotent skips are excluded.
- **The commit proves the result, not the plan.** After its identity writes,
  and still inside the same transaction, a merge re-derives the identity
  classes it touched from the written state and refuses a contradiction there
  as `IdentityMergeConflictError` — so a plan validated against state that has
  since moved cannot leave a contradictory ledger behind. The whole merge rolls
  back; there is no partial commit. If the derived classes disagree with the
  materialized closure, the closure is rebuilt inside the same transaction and
  the check re-runs, which repairs a lagging closure atomically with a merge
  that is otherwise sound.

## Operational notes

On PostgreSQL, every identity-affecting node write on an identity-enabled graph
serializes on a per-graph advisory transaction lock: at most one writer per
graph proceeds at a time. This is a correctness guarantee for the assertion
ledger and closure, and it is also a throughput ceiling — concurrent writers to
the same graph queue behind the lock. Writes to other graphs, and all reads,
are unaffected.

First-time enablement is heavier than steady state. It takes a `SHARE` lock on
the shared nodes table, which briefly blocks writes for **every** graph in that
database, and it loads the whole graph to build the initial identity closure.
Plan enablement for a quiet window on large databases. `evolve()` on an
identity-enabled graph re-runs the same closure rebuild, so schema evolution
carries a comparable one-time cost proportional to graph size.

Changing `sameIdAcrossKinds` is a **breaking** schema change — a `fold`↔`ignore`
flip rewrites the materialized identity closure and changes every
`areSame`/`membersOf`/`includeIdentityMembers` answer against existing data —
so it requires the same explicit `migrateSchema()` opt-in as any other
breaking change; it never auto-migrates silently. Identity-relevant ontology
changes (`disjointWith`, `equivalentTo`/deprecated `sameAs`, or `subClassOf`)
are likewise persisted semantic migrations, not a local runtime toggle.
`createStoreWithSchema` and explicit `migrateSchema()` both rebuild and
validate the closure atomically with the schema commit that carries the
change. While the flip is unapplied, store construction refuses with
`ConfigurationError` details code `IDENTITY_PROFILE_MIGRATION_PENDING`
whenever the identity change is the only breaking one in the diff; a
migration that also breaks other schema surfaces raises the generic
`MigrationError` enumerating everything. First-time identity *enablement* (`autoMigrate: false` on a graph
newly declaring `identity: { ... }`) is a safe, additive change, and
`createStoreWithSchema` refuses to return a Store while it is pending with
`ConfigurationError` details code `IDENTITY_ENABLEMENT_PENDING`. The very
first schema commit of an identity-enabled graph is an enablement too: a
legacy database populated through an unmanaged `createStore` gets the same
atomic fold scan, contradiction validation, and closure build during
initialization — an empty database just makes them cheap no-ops.

## Migrating from type-level factories

The ontology factories `sameAs(A, B)` and `differentFrom(A, B)` are deprecated:
they relate **types**, not individual rows, and `differentFrom` never enforced
instance identity. To migrate:

1. Add `identity: { sameIdAcrossKinds: "fold" }` to the graph.
2. Open it with `createStoreWithSchema` so the capability is persisted and
   existing cross-kind same-ID groups are validated and materialized.
3. Replace type-level facts with `store.identity` assertions between concrete
   node references.
4. Use `equivalentTo` or `disjointWith` when the intended relation is genuinely
   between kinds.

On PostgreSQL, first-time enablement waits for in-flight node writes before it
builds the initial identity closure. Quiesce or restart any store instances
that were opened with the identity-disabled schema before allowing writes to
resume; stale instances do not participate in identity locking.

Identity requires interactive atomic transactions. Bundled SQLite and
PostgreSQL drivers support it; Cloudflare D1 and `drizzle-orm/neon-http` reject
an enabled graph with `ConfigurationError` details code
`IDENTITY_REQUIRES_ATOMIC_BACKEND`. Identity-disabled graphs continue to work
on those drivers.

Durable entity handles, identity-group IDs, semantic reconciliation, automatic
OWL property substitution, and graph-wide identity expansion are reserved
future capabilities and are not implied by this profile.
