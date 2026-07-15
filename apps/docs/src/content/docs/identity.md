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
identity traversal option. Disabled graph types expose none of those callable
surfaces and execute no identity locks, probes, closure work, or identity SQL.

`sameIdAcrossKinds: "fold"` preserves TypeGraph's structural ID rule: live
nodes of different kinds with the same ID belong to one identity class. No
assertion row is manufactured for that implicit membership.

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

const assertion = await store.identity.assertSame(alice, author);

await store.identity.membersOf(alice);
// [{ kind: "Author", id: "author-alice" },
//  { kind: "Person", id: "person-alice" }]

await store.identity.representativeOf(alice);
await store.identity.areSame(alice, author);
await store.identity.assertionsOf(alice);

await store.identity.retractAssertion(assertion.id);
```

The complete write surface is:

- `assertSame(a, b)` and `assertDifferent(a, b)`
- `bulkAssertSame(pairs)` and `bulkAssertDifferent(pairs)`
- `retractAssertion(id)`
- `retractSameAssertion(a, b)` and `retractDifferentAssertion(a, b)`
- `bulkRetractAssertions(ids)`

Bulk methods are eager, preserve input order, and run under one graph identity
lock. Reasserting a current semantic pair is idempotent. Self-assertions are
rejected. Assertion IDs use the exported private-symbol-branded
`IdentityAssertionId` type so unrelated strings cannot be passed accidentally.

Reads return typed `{ kind, id }` node references. A missing, deleted, or
coordinate-invisible input returns `undefined`, `[]`, or `false` according to
the method. A visible singleton returns itself from `membersOf` and
`representativeOf`, and `areSame(ref, ref)` is true. `areDifferent` lifts an
explicit different assertion across both identity classes and also reflects
ontology `disjointWith` constraints.

## Integrity and lifecycle

Assertions require live endpoints. `assertSame` fails when a current
`different` assertion spans the two classes or when any member kinds are
ontology-disjoint. `assertDifferent` fails when both endpoints are already in
one class. These checks, folding, node deletion, import, and schema validation
share one per-graph lock and one mutation coordinator.

Soft-deleting a node ends its current assertions. Hard-deleting it removes its
assertions permanently. Recreating the same `(kind, id)` does not revive ended
assertions, but folding runs again. Kind removal cascades assertion and closure
rows for the removed kinds. Tightening ontology disjointness is rejected when
it would make a persisted class contradictory.

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
const archive = await exportGraph(store, { identityMode: "archival" });
```

Archival mode also includes ended assertions. Those rows are restored after
shape validation and do not affect current closure. Recorded side tables are
not part of interchange.

Graph merge includes identity truth in staleness fingerprints and diffs.
Duplicate current assertions use the earliest `validFrom`, then the
code-point-smallest assertion ID. Opposing relations and retract/reassert races
are typed `IdentityMergeConflictError`s. This is mechanical truth propagation,
not semantic entity reconciliation.

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
