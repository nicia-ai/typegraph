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
 * which `query/dialect` already depends on) and is deliberately
 * Drizzle-free, so declaring contributions does not pull the concrete
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
   * indexes**. Running the full list is how the runtime ensure
   * self-heals partial states (table present, index missing) — it is
   * not a probe-and-skip. Deterministic for a given resolved
   * configuration: the canonical normalized input to #135's drift
   * signature.
   */
  createDdl: readonly string[];
  /**
   * Idempotent (`DROP ... IF EXISTS`) statements that tear this
   * contribution's storage down, ordered so that running the list
   * leaves nothing behind. Declaring it is what makes a contribution
   * *rebuildable*: the destructive
   * `store.rebuildContribution()` path drops through these statements
   * before re-running {@link createDdl}, which is the only repair for a
   * table provisioned at a shape the current `createDdl` no longer
   * produces.
   *
   * Optional because it is a capability, not an invariant. A
   * contribution whose content cannot be reconstructed from data
   * TypeGraph already stores has no business advertising a rebuild —
   * dropping it would destroy the only copy — and a third-party
   * strategy that predates this field keeps compiling and is reported
   * as not rebuildable rather than silently rebuilt through a
   * synthesized `DROP`. Backends surface the resulting gap as
   * `capabilities.contributions.rebuild`.
   *
   * The rebuild visits a strategy's `runtimeEnsure` contributions, the
   * same set the boot ensure provisions — so a companion table a strategy
   * declares outside that set is neither dropped nor recreated, and must
   * not be something the recreated storage depends on.
   */
  dropDdl?: readonly string[];
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
}>;

/**
 * A table a {@link FulltextStrategy} declares it owns. An alias, not a
 * distinct shape: a strategy's declaration is already authoritative
 * (no resolution step). The name documents the producer role.
 */
export type StrategyTableContribution = TableContribution;
