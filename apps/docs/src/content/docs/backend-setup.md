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
  so `store.transaction(...)` on a raw Store falls through to non-transactional sequential execution.
  A schema-managed Store may attach for reads, but its first write fails closed because the driver
  cannot hold the schema-version fence.
- **`drizzle-orm/neon-serverless`** uses a WebSocket Pool. Holds a session, supports full transactional
  semantics, but the WebSocket connection lifecycle needs care in serverless / per-request contexts
  (you typically want a fresh Pool per request).

Pick HTTP for stateless reads and explicitly raw, unfenced single writes after a
transactional migrator has initialized the database. Pick WebSockets for schema
migrations, schema-managed Store writes, or any atomic multi-statement write.
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
to `false`. On a raw Store, `store.transaction(...)` falls through to sequential
execution rather than throwing; on a schema-managed Store, read-only callbacks
still run but the first write fails closed.

Schema commits are the one exception: `commitSchemaVersion` and
`setActiveVersion` require atomicity to eliminate the orphan-row crash window
they exist to fix, so they refuse with a typed `ConfigurationError` on
non-transactional backends. Run schema migrations from a process with a
transactional driver (`drizzle-orm/neon-serverless`, regular `pg`, etc.); the
edge worker can keep using neon-http for reads. It can also use a raw
`createStore()` for single writes when the application explicitly accepts that
those writes are not fenced against schema changes. A managed or verified Store
can attach for reads, but its first write fails closed because neon-http cannot
hold the schema fence.

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

Use `neon-http` for reads and explicitly raw, unfenced single upserts. Run
migrations and schema-managed Store writes through `neon-serverless`, regular
`pg`, or another transactional driver.

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

The in-process cache that maps SQL text → statement name is LRU-bounded
(default 256 entries, override via `preparedStatementCacheMax`). Eviction
never recycles a name, because a live connection may still retain that name for
its original SQL. Therefore this setting does not bound server-side prepared
statement memory. For a high-cardinality stream of SQL text, use
`prepareStatements: false` instead.

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

Custom insert builders must apply the same born-ended validity rule as the
built-in adapters. Import its public owner instead of duplicating the bound
comparison:

```typescript
import { resolveStampedValidityLowerBound } from "@nicia-ai/typegraph/backend";

const validFrom = resolveStampedValidityLowerBound(
  params.validFrom,
  params.validTo,
  writeInstant,
);
```

Use the same `writeInstant` for the decision and the row's creation/update
stamp. This keeps custom node and edge inserts, plus node resurrection paths
that reset the validity window, aligned with Store and interchange semantics at
the zero-width boundary. Edge resurrection retains its stored lower bound and
does not use this stamping helper.

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

`drizzle-orm` is an optional peer dependency for these two managed
entrypoints: they load it only when their factory is called and, when it is
absent, reject with a typed `ConfigurationError` (`MISSING_PEER_DEPENDENCY`)
naming the package and the install command (`npm install drizzle-orm`) rather
than a bare module-resolution stack. The explicit `/adapters/drizzle/...`
entrypoints below expose Drizzle-native backends, connections, or schema
builders and load `drizzle-orm` when the module is evaluated. Importing one
without the peer installed therefore surfaces the raw module-resolution
error, which names the same package.

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

Cloudflare D1 has no interactive transaction primitive, so it cannot commit
TypeGraph schema versions or run schema-managed Store writes. Apply the base DDL
with Wrangler / drizzle-kit, then use a raw `createStore()` only when the
application accepts unfenced writes:

```typescript
import { drizzle } from "drizzle-orm/d1";
import { createStore } from "@nicia-ai/typegraph";
import { createSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";

export default {
  async fetch(request: Request, env: Env) {
    const db = drizzle(env.DB);
    const backend = createSqliteBackend(db);
    const store = createStore(graph, backend);

    // Use store...
  },
};
```

This raw Store does not validate or fence a committed TypeGraph schema version.
For schema-managed writes on Cloudflare, use **Durable Objects** (below), whose
SQLite storage exposes an interactive transaction runner.

**Important:** D1 has no interactive transaction primitive
(`D1Database.batch(...)` is transactional, but batch-only — not an
interactive runner), so `store.transaction()` is non-atomic on D1. See
[Limitations](/limitations) for details. For a transactional Cloudflare
SQLite store, use **Durable Objects** (below) instead.

For the same reason, a write guarded by a **declared constraint** — edge
cardinality other than `many`, a `disjointWith` axiom, a shared-scope unique, or
`getOrCreateByEndpoints`'s create leg — is refused on D1 with
`CONSTRAINT_WRITE_FENCE_UNSUPPORTED` rather than committed unfenced. See
[Declared constraints require `transactions`](#declared-constraints-require-transactions).

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
| `constraintClaims?`                                                        | The backend carries the claim relations that fence declared constraints without a lock (see below)  |
| `graphAnalytics?.{supported,mathFunctions}`                                | Static support for whole-graph temporary-table iteration, plus availability of deferred transcendental-math algorithms |
| `vector?.metrics` / `vector?.indexTypes` / `vector?.maxDimensions`         | Vector strategy capabilities (present once a vector strategy is configured)                         |
| `fulltext?.{supported,languages,phraseQueries,prefixQueries,highlighting}` | Fulltext strategy capabilities                                                                      |
| `recursiveTraversal?.{supported,reason}`                                   | Whether the engine can compute a bounded transitive closure of a relation in one round trip — a recursive CTE, or a graph-native expansion operator. **Absent means supported** |
| `pessimisticLocks?.{advisoryLocks,tableLocks,serializedWriters}`           | How this engine serializes concurrent writers, if at all — see [Write fence declaration](#write-fence-declaration-pessimisticlocks) |
| `recordedTimeOwnership?`                                                  | Who allocates recorded-time revisions — see [Recorded-time ownership](#recorded-time-ownership-recordedtimeownership) |

`graphAnalytics.supported` describes the backend shape, not mutable PostgreSQL
session state. A hot standby or a role without the database `TEMP` privilege can
still reject the working-table transaction that the iterative graph algorithms
open: a standby refuses the read-write transaction itself, and a role without
`TEMP` refuses the `CREATE TEMP TABLE` inside it. Both refusals reach the caller
as `UnsupportedBackendCapabilityError`, with the PostgreSQL error retained as
its `cause`.

### Validity-end clearing capability

Custom backends must advertise `capabilities.clearValidTo: true` only when both
`updateNode` and `updateEdge` apply `clearValidTo: true` by storing SQL `NULL` in
`valid_to`. The built-in SQLite and PostgreSQL adapters do. An explicit clear on
a backend without that promise is refused with `ConfigurationError` code
`CLEAR_VALID_TO_UNSUPPORTED` before coalescing or writes, so the result
does not depend on whether the target row is already open. Omission still means
preserve; custom backends that do not support clearing remain compatible with
all writes that omit the option.

### Recorded-table migration DDL (`recordedTableDdl`)

`GraphBackend.recordedTableDdl` is an optional, synchronous callback used only by the offline
timestamp-only recorded-time preview migration. The migration calls it twice, once with temporary
table names and once with the final names, and expects DDL for `recordedClock`, `recordedNodes`, and
`recordedEdges`. The backend owns this callback because table creation, indexes, and named
constraints are dialect-specific and must not pull Drizzle into portable entrypoints.

A custom backend can omit the callback unless it created data in the old preview schema. If
`migrateLegacyRecordedTime` discovers that schema and the callback is absent, it throws
`UnsupportedBackendCapabilityError` with `details.capability: "recordedTableDdl"`. When the engine
names primary-key constraints, the temporary and final callback results must either both name the
constraint or both omit it; a one-sided result throws `ConfigurationError` code
`RECORDED_DDL_CONSTRAINT_NAME_MISMATCH`.

The callback only describes DDL. It must not execute statements or inspect the catalog, because the
migration invokes it inside its transaction. See
[Migrating Preview Recorded Time](/schema-management#migrating-preview-recorded-time) for the
operator workflow.

### Recursive traversal capability

Both bundled backends declare `capabilities.recursiveTraversal: { supported: true }`. **Absent
means supported** — mirroring `returning`, not `constraintClaims`: every existing custom backend
already runs the six recursive-CTE emission sites unconditionally, so absence meaning unsupported
would refuse traversals that work today.

```typescript
const capabilities: Partial<BackendCapabilities> = {
  recursiveTraversal: { supported: false, reason: "engine has no WITH RECURSIVE / equivalent" },
};
```

A backend that genuinely lacks the primitive declares `{ supported: false, reason }`. A factory
refuses a contradictory declaration — `supported: false` with no `reason`, or `supported: true`
with a dangling `reason` — with `ConfigurationError` details code `CAPABILITY_DECLARATION_CONTRADICTION`.

Five operations refuse when unsupported: variable-length (`traverse`) queries, `store.subgraph()`,
historical identity class reads, identity-expanded historical queries, and the identity
window-ledger read — each throwing `ConfigurationError` code `RECURSIVE_TRAVERSAL_UNSUPPORTED`
with `details.operation` naming the site and `details.reason` echoing the declaration.

`weightedShortestPath` is the one exception: on a backend with temporary statements but no
recursion, it **falls back** to a per-hop predecessor walk instead of refusing, issuing
`pathLength + 1` extraction statements for the path a recursive CTE would have returned in one
round trip. The unweighted `shortestPath` (along with `reachable`, `canReach`, and `neighbors`)
emits no recursive CTE at all — it routes through the iterative working-table or inline path
instead — so it neither refuses nor falls back regardless of this declaration.

### Write fence declaration (pessimisticLocks)

TypeGraph serializes a family of writes — Operational Identity's mutations, and the
TypeGraph-owned recorded-clock allocation behind `history` / `revisionTracking` — behind a
per-graph fence rather than trusting the engine's default isolation. `capabilities.pessimisticLocks`
declares what this backend can provide, and `resolveWriteFencePlan` is the one place that
declaration turns into a plan every lock site consumes instead of re-deriving:

- `{ kind: "lock", advisoryLocks: true, tableLocks: boolean }` — take the declared keyed
  (and, where needed, table) lock.
- `{ kind: "engine-serialized" }` — no lock needed; the engine serializes writers by
  construction (SQLite's single writer slot).
- `{ kind: "unfenced" }` — neither. Every non-degradable fence refuses rather than running
  unfenced.

Resolution order: (1) the declared `pessimisticLocks` value, if present; (2) absent AND the
backend was built by `createSqliteBackend` / `createPostgresBackend` — derived from `dialect`,
which is exactly what every lock site used to compute inline; (3) absent on anything else —
`unfenced`, because an undeclared custom backend is by definition uncertified and inferring
lock support from `dialect` alone is the unsound inference this capability replaces.

```typescript
const capabilities: Partial<BackendCapabilities> = {
  pessimisticLocks: { advisoryLocks: true, tableLocks: true, serializedWriters: false },
};
```

The two bundled backends declare exactly these lines — copy the one matching your engine:

- PostgreSQL: `pessimisticLocks: { advisoryLocks: true, tableLocks: true, serializedWriters: false }`
- SQLite: `pessimisticLocks: { advisoryLocks: false, tableLocks: false, serializedWriters: true }`

Constructing Operational Identity, or `history: true` / `revisionTracking: true`, against an
`unfenced` backend is refused immediately at `createStore` — never mid-flush — with
`ConfigurationError` details code `IDENTITY_REQUIRES_WRITE_FENCE` (identity) or
`RECORDED_CLOCK_REQUIRES_WRITE_FENCE` (recorded-clock allocation), and the refusal message names
the exact declaration line to add.

A declared-advisory-only backend (`tableLocks: false`) that reaches a site whose operation
`requires: "table-lock"` is refused with details code `WRITE_FENCE_UNAVAILABLE`, naming
`details.operation` and `details.requires` — the lock plan resolved, but it cannot satisfy what
this specific operation needs.

### Recorded-time ownership (recordedTimeOwnership)

`capabilities.recordedTimeOwnership` names who allocates recorded-time revisions. Absent means
`"typegraph-relations"` — today's behavior for every existing backend: TypeGraph owns a clock
row and performs the read/advance/write that the write fence serializes.

Declaring `"engine-native"` together with `history: true` or `revisionTracking: true` is refused
at construction with `ConfigurationError` details code
`ENGINE_NATIVE_RECORDED_TIME_NOT_IMPLEMENTED` — the engine-native read/write path does not exist
yet, so admitting the declaration would move the refusal from construction to mid-flush instead.
This refusal is independent of the write-fence plan above: it fires whether the same backend is
fenced or unfenced, because it is about the missing read/write path, not about locking. Declaring
`"engine-native"` **without** `history` / `revisionTracking` constructs without incident — the
declaration has no consumer to refuse until one exists.

### Capability bundles

A **capability bundle** groups a set of `GraphBackend` members that one operation family needs
together, with one verdict resolver and one member accessor, so a caller never re-derives "does
this backend support X" from a scattered `undefined` check. Six pilot bundles ship in this
release:

| Bundle                    | Kind       | Disposition                                                                                                                                                                 |
| ------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claims`                  | gated      | Bidirectional cross-check between the `constraintClaims` declaration and the core members; disagreement in either direction refuses with `CONSTRAINT_CLAIM_SURFACE_MISMATCH` |
| `statementExecution`      | gated      | Core `executeStatement` absent refuses with `IDENTITY_REQUIRES_STATEMENT_EXECUTION`                                                                                          |
| `recordedRevisionOrigins` | gated      | Core `ensureRevisionOriginsTable` absent refuses with the operation's own typed error                                                                                        |
| `batchPointRead`          | graduated  | `getNodes` absent falls back to per-id `getNode`; `getEdges` absent falls back to per-id `getEdge`                                                                           |
| `uniqueSidecarBatch`      | graduated  | `insertUniqueBatch` absent falls back to `issueClaimsIndividually`; `checkUniqueBatch` absent falls back to a per-key loop; `hardDeleteUniquesByNodeIds` absent refuses with the operation's own typed error |
| `contributionHealth`      | graduated  | `verifyContributions` / `repairContributions` / `rebuildContribution` absent each refuse with the operation's own typed error; `probeContributions` absent falls back to `{ entries: [] }` |

The port-mismatch rule that governs every bundle's member accessor is keyed to the disposition,
not blanket: a `refuse`-disposition row whose backend object cannot actually reach the member
throws that bundle's own `portSurfaceCode` (`CONSTRAINT_CLAIM_SURFACE_MISMATCH` for `claims`,
`BUNDLE_PORT_SURFACE_MISMATCH` for the other five); a `fallback`-disposition row whose port cannot
reach the member takes its declared fallback instead of throwing — the verdict said the member
was there, the object it binds against says otherwise, and a fallback row is defined to degrade
rather than assert.

This bundle model ships for **six of the twenty-one** member-bearing operation families measured
in this workstream; the remaining fifteen are a named follow-up workstream, not a silent gap —
their members keep working exactly as before, unbundled, with an access-count ceiling that
prevents new scattered checks from accumulating ahead of that follow-up.

A backend author does not need to do anything for these six bundles today: both bundled backends
already carry every core member each bundle's `dialects` scope requires. A future conformance kit
will certify a **third-party** backend by resolving every bundle's verdict against the declared
capabilities and the object the calls actually execute on, and asserting the disposition-keyed
port-mismatch rule above holds — a backend author preparing for that kit should make sure a
declared capability (`constraintClaims`, `contributions`, …) is truthful about which members the
backend object actually implements, not just which capability fields it sets.

### Declared constraints require `transactions`

A **constrained write** — one whose correctness rests on a check-then-write that
no database key repeats at write time — runs its probe and its write under one
per-graph mutual exclusion. That fence is a transaction-scoped construct on both
dialects: SQLite's `BEGIN IMMEDIATE` writer slot, PostgreSQL's
`pg_advisory_xact_lock` (which outside a transaction is taken and dropped inside
its own implicit single-statement one, excluding nothing). A backend reporting
`capabilities.transactions: false` can supply neither, so such a write is
**refused** rather than run unfenced — a constraint enforced only when nothing
races is the defect the fence exists to close.

The refusal is a `ConfigurationError` with `details.code`
`CONSTRAINT_WRITE_FENCE_UNSUPPORTED`, and `details.constraint` naming which
class needed the fence, because the way forward differs per class:

| `details.constraint` | The write that needs the fence | Way forward without a transactional backend |
| --- | --- | --- |
| `edgeCardinality` | Creating or resurrecting an edge whose `cardinality` is `one`, `unique`, or `oneActive` | Declare the edge `cardinality: "many"` and enforce the limit in application code |
| `edgeMatchKeyConvergence` | `getOrCreateByEndpoints` (single or bulk) taking its create leg — the match key is backed by no database key | Use `create` with a caller-chosen id, whose uniqueness the edges primary key enforces |
| `nodeDisjointness` | Creating a node under a kind that participates in a `disjointWith` axiom | Drop the axiom and keep ids distinct across those kinds yourself |
| `nodeUniquenessClaim` | **Updating or resurrecting** a node whose kind declares any unique constraint, of any scope — a transition reserves the new key *before* the row write it gates, and only a transaction can undo the pair together | Drop the constraint, or run updates on a transactional backend. Plain **creates** under a `scope: "kind"` unique are unaffected: their claim follows the row |
| `nodeUniquenessScope` | Creating **or updating** a node under a `scope: "kindWithSubClasses"` unique that actually expands past the node's own kind | Scope the constraint to `"kind"`, which the uniques primary key enforces on its own |

`importGraph` / `importGraphStream` is refused on the same backends whenever any
node kind of the graph owes a claim ahead of its row — that is, declares **any**
unique constraint or has a disjoint partner — or any edge kind is non-`many`.
The import writes both creates and updates, so the widest of those placements is
what decides it.

This affects **Cloudflare D1**, **`drizzle-orm/neon-http`**, and any SQLite
backend built with `transactionMode: "none"`. Durable Objects are unaffected —
`do-sqlite` reports `capabilities.transactions: true` and fences normally.

Unconstrained writes on those backends are untouched and keep working exactly as
before: a `cardinality: "many"` edge created, updated and deleted; any node
delete, including one whose kind participates in a disjointness axiom (a delete
re-derives no cross-kind verdict); a node whose uniques are all `scope: "kind"`;
and a `getOrCreateByEndpoints` that *finds* an existing edge in the default
`ifExists: "return"` mode, or resurrects a `many` one — that resurrection is an
id-keyed `UPDATE` that re-derives nothing. With `coalesceUnchangedUpserts`
enabled, confirming that a single `ifExists: "update"` endpoint replay is
unchanged requires the endpoint match-key convergence fence and therefore
refuses on these backends. The bulk `getOrCreateByEndpoints` form fences its
whole batch, so it refuses on those backends whatever the outcome would have
been.

### Claim relations, and what they do not promise

Underneath the lock, a declared constraint is also reserved in a **claim
relation** whose primary key admits one live claimant per axis: `uniques` (for
uniqueness scopes and `disjointWith` pairs) and `typegraph_edge_claims` (for
`cardinality: "one" | "unique" | "oneActive"`). Both bundled backends carry them
and report `capabilities.constraintClaims: true`. The claim is what makes those
constraints hold for TypeGraph writers that hold no per-graph lock at all —
`importGraph` is the one in the box. The protocol is application-maintained:
raw SQL that writes only `nodes` or `edges` bypasses the corresponding claim
write and can violate the declaration. An out-of-band writer is fenced only if
it participates in the same claim protocol in the same transaction.

Three properties of that mechanism are worth knowing before you rely on it:

- **A claim row's lock is held to the end of the transaction, including on
  refusal.** A caller that catches a typed constraint error and keeps going —
  import's per-row recovery, or your own `try`/`catch` inside
  `store.transaction` — still holds the lock on the row it was refused at, and
  any other writer of that axis waits until the transaction ends. This is
  inherent to every row-lock fence, not specific to this one.
- **Above READ COMMITTED, PostgreSQL reports a serialization failure instead of
  the typed error.** At `REPEATABLE READ` or `SERIALIZABLE`, `INSERT … ON
  CONFLICT DO UPDATE` raises `40001` rather than resolving the conflict, so the
  losing writer sees a serialization failure to retry rather than
  `UniquenessError`. SQLite has no such mode. This is unchanged from earlier
  versions, which already reserved single-kind uniqueness through the same
  statement.
- **Pre-existing violations are neither repaired nor refused at boot.** A
  database that already held two live claimants of one axis before the claim
  relations existed keeps holding them; the next write that touches that axis is
  refused with the ordinary typed error naming the incumbent.
  `store.verifyConstraintFences()` is the read-only diagnostic that makes that
  state legible ahead of time:

```typescript
for (const violation of await store.verifyConstraintFences()) {
  // violation.target names the claim row two claimants contend for
  console.warn(violation.family, violation.target.axis, violation.target.key);
}
```

It reports one entry per contended axis — `nodeUniqueness` and
`nodeDisjointness` carry the conflicting `owners` (each a `concrete_kind` /
`node_id` pair, because ids are unique only per kind), `edgeCardinality` carries
the conflicting `edgeIds`. It reads the nodes, edges and `uniques` relations, so
it finds violations that predate the claim tables; it writes nothing, and it
repairs nothing — choosing which claimant keeps the axis is a data-loss decision
that stays with you.

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
| HNSW `efSearch` query tuning                           | ✗                                                 | ✓ transactional HNSW drivers               | Refused, never ignored: `UnsupportedBackendCapabilityError` with `details.capability` `vector.searchFrontierTuning` on **any** SQLite backend (vector and hybrid alike — neither `sqlite-vec`'s `vec0` KNN nor `libsql-native`'s DiskANN has a per-search frontier), and on transaction-less Postgres or a non-HNSW slot |
| Bounded planner-statistics sampling                    | ✓ standard connections / ✗ D1 and Durable Objects | Native `ANALYZE` sampling                  | Restricted SQLite skips `analysis_limit` but still attempts scoped `ANALYZE`. Performance only — same results             |
| TypeGraph Identity Profile                             | ✓ transactional drivers                           | ✓ transactional drivers                    | Enabled graphs fail fast on non-atomic drivers; identity-disabled graphs retain their ordinary path                      |
| Constraint claim relations (`capabilities.constraintClaims`) | ✓                                           | ✓                                          | Identical relations and identical statements on both dialects. A third-party backend that omits them declares `constraintClaims` absent and keeps the per-graph lock as its only fence |
| Typed constraint error above READ COMMITTED            | n/a (no such isolation mode)                      | ✗ at `REPEATABLE READ` / `SERIALIZABLE`    | PostgreSQL raises `40001` from the claim's upsert instead of resolving the conflict, so the loser retries a serialization failure rather than reading `UniquenessError` |
| Claim row lock released before end of transaction      | ✗                                                 | ✗                                          | Held to commit/rollback on both dialects, refusal included — a caller that catches a constraint error blocks other writers of that axis for the rest of its transaction |
| Recursive traversal (`capabilities.recursiveTraversal`) | ✓                                                 | ✓                                          | Identical on both bundled backends. A third-party backend declaring `{ supported: false, reason }` refuses the five recursion-dependent operations with `ConfigurationError` code `RECURSIVE_TRAVERSAL_UNSUPPORTED`; `weightedShortestPath` degrades to a predecessor walk instead — see above. Unweighted `shortestPath` is unaffected — it never emits a recursive CTE |
| Write fence (`capabilities.pessimisticLocks`)           | ✓ `engine-serialized` (single writer slot)        | ✓ `lock` (advisory + table locks)          | Identical guarantee, different mechanism. A custom backend that declares neither resolves `unfenced` and is refused at construction for Operational Identity or TypeGraph-owned recorded-clock allocation |
| Recorded-time ownership (`capabilities.recordedTimeOwnership`) | `"typegraph-relations"` (default)          | `"typegraph-relations"` (default)          | Both bundled backends own the clock today. `"engine-native"` is refused at construction as an interim measure whenever it is combined with `history`/`revisionTracking`, on either dialect |
| Capability bundles (`CAPABILITY_BUNDLES`)               | Identical                                         | Identical                                  | Both bundled backends implement every pilot bundle's core/extra members on both dialects it scopes to. A third-party backend with a port gap refuses (gated core, or a `refuse`-disposition extra) or degrades (a `fallback`-disposition extra) per that bundle's own registry row |

Identity support also has a **driver** dimension inside each dialect:

| Driver                                                       | Atomic identity support | Behavior                                                                                                            |
| ------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Managed SQLite, libSQL, Durable Objects                      | ✓                       | Full profile                                                                                                        |
| PostgreSQL `node-postgres`, `postgres-js`, neon-serverless, PGlite | ✓                  | Full profile; identity-affecting writes serialize per graph, limiting each graph to one identity writer at a time   |
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
different `metrics`/`indexTypes`/`filteredApproximateSearch`/`searchFrontierTuning` shifts these rows accordingly —
always check `backend.capabilities` at runtime rather than hard-coding the dialect.

`searchFrontierTuning` is **required** on a vector strategy's capabilities, so a strategy must state whether it has a
per-search ANN frontier knob rather than inheriting silence. It is a discriminated union: `{ tunable: true, parameter,
indexType, requiresTransactionScope }` names the engine parameter `efSearch` maps to (`pgvector`: `hnsw.ef_search`, on
an `hnsw` slot, needing a transaction to scope it), while `{ tunable: false, reason }` names why the engine has no such
knob and is what makes `efSearch` a typed refusal there. A hand-written strategy that omits the field no longer
compiles.

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
Identity) throw on those drivers regardless of backend. Schema-managed Store writes also fail closed because they
cannot hold the transaction-scoped schema fence; only raw Store or direct-backend writes retain the sequential,
non-atomic fallback.
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

### Serialized connections

Some drivers run every statement through **one** connection. Two long-lived
interchange streams cannot share such a connection — an export snapshot holds a
read transaction for the whole stream while an import writes one per chunk — so
TypeGraph refuses the second one with a typed error instead of letting it hang
(see
[Interchange serialized-connection guard codes](/errors#interchange-serialized-connection-guard-codes)).

Recognizing a serialized connection means recognizing the *driver*, from the
shape of the client object. That is deliberately conservative: a driver
TypeGraph cannot positively identify is left unmarked, because refusing a pooled
connection would refuse work that succeeds.

| Driver / configuration                                                                        | Detected           | Notes                                                                                                          |
| --------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| better-sqlite3, bun:sqlite, sql.js, local libSQL (`file:` / `:memory:`), Durable Object storage | ✓ automatic        | One handle, one connection                                                                                       |
| PGlite                                                                                        | ✓ automatic        | One in-process WASM connection                                                                                   |
| Bare `pg` / neon-serverless `Client`, a checked-out `PoolClient`                               | ✓ automatic        | One owned socket                                                                                                 |
| `pg` `Pool` capped at one (`{ max: 1 }`, `{ max: "1" }`, `{ poolSize: "1" }`)                  | ✓ automatic        | pg-pool does not coerce the cap, so the string forms are the same one-connection pool                            |
| postgres-js capped at one (`{ max: 1 }`, `?max=1`, `PGMAX=1`)                                  | ✓ automatic        | Same reasoning on the postgres-js side                                                                           |
| Default-size pools, `neon-http`, D1, RDS Data API, remote libSQL (`http` / `ws`)               | — deliberately not | Each statement gets an independent connection; refusing would refuse work that succeeds                          |
| `expo-sqlite`, `op-sqlite`, `sqlite-proxy`, `pg-proxy`, a bespoke adapter                      | ✗ **declare it**   | Serialized in fact, but the client exposes no shape TypeGraph can attribute to a known driver                    |
| Bun `SQL` (Postgres) at `{ max: 1 }`                                                           | ✗ **declare it**   | The cap is readable, but nothing identifies the driver, and a cap on an unknown client is not evidence           |
| postgres-js with a non-numeric string cap other than one, e.g. `?max=5`                        | ✗ **declare it**   | Opens exactly one connection today only because postgres-js does not coerce the value — marking it would encode an upstream bug that will one day be fixed |

For the rows marked **declare it**, tell TypeGraph what it cannot see. The
option is on `createSqliteBackend` and `createPostgresBackend` — the two
factories that resolve it. The batteries-included wrappers
(`createLibsqlBackend`, `createLocalSqliteBackend`, `createLocalPgliteBackend`)
do not take it, because each already detects its own connection.

```typescript
const sql = postgres(process.env.DATABASE_URL + "?max=5");

const backend = createPostgresBackend(drizzle(sql), {
  // This client really does run every statement on one connection.
  serializedResource: { mode: "shared", resource: sql },
});
```

Two backends that name the **same** object are one serialized resource, exactly
as two wrappers over a detected client are. Naming a *different* object than the
one TypeGraph detected is refused with a `ConfigurationError`
(`details.reason: "serialized-resource-conflict"`) rather than silently
preferred: two wrappers over one connection given two different sentinels would
stop being seen as a pair, which is the failure the guard exists to prevent.
The refusal names each side by constructor (`details.declaredKind` /
`details.detectedKind`) instead of carrying the two handles, because `details`
is what `toLogString()` serializes and a driver handle there would log whatever
that driver stores — a `pg.Pool` keeps its `connectionString`.

The reverse declaration escapes a detection that is wrong for your topology:

```typescript
const backend = createSqliteBackend(db, {
  serializedResource: { mode: "independent" },
});
```

**Scope.** `{ mode: "independent" }` lifts the *shared-resource* refusal between
two distinct backend objects. It does not lift the object-identity refusal, under
which one SQLite backend exporting into **itself** is refused with
`INTERCHANGE_SAME_SQLITE_BACKEND_SNAPSHOT`. That one is a fact about a single
handle holding a single open snapshot transaction, not a claim about connection
topology, so no declaration can make it false — pass a second backend instead.
That surviving refusal is SQLite-only, so on PostgreSQL the declaration lifts
the refusal for one backend exporting into itself as well: a client that hands
out independent connections — which is exactly what the declaration claims —
runs the snapshot and the writes it contends with on different ones.

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
  The Store is also raw and unversioned: its writes do not participate in
  the schema-version fence. Direct backend writes have the same semantics.
  Quiesce those writers yourself before changing schemas.

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
  Its managed writes require a transactional backend with the schema-write
  fence; non-transactional and unsupported custom backends can attach for
  reads but fail closed on the first write.

The adapter equivalents (`createAdapterStoreWithSchema` and
`createVerifiedAdapterStore`) carry the same managed metadata. So does
`createAdapterStore(..., { reconciled })` with a cached reconciliation snapshot,
and Stores returned by `evolve()` or rebound from an already-managed Store.
Check `store.introspect().schemaVersion !== undefined` at runtime. Calling
`store.clear()` deletes the schema rows and resets that Store to raw semantics;
reopen it through a managed factory before resuming version-fenced writes.

- **`store.verifyContributions()` diagnoses contribution storage;
  `store.repairContributions()` repairs safe findings under a privileged
  role.**
  Every gate above trusts the marker row without probing the catalog, so
  a database whose strategy-owned tables were dropped out of band opens
  clean and fails at the first dependent read or write. This method compares each contribution
  currently expected by the active graph and backend strategies with its
  marker and the catalog. It does not audit retired marker rows, and a
  never-attempted contribution with neither marker nor table is omitted, so
  an empty result is not initialization proof. It is read-only (`SELECT`
  only, no DDL) so the least-privilege role can run it, and it is deliberately
  not part of any open path. For a readiness check, construct the Store with
  `createVerifiedStore()` first and then run this diagnostic; otherwise use
  it as an operator check. The repair method re-audits current declarations,
  preserves data while repairing `missing-marker` and
  `failed-materialization`, and reports `stale` or `orphaned-marker` as
  `requires-rebuild`. Run repair through the DDL-capable migration role, not
  the least-privilege runtime role. Follow the per-state table in
  [The store opens clean but a fulltext or vector read fails](/troubleshooting#the-store-opens-clean-but-a-fulltext-or-vector-read-fails)
  rather than applying one repair to every entry.

- **`store.probeContributions()` is the read-only readiness check;
  `store.rebuildContribution()` is the destructive last resort.**
  The two bracket `repairContributions()` into one escalation ladder:
  probe (writes nothing) → repair (non-destructive) → rebuild
  (destructive, but scoped to the calling graph). The probe reports one
  `ready` / `degraded` entry per
  search projection and is safe on a read path, on a replica, and under
  the least-privilege role — it shares the detection logic of the other
  two rather than reimplementing it, so it cannot disagree with the gate
  the hot path actually consults. The rebuild is the only repair for a
  `stale` contribution, whose table exists at a shape the current
  `createDdl` no longer produces; it deletes and refills only the calling
  graph's rows in the shared fulltext table, escalating to drop → recreate
  when that table holds no other graph's rows (under a database-scoped DDL
  advisory lock, since that DDL is database-global), and runs the whole
  sequence inside one transaction under the schema-write fence. It refuses
  with `ContributionRebuildUnsupportedError` for vector storage, whose
  embeddings exist only in the table it would drop
  (`reason: "vector-source-unavailable"`), and for a `stale` shape whose
  storage still holds other graphs' rows
  (`reason: "shared-storage-in-use"`, naming them in
  `details.otherGraphIds`). Run rebuilds through
  the DDL-capable migration role, in a maintenance window: the
  transaction is held for the whole refill, and on PostgreSQL a drop's
  `ACCESS EXCLUSIVE` lock blocks both searches and writes to any kind with
  `searchable()` fields until it commits. Reach it from a `createStore()`
  Store — the managed factory's boot step refuses to open while a
  contribution is `stale`. See
  [Contribution health: probe, repair, rebuild](/troubleshooting#contribution-health-probe-repair-rebuild).

### Contribution capability parity

`backend.capabilities.contributions` declares how far up the ladder a
backend goes. Each rung is separate because a backend can genuinely stop
at any of them, and a rung a backend cannot serve refuses with a typed
error rather than returning something that looks like success.

| Backend | `supported` | `probe` | `rebuild` |
| --- | --- | --- | --- |
| SQLite (better-sqlite3, bun:sqlite, libSQL, Durable Objects) | ✅ | ✅ | ✅ |
| SQLite with `transactionMode: "none"` | ✅ | ✅ | ❌ no schema fence |
| PostgreSQL (`pg`, `postgres-js`, PGlite, `neon-serverless`) | ✅ | ✅ | ✅ |
| PostgreSQL over `neon-http` | ✅ | ✅ | ❌ no schema fence |
| Custom fulltext strategy without `dropDdl` | ✅ | ✅ | ❌ no teardown DDL |

`rebuild` requires two things at once: a fulltext strategy that declares
`dropDdl` on its contribution, and a transactional schema fence
(`schemaWriteTransaction`) to run the sequence under. The HTTP-only
PostgreSQL drivers cannot hold a session across statements, so they have
no fence — the same reason they already report
`capabilities.transactions === false`. A third-party strategy predating
`dropDdl` keeps working for every other operation and is reported as not
rebuildable rather than being dropped through a synthesized statement
TypeGraph guessed at. Vector contributions are never rebuildable on any
backend; that is a property of what TypeGraph stores, not of the engine.

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
