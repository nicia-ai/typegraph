---
title: Limitations
description: Known constraints and backend-specific limitations
---

This page documents TypeGraph's known limitations and constraints.

## Backends Without Atomic Transactions

Some runtimes cannot hold a multi-statement database session and therefore
cannot offer atomic transactions:

- **Cloudflare D1** — the D1 binding has no interactive transaction
  primitive (`D1Database.batch(...)` is transactional but batch-only).
- **`drizzle-orm/neon-http`** — Neon's HTTP driver issues each statement as
  an independent request; there is no session to bind a transaction to.

Cloudflare **Durable Objects** SQLite is *not* in this list: a store backed
by `drizzle(ctx.storage)` is auto-detected as `transactionMode: "do-sqlite"`,
reports `capabilities.transactions: true`, and is fully atomic. An
`AdapterStore` created from that backend also exposes the adapter-only
`store.withTransaction` and `tx.sql` surfaces. See
[Backend Setup](/backend-setup#cloudflare-durable-objects-sqlite).

These backends report `capabilities.transactions: false`. On such backends,
`store.transaction(fn)` and `store.batch(...)` still run — `fn` executes
against the same backend used outside `transaction()`, sequentially —
**but writes are applied as they happen and a thrown error inside the
callback does not roll back earlier writes**. Likewise, `store.batch(...)`
runs each query over an independent connection, so two queries in the same
batch may observe different database snapshots.

```typescript
// On D1 / neon-http: every successful create is persisted immediately.
// If the throw fires after Alice is created, Alice stays in the database.
await store.transaction(async (tx) => {
  await tx.nodes.Person.create({ name: "Alice" });
  throw new Error("boom"); // does NOT roll back the create above
});
```

**If you require atomicity, branch on the capability:**

```typescript
if (store.capabilities.transactions) {
  await store.transaction(async (tx) => {
    /* atomic */
  });
} else {
  // Sequential, non-atomic — handle partial-failure recovery yourself.
  const person = await store.nodes.Person.create({ name: "Alice" });
  const company = await store.nodes.Company.create({ name: "Acme" });
  await store.edges.worksAt.create(person, company, { role: "Engineer" });
}
```

If you need atomic writes from an edge runtime, use
`drizzle-orm/neon-serverless` (WebSocket-backed Pool) instead of
`drizzle-orm/neon-http`.

## libsql Single-Connection Transactions

For local `@libsql/client` connections (`file:` paths and `file::memory:`),
`createLibsqlBackend` frames transactions with raw `BEGIN IMMEDIATE`/`COMMIT`
statements on the client's single stable connection. It deliberately avoids
`client.transaction()`, which hands the client's connection to the transaction
and lazily opens a new one afterwards — for an in-memory database that new
connection is a fresh, empty database
([tursodatabase/libsql-client-ts#229](https://github.com/tursodatabase/libsql-client-ts/issues/229)).
In-memory databases therefore work for all operations, including transactions.
Remote Turso connections (`libsql://`, `http(s)://`) run each transaction on
its own stream via the driver.

The trade-off of a single connection: a store-level operation awaited from
**inside** a `store.transaction` callback (on the root store, rather than the
`tx` context) can never run — the open transaction occupies the backend's
serialized execution slot until it completes — so the backend rejects it with
a `ConfigurationError` instead of deadlocking.

```typescript
// ✅ In-memory works, including transactions
const client = createClient({ url: "file::memory:" });

// ❌ Root-store access inside a transaction callback throws
await store.transaction(async (tx) => {
  await store.nodes.Person.find(); // ConfigurationError — use tx.nodes
  await tx.nodes.Person.find(); // ✅ transaction-scoped access
});
```

## Recursive Traversal Depth

Variable-length traversals use two caps:

1. Unbounded traversals (no `maxHops` option) are capped at 10 hops.
2. Explicit `maxHops` values are validated up to 1000 hops (`maxHops: >1000` throws).
3. Cycle prevention is on by default. To skip cycle checks for speed, opt into
   `cyclePolicy: "allow"` (which may revisit nodes across hops).

This prevents runaway queries while still supporting deep, intentionally bounded traversals.

```typescript
// Implicitly limited to 10 hops
store
  .query()
  .from("Person", "p")
  .traverse("reportsTo", "e")
  .recursive()
  .to("Person", "manager");

// Explicit limits up to 1000 are honored
store
  .query()
  .from("Person", "p")
  .traverse("reportsTo", "e")
  .recursive({ maxHops: 200 }) // honored
  .to("Person", "manager");

// Explicit limits above 1000 throw
store
  .query()
  .from("Person", "p")
  .traverse("reportsTo", "e")
  .recursive({ maxHops: 2000 }) // throws
  .to("Person", "manager");
```

The unbounded-traversal limit is defined as `MAX_RECURSIVE_DEPTH`:

```typescript
import { MAX_RECURSIVE_DEPTH } from "@nicia-ai/typegraph";
// MAX_RECURSIVE_DEPTH = 10
```

## Connection Management

Managed Store factories own their local SQLite or PGlite connection, and their
`store.close()` method releases it. The local backend factories
`createLocalSqliteBackend` and `createLocalPgliteBackend` likewise expose an
owned backend whose `close()` releases its resources.

Bring-your-own adapter factories leave connection ownership with you. For
`createSqliteBackend`, `createPostgresBackend`, and `createLibsqlBackend`, you
are responsible for:

1. **Creating and configuring** the database connection
2. **Implementing connection pooling** for production use
3. **Closing connections** when done

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteBackend, generateSqliteMigrationSQL } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";

// You manage the connection
const sqlite = new Database("app.db");
sqlite.exec(generateSqliteMigrationSQL());
const db = drizzle(sqlite);

const backend = createSqliteBackend(db);
const store = createStore(graph, backend);

// You close the connection
sqlite.close();
```

For production deployments, use connection pooling:

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum connections
});

const db = drizzle(pool);
const backend = createPostgresBackend(db);
```

In the bring-your-own example above, `store.close()` leaves the supplied driver
open. Close that driver or pool through its own API.

## Predicate Serialization

Where predicates in unique constraints cannot be serialized. If you use schema
serialization for versioning or migration, predicates are stored as
`"[predicate]"` and cannot be reconstructed.

```typescript
// This predicate works at runtime...
unique({
  name: "email_unique_when_active",
  fields: ["email"],
  where: (props) => props.status.isNotNull(),
});

// ...but serializes as:
// { "where": "[predicate]" }
```

**Workaround:** For full schema serialization support, avoid predicates in unique constraints.
Use application-level validation instead.

## Vector Search Backend Requirements

Vector and hybrid search work across all primary backends via a pluggable
`VectorStrategy`. Each backend advertises its capabilities through
`backend.capabilities.vector` (`{ supported, metrics, indexTypes, maxDimensions }`):

| Backend | Requirement | Metrics |
|---------|-------------|---------|
| PostgreSQL | pgvector extension (HNSW / IVFFlat) | cosine, l2, inner_product |
| SQLite | sqlite-vec extension (`vec0` KNN) | cosine, l2 |
| libSQL / Turso | built-in native engine (DiskANN); nothing to load | cosine, l2 |
| D1 | Not supported | — |

Note that `inner_product` is PostgreSQL-only — sqlite-vec and libSQL support
cosine and l2 only.

Using vector predicates on unsupported backends throws `UnsupportedPredicateError`:

```typescript
try {
  await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.embedding.similarTo(queryVector, 10))
    .execute();
} catch (error) {
  if (error instanceof UnsupportedPredicateError) {
    // Vector search not available on this backend
  }
}
```

## Query Builder Type Inference

Complex query chains may occasionally require explicit type annotations when TypeScript cannot
infer the full type. This is rare but can occur with deeply nested selects or unions.

```typescript
// If type inference fails, add explicit type
const results = await store
  .query()
  .from("Person", "p")
  .select((ctx) => ({
    name: ctx.p.name as string,  // Explicit annotation
  }))
  .execute();
```

## Bulk Operation Limits

Bulk operations (`bulkCreate`, `bulkInsert`, `bulkUpsertById`, `bulkDelete`) have practical limits based on your database:

| Database | Recommended Batch Size |
|----------|----------------------|
| SQLite | 500-1000 items |
| PostgreSQL | 1000-5000 items |

For larger datasets, batch your operations:

```typescript
const BATCH_SIZE = 1000;

for (let i = 0; i < items.length; i += BATCH_SIZE) {
  const batch = items.slice(i, i + BATCH_SIZE);
  await store.nodes.Person.bulkCreate(batch);
}
```

## Graph Analytics Limits

TypeGraph ships focused algorithms on `store.algorithms.*` — shortest path
(weighted and unweighted), reachability, k-hop neighborhoods, degree, exact
weakly connected components, deterministic label propagation, and
global/personalized PageRank. See
[Graph Algorithms](/graph-algorithms) for the full API.

The following heavier analytics are **not** provided:

- Modularity-optimizing community detection such as Leiden or Louvain
- Centrality measures beyond degree (betweenness, closeness, eigenvector)
- Strongly connected components
- Topological sort
- Graph partitioning

For these use cases, export your data via `.query().traverse()` or
`store.subgraph()` and use a specialized library such as
[graphology](https://graphology.github.io/) in memory, or move to a
dedicated graph database.

## Single Database Deployment

TypeGraph is designed for single-database deployments. It does not support:

- Distributed storage across multiple databases
- Sharding
- Cross-database queries
- Replication coordination

For distributed graph workloads, consider a dedicated graph database.

## Temporal Query Limitations

Temporal queries (`asOf`, `includeEnded`) work correctly but have some constraints:

- Point-in-time queries cannot be combined with streaming (`.stream()`)
- `validFrom` defaults to the record's own creation timestamp when omitted, so `asOf` queries
  work out of the box; an end boundary still requires an explicit `validTo` — an open `validTo`
  means "still valid"
- Clock skew between application servers can affect temporal accuracy

### Recorded / system time (`history: true`)

Recorded-time capture (`createStore(graph, backend, { history: true })`) and
`store.asOfRecorded(T)` add a second temporal axis with these constraints. Use
`createAdapterStore(..., { history: true })` instead when the application must
adopt a caller-owned transaction:

- **Opt-in, no backfill.** Capture only sees changes committed after it is
  enabled; an entity that already exists is first recorded the next time it is
  written. Enable it on a fresh graph for complete history.
- **TypeGraph-write capture.** Built-in capture records TypeGraph collection
  writes only. Out-of-band database writes and row-returning raw SQL paths are
  not captured into the recorded relations.
- **Reconstructing reads only.** A recorded view exposes point reads
  (`getById` / `getByIds`), bounded deterministic `scan()` pages, `query()`,
  `subgraph()`, and the graph algorithms. Broad filtered collection reads
  (`find` / `count` / `findFrom`), `search`, and fulltext / vector predicates are
  refused — those indexes reflect current state and cannot answer a
  recorded-time query.
- **Transactional backend required.** Capture needs a backend with atomic
  transactions and statement execution — the built-in SQLite / PostgreSQL
  backends qualify. A custom backend must implement `executeStatement` (optional
  on the `GraphBackend` interface, but required once `history: true` is set) or
  enabling capture throws a `ConfigurationError` at write time. On an
  `AdapterHistoryStore`, raw `tx.sql` is disabled under `history: true`; adopt
  external transactions with `store.withRecordedTransaction(...)` instead of
  `store.withTransaction(...)` (which is a compile error on a history store).
- **Reconstruction cost.** Recorded reads rebuild from the history relations and
  are slower than live reads, most noticeably for full-graph subgraph /
  algorithm reconstructions on PostgreSQL.
- **PostgreSQL capture requires `READ COMMITTED`.** Every captured commit
  advances a single recorded-clock row for the graph. TypeGraph refuses
  PostgreSQL `REPEATABLE READ` / `SERIALIZABLE` history-capture transactions
  because snapshot isolation cannot safely allocate that per-graph recorded
  clock inside the captured transaction. Omit the transaction isolation option,
  or set it to `read_committed`.

## Schema Migration Constraints

Automatic migrations (`createStoreWithSchema`) only handle additive changes:

| Change Type | Auto-Migrated |
|-------------|---------------|
| Add new node type | Yes |
| Add new edge type | Yes |
| Add optional property | Yes |
| Add required property | No |
| Remove property | No |
| Rename type | No |
| Change property type | No |

Breaking changes throw `MigrationError` and require manual migration.
