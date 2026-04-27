---
title: Limitations
description: Known constraints and backend-specific limitations
---

This page documents TypeGraph's known limitations and constraints.

## Backends Without Atomic Transactions

Some runtimes cannot hold a multi-statement database session and therefore
cannot offer atomic transactions:

- **Cloudflare D1** — the D1 binding has no transaction primitive.
- **`drizzle-orm/neon-http`** — Neon's HTTP driver issues each statement as
  an independent request; there is no session to bind a transaction to.

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
if (backend.capabilities.transactions) {
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

## libsql In-Memory Transactions

When using `@libsql/client` with `file::memory:`, transactions destroy the in-memory
database. This happens because libsql opens a new connection for each transaction, and
each connection to `:memory:` gets its own database
([tursodatabase/libsql-client-ts#229](https://github.com/tursodatabase/libsql-client-ts/issues/229)).

**Workaround:** Use a file-based database (`file:path.db`) or a remote Turso URL when
transactions are needed. In-memory databases work fine for all non-transactional operations.

```typescript
// ❌ Transactions break with in-memory
const client = createClient({ url: "file::memory:" });

// ✅ Use a file path instead
const client = createClient({ url: "file:app.db" });

// ✅ Or a remote Turso URL
const client = createClient({ url: "libsql://my-db.turso.io", authToken: "..." });
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

TypeGraph does not manage database connections. You are responsible for:

1. **Creating and configuring** the database connection
2. **Implementing connection pooling** for production use
3. **Closing connections** when done

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteBackend, generateSqliteMigrationSQL } from "@nicia-ai/typegraph/sqlite";

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
import { createPostgresBackend } from "@nicia-ai/typegraph/postgres";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum connections
});

const db = drizzle(pool);
const backend = createPostgresBackend(db);
```

The `store.close()` method is a no-op. Connection cleanup is your responsibility.

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

Vector similarity search requires specific database extensions:

| Backend | Requirement |
|---------|-------------|
| PostgreSQL | pgvector extension |
| SQLite | sqlite-vec extension |
| D1 | Not supported |

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

## No Built-in Graph Analytics

TypeGraph ships a small set of Tier 1 connectivity algorithms on
`store.algorithms.*` — shortest path, reachability, k-hop neighborhoods,
and degree. See [Graph Algorithms](/graph-algorithms) for the full API.

The following heavier analytics are **not** provided:

- Weighted shortest path (Dijkstra, A*)
- PageRank
- Community detection
- Centrality measures beyond degree (betweenness, closeness, eigenvector)
- Connected components / strongly connected components
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
- Historical data is only available if temporal fields (`validFrom`, `validTo`) were populated at creation time
- Clock skew between application servers can affect temporal accuracy

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
