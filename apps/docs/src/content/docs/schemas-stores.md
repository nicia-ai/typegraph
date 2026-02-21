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

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `hooks` | `StoreHooks` | Observability hooks for monitoring operations |
| `schema` | `SqlSchema` | Custom table name configuration |
| `queryDefaults.traversalExpansion` | `TraversalExpansion` | Default ontology expansion mode for traversals (default: `"inverse"`) |

**Example:**

```typescript
const store = createStore(graph, backend);
```

Override the default traversal expansion:

```typescript
const store = createStore(graph, backend, {
  queryDefaults: { traversalExpansion: "none" },
});
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

- `status: "initialized"` - Schema created for the first time
- `status: "unchanged"` - Schema matches, no changes needed
- `status: "migrated"` - Safe changes auto-applied (additive only)
- `status: "pending"` - Safe changes detected but `autoMigrate` is `false`
- `status: "breaking"` - Breaking changes detected, action required

**Example:**

```typescript
const [store, result] = await createStoreWithSchema(graph, backend);

if (result.status === "initialized") {
  console.log("Schema initialized at version", result.version);
} else if (result.status === "migrated") {
  console.log(`Migrated from v${result.fromVersion} to v${result.toVersion}`);
} else if (result.status === "pending") {
  console.log(`Safe changes pending at version ${result.version}`);
}
```

**Throws:** `MigrationError` if breaking changes are detected and
`throwOnBreaking` is `true` (the default).

## Store API

The store provides typed node and edge collections via `store.nodes.*` and `store.edges.*`.

### Node Collections

Each node type has a collection with these methods:

#### Naming Guidelines

Mutation method names follow what identifier is used to match an existing record:

| If you have... | Use... |
|----------------|--------|
| ID | `*ById` |
| Unique constraint name + props | `*ByConstraint` |
| Edge endpoints (`from`, `to`) + optional `matchOn` | `*ByEndpoints` |

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

#### `getByIds(ids)`

Retrieves multiple nodes by ID in a single query. Returns results in input order,
with `undefined` for missing IDs.

```typescript
store.nodes.Person.getByIds(
  ids: readonly NodeId<Person>[],
  options?: QueryOptions
): Promise<readonly (Node<Person> | undefined)[]>;
```

When the backend supports batch lookups (`getNodes`), this executes a single
`SELECT ... WHERE id IN (...)` query. Otherwise it falls back to sequential lookups.

```typescript
const [alice, bob, unknown] = await store.nodes.Person.getByIds([
  aliceId,
  bobId,
  "nonexistent",
]);
// alice: Node<Person>
// bob: Node<Person>
// unknown: undefined
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

#### `hardDelete(id)`

Permanently deletes a node. This is irreversible and should be used carefully.

```typescript
store.nodes.Person.hardDelete(id: NodeId<Person>): Promise<void>;
```

#### `find(options?)`

Finds nodes of this kind with optional filtering and pagination.

```typescript
store.nodes.Person.find(options?: {
  where?: (accessor) => Predicate;
  limit?: number;
  offset?: number;
}): Promise<Node<Person>[]>;
```

The optional `where` predicate uses the same accessor API as `whereNode()` in the query builder:

```typescript
const activeUsers = await store.nodes.Person.find({
  where: (p) => p.status.eq("active"),
  limit: 50,
});
```

#### `count()`

Counts nodes of this kind (excluding soft-deleted nodes).

```typescript
store.nodes.Person.count(): Promise<number>;
```

#### `upsertById(id, props, options?)`

Creates or updates a node by ID.

```typescript
store.nodes.Person.upsertById(
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

Creates multiple nodes efficiently. Uses a single multi-row INSERT when the backend supports it.

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

Use `bulkInsert` when you don't need the created nodes back:

```typescript
await store.nodes.Person.bulkInsert(batch);
```

#### `bulkInsert(items)`

Inserts multiple nodes without returning results. This is the dedicated fast path for bulk
ingestion — wrapped in a transaction when the backend supports it.

```typescript
store.nodes.Person.bulkInsert(
  items: readonly {
    props: { name: string; email?: string };
    id?: string;
    validFrom?: string;
    validTo?: string;
  }[]
): Promise<void>;
```

#### `bulkUpsertById(items)`

Creates or updates multiple nodes by ID.

```typescript
store.nodes.Person.bulkUpsertById(
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

#### `getOrCreateByConstraint(constraintName, props, options?)`

Looks up an existing node by a named uniqueness constraint. Returns the match if found, or creates a new node if not.

```typescript
store.nodes.Person.getOrCreateByConstraint(
  constraintName: string,
  props: { name: string; email?: string },
  options?: { ifExists?: "return" | "update" } // Default: "return"
): Promise<{
  node: Node<Person>;
  action: "created" | "found" | "updated" | "resurrected";
}>;
```

#### `bulkGetOrCreateByConstraint(constraintName, items, options?)`

Batch version of `getOrCreateByConstraint`. Returns results in input order.

```typescript
store.nodes.Person.bulkGetOrCreateByConstraint(
  constraintName: string,
  items: readonly {
    props: { name: string; email?: string };
  }[],
  options?: { ifExists?: "return" | "update" }
): Promise<
  {
    node: Node<Person>;
    action: "created" | "found" | "updated" | "resurrected";
  }[]
>;
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

#### `getByIds(ids)`

Retrieves multiple edges by ID in a single query. Returns results in input order,
with `undefined` for missing IDs.

```typescript
store.edges.worksAt.getByIds(
  ids: readonly string[],
  options?: QueryOptions
): Promise<readonly (Edge<worksAt> | undefined)[]>;
```

```typescript
const [edge1, edge2] = await store.edges.worksAt.getByIds([id1, id2]);
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

Finds edges with endpoint filtering.

```typescript
store.edges.worksAt.find(options?: {
  from?: TypedNodeRef<Person>;
  to?: TypedNodeRef<Company>;
  limit?: number;
  offset?: number;
}): Promise<Edge<worksAt>[]>;
```

For edge property filters, use the query builder with `whereEdge(...)`.

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

#### `hardDelete(id)`

Permanently deletes an edge. This is irreversible and should be used carefully.

```typescript
store.edges.worksAt.hardDelete(id: string): Promise<void>;
```

#### `bulkCreate(items)`

Creates multiple edges efficiently. Uses a single multi-row INSERT when the backend supports it.

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

Use `bulkInsert` for high-volume edge ingestion when you do not need returned payloads:

```typescript
await store.edges.worksAt.bulkInsert(edgeBatch);
```

#### `bulkInsert(items)`

Inserts multiple edges without returning results. This is the dedicated fast path for bulk
ingestion — wrapped in a transaction when the backend supports it.

```typescript
store.edges.worksAt.bulkInsert(
  items: readonly {
    from: TypedNodeRef<Person>;
    to: TypedNodeRef<Company>;
    props?: { role: string };
    id?: string;
    validFrom?: string;
    validTo?: string;
  }[]
): Promise<void>;
```

#### `bulkDelete(ids)`

Soft-deletes multiple edges.

```typescript
store.edges.worksAt.bulkDelete(
  ids: readonly string[]
): Promise<void>;
```

#### `bulkUpsertById(items)`

Creates or updates multiple edges by ID.

```typescript
store.edges.worksAt.bulkUpsertById(
  items: readonly {
    id: string;
    from: TypedNodeRef<Person>;
    to: TypedNodeRef<Company>;
    props?: { role: string };
    validFrom?: string;
    validTo?: string;
  }[]
): Promise<Edge<worksAt>[]>;
```

#### `getOrCreateByEndpoints(from, to, props, options?)`

Looks up an existing edge by endpoints (and optionally by property fields via `matchOn`).
Returns the match if found, or creates a new edge if not.

```typescript
store.edges.worksAt.getOrCreateByEndpoints(
  from: TypedNodeRef<Person>,
  to: TypedNodeRef<Company>,
  props: { role: string },
  options?: {
    matchOn?: readonly ("role")[]; // Default: []
    ifExists?: "return" | "update"; // Default: "return"
  }
): Promise<{
  edge: Edge<worksAt>;
  action: "created" | "found" | "updated" | "resurrected";
}>;
```

#### `bulkGetOrCreateByEndpoints(items, options?)`

Batch version of `getOrCreateByEndpoints`. Returns results in input order.

```typescript
store.edges.worksAt.bulkGetOrCreateByEndpoints(
  items: readonly {
    from: TypedNodeRef<Person>;
    to: TypedNodeRef<Company>;
    props: { role: string };
  }[],
  options?: {
    matchOn?: readonly ("role")[];
    ifExists?: "return" | "update";
  }
): Promise<
  {
    edge: Edge<worksAt>;
    action: "created" | "found" | "updated" | "resurrected";
  }[]
>;
```

### Transactions

#### `store.transaction(fn)`

Executes a callback within an atomic transaction. All operations succeed together or are
rolled back together. The transaction context (`tx`) provides the same `nodes.*` and
`edges.*` collection API as the store itself.

```typescript
await store.transaction(async (tx) => {
  const person = await tx.nodes.Person.create({ name: "Alice" });
  const company = await tx.nodes.Company.create({ name: "Acme" });
  await tx.edges.worksAt.create(person, company, { role: "Engineer" });
});
```

#### Return values

The callback's return value is forwarded to the caller:

```typescript
const personId = await store.transaction(async (tx) => {
  const person = await tx.nodes.Person.create({ name: "Alice" });
  return person.id;
});
// personId is available here
```

#### Rollback and error propagation

If the callback throws, the transaction is rolled back and the error re-throws to the
caller. No partial writes are persisted.

```typescript
try {
  await store.transaction(async (tx) => {
    await tx.nodes.Person.create({ name: "Alice" });
    throw new Error("something went wrong");
    // Alice is NOT persisted — the entire transaction is rolled back
  });
} catch (error) {
  // error.message === "something went wrong"
}
```

#### Nesting

Transactions do **not** nest. The transaction context intentionally omits the
`transaction()` method, so attempting to start a transaction inside another transaction is
a compile-time error. If you need to compose transactional operations, pass the `tx`
context through your call chain.

#### Backend support

Not all backends support atomic transactions. Cloudflare D1, for example, does not —
calling `store.transaction()` on a D1-backed store throws a `ConfigurationError`. Check
support at runtime with:

```typescript
if (backend.capabilities.transactions) {
  await store.transaction(async (tx) => { /* ... */ });
} else {
  // fall back to individual operations with manual error handling
}
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
| `prepare()` | `PreparedQuery<T>` | Pre-compile query for repeated execution with parameters |

### Registry Access

#### `store.registry`

Access to the type registry for ontology lookups. The registry is an internal type;
use `store.registry` directly without importing its type.

See [Ontology](/ontology) for registry methods.

## Observability Hooks

TypeGraph supports observability hooks for monitoring and logging store operations.

### `StoreHooks`

Configuration for observability callbacks:

```typescript
import type {
  HookContext,
  QueryHookContext,
  OperationHookContext,
  StoreHooks,
} from "@nicia-ai/typegraph";
```

```typescript
type StoreHooks = Readonly<{
  onQueryStart?: (ctx: QueryHookContext) => void;
  onQueryEnd?: (ctx: QueryHookContext, result: { rowCount: number; durationMs: number }) => void;
  onOperationStart?: (ctx: OperationHookContext) => void;
  onOperationEnd?: (ctx: OperationHookContext, result: { durationMs: number }) => void;
  onError?: (ctx: HookContext, error: Error) => void;
}>;

type HookContext = Readonly<{
  operationId: string;
  graphId: string;
  startedAt: Date;
}>;

type QueryHookContext = HookContext &
  Readonly<{
    sql: string;
    params: readonly unknown[];
  }>;

type OperationHookContext = HookContext &
  Readonly<{
    operation: "create" | "update" | "delete";
    entity: "node" | "edge";
    kind: string;
    id: string;
  }>;
```

> **Note:** Batch operations (`bulkCreate`, `bulkInsert`, `bulkUpsertById`) skip per-item
operation hooks for throughput. Query hooks still fire normally.

**Example:**

```typescript
import { createStore, type StoreHooks } from "@nicia-ai/typegraph";

const hooks: StoreHooks = {
  onQueryStart: (ctx) => {
    console.log(`[${ctx.operationId}] SQL: ${ctx.sql}`);
  },
  onQueryEnd: (ctx, result) => {
    console.log(`[${ctx.operationId}] ${result.rowCount} rows in ${result.durationMs}ms`);
  },
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
// [op-abc123] create node:Person
// [op-abc123] SQL: INSERT INTO ...
// [op-abc123] 1 rows in 2ms
// [op-abc123] Completed in 5ms
```
