---
title: Backend Setup
description: Configure SQLite and PostgreSQL backends for TypeGraph
---

TypeGraph stores graph data in your existing relational database using Drizzle ORM adapters.
This guide covers setting up SQLite and PostgreSQL backends.

:::note[Custom indexes]
TypeGraph migrations create the core tables and built-in indexes. For application-specific indexes
on JSON properties (and Drizzle/drizzle-kit integration), see [Indexes](/performance/indexes).
:::

## SQLite

SQLite is ideal for development, testing, single-server deployments, and embedded applications.

### Quick Setup

For development and testing, use the convenience function that handles everything:

```typescript
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";
import { createStore } from "@nicia-ai/typegraph";

// In-memory database (resets on restart)
const { backend } = createLocalSqliteBackend();
const store = createStore(graph, backend);

// File-based database (persisted)
const { backend, db } = createLocalSqliteBackend({ path: "./app.db" });
const store = createStore(graph, backend);
```

### Manual Setup

For full control over the database connection:

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteBackend, generateSqliteMigrationSQL } from "@nicia-ai/typegraph/sqlite";
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

For semantic search, use sqlite-vec:

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteBackend, generateSqliteMigrationSQL } from "@nicia-ai/typegraph/sqlite";

const sqlite = new Database("app.db");

// Load sqlite-vec extension
sqlite.loadExtension("vec0");

// Run migrations (includes vector index setup)
sqlite.exec(generateSqliteMigrationSQL());

const db = drizzle(sqlite);
const backend = createSqliteBackend(db);
```

See [Semantic Search](/semantic-search) for query examples.

### libsql / Turso

For edge deployments, shared-driver setups, or Turso cloud databases, use the first-class
libsql backend:

```bash
npm install @libsql/client
```

```typescript
import { createClient } from "@libsql/client";
import { createLibsqlBackend } from "@nicia-ai/typegraph/sqlite/libsql";
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
  path?: string;       // Database path, defaults to ":memory:"
  tables?: SqliteTables;
}): { backend: GraphBackend; db: BetterSQLite3Database };
```

#### `createSqliteBackend(db, options?)`

Creates a SQLite backend from an existing Drizzle database instance.

```typescript
function createSqliteBackend(
  db: BetterSQLite3Database,
  options?: { tables?: SqliteTables }
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
async function createLibsqlBackend(
  client: Client,
  options?: { tables?: SqliteTables }
): Promise<{ backend: GraphBackend; db: LibSQLDatabase }>;
```

## PostgreSQL

PostgreSQL is recommended for production deployments with concurrent access, large datasets,
or when you need advanced features like pgvector.

`createPostgresBackend` is driver-agnostic. Pick the Drizzle adapter that matches your
runtime, and TypeGraph works the same way against each.

### Choosing a PostgreSQL driver

| Runtime | Recommended driver | Drizzle adapter |
|---|---|---|
| Long-lived Node server (Fly, Render, Cloud Run, containers) | `pg` (node-postgres) or `postgres` (postgres-js) | `drizzle-orm/node-postgres` or `drizzle-orm/postgres-js` |
| Node serverless (Vercel Functions, AWS Lambda, Netlify Functions) | `postgres` (postgres-js) — faster cold start, lower per-query overhead | `drizzle-orm/postgres-js` |
| Bun server | `postgres` (postgres-js) or Bun's built-in SQL | `drizzle-orm/postgres-js` or `drizzle-orm/bun-sql` |
| Edge runtime (Cloudflare Workers, Vercel Edge, Netlify Edge) — needs transactions | `@neondatabase/serverless` Pool over WebSockets | `drizzle-orm/neon-serverless` |
| Edge runtime — single-statement reads/writes only | `@neondatabase/serverless` `neon(url)` over HTTP | `drizzle-orm/neon-http` |
| Cloudflare Hyperdrive | `pg` or `postgres` (through the Hyperdrive pooler) | `drizzle-orm/node-postgres` or `drizzle-orm/postgres-js` |

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
import { createPostgresBackend } from "@nicia-ai/typegraph/postgres";
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
import { generatePostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";

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
import { createPostgresBackend } from "@nicia-ai/typegraph/postgres";
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
import { createPostgresBackend } from "@nicia-ai/typegraph/postgres";
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
import { createPostgresBackend } from "@nicia-ai/typegraph/postgres";
import { createStore } from "@nicia-ai/typegraph";

const sql = neon(env.NEON_DATABASE_URL);
const db = drizzle({ client: sql });
const backend = createPostgresBackend(db);
const store = createStore(graph, backend);
// backend.capabilities.transactions === false (auto-detected)
```

Use `neon-http` for reads, single upserts, and migrations. Use `neon-serverless`
when you need atomic multi-statement writes.

### PostgreSQL with Vector Search

For semantic search, enable pgvector:

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresBackend, generatePostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Migration SQL includes pgvector extension
await pool.query(generatePostgresMigrationSQL());
// Runs: CREATE EXTENSION IF NOT EXISTS vector;

const db = drizzle(pool);
const backend = createPostgresBackend(db);
```

See [Semantic Search](/semantic-search) for query examples.

### Refreshing planner statistics after bulk loads

Call `store.refreshStatistics()` after any large initial import or bulk
backfill. PostgreSQL's query planner relies on table statistics to choose
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
or fulltext / embedding configuration. If you need to bypass the API for an
unusual deployment (for example issuing `ANALYZE` over a separate admin
connection), call `backend.execute()` with raw SQL as the escape hatch.

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
  max: 20,                    // Maximum pool size
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
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
`drizzle-orm/postgres-js`, `drizzle-orm/neon-serverless`, and
`drizzle-orm/neon-http`. The neon-http driver is auto-detected and
`capabilities.transactions` is set to `false` (HTTP can't hold a session); use
`drizzle-orm/neon-serverless` if you need transactional writes.

```typescript
function createPostgresBackend(
  db: AnyPgDatabase,
  options?: {
    tables?: PostgresTables;
    fulltext?: FulltextStrategy;
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
  }
): GraphBackend;
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

## Drizzle Entrypoints

TypeGraph exposes Drizzle adapters through public entrypoints:

- `@nicia-ai/typegraph/sqlite` — Generic SQLite adapter (any Drizzle SQLite driver)
- `@nicia-ai/typegraph/sqlite/local` — Batteries-included better-sqlite3 wrapper (Node.js only)
- `@nicia-ai/typegraph/sqlite/libsql` — Batteries-included libsql wrapper (Node.js, Workers, browser)
- `@nicia-ai/typegraph/postgres` — PostgreSQL adapter

Import from the entrypoint matching your database:

```typescript
import { createSqliteBackend, tables } from "@nicia-ai/typegraph/sqlite";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";
import { createLibsqlBackend } from "@nicia-ai/typegraph/sqlite/libsql";
import { createPostgresBackend, tables } from "@nicia-ai/typegraph/postgres";
```

## Cloudflare D1

TypeGraph supports Cloudflare D1 for edge deployments, with some limitations.

Use `createStoreWithSchema()` to automatically create tables on a fresh D1
database and manage schema versions across deployments:

```typescript
import { drizzle } from "drizzle-orm/d1";
import { createStoreWithSchema } from "@nicia-ai/typegraph";
import { createSqliteBackend } from "@nicia-ai/typegraph/sqlite";

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

**Important:** D1 does not support transactions. See [Limitations](/limitations) for details.

## Backend Capabilities

Check what features a backend supports:

```typescript
const backend = createSqliteBackend(db);

if (backend.capabilities.transactions) {
  await store.transaction(async (tx) => { /* ... */ });
} else {
  // Handle non-transactional execution
}

if (backend.capabilities.vector?.supported) {
  // Vector similarity queries available
}
```

## Connection Management

TypeGraph does not manage database connections. You are responsible for:

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

The `store.close()` method is a no-op—cleanup is your responsibility.

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

```typescript
// PostgreSQL with pooling
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  ssl: { rejectUnauthorized: false }, // For managed databases
});

await pool.query(generatePostgresMigrationSQL());
const db = drizzle(pool);
const backend = createPostgresBackend(db);
const [store] = await createStoreWithSchema(graph, backend);
```

## Next Steps

- [Schemas & Types](/core-concepts) - Define your graph schema
- [Semantic Search](/semantic-search) - Vector embeddings and similarity search
- [Limitations](/limitations) - Backend-specific constraints
