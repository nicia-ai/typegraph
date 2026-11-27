---
title: Schemas & Types
description: Defining nodes, edges, and leveraging TypeScript inference
---

TypeGraph's power comes from its type system. Define your schema once with Zod, and get:

- **Runtime validation** on every create and update
- **TypeScript types** inferred automatically (no duplication)
- **Query builder constraints** that prevent invalid queries at compile time

## Contents

- [Nodes](#nodes) — Entities with properties and metadata
  - [Defining Node Types](#defining-node-types)
  - [Schema Features](#schema-features)
  - [Node Operations](#node-operations)
- [Edges](#edges) — Relationships between nodes
  - [Defining Edge Types](#defining-edge-types) (domain/range constraints)
  - [Edge Constraints](#edge-constraints) (cardinality, acyclicity)
  - [Edge Operations](#edge-operations)
- [Graph Definition](#graph-definition) — Combining nodes, edges, and ontology
- [Delete Behaviors](#delete-behaviors) — Restrict, cascade, disconnect
- [Uniqueness Constraints](#uniqueness-constraints) — Enforcing unique values
- [Type Inference](#type-inference) — Extracting TypeScript types from schemas

## Nodes

Nodes represent entities in your graph. Each node has:

- **Type**: The type of node (e.g., "Person", "Company")
- **ID**: A unique identifier within the graph
- **Props**: Properties defined by a Zod schema
- **Metadata**: Version, timestamps, and soft-delete state

### Defining Node Types

```typescript
import { z } from "zod";
import { defineNode } from "@nicia-ai/typegraph";

const Person = defineNode("Person", {
  schema: z.object({
    fullName: z.string().min(1),
    email: z.string().email().optional(),
    dateOfBirth: z.string().optional(),
    tags: z.array(z.string()).default([]),
  }),
  description: "A person in the system", // Optional
});
```

### Schema Features

A property schema can use any Zod validation feature, with one requirement
on transforms (below):

```typescript
const Product = defineNode("Product", {
  schema: z.object({
    // Required string
    name: z.string().min(1).max(200),

    // Optional with default
    status: z.enum(["draft", "active", "archived"]).default("draft"),

    // Number with constraints
    price: z.number().positive(),

    // Array with items validation
    categories: z.array(z.string()).min(1),

    // Regex pattern
    sku: z.string().regex(/^[A-Z]{2,4}-\d{4,8}$/),

    // Nullable field
    description: z.string().nullable(),

    // Transform on validation
    slug: z.string().transform((s) => s.toLowerCase().replace(/\s+/g, "-")),
  }),
});
```

#### Transforms must be idempotent

TypeGraph stores a schema's parsed output, and an `update()` parses the
merged stored properties through the schema again. A `.transform()` therefore
runs again on every update, on the value it produced last time. A transform
is safe when its output is valid input that parses to itself, as `slug` above
is: slugging an already-slugged value changes nothing.

Two kinds of transform are not safe:

- **One that is not idempotent is applied again.** With
  `z.string().transform((v) => v + "!")`, a create stores `"x!"`, and an
  `update()` that does not touch the field stores `"x!!"`.
- **One that changes the type makes every later update throw.** With
  `z.string().transform((v) => v.length)`, a create stores a number, and the
  next `update()` is refused with a `ValidationError`, even one that does not
  touch the field, because the stored number is not a string.

This holds for node and edge properties, and for every write that updates a
stored row: an edge `update()` that only states `validTo`, and a `reparent`
that ends a `oneActive` incumbent's window, re-parse the stored properties too.
Keep a value that must change type in its input form and derive the other form
when you read it. Planning a [graph merge](/graph-merge) from staged
operations already refuses a schema whose output does not survive a second
parse.

#### Date properties

Properties are stored as JSON, so a `z.date()` property's `Date` is stored as
its canonical ISO-8601 text (`2024-01-01T00:00:00.000Z`). Every read turns
that text back into a `Date` wherever the property's schema output is a
`Date`: a `z.date()`, a `z.coerce.date()`, or a pipe that ends in one
(`z.string().pipe(z.coerce.date())`), inside `.optional()`, `.nullable()`,
`.default()` and similar wrappers, a nested `z.object()`, a `z.array()` or a
`z.record()`. That covers collection reads and the nodes and edges a write
returns, query rows and selected fields, `.project()` and aggregates,
`first()`, `paginate()` and `stream()`, traversals, `subgraph()`,
`neighbors()`, search hits, `asOf()` and `asOfRecorded()` views, reads inside
a transaction, and the nodes a [graph merge](/graph-merge) hands to `block()`
and a `custom` similarity `score()`.

The stored form does not change. `JSON.stringify` of a read, an export
document, a pagination cursor and a graph-merge plan hold the same text as
before. A read runs no part of the schema: it applies no parse, transform or
refinement. So these still read as stored:

- A `z.string()` or `z.iso.datetime()`, whose output is a string.
- A union with a date member (`z.union([z.date(), z.string()])`), a tuple, and
  a `.transform()`, even one that returns a `Date`. Declare
  `z.string().pipe(z.coerce.date())` rather than
  `z.string().transform((text) => new Date(text))` when you want a `Date`.
- Stored text that is not the canonical form the store writes (years 0001 to
  9999, UTC, milliseconds), for example text an older schema or raw SQL
  wrote. A read returns it exactly as stored and never an `Invalid Date`, and
  `validateStore()` reports it. On PostgreSQL, a selected field, a
  `.project()` scalar, `$scalar()`, `min`/`max`, a `groupBy()` date key and
  the elements of `expr.collect()` extract the date with a `timestamptz` cast,
  so there text the engine can cast comes back as the `Date` the cast reads
  (see the [parity matrix](/backend-setup#sqlite--postgresql-parity)).

A date you state in a query rather than store, an `expr.literal()` or
`expr.param()` date, comes back from `.project()`, `$scalar()`, a relation
column or `expr.collect()` as the `Date` you stated, including one outside the
years 0001 to 9999. So does a `coalesce()` or `when()` whose every branch is
such a date. A composition that may yield a stored date is decoded as stored
text. Every date a query returns is the same value on SQLite and PostgreSQL
whatever the PostgreSQL session `TimeZone` is: `expr.collect()` elements and
the date columns of a `batchOnce()` payload are emitted as canonical UTC text
on both.

A write that parses stored properties again first turns that stored text back
into a `Date`, so an update that does not touch a date property leaves it as
it was. This covers `update()`, `upsertById()`, `getOrCreateByConstraint()` and
`getOrCreateByEndpoints()` with `ifExists: "update"`, their bulk forms,
`updateWhere()`, `compareAndSet()`, an edge `update()` that only states
`validTo`, and `validateStore()`, which does not report a stored date as a
violation. Text is turned back into a `Date` only where the schema accepts
nothing but a `Date` — a `z.date()`, possibly inside `.optional()`,
`.nullable()`, `.default()`, `.catch()` and similar wrappers, a nested
`z.object()` or a `z.array()` — and only when it is exactly the text the store
writes. A date under a union, a record, a tuple, a `.transform()`, or an
`.overwrite()` on the date itself or on an object or array holding it, is
parsed as stored. An `.overwrite()` on a wrapper around the date
(`z.date().optional().overwrite(…)`) runs on the revived `Date`, so one that
changes its input changes the stored date on every update of another property,
and on an import or merge of the row; this is a known limitation of
re-validating the whole row. A value you pass
yourself is never converted: state a date property as a `Date`.
The `getOrCreate…` forms parse the properties you state as a create first, so a
property you omit that declares a `.default()` or `.catch()` takes that value
rather than the stored one.

Every write stores a `Date` you state the same way: as the ISO text of the
instant it holds, read from the `Date` itself, never from a `toJSON()` or
`toISOString()` the object carries (an own property or a subclass), so a
`Date` cannot be stored, matched or compared as an instant other than its
own. This holds for every node and edge write on the built-in backends, a
uniqueness constraint, an endpoint match, `importGraph()` and
`trustedImportGraph()` of an in-memory document, a `compareAndSet()`
expectation, an index lookup, and a predicate or parameter compared with a
date. `updateWhere()` and `compareAndSet()` accept a `Date` in their `patch`,
at any depth of a nested object or array, and store the same text `create()`
and `update()` store. They refuse a `Date` at a position where parsing the
row again would not turn that text back into a `Date`, such as under a union,
a record or `z.any()`, with a `ValidationError`, since the row would then hold
a string where you wrote a `Date`. A `compareAndSet()` `expected` value may be a
`Date`; it matches when the stored text is that `Date`'s ISO text. It is a
comparison, not a write, so it is not parsed through the property's schema: a
transform or `.overwrite()` there does not change the instant it compares.
`importGraph()` reads the stored text an export wrote back as a `Date` by the
same rule as the updates above
([Date properties in interchange](/interchange#date-properties)), and so does
a [graph merge](/graph-merge), whose plans carry each row's properties in their
stored form: `applyMergePlan()`, `merge()`, candidate write sets and mutation
plans all apply a dated write.

Reads and these writes still disagree about two shapes. A `z.record()` of
dates reads back as `Date`s, and a `z.date().transform(…)` reads back as the
transform's output, but a write that parses the stored row again turns neither
back into its input: an `update()` of another property of such a kind, and a
graph-merge `branch()` of a store holding one, fail with a validation error.
Keep such a property on a kind you do not update, or declare a nested
`z.object()` or a pipe (`z.string().pipe(z.coerce.date())`) instead.

### Node Operations

```typescript
// Create with auto-generated ID
const bob = await store.nodes.Person.create({ fullName: "Bob Jones" });

// Create with specific ID
const alice = await store.nodes.Person.create({ fullName: "Alice Smith" }, { id: "person-alice" });

// Retrieve. Ids are typed `NodeId<typeof Person>`; use the id a node carries,
// or brand a string you hold with `asNodeId`.
const person = await store.nodes.Person.getById(alice.id);
const same = await store.nodes.Person.getById(asNodeId<typeof Person>("person-alice"));

// Update (partial)
const updated = await store.nodes.Person.update(alice.id, {
  email: "alice@example.com",
});

// Delete (soft delete by default)
await store.nodes.Person.delete(alice.id);

// Hard delete: removes the row and what is derived from it (see below)
await store.nodes.Person.hardDelete(bob.id);
```

### Node Object Shape

A node returned from the store has this structure:

```typescript
const alice = await store.nodes.Person.create({ name: "Alice", email: "a@example.com" });

// alice = {
//   id: "01HX...",          // Generated ULID (or your custom ID)
//   kind: "Person",         // The node type name
//   name: "Alice",          // Schema property (flattened to top level)
//   email: "a@example.com", // Schema property
//   meta: {
//     version: 1,
//     createdAt: "2024-01-15T10:30:00.000Z",
//     updatedAt: "2024-01-15T10:30:00.000Z",
//     deletedAt: undefined,
//     validFrom: "2024-01-15T10:30:00.000Z", // defaults to createdAt when omitted,
//                                            // unless a stated past validTo makes
//                                            // the row "born already ended" (undefined)
//     validTo: undefined,
//   }
// }
```

Schema properties are flattened to the top level for ergonomic access (`alice.name` instead of
`alice.props.name`). System metadata lives under `meta`.

### Soft Delete vs Hard Delete

By default, `delete()` performs a **soft delete**—it sets the `deletedAt` timestamp but preserves the record:

```typescript
await store.nodes.Person.delete(alice.id); // Sets deletedAt, keeps the record
```

`hardDelete()` removes the node's row instead, together with what the store derives from it:

```typescript
await store.nodes.Person.hardDelete(alice.id); // Removes the live row and its derived rows
```

**When to use each:**

| Method | Use Case |
|--------|----------|
| `delete()` | Standard deletions, audit trails, undo capability |
| `hardDelete()` | Storage cleanup, removing test data, freeing a unique key |

A soft delete keeps the node's row and its properties, readable with
`store.view({ mode: "includeTombstones" })`; it removes the node's fulltext and embedding rows, ends
its Operational Identity assertions, and applies the kind's `onDelete` behavior to its edges (with
`cascade`, they are soft-deleted and stay readable the same way).
`hardDelete()` cannot be undone through the store, but it is **not an erasure**: what it leaves
depends on how the store was opened.

| Store | `hardDelete()` removes | Kept after `hardDelete()` |
|-------|------------------------|---------------------------|
| Every store | The node's row (live or soft-deleted), every incident edge, its uniqueness, fulltext and embedding rows, and the Operational Identity assertions and closure rows that name it | A branch or working copy forked before the delete keeps its own copy. Values the application already read, exported or archived are outside the store. |
| `revisionTracking: true` | The same | The revision journal keeps the node's kind and ID, without property values |
| `history: true` | The same | Every recorded version of the node and of its incident edges, with their properties: `asOfRecorded(T)` at an instant before the delete still returns them. The recorded identity assertions, and the identity transition log entries that name the node (`identity.transitionsOf`), also remain. |

`bulkHardDelete()` leaves the same state as calling `hardDelete()` once per ID. On PostgreSQL the
revision journal is kept by database triggers once it is installed, so it can hold the ID
for a store that does not track revisions. No operation removes recorded versions of a single node;
[#922](https://github.com/nicia-ai/typegraph/issues/922) tracks an erasure operation that reaches
recorded history and every derived copy. See [Limitations](/limitations#deleting-is-not-erasure) for
what a caller can do today.

## Edges

Edges represent relationships between nodes. Each edge has:

- **Type**: The type of relationship (e.g., "worksAt", "knows")
- **ID**: A unique identifier
- **From**: Source node (type + ID)
- **To**: Target node (type + ID)
- **Props**: Properties defined by a Zod schema

### Defining Edge Types

```typescript
import { defineEdge } from "@nicia-ai/typegraph";

// Edge with properties
const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startDate: z.string().optional(),
    isPrimary: z.boolean().default(true),
  }),
});

// Edge without properties
const knows = defineEdge("knows");
// Equivalent to: defineEdge("knows", { schema: z.object({}) })
```

#### Unconstrained Edges

Edges defined without `from` and `to` are **unconstrained** — they can connect any
node type to any node type. When used directly in `defineGraph`, they are automatically
allowed for all node types in the graph:

```typescript
const sameAs = defineEdge("sameAs");
const related = defineEdge("related", {
  schema: z.object({ reason: z.string() }),
});

const graph = defineGraph({
  id: "my_graph",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    sameAs,     // any→any (Person↔Person, Person↔Company, Company↔Company)
    related,    // any→any, with properties
    worksAt: { type: worksAt, from: [Person], to: [Company] },  // constrained
  },
});

// All of these work:
await store.edges.sameAs.create(alice, bob, {});       // Person→Person
await store.edges.sameAs.create(alice, acme, {});      // Person→Company
await store.edges.sameAs.create(acme, alice, {});      // Company→Person
```

This is useful for semantic relationships like `sameAs`, `seeAlso`, `related`, or
`tagged` that apply broadly across node types.

#### Domain and Range Constraints

Edges can include built-in domain (source types) and range (target types) constraints
directly in their definition. This makes edge definitions self-contained and reusable:

```typescript
// Edge with built-in domain/range constraints
const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startDate: z.string().optional(),
  }),
  from: [Person],      // Domain: only Person can be the source
  to: [Company],       // Range: only Company can be the target
});

// Edge connecting multiple types
const mentions = defineEdge("mentions", {
  from: [Article, Comment],
  to: [Person, Company, Topic],
});
```

Any edge type can be used directly in `defineGraph` without an `EdgeRegistration`
wrapper. Constrained edges use their built-in `from`/`to`; unconstrained edges
allow all node types:

```typescript
const graph = defineGraph({
  id: "my_graph",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {
    worksAt,  // Constrained - uses built-in from/to
    sameAs,   // Unconstrained - connects any node to any node
  },
});
```

You can still use `EdgeRegistration` to narrow (but not widen) the constraints:

```typescript
const worksAt = defineEdge("worksAt", {
  from: [Person],
  to: [Company, Subsidiary],  // Allows both Company and Subsidiary
});

const graph = defineGraph({
  edges: {
    // Narrow to only Subsidiary targets in this graph
    worksAt: { type: worksAt, from: [Person], to: [Subsidiary] },
  },
});
```

An edge whose `from` or `to` names a node kind that is not registered in `nodes`
also throws a `ConfigurationError` at `defineGraph` time
(`details.code: "EDGE_ENDPOINT_KIND_NOT_REGISTERED"`), as does an unknown
`cardinality`, `targetCardinality` or `acyclic` value from untyped code
(`EDGE_INTEGRITY_OPTION_INVALID`).

Attempting to widen beyond the edge's built-in constraints throws a `ConfigurationError`:

```typescript
const worksAt = defineEdge("worksAt", {
  from: [Person],
  to: [Company],
});

// This throws ConfigurationError - OtherEntity is not in the edge's range
defineGraph({
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [OtherEntity] },
  },
});
```

#### Source-Dependent Targets

An array-valued `to` allows every combination of the source and target types.
When the valid target depends on the source, use a map instead:

```typescript
const Employee = defineNode("Employee", { schema: z.object({ name: z.string() }) });
const Student = defineNode("Student", { schema: z.object({ name: z.string() }) });
const Department = defineNode("Department", { schema: z.object({ name: z.string() }) });
const Course = defineNode("Course", { schema: z.object({ name: z.string() }) });

const assignedTo = defineEdge("assignedTo", {
  from: [Employee, Student],
  to: {
    Employee: [Department],
    Student: [Course],
  },
});

const graph = defineGraph({
  id: "assignments",
  nodes: {
    Employee: { type: Employee },
    Student: { type: Student },
    Department: { type: Department },
    Course: { type: Course },
  },
  edges: { assignedTo },
});
```

This permits `Employee → Department` and `Student → Course`. It rejects
`Employee → Course` and `Student → Department`. Using
`to: [Department, Course]` would permit all four combinations.

Map keys are the literal node kind names (`Employee.kind`), not aliases used to
register nodes in a graph. Every kind in `from` must have a map entry, no other
keys are allowed, and each target array must be nonempty. You can also use
computed keys such as `[Employee.kind]: [Department]`.

The map syntax works in an explicit graph registration too:

```typescript
edges: {
  assignedTo: {
    type: assignedTo,
    from: [Employee],
    to: { Employee: [Department] },
  },
}
```

A registration may narrow the built-in allowed pairs, but it cannot introduce
new pairs. Replacing a map with arrays is valid only when every resulting
combination is already allowed by the edge definition.

At runtime, both endpoints must match the **same** declared pair, including
`subClassOf` assignability. A source matching several source entries can use the
targets allowed by any of those entries. An undeclared pair fails with
[`EndpointPairError`](/errors#endpointpairerror); an invalid source kind still
fails with `EndpointError`. Malformed declarations fail with `ConfigurationError`.

Typed collection writes preserve the source/target relationship; dynamic writes
and imports enforce it at runtime. Bulk writes reject invalid pairs atomically.
Import pair validation remains active even when reference validation is disabled;
imports retain their own documented error-handling and partial-success behavior.
See [collection types](/types#typededgecollectionr-g) for inference limits,
[graph extensions](/graph-extensions#edges) for runtime declarations, and
[schema management](/schema-management#endpoint-pair-changes) for schema changes.

### Edge Constraints

#### Cardinality

Control how many edges can exist:

```typescript
const graph = defineGraph({
  edges: {
    // Default: no limit
    knows: { type: knows, from: [Person], to: [Person], cardinality: "many" },

    // At most one edge of this type from any source node
    currentEmployer: {
      type: currentEmployer,
      from: [Person],
      to: [Company],
      cardinality: "one",
    },

    // At most one edge between any (source, target) pair
    rated: { type: rated, from: [Person], to: [Product], cardinality: "unique" },

    // At most one active edge (valid_to IS NULL) from any source
    currentRole: {
      type: currentRole,
      from: [Person],
      to: [Company],
      cardinality: "oneActive",
    },
  },
});
```

| Cardinality | Description |
|-------------|-------------|
| `"many"` | No limit (default) |
| `"one"` | At most one edge of this type from any source node |
| `"unique"` | At most one edge between any (source, target) pair |
| `"oneActive"` | At most one edge with `valid_to IS NULL` from any source |

#### Enforcement Timing

Cardinality constraints are checked at edge **creation time**, before the insert:

```typescript
// With cardinality: "one" on currentEmployer:
await store.edges.currentEmployer.create(alice, acme, {});  // OK
await store.edges.currentEmployer.create(alice, other, {}); // Throws CardinalityError
```

The check queries existing edges and throws `CardinalityError` if violated.
For `oneActive`, only edges with `validTo` unset count toward the limit.

#### Target cardinality

`targetCardinality` bounds the edges that point **at** one target node,
independently of `cardinality`, which bounds the edges leaving one source:

```typescript
const graph = defineGraph({
  edges: {
    // Many-to-one ownership: a source may point at many targets, but each
    // target may be pointed at by at most one live edge.
    assignedTo: {
      type: assignedTo,
      from: [Person],
      to: [Ticket],
      targetCardinality: "one",
    },

    // At most one ACTIVE edge (valid_to IS NULL) into any target.
    currentOwner: {
      type: currentOwner,
      from: [Person],
      to: [Asset],
      targetCardinality: "oneActive",
    },
  },
});
```

| Target cardinality | Description |
|---------------------|-------------|
| `"many"` | No limit (default) |
| `"one"` | At most one edge of this type into any target node |
| `"oneActive"` | At most one edge with `valid_to IS NULL` into any target |

There is no `"unique"` target cardinality: pair uniqueness is a property of
the `(source, target)` pair, and `cardinality: "unique"` already declares it
from the source side — a second pair declaration on the target side would be
the same axis stated twice.

`cardinality` and `targetCardinality` compose freely. All twelve
combinations are accepted; one is *redundant* (`unique` already implies the
pair bound that `targetCardinality: "one"` would separately declare) and is
still honored, because refusing an author's explicit, true statement would be
surprising:

| `cardinality` \ `targetCardinality` | `many` (default) | `one` | `oneActive` |
| --- | --- | --- | --- |
| `many` (default) | unconstrained multigraph | many-to-one: a target has at most one incoming edge ever | many-to-one over open-ended edges only |
| `one` | one outgoing per source (as above) | strict 1:1 over the live population | 1:1 where the target bound counts open-ended edges only |
| `unique` | at most one edge per `(from, to)` pair (as above) | *redundant*: target `"one"` already implies pair uniqueness | pair uniqueness plus an active-only target bound |
| `oneActive` | one open-ended outgoing per source (as above) | one open-ended out, at most one incoming ever | strict 1:1 over the open-ended population |

Both axes are limits on **edge count**, not on distinct neighbours: a second
distinct edge from the same source to an already-`targetCardinality: "one"`
target is refused exactly like a second edge from a different source would
be. The reservation is scoped to `(graph, edge kind, target kind, target
id)` — the source kind is deliberately not part of the key, so two different
source kinds contend for one target allowance, and two nodes with the same
id under different target kinds or edge kinds never collide.

The temporal rules mirror the source-side ones, read from the target end:
`"one"` counts every non-deleted edge at the target (including edges with a
stated validity end); `"oneActive"` counts only those whose `validTo` is
unset. Soft-deleting an edge frees the slot it held on both axes; ending an
edge (setting `validTo`) frees only an active-only (`"oneActive"`) slot,
never a `"one"` slot; a resurrection or a reopened validity window
reacquires every applicable reservation, on both axes.

`CardinalityErrorDetails` names which endpoint's population was overrun via
`direction: "source" | "target"`, alongside `toKind` / `toId` for the target
endpoint (`fromKind` / `fromId` keep their existing meaning).

#### Acyclicity

Declaring `acyclic: true` makes an edge kind's live relation a DAG (directed
acyclic graph): no write can create a path from an edge's `to` endpoint back
to its `from` endpoint, and a self-loop is a cycle of length one.

```typescript
const graph = defineGraph({
  edges: {
    dependsOn: {
      type: dependsOn,
      from: [Task],
      to: [Task],
      cardinality: "many",
      acyclic: true,
    },
  },
});

await store.edges.dependsOn.create(a, b, {}); // OK
await store.edges.dependsOn.create(b, c, {}); // OK
await store.edges.dependsOn.create(c, a, {}); // Throws EdgeAcyclicityError
```

`acyclic` is orthogonal to `cardinality`: `cardinality: "many", acyclic: true`
(a dependency graph, where any number of edges may point at or from a task) is
the common case. Every write path that can put an edge into the relation
enforces it: `create`, `bulkCreate`, `getOrCreateByEndpoints`, resurrecting a
soft-deleted edge, validating import, and merge apply after canonicalization.

A refusal's `details.witness` identifies one return path, including the node
references and stored or proposed edge ids a caller can show for repair. It
reports at most 64 edges with a `truncated` flag. This diagnostic runs only on
refused writes; see [EdgeAcyclicityError](/errors#edgeacyclicityerror).

**Population.** Every non-deleted edge counts, regardless of its validity
window. Soft-deleting an edge frees the relation — `a -> b` then `b -> a` is
accepted once the first edge is deleted. Ending an edge's validity window does
**not** free it: `a -> b` with its window closed still blocks `b -> a`. This
is the one place the two temporal axes disagree: acyclicity is a claim about
the relation's *shape*, not about an instant, so a future-dated edge could
otherwise close a cycle no write ever probed.

**The check is exhaustive**, not a bounded traversal: it is a set-semantics
recursive reachability query with no depth bound, so a cycle of any length is
found — the query builder's `MAX_EXPLICIT_RECURSIVE_DEPTH` does not apply
here. An engine that cuts the search short (a statement timeout, a resource
limit) raises `EdgeAcyclicityIndeterminateError` rather than reporting "no
cycle".

**Concurrency.** The check and the write it guards commit under the same
per-graph write fence edge cardinality uses, so two concurrent writers of
`a -> b` and `b -> a` serialize and exactly one commits. A backend with no
transactions refuses the write (`CONSTRAINT_WRITE_FENCE_UNSUPPORTED`) rather
than enforcing the rule only when nothing races.

On PostgreSQL the check reads the relation after taking the fence, so the
session must see what committed while it waited. A `READ COMMITTED` session
does: every statement takes a new snapshot. A `REPEATABLE READ` or
`SERIALIZABLE` session keeps the snapshot of its first statement however long
it then waits, and PostgreSQL arbitrates `SERIALIZABLE` transactions only
against each other, so a lock alone would let such a session and a
`READ COMMITTED` writer close a cycle between them. A write that checks an
acyclic relation therefore also advances the graph's row in
`typegraph_fences` behind the lock, at every isolation level: a session whose
snapshot predates another such writer's commit fails on that row with a
serialization failure (SQLSTATE `40001`) instead of checking a relation it can
no longer see. The guarantee above holds at every isolation level, and between
writers at different levels.

Who retries depends on who owns the transaction. A collection write, an import
or a merge commit that TypeGraph opened the transaction for is replayed whole,
in a new transaction, and then sees the winner. Inside
`store.transaction(...)` or an adopted transaction, the failure surfaces as
`TransactionConflictError`; re-run the whole transaction, or pass
`store.transaction(fn, { retry: { attempts } })`.

Only the writes that make such a decision touch that row: a write into an
acyclic or composition relation, a delete of a composition whole, and a
match-key convergence. Every other write, on any graph, leaves it alone, so a
graph that declares neither kind of relation and never converges on a match
key never writes it. Where it is written it is one row per graph and behaves
like any hot row under MVCC: see
[Write Fence Row](/limitations#write-fence-row) for how a long-lived snapshot
affects it.

A custom backend whose write fence is an advisory lock with no fences relation
(`tableNames.fences`) cannot detect a stale snapshot. There a
`REPEATABLE READ` or `SERIALIZABLE` write is refused with `ConfigurationError`
(`EDGE_ACYCLICITY_REQUIRES_FRESH_SNAPSHOT`) in every frame of the transaction,
batches and concurrent sibling writes included; `READ COMMITTED` is the level
it supports.

Use `store.verifyConstraintFences()` to find edges already on a cycle (the
`edgeAcyclicity` family), and see [Errors](/errors) for
`EdgeAcyclicityError` / `EdgeAcyclicityIndeterminateError` and
[Limitations](/limitations) for what a transactionless backend and a fused
write program cannot do with an acyclic edge kind.

Cardinality and target cardinality constrain one edge kind's own population;
they say nothing about what happens to the nodes on either end when the
relation is a real whole/part relationship. That's a separate declaration,
[**composition**](/ontology#composition) (`partOf` / `hasPart`): it names
which edge kind *realizes* containment and requires that edge to declare
`cardinality`/`targetCardinality: "one"` or `"oneActive"` on the whole side.
Ownership (one whole per part, enforced cross-relation) and cascade (deleting
a whole deletes its parts) are the guarantees this declaration is *for*, and
both are enforced — see the
[containment tiers](/ontology#choosing-a-containment-tier) table for the
complete list.

### Edge Operations

```typescript
// Create edge - pass nodes directly
const edge = await store.edges.worksAt.create(alice, acme, { role: "Engineer" });

// Retrieve edge
const e = await store.edges.worksAt.getById(edge.id);

// Delete edge
await store.edges.worksAt.delete(edge.id);
```

## Graph Definition

The graph definition combines all components:

```typescript
import { defineGraph } from "@nicia-ai/typegraph";

const graph = defineGraph({
  // Unique identifier for this graph
  id: "my_application",

  // Node registrations
  nodes: {
    Person: {
      type: Person,
      onDelete: "restrict", // Default behavior
    },
    Company: {
      type: Company,
      onDelete: "cascade",
    },
    Employment: {
      type: Employment,
      onDelete: "disconnect",
    },
  },

  // Edge registrations
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
    employedAt: {
      type: employedAt,
      from: [Company],
      to: [Employment],
      cardinality: "many",
    },
  },

  // Semantic relationships
  ontology: [subClassOf(Company, Organization), disjointWith(Person, Company)],
});
```

`subClassOf(Company, Organization)` here requires `Company`'s schema to
structurally extend `Organization`'s — checked at compile time and at
registry build (see [Ontology](/ontology#subsumption-type-inheritance)).
Because of that guarantee, querying `Organization` returns `Company` rows
by default: `store.query().from("Organization", "o")` is polymorphic, with
`o`'s `kind` widened to `string` and only `Organization`'s own properties
statically typed on the alias. Pass `{ expansion: "exact" }` to get
back the exact-kind reading.

## Delete Behaviors

Control what happens when nodes are deleted:

### Restrict (Default)

Blocks deletion if any edges are connected:

```typescript
nodes: {
  Author: { type: Author }, // onDelete defaults to "restrict"
}

// This throws RestrictedDeleteError if Author has edges
await store.nodes.Author.delete(authorId);
```

### Cascade

Automatically deletes all connected edges:

```typescript
nodes: {
  Book: { type: Book, onDelete: "cascade" },
}

// Deletes the book and all edges connected to it
await store.nodes.Book.delete(bookId);
```

### Disconnect

Soft-deletes edges (preserves history):

```typescript
nodes: {
  Review: { type: Review, onDelete: "disconnect" },
}

// Marks connected edges as deleted (deleted_at is set)
await store.nodes.Review.delete(reviewId);
```

### Deletes and concurrent edge writes

A delete behavior applies to every edge that exists when the delete commits,
including one another writer creates while the delete runs: the edge write and
the delete wait for each other, so the edge write is refused with
`EndpointNotFoundError` or the delete sees the edge and removes or refuses it.
Creating or resurrecting an edge always requires both endpoints to be live.
On PostgreSQL this holds for deletes at the default READ COMMITTED isolation;
see [Limitations](/limitations#concurrent-endpoint-deletes-above-read-committed-postgresql)
for a delete at REPEATABLE READ or SERIALIZABLE.

## Uniqueness Constraints

Ensure unique values within node types:

```typescript
const graph = defineGraph({
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "person_email",
          fields: ["email"],
          where: (props) => props.email.isNotNull(),
          scope: "kind",
          collation: "caseInsensitive",
        },
      ],
    },
    Company: {
      type: Company,
      unique: [
        {
          name: "company_ticker",
          fields: ["ticker"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
});
```

### Scope Options

- `"kind"`: The constraint keys the rows of the kind that declares it.
- `"kindWithSubClasses"`: The constraint keys the rows of every kind in the
  declaring kind's `subClassOf` hierarchy (its ancestors, descendants and
  siblings) in one shared key space, so a value taken by a row of one kind is
  refused for a row of another.

A constraint is enforced on the writes of the kind that declares it; a subclass
does not inherit it. A constraint declared only on a parent kind therefore does
not cover rows written as a subclass, whichever scope it has. To get uniqueness
across a hierarchy, declare the constraint on every kind in it with the same
`name`, `fields` and `collation` and `scope: "kindWithSubClasses"`:
each kind's writes then claim the same key and probe the others' rows. Declared
with `scope: "kind"`, the same constraint on each kind is uniqueness per kind.

TypeScript requires both `scope` and `collation`. An untyped caller that omits
`scope` gets `"kindWithSubClasses"`, and one that omits `collation` gets
`"binary"`. A [graph extension](/graph-extensions) that omits `scope` gets
`"kind"`. A `scope` or `collation` outside the values listed here is refused at
`defineGraph` with `ConfigurationError` (`UNIQUE_CONSTRAINT_OPTION_INVALID`).

### Collation Options

- `"binary"`: Case-sensitive comparison
- `"caseInsensitive"`: Case-insensitive comparison

## Type Inference

TypeGraph infers TypeScript types from Zod schemas—you never duplicate type definitions.

### Extracting Types from Definitions

```typescript
import { z } from "zod";
import { defineNode, type Node, type NodeProps, type NodeId } from "@nicia-ai/typegraph";

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().email().optional(),
    age: z.number().optional(),
  }),
});

// For functions that work with full nodes (id, kind, metadata, props):
type PersonNode = Node<typeof Person>;
// { id: NodeId<Person>; kind: "Person"; name: string; email?: string; meta: NodeMeta }

// For functions that only need the property data:
type PersonProps = NodeProps<typeof Person>;
// { name: string; email?: string; age?: number }

// For type-safe node IDs (prevents mixing IDs from different node types):
type PersonId = NodeId<typeof Person>;
// string & { readonly [__nodeId]: typeof Person }
```

Use `Node<typeof X>` when your function needs the full node with metadata.
 Use `NodeProps<typeof X>` when you only care about the schema properties (e.g., for form validation or API payloads).

### Typed Store Operations

```typescript
// Create returns a fully typed Node
const alice: Node<typeof Person> = await store.nodes.Person.create({
  name: "Alice",
  email: "alice@example.com",
});

// TypeScript knows the structure
alice.id;              // NodeId<typeof Person> - branded string
alice.name;            // string
alice.email;           // string | undefined
alice.age;             // number | undefined
alice.meta.version;    // number
alice.meta.createdAt;  // string (ISO 8601)

// Type errors caught at compile time
await store.nodes.Person.create({
  name: 123,           // Error: Type 'number' is not assignable to type 'string'
  invalid: "field",    // Error: Object literal may only specify known properties
});
```

### Typed Query Results

```typescript
// Result type is inferred from your select projection
const results = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ({
    name: ctx.p.name,     // TypeScript knows: string
    email: ctx.p.email,   // TypeScript knows: string | undefined
    id: ctx.p.id,         // TypeScript knows: NodeId<Person>
  }))
  .execute();

// results: Array<{ name: string; email: string | undefined; id: NodeId<Person> }>

// Invalid property access is caught
.select((ctx) => ({
  invalid: ctx.p.nonexistent,  // TypeScript error!
}))
```

### Typed Edge Operations

Edge endpoints are constrained to valid node types:

```typescript
// Edge definition: worksAt goes from Person → Company
const graph = defineGraph({
  // ...
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
  },
});

// TypeScript enforces valid endpoints
await store.edges.worksAt.create(alice, acmeCorp, { role: "Engineer" }); // OK

await store.edges.worksAt.create(acmeCorp, alice, { role: "Engineer" });
// Error: Argument of type 'Node<Company>' is not assignable to parameter of type 'Node<Person>'
```
