---
"@nicia-ai/typegraph": minor
---

Unified `TableContribution` contract for strategy-owned tables (#129).

"What tables does TypeGraph own?" was previously split across four
uncoordinated surfaces (Drizzle named exports, tables-factory
recursion, strategy raw DDL, per-table `ensureXTable` methods). Adding
a new strategy- or backend-owned table without also wiring an
`ensureXTable` + bootstrap probe re-opened the gap #128 closed. This
refactor routes every owned table through one shape.

**Breaking (custom `FulltextStrategy` implementers only):**
`FulltextStrategy.generateDdl(tableName): string[]` is replaced by
`ownedTables(primaryTableName): readonly StrategyTableContribution[]`.
A strategy now *declares* its tables, Drizzle-free, as already
authoritative contributions (`logicalName`, `owner`, resolved
`tableName`, idempotent `createDdl` for the table **and its supporting
indexes**, `runtimeEnsure`). The two shipped strategies
(`tsvectorStrategy`, `fts5Strategy`) and all internal callers are
migrated; consumers using only the shipped strategies need no changes.

**What ships:**

- New `@nicia-ai/typegraph` export: `TableContribution` and
  `StrategyTableContribution` (its strategy-declaration alias). Each
  contribution carries a stable, deployment-independent `logicalName`
  plus the resolved physical `tableName` (distinct identity vs.
  drift-signature inputs) — the prerequisite that lets #135 make
  fulltext materialization a durable, decidable fact instead of an
  in-memory per-backend latch.
- `postgresContributions()` / `sqliteContributions()` are the single
  source of truth for DDL generation and the bootstrap ensure.
  `generatePostgresDDL` / `generateSqliteDDL` iterate contributions;
  the `table === tables.fulltext` reference-identity hack is gone from
  DDL generation. drizzle-kit visibility for the default Postgres
  strategy comes from the schema barrel exporting the matching
  `tables.fulltext` object (one object, not two); a non-default
  strategy exports its own.
- New backend method `ensureRuntimeContributions()`, which runs each
  `runtimeEnsure` contribution's full idempotent `createDdl` (table +
  supporting indexes) so a partial state (table present, index
  missing) self-heals — not a probe-and-skip.
  `loadActiveSchemaWithBootstrap` calls it scoped to `runtimeEnsure`
  contributions only (the strategy-owned fulltext table today), so
  startup does not regress into broad DDL/probing across every table.
  `ensureFulltextTable` is retained as a thin back-compat wrapper.

DDL statement ordering changes from "all CREATE TABLE, then all CREATE
INDEX, then fulltext" to per-contribution "table then its own
indexes". Safe because TypeGraph's tables carry no cross-table foreign
keys; raw migration SQL byte output differs accordingly.

Prerequisite for #135 (durable fulltext materialization), which is in
turn the prerequisite for #134 (cross-store transaction adoption).
