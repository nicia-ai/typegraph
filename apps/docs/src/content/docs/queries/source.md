---
title: Source
description: Starting queries with from()
---

Every query starts with `from()`, which specifies the node kind to query and assigns an alias for
referencing it throughout the query.

## Basic Usage

```typescript
const results = await store
  .query()
  .from("Person", "p")  // Start from Person nodes, alias as "p"
  .select((ctx) => ctx.p)
  .execute();
```

## Parameters

```typescript
.from(kind, alias, options?)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `kind` | `string` | The node kind to query (must exist in your graph definition) |
| `alias` | `string` | A unique identifier for referencing this node in the query |
| `options.expansion` | `"exact" \| "subclasses" \| "narrower"` | The alias's expansion axis. `"subclasses"` (the default) includes nodes of subclass kinds; `"exact"` is the named kind alone; `"narrower"` follows `broader`/`narrower` descendants instead |

## Aliases

The alias is used throughout the query to reference the node:

```typescript
const results = await store
  .query()
  .from("Person", "person")
  .whereNode("person", (p) => p.status.eq("active"))  // Reference in filter
  .orderBy("person", "name", "asc")                    // Reference in ordering
  .select((ctx) => ({
    name: ctx.person.name,                             // Reference in selection
    email: ctx.person.email,
  }))
  .execute();
```

Aliases must be unique within a query. TypeScript enforces this at compile time:

```typescript
store
  .query()
  .from("Person", "p")
  .traverse("worksAt", "e")
  .to("Company", "p")  // TypeScript error: alias "p" already in use
```

## Subclass Expansion

A query against a kind that other kinds declare `subClassOf` (or that
participates in a registered-kind `equivalentTo`/`sameAs`) is **polymorphic by
default**: `subClassOf` carries a structural contract (the child's schema
extends the parent's, checked at compile time and at registry build), so a
supertype query that silently excluded its subtypes would be a partial answer
presented as complete.

```typescript
// Graph definition with subclass relationships:
// subClassOf(Podcast, Media)
// subClassOf(Article, Media)
// subClassOf(Video, Media)

// Query Media and all subclasses (default behavior)
const allMedia = await store
  .query()
  .from("Media", "m")
  .select((ctx) => ({
    // Runtime values: "Media", "Podcast", "Article", or "Video" — the row's
    // actual kind. Static type: `string`, because the alias is widened for a
    // kind the ontology can affect (see below).
    kind: ctx.m.kind,
    title: ctx.m.title,
  }))
  .execute();

// Query only exact Media nodes
const exactMedia = await store
  .query()
  .from("Media", "m", { expansion: "exact" })
  .select((ctx) => ctx.m)
  .execute();
```

By default (`expansion` absent, or explicitly `"subclasses"`):

- Results include nodes of the specified kind AND all subclass kinds — AND any
  kind declared `equivalentTo` the specified kind (or one of its subclasses),
  since equivalence is mutual subsumption and folds into the same closure
- The `kind` field in results reflects the actual node kind, so its type is
  widened to `string` (and the row's id brand widened correspondingly) for a
  kind the ontology can actually affect — a graph declaring no subsumption
  relations keeps its exact literal types
- Only the properties the structural contract guarantees — the PARENT kind's
  own properties — are statically accessible; a subclass-only field needs
  `fromDynamic()` or a cast, the same way a graph-extension kind's field does

**Annotating a relation as `OntologyRelation` widens every alias in the
graph.** Every relation factory returns a typed relation carrying its
meta-edge name and endpoint kinds, which is what lets the alias type tell
"this relation does not touch my kind" from "this relation was never typed".
Storing one in a variable annotated `OntologyRelation` (or the whole array in
a `readonly OntologyRelation[]`) erases those literals, and the alias type
then widens every kind in the graph conservatively rather than risk typing a
polymorphic alias as exact. Let the relation types be inferred, or annotate
with `typeof` the factory call, if you want the narrow types back.

**An endpoint declared as a union of kinds widens every kind the union can
hold.** A helper that declares a subclass of either media root —
`(root: typeof Audio | typeof Video) => subClassOf(Episode, root)`, or the
same helper annotated `NodeType<"Audio" | "Video">` — keeps its meta-edge name
and its endpoint kind literals, so nothing is erased, but its declared type no
longer says which root the call passed. Both `Audio` and `Video` therefore get
the polymorphic alias type, while a kind the union cannot hold stays exact.
Pass the root directly (`subClassOf(Episode, Audio)`) if you want only the
root you named to widen.

**Limitation — `evolve()`-declared subsumption isn't visible to the alias
type.** The `kind`/`NodeId` widening above is computed from your
compile-time graph definition. A `subClassOf` an [extension](/graph-extensions)
adds at `store.evolve(...)` time changes what the LIVE registry accepts and
returns, but `evolve()` still returns `Store<G>` with the same compile-time
`G` — so `from("Media", "m")` keeps typing `m` as exact `Media` even though a
row may now come back as the extension's `Podcast` subclass. Passing that
row's `id` to `store.nodes.Media.update(...)` would then typecheck and
silently match nothing. Use `fromDynamic()` (always polymorphically typed) or
`{ expansion: "exact" }` for a kind a runtime extension subclasses.

Pass `{ expansion: "exact" }` to narrow one alias back to the exact
kind, or set `queryDefaults.expansion: "exact"` on `createStore(...)` to
restore the exact-kind behavior everywhere. `search()` and the collection
APIs (`find`, `count`, `updateWhere`, `compareAndSet`) are unaffected by this
default and stay exact-kind.

### `expansion: "narrower"` — kind-level taxonomies

`broader`/`narrower` model a hierarchy that is **not** a subtype relationship
— no schema contract is claimed, so the alias type stays untyped (`NodeAlias`,
no static property access). Use it for a small, fixed vocabulary known at
schema-authoring time; for a vocabulary that grows at runtime, prefer an
instance-level concept kind with a `broader` **edge** traversed
with `.recursive()` (see [Ontology](/ontology)).

```typescript
// ontology: [broader(Podcast, Media), broader(Video, Media)]
const rows = await store
  .query()
  .from("Media", "m", { expansion: "narrower" })
  .select((ctx) => ctx.m)
  .execute();
```

One alias carries exactly one axis, because `expansion` is one option with
one value — a contradiction like "subclasses and narrower" is not
expressible. An expansion naming a kind that is not registered, or (on
`to()`/`toDynamic()`) that the traversed edge does not admit as an endpoint,
is refused rather than silently narrowed; so is an `expansion` value outside
the three axes (`QUERY_ALIAS_EXPANSION_INVALID`), which only a JavaScript
caller can reach.

Omitting `options` entirely, passing `{}`, or passing an explicit `undefined`
all mean the same thing — take the store default — so an options bag can be
forwarded through your own helper without special-casing the empty case. A bag
whose `expansion` is not one literal — `{ expansion?: "exact" }` from a
wrapper that only ever narrows, say — forwards too; since the axis is not
known at compile time, that alias is typed conservatively (untyped, the same
way `"narrower"` is). State a literal axis at the call site to keep the
precise alias type.

## Runtime-declared kinds

`from()` requires `kind` to be a compile-time literal in your graph
definition. For kinds added at runtime via [graph
extensions](/graph-extensions), use `fromDynamic()`:

```typescript
// "Paper" was added by store.evolve(extension), so it isn't in the
// compile-time graph type. fromDynamic accepts arbitrary string kinds.
const recent = await store
  .query()
  .fromDynamic("Paper", "p")
  .whereNode("p", (p) => p.field("year").number().gte(2020))
  .select((ctx) => ctx.p)
  .execute();
```

The kind is validated against the registry — typos throw
`KindNotFoundError` instead of silently producing an empty query.
The alias's predicate accessor is `DynamicNodeAccessor`, which exposes
schema properties through a `.field(name)` discriminator —
`.field("year").number().gte(2020)` for type-narrow predicates,
`.field("year").eq(...)` directly for `BaseFieldAccessor` methods. See
[Traverse ▸ The `.field()`
discriminator](/queries/traverse#the-field-discriminator) for the full
surface.

`fromDynamic` mixes freely with typed `traverse` / `to` and the dynamic
siblings. See [graph extensions ▸ Querying extension
kinds](/graph-extensions#querying-extension-kinds) for the full story.

Passing Store-issued runtime-kind evidence instead of a string narrows the
alias to the graph-extension definition, so ordinary typed property access is
available. String inputs retain the discriminator-based dynamic surface.

## Return Type

`from()` returns a `QueryBuilder` that provides access to all query methods:

- [Filter](/queries/filter) - `whereNode()`, `whereEdge()`
- [Traverse](/queries/traverse) - `traverse()`, `optionalTraverse()`
- [Recursive](/queries/recursive) - `.recursive()`, and the composition
  shortcuts [`parts()` /
  `wholes()`](/queries/recursive#composition-shortcuts-parts-and-wholes)
- [Shape](/queries/shape) - `select()`, `aggregate()`
- [Order](/queries/order) - `orderBy()`, `limit()`, `offset()`
- [Aggregate](/queries/aggregate) - `groupBy()`, `groupByNode()`
- [Temporal](/queries/temporal) - `temporal()`
- [Compose](/queries/compose) - `pipe()`

## Next Steps

- [Filter](/queries/filter) - Reduce results with `whereNode()`
- [Traverse](/queries/traverse) - Navigate to related nodes
- [Shape](/queries/shape) - Define output with `select()`
