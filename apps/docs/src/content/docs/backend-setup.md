---
title: Backend Setup
description: Configure SQLite and PostgreSQL backends for TypeGraph
---

TypeGraph stores graph data in your existing relational database using Drizzle ORM adapters.
This guide covers setting up SQLite, PostgreSQL, and PGlite backends.

:::note[Custom indexes]
TypeGraph migrations create the core tables and built-in indexes. For application-specific indexes
on JSON properties (and Drizzle/drizzle-kit integration), see [Indexes](/performance/indexes).
:::

## SQLite

SQLite is ideal for development, testing, single-server deployments, and embedded applications.

### Quick Setup

For development and testing, use the convenience function that handles everything:

```typescript
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import { createStore } from "@nicia-ai/typegraph";

// In-memory database (resets on restart)
const { backend } = createLocalSqliteBackend();
const store = createStore(graph, backend);

// File-based database (persisted)
const { backend, db } = createLocalSqliteBackend({ path: "./app.db" });
const store = createStore(graph, backend);
```

The local backend owns its connection, so it applies performance pragmas at
open: `journal_mode=WAL`, `synchronous=NORMAL`, and a 5s `busy_timeout`. On
file databases this makes single-operation writes roughly 5× faster than the
driver defaults (rollback journal, `synchronous=FULL`). Override individual
values or opt out entirely:

```typescript
// Override one value, keep the other defaults
createLocalSqliteBackend({ path: "./app.db", pragmas: { busyTimeoutMs: 10_000 } });

// Keep better-sqlite3's driver defaults untouched
createLocalSqliteBackend({ path: "./app.db", pragmas: false });
```

:::caution[Fulltext and embeddings require `createStoreWithSchema`]
`createLocalSqliteBackend` creates the base tables but does not durably
materialize strategy-owned storage. If your graph has `searchable()` or
`embedding()` fields, boot with
`const [store] = await createStoreWithSchema(graph, backend);` instead of
bare `createStore()` — otherwise the first fulltext or embedding operation
throws `StoreNotInitializedError`.
:::

### Manual Setup

For full control over the database connection:

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteBackend, generateSqliteMigrationSQL } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import { createStoreWithSchema } from "@nicia-ai/typegraph";

// Create and configure the database
const sqlite = new Database("app.db");
sqlite.pragma("journal_mode = WAL"); // Recommended for performance
sqlite.pragma("foreign_keys = ON");

// Create Drizzle instance and backend
const db = drizzle(sqlite);
const backend = createSqliteBackend(db);

// createStoreWithSchema auto-creates tables on first run
const [store] = await createStoreWithSchema(graph, backend);

// Clean up when done
process.on("exit", () => sqlite.close());
```

If you need to run DDL yourself (e.g. via a migration tool), use
`generateSqliteMigrationSQL()` with `createStore()` instead:

```typescript
sqlite.exec(generateSqliteMigrationSQL());
const store = createStore(graph, backend);
```

### SQLite with Vector Search

For semantic search, use the sqlite-vec extension. `createLocalSqliteBackend()` wires the
`sqliteVecStrategy` automatically when the extension loads. For a bring-your-own connection, load the
extension and pass the strategy explicitly:

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteBackend, generateSqliteMigrationSQL } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import { sqliteVecStrategy } from "@nicia-ai/typegraph";

const sqlite = new Database("app.db");

// Load sqlite-vec extension
sqlite.loadExtension("vec0");

// Run migrations (core tables)
sqlite.exec(generateSqliteMigrationSQL());

const db = drizzle(sqlite);
const backend = createSqliteBackend(db, { vector: sqliteVecStrategy });
```

sqlite-vec stores embeddings in `vec0` virtual tables and supports the `cosine` and `l2` metrics. Per-field
vector tables are provisioned by `createStoreWithSchema` at boot (not by the generated migration SQL), and the
runtime asserts a durable marker rather than issuing DDL on first write — see
[Database roles & least privilege](#database-roles--least-privilege).

See [Semantic Search](/semantic-search) for query examples.

### libsql / Turso

For edge deployments, shared-driver setups, or Turso cloud databases, use the first-class
libsql backend:

```bash
npm install @libsql/client
```

```typescript
import { createClient } from "@libsql/client";
import { createLibsqlBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/libsql";
import { createStore } from "@nicia-ai/typegraph";

// Local file
const client = createClient({ url: "file:app.db" });

// Or remote Turso database
// const client = createClient({ url: "libsql://my-db.turso.io", authToken: "..." });

const { backend, db } = await createLibsqlBackend(client);
const store = createStore(graph, backend);
```

`createLibsqlBackend` handles DDL execution and configures the correct async
execution profile automatically. It returns both the `backend` and the underlying
Drizzle `db` instance for direct SQL access. The caller retains ownership of the
client and is responsible for closing it when done — this allows sharing a single
client across TypeGraph and other libraries.

The libsql backend has native vector and hybrid search, wired automatically via `libsqlVectorStrategy` — no
extension to load. It uses libSQL's built-in engine (`F32_BLOB(N)` storage, `vector_distance_cos` /
`vector_distance_l2`, and DiskANN approximate nearest neighbor via `libsql_vector_idx` + `vector_top_k`) and
supports the `cosine` and `l2` metrics. See [Semantic Search](/semantic-search) for query examples.

:::caution[In-memory databases and transactions]
libsql's `file::memory:` creates a separate database per connection. Since transactions
open a new connection, the original database is destroyed after a transaction completes
([tursodatabase/libsql-client-ts#229](https://github.com/tursodatabase/libsql-client-ts/issues/229)).
Use a file-based database (`file:path.db`) or remote URL when transactions are needed.
:::

### API Reference

#### `createLocalSqliteBackend(options?)`

Creates a SQLite backend with automatic database and schema setup.

```typescript
function createLocalSqliteBackend(options?: {
  path?: string; // Database path, defaults to ":memory:"
  tables?: SqliteTables;
}): { backend: GraphBackend; db: BetterSQLite3Database };
```

#### `createSqliteBackend(db, options?)`

Creates a SQLite backend from an existing Drizzle database instance. Pass `vector` to enable vector search
(for example `sqliteVecStrategy` after loading the sqlite-vec extension).

```typescript
function createSqliteBackend(
  db: BetterSQLite3Database,
  options?: {
    tables?: SqliteTables;
    vector?: VectorStrategy;
    capabilities?: Partial<BackendCapabilities>;
  },
): GraphBackend;
```

#### `generateSqliteMigrationSQL()`

Returns SQL for creating TypeGraph tables in SQLite.

```typescript
function generateSqliteMigrationSQL(): string;
```

#### `createLibsqlBackend(client, options?)`

Creates a SQLite backend from a `@libsql/client` instance. Runs DDL automatically.
The caller retains ownership of the client and is responsible for closing it.

```typescript
async function createLibsqlBackend(client: Client, options?: { tables?: SqliteTables }): Promise<{ backend: GraphBackend; db: LibSQLDatabase }>;
```

## PostgreSQL

PostgreSQL is recommended for production deployments with concurrent access, large datasets,
or when you need advanced features like pgvector.

`createPostgresBackend` is driver-agnostic. Pick the Drizzle adapter that matches your
runtime, and TypeGraph works the same way against each.

### Choosing a PostgreSQL driver

| Runtime                                                                           | Recommended driver                                                     | Drizzle adapter                                          |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| Long-lived Node server (Fly, Render, Cloud Run, containers)                       | `pg` (node-postgres) or `postgres` (postgres-js)                       | `drizzle-orm/node-postgres` or `drizzle-orm/postgres-js` |
| Node serverless (Vercel Functions, AWS Lambda, Netlify Functions)                 | `postgres` (postgres-js) — faster cold start, lower per-query overhead | `drizzle-orm/postgres-js`                                |
| Bun server                                                                        | `postgres` (postgres-js) or Bun's built-in SQL                         | `drizzle-orm/postgres-js` or `drizzle-orm/bun-sql`       |
| Edge runtime (Cloudflare Workers, Vercel Edge, Netlify Edge) — needs transactions | `@neondatabase/serverless` Pool over WebSockets                        | `drizzle-orm/neon-serverless`                            |
| Edge runtime — single-statement reads/writes only                                 | `@neondatabase/serverless` `neon(url)` over HTTP                       | `drizzle-orm/neon-http`                                  |
| Cloudflare Hyperdrive                                                             | `pg` or `postgres` (through the Hyperdrive pooler)                     | `drizzle-orm/node-postgres` or `drizzle-orm/postgres-js` |
| Embedded apps, local development, Postgres dialect tests                          | `@electric-sql/pglite`                                                 | `drizzle-orm/pglite`                                     |

:::note[Neon HTTP vs WebSocket]
Both Neon drivers work with TypeGraph. They have different tradeoffs:

- **`drizzle-orm/neon-http`** uses HTTP per statement. Lowest cold-start cost; survives Workers'
  per-request isolation. **Cannot hold a session across statements**, so multi-statement transactions
  are unavailable — TypeGraph auto-detects this driver and sets `capabilities.transactions = false`,
  so `store.transaction(...)` falls through to non-transactional sequential execution.
- **`drizzle-orm/neon-serverless`** uses a WebSocket Pool. Holds a session, supports full transactional
  semantics, but the WebSocket connection lifecycle needs care in serverless / per-request contexts
  (you typically want a fresh Pool per request).

Pick HTTP for stateless reads, single upserts, and migrations. Pick WebSockets if you need atomic
multi-statement writes.
:::

### node-postgres (pg)

The default choice for long-lived Node servers. Widest ecosystem and most deployment
documentation.

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { createStoreWithSchema } from "@nicia-ai/typegraph";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

const db = drizzle(pool);
const backend = createPostgresBackend(db);
const [store] = await createStoreWithSchema(graph, backend);
```

If you manage DDL externally, use `generatePostgresMigrationSQL()` with `createStore()`:

```typescript
import { generatePostgresMigrationSQL } from "@nicia-ai/typegraph/adapters/drizzle/postgres";

await pool.query(generatePostgresMigrationSQL());
const store = createStore(graph, backend);
```

### postgres-js

A leaner Postgres client with lower per-query overhead and smaller bundle size. Good
default for Node serverless platforms and Bun. Fully tested against TypeGraph's adapter
and integration suites.

```bash
npm install postgres drizzle-orm
```

```typescript
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { createStoreWithSchema } from "@nicia-ai/typegraph";

const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
});

const db = drizzle(sql);
const backend = createPostgresBackend(db);
const [store] = await createStoreWithSchema(graph, backend);
```

Transactions go through `sql.begin(fn)`; TypeGraph handles this automatically via
Drizzle's `db.transaction()`. Isolation levels are honored the same way as with
node-postgres.

### Neon serverless (WebSockets)

For edge runtimes like Cloudflare Workers, Vercel Edge, and Netlify Edge — anywhere
native TCP sockets aren't available. Neon's `@neondatabase/serverless` driver speaks
the Postgres wire protocol over WebSockets and exposes a pg-Pool-compatible API.

```bash
npm install @neondatabase/serverless drizzle-orm
```

```typescript
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { createStoreWithSchema } from "@nicia-ai/typegraph";

const pool = new Pool({ connectionString: env.NEON_DATABASE_URL });
const db = drizzle(pool);
const backend = createPostgresBackend(db);
const [store] = await createStoreWithSchema(graph, backend);
```

When running under Node.js (for local testing), install `ws` and configure it once
before connecting:

```typescript
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;
```

Edge runtimes expose `WebSocket` globally and need no extra setup.

### Neon HTTP

For stateless edge workloads where you don't need transactional writes. The HTTP
driver issues one request per query — lowest cold-start cost, no session lifecycle
to manage. TypeGraph auto-detects this driver and sets `capabilities.transactions`
to `false`, so `store.transaction(...)` falls through to sequential execution
rather than throwing.

Schema commits are the one exception: `commitSchemaVersion` and
`setActiveVersion` require atomicity to eliminate the orphan-row crash window
they exist to fix, so they refuse with a typed `ConfigurationError` on
non-transactional backends. Run schema migrations from a process with a
transactional driver (`drizzle-orm/neon-serverless`, regular `pg`, etc.); the
edge worker can keep using neon-http for reads and writes once the schema is
established.

```bash
npm install @neondatabase/serverless drizzle-orm
```

```typescript
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { createStore } from "@nicia-ai/typegraph";

const sql = neon(env.NEON_DATABASE_URL);
const db = drizzle({ client: sql });
const backend = createPostgresBackend(db);
const store = createStore(graph, backend);
// backend.capabilities.transactions === false (auto-detected)
```

Use `neon-http` for reads, single upserts, and migrations. Use `neon-serverless`
when you need atomic multi-statement writes.

### PGlite (Postgres-in-WASM)

[PGlite](https://pglite.dev/) is a full Postgres compiled to WebAssembly that runs
in-process — in Node, Bun, Deno, or the browser — with no server and no native
addon. It's ideal for local development, embedded apps, and running the real
Postgres dialect (including pgvector) in tests without Docker.

`@electric-sql/pglite` is an optional peer dependency. Vector support additionally
needs `@electric-sql/pglite-pgvector` (PGlite ≥ 0.5 ships pgvector as a separate
package):

```bash
npm install @electric-sql/pglite @electric-sql/pglite-pgvector
```

The batteries-included helper constructs the engine, loads pgvector, runs the
schema DDL, and returns a ready backend — the Postgres analog of
`createLocalSqliteBackend`:

```typescript
import { createLocalPgliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres/pglite";
import { createStore } from "@nicia-ai/typegraph";

// In-memory by default, with pgvector enabled.
const { backend, db, client } = await createLocalPgliteBackend();
const store = createStore(graph, backend);

// backend.close() disposes the PGlite engine.
```

```typescript
// Persistent on disk:
const { backend } = await createLocalPgliteBackend({ dataDir: "./pgdata" });

// No embeddings? Skip the extension (no pgvector dependency needed):
const { backend } = await createLocalPgliteBackend({ vector: false });

// Pass an explicit pgvector extension object:
import { vector } from "@electric-sql/pglite-pgvector";
const { backend } = await createLocalPgliteBackend({ vector });
```

If you construct PGlite yourself, pass its Drizzle database straight to
`createPostgresBackend` — the execution fast path detects PGlite and routes it
correctly:

```typescript
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { createPostgresBackend, generatePostgresMigrationSQL } from "@nicia-ai/typegraph/adapters/drizzle/postgres";

const client = await PGlite.create({ extensions: { vector } });
await client.exec(generatePostgresMigrationSQL());
const backend = createPostgresBackend(drizzle(client));
```

PGlite is single-connection and serial: there is no pooling, so concurrent
`store.transaction()` calls queue rather than run in parallel. It complements,
rather than replaces, a Docker-based Postgres for CI — PGlite exercises the SQL
dialect and pgvector, but not driver-specific behavior (node-postgres statement
naming, postgres-js, pgbouncer, real concurrency).

### PostgreSQL with Vector Search

For semantic search, enable pgvector. `createPostgresBackend` defaults to `pgvectorStrategy`, so no extra
wiring is required:

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresBackend, generatePostgresMigrationSQL } from "@nicia-ai/typegraph/adapters/drizzle/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Migration SQL enables the pgvector extension
await pool.query(generatePostgresMigrationSQL());
// Runs: CREATE EXTENSION IF NOT EXISTS vector;

const db = drizzle(pool);
const backend = createPostgresBackend(db);
```

pgvector stores embeddings in per-field typed `vector(N)` tables (provisioned by `createStoreWithSchema` at boot
— the generated migration SQL creates no embedding table) with HNSW or IVFFlat indexes, and supports the
`cosine`, `l2`, and `inner_product` metrics.

See [Semantic Search](/semantic-search) for query examples.

### Refreshing planner statistics after bulk loads

`importGraph()` refreshes planner statistics automatically after an import
that created or updated rows, and `store.materializeIndexes()` does the
same on SQLite after creating indexes (pass `refreshStatistics: false` to
opt out). On PostgreSQL, `materializeIndexes()` builds with
`CREATE INDEX CONCURRENTLY` and skips the automatic refresh — call
`store.refreshStatistics()` after materializing.

`bulkCreate` and `bulkInsert` on nodes and edges also refresh
automatically when a single autocommit call writes 1,000 rows or more. Tune or disable this
with the `autoRefreshStatistics` store option:

```typescript
// Refresh after any autocommit bulkCreate of 5,000+ rows
const store = createStore(graph, backend, { autoRefreshStatistics: 5000 });

// Never refresh automatically after bulkCreate
const store = createStore(graph, backend, { autoRefreshStatistics: false });
```

Bulk writes inside a `store.transaction(...)` block never auto-refresh —
statistics collected mid-transaction cannot see the uncommitted rows —
so refresh manually after the transaction commits. The same applies to
loops of small `bulkCreate` batches that never individually reach the
threshold, and to backend-level batch inserts — the loop example below
covers that pattern.

PostgreSQL's query planner relies on table statistics to choose
between multi-column indexes on `typegraph_edges` (forward vs reverse vs
cardinality), and when those statistics are stale the planner can pick a
reverse-index scan with a filter — turning a 0.5ms forward traversal into a
5ms one. SQLite's planner is similarly sensitive: without `sqlite_stat1`
data, some FTS5 fulltext queries fall back to a plan that's roughly 30×
slower. Autovacuum / background statistics collection will catch up
eventually, but refreshing explicitly gives correct latencies immediately.

```typescript
for (const batch of batches) {
  await store.nodes.Document.bulkCreate(batch);
}
await store.refreshStatistics();
```

The implementation runs `ANALYZE` against the TypeGraph-managed tables in
the configured backend — the call is safe regardless of custom table names
or fulltext / embedding configuration. Cloudflare D1 and Durable Object SQLite
reject the performance-only `PRAGMA analysis_limit` tuning statement through
their authorizer. TypeGraph recognizes only that `SQLITE_AUTH` failure and
continues with scoped `ANALYZE`; workerd permits `ANALYZE`, so planner statistics
are still refreshed but without bounded sampling. Unexpected PRAGMA or ANALYZE
failures stay visible through the existing caller warning or rejection. If you
need to bypass the API for an unusual deployment (for example issuing `ANALYZE`
over a separate admin connection), call `backend.execute()` with raw SQL as the
escape hatch.

### pgbouncer / transaction-pool mode

By default, the node-postgres / neon-serverless fast path issues server-side
prepared statements (`client.query({name, text, values})`) so PostgreSQL
caches the parsed plan per session. This is incompatible with pgbouncer in
transaction-pool mode: pgbouncer routes successive statements over different
backend connections, so a `name` registered on one connection isn't visible
on the next. Pass `prepareStatements: false` to fall back to unnamed
positional queries:

```typescript
const backend = createPostgresBackend(db, {
  prepareStatements: false, // pgbouncer transaction-pool compatibility
});
```

The cache that maps SQL text → statement name is LRU-bounded (default 256
entries, override via `preparedStatementCacheMax`). Worst-case server-side
footprint is roughly `cap × pool size` prepared statements across all pooled
connections.

### Connection Pooling

For production, always use connection pooling:

```typescript
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum pool size
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 2000, // Timeout for new connections
});

// Handle pool errors
pool.on("error", (err) => {
  console.error("Unexpected pool error", err);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
```

### API Reference

#### `createPostgresBackend(db, options?)`

Creates a PostgreSQL backend adapter. Accepts any Drizzle PostgreSQL database
instance, regardless of the underlying driver. Tested with `drizzle-orm/node-postgres`,
`drizzle-orm/postgres-js`, `drizzle-orm/neon-serverless`,
`drizzle-orm/neon-http`, and `drizzle-orm/pglite`. The neon-http driver is auto-detected and
`capabilities.transactions` is set to `false` (HTTP can't hold a session); use
`drizzle-orm/neon-serverless` if you need transactional writes.

```typescript
function createPostgresBackend(
  db: AnyPgDatabase,
  options?: {
    tables?: PostgresTables;
    fulltext?: FulltextStrategy;
    /**
     * Override the vector search strategy. Defaults to
     * `pgvectorStrategy`. Pass a custom `VectorStrategy` to change the
     * storage / index engine, or `false` to disable vector support.
     */
    vector?: VectorStrategy | false;
    /**
     * Override specific backend capabilities. Useful for HTTP-style
     * drivers or test scenarios. neon-http already has `transactions:
     * false` auto-applied — pass this to override that or to disable
     * other capabilities for custom drivers.
     */
    capabilities?: Partial<BackendCapabilities>;
    /**
     * Use server-side prepared statements on the node-postgres /
     * neon-serverless fast path. Default `true`. Set to `false` when
     * pooling through pgbouncer in transaction-pool mode (named
     * statements are invisible across pooled connections).
     */
    prepareStatements?: boolean;
    /**
     * LRU cap on the number of distinct SQL strings tracked for
     * prepared-statement naming. Default 256. Worst-case server-side
     * footprint is roughly `cap × pool size` prepared statements.
     * Ignored when `prepareStatements` is `false`.
     */
    preparedStatementCacheMax?: number;
  },
): GraphBackend;
```

#### `createLocalPgliteBackend(options?)`

Creates an in-process PGlite backend with automatic engine construction,
schema DDL, and optional pgvector loading. The returned backend owns the PGlite
engine; call `backend.close()` when the process or test is done.

```typescript
async function createLocalPgliteBackend(options?: {
  /**
   * PGlite data directory. Omit for an in-memory database, pass a filesystem
   * path for persistence, or use a runtime-specific scheme such as `idb://`.
   */
  dataDir?: string;
  tables?: PostgresTables;
  /**
   * Omit to load @electric-sql/pglite-pgvector, pass `false` to disable vector
   * support, or pass a PGlite Extension object to control the extension import.
   */
  vector?: false | Extension;
}): Promise<{
  backend: GraphBackend;
  db: PgliteDatabase;
  client: PGlite;
}>;
```

#### `generatePostgresMigrationSQL()`

Returns SQL for creating TypeGraph tables in PostgreSQL, including the pgvector extension.

```typescript
function generatePostgresMigrationSQL(): string;
```

#### `generatePostgresDDL(tables?)`

Returns individual DDL statements (CREATE TABLE, CREATE INDEX) as an array. Useful when you
need per-statement control, for example to execute them in separate transactions or log them
individually.

```typescript
function generatePostgresDDL(tables?: PostgresTables): string[];
```

## Drizzle-Free Entrypoints

TypeGraph keeps its public core and backend contracts independent of Drizzle:

- `@nicia-ai/typegraph/core` exports graph definition helpers and their
  schema-derived types for packages that only define or share schemas.
- `@nicia-ai/typegraph/backend` exports the complete backend, dialect,
  SQL-fragment, fulltext, and vector strategy contracts for adapter authors.
- `@nicia-ai/typegraph/sqlite/local` and
  `@nicia-ai/typegraph/postgres/pglite` create managed Stores without exposing
  adapter-native handles.

Application code can continue importing the complete portable Store API from
`@nicia-ai/typegraph`. Use the `/adapters/drizzle/...` entrypoints only when the
application deliberately owns a Drizzle connection or needs native transaction
interop.

## Managed Store Entrypoints

For local applications that do not need direct database access, TypeGraph can
own the connection, provision its schema, and return the complete typed Store:

- `@nicia-ai/typegraph/sqlite/local` — Node-only SQLite through the
  native better-sqlite3 addon
- `@nicia-ai/typegraph/postgres/pglite` — in-process PostgreSQL through
  PGlite's WebAssembly runtime

```typescript
import { createLocalSqliteStore } from "@nicia-ai/typegraph/sqlite/local";
import { createLocalPgliteStore } from "@nicia-ai/typegraph/postgres/pglite";

const sqliteStore = await createLocalSqliteStore(graph, { path: "./graph.db" });
const postgresStore = await createLocalPgliteStore(graph, { vector: false });
```

These entrypoints expose no adapter-native database handle. The returned
`Store` keeps the complete graph API, including graph-owned
`store.transaction(...)`, but intentionally omits `withTransaction` and
`withRecordedTransaction`, which require a caller-owned adapter handle. The
Store owns its connection, so call `store.close()` during shutdown. Its
declaration surface is safe for strict TypeScript consumers that do not install
unused database drivers.

PGlite vector support is enabled by default and loads the optional
`@electric-sql/pglite-pgvector` package. Install that package when using vector
fields, or pass `{ vector: false }` as above for a smaller non-vector setup.

Both factories accept `store` and `schemaManagement` groups, so the managed
path supports the same hooks, history/revision tracking, custom SQL schema,
query defaults, and migration policy as `createStoreWithSchema`:

```typescript
import { createSqlSchema } from "@nicia-ai/typegraph";

const store = await createLocalSqliteStore(graph, {
  path: "./graph.db",
  pragmas: { busyTimeoutMs: 10_000 },
  store: {
    history: true,
    schema: createSqlSchema({
      nodes: "app_nodes",
      edges: "app_edges",
      fulltext: "app_fulltext",
      uniques: "app_uniques",
    }),
  },
  schemaManagement: { systemIndexes: "skip" },
});
```

When a custom SQL schema is supplied, the managed factory provisions those
same physical table names; no separate Drizzle table configuration is needed.

## Drizzle Adapter Entrypoints

TypeGraph exposes Drizzle adapters through public entrypoints:

- `@nicia-ai/typegraph/adapters/drizzle/indexes` — Drizzle schema-builder helpers for TypeGraph index declarations
- `@nicia-ai/typegraph/adapters/drizzle/sqlite` — Generic SQLite adapter (any Drizzle SQLite driver)
- `@nicia-ai/typegraph/adapters/drizzle/sqlite/local` — Batteries-included better-sqlite3 wrapper (Node.js only)
- `@nicia-ai/typegraph/adapters/drizzle/sqlite/libsql` — Batteries-included libsql wrapper (Node.js, Workers, browser)
- `@nicia-ai/typegraph/adapters/drizzle/postgres` — PostgreSQL adapter (any Drizzle Postgres driver)
- `@nicia-ai/typegraph/adapters/drizzle/postgres/pglite` — Batteries-included PGlite (Postgres-in-WASM) wrapper

Import from the entrypoint matching your database:

```typescript
import { createSqliteBackend, tables } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import { createLibsqlBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/libsql";
import { createPostgresBackend, tables } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { createLocalPgliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres/pglite";
```

## Cloudflare D1

TypeGraph supports Cloudflare D1 for edge deployments, with some limitations.

Use `createStoreWithSchema()` to automatically create tables on a fresh D1
database and manage schema versions across deployments:

```typescript
import { drizzle } from "drizzle-orm/d1";
import { createStoreWithSchema } from "@nicia-ai/typegraph";
import { createSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";

export default {
  async fetch(request: Request, env: Env) {
    const db = drizzle(env.DB);
    const backend = createSqliteBackend(db);
    const [store] = await createStoreWithSchema(graph, backend);

    // Use store...
  },
};
```

If you prefer to manage DDL yourself, use `createStore()` with manual migrations
instead.

**Important:** D1 has no interactive transaction primitive
(`D1Database.batch(...)` is transactional, but batch-only — not an
interactive runner), so `store.transaction()` is non-atomic on D1. See
[Limitations](/limitations) for details. For a transactional Cloudflare
SQLite store, use **Durable Objects** (below) instead.

## Cloudflare Durable Objects (SQLite)

A store backed by `drizzle(ctx.storage)` inside a Durable Object is
**auto-detected** as `transactionMode: "do-sqlite"` and reports
`capabilities.transactions: true` — no `executionProfile` hint needed.
Unlike D1, Durable Objects expose an interactive storage transaction runner,
so adapter stores can provide fully atomic `store.transaction()` and
`store.withTransaction()` operations.
The runtime authorizer forbids temporary tables, so the same profile reports
`capabilities.graphAnalytics.supported: false`. Traversal algorithms such as
`shortestPath`, `reachable`, and `weightedShortestPath` automatically use their
inline fallback; temporary-table-only analytics such as
`weaklyConnectedComponents` throw `UnsupportedBackendCapabilityError`.
The authorizer also rejects SQLite's `analysis_limit` tuning PRAGMA. Statistics
refresh catches that specific authorization error and still runs scoped
`ANALYZE`; this affects refresh cost only, not query results.
The same profile advertises Cloudflare's 100-bound-parameter query limit.
TypeGraph uses that hard ceiling for its managed write batches and
recorded-history flushes; capability overrides may lower it but cannot raise
it. Literal `.in()` and `.notIn()` query lists are packed into one JSON-bound
parameter, so the list itself does not exhaust the Durable Object budget.

```typescript
import { drizzle } from "drizzle-orm/durable-sqlite";
import { createAdapterStoreWithSchema } from "@nicia-ai/typegraph";
import { createSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";

export class MyObject {
  constructor(private ctx: DurableObjectState) {}

  async handle() {
    const db = drizzle(this.ctx.storage);
    const backend = createSqliteBackend(db);
    // Boots schema/DDL outside any storage transaction (no DDL in the
    // business transaction); the schema-version commit uses the
    // do-sqlite runner.
    const [store] = await createAdapterStoreWithSchema(graph, backend);

    // Atomic across TypeGraph + the product's own relational tables:
    await store.transaction(async (tx) => {
      await tx.nodes.Document.update(documentId, props);
      if (tx.sqlAvailability !== "available") {
        throw new Error(`Native transaction unavailable: ${tx.sqlAvailability}`);
      }
      const sqlTx = tx.sql;
      await sqlTx.insert(documentVersions).values(versionRow);
    });
  }
}
```

TypeGraph delegates to the async storage runner
`ctx.storage.transaction(async …)` (Drizzle's own `db.transaction()` on
Durable Objects is `ctx.storage.transactionSync` and cannot span an
`await`, so it is not used). See the
[Cross-Store Transactions recipe](/recipes#cross-store-transactions-drizzle--typegraph)
for the caller-owned (`withTransaction`) and graph-owned (`tx.sql`) shapes.

## Backend Capabilities

Check what features a backend supports:

```typescript
const backend = createSqliteBackend(db);
const store = createStore(graph, backend);

if (store.capabilities.transactions) {
  await store.transaction(async (tx) => {
    /* ... */
  });
} else {
  // Handle non-transactional execution
}

if (store.capabilities.vector?.supported) {
  // Vector similarity queries available
}
```

`store.capabilities` is the portable runtime source of truth; adapter authors
can inspect the same object as `backend.capabilities`. The shape is:

| Field                                                                      | Meaning                                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `transactions`                                                             | Atomic transactions available (see note below)                                                      |
| `windowFunctions`                                                          | SQL window functions such as `ROW_NUMBER()` are available                                           |
| `graphAnalytics?.{supported,mathFunctions}`                                | Whole-graph temporary-table iteration, plus availability of deferred transcendental-math algorithms |
| `vector?.metrics` / `vector?.indexTypes` / `vector?.maxDimensions`         | Vector strategy capabilities (present once a vector strategy is configured)                         |
| `fulltext?.{supported,languages,phraseQueries,prefixQueries,highlighting}` | Fulltext strategy capabilities                                                                      |

### SQLite ↔ PostgreSQL parity

The **query language is fully portable** between SQLite and PostgreSQL. Predicates (comparison, string/`ILIKE`,
null, `between`, array, object, JSON-path), fixed and variable-length (recursive) traversals, aggregates
(`count`/`sum`/`avg`/`min`/`max` with `groupBy`/`having`), set operations (`UNION`/`UNION ALL`/`INTERSECT`/`EXCEPT`,
including traversal, subquery, `GROUP BY`/`HAVING`, and per-leaf `ORDER BY`/`LIMIT`/`OFFSET` leaves), ordering with
`NULLS FIRST`/`LAST`, cursor pagination, temporal queries, and the fulltext query modes (`websearch`, `phrase`,
`plain`, `raw`) all behave identically. A query you write against one backend compiles and runs the same way on the
other.

The remaining differences are **engine and runtime capability gaps** — they
stem from what each database or hosted authorizer implements, not from
TypeGraph choosing separate query semantics per backend:

| Capability                                             | SQLite                                            | PostgreSQL                                 | Behavior on the unsupported side                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Whole-graph temporary-table analytics                  | ✓ standard connections / ✗ D1 and Durable Objects | ✓ connection-based drivers / ✗ `neon-http` | Throws `UnsupportedBackendCapabilityError`; traversal algorithms with an inline engine fall back automatically            |
| Vector metric `inner_product`                          | ✗                                                 | ✓                                          | Rejected at compile time on SQLite (`sqlite-vec`/`libsql-native` expose `cosine` + `l2`; `pgvector` adds `inner_product`) |
| Vector index type `ivfflat`                            | ✗                                                 | ✓                                          | Index declaration is **skipped** on SQLite (`indexTypes`: `hnsw`/`none` vs `hnsw`/`ivfflat`/`none`)                       |
| Filtered approximate search **guarantees** a full page | ✓ `sqlite-vec` / ✗ `libsql-native`                | ✗ (`pgvector` recovers, but is bounded)    | Only `sqlite-vec` guarantees it; the others can return **fewer than `limit`** rows under heavy filtering — see below      |
| Per-query fulltext `language` override                 | ✗                                                 | ✓                                          | Throws on SQLite — FTS5's tokenizer is fixed at table-create time; `tsvector` accepts a regconfig per query               |
| HNSW `efSearch` query tuning                           | ✗                                                 | ✓                                          | Silent no-op on SQLite; Postgres applies `hnsw.ef_search`. Performance only — same results                                |
| Bounded planner-statistics sampling                    | ✓ standard connections / ✗ D1 and Durable Objects | Native `ANALYZE` sampling                  | Restricted SQLite skips `analysis_limit` but still attempts scoped `ANALYZE`. Performance only — same results             |
| TypeGraph Identity Profile                             | ✓ transactional drivers                           | ✓ transactional drivers                    | Enabled graphs fail fast on non-atomic drivers; identity-disabled graphs retain their ordinary path                      |

Identity support also has a **driver** dimension inside each dialect:

| Driver                                                       | Atomic identity support | Behavior                                                                                                            |
| ------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Managed SQLite, libSQL, Durable Objects                      | ✓                       | Full profile                                                                                                        |
| PostgreSQL `node-postgres`, `postgres-js`, neon-serverless, PGlite | ✓                  | Full profile; writes serialize with a per-graph advisory transaction lock                                           |
| Cloudflare D1                                                | ✗                       | Enabled graphs fail at store construction with `ConfigurationError` details code `IDENTITY_REQUIRES_ATOMIC_BACKEND` |
| `drizzle-orm/neon-http`                                      | ✗                       | Same fail-fast error; identity-disabled graphs retain the ordinary single-statement path                            |

### Filtered approximate search

Every approximate (ANN) vector search carries at least one row filter: the liveness predicate that hides
soft-deleted and out-of-validity rows. A `.where(...)` predicate narrows it further. Engines differ in where they
apply that filter relative to the index traversal, which decides whether a page can come back short. Read it from
`backend.capabilities.vector.filteredApproximateSearch`:

```typescript
const filtered = backend.capabilities.vector?.filteredApproximateSearch;
if (filtered?.guaranteesFullPage !== true) {
  // An approximate search here may return fewer than `limit` rows.
}
```

**Check `guaranteesFullPage`, not `mode`.** `mode` names the mechanism the strategy asks the engine for; only
`guaranteesFullPage` tells you whether a short page is possible.

| `mode`              | Strategy        | `guaranteesFullPage` | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | --------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"filter-pushdown"` | `sqlite-vec`    | `true`               | The filter constrains the `vec0` KNN candidate set itself. `limit` matching rows come back whenever `limit` exist.                                                                                                                                                                                                                                                                                                      |
| `"iterative-scan"`  | `pgvector`      | `false`              | The index is re-entered for more candidates (`hnsw.iterative_scan` / `ivfflat.iterative_scan`, applied automatically on pgvector ≥ 0.8). Much better recall than a post-filter, but **not a guarantee**: the scan stops at `hnsw.max_scan_tuples` / `ivfflat.max_probes`. And on **pgvector < 0.8** there is no iterative scan at all — the backend detects that, warns once, and the search stays `ef_search`-bounded. |
| `"post-filter"`     | `libsql-native` | `false`              | DiskANN's `vector_top_k` is a table function with no filter pushdown and no way to re-enter the index. TypeGraph over-fetches `4 × (limit + offset)` neighbors and filters afterwards, so once more than that headroom is filtered out **the search silently returns fewer than `limit` rows while more matches exist**.                                                                                                |

Heavy tombstone drift — routine in a temporal store — is what turns a bounded search from a theoretical caveat into
a short page. When a full page matters, use an exact search (`approximate: false`), which scans and so applies the
filter to every row; or declare the field's index as `"none"` so it is always brute-forced.

Vector and fulltext capabilities are populated from the configured strategy, so the matrix above reflects the
bundled strategies (`sqlite-vec`/`libsql-native`/`pgvector`, `fts5`/`tsvector`). A custom strategy advertising
different `metrics`/`indexTypes`/`filteredApproximateSearch` shifts these rows accordingly — always check
`backend.capabilities` at runtime rather than hard-coding the dialect.

Both bundled backends advertise `windowFunctions: true`. Vector, fulltext, and hybrid relevance-ranking
queries use `ROW_NUMBER()` internally and throw `ConfigurationError` before SQL generation if a custom backend profile
sets `windowFunctions: false` — there the window output *is* the result (the relevance k-cutoff / rank ordinal), so
there is no correct fallback.

`bulkFindByIndex({ limitPerInput })` also uses `ROW_NUMBER()` when available, but it does **not** throw on a
windowless profile: the per-input cap is a transfer optimization with identical row semantics either way, so it
degrades gracefully — fetching all matching ids and capping per group in application code. The unbounded
`bulkFindByIndex` path needs no window and is always available.

:::note[JSON is native on both backends]
SQLite stores JSON as text and queries it with the built-in JSON functions (`json_extract`, `json_each`, …);
PostgreSQL uses native `JSONB`. The dialect layer hides this difference, so JSON-path predicates and **B-tree
expression indexes on scalar JSON properties** (`defineNodeIndex` / `defineEdgeIndex`) are at full parity. The one
JSON-related difference is performance, not capability: PostgreSQL can use a single GIN index to accelerate
array/object **containment** predicates (`contains()` / `containsAll()` / `hasKey()` / `pathEquals()`), whereas on
SQLite those run as `json_each()` scans — correct results, just not index-accelerated. See
[Indexes](/performance/indexes) for the full breakdown.
:::

:::note[Transactions are driver-dependent, not backend-dependent]
Both backends report `transactions: true` by default. The exception is symmetric and lives in specific drivers:
Cloudflare D1 (SQLite) and `drizzle-orm/neon-http` (Postgres) are non-transactional, so they downgrade to
`transactions: false`. Operations that require atomicity (`commitSchemaVersion`, `setActiveVersion`, Operational
Identity) throw on those drivers regardless of backend.
:::

:::note[Aggregate set operations are a builder limitation, not a parity gap]
`GROUP BY`/`HAVING` leaves are supported by the set-operation compiler on **both** backends, but the query builder
does not expose `.union()`/`.intersect()`/`.except()` on `.aggregate()` queries. That limit applies equally to SQLite
and PostgreSQL, so it is not a portability difference.
:::

## Connection Management

Connection ownership follows the entrypoint:

- **Managed Store factories** (`/sqlite/local` and `/postgres/pglite`) own the
  connection and provisioned resources. `await store.close()` releases them.
- **Owned local backend factories** (`createLocalSqliteBackend` and
  `createLocalPgliteBackend`) also own their resources. A Store delegates
  `close()` to its backend, so `await store.close()` releases them.
- **Bring-your-own adapter factories** (`createSqliteBackend`,
  `createPostgresBackend`, and `createLibsqlBackend`) leave connection ownership
  with the caller. Their Store's `close()` does not close the supplied client or
  pool.

When you bring your own connection, you are responsible for:

1. **Creating connections** with appropriate configuration
2. **Connection pooling** for production use
3. **Closing connections** on shutdown

```typescript
// You create the connection
const sqlite = new Database("app.db");
const db = drizzle(sqlite);
const backend = createSqliteBackend(db);
const store = createStore(graph, backend);

// You close the connection
process.on("exit", () => {
  sqlite.close();
});
```

Here `store.close()` leaves `sqlite` open because the application supplied the
connection. Close the driver or pool through its own API.

## Database roles & least privilege

`createStoreWithSchema()` and `createStore()` divide cleanly along DDL
privilege, so a production deployment can run its application under a
least-privilege, DML-only database role.

- **`createStoreWithSchema(graph, backend)` runs DDL.** It bootstraps the
  base tables on a fresh database, applies safe auto-migrations, and
  durably materializes strategy-owned runtime storage — both fulltext and
  each `embedding()` field's per-`(kind, field)` vector table, plus a
  durable marker for each. It also brings TypeGraph's own base-relation
  **system indexes** up to the running library version: bootstrap DDL only
  runs on the very first boot, so an index shipped in a newer version
  reaches an already-initialized database through this step (built with
  `CREATE INDEX CONCURRENTLY` on PostgreSQL; a database whose indexes all
  exist settles from the catalog with no DDL). It re-issues idempotent DDL
  on every cold boot — at minimum a `CREATE TABLE IF NOT EXISTS` for the
  contribution-marker table — so the role it runs under **must hold
  `CREATE` / DDL privileges**. Run it once at startup, outside request
  handlers and transactions. (`store.evolve()` likewise provisions any
  embedding field it introduces, so it too needs DDL privileges.)
  Deployments that never run `createStoreWithSchema` (manual-DDL boot with
  a plain `createStore` attach) adopt new system indexes by calling
  `store.materializeSystemIndexes()` once under a DDL-capable role after
  upgrading; deployments that must not run index builds inline at boot
  (large tables behind a readiness probe) pass `systemIndexes: "skip"` to
  `createStoreWithSchema` and materialize out-of-band the same way.

- **`createStore(graph, backend)` is a synchronous, zero-I/O attach.**
  It does not create tables, repair DDL, or record that runtime storage
  is materialized — it issues **no DDL ever**. Use it only to attach to a
  database a prior `createStoreWithSchema` boot already initialized. A
  fulltext operation or an **embedding write** against a database that was
  never initialized — a `create({ embedding })` or embedding update/delete
  — throws `StoreNotInitializedError` rather than silently emitting
  `CREATE TABLE` on the hot path. (Vector *reads* are not marker-gated:
  `store.search.vector`, `store.search.hybrid`, and a query-builder
  `.similarTo()` predicate compile to SQL against the per-field table
  directly, so on an un-provisioned database they surface the engine's own
  missing-relation error instead — `no such table: tg_vec_…` on SQLite,
  `relation … does not exist` on Postgres. Same cause, same fix; use
  `createVerifiedStore` to catch it at attach rather than at first query.)
  This is what lets a least-privilege role run vector ops: the table
  already exists. Graphs with no `searchable()` or `embedding()` fields
  are unaffected.

- **`createVerifiedStore(graph, backend)` is the same zero-DDL attach
  with a verification gate.** It reads the active schema row, folds the
  persisted graph extension, and refuses to construct the Store unless
  the database is at the same schema version as the code graph. Throws
  `MigrationError` on drift (safe or breaking), `ConfigurationError`
  when no schema has been initialized, and `StoreNotInitializedError`
  when the schema is current but runtime-contribution markers are
  missing. The runtime-side counterpart of `createStoreWithSchema` for
  least-privilege deployments. If you only need the gate without
  building a Store (e.g. a readiness probe), call `assertSchemaCurrent`.

### Recommended deployment shape

Run schema/DDL changes as a **privileged, one-time migration step**, then
run the application under a **least-privilege runtime role** that holds
only `SELECT` / `INSERT` / `UPDATE` / `DELETE`:

```typescript
// 1. Migration step — privileged role with DDL/CREATE.
//
//    createStoreWithSchema is mandatory here: it bootstraps tables,
//    applies safe auto-migrations, commits the schema_versions row,
//    and writes the durable contribution markers. The runtime gate
//    checks all of those.
const [/* store */] = await createStoreWithSchema(graph, adminBackend);

//    Optional prerequisite if you manage DDL externally with
//    drizzle-kit. Generated SQL creates the tables but does NOT
//    initialize the schema row or contribution markers — still run
//    createStoreWithSchema afterwards (it skips bootstrap when tables
//    already exist and commits the row + markers):
//
//    import { generatePostgresMigrationSQL } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
//    await adminPool.query(generatePostgresMigrationSQL());
//    await createStoreWithSchema(graph, adminBackend);
```

```typescript
// 2. Runtime — least-privilege, DML-only role. Zero DDL.
// createVerifiedStore fails fast if the privileged migrator is behind.
const runtimePool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const backend = createPostgresBackend(drizzle(runtimePool));
const [store] = await createVerifiedStore(graph, backend);
```

If the runtime role has no DDL privileges and you boot it with
`createStoreWithSchema()` anyway, the first cold boot fails with a
permission error on the bootstrap or contribution-marker DDL — see
[Troubleshooting](/troubleshooting).

## Environment-Specific Setup

### Development

```typescript
// In-memory for fast tests
const { backend } = createLocalSqliteBackend();

// Or file-based for persistence during development
const { backend } = createLocalSqliteBackend({ path: "./dev.db" });
```

### Testing

```typescript
// Fresh in-memory database per test
beforeEach(() => {
  const { backend } = createLocalSqliteBackend();
  store = createStore(graph, backend);
});
```

### Production

Single-role setup — `createStoreWithSchema` bootstraps and migrates on
boot, so the role needs DDL privileges. To run the application under a
least-privilege, DML-only role instead, split the migration step out as
described in [Database roles & least privilege](#database-roles--least-privilege).

```typescript
// PostgreSQL with pooling
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  ssl: { rejectUnauthorized: false }, // For managed databases
});

const db = drizzle(pool);
const backend = createPostgresBackend(db);
const [store] = await createStoreWithSchema(graph, backend);
```

## Next Steps

- [Schemas & Types](/core-concepts) - Define your graph schema
- [Semantic Search](/semantic-search) - Vector embeddings and similarity search
- [Limitations](/limitations) - Backend-specific constraints
