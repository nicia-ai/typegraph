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
A strategy now *declares* its tables (Drizzle-free: `logicalName`,
`owner`, resolved `tableName`, idempotent `createDdl` for the table
**and its supporting indexes**, and a `drizzleModel` discriminant);
the schema factory resolves those declarations into authoritative
`TableContribution`s. The two shipped strategies (`tsvectorStrategy`,
`fts5Strategy`) and all internal callers are migrated; consumers using
only the shipped strategies need no changes.

**What ships:**

- New `@nicia-ai/typegraph` export: `TableContribution`,
  `TableContributionSource`, `StrategyTableContribution`,
  `StrategyDrizzleModel`, `isDrizzleContribution`. Each contribution
  carries a stable, deployment-independent `logicalName` plus the
  resolved physical `tableName` (distinct identity vs. drift-signature
  inputs) — the prerequisite that lets #135 make fulltext
  materialization a durable, decidable fact instead of an in-memory
  per-backend latch.
- `postgresContributions()` / `sqliteContributions()` are the single
  source of truth for DDL generation, the bootstrap ensure, and
  drizzle-kit visibility. The Postgres `tables.fulltext` pgTable is
  created once by the factory and that **exact** object is attached to
  the fulltext contribution — never a second object for the same
  physical table. `generatePostgresDDL` / `generateSqliteDDL` iterate
  contributions; the `table === tables.fulltext` reference-identity
  hack is gone. drizzle-kit visibility is now declarative
  (`source.kind`) rather than structural.
- New backend methods `ensureContribution(logicalName)` and
  `ensureRuntimeContributions()`. `ensureContribution` runs a
  contribution's full idempotent `createDdl` (table + supporting
  indexes), so a partial state (table present, index missing)
  self-heals — it is not a probe-and-skip.
  `loadActiveSchemaWithBootstrap` now calls
  `ensureRuntimeContributions()`, scoped to `runtimeEnsure`
  contributions only (the strategy-owned fulltext table today), so
  startup does not regress into broad DDL/probing across every table.
  `ensureFulltextTable` is retained as a thin back-compat wrapper.

DDL statement ordering changes from "all CREATE TABLE, then all CREATE
INDEX, then fulltext" to per-contribution "table then its own
indexes". Safe because TypeGraph's tables carry no cross-table foreign
keys; raw migration SQL byte output differs accordingly.

Prerequisite for #135 (durable fulltext materialization), which is in
turn the prerequisite for #134 (cross-store transaction adoption).
