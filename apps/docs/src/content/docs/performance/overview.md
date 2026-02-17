---
title: Performance Overview
description: Understanding the performance characteristics of TypeGraph
---

TypeGraph is designed to be a high-performance, low-overhead layer on top of
your relational database. By leveraging the power of modern SQL engines (SQLite
and PostgreSQL) and precomputing complex relationships, TypeGraph ensures that
your knowledge graph scales with your application.

## Performance Philosophy

1. **One Query, One Statement**: Every query — including multi-hop traversals — compiles to a
   single SQL statement. No N+1 queries by design.
2. **Precomputed Ontology**: Transitive closures, subclass hierarchies, and edge implications are
   computed once at schema initialization, not during every query.
3. **Batching & Transactions**: Bulk collection APIs and transactions minimize round-trips for writes.
4. **Zero-Cost Abstractions**: Type safety and ontological reasoning add no measurable runtime overhead.

## N+1 Prevention

A common performance problem in ORMs is the N+1 query: you fetch N entities, then issue one
query per entity to load related data. TypeGraph eliminates this structurally.

Every query — regardless of how many traversals it chains — compiles to a **single SQL statement**
using Common Table Expressions (CTEs). Each traversal step becomes a CTE that joins against the
previous one:

```typescript
// This compiles to ONE SQL statement, not 3 separate queries
const results = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.name.eq("Alice"))
  .traverse("worksAt", "employment")
  .to("Company", "c")
  .traverse("locatedIn", "location")
  .to("City", "city")
  .select((ctx) => ({
    person: ctx.p.name,
    company: ctx.c.name,
    city: ctx.city.name,
  }))
  .execute();
```

The generated SQL looks like:

```sql
WITH cte_p AS (
  SELECT ... FROM typegraph_nodes
  WHERE graph_id = ? AND kind IN ('Person') AND ...
),
cte_employment AS (
  SELECT ... FROM typegraph_edges e
  JOIN typegraph_nodes n ON ...
  WHERE e.graph_id = ? AND ...
),
cte_location AS (
  SELECT ... FROM typegraph_edges e
  JOIN typegraph_nodes n ON ...
  WHERE e.graph_id = ? AND ...
)
SELECT ... FROM cte_p
JOIN cte_employment ON ...
JOIN cte_location ON ...
```

This holds for all query types:

- Multi-hop traversals (N CTEs, 1 statement)
- [Recursive traversals](/queries/recursive) (WITH RECURSIVE, 1 statement)
- Aggregations with traversals (CTEs + GROUP BY, 1 statement)
- [Set operations](/queries/combine) (UNION/INTERSECT/EXCEPT of CTEs, 1 statement)

There is no dataloader or batching layer because there is nothing to batch — the database handles
the entire join graph in a single execution.

## Batch Write Patterns

### Single vs bulk operations

For small numbers of writes, individual `create()` calls inside a transaction are fine. For larger
volumes, use the bulk collection APIs — they use multi-row INSERTs and handle parameter chunking
internally.

| Method | Returns results | Use case |
|--------|----------------|----------|
| `bulkCreate(items)` | Yes | Need created nodes back |
| `bulkCreate(items, { returnResults: false })` | No | Create many, don't need results |
| `bulkInsert(items)` | No | Maximum throughput ingestion |
| `bulkUpsert(items)` | Yes | Idempotent import (create or update) |
| `bulkDelete(ids)` | No | Mass soft-delete |

### PostgreSQL parameter limits

PostgreSQL has a 65,535 bind parameter limit per statement. TypeGraph automatically chunks bulk
operations to stay within this limit:

- Node inserts: ~7,200 per chunk (9 params per node)
- Edge inserts: ~5,400 per chunk (12 params per edge)

You don't need to chunk manually — pass arrays of any size and TypeGraph handles the rest.

### Transaction wrapping

Bulk operations are individually transactional (each chunk is atomic), but if you need the
entire batch to be atomic, wrap it in a transaction:

```typescript
// Atomic: all-or-nothing for the entire import
await store.transaction(async (tx) => {
  await tx.nodes.Person.bulkCreate(people);
  await tx.nodes.Company.bulkCreate(companies);
  await tx.edges.worksAt.bulkCreate(employments);
});
```

Without the wrapping transaction, a failure partway through would leave partial data.

### Choosing the right pattern

```typescript
// Small batch (< 100 items): individual creates in a transaction are fine
await store.transaction(async (tx) => {
  for (const person of people) {
    await tx.nodes.Person.create(person);
  }
});

// Medium batch (100–10,000 items): bulkCreate
const created = await store.nodes.Person.bulkCreate(people);

// Large batch (10,000+ items): bulkInsert (no result allocation)
await store.nodes.Person.bulkInsert(people);

// Idempotent import: bulkUpsert (creates or updates by ID)
await store.nodes.Person.bulkUpsert(itemsWithIds);
```

### Batch reads

`getByIds()` on node and edge collections uses a single `SELECT ... WHERE id IN (...)` instead of N
individual queries. Results are returned in input order with `undefined` for missing entries.

```typescript
const [alice, bob] = await store.nodes.Person.getByIds([aliceId, bobId]);
```

:::note[Operation hooks]
Bulk operations (`bulkCreate`, `bulkInsert`, `bulkUpsert`) skip per-item operation hooks for
throughput. Query hooks still fire normally. See [Schemas & Stores](/schemas-stores#hooks) for details.
:::

## Connection Management

TypeGraph does not manage database connections or pools — you bring your own and are responsible
for lifecycle. See [Backend Setup](/backend-setup) for full setup guides.

### PostgreSQL pooling

Always use a connection pool in production. TypeGraph issues one SQL statement per query, so pool
utilization is straightforward — no long-held connections or multi-statement conversations.

```typescript
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                       // Size based on your concurrency needs
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

pool.on("error", (err) => {
  console.error("Unexpected pool error", err);
});
```

**Sizing guidance:** Each concurrent query uses one connection for the duration of that single SQL
statement. A pool of 10–20 connections handles most workloads. If you're running bulk imports in
parallel, size up accordingly.

### SQLite concurrency

SQLite is single-writer. For best throughput:

- Enable WAL mode: `sqlite.pragma("journal_mode = WAL")` — allows concurrent reads while writing
- Batch writes in transactions rather than issuing many small commits
- For read-heavy workloads, SQLite performs well without pooling since `better-sqlite3` is synchronous

### Transaction isolation

PostgreSQL transactions accept an optional isolation level:

```typescript
await store.transaction(
  async (tx) => {
    // Serializable isolation for strict consistency
    const snapshot = await tx.nodes.Account.getById(accountId);
    // ...
  },
  { isolationLevel: "serializable" },
);
```

Available levels: `read_uncommitted`, `read_committed` (default), `repeatable_read`, `serializable`.

SQLite always operates at `serializable` isolation.

## Query Optimization Features

### Precomputed Closures

When you define an ontology (e.g., `subClassOf`, `implies`), TypeGraph precomputes the full
transitive closure at store initialization. Queries like
`.from("Parent", "p", { includeSubClasses: true })` use a pre-calculated list of kinds rather than
recursive lookups at runtime.

### Smart Select

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

This optimization pairs well with [covering indexes](/performance/indexes#covering-indexes): if
your index contains both the filter keys and the selected keys, the database can satisfy the query
with an index-only scan.

**When optimization applies:**

| Pattern | Optimized? | Reason |
|---------|-----------|--------|
| `ctx => ({ email: ctx.p.email })` | Yes | Simple field extraction |
| `ctx => [ctx.p.id, ctx.p.name]` | Yes | Multiple fields in array |
| `ctx => ctx.p` | No | Whole node returned |
| `ctx => ({ upper: ctx.p.email.toUpperCase() })` | Yes | Field extracted; method runs in JS |
| `ctx => ({ ...ctx.p })` | No | Spread requires full node |

The optimization is transparent — if your callback can't be optimized, TypeGraph automatically
falls back to fetching the full node data.

:::note[Select callback purity]
Smart select applies to `.execute()`, `.paginate()`, and `.stream()`. The `select()` callback may be evaluated
multiple times during planning/optimization, so it should be pure (no side effects).
:::

:::note[Known limitations]
Smart select is not currently applied to queries that include variable-length traversals (recursive CTEs),
even when the select callback is otherwise optimizable.
:::

### Built-in Indexes

The default TypeGraph schema includes optimized indexes for the most common access patterns:

- **Graph + Kind + ID**: Primary key for node lookups
- **Graph + From/To ID**: Optimized for edge traversals
- **Temporal columns**: Indexes on `valid_from`, `valid_to`, and `deleted_at`

For application-specific indexes on JSON properties, see [Indexes](/performance/indexes).

### Compilation Caching

Each builder method (`.where()`, `.limit()`, `.orderBy()`, etc.) returns a new immutable instance.
The compiled SQL for each instance is cached internally — repeated `.execute()` calls on the same
builder skip recompilation entirely. This applies to standard queries, aggregate queries, and
set-operation queries (`union`, `intersect`, `except`). This is transparent and requires no API changes.

```typescript
const activeUsers = store
  .query()
  .from("User", "u")
  .whereNode("u", (u) => u.status.eq("active"))
  .select((ctx) => ctx.u);

// First call: compiles AST → SQL → executes
await activeUsers.execute();

// Second call: reuses cached SQL → executes
await activeUsers.execute();
```

### Prepared Queries

For hot paths that execute the same query shape with different values, `.prepare()` pre-compiles the
entire query pipeline (AST build, SQL compilation, text extraction) once. Subsequent
`.execute(bindings)` calls only substitute parameter values and execute.

When `executeRaw` is available (both SQLite and PostgreSQL backends), the pre-compiled SQL text is
sent directly to the driver — zero recompilation overhead.

Best for: API endpoints, hot loops, or any code path that runs the same query shape repeatedly.

See [Prepared Queries](/queries/execute#prepared-queries) for usage details.

## Best Practices

### Filter early

Apply `.whereNode()` predicates as early as possible in your query chain. TypeGraph moves these
predicates into the initial CTEs, reducing the number of rows that need to be joined in subsequent
steps.

### Select specific fields

When you only need certain fields, select them explicitly rather than returning whole nodes.
This triggers the [smart select optimization](#smart-select) and can enable index-only scans with
properly configured indexes.

```typescript
// Preferred: Only fetches what you need
.select((ctx) => ({ name: ctx.p.name, email: ctx.p.email }))

// Avoid when possible: Fetches entire props blob
.select((ctx) => ctx.p)
```

### Use specific kinds

Unless you specifically need to query across a hierarchy, avoid `includeSubClasses: true`. Being
specific about the node kind allows the SQL engine to use more restrictive index scans.

### Use cursor pagination

For large datasets, prefer `.paginate()` over `.limit()` and `.offset()`. Keyset pagination
(using cursors) avoids the `O(N)` cost of skipping rows in standard SQL offsets.

### Index your filter and sort properties

TypeGraph's built-in indexes cover structural lookups (by ID, by edge endpoints). Properties you
filter or sort on in `whereNode()`, `whereEdge()`, and `orderBy()` need application-specific
[expression indexes](/performance/indexes). Use the [Query Profiler](/performance/profiler) to
identify which properties need coverage.

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

## Benchmarks

TypeGraph uses a deterministic performance sanity suite as its benchmark and regression gate.
The suite seeds a realistic graph shape and measures end-to-end query latency across:

- forward and reverse traversals
- inverse/symmetric traversal (`expand: "inverse"` / `expand: "all"`)
- 2-hop and 3-hop traversals
- aggregate queries
- cached execute vs prepared execute
- deep traversals (`10`/`100`/`1000` hop recursive with `cyclePolicy: "allow"`)

Guardrail thresholds enforce expected behavior in CI (for example, traversal latency caps and
ratio checks such as reverse/forward and deep-hop scaling).

Deep-recursive benchmark probes explicitly set `cyclePolicy: "allow"` to isolate recursive CTE
expansion cost; the default `cyclePolicy: "prevent"` prioritizes cycle-safe semantics and is
expected to be slower on long traversals.

*Note: Real-world performance varies by hardware, database driver, network latency (for PostgreSQL),
and schema/data shape.*

<details>
<summary>Benchmark configuration and guardrails</summary>

Current suite configuration:

| Setting | Value |
|---------|-------|
| Seed users | 1200 |
| Follows per user | 10 |
| Posts per user | 5 |
| Batch size | 250 |
| Warmup iterations | 2 |
| Sample iterations (median reported) | 15 |

Default guardrails:

| Check | Threshold |
|-------|-----------|
| reverse/forward ratio | <= 6x |
| inverse traversal latency | <= 500ms |
| inverse/forward ratio | <= 10x |
| 3-hop latency | <= 500ms |
| 3-hop/2-hop ratio | <= 8x |
| aggregate latency | <= 500ms |
| aggregate distinct latency | <= 700ms |
| aggregateDistinct/aggregate ratio | <= 4x |
| cached execute latency | <= 500ms |
| prepared execute latency | <= 500ms |
| prepared/cached ratio | <= 2x |
| 10-hop recursive latency | <= 250ms |
| 100-hop recursive latency | <= 1000ms |
| 100-hop-recursive/10-hop-recursive ratio | <= 30x |
| 1000-hop recursive latency | <= 5000ms |
| 1000-hop-recursive/100-hop-recursive ratio | <= 20x |

Backend-specific overrides:

| Backend | Check | Threshold |
|---------|-------|-----------|
| SQLite | 1000-hop recursive latency | <= 7000ms |
| PostgreSQL | inverse traversal latency | <= 1000ms |
| PostgreSQL | inverse/forward ratio | <= 30x |
| PostgreSQL | 3-hop latency | <= 1000ms |
| PostgreSQL | aggregate distinct latency | <= 1200ms |
| PostgreSQL | prepared execute latency | <= 700ms |

</details>

### Running benchmarks locally

```bash
pnpm bench
```

For guardrail mode (fails on regression thresholds):

```bash
pnpm --filter @nicia-ai/typegraph-benchmarks perf:check
```

Run the same guardrailed suite against PostgreSQL:

```bash
POSTGRES_URL=postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test \
  pnpm --filter @nicia-ai/typegraph-benchmarks perf:check:postgres
```

The benchmark source code is located in `packages/benchmarks/src/`.

## Next Steps

- [Indexes](/performance/indexes) — Define custom indexes for your schema
- [Query Profiler](/performance/profiler) — Identify missing indexes automatically
- [Backend Setup](/backend-setup) — Connection setup, pooling, and lifecycle
