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
identity traversal option, and disabled graphs run no identity locks, probes,
closure work, or identity SQL. The surfaces are guarded at two levels: on a
disabled graph type `tx.identity` is absent at compile time, while the
`store.identity` and `StoreView.identity` getters are guarded at runtime and
throw `ConfigurationError` with details code `IDENTITY_NOT_ENABLED` if reached
(for example through a widened or `any`-typed store handle).

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

Bulk methods are eager, preserve input order, and run under one graph identity
lock. Reasserting a current semantic pair is idempotent; assertion results
distinguish `action: "created"` from `action: "existing"`. Retraction methods
return the ended assertion (or `undefined` for a missing current assertion),
and bulk retraction returns all ended assertions. Self-assertions are rejected.
Assertion IDs use the exported private-symbol-branded
`IdentityAssertionId` type so unrelated strings cannot be passed accidentally.
When you hold a plain assertion-ID string that came from persistence or an
interchange document, re-enter the branded type with the `asIdentityAssertionId(value)`
caster rather than a `as` assertion.

Reference reads return graph-bounded `{ kind, id }` values whose IDs retain the
node kind's `NodeId` brand. `nodesOf` hydrates the class into a kind-discriminated
node union. A missing, deleted, or
coordinate-invisible input returns `undefined`, `[]`, or `false` according to
the method. A visible singleton returns itself from `membersOf` and
`representativeOf`, and `areSame(ref, ref)` is true. `areDifferent` lifts an
explicit different assertion across both identity classes and also reflects
ontology `disjointWith` constraints. Representatives are deterministic: the
code-point-smallest `(kind, id)` visible member wins.

## Integrity and lifecycle

Assertions require live endpoints. `assertSame` fails when a current
`different` assertion spans the two classes or when any member kinds are
ontology-disjoint. `assertDifferent` fails when both endpoints are already in
one class. These checks, folding, node deletion, import, and schema validation
share one per-graph lock and one mutation coordinator.

Soft-deleting a node ends its current assertions. Hard-deleting it removes its
assertions permanently. On every graph, a `create()` or `upsert` for a
soft-deleted same-`(kind, id)` row **resurrects** that row rather than erroring:
its properties are replaced and its validity window is reset, so `validFrom`
becomes the resurrection instant. This graph-wide rule does not depend on the
identity profile. Resurrection does not revive ended assertions, but folding
runs again over the resurrected node when configured. Kind removal
cascades assertion and closure rows for the removed kinds. Tightening ontology
disjointness is rejected when it would make a persisted class contradictory.

`rebuildIdentityClosure(store)` repairs the derived current closure from live
nodes and current assertions. It validates integrity and never advances the
content revision.

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

```typescript
const before = await store.recordedNow();
const historical = store.asOfRecorded(before!);
await historical.identity.membersOf(alice);
```

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
physical edge within the step. Recursive traversal supports the same option.
TypeGraph does not perform automatic graph-wide expansion and collection reads
such as `getById` have no identity option.

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
shape validation and do not affect current closure. Ended assertions can
reference soft-deleted nodes, so pair `identityMode: "archival"` with
`includeDeleted: true` to keep the archive self-contained — otherwise the
export can carry assertions whose endpoints are absent from the same document.
Recorded side tables are not part of interchange.

Graph merge includes identity truth in staleness fingerprints and diffs.
Duplicate current assertions use the earliest `validFrom`, then the
code-point-smallest assertion ID. Opposing relations and retract/reassert races
are typed `IdentityMergeConflictError`s. This is mechanical truth propagation,
not semantic entity reconciliation.

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
