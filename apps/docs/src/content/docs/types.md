---
title: Types
description: TypeScript type definitions and utilities
---

This reference documents TypeGraph's TypeScript types and utility functions.

## Node Types

### `Node<N>`

The full node type returned from store operations.

```typescript
type Node<N extends NodeType> = Readonly<{
  id: NodeId<N>;     // Branded ID type
  kind: N["kind"];   // Node kind name
  meta: {
    version: number;                 // Monotonic version counter
    validFrom: string | undefined;   // Temporal validity start (ISO string)
    validTo: string | undefined;     // Temporal validity end (ISO string)
    createdAt: string;               // Created timestamp (ISO string)
    updatedAt: string;               // Updated timestamp (ISO string)
    deletedAt: string | undefined;   // Soft delete timestamp (ISO string)
  };
}> & z.infer<N["schema"]>;            // Schema properties are flattened
```

### `NodeId<N>`

Branded string type for type-safe node IDs. Prevents accidentally mixing IDs from different node types.

```typescript
type NodeId<N extends NodeType> = string & { readonly [__nodeId]: N };
```

**Example:**

```typescript
import { type NodeId } from "@nicia-ai/typegraph";

type PersonId = NodeId<typeof Person>;
type CompanyId = NodeId<typeof Company>;

function getPersonById(id: PersonId): Promise<Node<typeof Person>> {
  // TypeScript prevents passing a CompanyId here
  return store.nodes.Person.getById(id);
}
```

### `NodeProps<N>`

Extracts just the property types from a node definition. Use this when you only
need the schema data without node metadata.

```typescript
type NodeProps<N extends NodeType> = z.infer<N["schema"]>;
```

**Example:**

```typescript
import { type NodeProps } from "@nicia-ai/typegraph";

type PersonProps = NodeProps<typeof Person>;
// { name: string; email?: string; age?: number }

// Useful for form data, API payloads, or validation
function validatePersonData(data: PersonProps): boolean {
  return data.name.length > 0;
}
```

### `NodeRef<N>`

Type-safe reference to a node of a specific kind. Used for edge collection
methods to enforce that endpoints match the allowed node types.
Defaults to `NodeType` when no type parameter is given.

```typescript
type NodeRef<N extends NodeType = NodeType> = Node<N> | Readonly<{ kind: N["kind"]; id: string }>;
```

Accepts either:

- A `Node<N>` instance (e.g., the result of `store.nodes.Person.create()`)
- An explicit object with the correct type name and ID

### `SelectableNode<N>`

The node type available in `select()` context. Properties are flattened (not nested under `props`).

```typescript
type SelectableNode<N extends NodeType> = Readonly<{
  id: NodeId<N>;
  kind: N["kind"];
  meta: {
    version: number;
    validFrom: string | undefined;
    validTo: string | undefined;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | undefined;
  };
}> & z.infer<N["schema"]>;  // Properties are flattened
```

`id` carries the same `NodeId<N>` brand as `Node<N>`, so a projected id can be
passed straight into `getById`/`getByIds` without a cast.

**Example:**

```typescript
// In select context, access properties directly
.select((ctx) => ({
  id: ctx.p.id,           // NodeId<Person>
  name: ctx.p.name,       // Direct property access (not ctx.p.props.name)
  email: ctx.p.email,
  created: ctx.p.meta.createdAt,
}))
```

## Edge Types

### `Edge<E, From, To>`

The full edge type returned from store operations. The `From` and `To` type
parameters carry compile-time node type information for the edge endpoints.

```typescript
type Edge<
  E extends EdgeType = EdgeType,
  From extends NodeType = NodeType,
  To extends NodeType = NodeType,
> = Readonly<{
  id: EdgeId<E>;           // Branded ID type
  kind: E["kind"];
  fromKind: From["kind"];
  fromId: NodeId<From>;
  toKind: To["kind"];
  toId: NodeId<To>;
  meta: {
    validFrom: string | undefined;   // Temporal validity start (ISO string)
    validTo: string | undefined;     // Temporal validity end (ISO string)
    createdAt: string;               // Created timestamp (ISO string)
    updatedAt: string;               // Updated timestamp (ISO string)
    deletedAt: string | undefined;   // Soft delete timestamp (ISO string)
  };
}> & z.infer<E["schema"]>;            // Schema properties are flattened
```

### `EdgeId<E>`

Branded string type for type-safe edge IDs. Prevents accidentally mixing IDs from different edge types.

```typescript
type EdgeId<E extends AnyEdgeType = AnyEdgeType> = string & { readonly [__edgeId]: E };
```

**Example:**

```typescript
import { type EdgeId } from "@nicia-ai/typegraph";

type WorksAtId = EdgeId<typeof worksAt>;

function getEdgeById(id: WorksAtId): Promise<Edge<typeof worksAt>> {
  return store.edges.worksAt.getById(id);
}
```

### `EdgeProps<E>`

Extracts just the property types from an edge definition.

```typescript
type EdgeProps<E extends EdgeType> = z.infer<E["schema"]>;
```

**Example:**

```typescript
import { type EdgeProps } from "@nicia-ai/typegraph";

type WorksAtProps = EdgeProps<typeof worksAt>;
// { role: string; startDate?: string }
```

### `SelectableEdge<E>`

The edge type available in `select()` context. Properties are flattened.

```typescript
type SelectableEdge<E extends EdgeType> = Readonly<{
  id: string;
  kind: E["kind"];
  fromId: string;
  toId: string;
  meta: {
    validFrom: string | undefined;
    validTo: string | undefined;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | undefined;
  };
}> & z.infer<E["schema"]>;  // Edge properties are flattened
```

`traverse()` defaults to `expand: "inverse"`, which can match the graph's
*registered inverse* edge kind alongside the one you asked for — and
`inverseOf(edgeA, edgeB)` doesn't require `edgeA`/`edgeB` to share a props
schema — so the row behind an edge alias isn't guaranteed to be the
requested kind, or to have the requested kind's schema. This affects
`SelectableEdge` in three different ways:

- **`kind: E["kind"]` can already be wrong today.** It's a literal type
  (e.g. `"manages"`), not `string` — but the runtime value can be the
  registered inverse kind (e.g. `"managedBy"`) under the default expansion
  mode. This isn't a missing brand, it's an existing type-accuracy gap:
  don't trust `ctx.e.kind` without knowing the traversal can't have
  expanded into a different kind.
- **The flattened schema properties have the same gap.** `ctx.e.role` is
  typed against the requested edge kind's schema, but an inverse-branch
  row's real props came from a different schema and may not have a `role`
  field at all — reading it returns `undefined`, not a type error.
- **`id`/`fromId`/`toId` stay plain `string`**, unlike `SelectableNode<N>.id`
  — deliberately not branded `EdgeId<E>`/`NodeId<From>`/`NodeId<To>`. This
  one's just an ergonomics gap (`string` never overclaims), but branding
  these fields would compile while being actively wrong for the same
  reason: a mismatched-kind id would compile straight into `getById` and
  silently return `undefined` instead of erroring.

When you know a traversal is single-kind, re-brand explicitly:

```typescript
import { asEdgeId, asNodeId } from "@nicia-ai/typegraph";

const rows = await store
  .query()
  .from("Person", "p")
  .traverse("worksAt", "e", { expand: "none" })
  .to("Company", "c")
  .select((ctx) => ({ edgeId: ctx.e.id, companyId: ctx.e.toId }))
  .execute();

const edge = await store.edges.worksAt.getById(asEdgeId<typeof worksAt>(rows[0]!.edgeId));
const company = await store.nodes.Company.getById(asNodeId<typeof Company>(rows[0]!.companyId));
```

**Example:**

```typescript
// Access edge properties in select context. expand: "none" makes the
// schema (and kind/id) trustworthy — see the warning above.
.traverse("worksAt", "e", { expand: "none" })
.select((ctx) => ({
  role: ctx.e.role,           // Direct edge property access
  salary: ctx.e.salary,
  edgeId: ctx.e.id,
  startedAt: ctx.e.meta.createdAt,
}))
```

### `TypedEdgeCollection<R>`

A type-safe edge collection derived from the edge registration. This is what
`store.edges.*` returns. With array-valued `to`, each source type can connect to
each target type. With a [source-dependent target map](/core-concepts#source-dependent-targets),
typed writes preserve the allowed pairs instead of accepting independent endpoint unions.

```typescript
// assignedTo allows Employee -> Department and Student -> Course.
await store.edges.assignedTo.create(employee, department, {});
await store.edges.assignedTo.create(student, course, {});

// @ts-expect-error Employee cannot be assigned to Course.
await store.edges.assignedTo.create(employee, course, {});
```

Keep the inferred edge and graph types to retain this information. Widening a
declaration to a generic endpoint union can lose compile-time correlation;
runtime validation still enforces the graph's allowed pairs. The same runtime
validation applies to dynamic collections whose kinds are only known at runtime.
This write-side guarantee does not make query results a correlated union of
source/target pairs; narrow result kinds explicitly when consuming them.

### `DynamicNodeCollection`

A node collection with widened generics for runtime string-keyed access via
[`store.getNodeCollection(kind)`](/schemas-stores#storegetnodecollectionkind).
Exposes the full `NodeCollection` API (`create`, `getById`, `find`, `count`,
`createFromRecord`, etc.) but accepts `Record<string, unknown>` for schema-typed
parameters since the concrete node type is not known at compile time.

ID parameters (`getById`, `getByIds`, `update`, `delete`, `hardDelete`,
`bulkDelete`) accept plain `string` instead of branded `NodeId<N>`, since the
dynamic path typically receives IDs from edge metadata, snapshots, or external
input where the brand is not available.

```typescript
import type { DynamicNodeCollection } from "@nicia-ai/typegraph";

// Derived from NodeCollection<DynamicNodeType, string> with ID parameters widened to string
```

### `DynamicNodeKind`, `DynamicNode`, and `DynamicNodeReference`

`DynamicNodeKind<K>` preserves and nominally marks the requested collection
key. `DynamicNode` is the node value returned by a `DynamicNodeCollection`, and
`DynamicNodeReference` is the nominal lightweight `{ kind, id }` form returned
by runtime-aware identity reads. The markers let those results flow back into
identity operations without making arbitrary string kinds valid compile-time
inputs.

```typescript
import type {
  DynamicNode,
  DynamicNodeKind,
  DynamicNodeReference,
} from "@nicia-ai/typegraph";
```

Identity reads return `IdentityNodeReference<G>`, the union of the graph's
compile-time node references and `DynamicNodeReference`, because a class can
contain both after runtime evolution.

### `DynamicEdgeCollection`

`DynamicEdgeCollection<E>` is an edge collection for runtime endpoint dispatch. Obtain it from
[`store.getEdgeCollection(kind)`](/schemas-stores#storegetedgecollectionkind),
`store.getEdgeCollectionOrThrow(kind)`, or either method on a transaction context.
When `kind` belongs to the graph's TypeScript definition, `E` retains that edge's
property schema and result type. An arbitrary `string` uses the default
`AnyEdgeType`, so properties are checked at runtime.

Endpoints accept `{ kind: string; id: string }`. Writes validate endpoint domains
and source-dependent pairs against the graph's schema. ID parameters accept
plain `string`; returned edges retain their typed IDs. This surface exposes the
full collection API, including bulk operations.

Use it for helpers generic over a graph and edge kind:

```typescript
import type { EdgeKinds, GraphDef, NodeRef, TransactionContext } from "@nicia-ai/typegraph";
import type { z } from "zod";

async function connect<G extends GraphDef, K extends EdgeKinds<G>>(
  tx: TransactionContext<G>,
  kind: K,
  from: NodeRef,
  to: NodeRef,
  props: z.input<G["edges"][K]["type"]["schema"]>,
) {
  return tx.getEdgeCollectionOrThrow(kind).getOrCreateByEndpoints(
    from, to, props, { ifExists: "update" },
  );
}
```

For a reusable collection parameter, use `DynamicEdgeCollection<E>`. No collection
cast or dependency on generated declaration filenames is needed.

**Upgrading from 0.54/0.55:** source-dependent targets in 0.55 made endpoint
arguments a union of valid pairs. TypeScript cannot resolve that union inside
some generic `G`/`K` helpers, even for array-valued targets. Migrate dynamic calls
from `tx.edges[kind]` to `tx.getEdgeCollectionOrThrow(kind)` (or check the optional
lookup result). Generic `EdgeCollection<E, From, To>` and
`TypedEdgeCollection<EdgeRegistration<E, From, To>>` annotations can encounter the
same deferred-type limitation; use `DynamicEdgeCollection<E>` when endpoints are
runtime data. Keep `store.edges.specificKind` for compile-time endpoint checking.

`EdgeRegistration` now permits array or map targets in broad annotations. Code
inspecting `.to` must narrow with `isEdgeTargetMap`; an explicitly Cartesian
registration can specify `readonly To[]` as its fourth type argument.

Known-kind dynamic lookups now check properties at compile time. Callers passing
an unvalidated record should parse it with the selected schema first. An `unknown`
property value was not accepted by the typed 0.54 API either.

### `DynamicStoreViewEdgeCollection<E>`

`view.getEdgeCollection(kind)` returns an optional dynamic collection bound to the
view's valid-time coordinate. It retains known edge property types and accepts
runtime endpoint references and string IDs. It exposes only the view's reads:
there are no writes, deferred batch reads, or per-call temporal overrides.
Recorded-time views retain their narrower reconstructing-read API.

## Subgraph Types

These types are used with [`store.subgraph()`](/schemas-stores#storesubgraphrootid-options) for
typed neighborhood extraction.

### `AnyNode<G>`

Discriminated union of all runtime node types in a graph. Each member carries its
own `kind` literal, so `switch (node.kind)` narrows the type automatically.

```typescript
import type { AnyNode } from "@nicia-ai/typegraph";

type MyNode = AnyNode<typeof graph>;
// = Node<typeof Person> | Node<typeof Company> | ...
```

### `AnyEdge<G>`

Discriminated union of all runtime edge types in a graph.

```typescript
import type { AnyEdge } from "@nicia-ai/typegraph";

type MyEdge = AnyEdge<typeof graph>;
// = Edge<typeof worksAt> | Edge<typeof knows> | ...
```

### `SubsetNode<G, K>`

Narrows `AnyNode<G>` to a subset of node kinds. Useful when `store.subgraph()`
is called with `includeKinds`.

```typescript
import type { SubsetNode } from "@nicia-ai/typegraph";

type TaskOrAgent = SubsetNode<typeof graph, "Task" | "Agent">;
// = Node<typeof Task> | Node<typeof Agent>
```

### `SubsetEdge<G, K>`

Narrows `AnyEdge<G>` to a subset of edge kinds.

```typescript
import type { SubsetEdge } from "@nicia-ai/typegraph";

type TraversedEdges = SubsetEdge<typeof graph, "has_task" | "runs_agent">;
```

### `SubgraphOptions<G, EK, NK>`

Options for `store.subgraph()`. See the
[store reference](/schemas-stores#storesubgraphrootid-options) for the full
parameter table.

```typescript
type SubgraphOptions<G, EK, NK> = Readonly<{
  edges: readonly EK[];
  maxDepth?: number;
  includeKinds?: readonly NK[];
  excludeRoot?: boolean;
  direction?: "out" | "both";
  cyclePolicy?: "prevent" | "allow";
}>;
```

### `SubgraphResult<G, NK, EK>`

The return type of `store.subgraph()`. Contains the root node, a node index, and
forward/reverse adjacency maps for immediate traversal.

```typescript
type SubgraphResult<G, NK, EK> = Readonly<{
  root: SubgraphNodeResult<G, NK> | undefined;
  nodes: ReadonlyMap<string, SubgraphNodeResult<G, NK>>;
  adjacency: ReadonlyMap<string, ReadonlyMap<EK, readonly SubgraphEdgeResult<G, EK>[]>>;
  reverseAdjacency: ReadonlyMap<string, ReadonlyMap<EK, readonly SubgraphEdgeResult<G, EK>[]>>;
}>;
```

## Graph Configuration Types

### `DeleteBehavior`

Controls what happens to edges when a node is deleted.

```typescript
type DeleteBehavior = "restrict" | "cascade" | "disconnect";
```

| Value | Description |
|-------|-------------|
| `"restrict"` | Prevent deletion if edges exist |
| `"cascade"` | Delete connected edges |
| `"disconnect"` | Remove edges without error |

### `Cardinality`

Controls how many edges of a type can connect from/to a node.

```typescript
type Cardinality = "many" | "one" | "unique" | "oneActive";
```

| Value | Description |
|-------|-------------|
| `"many"` | No limit on edges |
| `"one"` | At most one edge per source node |
| `"unique"` | At most one edge per source-target pair |
| `"oneActive"` | At most one active edge (`validTo` is `undefined`) per source node |

### `InferenceType`

Controls how ontology relationships affect queries.

```typescript
type InferenceType =
  | "subsumption"   // Query for X includes subclass instances
  | "hierarchy"     // Enables broader/narrower traversal
  | "substitution"  // Can substitute equivalent types
  | "constraint"    // Validation rules
  | "composition"   // Part-whole navigation
  | "association"   // Discovery/recommendation
  | "none";         // No automatic inference
```

## Query Types

### `VariableLengthSpec`

Configuration for variable-length (recursive) traversals.

```typescript
type VariableLengthSpec = Readonly<{
  minDepth: number;                   // Minimum hops (default: 1)
  maxDepth: number;                   // Maximum hops (-1 = unlimited)
  cyclePolicy: "prevent" | "allow";   // Cycle handling mode
  pathAlias?: string;                 // Column alias for projected path
  depthAlias?: string;                // Column alias for projected depth
}>;
```

### `SetOperationType`

Available set operations for combining queries.

```typescript
type SetOperationType = "union" | "unionAll" | "intersect" | "except";
```

### `PaginateOptions`

Options for cursor-based pagination.

```typescript
type PaginateOptions = Readonly<{
  first?: number;   // Items to fetch (forward)
  after?: string;   // Cursor to start after (forward)
  last?: number;    // Items to fetch (backward)
  before?: string;  // Cursor to start before (backward)
}>;
```

### `PaginatedResult<R>`

Result of a paginated query.

```typescript
type PaginatedResult<R> = Readonly<{
  data: readonly R[];
  nextCursor: string | undefined;
  prevCursor: string | undefined;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}>;
```

### `StreamOptions`

Options for streaming results.

```typescript
type StreamOptions = Readonly<{
  batchSize?: number;  // Items per batch (default: 1000)
}>;
```

## Utility Functions

### `generateId()`

Generates a unique ID using nanoid.

```typescript
import { generateId } from "@nicia-ai/typegraph";

function generateId(): string;

const id = generateId(); // "V1StGXR8_Z5jdHi6B-myT"
```

## Constants

### `MAX_RECURSIVE_DEPTH`

Maximum depth for unbounded recursive traversals (10).

```typescript
import { MAX_RECURSIVE_DEPTH } from "@nicia-ai/typegraph";

// MAX_RECURSIVE_DEPTH = 10
```

Recursive traversals are capped at this depth when no `maxHops` is specified in
the `recursive()` options object. Explicit `maxHops` values are validated against
`MAX_EXPLICIT_RECURSIVE_DEPTH` (1000). Cycle prevention is enabled by default.
To allow revisits for maximum performance, use `cyclePolicy: "allow"`.

### `MAX_EXPLICIT_RECURSIVE_DEPTH`

Maximum allowed value for the `maxHops` option in recursive traversals (1000).

```typescript
import { MAX_EXPLICIT_RECURSIVE_DEPTH } from "@nicia-ai/typegraph";

// MAX_EXPLICIT_RECURSIVE_DEPTH = 1000
```
