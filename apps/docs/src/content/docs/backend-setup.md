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
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite";
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
import { createSqliteBackend, getSqliteMigrationSQL } from "@nicia-ai/typegraph/sqlite";
import { createStore } from "@nicia-ai/typegraph";

// Create and configure the database
const sqlite = new Database("app.db");
sqlite.pragma("journal_mode = WAL"); // Recommended for performance
sqlite.pragma("foreign_keys = ON");

// Run TypeGraph migrations
sqlite.exec(getSqliteMigrationSQL());

// Create Drizzle instance and backend
const db = drizzle(sqlite);
const backend = createSqliteBackend(db);
const store = createStore(graph, backend);

// Clean up when done
process.on("exit", () => sqlite.close());
```

### SQLite with Vector Search

For semantic search, use sqlite-vec:

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteBackend, getSqliteMigrationSQL } from "@nicia-ai/typegraph/sqlite";

const sqlite = new Database("app.db");

// Load sqlite-vec extension
sqlite.loadExtension("vec0");

// Run migrations (includes vector index setup)
sqlite.exec(getSqliteMigrationSQL());

const db = drizzle(sqlite);
const backend = createSqliteBackend(db);
```

See [Semantic Search](/semantic-search) for query examples.

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

#### `getSqliteMigrationSQL()`

Returns SQL for creating TypeGraph tables in SQLite.

```typescript
function getSqliteMigrationSQL(): string;
```

## PostgreSQL

PostgreSQL is recommended for production deployments with concurrent access, large datasets,
or when you need advanced features like pgvector.

### Basic Setup

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresBackend, getPostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";
import { createStore } from "@nicia-ai/typegraph";

// Create connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum connections
});

// Run TypeGraph migrations
await pool.query(getPostgresMigrationSQL());

// Create Drizzle instance and backend
const db = drizzle(pool);
const backend = createPostgresBackend(db);
const store = createStore(graph, backend);
```

### PostgreSQL with Vector Search

For semantic search, enable pgvector:

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresBackend, getPostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Migration SQL includes pgvector extension
await pool.query(getPostgresMigrationSQL());
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

#### `getPostgresMigrationSQL()`

Returns SQL for creating TypeGraph tables in PostgreSQL, including the pgvector extension.

```typescript
function getPostgresMigrationSQL(): string;
```

#### `generatePostgresDDL(tables?)`

Returns individual DDL statements (CREATE TABLE, CREATE INDEX) as an array. Useful when you
need per-statement control, for example to execute them in separate transactions or log them
individually.

```typescript
function generatePostgresDDL(tables?: PostgresTables): string[];
```

## Drizzle Entrypoints

TypeGraph exposes Drizzle adapters through three public entrypoints:

- `@nicia-ai/typegraph/drizzle` - Combined SQLite + PostgreSQL exports
- `@nicia-ai/typegraph/drizzle/sqlite` - SQLite-only adapter exports
- `@nicia-ai/typegraph/drizzle/postgres` - PostgreSQL-only adapter exports

Use the combined entrypoint when you want one import surface:

```typescript
import {
  createPostgresBackend,
  createSqliteBackend,
  postgresTables,
  sqliteTables,
} from "@nicia-ai/typegraph/drizzle";
```

Use the PostgreSQL-only entrypoint when you only target Postgres:

```typescript
import { createPostgresBackend, tables } from "@nicia-ai/typegraph/drizzle/postgres";
```

## Cloudflare D1

TypeGraph supports Cloudflare D1 for edge deployments, with some limitations.

```typescript
import { drizzle } from "drizzle-orm/d1";
import { createStore } from "@nicia-ai/typegraph";
import { createSqliteBackend } from "@nicia-ai/typegraph/drizzle/sqlite";

export default {
  async fetch(request: Request, env: Env) {
    const db = drizzle(env.DB);
    const backend = createSqliteBackend(db);
    const store = createStore(graph, backend);

    // Use store...
  },
};
```

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

await pool.query(getPostgresMigrationSQL());
const db = drizzle(pool);
const backend = createPostgresBackend(db);
const [store] = await createStoreWithSchema(graph, backend);
```

## Next Steps

- [Schemas & Types](/core-concepts) - Define your graph schema
- [Semantic Search](/semantic-search) - Vector embeddings and similarity search
- [Limitations](/limitations) - Backend-specific constraints
