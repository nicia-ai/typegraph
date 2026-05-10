---
"@nicia-ai/typegraph": patch
---

Fix drizzle-kit-managed fulltext bootstrap gap on both Postgres and SQLite (#128).

Consumers managing typegraph storage via `drizzle-kit push` /
`drizzle-kit generate` (`export * from "@nicia-ai/typegraph/postgres"`
or `…/sqlite"`) got every typegraph table EXCEPT
`typegraph_node_fulltext`. The fulltext table was strategy-owned raw
DDL — the schema modules exposed only `fulltextTableName: string`,
not a Drizzle table — so drizzle-kit silently skipped it. The
`bootstrapTables` fallback in `loadActiveSchemaWithBootstrap` only
fires on a missing-table error from `getActiveSchema`; once
drizzle-kit had created `typegraph_schema_versions`, that branch
stopped triggering and `searchable()` writes failed at runtime with
`relation/table "typegraph_node_fulltext" does not exist`.

Two fixes ship together:

- **`backend.ensureFulltextTable()` (both backends).** A focused
  narrow-ensure that mirrors the existing
  `ensureIndexMaterializationsTable` /
  `ensureKindRemovalsTable` /
  `ensureReconciliationMarkersTable` idiom — single-table
  `CREATE … IF NOT EXISTS`, no Postgres SHARE-lock deadlock under
  concurrent replica startup. The backend wraps every method that
  emits fulltext SQL (`upsertFulltext` / `deleteFulltext` and their
  batch variants, `fulltextSearch`, and `hardDeleteNode` whose
  cascade unconditionally deletes from the fulltext table) to call
  the ensure first. A per-backend latch makes the per-call cost a
  single boolean check after the first invocation, so the wrapping
  is safe on the hot path. `loadActiveSchemaWithBootstrap` also
  calls the ensure as a belt-and-suspenders for the
  `createStoreWithSchema` path. Together these cover both async
  schema-aware boot AND the sync `createStore` path — the bare
  bootstrap-load probe alone would miss the latter. This is the
  canonical fix and the **only** viable one for SQLite (FTS5
  virtual tables aren't drizzle-kit-modelable).

- **Typed Drizzle pg-core table for `tsvectorStrategy` (Postgres
  only).** `createPostgresTables()` now returns
  `tables.fulltext` — a typed `pgTable` for the default
  `tsvector` + GIN stack — alongside `tables.fulltextTableName`.
  The new `fulltext` named export is included in
  `@nicia-ai/typegraph/postgres`, so `export *` lets drizzle-kit
  generate migrations for the fulltext table the same way it does
  for `nodes`/`edges`/etc. Custom `tsvector`/`regconfig` column
  types are exported alongside the existing `vector` column.

  `generatePostgresDDL` deliberately skips the typed Drizzle table
  (the column-walker can't reproduce the `GENERATED ALWAYS AS (…)
  STORED` clause) and continues to defer to
  `tsvectorStrategy.generateDdl()` for the runtime DDL emit. The
  two paths agree byte-for-byte; a drift sentinel test catches any
  divergence.

  Alternate Postgres fulltext strategies (pg_trgm, ParadeDB,
  pgroonga) still own their own DDL via
  `FulltextStrategy.generateDdl()` and the bootstrap probe runs it.
  Drizzle-kit consumers using a non-default strategy must override
  `tables.fulltext` in their schema barrel with their strategy's
  own table.

Documented the SQLite FTS5 virtual-table caveat and the new
Postgres `tables.fulltext` export in
`apps/docs/src/content/docs/integration.md`.
