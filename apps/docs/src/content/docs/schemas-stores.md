---
title: Schemas & Stores
description: Schema definition functions and store API reference
---

This reference documents the schema definition functions and store API for TypeGraph.

## Schema Definition

### `defineNode(name, options)`

Creates a node type definition.

```typescript
import { defineNode } from "@nicia-ai/typegraph";

function defineNode<K extends string, S extends z.ZodObject<any>>(
  name: K,
  options: {
    schema: S;
    description?: string;
  },
): NodeType<K, S>;
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Unique name for this node type |
| `options.schema` | `z.ZodObject` | Zod object schema for node properties |
| `options.description` | `string` | Optional description |

**Example:**

```typescript
const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().email().optional(),
  }),
  description: "A person in the system",
});
```

### `defineEdge(name, options?)`

Creates an edge type definition.

```typescript
import { defineEdge } from "@nicia-ai/typegraph";

function defineEdge<K extends string, S extends z.ZodObject<any>>(
  name: K,
  options?: {
    schema?: S;
    description?: string;
    from?: NodeType[];
    to?: NodeType[];
  },
): EdgeType<K, S>;
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Unique name for this edge type |
| `options.schema` | `z.ZodObject` | Optional Zod object schema (defaults to empty object) |
| `options.description` | `string` | Optional description |
| `options.from` | `NodeType[]` | Optional domain constraint (valid source node types) |
| `options.to` | `NodeType[]` | Optional range constraint (valid target node types) |

**Example:**

```typescript
const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startDate: z.string().optional(),
  }),
});

const knows = defineEdge("knows"); // No schema needed
```

**With Domain/Range Constraints:**

When `from` and `to` are specified, the edge carries its endpoint constraints intrinsically:

```typescript
const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startDate: z.string().optional(),
  }),
  from: [Person],      // Domain: only Person can be the source
  to: [Company],       // Range: only Company can be the target
});

// Edges with built-in constraints can be used directly in defineGraph
const graph = defineGraph({
  id: "my_graph",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: { worksAt },  // Direct use - no EdgeRegistration wrapper needed
});
```

See [Schemas & Types](/core-concepts#domain-and-range-constraints) for detailed documentation on domain/range constraints.

### `embedding(dimensions)`

Creates a Zod schema for vector embeddings with dimension validation.

```typescript
import { embedding } from "@nicia-ai/typegraph";

function embedding<D extends number>(dimensions: D): EmbeddingSchema<D>;
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `dimensions` | `number` | The number of dimensions (e.g., 384, 512, 768, 1536, 3072) |

**Example:**

```typescript
const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    content: z.string(),
    embedding: embedding(1536), // OpenAI ada-002
  }),
});

// Optional embeddings
const Article = defineNode("Article", {
  schema: z.object({
    content: z.string(),
    embedding: embedding(1536).optional(),
  }),
});
```

See [Semantic Search](/semantic-search) for query usage.

### `externalRef(table)`

Creates a Zod schema for referencing external data sources. Use this for hybrid
overlay patterns where TypeGraph stores relationships while your existing tables
remain the source of truth.

```typescript
import { externalRef } from "@nicia-ai/typegraph";

function externalRef<T extends string>(table: T): ExternalRefSchema<T>;
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | `string` | Identifier for the external table (e.g., "users", "documents") |

**Example:**

```typescript
const Document = defineNode("Document", {
  schema: z.object({
    source: externalRef("documents"),
    embedding: embedding(1536).optional(),
  }),
});

// Create with explicit table reference
await store.nodes.Document.create({
  source: { table: "documents", id: "doc_123" },
});

// Query the external reference
const results = await store
  .query()
  .from("Document", "d")
  .select((ctx) => ctx.d.source)
  .execute();
// results[0].source = { table: "documents", id: "doc_123" }
```

### `createExternalRef(table)`

Factory helper to create external reference values without repeating the table name.

```typescript
import { createExternalRef } from "@nicia-ai/typegraph";

function createExternalRef<T extends string>(
  table: T
): (id: string) => ExternalRefValue<T>;
```

**Example:**

```typescript
const docRef = createExternalRef("documents");

await store.nodes.Document.create({
  source: docRef("doc_123"), // { table: "documents", id: "doc_123" }
});
```

### `defineGraph(config)`

Creates a graph definition combining nodes, edges, and ontology.

```typescript
import { defineGraph } from "@nicia-ai/typegraph";

function defineGraph<G extends GraphDef>(config: {
  id: string;
  nodes: Record<string, NodeRegistration>;
  edges: Record<string, EdgeRegistration>;
  ontology?: OntologyRelation[];
}): G;
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | Unique identifier for this graph |
| `nodes` | `Record<string, NodeRegistration>` | Node type registrations |
| `edges` | `Record<string, EdgeRegistration>` | Edge type registrations with endpoint types |
| `ontology` | `OntologyRelation[]` | Optional semantic relationships |

**Example:**

```typescript
const graph = defineGraph({
  id: "my_graph",
  nodes: {
    Person: { type: Person },
    Company: { type: Company, onDelete: "cascade" },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
  },
  ontology: [disjointWith(Person, Company)],
});
```

## Store Creation

### `createStore(graph, backend, options?)`

Creates a store instance for a graph definition.

```typescript
import { createStore } from "@nicia-ai/typegraph";

function createStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options?: StoreOptions
): Store<G>;
```

**Example:**

```typescript
const store = createStore(graph, backend);
```

### `createStoreWithSchema(graph, backend, options?)`

Creates a store and ensures the database schema is initialized or migrated.
This is the recommended factory for production use.

```typescript
import { createStoreWithSchema } from "@nicia-ai/typegraph";

function createStoreWithSchema<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options?: StoreOptions & SchemaManagerOptions
): Promise<[Store<G>, SchemaValidationResult]>;
```

**Returns:** A tuple of `[store, validationResult]`

The validation result indicates what happened:

- `status: "unchanged"` - Schema matches, no changes needed
- `status: "initialized"` - Schema created for the first time
- `status: "migrated"` - Safe changes auto-applied (additive only)

**Example:**

```typescript
const [store, result] = await createStoreWithSchema(graph, backend);

if (result.status === "initialized") {
  console.log("Schema initialized at version", result.version);
} else if (result.status === "migrated") {
  console.log(`Migrated from v${result.fromVersion} to v${result.toVersion}`);
}
```

**Throws:** `MigrationError` if breaking changes are detected that require
manual migration.

## Store API

The store provides typed node and edge collections via `store.nodes.*` and `store.edges.*`.

### Node Collections

Each node type has a collection with these methods:

#### `create(props, options?)`

Creates a new node.

```typescript
store.nodes.Person.create(
  props: { name: string; email?: string },
  options?: { id?: string; validFrom?: string; validTo?: string }
): Promise<Node<Person>>;
```

#### `getById(id)`

Retrieves a node by ID.

```typescript
store.nodes.Person.getById(id: NodeId<Person>): Promise<Node<Person> | undefined>;
```

#### `update(id, props)`

Updates node properties.

```typescript
store.nodes.Person.update(
  id: NodeId<Person>,
  props: Partial<{ name: string; email?: string }>
): Promise<Node<Person>>;
```

#### `delete(id)`

Soft-deletes a node.

```typescript
store.nodes.Person.delete(id: NodeId<Person>): Promise<void>;
```

#### `find(options?)`

Finds nodes of this kind with optional pagination.
For filtering, use the query builder (`store.query()`).

```typescript
store.nodes.Person.find(options?: {
  limit?: number;
  offset?: number;
}): Promise<Node<Person>[]>;
```

#### `count()`

Counts nodes of this kind (excluding soft-deleted nodes).

```typescript
store.nodes.Person.count(): Promise<number>;
```

#### `upsert(id, props, options?)`

Creates or updates a node.

```typescript
store.nodes.Person.upsert(
  id: string,
  props: { name: string; email?: string },
  options?: { validFrom?: string; validTo?: string }
): Promise<Node<Person>>;
```

**Behavior:**

- Creates a new node if no node with the ID exists
- Updates the existing node if one exists
- Un-deletes soft-deleted nodes (clears `deletedAt`)

#### `bulkCreate(items)`

Creates multiple nodes efficiently.

```typescript
store.nodes.Person.bulkCreate(
  items: readonly {
    props: { name: string; email?: string };
    id?: string;
    validFrom?: string;
    validTo?: string;
  }[]
): Promise<Node<Person>[]>;
```

#### `bulkUpsert(items)`

Creates or updates multiple nodes.

```typescript
store.nodes.Person.bulkUpsert(
  items: readonly {
    id: string;
    props: { name: string; email?: string };
    validFrom?: string;
    validTo?: string;
  }[]
): Promise<Node<Person>[]>;
```

#### `bulkDelete(ids)`

Soft-deletes multiple nodes.

```typescript
store.nodes.Person.bulkDelete(
  ids: readonly NodeId<Person>[]
): Promise<void>;
```

### Edge Collections

Each edge type has a type-safe collection. The `from` and `to` parameters are
constrained to only accept node types declared in the edge registration.

#### `create(from, to, props)`

Creates an edge. TypeScript enforces valid endpoint types.

```typescript
// Given: worksAt: { type: worksAt, from: [Person], to: [Company] }

store.edges.worksAt.create(
  from: TypedNodeRef<Person>,
  to: TypedNodeRef<Company>,
  props: { role: string }
): Promise<Edge<worksAt>>;

// Preferred: Pass node objects directly
await store.edges.worksAt.create(alice, acme, { role: "Engineer" });

// Compile error - Company is not a valid 'from' type
await store.edges.worksAt.create(acme, alice, { role: "Engineer" });
```

#### Node References

Both forms are **exactly equivalent**—TypeGraph extracts `kind` and `id` from either:

```typescript
// Full node object (preferred - cleaner syntax)
await store.edges.worksAt.create(alice, acme, { role: "Engineer" });

// Explicit reference (useful when you only have IDs)
await store.edges.worksAt.create(
  { kind: "Person", id: aliceId },
  { kind: "Company", id: acmeId },
  { role: "Engineer" }
);
```

Use the explicit `{ kind, id }` form when you have IDs but not the full node objects (e.g., from a
previous query or external input).

#### `getById(id)`

Retrieves an edge by ID.

```typescript
store.edges.worksAt.getById(id: string): Promise<Edge<worksAt> | undefined>;
```

#### `update(id, props, options?)`

Updates edge properties.

```typescript
store.edges.worksAt.update(
  id: string,
  props: Partial<{ role: string }>,
  options?: { validTo?: string }
): Promise<Edge<worksAt>>;
```

#### `findFrom(from)`

Finds edges from a node.

```typescript
store.edges.worksAt.findFrom(
  from: TypedNodeRef<Person>
): Promise<Edge<worksAt>[]>;
```

#### `findTo(to)`

Finds edges to a node.

```typescript
store.edges.worksAt.findTo(
  to: TypedNodeRef<Company>
): Promise<Edge<worksAt>[]>;
```

#### `find(options?)`

Finds edges with filtering.

```typescript
store.edges.worksAt.find(options?: {
  from?: TypedNodeRef<Person>;
  to?: TypedNodeRef<Company>;
  limit?: number;
  offset?: number;
}): Promise<Edge<worksAt>[]>;
```

#### `count(options?)`

Counts edges matching filters.

```typescript
store.edges.worksAt.count(options?: {
  from?: TypedNodeRef<Person>;
  to?: TypedNodeRef<Company>;
}): Promise<number>;
```

#### `delete(id)`

Soft-deletes an edge.

```typescript
store.edges.worksAt.delete(id: string): Promise<void>;
```

#### `bulkCreate(items)`

Creates multiple edges efficiently.

```typescript
store.edges.worksAt.bulkCreate(
  items: readonly {
    from: TypedNodeRef<Person>;
    to: TypedNodeRef<Company>;
    props?: { role: string };
    id?: string;
    validFrom?: string;
    validTo?: string;
  }[]
): Promise<Edge<worksAt>[]>;
```

#### `bulkDelete(ids)`

Soft-deletes multiple edges.

```typescript
store.edges.worksAt.bulkDelete(
  ids: readonly string[]
): Promise<void>;
```

### Transactions

#### `store.transaction(fn)`

Executes operations in a transaction. The transaction context has the same collection API.

```typescript
await store.transaction(async (tx) => {
  const person = await tx.nodes.Person.create({ name: "Alice" });
  const company = await tx.nodes.Company.create({ name: "Acme" });
  await tx.edges.worksAt.create(person, company, { role: "Engineer" });
});
```

### Query Builder

#### `store.query()`

Creates a query builder. See [Query Builder](/queries/overview) for full documentation.

```typescript
const results = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.startsWith("A"))
  .select((ctx) => ctx.p)
  .execute();
```

**Execution methods** (see [Execute](/queries/execute) for details):

| Method | Returns | Description |
|--------|---------|-------------|
| `execute()` | `Promise<readonly T[]>` | Run query, return all results |
| `first()` | `Promise<T \| undefined>` | Return first result or undefined |
| `count()` | `Promise<number>` | Count matching results |
| `exists()` | `Promise<boolean>` | Check if any results exist |
| `paginate(options)` | `Promise<PaginatedResult<T>>` | Cursor-based pagination |
| `stream(options?)` | `AsyncIterable<T>` | Stream results in batches |

### Registry Access

#### `store.registry`

Access to the type registry for ontology lookups.

```typescript
readonly registry: KindRegistry;
```

See [Ontology](/ontology) for registry methods.

## Observability Hooks

TypeGraph supports observability hooks for monitoring and logging store operations.

### `StoreHooks`

Configuration for observability callbacks:

```typescript
type StoreHooks = Readonly<{
  onOperationStart?: (ctx: OperationHookContext) => void;
  onOperationEnd?: (ctx: OperationHookContext, result: { durationMs: number }) => void;
  onError?: (ctx: HookContext, error: Error) => void;
}>;

type HookContext = Readonly<{
  operationId: string;
  graphId: string;
  startedAt: Date;
}>;

type OperationHookContext = HookContext &
  Readonly<{
    operation: "create" | "update" | "delete";
    entity: "node" | "edge";
    kind: string;
    id: string;
  }>;
```

**Example:**

```typescript
import { createStore, type StoreHooks } from "@nicia-ai/typegraph";

const hooks: StoreHooks = {
  onOperationStart: (ctx) => {
    console.log(`[${ctx.operationId}] ${ctx.operation} ${ctx.entity}:${ctx.kind}`);
  },
  onOperationEnd: (ctx, result) => {
    console.log(`[${ctx.operationId}] Completed in ${result.durationMs}ms`);
  },
  onError: (ctx, error) => {
    console.error(`[${ctx.operationId}] Error:`, error.message);
  },
};

const store = createStore(graph, backend, { hooks });

// Operations now trigger hooks
await store.nodes.Person.create({ name: "Alice" });
// Logs:
// [abc123] create node:Person
// [abc123] Completed in 5ms
```
