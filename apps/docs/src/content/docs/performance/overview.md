---
title: Performance Overview
description: Understanding the performance characteristics of TypeGraph
---

TypeGraph is designed to be a high-performance, low-overhead layer on top of
your relational database. By leveraging the power of modern SQL engines (SQLite
and PostgreSQL) and precomputing complex relationships, TypeGraph ensures that
your knowledge graph scales with your application.

## Performance Philosophy

1. **One Fluent Query, One Statement**: Every fluent query — including multi-hop traversals —
   compiles to a single SQL statement, so its statement count never grows with the size of the
   graph. This prevents compiler-generated N+1 work inside that query; application code can still
   create an N+1 by issuing separate reads in a loop. (Compilation, not execution: a query whose
   selective-field mapping falls back re-runs as a full fetch, costing a second statement. See
   [Batch reads](#batch-reads).)
2. **Precomputed Ontology**: Transitive closures, subclass hierarchies, and edge implications are
   computed once at schema initialization, not during every query.
3. **Batching & Transactions**: Bulk collection APIs minimize round-trips for writes. On the read
   side that job belongs to the query compiler — `store.batch()` only caps concurrency at one query
   in flight, it does not reduce round trips and it is not a snapshot.
4. **Zero-Cost Abstractions**: Type safety and ontological reasoning add no measurable runtime overhead.

## N+1 Prevention

A common performance problem in ORMs is the N+1 query: you fetch N entities, then issue one
query per entity to load related data. TypeGraph's fluent query compiler eliminates that pattern
inside one graph-shaped query; it cannot eliminate separate collection reads issued by application
code.

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

The fluent query needs no dataloader for that joined read because the database handles its entire
join graph in one execution. Separate reads can still form an N+1; use a traversal, `subgraph()`, or
the chunked collection reads described below instead of looping them or wrapping them in
`store.batch()`.

## Batch Write Patterns

### Single vs bulk operations

For small numbers of writes, individual `create()` calls inside a transaction are fine. For larger
volumes, use the bulk collection APIs — they use multi-row INSERTs and handle parameter chunking
internally.

| Method | Returns results | Use case |
|--------|----------------|----------|
| `bulkCreate(items)` | Yes | Need created nodes back |
| `bulkInsert(items)` | No | Maximum throughput ingestion |
| `bulkUpsertById(items)` | Yes | Idempotent import (create or update by ID) |
| `bulkDelete(ids)` | No | Mass soft-delete |
| `trustedImportGraphStream(store, chunks)` | No | Fastest initial load into a fresh dedicated database |

The collection APIs remain the default: they validate data and maintain every
configured constraint and sidecar. For a one-time initial load whose producer
already guarantees those invariants, the distinct
[`trustedImportGraphStream`](/interchange#trusted-initial-import) surface uses a
single transaction, engine-native inserts, and deferred secondary-index builds.
It intentionally rejects non-empty databases and graph features it cannot yet
maintain.

### PostgreSQL parameter limits

PostgreSQL's protocol can encode 65,535 bind parameters, while TypeGraph uses a portable
65,533-parameter budget across its bundled drivers. Bulk operations are automatically chunked to
stay within that budget:

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

// Idempotent import: bulkUpsertById (creates or updates by ID)
await store.nodes.Person.bulkUpsertById(itemsWithIds);

// Fresh dedicated database + already-validated producer:
await trustedImportGraphStream(store, interchangeChunks);
```

### Batch sizing for large multi-call imports

For a dataset too large for a single `bulkInsert`/`bulkCreate` call (e.g., streaming rows from a
file in a loop), the *size* of each call matters, not just the total row count. Each call is its
own transaction, and — per the default
[`autoRefreshStatistics`](/backend-setup#refreshing-planner-statistics-after-bulk-loads) — can
trigger a planner-statistics refresh on its own. In a large-scale bulk-load benchmark, batches of
~2,000 rows per call were consistently ~25-30% slower per row than batches of ~20,000+: fewer,
larger calls amortize both the per-call transaction commit and the statistics refresh across more
rows. Prefer batch sizes in the tens of thousands when looping over many calls for a large import,
and consider `autoRefreshStatistics: false` plus one `store.refreshStatistics()` call after the
loop if per-call refreshes still dominate.

### Batch reads

`getByIds()` on node and edge collections uses `SELECT ... WHERE id IN (...)` — one statement per
bind-limit chunk, so a single statement for id counts under the limit — instead of N individual
queries. Results are returned in input order with `undefined` for missing entries.

```typescript
const [alice, bob] = await store.nodes.Person.getByIds([aliceId, bobId]);
```

For multiple independent queries with different shapes and filters, use
[`store.batch()`](/schemas-stores#batch-query-execution) to run them in sequence against one target.
Note the cost: on a transactional backend it still issues at least one statement per query plus
`begin`/`commit`, so N queries are N+2 round trips at best; without transactions there is no
framing. It buys a connection profile that never peaks at N — not lower latency, and not a snapshot
(PostgreSQL's default read-committed isolation lets a later query see a newer commit):

```typescript
const [activeUsers, recentOrders] = await store.batch(
  store.query().from("User", "u")
    .whereNode("u", (u) => u.status.eq("active"))
    .select((ctx) => ({ id: ctx.u.id, name: ctx.u.name })),
  store.query().from("Order", "o")
    .select((ctx) => ({ id: ctx.o.id, total: ctx.o.total }))
    .orderBy("o", "createdAt", "desc")
    .limit(20),
);
```

Edge collection `batchFind*` methods (`batchFindFrom`, `batchFindTo`, `batchFindByEndpoints`) also
participate in `store.batch()`. On a transactional backend they move N `findFrom`/`findTo` calls
into one transaction — the statement count is unchanged either way. If the round trips are what
hurt, replace the calls with a traversal (one statement) or `store.subgraph()` (a fixed 2 on
SQLite, 3 on PostgreSQL, however large the result).

To read the edges of a *set* of endpoints, prefer `bulkFindFrom` / `bulkFindTo` (see
[Edge Collections](/schemas-stores#edge-collections)).
Where `store.batch()` runs N singleton reads over one connection, these widen the endpoint predicate
itself to `from_id IN (...)` — one set-oriented statement per endpoint kind and bind-budget chunk,
on the same index prefix seek the singleton read uses — and return the edges grouped per input:

```typescript
const people = await store.nodes.Person.find({ limit: 50 });
const jobsPerPerson = await store.edges.worksAt.bulkFindFrom(people);
// jobsPerPerson[i] holds the worksAt edges of people[i]
```

This is the fix for the "list view with relationship counts" N+1: statement count grows with
endpoint kinds and bind-budget chunks instead of with every item on the page. Pass `limitPerInput`
to bound each endpoint's fan-out.

:::note[Operation hooks]
Bulk operations (`bulkCreate`, `bulkInsert`, `bulkUpsertById`) skip per-item operation hooks for
throughput. Query hooks still fire normally. See
[Schemas & Stores](/schemas-stores#observability-hooks) for details.
:::

## Connection Management

Managed local Store and backend factories own and close their SQLite or PGlite
resources. Bring-your-own adapter integrations leave the supplied connection or
pool under application control. See [Backend Setup](/backend-setup#connection-management)
for the ownership matrix and shutdown examples.

### PostgreSQL pooling

Always use a connection pool in production. An individual query holds a connection only while each
statement runs. Most queries issue a single statement; a query whose selective-field mapping falls
back issues a second. `store.transaction()` holds one connection for the whole callback, and
`store.batch()` does the same for its implicit transaction.

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

**Sizing guidance:** Each concurrent query holds one connection for as long as its statement runs.
A pool of 10–20 connections handles most workloads. If you're running bulk imports in parallel,
size up accordingly.

**Reducing pool pressure with `batch()`:** When loading multiple independent queries (e.g., a
detail page with several relationship types), `Promise.all` can acquire up to N connections
simultaneously — fewer if the pool is undersized or saturated, in which case it queues instead.
[`store.batch()`](/schemas-stores#batch-query-execution) keeps at most one query in flight, so peak
connection use is 1 — on a transactional backend that is literally one checked-out connection for
the implicit transaction; elsewhere it is one at a time, and whether the adapter reuses the same
client is its own business. It does not reduce the statement count, and read-committed isolation
means it is not a snapshot.

### SQLite concurrency

SQLite is single-writer. For best throughput:

- Use WAL with `synchronous=NORMAL`. `createLocalSqliteBackend` applies both
  (plus a 5s `busy_timeout`) automatically; on a bring-your-own connection set
  them yourself: `sqlite.pragma("journal_mode = WAL")`,
  `sqlite.pragma("synchronous = NORMAL")`. On file databases this makes
  single-operation writes roughly 5× faster than the driver defaults.
- Batch writes in transactions rather than issuing many small commits. (One
  nuance: pure bulk appends of fresh pages can run marginally faster under the
  rollback journal than WAL, since WAL writes pages twice — the per-commit wins
  dominate everywhere else.)
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
your index contains both the filter keys and the selected keys, the database can serve the query
straight from the index instead of scanning the whole table — though on PostgreSQL specifically,
this stops short of a true `Index Only Scan` for JSONB-extracted fields; see the
[covering indexes](/performance/indexes#covering-indexes) section for the concrete limitation and
a workaround.

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

For data-dependent callbacks, TypeGraph first plans with representative values, including a
high-value pass that covers common numeric threshold branches. If an unobserved branch accesses an
additional field at execution time, the first miss may require a second statement that fetches the
full row. Prepared queries remember that missing-field failure and use the full-row plan directly on
later executions. Comparisons against arbitrary string values can still take an unobserved branch;
the high-value pass does not guarantee that every possible callback path is planned in advance.

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

### SQL Compilation

Each builder method (`.where()`, `.limit()`, `.orderBy()`, etc.) returns a new immutable instance.

A reused query instance compiles **once**. The first `.execute()` builds a cached template and every
later call reuses it — for standard queries, aggregate queries, set-operation queries (`union`,
`intersect`, `except`), and prepared queries alike. Explicit `.toSQL()` / `.compile()` calls are the
exception: they compile on demand every time, because producing the statement is the thing the
caller asked for.

The subtlety a cache like that has to survive is freshness. A "current" (live) read filters on
temporal validity as of the instant it runs, so a template with a concrete "now" baked into it would
freeze that instant for the query instance's whole lifetime, hiding every row created afterward. The
template therefore reserves the read instant as a **placeholder** rather than a value, and each
execution fills it with a fresh instant alongside that call's bindings. Nothing in the statement's
text depends on either, so reuse costs no freshness.

```typescript
const activeUsers = store
  .query()
  .from("User", "u")
  .whereNode("u", (u) => u.status.eq("active"))
  .select((ctx) => ctx.u);

// One compilation, two executions. The read instant is bound per call, so a
// user created between these two is visible to the second one.
await activeUsers.execute();
await activeUsers.execute();
```

Two things fall back to compiling on every call:

- **Backends that cannot execute pre-compiled SQL text** — a custom or async backend, i.e. one
  without `executeRaw`.
- **Statements whose execution semantics ride on the compiled SQL object rather than its text**,
  even on PostgreSQL with `executeRaw` fully available. Two query shapes do: **approximate vector
  search** (`similarTo(..., { approximate: true })`, which carries the pgvector / `sqlite-vec`
  iterative-scan wrapper) and **`store.subgraph()` on PostgreSQL**, whose id-array fetches are
  marked to force a custom plan so the planner sizes them against the actual array rather than
  reusing a generic one. Flattening either to cacheable text would silently drop the behavior it
  depends on, so they are excluded deliberately — the trade is a template hit against correct
  execution, and correctness wins.

Compilation is pure, in-memory string-building with no I/O, so both fallbacks are cheap; the query's
database round-trip dominates either way. Worth knowing if you are profiling a vector query and
expecting the compile-once behavior described above — that is the one shape where it does not apply.

### Prepared Queries

For hot paths that execute the same query shape with different values, `.prepare()` builds and
structurally validates the query AST once — a malformed query fails fast, before the first
`.execute()`, instead of on first use — and compiles the statement once into a cached template. Each
`.execute(bindings)` fills that template's placeholders (a fresh read instant plus the call's own
parameter values) and runs the cached text directly through `executeRaw`.

Because arity never reaches the SQL text, a list-valued parameter reuses the same template no matter
how long the list is:

```typescript
const byIds = store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.id.in(param("ids")))
  .select((ctx) => ctx.p)
  .prepare();

await byIds.execute({ ids: ["a", "b", "c"] });
await byIds.execute({ ids: ["d"] }); // same compiled statement
```

Best for: validating a query shape once, then reusing it with different parameter values. The saved
compilation is real but small — the database round-trip still dominates.

See [Prepared Queries](/queries/execute#prepared-queries) for usage details.

### Subgraph extraction

For the "load entity with all relationships" pattern, [`store.subgraph()`](/schemas-stores#subgraph-extraction)
is the fastest strategy. It compiles to a recursive CTE that fans out across all specified edge
types in a fixed 2 statements on SQLite and 3 on PostgreSQL — no matter how many relationship kinds
are involved, or how much it returns. See
[Choosing a query strategy](/schemas-stores#choosing-a-query-strategy) for guidance on when to use
`subgraph()` vs the fluent query builder vs manual `findFrom` calls.

The [`project` option](/schemas-stores#subgraph-projection) further reduces overhead by extracting
only the specified fields per kind at the SQL level via `json_extract()` / JSONB paths, skipping
full `props` blob transfer and metadata columns for projected kinds.

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

### Real-world workload validation

Beyond the synthetic guardrail suite above, TypeGraph is also exercised against the
[LDBC Social Network Benchmark (SNB) Interactive](https://github.com/ldbc/ldbc_snb_interactive_v1)
workload — a standard, independently-defined graph benchmark, not a TypeGraph-specific one — at
SF1 scale (~10k persons, ~1M posts, ~2M comments). This surfaced and fixed two real scaling bugs in
the library: an unbounded `ANALYZE` cost on bulk SQLite loads, and an N+1 endpoint-existence check
in batched edge creation. It also directly produced the `keySystemColumns` guidance and the
PostgreSQL index-only-scan caveat in [Indexes](/performance/indexes#covering-indexes). The
benchmark source lives in `packages/benchmarks/src/real/` in the repository.

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

By default the SQLite suite runs against an in-memory database, which
measures engine and compile cost but not WAL/fsync behavior. Add
`--storage=file` (or use the `perf:file` / `perf:check:file` scripts) to run
against a temporary on-disk database — the lane that reflects real local
deployments.

A separate write-throughput bench measures single-op creates,
transaction-amortized creates, `bulkCreate`, search-indexed creates
(fulltext + vector sync), and `importGraph`, normalized to milliseconds per
operation:

```bash
pnpm --filter @nicia-ai/typegraph-benchmarks bench:write        # sqlite, in-memory
pnpm --filter @nicia-ai/typegraph-benchmarks bench:write:file   # sqlite, on-disk
POSTGRES_URL=... pnpm --filter @nicia-ai/typegraph-benchmarks bench:write:postgres
```

The write bench is report-only (no guardrails): write latency is dominated
by fsync behavior on the file lane and needs per-machine calibration.

The benchmark source code is located in `packages/benchmarks/src/`.

## Next Steps

- [Indexes](/performance/indexes) — Define custom indexes for your schema
- [Query Profiler](/performance/profiler) — Identify missing indexes automatically
- [Backend Setup](/backend-setup) — Connection setup, pooling, and lifecycle
