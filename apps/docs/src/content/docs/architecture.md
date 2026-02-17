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
│                    ┌──────────────┐                    │
│                    │   Drizzle    │                    │
│                    │     ORM      │                    │
│                    └──────┬───────┘                    │
│                           │                            │
└───────────────────────────┼────────────────────────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │  Your Database  │
                   └─────────────────┘
```

TypeGraph is an **embedded library**, not a database. It runs in your application process, uses your existing
database connection, and compiles queries to SQL.

## Core Design Principles

### 1. Embedded, Not External

**Decision**: TypeGraph is a library dependency, not a separate service.

**Why**: Graph databases like Neo4j require managing another piece of infrastructure. For many use
cases—knowledge bases, organizational structures, content relationships—the graph is part of your application,
not a standalone system.

**Tradeoff**: You don't get Neo4j's specialized graph algorithms (PageRank, community detection), but you avoid:

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

| Capability | How It Works |
|------------|--------------|
| **Self-describing database** | Query the schema without application code—useful for debugging, admin tools, and data exploration |
| **Schema versioning** | Every schema change creates a new version; previous versions are preserved for auditing |
| **Change detection** | Compare stored schema to code schema to detect additions, removals, and breaking changes |
| **Portable exports** | The [interchange format](/interchange) is self-contained—importers know what the data means |
| **Runtime introspection** | Applications can query the schema at runtime for dynamic UI, validation, or documentation |

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
  version     INTEGER NOT NULL,
  valid_from  TEXT NOT NULL,
  valid_to    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
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
Query Builder API → Query AST → SQL Generator → Drizzle → Database
```

1. **Query Builder**: Fluent API that constructs a typed AST
2. **Query AST**: A data structure representing the query (nodes, edges, predicates, projections)
3. **SQL Generator**: Transforms AST to SQL using CTEs for each step
4. **Drizzle**: Executes the SQL and returns typed results

### Common Table Expressions (CTEs)

TypeGraph compiles traversals to CTEs, which databases optimize well:

```typescript
store.query()
  .from("Person", "p")
  .traverse("authored", "e")
  .to("Document", "d")
  .whereNode("d", (d) => d.status.eq("published"))
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
    AND p.depth < 100           -- Implicit cap for unbounded traversal
    AND NOT n.id = ANY(p.path)  -- Cycle detection
)
SELECT * FROM path;
```

When you opt into `cyclePolicy: "allow"` and do not project a path column,
TypeGraph can use a lighter recursive shape without path-array state and
cycle predicates.

## Vector Search Architecture

For semantic search with embeddings:

### Storage

```sql
-- PostgreSQL with pgvector
CREATE TABLE typegraph_embeddings (
  graph_id    TEXT NOT NULL,
  node_kind   TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  field       TEXT NOT NULL,
  embedding   vector(1536),      -- pgvector type
  PRIMARY KEY (graph_id, node_kind, node_id, field)
);

CREATE INDEX ON typegraph_embeddings
  USING hnsw (embedding vector_cosine_ops);  -- HNSW index for fast similarity
```

### Query Flow

```typescript
.whereNode("d", (d) => d.embedding.similarTo(queryVector, 10))
```

Compiles to:

```sql
-- PostgreSQL
SELECT * FROM typegraph_nodes n
JOIN typegraph_embeddings e ON e.node_id = n.id
ORDER BY e.embedding <=> $1    -- Cosine distance
LIMIT 10;
```

The database's vector index (HNSW or IVFFlat) handles approximate nearest neighbor search efficiently.

## Performance Characteristics

### What's Fast

- **Point lookups by ID**: O(1) with primary key index
- **Traversals**: Single SQL query with JOINs, optimized by the database
- **Ontology expansion**: Precomputed at initialization, O(1) at query time
- **Semantic search**: HNSW indexes provide sub-linear search

### What's Slower

- **Deep recursive traversals**: Recursive CTEs are more expensive than simple JOINs
- **Large property filtering without indexes**: JSON extraction is slower than column access
- **Cross-kind queries**: `includeSubClasses: true` increases the WHERE IN set

### Optimization Strategies

1. **Filter early**: Apply predicates as close to the source as possible
2. **Limit results**: Always paginate large result sets
3. **Use specific kinds**: Avoid `includeSubClasses` unless needed
4. **Index JSON paths**: For frequently-filtered properties, add expression indexes
5. **Batch writes**: Use transactions to reduce disk syncs and round-trips

## Why These Tradeoffs?

### Why Not a Native Graph Database?

Native graph databases (Neo4j, Amazon Neptune) excel at:

- Very deep traversals (10+ hops)
- Graph algorithms (shortest path, PageRank)
- Massive scale (billions of nodes)

TypeGraph is designed for:

- Knowledge bases with thousands to millions of nodes
- Shallow to medium traversals (1-5 hops typically)
- Applications that already use SQL databases
- Teams that want one database to manage

### Why Drizzle ORM?

1. **Type safety**: Full TypeScript inference
2. **Multiple dialects**: Same API for SQLite and PostgreSQL
3. **Raw SQL access**: When needed for performance
4. **Active ecosystem**: Well-maintained, growing community

### Why Zod for Schemas?

1. **Runtime validation**: Not just types, but actual validation
2. **Inference**: `z.infer<T>` eliminates type duplication
3. **Composition**: Build complex schemas from simple ones
4. **Ecosystem**: Widely used, lots of integrations

## Next Steps

- [Performance](/performance/overview) - Benchmarks and optimization tips
- [Schemas & Stores](/schemas-stores) - Complete function signatures
- [Integration Patterns](/integration) - How to integrate with your stack
