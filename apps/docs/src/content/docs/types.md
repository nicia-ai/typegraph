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

### `NodeRef`

Generic reference to a node endpoint.

```typescript
type NodeRef = Readonly<{ kind: string; id: string }>;
```

### `TypedNodeRef<N>`

Type-safe reference to a node of a specific type. Used for edge collection
methods to enforce that endpoints match the allowed node types.

```typescript
type TypedNodeRef<N extends NodeType> = Node<N> | Readonly<{ kind: N["kind"]; id: string }>;
```

Accepts either:

- A `Node<N>` instance (e.g., the result of `store.nodes.Person.create()`)
- An explicit object with the correct type name and ID

### `SelectableNode<N>`

The node type available in `select()` context. Properties are flattened (not nested under `props`).

```typescript
type SelectableNode<N extends NodeType> = Readonly<{
  id: string;
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

**Example:**

```typescript
// In select context, access properties directly
.select((ctx) => ({
  id: ctx.p.id,           // string
  name: ctx.p.name,       // Direct property access (not ctx.p.props.name)
  email: ctx.p.email,
  created: ctx.p.meta.createdAt,
}))
```

## Edge Types

### `Edge<E>`

The full edge type returned from store operations.

```typescript
type Edge<E extends EdgeType> = Readonly<{
  id: string;
  kind: E["kind"];
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  meta: {
    validFrom: string | undefined;   // Temporal validity start (ISO string)
    validTo: string | undefined;     // Temporal validity end (ISO string)
    createdAt: string;               // Created timestamp (ISO string)
    updatedAt: string;               // Updated timestamp (ISO string)
    deletedAt: string | undefined;   // Soft delete timestamp (ISO string)
  };
}> & z.infer<E["schema"]>;            // Schema properties are flattened
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

**Example:**

```typescript
// Access edge properties in select context
.select((ctx) => ({
  role: ctx.e.role,           // Direct edge property access
  salary: ctx.e.salary,
  edgeId: ctx.e.id,
  startedAt: ctx.e.meta.createdAt,
}))
```

### `TypedEdgeCollection<R>`

A type-safe edge collection with From/To types extracted from the edge
registration. This is what `store.edges.*` returns.

```typescript
type TypedEdgeCollection<R extends EdgeRegistration> = EdgeCollection<
  R["type"],
  R["from"][number], // Union of allowed 'from' node types
  R["to"][number]    // Union of allowed 'to' node types
>;
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

Maximum depth for unbounded recursive traversals (100).

```typescript
import { MAX_RECURSIVE_DEPTH } from "@nicia-ai/typegraph";

// MAX_RECURSIVE_DEPTH = 100
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
