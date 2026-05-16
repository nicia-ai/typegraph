/**
 * Shared building blocks for the
 * `typegraph_contribution_materializations` durable-marker table on
 * both SQLite and Postgres backends (#135).
 *
 * Independent sibling of `index-materializations.ts`. It deliberately
 * mirrors that module's shape — dialect timestamp adapter, raw-row
 * mapper, insert/upsert value builders, the `materialized_at` COALESCE
 * preservation rule for failed re-attempts — but stays a separate
 * module because the two status tables have different identities:
 * declared indexes key on a database-global physical index name,
 * #129 contributions key on `(graph_id, logical_name, owner,
 * table_name)`. The declared-index path is untouched by #135; a future
 * PR may migrate it onto this contribution model.
 */

import { sql } from "drizzle-orm";

import {
  StoreNotInitializedError,
  type StoreNotInitializedReason,
} from "../../errors";
import { type SqlDialect } from "../../query/dialect";
import { type FulltextStrategy } from "../../query/dialect/fulltext-strategy";
import { sortedReplacer } from "../../schema/canonical";
import { sha256Hex } from "../../utils/hash";
import { isMissingTableError } from "../../utils/sql-errors";
import type { StrategyTableContribution } from "../table-contribution";
import type {
  ContributionMaterializationIdentity,
  ContributionMaterializationRow,
  RecordContributionMaterializationParams,
  TransactionBackend,
} from "../types";
import { findStrategyContribution, runtimeStrategyContributions } from "./ddl";
import { formatPostgresTimestamp, nowIso } from "./row-mappers";

/**
 * Bridges the dialect-specific timestamp column representation to the
 * canonical ISO-8601 strings used by the row/param types. `string` for
 * SQLite TEXT, `Date` for Postgres TIMESTAMPTZ — identical contract to
 * the index-materialization adapter, kept separate so the two status
 * subsystems stay independent.
 */
type ContributionMaterializationTimestampAdapter<TEncoded> = Readonly<{
  /** Convert a stored column value to ISO-8601 (or `undefined`). */
  decode(value: unknown): string | undefined;
  /** Convert an ISO-8601 string to the value Drizzle expects on insert. */
  encode(value: string): TEncoded;
}>;

export const SQLITE_CONTRIBUTION_MAT_TIMESTAMPS: ContributionMaterializationTimestampAdapter<string> =
  {
    decode: (value) => (typeof value === "string" ? value : undefined),
    encode: (value) => value,
  };

export const POSTGRES_CONTRIBUTION_MAT_TIMESTAMPS: ContributionMaterializationTimestampAdapter<Date> =
  {
    decode: formatPostgresTimestamp,
    encode: (value) => new Date(value),
  };

/**
 * Raw shape Drizzle returns for one row of
 * `typegraph_contribution_materializations`. The caller has already
 * narrowed via the typed table query; this just spells out the
 * dialect-shared field set so `mapContributionMaterializationRow` can
 * decode it.
 */
type RawContributionMaterializationRow = Readonly<{
  graphId: string;
  logicalName: string;
  owner: string;
  tableName: string;
  signature: string;
  materializedAt: unknown;
  lastAttemptedAt: unknown;
  lastError: string | null;
}>;

export function mapContributionMaterializationRow(
  row: RawContributionMaterializationRow,
  decode: (value: unknown) => string | undefined,
): ContributionMaterializationRow {
  const lastAttemptedAt = decode(row.lastAttemptedAt);
  if (lastAttemptedAt === undefined) {
    throw new Error(
      `contribution materialization row missing required ` +
        `last_attempted_at: ${row.graphId}/${row.logicalName}`,
    );
  }
  return {
    graphId: row.graphId,
    logicalName: row.logicalName,
    owner: row.owner,
    tableName: row.tableName,
    signature: row.signature,
    materializedAt: decode(row.materializedAt),
    lastAttemptedAt,
    lastError: row.lastError ?? undefined,
  };
}

/**
 * Build the column values for the upsert. Timestamp columns are encoded
 * through the adapter so the dialect's Drizzle column type gets the
 * value-shape it expects.
 */
export function buildContributionInsertValues<TEncoded>(
  params: RecordContributionMaterializationParams,
  encode: (value: string) => TEncoded,
): Readonly<{
  graphId: string;
  logicalName: string;
  owner: string;
  tableName: string;
  signature: string;
  materializedAt: TEncoded | undefined;
  lastAttemptedAt: TEncoded;
  lastError: string | undefined;
}> {
  return {
    graphId: params.graphId,
    logicalName: params.logicalName,
    owner: params.owner,
    tableName: params.tableName,
    signature: params.signature,
    materializedAt:
      params.materializedAt === undefined ?
        undefined
      : encode(params.materializedAt),
    lastAttemptedAt: encode(params.attemptedAt),
    lastError: params.error,
  };
}

/**
 * Build the `set` clause for the upsert's ON CONFLICT DO UPDATE.
 *
 * The identity columns are the conflict target (composite primary key)
 * so they are never in the set clause. `materializedAt` uses `COALESCE`
 * to preserve any prior successful timestamp when this attempt failed
 * (`materializedAt === undefined`); on success the new timestamp wins.
 * Identical preservation rule to `buildMaterializationOnConflictSet`,
 * keeping a stale/failed boot retry from erasing the historical
 * success another replica recorded.
 */
export function buildContributionOnConflictSet(
  materializedAtColumn: unknown,
  paramsMaterializedAt: string | undefined,
): Readonly<Record<string, ReturnType<typeof sql>>> {
  const materializedAtSet =
    paramsMaterializedAt === undefined ?
      sql`COALESCE(excluded.${sql.identifier("materialized_at")}, ${materializedAtColumn})`
    : sql`excluded.${sql.identifier("materialized_at")}`;
  return {
    signature: sql`excluded.${sql.identifier("signature")}`,
    materializedAt: materializedAtSet,
    lastAttemptedAt: sql`excluded.${sql.identifier("last_attempted_at")}`,
    lastError: sql`excluded.${sql.identifier("last_error")}`,
  };
}

/**
 * Canonical hash of a resolved contribution's drift surface:
 * `{ dialect, owner, logicalName, tableName, createDdl }`. #129
 * guarantees `createDdl` is deterministic for a given resolved
 * configuration, so this hash is a meaningful staleness discriminant.
 * A strategy swap (different `owner`) or a DDL change on the same
 * logical slot changes the signature → detectable drift. 32 hex chars
 * because it is compared against an externally-stored signature.
 */
async function computeContributionSignature(
  dialect: SqlDialect,
  identity: Readonly<{
    owner: string;
    logicalName: string;
    tableName: string;
  }>,
  createDdl: readonly string[],
): Promise<string> {
  const hashable = {
    dialect,
    owner: identity.owner,
    logicalName: identity.logicalName,
    tableName: identity.tableName,
    createDdl,
  };
  return sha256Hex(JSON.stringify(hashable, sortedReplacer), 16);
}

/**
 * Whether a contribution is usable on the current connection, derived
 * from its durable marker row and the freshly-computed signature.
 *
 * - `missing`: no row — never initialized.
 * - `failed`: the last recorded attempt errored. Boot may retry; the
 *   hot path must refuse.
 * - `stale`: a row exists but its recorded signature no longer matches
 *   (strategy swap / DDL drift). Refuse rather than silently
 *   re-materialize on a hot path.
 * - `initialized`: signature matches, a successful `materializedAt` is
 *   recorded, and the last attempt did not error.
 */
// The non-initialized states are exactly `StoreNotInitializedError`'s
// reasons — derive the union so the two cannot drift apart and the
// assert can pass the state straight through as the error reason.
type ContributionMaterializationState =
  | "initialized"
  | StoreNotInitializedReason;

function evaluateContributionState(
  row: ContributionMaterializationRow | undefined,
  signature: string,
): ContributionMaterializationState {
  if (row === undefined) return "missing";
  if (row.lastError !== undefined) return "failed";
  if (row.signature !== signature) return "stale";
  if (row.materializedAt === undefined) return "missing";
  return "initialized";
}

function identityOf(
  graphId: string,
  contribution: StrategyTableContribution,
): ContributionMaterializationIdentity {
  return {
    graphId,
    logicalName: contribution.logicalName,
    owner: contribution.owner,
    tableName: contribution.tableName,
  };
}

/**
 * Wrap a transaction-scoped backend so every fulltext-touching method
 * asserts the durable contribution marker before delegating — the
 * point-of-use gate (#135) for the transaction path, mirroring the
 * non-tx wrappers.
 *
 * The tx-scoped backend exposes RAW fulltext methods (no self-ensure);
 * `assert` is the outer backend's cached durable-marker resolver. A
 * transaction that never touches fulltext never asserts, so non-
 * fulltext transactions stay free of any fulltext-init requirement.
 * `assert` performs only a (cached) SELECT — never DDL — so it is safe
 * inside the caller's open transaction (#134).
 *
 * `hardDeleteNode` is gated because the cascade unconditionally deletes
 * from the fulltext table even for graphs with no `searchable()`
 * fields. Empty-input batch calls skip the assert, matching the
 * "a genuine no-op is harmless" contract of the non-tx wrappers.
 */
export function gateFulltext(
  tx: TransactionBackend,
  assert: (graphId: string) => Promise<void>,
): TransactionBackend {
  // Mutable local so each override is only assigned when the raw method
  // exists; the "only wrap when defined" rule stays obvious instead of
  // hiding behind conditional spreads.
  const gated: { -readonly [K in keyof TransactionBackend]: TransactionBackend[K] } =
    { ...tx };

  if (tx.upsertFulltext) {
    const raw = tx.upsertFulltext;
    gated.upsertFulltext = async (params) => {
      await assert(params.graphId);
      await raw(params);
    };
  }
  if (tx.deleteFulltext) {
    const raw = tx.deleteFulltext;
    gated.deleteFulltext = async (params) => {
      await assert(params.graphId);
      await raw(params);
    };
  }
  if (tx.upsertFulltextBatch) {
    const raw = tx.upsertFulltextBatch;
    gated.upsertFulltextBatch = async (params) => {
      // A genuine no-op call asserts nothing, matching the non-tx
      // wrappers' "empty input is harmless" contract.
      if (params.rows.length === 0) return;
      await assert(params.graphId);
      await raw(params);
    };
  }
  if (tx.deleteFulltextBatch) {
    const raw = tx.deleteFulltextBatch;
    gated.deleteFulltextBatch = async (params) => {
      if (params.nodeIds.length === 0) return;
      await assert(params.graphId);
      await raw(params);
    };
  }
  if (tx.fulltextSearch) {
    const raw = tx.fulltextSearch;
    gated.fulltextSearch = async (params) => {
      await assert(params.graphId);
      return raw(params);
    };
  }
  // Unconditional: the hard-delete cascade deletes from the fulltext
  // table even for graphs that declare no `searchable()` fields.
  const rawHardDelete = tx.hardDeleteNode;
  gated.hardDeleteNode = async (params) => {
    await assert(params.graphId);
    await rawHardDelete(params);
  };
  return gated;
}

// ============================================================
// Materializer (#135) — the one place orchestration lives
// ============================================================

/**
 * The dialect-specific seams the materializer needs. Mirrors how the
 * index-materialization subsystem keeps orchestration dialect-agnostic
 * (`store/materialize-indexes.ts`) and leaves only thin primitives in
 * each backend.
 */
export type ContributionMaterializerDeps = Readonly<{
  dialect: SqlDialect;
  fulltextStrategy: FulltextStrategy;
  fulltextTableName: string;
  /** Run one raw DDL statement (dialect's `execute`/`run` of `sql.raw`). */
  execDdl: (statement: string) => Promise<void>;
  /** Idempotently create the `contribution_materializations` table. */
  ensureMarkerTable: () => Promise<void>;
  getMarker: (
    identity: ContributionMaterializationIdentity,
  ) => Promise<ContributionMaterializationRow | undefined>;
  recordMarker: (
    params: RecordContributionMaterializationParams,
  ) => Promise<void>;
}>;

export type ContributionMaterializer = Readonly<{
  /** Materialize one declared contribution by `logicalName` + record it. */
  ensureContribution: (logicalName: string, graphId: string) => Promise<void>;
  /** Canonical durable-marker writer: every `runtimeEnsure` contribution. */
  ensureRuntimeContributions: (graphId: string) => Promise<void>;
  /**
   * Hot-path / transaction gate: resolve the durable markers once per
   * backend instance (cached) and throw `StoreNotInitializedError` on
   * the first missing/stale/failed contribution. Zero DDL, zero writes.
   */
  assertInitialized: (graphId: string) => Promise<void>;
}>;

export function createContributionMaterializer(
  deps: ContributionMaterializerDeps,
): ContributionMaterializer {
  const { dialect, fulltextStrategy, fulltextTableName } = deps;

  // Positive-only cache: a graph id lands here once every runtime
  // contribution's durable marker has been observed materialized for
  // it. Missing/stale/failed verdicts are never cached, so a concurrent
  // boot that fixes the state is picked up on the next call.
  const initializedGraphIds = new Set<string>();

  function runtimeContributions(): readonly StrategyTableContribution[] {
    return runtimeStrategyContributions(fulltextStrategy, fulltextTableName);
  }

  async function materializeOne(
    graphId: string,
    contribution: StrategyTableContribution,
  ): Promise<void> {
    const signature = await computeContributionSignature(
      dialect,
      contribution,
      contribution.createDdl,
    );
    const identity = identityOf(graphId, contribution);
    const existing = await deps.getMarker(identity);
    const priorSuccess = existing?.materializedAt !== undefined;

    // Already materialized at this exact shape — nothing to do.
    if (
      priorSuccess &&
      existing.signature === signature &&
      existing.lastError === undefined
    ) {
      return;
    }

    // Drift after a *recorded success*: the table physically exists with
    // the OLD shape, so the idempotent `CREATE ... IF NOT EXISTS` would
    // no-op and we'd silently bless the new signature against a stale
    // table. Refuse loudly instead — mirrors the index materializer's
    // signature-drift handling. (A row with no prior success, or one
    // whose last attempt errored, falls through and re-runs the DDL.)
    if (priorSuccess && existing.signature !== signature) {
      const error = new Error(
        `Contribution "${contribution.logicalName}" (owner ` +
          `"${contribution.owner}", table "${contribution.tableName}") was ` +
          `already materialized with a different signature. The recorded ` +
          `physical shape is stale relative to the current strategy/DDL — ` +
          `migrate or drop the table and retry, or restore the original ` +
          `strategy.`,
      );
      await deps.recordMarker({
        ...identity,
        signature,
        attemptedAt: nowIso(),
        materializedAt: undefined,
        error: error.message,
      });
      throw error;
    }

    const attemptedAt = nowIso();
    try {
      for (const statement of contribution.createDdl) {
        await deps.execDdl(statement);
      }
    } catch (error) {
      await deps.recordMarker({
        ...identity,
        signature,
        attemptedAt,
        materializedAt: undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    await deps.recordMarker({
      ...identity,
      signature,
      attemptedAt,
      materializedAt: attemptedAt,
      error: undefined,
    });
  }

  async function ensureRuntimeContributions(graphId: string): Promise<void> {
    // Cache guard so a redundant boot call (the warm path materializes
    // via loadActiveSchemaWithBootstrap, then createStoreWithSchema
    // calls again) is a true O(1) no-op rather than a re-SELECT.
    if (initializedGraphIds.has(graphId)) return;
    const contributions = runtimeContributions();
    if (contributions.length > 0) {
      await deps.ensureMarkerTable();
      for (const contribution of contributions) {
        await materializeOne(graphId, contribution);
      }
    }
    initializedGraphIds.add(graphId);
  }

  async function ensureContribution(
    logicalName: string,
    graphId: string,
  ): Promise<void> {
    const declared = findStrategyContribution(
      fulltextStrategy,
      fulltextTableName,
      logicalName,
    );
    await deps.ensureMarkerTable();
    await materializeOne(graphId, declared);
  }

  async function assertInitialized(graphId: string): Promise<void> {
    if (initializedGraphIds.has(graphId)) return;
    for (const contribution of runtimeContributions()) {
      const signature = await computeContributionSignature(
        dialect,
        contribution,
        contribution.createDdl,
      );
      const identity = identityOf(graphId, contribution);
      let existing: ContributionMaterializationRow | undefined;
      try {
        existing = await deps.getMarker(identity);
      } catch (error) {
        // A never-bootstrapped database has no marker table — that is
        // precisely "not initialized". Any other failure (connection,
        // permission, driver) is a real system fault and must surface
        // as-is rather than be masked as a user init error.
        if (!isMissingTableError(error)) throw error;
        throw new StoreNotInitializedError(graphId, "missing", {
          cause: error,
          details: { logicalName: contribution.logicalName },
        });
      }
      const state = evaluateContributionState(existing, signature);
      if (state !== "initialized") {
        throw new StoreNotInitializedError(graphId, state, {
          details: { logicalName: contribution.logicalName },
        });
      }
    }
    initializedGraphIds.add(graphId);
  }

  return { ensureContribution, ensureRuntimeContributions, assertInitialized };
}
