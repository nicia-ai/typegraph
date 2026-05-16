/**
 * Unified table-contribution contract (#129).
 *
 * Every table TypeGraph owns — whether modeled as a Drizzle table or
 * emitted as strategy-owned raw DDL — is described by a single
 * {@link TableContribution} shape. This is the one place that answers
 * "what tables does this backend/strategy own?", replacing the
 * previously split surfaces (Drizzle named exports, tables-factory
 * recursion, strategy raw DDL, per-table `ensureXTable` methods).
 *
 * Lives in the neutral `backend/` layer (sibling of `backend/types.ts`,
 * which `query/dialect` already depends on) with **type-only** Drizzle
 * imports, so declaring contributions does not pull the concrete
 * Drizzle backend runtime into the query/dialect layer.
 *
 * ## Identity vs. signature (prerequisite for #135)
 *
 * #135 (durable fulltext/contribution materialization) needs to make
 * "not materialized" vs. "materialized but stale" a decidable, durable
 * fact instead of an in-memory per-backend latch. That requires two
 * conceptually separate things, and #129's job is only to make both
 * *derivable* from the contract:
 *
 * - **Materialization identity** — `owner` + `logicalName` +
 *   resolved physical `tableName`. Keying on `logicalName` alone is
 *   insufficient: custom per-deployment table names must be
 *   distinguishable, otherwise two deployments with different physical
 *   names would collide on one durable marker. (#135 additionally
 *   scopes this by `graphId` at persistence time.)
 * - **Drift signature** — a hash of the strategy identity/version,
 *   the resolved table name(s), and the normalized `createDdl`. #129
 *   guarantees `createDdl` is deterministic for a given resolved
 *   configuration so the hash #135 computes is meaningful.
 *
 * The signature is intentionally **not** eagerly carried on the
 * contribution: hashing is async (Web Crypto, see `utils/hash`) and
 * #135 already owns signature persistence the same way
 * `materializeIndexes` does for declared indexes.
 */
import type { PgTableWithColumns } from "drizzle-orm/pg-core";
import type { SQLiteTableWithColumns } from "drizzle-orm/sqlite-core";

/**
 * `logicalName` of the strategy-owned fulltext slot. Used as a logic
 * discriminant (latch routing, runtime-ensure) across the strategies
 * and both backends — a shared constant so a strategy declaring a
 * different name fails loudly at the call site instead of silently
 * skipping the latched fulltext path.
 */
export const FULLTEXT_CONTRIBUTION_NAME = "fulltext";

/** `owner` of core/base schema tables (not strategy-owned). */
export const BASE_CONTRIBUTION_OWNER = "base";

/**
 * Where a contribution's storage comes from. Drives two otherwise
 * structural decisions declaratively:
 *
 * - **drizzle-kit visibility**: only `drizzle-*` contributions are
 *   re-exported for drizzle-kit introspection. Previously decided by
 *   scattered `table === tables.fulltext` reference-identity checks in
 *   the DDL generators.
 * - **DDL-generation routing**: `drizzle-*` contributions can flow
 *   through the column-walker; `raw-ddl` contributions (SQLite FTS5
 *   virtual tables, future pg_trgm / ParadeDB / pgroonga stacks) are
 *   emitted verbatim from `createDdl`.
 *
 * The `drizzle-*` variants reference the **exact** table object the
 * schema factory created and exports — never a second `pgTable`
 * constructed elsewhere for the same physical table.
 */
export type TableContributionSource =
  | {
      readonly kind: "drizzle-pg";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly table: PgTableWithColumns<any>;
    }
  | {
      readonly kind: "drizzle-sqlite";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly table: SQLiteTableWithColumns<any>;
    }
  | { readonly kind: "raw-ddl" };

/**
 * A single table TypeGraph owns.
 */
export type TableContribution = Readonly<{
  /**
   * Stable, graph- and deployment-independent identity for the logical
   * slot this contribution fills (e.g. `"fulltext"`). NOT the physical
   * table name. Stable across table-name overrides and across strategy
   * swaps of the *same* logical slot, so #135's durable marker can
   * survive both.
   */
  logicalName: string;
  /**
   * Identifies the producer of this contribution (e.g. a strategy id
   * like `"tsvector"` / `"fts5"`, or `"base"` for core schema tables).
   * Part of the #135 materialization identity and an input to the
   * drift signature — a strategy swap on the same `logicalName` is a
   * legitimate, detectable drift, not a silent reuse.
   */
  owner: string;
  /**
   * Resolved physical table name after any per-deployment name
   * override. Part of the #135 materialization identity (custom names
   * must be distinguishable) and used by diagnostics / the focused
   * bootstrap ensure.
   */
  tableName: string;
  /**
   * Idempotent (`CREATE ... IF NOT EXISTS`) statements that
   * materialize this contribution's table **and its supporting
   * indexes**. Running the full list is how `ensureContribution`
   * self-heals partial states (table present, index missing) — it is
   * not a probe-and-skip. Deterministic for a given resolved
   * configuration: the canonical normalized input to #135's drift
   * signature.
   */
  createDdl: readonly string[];
  /**
   * When `true`, the post-schema-load focused ensure
   * (`loadActiveSchemaWithBootstrap`) materializes this contribution
   * on every successful schema load.
   *
   * **Invariant: only strategy-declared contributions may set this.**
   * Core/base tables are always `false` — they are created by
   * drizzle-kit / `bootstrapTables`. This is what lets the boot path
   * derive runtime contributions straight from the strategy
   * (`fulltextStrategy.ownedTables`) without walking — and generating
   * DDL for — every base table.
   */
  runtimeEnsure: boolean;
  /** Storage origin — see {@link TableContributionSource}. */
  source: TableContributionSource;
}>;

/**
 * Whether a contribution should be visible to drizzle-kit (i.e. is
 * backed by a Drizzle table object, not strategy-owned raw DDL).
 */
export function isDrizzleContribution(
  contribution: TableContribution,
): boolean {
  return contribution.source.kind !== "raw-ddl";
}

/**
 * How the schema factory should source a strategy-declared table.
 *
 * - `"raw-ddl"` — emit `createDdl` verbatim; not drizzle-kit visible
 *   (SQLite FTS5 virtual tables, raw-DDL Postgres stacks).
 * - `"drizzle-pg"` — the Postgres factory attaches the **exact**
 *   `tables.fulltext` pgTable object it already created and exports;
 *   the strategy never constructs a Drizzle table itself, so there is
 *   never a second object for the same physical table.
 *
 * There is intentionally no `"drizzle-sqlite"`: the SQLite factory has
 * no strategy-owned Drizzle table slot to attach (FTS5 virtual tables
 * aren't Drizzle-modelable, so SQLite strategies are `"raw-ddl"`).
 * `TableContributionSource` still carries a `drizzle-sqlite` kind for
 * *resolved* base/core tables — that path is unaffected.
 */
export type StrategyDrizzleModel = "raw-ddl" | "drizzle-pg";

/**
 * A table a {@link FulltextStrategy} declares it owns. This is the
 * strategy's *declaration*; the schema factory resolves it into the
 * authoritative {@link TableContribution} — attaching the real Drizzle
 * table object for `drizzle-*` models (see {@link StrategyDrizzleModel}).
 *
 * Deliberately Drizzle-free so implementing a custom strategy never
 * requires a `drizzle-orm` dependency.
 */
export type StrategyTableContribution = Readonly<{
  logicalName: string;
  owner: string;
  tableName: string;
  createDdl: readonly string[];
  runtimeEnsure: boolean;
  drizzleModel: StrategyDrizzleModel;
}>;
