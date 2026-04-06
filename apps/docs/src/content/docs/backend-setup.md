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

### Basic Setup

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresBackend } from "@nicia-ai/typegraph/postgres";
import { createStoreWithSchema } from "@nicia-ai/typegraph";

// Create connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum connections
});

// Create Drizzle instance and backend
const db = drizzle(pool);
const backend = createPostgresBackend(db);

// createStoreWithSchema auto-creates tables on first run
const [store] = await createStoreWithSchema(graph, backend);
```

If you manage DDL externally, use `generatePostgresMigrationSQL()` with `createStore()`:

```typescript
import { generatePostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";

await pool.query(generatePostgresMigrationSQL());
const store = createStore(graph, backend);
```

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

Creates a PostgreSQL backend adapter.

```typescript
function createPostgresBackend(
  db: NodePgDatabase,
  options?: { tables?: PostgresTables }
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

if (backend.capabilities.vectorSearch) {
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
