---
title: Performance Overview
description: Understanding the performance characteristics of TypeGraph
---

TypeGraph is designed to be a high-performance, low-overhead layer on top of
your relational database. By leveraging the power of modern SQL engines (SQLite
and PostgreSQL) and precomputing complex relationships, TypeGraph ensures that
your knowledge graph scales with your application.

## Performance Philosophy

1. **Zero-Cost Abstractions**: Where possible, TypeGraph's type safety and ontological reasoning
   should not add measurable runtime overhead.
2. **SQL Native**: All queries are compiled into a single, efficient SQL statement using Common
   Table Expressions (CTEs) and native JSON operations.
3. **Precomputed Ontology**: Transitive closures, subclass hierarchies, and edge implications are
   computed once at schema initialization, not during every query.
4. **Batching & Transactions**: Native support for transactions allows for high-throughput write operations.

## Benchmarks

The following benchmarks were recorded using `tinybench` on a standard development machine
(M3 Pro) using an in-memory SQLite database. These represent the baseline overhead of the
TypeGraph library itself.

| Operation             | Throughput (ops/s) | Avg Latency (ns) |
| :-------------------- | :----------------- | :--------------- |
| **Create Node**       | ~34,000            | ~32,000          |
| **Read Node by ID**   | ~92,000            | ~12,000          |
| **Simple Query**      | ~6,800             | ~147,000         |

*Note: Real-world performance will vary based on your database driver, network latency (for PostgreSQL), and schema complexity.*

## Key Performance Features

### 1. Precomputed Closures

When you define an ontology (e.g., `subClassOf`, `implies`), TypeGraph precomputes the full
transitive closure. When you run a query like `.from("Parent", "p", { includeSubClasses: true })`,
the SQL generator uses a pre-calculated list of IDs rather than performing recursive lookups at
runtime.

### 2. Recursive CTEs for Variable-Length Paths

For queries that traverse edges of unknown length (e.g., finding all descendants in a tree),
TypeGraph compiles your request into a single **Recursive Common Table Expression**. This allows
the database engine to optimize the traversal and minimizes the number of round-trips between your
application and the database.

### 3. Smart Select Optimization

TypeGraph automatically optimizes queries based on which fields your `select()` callback accesses.
When you select specific fields, TypeGraph generates SQL that only extracts those fields using
`json_extract()` (SQLite) or JSONB path extraction (PostgreSQL), rather than fetching the entire
`props` blob.

```typescript
// Optimized: Only fetches email and name from the database
const results = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.email.eq("alice@example.com"))
  .select((ctx) => ({
    email: ctx.p.email,
    name: ctx.p.name,
  }))
  .execute();

// SQL: SELECT json_extract(props, '$.email'), json_extract(props, '$.name') ...
```

This optimization pairs well with expression indexes on the same JSON paths: if your index contains
both the filter keys and the selected keys, the database may be able to satisfy the query using an
index-only scan. See [Indexes](/performance/indexes) for TypeGraph-friendly index definitions.

**When optimization applies:**

| Pattern | Optimized? | Reason |
|---------|-----------|--------|
| `ctx => ({ email: ctx.p.email })` | Yes | Simple field extraction |
| `ctx => [ctx.p.id, ctx.p.name]` | Yes | Multiple fields in array |
| `ctx => ctx.p` | No | Whole node returned |
| `ctx => ({ upper: ctx.p.email.toUpperCase() })` | Yes | Field extracted; method runs in JS |
| `ctx => ({ ...ctx.p })` | No | Spread requires full node |

The optimization is transparent - if your callback can't be optimized, TypeGraph automatically
falls back to fetching the full node data.

:::note[Select callback purity]
Smart select applies to `.execute()`, `.paginate()`, and `.stream()`. The `select()` callback may be evaluated
multiple times during planning/optimization, so it should be pure (no side effects).
:::

:::note[Known limitations]
Smart select is not currently applied to queries that include variable-length traversals (recursive CTEs),
even when the select callback is otherwise optimizable.
:::

### 4. Built-in Indexing

The default TypeGraph schema includes optimized indexes for the most common access patterns:

- **Graph + Kind + ID**: Primary key for lightning-fast node lookups.
- **Graph + From/To ID**: Optimized for edge traversals.
- **Temporal Indices**: Filter by `valid_from`, `valid_to`, and `deleted_at` with minimal impact.

For application-specific indexes on JSON properties, see [Indexes](/performance/indexes).

## Best Practices

### Use Specific Kinds

Unless you specifically need to query across a hierarchy, avoid `includeSubClasses: true`. Being
specific about the node kind allows the SQL engine to use more restrictive index scans.

### Select Specific Fields

When you only need certain fields, select them explicitly rather than returning whole nodes.
This triggers the [smart select optimization](#3-smart-select-optimization) and can enable
index-only scans with properly configured indexes.

```typescript
// Preferred: Only fetches what you need
.select((ctx) => ({ name: ctx.p.name, email: ctx.p.email }))

// Avoid when possible: Fetches entire props blob
.select((ctx) => ctx.p)
```

### Filter Early

Apply `.whereNode()` predicates as early as possible in your query chain. TypeGraph moves these
predicates into the initial CTEs, reducing the number of rows that need to be joined in subsequent
steps.

### Leverage Transactions

When creating or updating multiple nodes and edges, always use `store.transaction()`. This
significantly improves write throughput by reducing the number of disk syncs (in SQLite) or
network round-trips (in PostgreSQL).

```typescript
await store.transaction(async (tx) => {
  for (const data of batch) {
    await tx.nodes.Person.create(data);
  }
});
```

### Use Cursor Pagination

For large datasets, prefer `.paginate()` over `.limit()` and `.offset()`. Keyset pagination
(using cursors) avoids the `O(N)` cost of skipping rows in standard SQL offsets.

## Profile Your Queries

Use the [Query Profiler](/performance/profiler) to identify missing indexes and understand
query patterns in your application. The profiler captures property access patterns and generates
prioritized index recommendations.

```typescript
import { QueryProfiler } from "@nicia-ai/typegraph/profiler";

const profiler = new QueryProfiler();
const profiledStore = profiler.attachToStore(store);

// Run your application or test suite...

const report = profiler.getReport();
console.log(report.recommendations);
```

## Running Benchmarks Locally

You can run the benchmark suite against your own environment:

```bash
pnpm bench
```

The benchmark source code is located in `packages/benchmarks/src/index.ts` and can be customized
to match your specific data model.

## Next Steps

- [Indexes](/performance/indexes) - Define custom indexes for your schema
- [Query Profiler](/performance/profiler) - Identify missing indexes automatically
