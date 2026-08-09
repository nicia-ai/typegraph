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
    annotations?: Readonly<Record<string, JsonValue>>;
  },
): NodeType<K, S>;
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Unique name for this node type |
| `options.schema` | `z.ZodObject` | Zod object schema for node properties |
| `options.description` | `string` | Optional description |
| `options.annotations` | `KindAnnotations` | Optional consumer-owned per-kind annotations. See [Per-kind annotations](#per-kind-annotations). |

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

**With annotations:**

```typescript
const Incident = defineNode("Incident", {
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    occurredAt: z.string().datetime(),
  }),
  annotations: {
    ui: {
      titleField: "title",
      temporalField: "occurredAt",
      icon: "alert-triangle",
    },
    audit: {
      pii: false,
      retentionDays: 365,
    },
  },
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
    annotations?: Readonly<Record<string, JsonValue>>;
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
| `options.annotations` | `KindAnnotations` | Optional consumer-owned per-kind annotations. See [Per-kind annotations](#per-kind-annotations). |
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

**With annotations:**

```typescript
const reportedBy = defineEdge("reportedBy", {
  schema: z.object({ channel: z.string() }),
  from: [Incident],
  to: [Person],
  annotations: {
    ui: { showInTimeline: true, badge: "report" },
  },
});
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
```

**Unconstrained Edges:**

Edges without `from`/`to` are unconstrained — they can connect any node type to any node type:

```typescript
const sameAs = defineEdge("sameAs");
const related = defineEdge("related", {
  schema: z.object({ reason: z.string() }),
});
```

**Direct use in defineGraph:**

Any edge type can be used directly in `defineGraph` without an `EdgeRegistration` wrapper:

```typescript
const graph = defineGraph({
  id: "my_graph",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {
    worksAt,  // Constrained — uses built-in from/to
    sameAs,   // Unconstrained — connects any node to any node
  },
});
```

See [Core Concepts](/core-concepts#domain-and-range-constraints) for detailed documentation on domain/range constraints.

### Per-kind annotations

Both `defineNode` and `defineEdge` accept an optional `annotations` field — a
plain JSON object for consumer-owned, structured per-kind data that doesn't
belong in the Zod schema. Common uses:

- **Generic UI rendering.** Which property is the title for list views? Which
  is the canonical date for sorting? Which icon represents the kind?
- **Audit and compliance hints.** Mark a kind as PII, set retention windows,
  attach data-classification labels.
- **Tooling annotations.** Group kinds in catalogs, mark provenance
  ("originated from agent run X"), attach feature-flag gates.

```typescript
const Incident = defineNode("Incident", {
  schema: z.object({
    title: z.string(),
    occurredAt: z.string().datetime(),
  }),
  annotations: {
    ui: { titleField: "title", temporalField: "occurredAt", icon: "alert-triangle" },
    audit: { pii: false, retentionDays: 365 },
  },
});
```

Reading annotations back from a kind:

```typescript
const titleField = (Incident.annotations?.ui as { titleField?: string })?.titleField;
```

Or from a stored schema:

```typescript
import { getSchemaChanges, getActiveSchema } from "@nicia-ai/typegraph/schema";

const stored = await getActiveSchema(backend, "my_graph");
const incidentMeta = stored?.nodes.Incident?.annotations;
```

**Key guarantees and constraints:**

- **TypeGraph never reads, validates, or interprets keys inside `annotations`.**
  Consumers own the entire namespace — no reserved prefixes, no `x-typegraph`
  extension convention. Future library-owned per-kind state, if needed, will
  use a separate sibling field rather than carving out keys here.
- **Annotations participate in schema hashing and migration diffs.** Changing
  `annotations` bumps the schema version like any other structural change, and
  the diff is reported as a `safe`-severity change per kind. See
  [Schema Evolution](/schema-evolution#changing-annotations).
- **Values must be JSON-serializable.** Strings, numbers, booleans, `null`,
  arrays, and plain objects only. `bigint`, `function`, `symbol`, `undefined`,
  `Date`, `Map`, `Set`, and other class instances are rejected at definition
  time with a `ConfigurationError` so they can never silently break hashing or
  storage round-trips.
- **Default is `undefined`, not `{}`.** Graphs that never set `annotations`
  produce identical canonical-form hashes to graphs from before this field
  existed — adoption requires no migration. An explicit empty object (`{}`)
  is a structural opt-in and bumps the hash.
- **Annotations are not a typed contract.** TypeScript types them as
  `Readonly<Record<string, JsonValue>>`. Wrap reads in your own typed
  accessors at consumer boundaries if you need stronger guarantees.

### `embedding(dimensions, options?)`

Creates a Zod schema for vector embeddings with dimension validation.
Carries optional vector-index configuration that the auto-derivation
pass at `defineGraph()` time reads to produce
`VectorIndexDeclaration` entries — see [Graph Extensions →
Vector indexes](/graph-extensions#vector-indexes) for the full
materialization flow.

```typescript
import { embedding } from "@nicia-ai/typegraph";

function embedding<D extends number>(
  dimensions: D,
  options?: EmbeddingIndexOptions,
): EmbeddingSchema<D>;

type EmbeddingIndexOptions = Readonly<{
  /** Distance metric. Default `"cosine"`. */
  metric?: "cosine" | "l2" | "inner_product";
  /** Vector index implementation. Default `"hnsw"`. */
  indexType?: "hnsw" | "ivfflat" | "none";
  /** HNSW: max connections per layer. Default `16`. */
  m?: number;
  /** HNSW: build-time search depth. Default `64`. */
  efConstruction?: number;
  /** IVFFlat: number of inverted-list partitions. */
  lists?: number;
}>;
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `dimensions` | `number` | Number of dimensions (e.g., 384, 512, 768, 1536, 3072) |
| `options` | `EmbeddingIndexOptions?` | Optional index configuration. Defaults match pgvector recommendations. Pass `{ indexType: "none" }` to opt out of automatic materialization while keeping the embedding column. |

**Example:**

```typescript
// Defaults: cosine similarity, HNSW index, m=16, ef_construction=64.
const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    content: z.string(),
    embedding: embedding(1536), // OpenAI ada-002
  }),
});

// Override at the brand site — this is the load-bearing place to
// signal index intent because the metric usually reflects model
// output (cosine-normalized vs. raw inner-product).
const Image = defineNode("Image", {
  schema: z.object({
    embedding: embedding(512, { metric: "l2", m: 32, efConstruction: 100 }),
  }),
});

// Opt out of automatic materialization while keeping the embedding column.
const Manual = defineNode("Manual", {
  schema: z.object({
    embedding: embedding(384, { indexType: "none" }),
  }),
});

// Optional embeddings work as before — the brand survives `.optional()` /
// `.nullable()` wrappers and auto-derivation walks through them.
const Article = defineNode("Article", {
  schema: z.object({
    content: z.string(),
    embedding: embedding(1536).optional(),
  }),
});
```

See [Semantic Search](/semantic-search) for query usage and
[Graph Extensions](/graph-extensions#vector-indexes) for how the
auto-derived index flows through `materializeIndexes()`.

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
  edges: Record<string, EdgeRegistration | EdgeType>;
  ontology?: OntologyRelation[];
  indexes?: IndexDeclaration[];
  defaults?: {
    onNodeDelete?: DeleteBehavior;
    temporalMode?: TemporalMode;
  };
}): G;
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | Unique identifier for this graph |
| `nodes` | `Record<string, NodeRegistration>` | Node type registrations |
| `edges` | `Record<string, EdgeRegistration \| EdgeType>` | Edge registrations or edge types directly |
| `ontology` | `OntologyRelation[]` | Optional semantic relationships |
| `indexes` | `IndexDeclaration[]` | Optional explicit index declarations from `defineNodeIndex` / `defineEdgeIndex`. Vector indexes are auto-derived from `embedding()` brands; explicit declarations win on `(kind, fieldPath)` collisions. |
| `defaults` | `{ onNodeDelete?, temporalMode? }` | Optional graph-wide defaults. `onNodeDelete` defaults to `"restrict"`; `temporalMode` defaults to `"current"`. |

Edge entries can be:

- **`EdgeRegistration`** — explicit `{ type, from, to }` with optional `cardinality`
- **`EdgeType` with `from`/`to`** — uses built-in constraints
- **`EdgeType` without `from`/`to`** — unconstrained, connects any node to any node

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
    sameAs,  // Unconstrained — any→any
  },
  ontology: [disjointWith(Person, Company)],
});
```

### Graph identity and the kind namespace

`id` is the isolation boundary, and it is the most important operational fact
about a TypeGraph deployment: **kinds are scoped to the `graph_id`** — not to the
module, file, or proposal that declared them.

Everything committed under one `id` shares a single schema document and a single
set of physical collections:

- Two graphs with the **same `id`** share one kind namespace. Committing a graph
  that declares `Invoice` makes `Invoice` part of *that graph's* schema for every
  process that opens it — including ones whose compile-time graph never mentioned
  it. Re-committing a different graph under the same `id` is a **schema change**,
  diffed against what is already committed; it is not a separate scope.
- Two graphs with **different `id`s** are fully independent: separate kind
  namespaces, separate data, separate schema versions. They can hold divergent
  schemas in the same database.

The practical consequence: a namespace *is* a `graph_id`. If you want two units
(tenants, test suites, per-customer graphs) to declare kinds without colliding,
give them different `id`s — do not rely on separate declaration sites, module
boundaries, or naming conventions to isolate them. A shared test database where
every suite commits under one `id` will see those suites fight over one schema.

See [Multi-Tenant Architecture](/integration#multi-tenant-architecture) for
running many `graph_id`s in a single database.

### Pre-flighting a schema change

Committing a schema is a privileged, migration-gated operation — in a
least-privilege deployment the runtime role cannot run DDL at all. Both of these
are **SELECT-only**: they report what a commit *would* do without attempting it.

```typescript
import { classifySchemaChanges } from "@nicia-ai/typegraph/schema";

// Cheapest check: does this need the privileged path at all?
if (await store.requiresMigration()) {
  // Route to the privileged bootstrap instead of failing mid-request.
}

// Or decide additive-vs-incompatible before committing:
const diff = await store.schemaChanges();
const classification =
  diff === undefined ? "uninitialized" : classifySchemaChanges(diff);
// "identical" | "additive" | "incompatible"
```

`requiresMigration()` is `true` when the committed schema is behind the graph
**and** when nothing has been committed yet, since both need the privileged path.

If a commit does fail, branch on the structured outcome rather than the message
text (which is free to be reworded in any release): `MigrationError.details.reason`
is a stable discriminant (`MIGRATION_FAILURE_REASONS`), and `details.diff` carries
the same structured diff — with per-change `severity` — that `getSchemaChanges`
returns. See [Handling Breaking Changes](/schema-management#handling-breaking-changes).

## Store Creation

### `createStore(graph, backend, options?)`

Creates the portable store contract for a graph definition. It contains the
complete TypeGraph API and graph-owned transactions, but deliberately omits
adapter-native handles, caller-owned transaction adoption, and mutable backend
internals. This synchronous factory performs no database I/O, including schema
shape checks. Use an async factory below when startup must verify storage.
Because it carries no committed schema-version metadata, its writes are raw and
are not fenced against concurrent schema changes.

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
| `history` | `boolean` | Enable built-in recorded / system-time capture: every committed TypeGraph node/edge write is captured into the recorded-time relations read by [`store.asOfRecorded(T)`](/queries/temporal#recorded-time-bitemporal) (default: `false`) |
| `recordedRead` | `ExternalRecordedReadSource` | Bind an already-populated recorded relation for `store.asOfRecorded(T)` reads without enabling TypeGraph-managed capture. Must be created with `recordedRelation({ schema })` using a `createSqlSchema(...)` schema; the store validates those factory descriptors at runtime. Use `history: true` when TypeGraph should capture writes and advance `store.recordedNow()`. |
| `schema` | `SqlSchema` | Custom table name configuration created with `createSqlSchema(...)` |
| `queryDefaults.traversalExpansion` | `TraversalExpansion` | Default ontology expansion mode for traversals (default: `"inverse"`) |
| `autoRefreshStatistics` | `false \| number` | Row threshold at which a single autocommit `bulkCreate`/`bulkInsert` triggers an automatic planner-statistics refresh (default: `1000`); `false` disables. See [Refreshing planner statistics](/backend-setup#refreshing-planner-statistics-after-bulk-loads). |
| `coalesceUnchangedUpserts` | `boolean` | Skip the write for an `upsertById` or endpoint get-or-create update whose validated props and requested window already equal the existing live row; bulk forms behave identically (default: `false`). Node `getOrCreateByConstraint` updates are not coalesced; use `upsertById` for replay projectors that must avoid unchanged node history churn. For at-least-once / replay materializers: a byte-identical re-delivery performs no write, no history row, and no revision advance. See [`upsertById`](#upsertbyidid-props-options), [`getOrCreateByEndpoints`](#getorcreatebyendpointsfrom-to-props-options), and [Materializing external event logs](/materializing-event-logs). |

**Example:**

```typescript
const store = createStore(graph, backend);
```

When an application owns an adapter connection and must coordinate native SQL
with TypeGraph, use `createAdapterStore(graph, adapterBackend)` instead. It
returns `AdapterStore<G, TNativeTransaction>`, which adds precisely typed
`tx.sql`, `withTransaction`, `withRecordedTransaction`, and the adapter backend
surface. A plain `GraphBackend` cannot be passed to this factory.

`createAdapterStore` is likewise raw unless passed a cached `{ reconciled }`
snapshot. Writes issued directly through a backend are always outside the Store
schema fence.

Override the default traversal expansion:

```typescript
const store = createStore(graph, backend, {
  queryDefaults: { traversalExpansion: "none" },
});
```

### `createStoreWithSchema(graph, backend, options?)`

Creates a store and ensures the database schema is initialized or migrated.
This is the recommended factory for production use, and it is **required**
for any graph with `searchable()` fields: it durably materializes the
fulltext storage. Bare `createStore()` does not, and the first fulltext
operation against an uninitialized database throws
`StoreNotInitializedError`.

With `history: true`, the async open also verifies the recorded node, edge, and
clock column shapes before returning. Databases created by the timestamp-only
recorded-time preview must run `migrateLegacyRecordedTime({ backend })` first;
an unmigrated schema throws a typed `ConfigurationError` with
`details.code === "RECORDED_SCHEMA_INCOMPATIBLE"` at open rather than on the
first write.

For an existing history-enabled database that predates identity enablement,
open it once through `createStoreWithSchema(...)` after adding
`defineGraph(...).identity`. Bundled backends provision the identity relations
before the migration preflight. A later missing relation reports
`details.code === "IDENTITY_STORAGE_MISSING"` instead of opening over silently
empty state. Restore a missing assertion ledger from backup. If only the
derived closure is missing, recreate that relation with TypeGraph's standard
DDL, then run `rebuildIdentityClosure()` before serving traffic. Any
`history: true` open of an identity-enabled graph verifies the recorded
identity relation exists and reports `RECORDED_IDENTITY_SCHEMA_MISSING` if it
does not; bundled backends provision it, so this is rare there and more likely
on a custom backend that skipped it. Restore that recorded ledger from backup;
recreating it empty would silently discard identity history. Provision an empty
relation through the backend's privileged setup path only when this is confirmed
first-time identity enablement with no identity history to preserve. Malformed
columns in an existing relation continue to report
`RECORDED_SCHEMA_INCOMPATIBLE`.

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

For `initialized` and `migrated`, the result also includes
`committedRow: SchemaVersionRow`, which is the row TypeGraph just committed.
Most callers can ignore it; it is useful when building schema metadata without
performing another active-schema lookup.

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

Use `createAdapterStoreWithSchema` for the same provisioning behavior with an
`AdapterStore` result. This explicit factory is required for native transaction
adoption or `tx.sql`; schema provisioning alone does not expose adapter
capabilities on the portable `Store`.

#### Schema-managed write fence

A Store is schema-managed when
`store.introspect().schemaVersion !== undefined`. This includes Stores opened by
`createStoreWithSchema`, `createAdapterStoreWithSchema`, `createVerifiedStore`,
or `createVerifiedAdapterStore`; `createAdapterStore(..., { reconciled })`;
Stores returned by `evolve()`; and Stores rebound from an already-managed Store.

The official transactional backends fence and revalidate every managed write
against schema commits. Rechecking matters when adapter-native SQL rolls back to
a savepoint, because PostgreSQL releases row locks acquired after that
savepoint. A custom or non-transactional backend without fence support fails
closed when a managed write is attempted rather than racing. Raw Stores and
direct backend writes remain available when the application deliberately owns
schema/write coordination.

Because a managed Store is pinned to the schema version it opened, use the
Store returned by `evolve()` for every subsequent operation in that request. A
Store captured before the commit is not updated, and its next managed write is
rejected by this fence. See
[Store lifetime after a schema commit](/schema-management#store-lifetime-after-a-schema-commit)
for the `StoreRef` and cross-process cache patterns.

## Store Projection

### `StoreProjection<G, N, E>`

A type-level utility that projects a store's collection surface onto a subset of node and
edge keys. Use this to type reusable helpers that work with any store containing a shared
subgraph.

```typescript
import type { StoreProjection } from "@nicia-ai/typegraph";

type CoreStore = StoreProjection<
  typeof myGraph,
  "Document" | "Chunk",
  "hasChunk"
>;

async function ingestChunk(store: CoreStore, document: Node<typeof Document>, text: string) {
  const chunk = await store.nodes.Chunk.create({ text });
  await store.edges.hasChunk.create(document, chunk);
  return chunk;
}
```

Both `Store<G>` and `TransactionContext<G>` are structurally assignable to a
`StoreProjection` whose keys are a subset of `G`. Node constraint names are erased so the
projection works across graphs that register the same node types with different unique
constraints.

See [Shared Subgraph Helpers](./multiple-graphs#shared-subgraph-helpers) for a full
example with multiple graphs.

## Store API

The store provides typed node and edge collections via `store.nodes.*` and `store.edges.*`.

Every write method below that accepts a `validFrom` option (`create`,
`createFromRecord`, `upsertById`, `upsertByIdFromRecord`, `bulkCreate`,
`bulkInsert`, `bulkUpsertById`, and their edge equivalents) defaults it to
that operation's own creation timestamp when omitted. `validTo` remains
optional and open-ended until set.

The one exception is a row **born already ended**: a write that CREATES a row
while stating a `validTo` at or before its own instant and no `validFrom` stores
**no lower bound** ("ended at T, start unknown") rather than a start after its
own end, and `meta.validFrom` reads back as `undefined`. Such a row is visible at
every `asOf` coordinate before its end and at none after it. A `validTo` in the
future is unaffected — it still stamps the creation timestamp, so the row is
invisible at instants before it existed.

The exception follows the API, not the row's prior state. Every **node** create
path takes it, including a `create`, `bulkCreate`, or `bulkInsert` whose id names
a tombstone: that call resurrects the row and reaches the same stored shape a
fresh id would — no lower bound, `meta.validFrom` back as `undefined`. An edge
create never lands on a tombstone — a taken id raises `Edge already exists`, and
a tombstoned edge is reachable again only through `bulkUpsertById` or
`getOrCreateByEndpoints`. A **resurrecting upsert** does not take it. `upsertById` / `bulkUpsertById` on a tombstoned node
resets the window and judges a lone historical `validTo` against the resurrection
instant, refusing it; `bulkUpsertById` and `getOrCreateByEndpoints` on a
tombstoned edge retain the bound that row already carries and judge the stated
`validTo` against that. Pass `validFrom` alongside a historical `validTo` when an
upsert may land on a tombstone.

Writes that accept a validity-end mutation have three explicit states: omit both
fields to preserve the stored end, pass `{ validTo }` to set or move it, or pass
`{ clearValidTo: true }` to remove it and reopen the window. `validTo` and
`clearValidTo` are mutually exclusive. Clearing is supported by node `update`,
`upsertById`, `upsertByIdFromRecord`, and `bulkUpsertById`, plus edge `update`,
`bulkUpsertById`, and both endpoint get-or-create forms.

A window may not have negative width. Stating both endpoints out of order, or
updating a row with a `validTo` that precedes its stored `validFrom`, raises a
`ValidationError` whose issue carries the code `INVERTED_VALIDITY_WINDOW` — such
a row stopped being true before it started, so no `asOf` coordinate could ever
observe it. Two related shapes are legal: a ZERO-width window
(`validTo === validFrom`), which is what a same-instant retraction produces; and
a create carrying only a historical `validTo`, which means "born already ended"
and is read back at any `asOf` coordinate before that end, or through the
`includeEnded` temporal mode.

### Node Collections

Each node type has a collection with these methods:

#### Naming Guidelines

Method names follow what identifier is used to match an existing record:

| If you have... | Read-only | Get-or-create |
|----------------|-----------|---------------|
| ID | `getById` | `upsertById` |
| Unique constraint name + props | `findByConstraint` | `getOrCreateByConstraint` |
| Declared index name + records (candidates) | `bulkFindByIndex` | — |
| Edge endpoints (`from`, `to`) + optional `matchOn` | `findByEndpoints` | `getOrCreateByEndpoints` |

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

When a persisted id crosses an untyped boundary, brand it before passing it to
read/update/delete APIs:

```typescript
const id = asNodeId<typeof Person>(row.personId);
const person = await store.nodes.Person.getById(id);
```

`create({ id })` and `upsertById` still accept plain strings because those are
write surfaces that mint or claim ids.

#### `getByIds(ids)`

Retrieves multiple nodes by ID, returning results in input order with `undefined`
for missing IDs. Costs one statement per bind-limit chunk where the backend
exposes a batch read; where it does not, it falls back to one lookup per distinct
id, issued concurrently.

```typescript
store.nodes.Person.getByIds(
  ids: readonly NodeId<Person>[],
  options?: QueryOptions
): Promise<readonly (Node<Person> | undefined)[]>;
```

When the backend supports batch lookups (`getNodes`), this executes
`SELECT ... WHERE id IN (...)` once per bind-limit chunk — a single statement for
id counts under the limit. Otherwise it falls back to one lookup per distinct id,
issued concurrently rather than sequentially.

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

#### `update(id, props, options?)`

Updates node properties.

```typescript
store.nodes.Person.update(
  id: NodeId<Person>,
  props: Partial<{ name: string; email?: string }>,
  options?: { validTo?: string } | { clearValidTo: true },
): Promise<Node<Person>>;
```

#### `updateWhere(params)`

Updates a set of current, live nodes in one transactional operation and returns
the number of rows changed. A selector is mandatory: provide `where`, one or
more independent `exists` relationship predicates, or the explicit
`all: true` acknowledgement.

```typescript
const result = await store.nodes.Person.updateWhere({
  patch: { active: false },
  where: (person) => person.lastSeen.lt(cutoff),
  exists: [
    {
      edgeKind: "worksAt",
      direction: "out",
      relatedKind: "Company",
      whereRelated: (company) =>
        company.field("status").string().eq("closed"),
    },
  ],
});
// { affectedCount: number }
```

Each `exists` entry is evaluated independently and ANDed with the other
selectors. The patch is shallow: values replace top-level properties, explicit
`null` is preserved, and `undefined` removes an optional property. TypeGraph
validates every complete after-image and updates uniqueness, fulltext, vector,
history, and revision state in the same transaction. If any row or sidecar is
invalid, the whole update rolls back. Backends without transactional set-write
and batched sidecar support reject the operation before writing.

`updateWhere()` is current-state only and is intentionally unavailable on a
`StoreView`. Use `all: true` for an intentional whole-kind update:

```typescript
await store.nodes.Person.updateWhere({
  patch: { needsBackfill: false },
  all: true,
});
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

#### `find(filter?, temporal?)`

Finds nodes of this kind with optional filtering and pagination. The temporal
coordinate is a separate second argument (`temporalMode` / `asOf`), so the
filter object never mixes filtering with temporal scope.

```typescript
store.nodes.Person.find(
  filter?: {
    where?: (accessor) => Predicate;
    limit?: number;
    offset?: number;
  },
  temporal?: { temporalMode?: TemporalMode; asOf?: string },
): Promise<Node<Person>[]>;
```

The optional `where` predicate uses the same accessor API as `whereNode()` in the query builder:

```typescript
const activeUsers = await store.nodes.Person.find({
  where: (p) => p.status.eq("active"),
  limit: 50,
});

// Pass the temporal coordinate as the second argument.
const asOfLastYear = await store.nodes.Person.find(
  { where: (p) => p.status.eq("active") },
  { temporalMode: "asOf", asOf: "2024-01-01T00:00:00.000Z" },
);
```

#### `count(temporal?)`

Counts nodes of this kind (excluding soft-deleted nodes). Accepts the same
optional temporal coordinate as `find`.

```typescript
store.nodes.Person.count(temporal?: {
  temporalMode?: TemporalMode;
  asOf?: string;
}): Promise<number>;
```

#### `createFromRecord(data, options?)`

Creates a node from untyped data, relying on runtime Zod validation. Use this for
dynamic dispatch (changesets, migrations, imports) where the data shape is determined
at runtime, not compile time. The return type is fully typed — only the input gate is relaxed.

```typescript
store.nodes.Person.createFromRecord(
  data: Record<string, unknown>,
  options?: { id?: string; validFrom?: string; validTo?: string }
): Promise<Node<Person>>;
```

```typescript
// Data arrives from an external source at runtime
const importedRow: Record<string, unknown> = JSON.parse(line);
const person = await store.nodes.Person.createFromRecord(importedRow);
// person is fully typed as Node<Person>
```

#### `upsertById(id, props, options?)`

Creates or updates a node by ID.

```typescript
store.nodes.Person.upsertById(
  id: string,
  props: { name: string; email?: string },
  options?: {
    validFrom?: string;
    validTo?: string;
    clearValidTo?: true;
    onImmutableLowerBound?: "refuse" | "preserve";
  }
): Promise<Node<Person>>;
```

**Behavior:**

- Creates a new node if no node with the ID exists
- Updates the existing node if one exists
- Un-deletes soft-deleted nodes (clears `deletedAt`)

**Coalescing unchanged upserts.** When the store is created with
[`coalesceUnchangedUpserts: true`](#createstoregraph-backend-options), an upsert
whose validated props are value-identical to the existing **live** row performs
**no write at all** — no update, no recorded history row, no revision-anchor
advance, and no `update` operation hooks — and resolves with the existing node
(its original `validFrom` / `updatedAt` / `version`). Enable it for
at-least-once / replay materializers, where a byte-identical re-delivery would
otherwise rewrite every row and grow recorded history by one per delivery. A
write still happens (never coalesced) when the row is soft-deleted (an upsert
resurrects it), when an explicit `validFrom` / `validTo` MOVES the window the row
already holds, or when any prop differs after Zod normalization. Re-stating the
window a row already holds — including clearing an already-open end — coalesces
like any other unchanged value after backend capability validation, and a
`validFrom` naming a bound a live row does not hold is refused rather than
written (see
[Immutable validity lower bounds](/errors/#immutable_validity_lower_bound)) —
with this option on or off, because coalescing must not decide whether an
unappliable or malformed bound is reported. The default is off, because some
consumers want an audit row per re-delivery as proof the event was reprocessed.
In a receipt, a coalesced upsert still counts as one write intent
(`writes.total`) but captures nothing (`recorded` stays `undefined`) — the same
shape as a no-op delete.

**Create-only event time.** The default
`onImmutableLowerBound: "refuse"` treats `validFrom` as an assertion on every
branch. Event projectors that carry the source start on every revision can use
`"preserve"`: create and resurrection still validate and store `validFrom`,
while a live-row update preserves the bound already stored and applies the new
props and `validTo`. This is an explicit branch policy, not a silent drop, and
avoids catching `IMMUTABLE_VALIDITY_LOWER_BOUND` as normal control flow.

#### `upsertByIdFromRecord(id, data, options?)`

Upserts a node from untyped data, relying on runtime Zod validation. Same behavior
as `upsertById` but accepts `Record<string, unknown>` instead of the typed schema input.

```typescript
store.nodes.Person.upsertByIdFromRecord(
  id: string,
  data: Record<string, unknown>,
  options?: {
    validFrom?: string;
    validTo?: string;
    clearValidTo?: true;
    onImmutableLowerBound?: "refuse" | "preserve";
  }
): Promise<Node<Person>>;
```

```typescript
// Pre-seeded ID with dynamic data from a changeset
const run = await store.nodes.Run.upsertByIdFromRecord(
  prepared.runId,
  { status: "running", ...dynamicConfig },
);
```

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
    clearValidTo?: true;
    onImmutableLowerBound?: "refuse" | "preserve";
  }[]
): Promise<Node<Person>[]>;
```

With [`coalesceUnchangedUpserts: true`](#createstoregraph-backend-options) the
dirty-check is applied per item: value-identical items are skipped from the
write batch but still appear in the returned array (the existing node, in input
order). See [`upsertById`](#upsertbyidid-props-options).

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

#### `findByConstraint(constraintName, props)`

Looks up a node by a named uniqueness constraint without creating.
Returns the matching node or `undefined`. Soft-deleted nodes are excluded.

```typescript
store.nodes.Person.findByConstraint(
  constraintName: string,
  props: { name: string; email?: string }
): Promise<Node<Person> | undefined>;
```

```typescript
const alice = await store.nodes.Person.findByConstraint("email", {
  email: "alice@example.com",
  name: "Alice",
});

if (alice) {
  console.log(alice.id, alice.name);
}
```

Throws `NodeConstraintNotFoundError` if the constraint name is not defined on the node type.

#### `bulkFindByConstraint(constraintName, items)`

Batch version of `findByConstraint`. Returns results in input order,
with `undefined` for non-matches. Deduplicates within-batch lookups automatically.

```typescript
store.nodes.Person.bulkFindByConstraint(
  constraintName: string,
  items: readonly { props: { name: string; email?: string } }[]
): Promise<(Node<Person> | undefined)[]>;
```

```typescript
const results = await store.nodes.Person.bulkFindByConstraint("email", [
  { props: { email: "alice@example.com", name: "Alice" } },
  { props: { email: "nobody@example.com", name: "Nobody" } },
  { props: { email: "bob@example.com", name: "Bob" } },
]);
// results[0]: Node<Person> (Alice)
// results[1]: undefined
// results[2]: Node<Person> (Bob)
```

#### `bulkFindByIndex(indexName, items, options?)`

Batched candidate retrieval against a **declared node index** (from
[`defineNodeIndex`](/performance/indexes)). For each input record, returns the
live nodes that share its declared index key. Unlike `bulkFindByConstraint`,
the index may be **non-unique**, so each input yields a (possibly empty) array
rather than a single optional node — this is candidate discovery (import
reconciliation, dedup candidates, joining records by a composite key), not a
uniqueness guarantee. For unique lookups prefer `bulkFindByConstraint`.

```typescript
store.nodes.Person.bulkFindByIndex(
  indexName: string,
  items: readonly { props: Partial<{ name: string; email?: string }> }[],
  options?: { limitPerInput?: number }
): Promise<readonly Node<Person>[][]>;
```

```typescript
// Index: defineNodeIndex(Person, { name: "by_tenant", fields: ["tenantId"] })
const candidates = await store.nodes.Person.bulkFindByIndex("by_tenant", [
  { props: { tenantId: "t1" } },
  { props: { tenantId: "t2" } },
]);
// candidates[0]: Node<Person>[]  (everyone in t1)
// candidates[1]: Node<Person>[]  (everyone in t2)
```

Semantics: one bucket per input in input order (empty input → `[]`); live,
non-soft-deleted nodes only; buckets ordered by node id; only `index.fields`
are used (not `coveringFields` or `keySystemColumns`), with the index's
partial `where` applied to stored rows. A missing/`undefined` indexed field
matches stored `NULL`.

- `options.limitPerInput` caps each bucket (positive integer); unbounded by
  default. On backends without SQL window functions
  (`capabilities.windowFunctions: false`) the cap is applied in memory rather
  than via `ROW_NUMBER()` — same result.
- Throws `NodeIndexNotFoundError` for an unknown index, `ConfigurationError`
  for an index declared without `fields` (only `coveringFields` and/or
  `keySystemColumns` — nothing to probe by) or for a date-typed key field
  (which can't compare identically across SQLite and PostgreSQL), and
  `ValidationError` for a non-positive `limitPerInput` or a non-scalar probe
  value.

See [Index-backed lookup](/performance/indexes#batched-index-lookup-bulkfindbyindex)
for details.

### Edge Collections

Each edge type has a type-safe collection. The `from` and `to` parameters are
constrained to only accept node types declared in the edge registration.

#### `create(from, to, props)`

Creates an edge. TypeScript enforces valid endpoint types.

```typescript
// Given: worksAt: { type: worksAt, from: [Person], to: [Company] }

store.edges.worksAt.create(
  from: NodeRef<Person>,
  to: NodeRef<Company>,
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
store.edges.worksAt.getById(id: EdgeId<worksAt>): Promise<Edge<worksAt> | undefined>;
```

When a persisted id crosses an untyped boundary, brand it before passing it to
read/update/delete APIs:

```typescript
const id = asEdgeId<typeof worksAt>(row.edgeId);
const edge = await store.edges.worksAt.getById(id);
```

Edge write APIs that mint ids still accept plain strings.

#### `getByIds(ids)`

Retrieves multiple edges by ID, returning results in input order with `undefined`
for missing IDs. Costs one statement per bind-limit chunk where the backend
exposes a batch read (`getEdges`); where it does not, it falls back to one lookup
per distinct id, issued concurrently.

```typescript
store.edges.worksAt.getByIds(
  ids: readonly EdgeId<worksAt>[],
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
  id: EdgeId<worksAt>,
  props: Partial<{ role: string }>,
  options?: { validTo?: string } | { clearValidTo: true }
): Promise<Edge<worksAt>>;
```

#### `findFrom(from, options?)`

Finds edges from a node. Honors the same temporal model as `getById` / `find`:
with no `options`, the graph's default `temporalMode` applies (so under the
default `"current"` mode, edges outside their `validFrom` / `validTo` window are
excluded). Pass `temporalMode` / `asOf` to read the endpoint's edges at another
coordinate — e.g. `{ temporalMode: "includeEnded" }` for every non-deleted edge.

```typescript
store.edges.worksAt.findFrom(
  from: NodeRef<Person>,
  options?: { temporalMode?: TemporalMode; asOf?: string }
): Promise<Edge<worksAt>[]>;
```

#### `findTo(to, options?)`

Finds edges to a node. Temporal semantics mirror `findFrom`.

```typescript
store.edges.worksAt.findTo(
  to: NodeRef<Company>,
  options?: { temporalMode?: TemporalMode; asOf?: string }
): Promise<Edge<worksAt>[]>;
```

#### `bulkFindFrom(froms, options?)` / `bulkFindTo(tos, options?)`

Finds the edges of a **set** of endpoints in one read. This is `findFrom` /
`findTo` with the endpoint predicate widened from `from_id = ?` to
`from_id IN (...)` — the same index prefix seek, the same temporal model, the
same per-endpoint ordering — so a page of N nodes costs one statement per
endpoint kind and bind-budget chunk instead of N singleton statements.

Results are grouped per input: index `i` of the returned array holds the edges
of `froms[i]`, an endpoint with no edges gets an empty array, and repeated
inputs each get their own copy. Pass `limitPerInput` to bound each endpoint's
fan-out; it keeps the leading edges of that endpoint's `findFrom` order. Large
inputs are transparently split across statements to respect the backend's
bound-parameter budget.

Requires a backend that implements the `findEdgesByEndpointSet` operation —
both bundled Drizzle backends do. On a custom backend without it, these
methods throw a `ConfigurationError` instead of falling back to one
`findFrom` per input: a caller reaching for a bulk read is asking for a
set-oriented read, so quietly issuing N singleton statements would be the cost
surprise the method exists to remove. Loop over `findFrom` / `findTo` yourself
if that trade is fine.

```typescript
store.edges.worksAt.bulkFindFrom(
  froms: readonly NodeRef<Person>[],
  options?: { temporalMode?: TemporalMode; asOf?: string; limitPerInput?: number }
): Promise<readonly Edge<worksAt>[][]>;
```

```typescript
const people = await store.nodes.Person.find({ limit: 50 });
const jobsPerPerson = await store.edges.worksAt.bulkFindFrom(people);
// jobsPerPerson[i] holds the worksAt edges of people[i]
```

#### `store.bulkFindEdgesFrom(params, options?)`

Reads multiple edge kinds from heterogeneous source kinds through one set-oriented backend
operation. The result preserves source-group and ID order, includes an empty `edges` array for a
source with no matches, and preserves repeated source references as separate result entries.

The bundled SQLite and PostgreSQL backends issue one statement per bind-budget chunk, independent
of the number of licensed `(source kind, edge kind)` combinations. `limitPerInput` bounds each
source's fan-out. Temporal options have the same meaning as edge-collection reads, and
`StoreView.bulkFindEdgesFrom` supplies its pinned coordinate automatically.

```typescript
const results = await store.bulkFindEdgesFrom(
  {
    sources: [
      { kind: "Company", ids: companyIds },
      { kind: "Person", ids: personIds },
    ],
    edgeKinds: ["employs", "owns", "dependsOn"],
  },
  { limitPerInput: 20 },
);

for (const { source, edges } of results) {
  console.log(source.kind, source.id, edges.length);
}
```

The operation validates every dynamic kind against the Store's graph. It requires a backend that
implements `findEdgesByHeterogeneousEndpointSet`; a custom backend without that capability gets a
`ConfigurationError` instead of an implicit loop of singleton reads.

#### `batchFindFrom(from, options?)` / `batchFindTo(to, options?)` / `batchFindByEndpoints(from, to, options?)`

Deferred variants of `findFrom`, `findTo`, and `findByEndpoints` for use with
[`store.batch()`](#batch-query-execution). These return a `BatchableQuery` instead of
executing immediately. `batchFindFrom` / `batchFindTo` accept the same temporal
`options` as `findFrom` / `findTo`.

Batching them does not merge the reads — each still costs its own statement, and they share a
connection only when the backend supports transactions. It is not a snapshot: PostgreSQL's default
read-committed isolation lets a later read observe a commit the earlier ones did not. To read edges
for many sources in one statement, traverse from them in a single query.

```typescript
store.edges.worksAt.batchFindFrom(
  from: NodeRef<Person>,
  options?: { temporalMode?: TemporalMode; asOf?: string }
): BatchableQuery<Edge<worksAt>>;
store.edges.worksAt.batchFindTo(
  to: NodeRef<Company>,
  options?: { temporalMode?: TemporalMode; asOf?: string }
): BatchableQuery<Edge<worksAt>>;
store.edges.worksAt.batchFindByEndpoints(
  from: NodeRef<Person>,
  to: NodeRef<Company>,
  options?: { matchOn?: readonly string[]; props?: Partial<{ role: string }> }
): BatchableQuery<Edge<worksAt>>;
```

```typescript
// Execute multiple edge lookups in sequence — one statement each
const [skills, employer] = await store.batch(
  store.edges.hasSkill.batchFindFrom(alice),
  store.edges.worksAt.batchFindFrom(alice),
);
```

`batchFindByEndpoints` returns a 0-or-1 element array (matching the at-most-one semantics of `findByEndpoints`).

#### `find(filter?, temporal?)`

Finds edges with endpoint filtering. The temporal coordinate is a separate
second argument, mirroring `store.nodes.<kind>.find`.

```typescript
store.edges.worksAt.find(
  filter?: {
    from?: NodeRef<Person>;
    to?: NodeRef<Company>;
    limit?: number;
    offset?: number;
  },
  temporal?: { temporalMode?: TemporalMode; asOf?: string },
): Promise<Edge<worksAt>[]>;
```

For edge property filters, use the query builder with `whereEdge(...)`.

#### `count(filter?, temporal?)`

Counts edges matching filters.

```typescript
store.edges.worksAt.count(
  filter?: {
    from?: NodeRef<Person>;
    to?: NodeRef<Company>;
  },
  temporal?: { temporalMode?: TemporalMode; asOf?: string },
): Promise<number>;
```

#### `delete(id)`

Soft-deletes an edge.

```typescript
store.edges.worksAt.delete(id: EdgeId<worksAt>): Promise<void>;
```

#### `hardDelete(id)`

Permanently deletes an edge. This is irreversible and should be used carefully.

```typescript
store.edges.worksAt.hardDelete(id: EdgeId<worksAt>): Promise<void>;
```

#### `bulkCreate(items)`

Creates multiple edges efficiently. Uses a single multi-row INSERT when the backend supports it.

```typescript
store.edges.worksAt.bulkCreate(
  items: readonly {
    from: NodeRef<Person>;
    to: NodeRef<Company>;
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
    from: NodeRef<Person>;
    to: NodeRef<Company>;
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
  ids: readonly EdgeId<worksAt>[]
): Promise<void>;
```

#### `bulkUpsertById(items)`

Creates or updates multiple edges by ID.

```typescript
store.edges.worksAt.bulkUpsertById(
  items: readonly {
    id: EdgeId<worksAt>;
    from: NodeRef<Person>;
    to: NodeRef<Company>;
    props?: { role: string };
    validFrom?: string;
    validTo?: string;
    clearValidTo?: true;
  }[]
): Promise<Edge<worksAt>[]>;
```

#### `getOrCreateByEndpoints(from, to, props, options?)`

Looks up an existing edge by endpoints (and optionally by property fields via `matchOn`).
Returns the match if found, or creates a new edge if not.

```typescript
store.edges.worksAt.getOrCreateByEndpoints(
  from: NodeRef<Person>,
  to: NodeRef<Company>,
  props: { role: string },
  options?: {
    matchOn?: readonly ("role")[]; // Default: []
    ifExists?: "return" | "update"; // Default: "return"
    validFrom?: string;
    validTo?: string;
    clearValidTo?: true;
    onImmutableLowerBound?: "refuse" | "preserve"; // Default: "refuse"
  }
): Promise<{
  edge: Edge<worksAt>;
  action: "created" | "found" | "updated" | "resurrected";
}>;
```

`validFrom` applies when the operation creates or resurrects the edge. On an
`"updated"` live match, `onImmutableLowerBound: "preserve"` treats it as
create/resurrection-only input: the stored start remains unchanged while props
and `validTo` are applied. The default `"refuse"` policy instead refuses a
`validFrom` naming a different instant; restating the bound the edge already
holds is accepted. See
[Immutable validity lower bounds](/errors/#immutable_validity_lower_bound).
On a resurrection, naming `validFrom` asserts the COMPLETE window: an
accompanying `validTo` is applied, and an omitted one reopens the revived row
rather than keeping the tombstoned incarnation's end. `validTo` applies when
the edge is created, updated, or resurrected, and may not precede the row's
effective start — see
[Inverted validity windows](/errors/#inverted_validity_window). When `ifExists`
is omitted or `"return"`, a live match produces the `"found"` action and neither
temporal option changes the edge.
`clearValidTo` is the exception: a live match can apply it only under
`ifExists: "update"`. Supplying it with the default/`"return"` mode refuses with
`ConfigurationError` code `CLEAR_VALID_TO_REQUIRES_UPDATE` instead of silently
returning an ended edge. A create or tombstone resurrection can still apply the
clear request.

With `coalesceUnchangedUpserts: true`, an `ifExists: "update"` match whose
validated props and requested validity bounds already equal the live edge is a
no-op. It returns the existing edge with action `"found"`; action `"updated"`
therefore always means an UPDATE ran. The same rule applies per item to
`bulkGetOrCreateByEndpoints`. Confirming that no-op requires the endpoint
match-key convergence fence; a top-level backend without transactions refuses
it with `CONSTRAINT_WRITE_FENCE_UNSUPPORTED` rather than eliding the write from
an unfenced read.

#### `bulkGetOrCreateByEndpoints(items, options?)`

Batch version of `getOrCreateByEndpoints`. Returns results in input order.

```typescript
store.edges.worksAt.bulkGetOrCreateByEndpoints(
  items: readonly {
    from: NodeRef<Person>;
    to: NodeRef<Company>;
    props: { role: string };
    validFrom?: string;
    validTo?: string;
    clearValidTo?: true;
    onImmutableLowerBound?: "refuse" | "preserve";
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

Temporal fields and `onImmutableLowerBound` belong to each item so identities
with different endpoints or `matchOn` values can carry independent validity
windows and lower-bound policies in one batch. Items with the same
endpoint-plus-`matchOn` identity are duplicates: the first item supplies the
write values and later items return that edge with the `"found"` action. To
represent multiple periods between the same endpoints, add a stable period or
source-event field to the edge schema and include it in `matchOn`. Their create,
update, and resurrection semantics otherwise match the single operation.

#### `findByEndpoints(from, to, options?, temporal?)`

Looks up an edge by its endpoints without creating. Returns the matching edge or
`undefined`. Honors the same temporal model as `findFrom` / `findTo`: with no
`temporal` argument the graph's default `temporalMode` applies (so under the
default `"current"` mode, edges outside their validity window are excluded). Pass
`temporalMode` / `asOf` to look up the edge as of another coordinate.

When `matchOn` is omitted, returns the first matching edge between the two endpoints.
When `matchOn` is provided, filters by the specified property fields.

```typescript
store.edges.knows.findByEndpoints(
  from: NodeRef<Person>,
  to: NodeRef<Person>,
  options?: {
    matchOn?: readonly ("relationship" | "since")[];
    props?: Partial<{ relationship: string; since: string }>;
  },
  temporal?: { temporalMode?: TemporalMode; asOf?: string },
): Promise<Edge<knows> | undefined>;
```

```typescript
// Find any edge between Alice and Bob
const edge = await store.edges.knows.findByEndpoints(alice, bob);

// Find the specific "colleague" edge between Alice and Bob
const colleague = await store.edges.knows.findByEndpoints(alice, bob, {
  matchOn: ["relationship"],
  props: { relationship: "colleague" },
});
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

#### Transaction receipts

Use `store.transactionWithReceipt()` when a caller needs a write summary
without wrapping the transaction context itself. It runs the callback exactly
like `store.transaction()` and returns the result together with a receipt:

```typescript
const outcome = await store.transactionWithReceipt(async (tx) => {
  const alice = await tx.nodes.Person.create({ name: "Alice" });
  const bob = await tx.nodes.Person.create({ name: "Bob" });
  await tx.edges.knows.getOrCreateByEndpoints(alice, bob, {
    since: "2026",
  });
  return alice.id;
});

outcome.result; // Alice's id
outcome.receipt.writes; // { nodes: { Person: 2 }, edges: { knows: 1 }, total: 3 }
outcome.receipt.recorded; // RecordedInstant | undefined
```

Receipt counts are completed write intents at the collection surface, not rows
affected:

- Every successful completion of a write method on `tx.nodes.*` / `tx.edges.*`
  counts. The authoritative method list is `NodeWrites` / `EdgeWrites`.
- Bulk methods count by input length; an empty bulk call (`bulkCreate([])`)
  counts 0.
- Single-row methods count 1 on resolve — including `delete` of an absent id and
  `getOrCreate*` that found an existing row. Consumers that need "did anything
  actually change" semantics apply their own per-operation policy.
- A method that rejects counts 0 — even when the backend applied part of a bulk
  input before failing. On SQLite a failed statement does not abort the
  surrounding transaction, so a caller that catches the rejection and commits
  can persist rows the receipt never counted. Do not read the receipt as
  rows-affected in that scenario.
- A node `delete` under `cascade` / `disconnect` removes connected edges through
  the backend, not the edge-collection surface; those removals do not appear in
  `edges`.
- Rows-affected fidelity is intentionally out of scope for this first version; a
  future extension could ask backends to return row counts.

When the store was created with `{ history: true }` and the transaction flushed
captured writes, `receipt.recorded` is the recorded commit instant allocated for
this store's graph by this transaction. It is `undefined` when history capture is
off, the transaction is read-only, or no captured writes were flushed. Writes
that bypass the transaction collection surface — direct backend writes, raw SQL,
and import helpers — are not counted. `store.withRecordedTransaction()` — the
adopted-commit path for history stores — returns the same `TransactionOutcome`,
so the exactly-once cursor pattern gets a receipt too (see
[Recorded time](/queries/temporal/#raw-sql-under-history-capture)); only
`withTransaction`, whose commit belongs entirely to the caller with no flush
point, produces no receipt. On a raw Store backed by a non-transactional driver,
a receipt describes operations that individually committed; if the callback
rejects there, no receipt is returned even though earlier operations committed.
A schema-managed Store instead fails closed on its first write because it cannot
hold the schema-version fence.

##### Scoped receipts: `tx.measure()`

The context handed to `transactionWithReceipt` and `withRecordedTransaction`
also exposes `tx.measure(fn)`. It runs `fn` with a **scoped context** — a second
view over the same transaction — and returns a `TransactionOutcome` whose receipt
counts exactly the writes made **through that scoped context**
(`scoped.nodes` / `scoped.edges`). This lets a framework attribute writes to user
code it invoked (for example, an event-log materializer measuring
`project(scoped, change)` to detect a change that wrote nothing) while its own
bookkeeping — written through the outer `tx` — stays out of that count:

```typescript
await store.transactionWithReceipt(async (tx) => {
  const projected = await tx.measure((scoped) => project(scoped, change));
  if (projected.receipt.writes.total === 0 && change.operation !== "delete") {
    throw new DroppedChangeError(change); // the projector dropped the change
  }
  await tx.nodes.Cursor.upsertById("s1", { offset: change.offset }); // outer tx — not in `projected`
});
```

Attribution is by **which context you write through**, not by timing. A write
through the scoped context counts in both the scope and the outer receipt (it
happened in the transaction); a write through the outer `tx` during the scope
counts only in the outer receipt. This makes overlapping and concurrent measures
safe by construction — two scopes racing under `Promise.all`, each writing
through its own scoped context, never cross-count. Nesting composes:
`scoped.measure(...)` opens a child scope that chains up through its ancestors.
A scoped receipt's `recorded` is **always `undefined`** — the recorded instant is
a per-transaction flush concern, unknowable mid-transaction. Plain
`store.transaction()` contexts have no `measure` (no receipt is being produced).

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

Not all backends support atomic transactions. Cloudflare D1 and
`drizzle-orm/neon-http` cannot hold a multi-statement session and report
`capabilities.transactions: false`. A schema-managed Store fails closed before
writing on these backends because it cannot hold the schema fence. On a raw
Store, `store.transaction(fn)` still runs — `fn` executes against the same
backend used outside `transaction()`, sequentially — **but writes are applied
as they happen and a thrown error does not roll back earlier writes inside the
callback**. If you require atomicity or version fencing, branch on the
capability:

```typescript
if (store.capabilities.transactions) {
  await store.transaction(async (tx) => { /* atomic */ });
} else {
  // Raw Store only: sequential, non-atomic, and not schema-fenced.
}
```

See [Limitations](/limitations#backends-without-atomic-transactions) for
the full list of affected backends and edge-runtime alternatives.

### Clear

#### `store.clear()`

Hard-deletes all data for the current graph: nodes, edges, uniqueness entries,
embeddings, and schema versions. Resets collection caches so the store is
immediately reusable.

```typescript
store.clear(): Promise<void>;
```

Wrapped in a transaction when the backend supports it. Does not affect other graphs sharing the same backend.

```typescript
// Wipe all data and start fresh
await store.clear();

// Store is immediately reusable, now with raw/unversioned semantics.
const person = await store.nodes.Person.create({ name: "Alice" });
```

Because `clear()` deletes the committed schema rows, it also resets a formerly
managed Store to `introspect().schemaVersion === undefined`. Subsequent writes
are raw and unfenced. Reopen the graph through a managed factory before writing
when the schema-version guarantee is required.

### Batch Query Execution

#### `store.batch(...queries)`

Runs several independent queries in sequence and returns a typed tuple of results preserving input
order — N query executions, never one round trip. Accepts two or more queries (from `.select()`,
set operations, or edge collection `batchFind*` methods), each keeping its own projection,
filtering, sorting, and pagination.

**Cost.** At least one statement per query, sometimes two: a query whose selective-field mapping
falls back re-runs as a full fetch, and that fallback is detected *after* the selective statement
has already executed. It clears the fast path, so a reused query instance pays the double only
once — but the builder is immutable, so a query rebuilt per request pays it every request.

With `backend.capabilities.transactions` the queries share one transaction; how that reaches the
wire is the adapter's business. A SQL backend frames them with `begin`/`commit`, putting a networked
one at N+2 round trips **at best**, while Durable Objects use an ambient storage transaction with no
framing statements. Without transactions there is no framing. Connection reuse is a separate
question from transaction support: the no-transaction path passes the same backend object, so an
adapter may reuse one client there too (see [Limitations](/limitations)). The portable guarantee is
only that at most one query is in flight at a time.

**Not a snapshot — and there is no way to make it one.** PostgreSQL defaults to read-committed
isolation, so a later query in the batch can observe a commit the earlier ones did not.
`store.transaction()` takes an `isolationLevel`, but its context exposes only `nodes` / `edges`:
there is no public way to run a fluent query or a batch inside a transaction, so a snapshot across
fluent queries is **not available today**. Collection reads can have one —
`store.transaction(fn, { isolationLevel: "repeatable_read" })` reading through `tx.nodes` /
`tx.edges` — but only where the backend has transactions (others ignore the option entirely), and a
history-enabled store on PostgreSQL additionally requires `accessMode: "read_only"` or the call
throws.

**Will not fix an N+1.** Serializing N queries does not reduce their number. The alternatives are
set-oriented or chunked rather than fixed-cost: `.traverse()` compiles a whole chain to one
statement; [`store.subgraph()`](#subgraph-extraction) costs 2 statements on SQLite and 3 on
PostgreSQL however large the result; `getByIds()` issues one statement per bind-limit chunk,
falling back to one per distinct id where the backend exposes no batch read; `bulkFindByIndex()`
costs one probe plus that same chunked hydration.

**Versus `Promise.all`.** Workload- and adapter-dependent in both directions. `Promise.all`
overlaps its queries against a pool with idle capacity, but it does not necessarily hold N
connections, and against a single client or a saturated pool it queues. `batch()` keeps at most one
query in flight, so it pays the sum of their latencies — but it can still come out ahead where
connection acquisition dominates. Measure rather than assume.

```typescript
store.batch<R1, R2, ...Rn>(
  q1: BatchableQuery<R1>,
  q2: BatchableQuery<R2>,
  ...qn: BatchableQuery<Rn>,
): Promise<readonly [readonly R1[], readonly R2[], ...readonly Rn[]]>;
```

**Example:**

```typescript
const [people, companies] = await store.batch(
  store
    .query()
    .from("Person", "p")
    .whereNode("p", (p) => p.status.eq("active"))
    .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name })),
  store
    .query()
    .from("Company", "c")
    .select((ctx) => ({ id: ctx.c.id, name: ctx.c.name }))
    .orderBy("c", "name", "asc")
    .limit(5),
);
// people:    readonly { id: string; name: string }[]
// companies: readonly { id: string; name: string }[]
```

**With traversals and mixed projections:**

```typescript
const [skills, artifacts, recentGoals] = await store.batch(
  store
    .query()
    .from("Agent", "a")
    .whereNode("a", (a) => a.id.eq(agentId))
    .traverse("has_skill", "e")
    .to("Skill", "s")
    .select((ctx) => ({ id: ctx.s.id, name: ctx.s.name })),
  store
    .query()
    .from("Agent", "a")
    .whereNode("a", (a) => a.id.eq(agentId))
    .traverse("references", "ref")
    .to("Artifact", "art")
    .select((ctx) => ({
      id: ctx.art.id,
      title: ctx.art.title,
      pin: ctx.ref.activeVersionId,
    })),
  store
    .query()
    .from("Agent", "a")
    .whereNode("a", (a) => a.id.eq(agentId))
    .traverse("has_goal", "e")
    .to("Goal", "g")
    .select((ctx) => ({ id: ctx.g.id, name: ctx.g.name }))
    .orderBy("g", "name", "asc")
    .limit(10),
);
```

**Set operations work too:**

```typescript
const [combined, separate] = await store.batch(
  store
    .query()
    .from("Person", "p")
    .whereNode("p", (p) => p.role.eq("admin"))
    .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }))
    .union(
      store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.role.eq("owner"))
        .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name })),
    ),
  store
    .query()
    .from("Company", "c")
    .select((ctx) => ({ id: ctx.c.id, name: ctx.c.name })),
);
```

**Edge collection lookups:**

```typescript
// Edge batchFind* methods return BatchableQuery — mix freely with fluent queries
const [skills, employer, colleague] = await store.batch(
  store.edges.hasSkill.batchFindFrom(alice),
  store.edges.worksAt.batchFindFrom(alice),
  store.edges.knows.batchFindByEndpoints(alice, bob),
);
```

#### When to use batch() vs alternatives

| Pattern | Use |
|---------|-----|
| Multiple queries with different shapes/filters | `store.batch()` |
| Load entity with all relationships (uniform) | `store.subgraph()` |
| Fixing an N+1 / reducing round trips | `.traverse()` (one statement), `store.subgraph()` (2–3), `getByIds()` (chunked) — not `batch()` |
| Single query | `.execute()` directly |
| Writes interleaved with reads | `store.transaction()` |
| Same-shape queries merged into one result | `.union()` / `.intersect()` / `.except()` |

:::note
`batch()` is read-only. For bulk writes, use `bulkCreate`, `bulkInsert`, or wrap
operations in a `store.transaction()`.
:::

### Subgraph Extraction

#### `store.subgraph(rootId, options)`

Extracts a typed subgraph by performing a BFS traversal from a root node, following
the specified edge kinds. Returns an indexed result with adjacency maps for immediate
traversal.

Under the hood the traversal is a `WITH RECURSIVE` CTE and all the filtering and
hydration happen in the database. The cost is a fixed 2 statements on SQLite
(nodes, edges — each embedding the CTE) and 3 on PostgreSQL (the closure ids
once, then nodes and edges), independent of how much it returns.

```typescript
store.subgraph<EK, NK>(
  rootId: NodeId<AllNodeTypes<G>>,
  options: SubgraphOptions<G, EK, NK>,
): Promise<SubgraphResult<G, NK, EK>>;
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `edges` | `readonly EK[]` | *(required)* | Edge kinds to follow during traversal |
| `maxDepth` | `number` | `10` | Maximum traversal depth from root (capped at `MAX_RECURSIVE_DEPTH`) |
| `includeKinds` | `readonly NK[]` | all kinds | Node kinds to include in the result. Other kinds are traversed through but omitted from output |
| `excludeRoot` | `boolean` | `false` | Exclude the root node from the result |
| `direction` | `"out" \| "both"` | `"out"` | `"out"` follows edges in their defined direction; `"both"` treats edges as undirected |
| `cyclePolicy` | `"prevent" \| "allow"` | `"prevent"` | Whether to detect and skip cycles during traversal |
| `temporalMode` | `TemporalMode` | `graph.defaults.temporalMode` | Filter applied to both nodes and edges along the traversal — same semantics as `store.query()` and collection reads |
| `asOf` | `string` (ISO-8601) | *(none)* | Snapshot timestamp, required when `temporalMode: "asOf"` |
| `project` | `{ nodes?, edges? }` | *(none)* | Per-kind field projection — see [Projection](#subgraph-projection) below |

**Result:**

```typescript
type SubgraphResult<G, NK, EK> = Readonly<{
  root: SubgraphNodeResult<G, NK> | undefined;
  nodes: ReadonlyMap<string, SubgraphNodeResult<G, NK>>;
  adjacency: ReadonlyMap<string, ReadonlyMap<EK, readonly SubgraphEdgeResult<G, EK>[]>>;
  reverseAdjacency: ReadonlyMap<string, ReadonlyMap<EK, readonly SubgraphEdgeResult<G, EK>[]>>;
}>;
```

| Field | Description |
|-------|-------------|
| `root` | The root node, or `undefined` if it was not found or `excludeRoot` is set |
| `nodes` | All reachable nodes keyed by string ID |
| `adjacency` | Forward adjacency: `fromId → edgeKind → edges[]` |
| `reverseAdjacency` | Reverse adjacency: `toId → edgeKind → edges[]` |

Edges are only included when **both** endpoints appear in the result set.
Nodes and edges are filtered by the resolved `temporalMode` — by default,
only currently valid rows participate. Duplicate nodes (reachable via
multiple paths) are deduplicated.

**Example:**

```typescript
const sg = await store.subgraph(run.id, {
  edges: ["has_task", "runs_agent", "uses_skill"],
  maxDepth: 4,
});

// Root node (the traversal starting point)
console.log(sg.root?.kind);

// Lookup by ID
const task = sg.nodes.get(taskId);

// Forward adjacency: edges of a kind from a node
const taskEdges = sg.adjacency.get(String(run.id))?.get("has_task") ?? [];
const tasks = taskEdges.map((edge) => sg.nodes.get(String(edge.toId)));

// Reverse adjacency: edges of a kind pointing to a node
const parentEdges = sg.reverseAdjacency.get(taskId)?.get("has_task") ?? [];

// Narrow by kind with a switch
for (const node of sg.nodes.values()) {
  switch (node.kind) {
    case "Task": {
      console.log(node.title, node.status);
      break;
    }
    case "Agent": {
      console.log(node.model);
      break;
    }
  }
}
```

**Filtering to specific node kinds:**

```typescript
const tasksOnly = await store.subgraph(run.id, {
  edges: ["has_task", "depends_on"],
  includeKinds: ["Task"],
  excludeRoot: true,
});

// tasksOnly.nodes values are typed as Node<typeof Task>
```

**Bidirectional traversal:**

```typescript
// Find all nodes connected to a skill, regardless of edge direction
const neighborhood = await store.subgraph(skill.id, {
  edges: ["uses_skill", "has_task"],
  direction: "both",
  maxDepth: 3,
});
```

#### Subgraph Projection

By default, `subgraph()` returns fully hydrated nodes and edges. The `project` option lets you
specify which properties to keep per kind, reducing payload size and enabling SQL-level field
extraction via `json_extract()` / JSONB paths.

```typescript
const result = await store.subgraph(rootId, {
  edges: ["has_task", "uses_skill"],
  maxDepth: 2,
  project: {
    nodes: {
      Task: ["title", "meta"],
      Skill: ["name"],
    },
    edges: {
      uses_skill: ["priority"],
    },
  },
});
// Task  → { kind, id, title, meta }       — status omitted, compile-time error to access
// Skill → { kind, id, name }
// uses_skill → { id, kind, fromKind, fromId, toKind, toId, priority }
```

**Projection rules:**

- Projected nodes always retain `kind` and `id`; projected edges always retain structural fields
  (`id`, `kind`, `fromKind`, `fromId`, `toKind`, `toId`).
- Kinds omitted from `project` remain fully hydrated.
- Include `"meta"` in the field list for the full metadata object, or omit it entirely. No partial
  metadata selection — the struct is small enough that subsetting adds complexity without savings.
- Node projection keys must exist in `includeKinds` (or be any node kind when `includeKinds` is
  omitted). Edge projection keys must be in `edges`. Out-of-scope keys are a compile-time error.

**Type narrowing:**

Result types narrow per-kind based on the projection. Accessing an omitted field is a
compile-time error:

```typescript
for (const node of result.nodes.values()) {
  if (node.kind === "Task") {
    console.log(node.title);  // OK
    console.log(node.status); // TypeScript error — status was not projected
  }
}
```

#### `defineSubgraphProject()`

When storing a projection config in a variable, TypeScript widens field arrays to `string[]`,
defeating compile-time narrowing. Use `defineSubgraphProject()` to preserve literal types:

```typescript
import { defineSubgraphProject } from "@nicia-ai/typegraph";

const agentProjection = defineSubgraphProject<typeof graph>()({
  nodes: {
    Task: ["title", "status"],
    Skill: ["name"],
  },
  edges: {
    uses_skill: ["priority"],
  },
});

// Reuse across calls — types are preserved
const result = await store.subgraph(rootId, {
  edges: ["has_task", "uses_skill"],
  project: agentProjection,
});
```

#### Choosing a query strategy

TypeGraph offers several ways to load related data. The right choice depends on your access pattern:

| Pattern | Best strategy | Why |
|---------|--------------|-----|
| Load entity with all relationships | `subgraph(maxDepth: 1)` | Fixed 2 SQLite / 3 PostgreSQL statements — recursive traversal cost does not grow with edge count |
| Load entity with deep chain | `subgraph(maxDepth: N)` | Recursive CTE handles multi-hop without extra round trips per hop |
| Filter/sort within a relationship | `.query().traverse()` | Fluent query supports WHERE/ORDER/LIMIT on target nodes, in one statement |
| Multiple independent queries with per-query control | `store.batch()` | Typed tuple results, at most one query in flight — still at least a statement per query, and not a snapshot |
| Check if an edge exists | `edges.X.findFrom()` | Lightweight — no node resolution needed; honors the graph's temporal mode by default |
| Traverse + resolve one edge type | `edges.X.findFrom()` + `nodes.X.getByIds()` | Two queries, simple and explicit; pass `temporalMode` / `asOf` when reading history |
| Shortest path, reachability, neighborhoods, degree | `store.algorithms.*` | Set-based BFS frontier or a single `COUNT` — see [Graph Algorithms](/graph-algorithms) |

**Key insight:** `subgraph()` costs a fixed number of statements — 2 on SQLite (nodes, edges) and 3
on PostgreSQL (closure ids, then nodes and edges) — regardless of how many edge types it traverses
or how much it returns. Parallel `findFrom` calls scale linearly instead: one per edge type, plus
additional queries for node resolution. The gap widens as relationship count grows.

For the common "load an entity and everything it touches" pattern (detail pages, config hydration,
template instantiation), `subgraph()` with `maxDepth: 1` is the fastest approach. When you need
per-query filtering, sorting, or pagination across multiple independent queries, use
[`store.batch()`](#batch-query-execution) — but note it still costs at least a statement per query, so it
does not narrow this gap. Reserve individual fluent queries for one-off operations.

### Graph Algorithms

#### `store.algorithms`

Lazy-initialized facade exposing the graph algorithms —
`shortestPath`, `reachable`, `canReach`, `neighbors`, and `degree`.
See [Graph Algorithms](/graph-algorithms) for the full API; this section
is a quick reference.

```typescript
// Shortest path between two nodes
const path = await store.algorithms.shortestPath(alice, bob, {
  edges: ["knows"],
});

// Every reachable node with its discovery depth
const reachable = await store.algorithms.reachable(alice, {
  edges: ["knows"],
  maxHops: 5,
});

// Fast boolean reachability check
const connected = await store.algorithms.canReach(alice, bob, {
  edges: ["knows"],
});

// k-hop neighborhood (source excluded)
const twoHop = await store.algorithms.neighbors(alice, {
  edges: ["knows"],
  depth: 2,
});

// Count incident edges
const total = await store.algorithms.degree(alice, { edges: ["knows"] });
```

Every traversal algorithm accepts `edges`, `maxHops` (default 10),
`direction` (`"out" | "in" | "both"`, default `"out"`), and the
compatibility-only `cyclePolicy`, plus `temporalMode` / `asOf` for temporal
filtering — see [Temporal Behavior](/graph-algorithms#temporal-behavior).
Traversal calls expand a de-duplicated BFS frontier one level at a time;
`degree` compiles to a single `COUNT`. Node arguments accept either raw IDs or
any object with an `id` field — `Node`, `NodeRef`, and the lightweight records
returned by these algorithms all work.

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
| `prepare()` | `PreparedQuery<T>` | Validate query AST once for repeated execution with different parameters |

#### `store.batch(...queries)`

Run several queries in sequence — at least a statement each, never one round trip. See
[Batch Query Execution](#batch-query-execution).

### Dynamic Collection Access

The typed `store.nodes.*` and `store.edges.*` accessors require the kind name at compile
time. When the kind is determined at runtime — iterating all kinds, resolving a node from
edge metadata, building admin UIs or snapshot tools — use `getNodeCollection` and
`getEdgeCollection` instead.

#### `store.getNodeCollection(kind)`

Returns the [`DynamicNodeCollection`](/types#dynamicnodecollection) for the given kind, or
`undefined` if the kind is not registered in this graph.

```typescript
import { getNodeKinds } from "@nicia-ai/typegraph";

// Count every node kind
const counts: Record<string, number> = {};
for (const kind of getNodeKinds(graph)) {
  const collection = store.getNodeCollection(kind);
  if (collection) {
    counts[kind] = await collection.count();
  }
}

// Resolve a node from edge metadata
const collection = store.getNodeCollection(edge.fromKind);
const node = await collection?.getById(edge.fromId);
```

#### `store.getEdgeCollection(kind)`

Returns the [`DynamicEdgeCollection`](/types#dynamicedgecollection) for the given kind, or
`undefined` if the kind is not registered in this graph.

```typescript
import { getEdgeKinds } from "@nicia-ai/typegraph";

// Snapshot all edges
for (const kind of getEdgeKinds(graph)) {
  const collection = store.getEdgeCollection(kind);
  if (collection) {
    const edges = await collection.find({ limit: 10_000 });
    snapshot.push(...edges);
  }
}
```

The returned collections expose the full API (`create`, `getById`, `find`, `count`,
`createFromRecord`, etc.) with widened generics — see
[`DynamicNodeCollection`](/types#dynamicnodecollection) and
[`DynamicEdgeCollection`](/types#dynamicedgecollection).

### Dynamic Props Schema Access

Returns the live `z.ZodObject` the store uses internally to validate `.create()` /
`.update()` props. Same accessor for compile-time and graph-extension kinds. Useful
for MCP tool wrappers that want to validate inputs against the same schema as the
store, and for producing richer JSON Schema (refinements, formats, branded
`searchable()` / `embedding()` types) than `introspect().properties` exposes.

```typescript
store.getNodePropsSchema(kind: string): z.ZodObject<z.ZodRawShape> | undefined;
store.getNodePropsSchemaOrThrow(kind: string): z.ZodObject<z.ZodRawShape>;
store.getEdgePropsSchema(kind: string): z.ZodObject<z.ZodRawShape> | undefined;
store.getEdgePropsSchemaOrThrow(kind: string): z.ZodObject<z.ZodRawShape>;
```

`Object.hasOwn`-gated lookup matches `getNodeCollection` (no prototype-name leakage).
The `OrThrow` variants throw `KindNotFoundError` with `kindName`, `entity`, and host
`graphId` when the kind is not registered. Identity holds for compile-time kinds:
`store.getNodePropsSchema("Person") === Person.schema`.

```typescript
import { z } from "zod";

const schema = store.getNodePropsSchemaOrThrow("Paper");

// Validate tool input with the same schema the store uses.
const parsed = schema.parse(input);
await store.getNodeCollectionOrThrow("Paper").create(parsed);

// Produce JSON Schema for an MCP tool description.
const jsonSchema = z.toJSONSchema(schema);
```

**Props-only contract.** These accessors return only the props validator. Failed
`schema.parse()` throws `ZodError`; failed `collection.create()` wraps the same
underlying issues in `ValidationError`. Operation-level checks — uniqueness,
endpoint resolution (edges validate endpoints before props), temporal validity,
backend constraints — still run only through `collection.create` / `update`.

### Registry Access

#### `store.registry`

Access to the type registry for ontology lookups. The registry is an internal type;
use `store.registry` directly without importing its type.

See [Ontology](/ontology) for registry methods.

### Search (`store.search`)

Search operations are grouped under the `store.search` facade. The full
guide lives in [Fulltext Search](/fulltext-search); this section is the
signature reference.

```typescript
store.search.fulltext(nodeKind, options): Promise<readonly FulltextSearchHit<Node<K>>[]>;
store.search.hybrid(nodeKind, options): Promise<readonly HybridSearchHit<Node<K>>[]>;
store.search.rebuildFulltext(nodeKind?, options?): Promise<RebuildFulltextResult>;
```

#### `store.search.fulltext(nodeKind, options)`

Runs a ranked fulltext query against nodes of the given kind. Requires
at least one `searchable()` field on the node schema. `hit.node` is
narrowed to the typed node for `nodeKind` — no cast required.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `query` | `string` | — *(required)* | Query string. Parsed according to `mode`. |
| `limit` | `number` | — *(required)* | Max rows. Positive integer. |
| `mode` | `"websearch" \| "phrase" \| "plain" \| "raw"` | `"websearch"` | Parser for `query`. |
| `language` | `string` | per-row | Language override (Postgres only; throws on FTS5). |
| `minScore` | `number` | — | Drop hits below this backend-native score. |
| `includeSnippets` | `boolean` | `false` | Return a `<mark>…</mark>` snippet per hit. |

#### `store.search.hybrid(nodeKind, options)`

Runs a vector + fulltext hybrid query and fuses the two ranked lists
with Reciprocal Rank Fusion. Requires both `vectorSearch` and
`fulltextSearch` capabilities on the backend.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | `number` | — *(required)* | Final fused result count. |
| `vector.fieldPath` | `string` | — *(required)* | Embedding field on the node. |
| `vector.queryEmbedding` | `readonly number[]` | — *(required)* | Query vector. |
| `vector.metric` | `"cosine" \| "l2" \| "inner_product"` | `"cosine"` | Distance metric. |
| `vector.k` | `number` | `4 × limit` | Vector-side candidates to fuse. |
| `vector.minScore` | `number` | — | Vector-side score floor. |
| `fulltext.query` | `string` | — *(required)* | Fulltext query string. |
| `fulltext.k` | `number` | `4 × limit` | Fulltext-side candidates to fuse. |
| `fulltext.mode` | `FulltextQueryMode` | `"websearch"` | Parser mode. |
| `fulltext.language` | `string` | per-row | Language override. |
| `fulltext.minScore` | `number` | — | Fulltext-side score floor. |
| `fulltext.includeSnippets` | `boolean` | `false` | Return snippets per fulltext sub-hit. |
| `fusion.method` | `"rrf"` | `"rrf"` | Fusion method. |
| `fusion.k` | `number` | `60` | RRF constant. |
| `fusion.weights.vector` | `number` | `1` | Bias toward the vector retriever. |
| `fusion.weights.fulltext` | `number` | `1` | Bias toward the fulltext retriever. |

Each `HybridSearchHit` exposes `vector` and `fulltext` sub-results
(each with its own `rank` and `score`) for ranking debugging.

#### `store.search.rebuildFulltext(nodeKind?, options?)`

Rebuilds the fulltext index from existing node data. Use after a
schema change, a `DROP TABLE` / `TRUNCATE` of the fulltext table, or
bulk inserts that bypassed the store. Run during a maintenance
window for full consistency — concurrent hard-deletes between page
fetches can be missed by a single pass.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `nodeKind` | `string \| undefined` | all kinds | Scope to a single kind. |
| `options.pageSize` | `number` | `500` | Keyset page size. Positive integer. |
| `options.maxSkippedIds` | `number` | `10_000` | Cap on returned `skippedIds`. Raise for forensic runs. |

Returns `{ kinds, processed, upserted, cleared, skipped, skippedIds,
skippedTruncated }`.

See [Fulltext Search](/fulltext-search) for query modes, RRF tuning,
`FulltextStrategy` customization, and troubleshooting.

### Temporal Views (`store.asOf` and `store.view`)

A `StoreView` is a **read-only** lens that pins one temporal coordinate and
routes every supported read through it — the as-of database value, in the style
of Datomic `(d/as-of db t)` and SQL:2011 `FOR SYSTEM_TIME AS OF`. Use it when
several reads should share the same temporal coordinate; reach for the per-query
[`.temporal("asOf", T)`](/queries/temporal#point-in-time-queries-asof) when only
one query needs it.

```typescript
store.asOf(asOf: string): StoreView<G>;
store.view(coordinate: { mode: TemporalMode; asOf?: string }): StoreView<G>;
store.snapshot(): StoreView<G>;
```

- **`store.asOf(T)`** pins valid-time `asOf` mode at timestamp `T`.
- **`store.view({ mode, asOf })`** pins any public mode (`"current"`,
  `"asOf"`, `"includeEnded"`, `"includeTombstones"`). `asOf` is required for
  `"asOf"` mode.
- **`store.snapshot()`** pins the current instant, captured once at
  construction — sugar for `store.asOf(new Date().toISOString())`. Unlike
  `store.view({ mode: "current" })` (which tracks "now" live and may read
  different surfaces against slightly different clocks), a snapshot is a stable
  point-in-time value where every surface observes the same instant. Mirrors
  Datomic's `(d/db conn)`.

`asOf` must be a canonical UTC ISO-8601 timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`) —
a date-only, zoned-offset, or natural-language string is rejected with a
`ValidationError`, because the temporal filters compare it as text.

```typescript
const past = store.asOf("2026-01-01T00:00:00.000Z");

const alice = await past.nodes.Person.getById(aliceId);
const jobs = await past.edges.worksAt.findFrom(alice);
const names = await past
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq("Alice"))
  .select((ctx) => ctx.p.name)
  .execute();
const reach = await past.reachable(aliceId, { edges: ["knows"] });
const sg = await past.subgraph(aliceId, { edges: ["knows"] });
```

#### Surface

The view exposes the read surface of the `Store`, each pinned to its
coordinate:

| Surface | Behavior |
| --- | --- |
| `view.nodes` / `view.edges`: `getById`, `getByIds`, `find`, `count` | pinned |
| `view.edges`: `findFrom`, `findTo`, `bulkFindFrom`, `bulkFindTo`, `findByEndpoints` | pinned |
| `view.bulkFindEdgesFrom(params, options?)` | pinned |
| `view.query()` | a pinned query builder with a **sealed** temporal axis — `.temporal(...)` throws |
| `view.subgraph(rootId, options)` | pinned |
| `view.reachable` / `canReach` / `shortestPath` / `neighbors` / `degree` | pinned |
| `view.nodes`: `findByConstraint` / `bulkFindByConstraint` / `bulkFindByIndex` | current-only reads: delegate on a `"current"` view; reject on any temporal pin |
| `view.search` reads (`fulltext` / `vector` / `hybrid`) | delegate to the live search on a `"current"` view; reject on any other pin |
| `view.search.rebuildFulltext()` | rejected on every view (maintenance write) |
| `view.mode` / `view.asOf` | the pinned coordinate |

The algorithm and `subgraph` option objects are the same as on the live `Store`
**minus** `temporalMode` / `asOf`, which the pin supplies.

`view.query()` is a **capability-safe** pinned read context: the returned query
builder seeds the view's coordinate and seals the temporal axis, so calling
`.temporal(...)` on it (or on any builder derived from it) throws a
`ConfigurationError`. To read at a different coordinate, construct a different
view or use the live `store.query()`.

#### Read-only

A view is read-only by construction. Writes (`create` / `update` / `delete` /
`upsert*` / `bulk*` / `getOrCreate*`) and temporally-unscoped reads on a view
collection reject with a `ConfigurationError`, and the view exposes no
`transaction`. Perform writes on the live `Store`.

Constraint / index lookups (`findByConstraint`, `bulkFindByConstraint`,
`bulkFindByIndex`) read current state only — they have no temporal axis — so a
view **delegates** them on a `"current"` view and **rejects** them on any
temporal pin (rather than silently returning current data while every sibling
read is pinned). `search` is refused on a non-`"current"` view for the same
reason: the fulltext / vector index reflects current state only. (Edge
`findByEndpoints` *does* have a temporal axis and is pinned like `findFrom`.)

See [Temporal queries](/queries/temporal#shared-coordinate-views-storeasof) for
worked examples.

#### Recorded time (`store.asOfRecorded`)

With a store created with `{ history: true }` or an explicit `recordedRead`
binding, `store.asOfRecorded(T)` returns a `RecordedStoreView` — a narrow
read-only lens that reconstructs the graph as the recorded relation represented
it at instant `T` (the system-time axis), composing with the valid-time
coordinate above for bitemporal graph reads.

```typescript
store.asOfRecorded(recordedAsOf: RecordedInstant): RecordedStoreView<G>;
// also: store.asOf(validT).asOfRecorded(recordedT)
//       store.view({ mode }).asOfRecorded(recordedT)
store.recordedNow(): Promise<RecordedInstant | undefined>;
asRecordedInstant(value: string): RecordedInstant; // re-brand a persisted anchor
recordedInstantRevision(value: RecordedInstant): number;
recordedInstantWallTime(value: RecordedInstant): string;
compareRecordedInstants(a: RecordedInstant, b: RecordedInstant): -1 | 0 | 1;
```

- **`store.asOfRecorded(T)`** is diagonal sugar — the recorded *and* valid axes
  both at `T`. Chain from `store.asOf(validT)` / `store.view({ mode })` to pin
  the two axes independently.
- **`T` is a `RecordedInstant`**, a branded canonical string encoded as
  `r1:<16-digit revision>:<canonical UTC timestamp>`. It comes from
  `store.recordedNow()` or from `asRecordedInstant(...)` after the exact anchor
  has round-tripped through untyped storage. A raw wall-clock string
  (`new Date().toISOString()`) is a compile error because it cannot distinguish
  multiple commits in one millisecond. The logical revision orders commits; the
  timestamp is a non-decreasing physical wall-time high-water mark. Use
  `recordedInstantRevision(T)`, `recordedInstantWallTime(T)`, and
  `compareRecordedInstants(a, b)` instead of splitting or comparing anchor
  strings manually. Comparisons are meaningful only within one graph. See
  [Logical revision and physical time](/queries/temporal#logical-revision-and-physical-time).
- **`store.recordedNow()`** returns the recorded high-water mark — the latest
  captured recorded instant. After guarding the `undefined` case,
  `store.asOfRecorded(checkpoint)` reconstructs everything committed so far. Use
  it as a deterministic anchor instead of the wall clock. Returns `undefined`
  before the first capture; throws if the store was not created with
  `{ history: true }`.
- **`recordedRead`** binds an externally populated recorded relation for reads
  only. It does not capture TypeGraph writes, advance TypeGraph's recorded clock,
  or make `store.recordedNow()` available. It must be created with
  `recordedRelation({ schema })` using a `createSqlSchema(...)` schema and
  cannot be combined with `history: true`.
- The view exposes only **reconstructing** reads: `nodes` / `edges` point reads
  (`getById` / `getByIds`) and bounded deterministic `scan()` pages, a sealed
  `query()`, `subgraph()`, and the graph algorithms (`reachable` / `canReach` /
  `shortestPath` / `degree`). Broad filtered collection reads, `search`, and
  fulltext / vector predicates reject — those indexes reflect current state
  only.
- Built-in capture covers TypeGraph collection writes. Out-of-band database
  writes and row-returning raw SQL paths are not captured into the recorded
  relations.

Adopt an external transaction under `history: true` with the callback form
`store.withRecordedTransaction(externalTx, async (tx) => ...)`, which flushes
capture before the caller commits. `store.withTransaction(...)` is a compile
error on a history store, and the typed history transaction context omits raw
`tx.sql`. Branch on `tx.sqlAvailability` (`"history"`) before accessing the SQL
handle. See
[Recorded time](/queries/temporal#recorded-time-bitemporal) for the full guide.

## Observability Hooks

TypeGraph supports observability hooks for monitoring and logging store operations.
Query hooks describe SQL statements submitted by the query builder, not logical
query-builder calls or backend-internal setup statements. A logical query that retries
with a different projection therefore fires the query hooks once for each statement it
submits.

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

> **Note:** Batch operations (`bulkCreate`, `bulkInsert`, `bulkUpsertById`, `bulkDelete`) skip per-item
operation hooks for throughput, and the set-based bulk hooks (`onBulkOperationStart` / `onBulkOperationEnd`) do not
stand in for them — those fire only for node `updateWhere`, so a batch method emits no hook events at all, neither
per-item nor bulk. Call the single-item method to observe each write. Query hooks still fire normally.

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

// CRUD operations trigger operation hooks; query-builder statements trigger
// query hooks.
await store.nodes.Person.create({ name: "Alice" });
await store.query().from("Person", "p").select((ctx) => ctx.p).execute();
// Logs include:
// [op-abc123] create node:Person
// [op-abc123] Completed in 5ms
// [query-def456] SQL: WITH ... SELECT ...
// [query-def456] 1 rows in 2ms
```
