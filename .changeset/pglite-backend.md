---
"@nicia-ai/typegraph": minor
---

Add first-class support for [PGlite](https://pglite.dev/) (Postgres-in-WASM),
closing #160.

- **Execution fast-path fix.** `createPostgresBackend` now detects a PGlite
  `db.$client` and routes it to the unnamed positional query wrapper. PGlite's
  `.query` has no node-postgres named-statement config form — passing one
  desyncs its single connection (`08P01`), so under the default
  `prepareStatements: true` every query previously failed. PGlite works
  unchanged with `createPostgresBackend(drizzle(pglite))` now.

- **`createLocalPgliteBackend`** — a batteries-included helper under the new
  `@nicia-ai/typegraph/postgres/pglite` entry, the Postgres analog of
  `createLocalSqliteBackend`. It constructs an in-process PGlite engine
  (in-memory by default, or any `dataDir`), loads pgvector, runs the schema
  DDL, and returns `{ backend, db, client }` whose `close()` disposes the
  engine. Pass `vector: false` to skip the extension, or `vector: <Extension>`
  to bring your own pgvector build.

`@electric-sql/pglite` (and, for vector support, `@electric-sql/pglite-pgvector`
on PGlite ≥ 0.5) are optional peer dependencies. The biggest payoff: the
Postgres dialect and pgvector path can now be exercised in plain `pnpm test`
with zero Docker.
