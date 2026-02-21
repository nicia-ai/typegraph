---
"@nicia-ai/typegraph": minor
---

Restructure SQLite/Postgres entry points to decouple DDL generation from native dependencies.

**Breaking changes:**

- `./drizzle`, `./drizzle/sqlite`, `./drizzle/postgres`, `./drizzle/schema/sqlite`, `./drizzle/schema/postgres` entry points are removed. Import backend factories, schema tables/factories, and DDL helpers from `./sqlite` and `./postgres`.
- `createLocalSqliteBackend` moves from `./sqlite` to `./sqlite/local`. The `./sqlite` entry point no longer depends on `better-sqlite3`.
- `getSqliteMigrationSQL` is renamed to `generateSqliteMigrationSQL`.
- `getPostgresMigrationSQL` is renamed to `generatePostgresMigrationSQL`.
- Individual table type aliases (`NodesTable`, `EdgesTable`, `UniquesTable`, `SchemaVersionsTable`, `EmbeddingsTable`) are removed from both schema modules. Use `SqliteTables["nodes"]` or `PostgresTables["edges"]` instead.

**Migration guide:**

| Before | After |
|--------|-------|
| `import { ... } from "@nicia-ai/typegraph/drizzle/sqlite"` | `import { ... } from "@nicia-ai/typegraph/sqlite"` |
| `import { ... } from "@nicia-ai/typegraph/drizzle/postgres"` | `import { ... } from "@nicia-ai/typegraph/postgres"` |
| `import { ... } from "@nicia-ai/typegraph/drizzle/schema/sqlite"` | `import { ... } from "@nicia-ai/typegraph/sqlite"` |
| `import { ... } from "@nicia-ai/typegraph/drizzle/schema/postgres"` | `import { ... } from "@nicia-ai/typegraph/postgres"` |
| `import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite"` | `import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local"` |
| `getSqliteMigrationSQL()` | `generateSqliteMigrationSQL()` |
| `getPostgresMigrationSQL()` | `generatePostgresMigrationSQL()` |
| `NodesTable`, `EdgesTable`, `UniquesTable`, `SchemaVersionsTable`, `EmbeddingsTable` | `SqliteTables["nodes"]` / `PostgresTables["nodes"]` (and corresponding table keys) |
