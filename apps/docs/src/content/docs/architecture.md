---
title: Architecture
description: How TypeGraph works internally and the design decisions behind it
---

This page explains how TypeGraph works under the hood, the design decisions that shaped it, and why certain
tradeoffs were made.

## High-Level Architecture

```text
┌────────────────────────────────────────────────────────┐
│                     Your Application                   │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │                  TypeGraph Library               │  │
│  │                                                  │  │
│  │  ┌────────────┐                  ┌────────────┐  │  │
│  │  │   Schema   │                  │   Query    │  │  │
│  │  │    DSL     │                  │  Builder   │  │  │
│  │  └──────┬─────┘                  └─────┬──────┘  │  │
│  │         │                              │         │  │
│  │         └──────────────┴───────────────┘         │  │
│  │                        │                         │  │
│  │                        ▼                         │  │
│  │              ┌──────────────────┐                │  │
│  │              │  Ontology Layer  │                │  │
│  │              └──────────────────┘                │  │
│  └─────────────────────────┬────────────────────────┘  │
│                            │                           │
│                            ▼                           │
│              ┌────────────────────────┐                │
│              │ TypeGraph Backend Port │                │
│              └────────────┬───────────┘                │
│                           │                            │
│                    ┌──────▼───────┐                    │
│                    │ SQL Adapter  │                    │
│                    │  (Drizzle)   │                    │
│                    └──────┬───────┘                    │
│                           │                            │
└───────────────────────────┼────────────────────────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │  Your Database  │
                   └─────────────────┘
```

TypeGraph is an **embedded library**, not a database. It runs in your application
process and compiles queries to SQL. A managed local Store can own its SQLite or
PGlite connection; adapter integrations can instead use a connection your
application already owns.

### Capability boundaries

TypeGraph's public types match its supported runtime surfaces. The default
`Store` exposes graph operations; `AdapterStore` adds native transaction
interoperability; transaction contexts expose a read-only backend projection.
Every store exposes `store.capabilities`, the read-only runtime feature
descriptor used by its backend, so portable code can branch on atomicity,
vector, fulltext, or analytics support without reaching through the adapter
boundary.
Whenever a surface loses capabilities, TypeGraph constructs an explicit
allowlist projection. Proxy overlays are reserved for decorating a surface
without changing its capabilities.

The internal store and transaction ports are non-enumerable symbol properties
and are absent from public TypeScript contracts. They are not a JavaScript
security boundary: sufficiently reflective code can discover symbol properties,
as it can inspect internals in any in-process library. The guarantee applies to
all documented and supported access paths.

## Core Design Principles

### 1. Embedded, Not External

**Decision**: TypeGraph is a library dependency, not a separate service.

**Why**: Graph databases like Neo4j require managing another piece of infrastructure. For many use
cases—knowledge bases, organizational structures, content relationships—the graph is part of your application,
not a standalone system.

**Tradeoff**: You don't get Neo4j's broad graph-data-science suite (community
detection, betweenness centrality, and similar specialized analytics), but you
avoid:

- Additional deployment complexity
- Network latency between app and graph
- Separate scaling and monitoring
- Data synchronization challenges

### 2. Schema-First, Type-Driven

**Decision**: Zod schemas are the single source of truth. TypeScript types are inferred, not duplicated.

**Why**: In many graph systems, you define types in one place, validation in another, and database schemas in a
third. This leads to drift and bugs.

With TypeGraph:

```typescript
const Person = defineNode("Person", {
  schema: z.object({
    name: z.string().min(1),
    email: z.string().email().optional(),
  }),
});

// TypeScript type is inferred automatically
type PersonProps = z.infer<typeof Person.schema>;
// { name: string; email?: string }
```

The schema drives:

- Runtime validation on create/update
- TypeScript types for compile-time safety
- Database storage format
- Query builder type constraints

### 3. SQL as the Execution Engine

**Decision**: Compile graph queries to SQL, don't implement a custom query engine.

**Why**: SQLite and PostgreSQL are battle-tested, highly optimized query engines. Rather than building another one:

```typescript
// Your query
store.query()
  .from("Person", "p")
  .traverse("worksAt", "e")
  .to("Company", "c")
  .select((ctx) => ({ person: ctx.p.name, company: ctx.c.name }))

// Compiles to SQL with CTEs
WITH person_cte AS (
  SELECT * FROM typegraph_nodes WHERE kind = 'Person' AND deleted_at IS NULL
),
edge_cte AS (
  SELECT * FROM typegraph_edges WHERE kind = 'worksAt' AND deleted_at IS NULL
),
company_cte AS (
  SELECT * FROM typegraph_nodes WHERE kind = 'Company' AND deleted_at IS NULL
)
SELECT
  p.props->>'name' as person,
  c.props->>'name' as company
FROM person_cte p
JOIN edge_cte e ON e.from_id = p.id
JOIN company_cte c ON c.id = e.to_id
```

This means:

- You get database-level query optimization
- Indexes work as expected
- Transactions are ACID
- You can analyze queries with EXPLAIN

### 4. Precomputed Ontology

**Decision**: Compute transitive closures at store initialization, not query time.

**Why**: Semantic relationships like `subClassOf` and `implies` form hierarchies. Computing "all subclasses of
Media" during every query would be expensive.

Instead, when you create a store:

```typescript
const store = createStore(graph, backend);
// ↑ Computes:
//   - subClassOf closure: Media → [Media, Podcast, Article, Video]
//   - implies closure: marriedTo → [marriedTo, partneredWith, knows]
//   - disjoint sets: Person ⊥ Organization ⊥ Product
```

These closures are stored in the `TypeRegistry` and used during query compilation:

```typescript
.from("Media", "m", { includeSubClasses: true })
// At compile time, expands to: WHERE kind IN ('Media', 'Podcast', 'Article', 'Video')
```

**Tradeoff**: Changing the ontology requires recreating the store. But ontologies typically change rarely
compared to instance data.

### 5. Homoiconic Schema Storage

**Decision**: Store the graph schema and ontology as data in the database itself.

**Why**: Most ORMs and graph libraries define schemas only in application code. The database stores data but
has no record of what the data means. This creates problems:

- You can't understand the database without reading the application source
- Schema changes are invisible—no history, no diff, no audit trail
- Exports require the application to interpret the data
- Multiple applications can't share schema understanding

TypeGraph takes a different approach: the schema is data. When you initialize a store, the complete schema
(node types, edge types, property definitions, ontology relations, precomputed closures) is serialized to JSON
and stored in `typegraph_schema_versions`:

```sql
SELECT schema_doc FROM typegraph_schema_versions
WHERE graph_id = 'my_graph' AND is_active = TRUE;
```

From TypeScript,
[`getActiveSchema`](/schema-management#what-does-this-database-already-have)
runs this query and parses the result into a typed `SerializedSchema`.

The stored schema includes everything needed to understand the graph:

```typescript
{
  graphId: "my_graph",
  version: 3,
  nodes: {
    Person: { properties: { /* JSON Schema */ }, ... },
    Company: { ... }
  },
  edges: {
    worksAt: { fromKinds: ["Person"], toKinds: ["Company"], ... }
  },
  ontology: {
    relations: [{ metaEdge: "subClassOf", from: "Engineer", to: "Person" }],
    closures: {
      subClassAncestors: { Engineer: ["Person"] },
      // ... precomputed inference data
    }
  }
}
```

This enables:

| Capability                   | How It Works                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| **Self-describing database** | Query the schema without application code—useful for debugging, admin tools, and data exploration |
| **Schema versioning**        | Every schema change creates a new version; previous versions are preserved for auditing           |
| **Change detection**         | Compare stored schema to code schema to detect additions, removals, and breaking changes          |
| **Portable exports**         | The [interchange format](/interchange) is self-contained—importers know what the data means       |
| **Runtime introspection**    | Applications can query the schema at runtime for dynamic UI, validation, or documentation         |

```typescript
import { getActiveSchema, getSchemaChanges } from "@nicia-ai/typegraph/schema";

// Query the active schema at runtime
const schema = await getActiveSchema(backend, "my_graph");
console.log("Node types:", Object.keys(schema.nodes));
console.log("Edge types:", Object.keys(schema.edges));

// Detect pending changes before deployment
const diff = await getSchemaChanges(backend, graph);
if (!diff.isBackwardsCompatible) {
  console.error("Breaking changes require migration");
}
```

**Tradeoff**: Schema storage adds a small amount of database overhead (one JSON document per version). The
benefit is a database that explains itself.

## Data Model

### Storage Schema

TypeGraph uses two core tables:

```sql
-- Nodes table
CREATE TABLE typegraph_nodes (
  graph_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  id          TEXT NOT NULL,
  props       JSON NOT NULL,      -- Properties as JSON
  version     INTEGER NOT NULL,   -- Optimistic concurrency
  valid_from  TEXT NOT NULL,      -- Temporal validity
  valid_to    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,               -- Soft delete
  PRIMARY KEY (graph_id, kind, id, valid_from)
);

-- Edges table
CREATE TABLE typegraph_edges (
  graph_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  id          TEXT NOT NULL,
  from_kind   TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_kind     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  props       JSON NOT NULL,
  match_identity_name TEXT,
  match_identity_key  TEXT,
  version     INTEGER NOT NULL,
  valid_from  TEXT NOT NULL,
  valid_to    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  CHECK (
    (match_identity_name IS NULL) = (match_identity_key IS NULL)
  ),
  UNIQUE (graph_id, kind, match_identity_name, match_identity_key),
  PRIMARY KEY (graph_id, kind, id, valid_from)
);
```

### Why JSON for Properties?

**Decision**: Store node/edge properties as JSON, not as columns.

**Why**:

1. **Schema flexibility**: Adding a property doesn't require ALTER TABLE
2. **Heterogeneous nodes**: Different node kinds have different schemas
3. **Query simplicity**: One table for all nodes, not one per kind

Both SQLite (JSON1 extension) and PostgreSQL (JSONB) have efficient JSON operators:

```sql
-- PostgreSQL
SELECT props->>'name' FROM typegraph_nodes WHERE props->>'status' = 'active';

-- SQLite
SELECT json_extract(props, '$.name') FROM typegraph_nodes WHERE json_extract(props, '$.status') = 'active';
```

**Tradeoff**: You can't create a B-tree index on a JSON property as easily as a column. For high-cardinality
filtering, consider:

- PostgreSQL: Expression indexes on JSONB paths
- SQLite: Expression indexes on `json_extract(...)` (or generated columns)

See [Indexes](/performance/indexes) for TypeGraph utilities to define and create these indexes.

### Durable edge match identity

An edge registration can promote one endpoint/property comparison from a
caller convention to a stored graph-schema contract:

```text
graph matchIdentity declaration
            │
            ▼
canonical endpoint/property key
            │
            ▼
authoritative edge command ──► database unique arbiter
            │                         │
            └──────── created ◄───────┤
                      found   ◄───────┘
```

The database unique constraint is the concurrency authority. A cache, an
outside read, or a process-local lock cannot replace it because serverless
requests may use different processes and connections. Bundled root backends can
therefore lower an eligible `getOrCreateByEndpoints()` call to one statement;
paths with cardinality claims, history, revision tracking, or caller-owned work
use the same arbiter inside their transaction.

Each decision has one owner:

| Decision | Owner |
| --- | --- |
| Which property fields form the identity | The graph registration's named `matchIdentity` |
| Whether a schema can activate or re-key it | The schema manager's all-physical-row emptiness fence |
| How endpoint/property values become a portable key | The shared canonical encoder |
| Which concurrent writer owns the identity | The database unique constraint |
| Whether a command created or found a row | The authoritative command result |
| Whether a failed import batch may retry rows | The semantic savepoint result |

The semantic savepoint is broader than raw SQL transaction control. Rolling it
back restores the database savepoint and TypeGraph's pending capture touches,
forced revisions, and graph-lock memo together. Consumers receive the resulting
decision instead of re-deriving it from an exception, row count, or follow-up
read. That is what keeps direct creates, convergence, bulk writes, import,
history, and operation hooks aligned.

### Temporal Model

Every node and edge tracks temporal validity:

```text
┌──────────────────────────────────────────────────────────────┐
│ Node: Article#123                                            │
├──────────────────────────────────────────────────────────────┤
│ Version 1: "Draft"      │ valid_from: 2024-01-01            │
│                         │ valid_to:   2024-01-15            │
├─────────────────────────┼────────────────────────────────────┤
│ Version 2: "Published"  │ valid_from: 2024-01-15            │
│                         │ valid_to:   NULL (current)        │
└─────────────────────────┴────────────────────────────────────┘
```

When you update a node:

1. The current row's `valid_to` is set to now
2. A new row is inserted with `valid_from = now`, `valid_to = NULL`

This enables:

- **Point-in-time queries**: "What did the graph look like on January 10th?"
- **Audit trails**: "What were all the versions of this article?"
- **Soft deletes**: `deleted_at` marks deletion without losing history

## Query Compilation

### The Query Pipeline

```text
Query Builder → Query AST → TypeGraph SQL Fragment → Adapter → Database
```

1. **Query Builder**: Fluent API that constructs a typed AST
2. **Query AST**: A data structure representing the query (nodes, edges, predicates, projections)
3. **SQL Generator**: Transforms the AST into TypeGraph's immutable,
   database-independent SQL fragment representation
4. **Adapter**: Renders the fragment for SQLite or PostgreSQL and executes it
   through the configured driver

### Common Table Expressions (CTEs)

TypeGraph compiles traversals to CTEs, which databases optimize well:

```typescript
store
  .query()
  .from("Person", "p")
  .traverse("authored", "e")
  .to("Document", "d")
  .whereNode("d", (d) => d.status.eq("published"));
```

Becomes:

```sql
WITH
  step_0 AS (
    -- Start: all Person nodes
    SELECT * FROM typegraph_nodes
    WHERE graph_id = $1 AND kind = 'Person' AND deleted_at IS NULL
  ),
  step_1 AS (
    -- Traverse: follow 'authored' edges
    SELECT e.*, s.id as _from_step
    FROM typegraph_edges e
    JOIN step_0 s ON e.from_id = s.id
    WHERE e.kind = 'authored' AND e.deleted_at IS NULL
  ),
  step_2 AS (
    -- Arrive: at Document nodes
    SELECT n.*, s.id as _edge_id
    FROM typegraph_nodes n
    JOIN step_1 s ON n.id = s.to_id
    WHERE n.kind = 'Document' AND n.deleted_at IS NULL
  )
SELECT
  step_0.props->>'name' as person,
  step_2.props->>'title' as document
FROM step_0
JOIN step_1 ON step_1._from_step = step_0.id
JOIN step_2 ON step_2._edge_id = step_1.id
WHERE step_2.props->>'status' = 'published';
```

### Recursive CTEs for Variable-Length Paths

For `recursive()` traversals with cycle prevention enabled (the default),
TypeGraph generates recursive CTEs like:

```sql
WITH RECURSIVE path AS (
  -- Base case: starting nodes
  SELECT id, 1 as depth, ARRAY[id] as path
  FROM typegraph_nodes
  WHERE kind = 'Person' AND id = $1

  UNION ALL

  -- Recursive case: follow edges
  SELECT n.id, p.depth + 1, p.path || n.id
  FROM path p
  JOIN typegraph_edges e ON e.from_id = p.id
  JOIN typegraph_nodes n ON n.id = e.to_id
  WHERE e.kind = 'reportsTo'
    AND p.depth < 10            -- Implicit cap for unbounded traversal
    AND NOT n.id = ANY(p.path)  -- Cycle detection
)
SELECT * FROM path;
```

When you opt into `cyclePolicy: "allow"` and do not project a path column,
TypeGraph can use a lighter recursive shape without path-array state and
cycle predicates.

## Vector Search Architecture

Semantic search with embeddings works across **all** backends — pgvector on PostgreSQL, sqlite-vec on
better-sqlite3, and libSQL/Turso's built-in vector engine. The behavior is selected by a pluggable
`VectorStrategy`, so adding a new backend is a single strategy object with no edits to the core.

### Pluggable Strategies

Each backend wires a strategy that knows how to store embeddings and compile similarity queries:

| Backend        | Strategy                                                  | Storage / Index                                                     | Metrics                   |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------- |
| PostgreSQL     | `pgvectorStrategy` (default)                              | typed `vector(N)` tables, HNSW / IVFFlat                            | cosine, l2, inner_product |
| better-sqlite3 | `sqliteVecStrategy` (when the sqlite-vec extension loads) | `vec0` virtual tables (KNN)                                         | cosine, l2                |
| libSQL / Turso | `libsqlVectorStrategy` (wired automatically)              | `F32_BLOB(N)`, DiskANN ANN via `libsql_vector_idx` + `vector_top_k` | cosine, l2                |

`createSqliteBackend` and `createPostgresBackend` accept a `vector?: VectorStrategy` option to override the
default. The strategies, `buildVectorCapabilities`, and the complete `VectorStrategy` / `VectorSlot` authoring
vocabulary are exported from `@nicia-ai/typegraph/backend`.

A backend advertises its vector support as data on `backend.capabilities.vector`:

```typescript
backend.capabilities.vector; // { supported, metrics, indexTypes, maxDimensions, ... }
```

### Storage

Embeddings are stored in **per-field typed tables**, one per `(graphId, nodeKind, fieldPath)`, each carrying
that field's fixed dimension. Tables are provisioned by the privileged migrator (`createStoreWithSchema`, and
`evolve()` for runtime-added fields), with a durable contribution marker; the runtime hot path asserts the
marker and never issues DDL. They are named `tg_vec_<graphId>_<kind>_<field>`. Graph-scoping the table name lets
multiple graphs in one database declare the same kind+field at different dimensions without collision.

```sql
-- PostgreSQL with pgvector: one table per (graphId, kind, field). The kind
-- and field are encoded in the table name, so rows only key by node.
CREATE TABLE tg_vec_my_graph_document_embedding (
  graph_id    TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  embedding   vector(1536) NOT NULL,  -- pgvector type, fixed dimension per field
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (graph_id, node_id)
);

CREATE INDEX ON tg_vec_my_graph_document_embedding
  USING hnsw (embedding vector_cosine_ops);  -- HNSW index for fast similarity
```

`generatePostgresMigrationSQL()` runs `CREATE EXTENSION IF NOT EXISTS vector` but creates no embedding table —
the per-field tables are provisioned by `createStoreWithSchema` at boot (under the privileged role).

### Query Flow

The query API is storage-transparent and unchanged across backends:

```typescript
.whereNode("d", (d) => d.embedding.similarTo(queryVector, 10))
```

Compiles to a backend-specific nearest-neighbor query — for example, on PostgreSQL:

```sql
SELECT * FROM typegraph_nodes n
JOIN tg_vec_my_graph_document_embedding e
  ON e.node_id = n.id AND e.graph_id = n.graph_id
ORDER BY e.embedding <=> $1    -- Cosine distance
LIMIT 10;
```

The backend's vector index (pgvector HNSW/IVFFlat, sqlite-vec `vec0`, or libSQL DiskANN) handles approximate
nearest neighbor search efficiently.

## Performance Characteristics

### What's Fast

- **Point lookups by ID**: O(1) with primary key index
- **Traversal frontiers**: Set-based SQL rounds with database-managed joins and de-duplication
- **Ontology expansion**: Precomputed at initialization, O(1) at query time
- **Semantic search**: ANN indexes (pgvector HNSW/IVFFlat, sqlite-vec `vec0`, libSQL DiskANN) provide sub-linear search

### What's Slower

- **Deep recursive traversals**: Recursive CTEs are more expensive than simple JOINs
- **Whole-graph algorithms**: WCC, label propagation, and PageRank iterate over every visible node
  by default, or over an explicit `nodeKinds` induced subgraph, and their selected edges
- **Large property filtering without indexes**: JSON extraction is slower than column access
- **Cross-kind queries**: `includeSubClasses: true` increases the WHERE IN set

### Optimization Strategies

1. **Filter early**: Apply predicates as close to the source as possible
2. **Limit results**: Always paginate large result sets
3. **Use specific kinds**: Avoid `includeSubClasses` unless needed
4. **Index JSON paths**: For frequently-filtered properties, add expression indexes
5. **Batch writes**: Use transactions to reduce disk syncs and round-trips

### Mutation execution classes

TypeGraph classifies bulk writes by what must be known before SQL can be
submitted:

- A **closed mutation program** carries every input, fence, and refusal rule
  needed for the database to decide the write. Eligible node/edge creates and
  soft deletes use one exact-resource execution profile and can run as one native
  atomic exchange on bundled serverless transports. The profile is attached to
  the exact backend object. Derived backends do not inherit it accidentally;
  an already-open PostgreSQL transaction earns a separate session-bound
  registration.
- A **resolved mutation set** requires an authoritative database preimage and
  application computation before its writes are known. `bulkUpsertById()` is
  the canonical example: stored props are merged and Zod-validated, temporal
  decisions are derived, and repeated IDs observe earlier batch items. An
  eligible distinct-ID set can cross the exact registered boundary after resolution:
  its guarded SQL carries the node versions or complete edge preimages that
  justified the after-images. Update-only sets use one guarded set statement;
  mixed create/update sets add a terminal database postimage assertion inside
  the same native exchange, so an incomplete update aborts and rolls back its
  creates before the transport commits. Complex sets resolve and execute inside
  one interactive transaction. Neither shape is mislabeled as a read-free
  program. On an interactive PostgreSQL root, the operation runs on the exact
  collection-opened, caller-supplied, or adopted transaction and returns an
  explicit `applied | unsupported` verdict. `unsupported` proves that no
  program SQL ran before the complete portable path begins.

This boundary keeps transport optimization subordinate to Store semantics. A
new bulk optimization must either prove its mutation is closed or name the
authoritative resolution phase it preserves; it cannot read on one connection
and write on another, silently discard sidecars, or duplicate an eligibility
predicate beside the profile owner.

Backend authors can certify the transport boundary independently of mutation
eligibility with the framework-agnostic atomic transport conformance runner.
The runner supplies no dialect assumptions: the author provides statements,
state observers, and exact-root provenance checks, while the shared checks
verify ordered result slots, bound-parameter preservation, empty programs, and
all-or-nothing rollback across primary and sidecar writes.

## Why These Tradeoffs?

### Why Not a Native Graph Database?

Native graph databases (Neo4j, Amazon Neptune) excel at:

- Very deep traversals (10+ hops)
- Broad graph-data-science suites beyond the focused built-in algorithms
- Massive scale (billions of nodes)

TypeGraph is designed for:

- Knowledge bases with thousands to millions of nodes
- Shallow to medium traversals (1-5 hops typically)
- Applications that already use SQL databases
- Teams that want one database to manage

### Why a TypeGraph-Owned Backend Port?

The schema DSL, Store, query compiler, and SQL fragments belong to TypeGraph.
They do not import a database adapter's types. This keeps the public API stable
and prevents consumers from typechecking declarations for drivers and dialects
they never use.

Drizzle remains an implementation detail of the built-in SQLite and PostgreSQL
adapters:

1. **Driver integration**: Reuses mature SQLite and PostgreSQL connections
2. **Adapter-native access**: Bring-your-own-connection entrypoints retain
   precise Drizzle database and transaction types
3. **Replaceable boundary**: The core depends on TypeGraph ports; adapters
   translate fragments and operations at the edge

The package exports that boundary directly. Schema-only packages can import the
graph DSL and its schema-derived types from the Drizzle-free
`@nicia-ai/typegraph/core` entrypoint. Backend and search-strategy authors can
import the full Drizzle-free port vocabulary, including `GraphBackend`,
`AdapterBackend`, `DialectAdapter`, and `SqlFragment`, from
`@nicia-ai/typegraph/backend`.

### Why Zod for Schemas?

1. **Runtime validation**: Not just types, but actual validation
2. **Inference**: `z.infer<T>` eliminates type duplication
3. **Composition**: Build complex schemas from simple ones
4. **Ecosystem**: Widely used, lots of integrations

## Next Steps

- [Performance](/performance/overview) - Benchmarks and optimization tips
- [Schemas & Stores](/schemas-stores) - Complete function signatures
- [Integration Patterns](/integration) - How to integrate with your stack
