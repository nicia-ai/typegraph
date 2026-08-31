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
  ConfigurationError,
  ContributionRebuildUnsupportedError,
  ContributionUnavailableError,
  StoreNotInitializedError,
  type StoreNotInitializedReason,
} from "../../errors";
import {
  buildForeignFulltextGraphProbe,
  buildFulltextGraphDelete,
  type FulltextStrategy,
} from "../../query/dialect/fulltext-strategy";
import { type SqlDialect } from "../../query/dialect/types";
import {
  type VectorSlot,
  type VectorStrategy,
} from "../../query/dialect/vector-strategy";
import { sql as portableSql } from "../../query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../../query/sql-intent";
import { sortedReplacer } from "../../schema/canonical";
import { sha256Hex } from "../../utils/hash";
import { errorChain, isMissingTableError } from "../../utils/sql-errors";
import {
  requireWriteFence,
  resolveWriteFencePlan,
  type WriteFenceTarget,
} from "../capabilities/write-fence";
import { deriveTransactionSessionBackend } from "../derive-backend";
import { formatPostgresTimestamp, nowIso } from "../row-mappers";
import type { StrategyTableContribution } from "../table-contribution";
import {
  type ContributionDiagnostic,
  type ContributionDiagnosticState,
  type ContributionMaterializationIdentity,
  type ContributionMaterializationRow,
  type ContributionProbeContribution,
  type ContributionProbeEntry,
  type ContributionRebuildResult,
  type ContributionRebuildScope,
  type ContributionRepairEntry,
  type ContributionRepairResult,
  type ContributionRepopulationStats,
  type RecordContributionMaterializationParams,
  type SchemaWriteTransactionBackend,
  type TransactionBackend,
} from "../types";
import { runtimeStrategyContributions } from "./ddl";
import type { AtomicContributionEvidence } from "./operations/contribution-evidence";

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
function contributionSignatureInput(
  dialect: SqlDialect,
  identity: Readonly<{
    owner: string;
    logicalName: string;
    tableName: string;
  }>,
  createDdl: readonly string[],
): string {
  const hashable = {
    dialect,
    owner: identity.owner,
    logicalName: identity.logicalName,
    tableName: identity.tableName,
    createDdl,
  };
  return JSON.stringify(hashable, sortedReplacer);
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
type ContributionMaterializationState =
  "initialized" | StoreNotInitializedReason;

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

/**
 * Cross the durable marker verdict with physical-catalog reality and
 * name why the contribution is unusable, or `undefined` when it is fine.
 *
 * With the table ABSENT there are three cases, and only one of them is
 * silence:
 * - a marker recording a prior success is an `orphaned-marker`. Table
 *   absence dominates whatever the marker claims about shape: once the
 *   storage is gone the recorded signature is moot and the repair
 *   (recreate, then re-stamp) is the same either way.
 * - a marker recording a FAILED attempt is `failed-materialization`.
 *   Marker and catalog agree — provisioning was tried and it broke —
 *   but agreement is not health, and staying silent here would hide the
 *   exact state an operator is looking for.
 * - no marker row at all is genuinely silent: nothing has been
 *   attempted, and boot will provision it on the next privileged run.
 *
 * With the table PRESENT, `missing` and same-signature `failed` collapse to
 * `missing-marker`: both mean "storage exists but no marker attests it", and
 * both are repaired by re-running the ensure. A prior success at another
 * signature stays `stale` even when the latest attempt failed, because its
 * repair is a shape change, not a re-stamp.
 */
function diagnoseContribution(
  row: ContributionMaterializationRow | undefined,
  signature: string,
  tableExists: boolean,
): ContributionDiagnosticState | undefined {
  if (!tableExists) {
    if (row === undefined) return undefined;
    if (row.materializedAt !== undefined) return "orphaned-marker";
    return row.lastError === undefined ? undefined : "failed-materialization";
  }
  // A prior success at another signature means the existing table has the old
  // physical shape. That remains `stale` even when a later failed attempt also
  // recorded an error: classifying it as `missing-marker` would invite an
  // idempotent CREATE + marker re-stamp to bless the unchanged stale table.
  if (row?.materializedAt !== undefined && row.signature !== signature) {
    return "stale";
  }
  const state = evaluateContributionState(row, signature);
  switch (state) {
    case "initialized": {
      return undefined;
    }
    case "stale": {
      return "stale";
    }
    case "missing":
    case "failed": {
      return "missing-marker";
    }
    default: {
      return state satisfies never;
    }
  }
}

/**
 * A contribution `verifyContributions` will check, tagged with the
 * vector-slot coordinates that produced it. Both tags are absent for the
 * runtime (fulltext) contributions, which are not per-`(kind, field)`.
 *
 * `projection` records which enumeration loop produced the target rather
 * than being re-derived from the contribution's `logicalName` later. The
 * probe groups by it, and reconstructing the grouping from a name
 * convention would put a second, silently divergent classifier next to
 * the one that actually built the set.
 */
type VerificationTarget = Readonly<{
  contribution: StrategyTableContribution;
  projection: ContributionProbeContribution;
  kind?: string;
  fieldPath?: string;
}>;

type DiagnosedContribution = Readonly<{
  graphId: string;
  contribution: StrategyTableContribution;
  projection: ContributionProbeContribution;
  diagnostic: ContributionDiagnostic;
}>;

/**
 * Order probe entries are reported in. Fixed rather than derived from
 * declaration order so a result is stable enough to assert on and to
 * diff between two probes of the same store.
 */
const PROBE_PROJECTION_ORDER: readonly ContributionProbeContribution[] = [
  "fulltext",
  "vector",
] as const;

/** Why the projection is unusable, in one operator-facing clause. */
const PROBE_DETAIL_PHRASE: Readonly<
  Record<ContributionDiagnosticState, string>
> = {
  "orphaned-marker": "storage is missing",
  "missing-marker": "storage is not attested by a durable marker",
  "failed-materialization": "provisioning failed and produced no storage",
  stale: "storage exists at a different shape than the current declaration",
};

/**
 * Names the affected contribution the way an operator would look for it:
 * a vector slot by its `(kind, field)` coordinates, fulltext by the
 * physical table, since fulltext has exactly one table per graph and its
 * name is what a caller would have dropped or renamed.
 */
function describeProbeDiagnostic(diagnostic: ContributionDiagnostic): string {
  const subject =
    diagnostic.kind === undefined || diagnostic.fieldPath === undefined ?
      `table "${diagnostic.physicalName}"`
    : `${diagnostic.kind}.${diagnostic.fieldPath}`;
  return (
    `${subject}: ${PROBE_DETAIL_PHRASE[diagnostic.state]} ` +
    `(${diagnostic.state})`
  );
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
 * The fulltext-touching methods the durable-marker gate wraps. The five
 * `upsert*`/`delete*`/`fulltextSearch` are optional (a graph with no
 * `searchable()` fields has none); `hardDeleteNode` is always present
 * because its cascade unconditionally deletes from the fulltext table.
 */
export type GatableFulltextBackend = Pick<
  TransactionBackend,
  | "upsertFulltext"
  | "deleteFulltext"
  | "upsertFulltextBatch"
  | "deleteFulltextBatch"
  | "fulltextSearch"
  | "hardDeleteNode"
>;

type RefuseUnavailableFulltext = (
  graphId: string,
  error: unknown,
) => Promise<never>;

function missingTableErrorNames(error: unknown, tableName: string): boolean {
  const quotedTableName = `"${tableName.replaceAll('"', '""')}"`;
  for (const link of errorChain(error)) {
    const message = errorMessage(link);
    if (typeof message !== "string") continue;

    // workerd appends `: SQLITE_ERROR` to SQLite's missing-table message.
    // Keep that diagnostic delimiter out of the physical identifier so the
    // exact-name check below sees the declared table, not `<table>:`.
    const sqliteMatch = /\bno such table:\s*([^\s;:]+)/i.exec(message);
    const sqliteName = unquoteSqliteIdentifier(sqliteMatch?.[1]);
    if (sqliteName === tableName) return true;

    const namesPostgresTable =
      message.includes(`relation ${quotedTableName} does not exist`) ||
      message.includes(`table ${quotedTableName} does not exist`);
    if (namesPostgresTable) return true;
  }
  return false;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return undefined;
  }
  return typeof error.message === "string" ? error.message : undefined;
}

function unquoteSqliteIdentifier(
  identifier: string | undefined,
): string | undefined {
  if (identifier === undefined) return undefined;
  const first = identifier.at(0);
  const last = identifier.at(-1);
  const isQuoted =
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === "`" && last === "`") ||
    (first === "[" && last === "]");
  return isQuoted ? identifier.slice(1, -1) : identifier;
}

async function executeGatedFulltext<T>(
  graphId: string,
  assert: (graphId: string) => Promise<void>,
  refuseUnavailable: RefuseUnavailableFulltext,
  execute: () => Promise<T>,
): Promise<T> {
  await assert(graphId);
  try {
    return await execute();
  } catch (error) {
    return refuseUnavailable(graphId, error);
  }
}

/**
 * The fulltext point-of-use gate, as the wrapped overrides only. Each
 * method asserts the durable contribution marker before delegating; an
 * optional method is wrapped only when present. `assert` performs only
 * a (cached) SELECT — never DDL — so it is safe inside an open
 * transaction. The single source of the gating contract: both the
 * non-tx backend and the tx-scoped {@link gateFulltext} consume it.
 */
export function gateFulltextMethods(
  source: GatableFulltextBackend,
  assert: (graphId: string) => Promise<void>,
  refuseUnavailable: RefuseUnavailableFulltext,
): Partial<GatableFulltextBackend> {
  // Only assign an override when the raw method exists, so the "wrap
  // only what's defined" rule stays obvious instead of hiding behind
  // conditional spreads.
  const gated: {
    -readonly [K in keyof GatableFulltextBackend]?: GatableFulltextBackend[K];
  } = {};

  if (source.upsertFulltext) {
    const raw = source.upsertFulltext;
    gated.upsertFulltext = async (params) => {
      await executeGatedFulltext(
        params.graphId,
        assert,
        refuseUnavailable,
        () => raw(params),
      );
    };
  }
  if (source.deleteFulltext) {
    const raw = source.deleteFulltext;
    gated.deleteFulltext = async (params) => {
      await executeGatedFulltext(
        params.graphId,
        assert,
        refuseUnavailable,
        () => raw(params),
      );
    };
  }
  if (source.upsertFulltextBatch) {
    const raw = source.upsertFulltextBatch;
    gated.upsertFulltextBatch = async (params) => {
      // A genuine no-op call asserts nothing — the "empty input is
      // harmless" contract.
      if (params.rows.length === 0) return;
      await executeGatedFulltext(
        params.graphId,
        assert,
        refuseUnavailable,
        () => raw(params),
      );
    };
  }
  if (source.deleteFulltextBatch) {
    const raw = source.deleteFulltextBatch;
    gated.deleteFulltextBatch = async (params) => {
      if (params.nodeIds.length === 0) return;
      await executeGatedFulltext(
        params.graphId,
        assert,
        refuseUnavailable,
        () => raw(params),
      );
    };
  }
  if (source.fulltextSearch) {
    const raw = source.fulltextSearch;
    gated.fulltextSearch = async (params) => {
      return executeGatedFulltext(
        params.graphId,
        assert,
        refuseUnavailable,
        () => raw(params),
      );
    };
  }
  // Unconditional: the hard-delete cascade deletes from the fulltext
  // table even for graphs that declare no `searchable()` fields.
  const rawHardDelete = source.hardDeleteNode;
  gated.hardDeleteNode = async (params) => {
    await executeGatedFulltext(params.graphId, assert, refuseUnavailable, () =>
      rawHardDelete(params),
    );
  };
  return gated;
}

/**
 * Tx-scoped variant: a {@link TransactionBackend} with its fulltext
 * methods gated. The tx-scoped backend exposes RAW fulltext methods (no
 * self-ensure); a transaction that never touches fulltext never
 * asserts, so non-fulltext transactions stay free of any fulltext-init
 * requirement.
 */
export function gateFulltext(
  tx: TransactionBackend,
  assert: (graphId: string) => Promise<void>,
  refuseUnavailable: RefuseUnavailableFulltext,
): TransactionBackend {
  return deriveTransactionSessionBackend<TransactionBackend>(
    tx,
    gateFulltextMethods(tx, assert, refuseUnavailable),
  );
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
  /**
   * The write-fence target `lockContributionDdl` / `lockSharedFulltextTable`
   * resolve a plan from — a small first-party-marked object rather than the
   * whole backend, so this module needs no more of `GraphBackend` than the
   * lock decision itself.
   */
  fenceTarget: WriteFenceTarget;
  fulltextStrategy: FulltextStrategy;
  fulltextTableName: string;
  /**
   * Active vector strategy, or `undefined` when vector support is
   * disabled. When present, its per-`(kind, field)` `ownedTables(slot)`
   * contributions ride this same durable-marker machinery — boot
   * materializes them under the privileged role, the runtime hot path
   * asserts them with a SELECT (never DDL), exactly like fulltext.
   */
  vectorStrategy: VectorStrategy | undefined;
  /** Run one raw DDL statement (dialect's `execute`/`run` of `sql.raw`). */
  execDdl: (statement: string) => Promise<void>;
  /** Idempotently create the `contribution_materializations` table. */
  ensureMarkerTable: () => Promise<void>;
  /** Read every contribution marker for one graph in a single query. */
  getMarkers: (
    graphId: string,
  ) => Promise<readonly ContributionMaterializationRow[]>;
  recordMarker: (
    params: RecordContributionMaterializationParams,
  ) => Promise<void>;
  /**
   * Delete a marker row by identity. Used when a contribution's physical
   * table is torn down out-of-band (vector-field reclaim) so a later
   * re-provision sees "missing" and re-creates the table rather than
   * trusting an orphaned "initialized" marker.
   */
  deleteMarker: (
    identity: ContributionMaterializationIdentity,
  ) => Promise<void>;
  /**
   * Whether `tableName` exists in the connection's catalog right now.
   * The dialect-specific half of `verifyContributions`; the backend
   * supplies its `buildTableExists` probe. Must NOT be cached across
   * calls — a table confirmed present earlier is exactly the table this
   * diagnostic has to re-check.
   */
  tableExists: (tableName: string) => Promise<boolean>;
  /**
   * Run an administrative callback under the same per-graph fence as a
   * schema commit, with transaction-scoped DDL available. The destructive
   * rebuild's only seam: it makes drop → recreate → refill → stamp one
   * atomic unit, so an interrupted rebuild rolls back to the state it
   * started from instead of leaving storage attested but empty.
   *
   * Absent on a backend with no transactional schema fence, which
   * declines the rebuild rather than running it unfenced.
   */
  schemaWriteTransaction?: <T>(
    graphId: string,
    fn: (tx: SchemaWriteTransactionBackend) => Promise<T>,
  ) => Promise<T>;
}>;

export type ContributionMaterializer = Readonly<{
  /** Canonical durable-marker writer: every `runtimeEnsure` contribution. */
  ensureRuntimeContributions: (graphId: string) => Promise<void>;
  /**
   * Hot-path / transaction gate: resolve the durable markers once per
   * backend instance (cached) and throw `StoreNotInitializedError` on
   * the first missing/stale/failed contribution. Zero DDL, zero writes.
   */
  assertInitialized: (graphId: string) => Promise<void>;
  /**
   * Error-path classification for a gated fulltext operation. Translates only
   * a missing-relation failure that names the declared fulltext table; every
   * other failure is rethrown unchanged.
   */
  refuseUnavailableFulltext: RefuseUnavailableFulltext;
  /** Classifies missing storage named by a fused node projection statement. */
  refuseUnavailableNodeInsertProjections: (
    graphId: string,
    projections: Readonly<{
      fulltext: boolean;
      vectorSlots: readonly VectorSlot[];
    }>,
    error: unknown,
  ) => Promise<never>;
  /**
   * Privileged materializer for one vector slot's `ownedTables`
   * contribution(s): creates the per-`(kind, field)` table and records
   * its durable marker, idempotently. Pass `{ force: true }` to bypass
   * the drift-guard and overwrite the marker at the current signature —
   * the sanctioned path for `reembedVectorField`'s deliberate
   * dimension change. Pass `{ onDrift: "skip" }` to leave a drifted slot
   * untouched (warn, no marker write, no throw) instead of refusing —
   * the boot/evolve path, where the declared shape may have moved ahead
   * of a `reembedVectorField` the operator has not run yet. No-op when
   * vector support is disabled.
   */
  ensureVectorSlot: (
    slot: VectorSlot,
    options?: Readonly<{ force?: boolean; onDrift?: "throw" | "skip" }>,
  ) => Promise<void>;
  /** Batch form used by boot to share marker reads across every vector slot. */
  ensureVectorSlots: (
    slots: readonly VectorSlot[],
    options?: Readonly<{ force?: boolean; onDrift?: "throw" | "skip" }>,
  ) => Promise<void>;
  /**
   * Hot-path gate for one vector slot: SELECT-only marker assert over
   * the slot's `ownedTables` contribution(s), cached per backend
   * instance. Throws `StoreNotInitializedError` when the slot is
   * missing/stale/failed. No-op when vector support is disabled.
   */
  assertVectorSlot: (slot: VectorSlot) => Promise<void>;
  /** Batch form used by verified attach to perform one marker read. */
  assertVectorSlots: (slots: readonly VectorSlot[]) => Promise<void>;
  /**
   * One marker gate for every projection a fused node insert will write.
   * Fulltext and all vector slots share the same marker read on a cold cache.
   */
  assertNodeInsertProjections: (
    graphId: string,
    projections: Readonly<{
      fulltext: boolean;
      vectorSlots: readonly VectorSlot[];
    }>,
  ) => Promise<void>;
  /**
   * Resolves the exact marker rows an atomic projection program must prove.
   * This computes only strategy signatures; it performs no database read.
   */
  resolveNodeProjectionEvidence: (
    graphId: string,
    projections: Readonly<{
      fulltext: boolean;
      vectorSlots: readonly VectorSlot[];
    }>,
  ) => Promise<readonly AtomicContributionEvidence[]>;
  /**
   * Failure-only read-through diagnosis after an in-program marker assertion
   * refused. The program's database evidence supersedes any process cache.
   */
  diagnoseNodeProjectionEvidence: (
    graphId: string,
    projections: Readonly<{
      fulltext: boolean;
      vectorSlots: readonly VectorSlot[];
    }>,
  ) => Promise<void>;
  /**
   * Forget a vector slot: delete its `ownedTables` contribution
   * marker(s) and evict the per-instance cache. Called after the slot's
   * physical table is dropped (vector-field reclaim) so a future
   * `ensureVectorSlot` re-creates the table instead of trusting an
   * orphaned marker. No-op when vector support is disabled.
   */
  dropVectorSlot: (slot: VectorSlot) => Promise<void>;
  /** Conservatively evict one slot from the process-local marker cache. */
  evictVectorSlot: (slot: VectorSlot) => void;
  /**
   * Diagnostic: cross each currently declared runtime contribution and each
   * supplied vector slot's `ownedTables` contribution against its durable
   * marker and the physical catalog. This includes a recorded failed
   * materialization even when marker and catalog agree that no table exists.
   * Contributions with neither marker nor table and marker rows outside this
   * declaration set are omitted. Read-only: no DDL, no marker writes, and no
   * effect on the per-instance caches the hot path relies on.
   */
  verifyContributions: (
    graphId: string,
    vectorSlots: readonly VectorSlot[],
  ) => Promise<readonly ContributionDiagnostic[]>;
  /**
   * Privileged repair pass over declarations resolved inside this
   * materializer. Only non-destructive states are repaired automatically.
   */
  repairContributions: (
    graphId: string,
    vectorSlots: readonly VectorSlot[],
  ) => Promise<ContributionRepairResult>;
  /**
   * Read-only readiness projection over the same audit
   * `verifyContributions` runs, one entry per search projection.
   */
  probeContributions: (
    graphId: string,
    vectorSlots: readonly VectorSlot[],
  ) => Promise<readonly ContributionProbeEntry[]>;
  /**
   * Destructive rebuild of one projection's storage: drop, recreate from
   * the current `createDdl`, refill through `repopulate`, stamp the
   * marker. Atomic under the backend's schema fence. Refuses rather than
   * destroying anything it cannot reconstruct.
   */
  rebuildContribution: (
    graphId: string,
    scope: ContributionRebuildScope,
    repopulate: (
      target: TransactionBackend,
    ) => Promise<ContributionRepopulationStats>,
  ) => Promise<ContributionRebuildResult>;
}>;

/**
 * Whether a fulltext rebuild can be served, given the active strategy and
 * whether the backend has a transactional schema fence to run it under.
 *
 * Exported so `capabilities.contributions.rebuild` and the runtime
 * refusal inside `rebuildContribution` are two readings of one predicate
 * rather than two predicates that have to be kept in step. A backend
 * whose advertised capability disagrees with what the call actually does
 * is worse than one that declines.
 */
export function contributionRebuildSupported(
  fulltextStrategy: FulltextStrategy,
  fulltextTableName: string,
  transactional: boolean,
): boolean {
  return (
    transactional &&
    runtimeStrategyContributions(fulltextStrategy, fulltextTableName).every(
      (contribution) => contribution.dropDdl !== undefined,
    )
  );
}

/**
 * Advisory-lock key serializing contribution DDL across every graph in one
 * database. See `lockContributionDdl`.
 */
const CONTRIBUTION_DDL_LOCK_KEY = "typegraph:contribution-ddl";

/**
 * How many other graph ids a refusal names. The probe only has to decide
 * whether the set is empty; the ids are there so an operator knows which
 * deployments share the table, and a full list of them would be unbounded.
 */
const FOREIGN_GRAPH_REPORT_LIMIT = 5;

// NUL separator for the per-instance contribution cache key: collision-safe
// across arbitrary graph ids / names (a printable delimiter could appear in a
// caller-supplied graph id).
const CONTRIBUTION_KEY_SEPARATOR = String.fromCodePoint(0);

function contributionKey(
  graphId: string,
  contribution: Readonly<{
    owner: string;
    logicalName: string;
    tableName: string;
  }>,
): string {
  return [
    graphId,
    contribution.owner,
    contribution.logicalName,
    contribution.tableName,
  ].join(CONTRIBUTION_KEY_SEPARATOR);
}

export function createContributionMaterializer(
  deps: ContributionMaterializerDeps,
): ContributionMaterializer {
  const { dialect, fulltextStrategy, fulltextTableName } = deps;

  // Positive-only cache keyed per contribution identity
  // (`graphId | owner | logicalName | tableName`), holding the SIGNATURE the
  // marker was last observed materialized at on this connection. A cache hit
  // requires the freshly-computed signature to match the cached one, so a
  // changed shape (dimension, metric, storage DDL) on the same instance
  // misses the cache and falls through to the drift-guard / stale verdict —
  // the warm cache can never bless a contribution whose shape moved.
  // Per-contribution (not per-graph) so each per-`(kind, field)` vector slot
  // caches independently and the hot-path assert stays a small DDL-string
  // comparison plus `Map.get` after the first SELECT. Missing/stale/failed
  // verdicts are never cached, so a concurrent boot that fixes the state is
  // picked up on the next call.
  const initializedSignatures = new Map<string, string>();
  // A vector slot evicted during transactional cleanup cannot safely become a
  // positive cache hit again on this materializer: another request may read
  // the old marker before the cleanup commits, then finish after commit. Keep
  // evicted keys permanently read-through for this backend instance so such a
  // stale snapshot can never repopulate the positive cache. Re-added slots are
  // rare; their gates pay one marker SELECT instead of risking a silent pass.
  const uncacheableKeys = new Set<string>();
  // Computing the durable signature requires WebCrypto. Keep the canonical
  // DDL beside its digest so the hot path only compares the current DDL
  // strings. A same-instance shape change produces a mismatch and therefore
  // a fresh canonical input + digest; unchanged contributions reuse the
  // settled promise without serialization or new crypto work. The cache key
  // already covers every non-DDL signature field (owner/logical/table), while
  // dialect is fixed for the lifetime of this materializer.
  const computedSignatures = new Map<
    string,
    Readonly<{ createDdl: readonly string[]; signature: Promise<string> }>
  >();

  async function resolveContributionSignature(
    key: string,
    contribution: StrategyTableContribution,
  ): Promise<string> {
    const cached = computedSignatures.get(key);
    const cachedCreateDdl = cached?.createDdl;
    const cachedSignature = cached?.signature;
    if (
      cachedCreateDdl?.length === contribution.createDdl.length &&
      cachedSignature !== undefined &&
      contribution.createDdl.every(
        (statement, index) => cachedCreateDdl[index] === statement,
      )
    ) {
      return cachedSignature;
    }

    const input = contributionSignatureInput(
      dialect,
      contribution,
      contribution.createDdl,
    );
    const entry = {
      createDdl: [...contribution.createDdl],
      signature: sha256Hex(input, 16),
    } as const;
    computedSignatures.set(key, entry);
    try {
      return await entry.signature;
    } catch (error) {
      if (computedSignatures.get(key) === entry) {
        computedSignatures.delete(key);
      }
      throw error;
    }
  }

  function runtimeContributions(): readonly StrategyTableContribution[] {
    return runtimeStrategyContributions(fulltextStrategy, fulltextTableName);
  }

  function cacheInitializedSignature(key: string, signature: string): void {
    if (!uncacheableKeys.has(key)) {
      initializedSignatures.set(key, signature);
    }
  }

  async function materializeOne(
    graphId: string,
    contribution: StrategyTableContribution,
    signature: string,
    existing: ContributionMaterializationRow | undefined,
    options?: Readonly<{ force?: boolean; onDrift?: "throw" | "skip" }>,
  ): Promise<"materialized" | "drift-skipped"> {
    const force = options?.force === true;
    const identity = identityOf(graphId, contribution);

    // Already materialized at this exact shape — nothing to do. `force`
    // re-runs the DDL and re-stamps the marker even on a match: the path
    // `reembedVectorField` relies on after it has recreated the table.
    if (
      !force &&
      evaluateContributionState(existing, signature) === "initialized"
    ) {
      return "materialized";
    }
    const priorSuccess = existing?.materializedAt !== undefined;

    // Drift after a *recorded success*: the table physically exists with
    // the OLD shape, so the idempotent `CREATE ... IF NOT EXISTS` would
    // no-op and we'd silently bless the new signature against a stale
    // table. Refuse loudly instead — mirrors the index materializer's
    // signature-drift handling. (A row with no prior success, or one
    // whose last attempt errored, falls through and re-runs the DDL.)
    // `force` deliberately bypasses this — the caller has already dropped
    // and recreated the table at the new shape (`reembedVectorField`).
    if (!force && priorSuccess && existing.signature !== signature) {
      // `onDrift: "skip"` (boot/evolve): leave the slot exactly as it is —
      // marker untouched (so old-shape reads keep their verdict), nothing
      // cached, no throw. Writes to the new shape fail as `stale` until
      // `store.reembedVectorField` recreates storage and force-restamps.
      if (options?.onDrift === "skip") {
        console.warn(
          `[typegraph] contribution "${contribution.logicalName}" (table ` +
            `"${contribution.tableName}") is provisioned at a different ` +
            `shape than the current declaration — left untouched. Writes ` +
            `to it will fail until store.reembedVectorField(kind, ` +
            `fieldPath) recreates the storage at the new shape.`,
        );
        return "drift-skipped";
      }
      const error = new Error(
        `Contribution "${contribution.logicalName}" (owner ` +
          `"${contribution.owner}", table "${contribution.tableName}") was ` +
          `already materialized with a different signature. The recorded ` +
          `physical shape is stale relative to the current strategy/DDL — ` +
          `migrate or drop the table and retry, or restore the original ` +
          `strategy.`,
      );
      // Record the failed attempt but keep the RECORDED signature: it is
      // the only evidence of the shape the table actually has. Stamping
      // the shape we just refused to provision would leave a row matching
      // the current declaration with `last_error` set, which
      // `diagnoseContribution` reads as `missing-marker` — pointing the
      // operator at the idempotent re-stamp repair that blesses the
      // unchanged old-shape table, and letting the next attempt skip this
      // guard. Staying `stale` points at `store.rebuildContribution()`.
      await deps.recordMarker({
        ...identity,
        signature: existing.signature,
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
    return "materialized";
  }

  function indexMarkerRows(
    graphId: string,
    rows: readonly ContributionMaterializationRow[],
  ): ReadonlyMap<string, ContributionMaterializationRow> {
    return new Map(
      rows.map((row) => [contributionKey(graphId, row), row] as const),
    );
  }

  /**
   * Read every marker for a graph in one round trip. A missing marker table
   * is its own verdict so boot can create it while hot-path asserts translate
   * it to `StoreNotInitializedError`. All other database faults propagate.
   */
  async function readMarkerRows(graphId: string): Promise<
    | Readonly<{
        kind: "rows";
        rows: ReadonlyMap<string, ContributionMaterializationRow>;
      }>
    | Readonly<{ kind: "missing-table"; error: unknown }>
  > {
    try {
      return {
        kind: "rows",
        rows: indexMarkerRows(graphId, await deps.getMarkers(graphId)),
      };
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      return { kind: "missing-table", error };
    }
  }

  /**
   * Privileged materialize over an arbitrary contribution set. Per
   * contribution: skip if cached at the current signature; else (unless
   * `force`) a read-only
   * pre-check short-circuits the whole pending set when every marker is
   * already initialized at its current signature, so a warm graph stays
   * DDL-free — the marker `CREATE TABLE IF NOT EXISTS` itself would fail
   * on a connection that can't run DDL (#149). Otherwise ensure the
   * marker table and `materializeOne` each pending contribution. `force`
   * re-runs the DDL and re-stamps the marker unconditionally (drift-guard
   * bypassed) — the `reembedVectorField` recreate path.
   */
  async function ensureContributions(
    graphId: string,
    contributions: readonly StrategyTableContribution[],
    options?: Readonly<{
      force?: boolean;
      onDrift?: "throw" | "skip";
      bypassCache?: boolean;
    }>,
  ): Promise<void> {
    const force = options?.force === true;
    const bypassCache = options?.bypassCache === true;
    const entries = await Promise.all(
      contributions.map(async (contribution) => {
        const key = contributionKey(graphId, contribution);
        return {
          contribution,
          key,
          signature: await resolveContributionSignature(key, contribution),
        };
      }),
    );
    if (bypassCache) {
      // Repair is invoked precisely when durable state may have changed behind
      // this materializer's positive cache. Keep every touched key read-through
      // from now on: deleting only the current entry would still let an assert
      // that started before the repair repopulate stale success after a failed
      // repair recorded the contribution as unusable.
      for (const entry of entries) {
        uncacheableKeys.add(entry.key);
        initializedSignatures.delete(entry.key);
      }
    }
    // A cache hit requires the signature to match — a contribution whose
    // shape changed on this instance falls through to the drift-guard.
    const pending =
      force || bypassCache ? entries : (
        entries.filter(
          (entry) =>
            uncacheableKeys.has(entry.key) ||
            initializedSignatures.get(entry.key) !== entry.signature,
        )
      );
    if (pending.length === 0) return;

    const initialRead = force ? undefined : await readMarkerRows(graphId);
    if (
      !force &&
      initialRead?.kind === "rows" &&
      pending.every(
        (entry) =>
          evaluateContributionState(
            initialRead.rows.get(entry.key),
            entry.signature,
          ) === "initialized",
      )
    ) {
      for (const entry of pending) {
        cacheInitializedSignature(entry.key, entry.signature);
      }
      return;
    }

    await deps.ensureMarkerTable();
    // Preserve the original race check after marker-table bootstrap, but
    // refresh every pending contribution in one query rather than one query
    // per slot.
    const existingRows = indexMarkerRows(
      graphId,
      await deps.getMarkers(graphId),
    );
    for (const entry of pending) {
      const outcome = await materializeOne(
        graphId,
        entry.contribution,
        entry.signature,
        existingRows.get(entry.key),
        {
          force,
          ...(options?.onDrift === undefined ?
            {}
          : { onDrift: options.onDrift }),
        },
      );
      // A drift-skipped contribution is deliberately NOT cached: nothing
      // was materialized at this signature, and asserts must keep reading
      // it as stale until reembedVectorField restamps it.
      if (outcome === "materialized") {
        cacheInitializedSignature(entry.key, entry.signature);
      }
    }
  }

  /**
   * SELECT-only gate over an arbitrary contribution set: throws
   * `StoreNotInitializedError` on the first missing/stale/failed
   * contribution (or a never-bootstrapped marker table). Caches each
   * confirmed-initialized contribution BY SIGNATURE so the steady state is a
   * crypto-free DDL-string comparison + `Map.get`. A shape change on the same
   * instance computes a fresh signature, misses the initialized cache, and
   * surfaces as `stale`. Never runs DDL or writes.
   */
  async function assertContributions(
    graphId: string,
    contributions: readonly StrategyTableContribution[],
    options?: Readonly<{ bypassCache?: boolean }>,
  ): Promise<void> {
    const entries = await Promise.all(
      contributions.map(async (contribution) => {
        const key = contributionKey(graphId, contribution);
        return {
          contribution,
          key,
          signature: await resolveContributionSignature(key, contribution),
        };
      }),
    );
    const pending =
      options?.bypassCache === true ?
        entries
      : entries.filter(
          (entry) =>
            uncacheableKeys.has(entry.key) ||
            initializedSignatures.get(entry.key) !== entry.signature,
        );
    if (pending.length === 0) return;

    const read = await readMarkerRows(graphId);
    if (read.kind === "missing-table") {
      const first = pending[0];
      if (first === undefined) return;
      throw new StoreNotInitializedError(graphId, "missing", {
        cause: read.error,
        details: { logicalName: first.contribution.logicalName },
      });
    }

    for (const entry of pending) {
      const { contribution, key, signature } = entry;
      const state = evaluateContributionState(read.rows.get(key), signature);
      if (state !== "initialized") {
        throw new StoreNotInitializedError(graphId, state, {
          details: { logicalName: contribution.logicalName },
        });
      }
      cacheInitializedSignature(key, signature);
    }
  }

  async function ensureRuntimeContributions(graphId: string): Promise<void> {
    await ensureContributions(graphId, runtimeContributions());
  }

  async function assertInitialized(graphId: string): Promise<void> {
    await assertContributions(graphId, runtimeContributions());
  }

  async function refuseUnavailableFulltext(
    graphId: string,
    error: unknown,
  ): Promise<never> {
    await Promise.resolve();
    if (!isMissingTableError(error)) throw error;

    // A failed transaction cannot run the uncached catalog audit on every
    // backend (Postgres marks it aborted; PGlite shares that one session).
    // The failed statement still names the missing physical table. That is
    // transaction-safe proof that the declared physical storage is
    // missing and avoids any healthy-path query. It does not prove the marker
    // still exists because the preceding assertion may have hit its cache.
    const missingContribution = runtimeContributions().find(
      (contribution) =>
        contribution.logicalName === "fulltext" &&
        missingTableErrorNames(error, contribution.tableName),
    );
    if (missingContribution !== undefined) {
      throw new ContributionUnavailableError(
        graphId,
        missingContribution.tableName,
        { cause: error },
      );
    }
    throw error;
  }

  async function refuseUnavailableNodeInsertProjections(
    graphId: string,
    projections: Readonly<{
      fulltext: boolean;
      vectorSlots: readonly VectorSlot[];
    }>,
    error: unknown,
  ): Promise<never> {
    await Promise.resolve();
    if (!isMissingTableError(error)) throw error;
    const vectorContributions =
      groupVectorContributions(projections.vectorSlots).get(graphId) ?? [];
    const missingContribution = [
      ...(projections.fulltext ? runtimeContributions() : []),
      ...vectorContributions,
    ].find((contribution) =>
      missingTableErrorNames(error, contribution.tableName),
    );
    if (missingContribution !== undefined) {
      throw new ContributionUnavailableError(
        graphId,
        missingContribution.tableName,
        { cause: error },
      );
    }
    throw error;
  }

  async function ensureVectorSlot(
    slot: VectorSlot,
    options?: Readonly<{ force?: boolean; onDrift?: "throw" | "skip" }>,
  ): Promise<void> {
    await ensureVectorSlots([slot], options);
  }

  async function assertVectorSlot(slot: VectorSlot): Promise<void> {
    await assertVectorSlots([slot]);
  }

  function groupVectorContributions(
    slots: readonly VectorSlot[],
  ): ReadonlyMap<string, readonly StrategyTableContribution[]> {
    const grouped = new Map<string, readonly StrategyTableContribution[]>();
    if (deps.vectorStrategy === undefined) return grouped;
    for (const slot of slots) {
      grouped.set(slot.graphId, [
        ...(grouped.get(slot.graphId) ?? []),
        ...deps.vectorStrategy.ownedTables(slot),
      ]);
    }
    return grouped;
  }

  async function ensureVectorSlots(
    slots: readonly VectorSlot[],
    options?: Readonly<{ force?: boolean; onDrift?: "throw" | "skip" }>,
  ): Promise<void> {
    for (const [graphId, contributions] of groupVectorContributions(slots)) {
      await ensureContributions(graphId, contributions, options);
    }
  }

  async function assertVectorSlots(
    slots: readonly VectorSlot[],
  ): Promise<void> {
    for (const [graphId, contributions] of groupVectorContributions(slots)) {
      await assertContributions(graphId, contributions);
    }
  }

  async function assertNodeInsertProjections(
    graphId: string,
    projections: Readonly<{
      fulltext: boolean;
      vectorSlots: readonly VectorSlot[];
    }>,
  ): Promise<void> {
    await assertContributions(
      graphId,
      nodeProjectionContributions(graphId, projections),
    );
  }

  function nodeProjectionContributions(
    graphId: string,
    projections: Readonly<{
      fulltext: boolean;
      vectorSlots: readonly VectorSlot[];
    }>,
  ): readonly StrategyTableContribution[] {
    const vectorContributions =
      groupVectorContributions(projections.vectorSlots).get(graphId) ?? [];
    const contributions = [
      ...(projections.fulltext ? runtimeContributions() : []),
      ...vectorContributions,
    ];
    return [
      ...new Map(
        contributions.map((contribution) => [
          contributionKey(graphId, contribution),
          contribution,
        ]),
      ).values(),
    ];
  }

  async function resolveNodeProjectionEvidence(
    graphId: string,
    projections: Readonly<{
      fulltext: boolean;
      vectorSlots: readonly VectorSlot[];
    }>,
  ): Promise<readonly AtomicContributionEvidence[]> {
    return Promise.all(
      nodeProjectionContributions(graphId, projections).map(
        async (contribution) => {
          const key = contributionKey(graphId, contribution);
          return {
            ...identityOf(graphId, contribution),
            signature: await resolveContributionSignature(key, contribution),
          };
        },
      ),
    );
  }

  async function diagnoseNodeProjectionEvidence(
    graphId: string,
    projections: Readonly<{
      fulltext: boolean;
      vectorSlots: readonly VectorSlot[];
    }>,
  ): Promise<void> {
    const contributions = nodeProjectionContributions(
      graphId,
      projections,
    );
    for (const contribution of contributions) {
      const key = contributionKey(graphId, contribution);
      initializedSignatures.delete(key);
    }
    try {
      await assertContributions(graphId, contributions, { bypassCache: true });
    } catch (error) {
      // The atomic statement and committed read both proved the marker
      // unusable. Keep the key read-through so an assertion already in flight
      // cannot restore a stale positive after this diagnosis completes.
      for (const contribution of contributions) {
        uncacheableKeys.add(contributionKey(graphId, contribution));
      }
      throw error;
    }
  }

  function verificationTargetsByGraph(
    graphId: string,
    vectorSlots: readonly VectorSlot[],
  ): ReadonlyMap<string, readonly VerificationTarget[]> {
    const targets = new Map<string, VerificationTarget[]>();
    function addTarget(id: string, target: VerificationTarget): void {
      const existing = targets.get(id);
      if (existing === undefined) targets.set(id, [target]);
      else existing.push(target);
    }

    for (const contribution of runtimeContributions()) {
      addTarget(graphId, { contribution, projection: "fulltext" });
    }
    const { vectorStrategy } = deps;
    if (vectorStrategy !== undefined) {
      for (const slot of vectorSlots) {
        for (const contribution of vectorStrategy.ownedTables(slot)) {
          addTarget(slot.graphId, {
            contribution,
            projection: "vector",
            kind: slot.nodeKind,
            fieldPath: slot.fieldPath,
          });
        }
      }
    }
    return targets;
  }

  /**
   * The single detection pass every rung of the health ladder consults.
   * Takes the resolved target map rather than re-enumerating, so the
   * probe can group by the same declaration set this diagnosed — a second
   * enumeration would be free to disagree with the one that produced the
   * verdicts.
   */
  async function diagnoseTargets(
    targetsByGraph: ReadonlyMap<string, readonly VerificationTarget[]>,
  ): Promise<readonly DiagnosedContribution[]> {
    // One probe per distinct physical table, scoped to THIS call: a
    // strategy may own several contributions over one table, and paying a
    // round trip per contribution would be waste. Deliberately not the
    // backend's long-lived `createCachedTableExistence` — a cache that
    // outlived the call would answer from the very state this diagnostic
    // exists to re-check.
    const probes = new Map<string, Promise<boolean>>();
    function tableExists(tableName: string): Promise<boolean> {
      const pending = probes.get(tableName);
      if (pending !== undefined) return pending;
      const probe = deps.tableExists(tableName);
      probes.set(tableName, probe);
      return probe;
    }

    const diagnosed: DiagnosedContribution[] = [];
    for (const [id, targets] of targetsByGraph) {
      // A never-bootstrapped marker table means no contribution is marked,
      // which the per-target verdict already models as an empty row set.
      const read = await readMarkerRows(id);
      const rows =
        read.kind === "rows" ?
          read.rows
        : new Map<string, ContributionMaterializationRow>();
      for (const { contribution, projection, kind, fieldPath } of targets) {
        const key = contributionKey(id, contribution);
        const row = rows.get(key);
        const state = diagnoseContribution(
          row,
          await resolveContributionSignature(key, contribution),
          await tableExists(contribution.tableName),
        );
        if (state === undefined) continue;
        diagnosed.push({
          graphId: id,
          contribution,
          projection,
          diagnostic: {
            owner: contribution.owner,
            logicalName: contribution.logicalName,
            physicalName: contribution.tableName,
            ...(kind === undefined ? {} : { kind }),
            ...(fieldPath === undefined ? {} : { fieldPath }),
            state,
            // The recorded reason, carried through verbatim. `state` folds
            // several marker verdicts together because they share a repair;
            // this is what keeps the fold from also discarding the one thing
            // the catalog can never tell the operator.
            ...(row?.lastError === undefined ?
              {}
            : { lastError: row.lastError }),
          },
        });
      }
    }
    return diagnosed;
  }

  /**
   * Vector slots carry their own graph id, exactly as `ensureVectorSlots`
   * reads them, so the marker read stays one query per distinct graph.
   */
  async function diagnoseContributions(
    graphId: string,
    vectorSlots: readonly VectorSlot[],
  ): Promise<readonly DiagnosedContribution[]> {
    return diagnoseTargets(verificationTargetsByGraph(graphId, vectorSlots));
  }

  async function verifyContributions(
    graphId: string,
    vectorSlots: readonly VectorSlot[],
  ): Promise<readonly ContributionDiagnostic[]> {
    const diagnosed = await diagnoseContributions(graphId, vectorSlots);
    return diagnosed.map((entry) => entry.diagnostic);
  }

  async function probeContributions(
    graphId: string,
    vectorSlots: readonly VectorSlot[],
  ): Promise<readonly ContributionProbeEntry[]> {
    // One target enumeration shared with the diagnosis: a projection is
    // reported only when this graph actually declares contributions for
    // it, so an empty result reads as "nothing to assess" and never as
    // "assessed and healthy".
    const targetsByGraph = verificationTargetsByGraph(graphId, vectorSlots);
    const declared = new Set<ContributionProbeContribution>();
    for (const targets of targetsByGraph.values()) {
      for (const target of targets) declared.add(target.projection);
    }

    const diagnosed = await diagnoseTargets(targetsByGraph);
    const entries: ContributionProbeEntry[] = [];
    for (const projection of PROBE_PROJECTION_ORDER) {
      if (!declared.has(projection)) continue;
      const problems = diagnosed.filter(
        (entry) => entry.projection === projection,
      );
      if (problems.length === 0) {
        entries.push({ contribution: projection, state: "ready" });
        continue;
      }
      entries.push({
        contribution: projection,
        state: "degraded",
        detail: problems
          .map((entry) => describeProbeDiagnostic(entry.diagnostic))
          .join("; "),
      });
    }
    return entries;
  }

  async function repairContributions(
    graphId: string,
    vectorSlots: readonly VectorSlot[],
  ): Promise<ContributionRepairResult> {
    const diagnosed = await diagnoseContributions(graphId, vectorSlots);
    const results: ContributionRepairEntry[] = [];
    for (const {
      graphId: targetGraphId,
      contribution,
      diagnostic,
    } of diagnosed) {
      if (
        diagnostic.state === "stale" ||
        diagnostic.state === "orphaned-marker"
      ) {
        results.push({ diagnostic, status: "requires-rebuild" });
        continue;
      }

      try {
        // A repair must bypass the positive process-local cache because the
        // marker may have been removed or failed after this backend cached a
        // healthy signature. This is intentionally NOT `force`: the normal
        // drift guard must still refuse to re-stamp stale physical storage.
        await ensureContributions(targetGraphId, [contribution], {
          bypassCache: true,
        });
        results.push({ diagnostic, status: "repaired" });
      } catch (error) {
        results.push({
          diagnostic,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      results,
      remaining: await verifyContributions(graphId, vectorSlots),
    };
  }

  /**
   * The DATABASE-scoped critical section for the contribution ITSELF —
   * the logical slot, not the relation currently backing it.
   *
   * The schema-write fence is per GRAPH, but the fulltext table is one
   * physical table shared by every graph in the database, so two graphs
   * rebuilding at once are not serialized by that fence at all: they would
   * race the drop, the recreate, and each other's reading of "does another
   * graph still have rows here?". One constant-keyed transaction-scoped
   * advisory lock removes the race instead of recovering from it.
   *
   * It is NOT interchangeable with the relation lock
   * {@link lockSharedFulltextTable} takes, and neither replaces the other:
   *
   * - A relation lock cannot be taken when the relation does not exist, and
   *   "the table is missing" is one of the states a rebuild resolves. Two
   *   rebuilds racing that state have no relation to serialize on.
   * - A relation lock dies with its relation. The recreate path DROPs the
   *   table and CREATEs a new one with a new oid, so a second rebuild
   *   waiting on the old relation is released onto an object that no longer
   *   exists. An advisory key survives the drop because it names the
   *   contribution, not the object.
   *
   * ORDER: taken FIRST, before any relation lock, on every path that takes
   * both — and inside the per-graph schema fence, matching the identity DDL
   * lock's convention (per-graph fence → constant-keyed DDL lock → relation
   * locks). Nothing else in the system takes this key at all: ordinary
   * fulltext DML takes only relation-level locks and never an advisory one,
   * so no path can hold a fulltext relation lock while waiting for this key,
   * and the wait graph stays acyclic. Keyed distinctly from
   * `typegraph:identity-ddl`, in the two-argument lock space every
   * namespaced TypeGraph lock uses — the per-graph fence deliberately
   * occupies the one-argument space.
   *
   * SQLite needs nothing: `BEGIN IMMEDIATE` already holds the database's
   * single writer slot for the whole fence.
   */
  async function lockContributionDdl(
    tx: SchemaWriteTransactionBackend,
  ): Promise<void> {
    const plan = resolveWriteFencePlan(deps.fenceTarget);
    const fence = requireWriteFence(plan, "contribution DDL", "advisory-lock");
    switch (fence.kind) {
      case "lock": {
        await tx.execute(
          asCompiledRowsSql(
            portableSql`SELECT pg_advisory_xact_lock(hashtext(${CONTRIBUTION_DDL_LOCK_KEY}), 0)`,
          ),
        );
        return;
      }
      case "engine-serialized": {
        // SQLite needs nothing: `BEGIN IMMEDIATE` already holds the
        // database's single writer slot for the whole fence.
        return;
      }
      default: {
        fence satisfies never;
      }
    }
  }

  /**
   * Excludes every writer from the shared fulltext table for the rest of the
   * rebuild's transaction.
   *
   * The teardown VERDICT — "no other graph has rows here, so dropping this
   * table destroys nothing" — is only as good as the exclusion it was
   * computed under. Ordinary fulltext DML takes no advisory lock, so the
   * contribution lock above excludes other REBUILDS and nothing else: a
   * neighbouring graph's INSERT could commit between an unlocked probe and
   * the `DROP TABLE`, and be destroyed by a rebuild that had already decided
   * it was alone. `ACCESS EXCLUSIVE` is the lock scope that matches the
   * decision's resource — a writer that committed first is visible to the
   * re-probe (each statement takes a fresh snapshot; the fence sets no
   * isolation level, so it runs at the session default of READ COMMITTED),
   * and one that has not committed blocks until this rebuild does.
   *
   * Taken only on the path that may drop, and only after the contribution
   * advisory lock. The graph-scoped path needs nothing: its
   * `DELETE ... WHERE graph_id` touches only rows this graph owns and is
   * transactional, so it must not make every other graph's writers wait.
   *
   * Same shape as `lockPostgresTrustedImportTables`. SQLite has no relation
   * lock and needs none: `BEGIN IMMEDIATE` took the database's single writer
   * slot when the fence opened, so probe, drop and refill already run with
   * every other writer excluded.
   */
  async function lockSharedFulltextTable(
    tx: SchemaWriteTransactionBackend,
    tableName: string,
  ): Promise<void> {
    const plan = resolveWriteFencePlan(deps.fenceTarget);
    const fence = requireWriteFence(
      plan,
      "shared fulltext table lock",
      "table-lock",
    );
    switch (fence.kind) {
      case "lock": {
        await tx.executeStatement(
          asCompiledStatementSql(
            portableSql`LOCK TABLE ${portableSql.identifier(tableName)} IN ACCESS EXCLUSIVE MODE`,
          ),
        );
        return;
      }
      case "engine-serialized": {
        // SQLite has no relation lock and needs none: `BEGIN IMMEDIATE` took
        // the database's single writer slot when the fence opened, so probe,
        // drop and refill already run with every other writer excluded.
        return;
      }
      default: {
        fence satisfies never;
      }
    }
  }

  /**
   * Graph ids other than `graphId` with rows in the shared fulltext table.
   * Read inside the rebuild's transaction so the verdict cannot change
   * between the check and the teardown it authorizes.
   */
  async function readForeignGraphIds(
    tx: SchemaWriteTransactionBackend,
    tableName: string,
    graphId: string,
  ): Promise<readonly string[]> {
    const rows = await tx.execute<Readonly<{ graph_id: unknown }>>(
      asCompiledRowsSql(
        buildForeignFulltextGraphProbe(
          tableName,
          graphId,
          FOREIGN_GRAPH_REPORT_LIMIT,
        ),
      ),
    );
    return rows.map((row) => String(row.graph_id));
  }

  async function rebuildContribution(
    graphId: string,
    scope: ContributionRebuildScope,
    repopulate: (
      target: TransactionBackend,
    ) => Promise<ContributionRepopulationStats>,
  ): Promise<ContributionRebuildResult> {
    // Refuse before anything is dropped. Every precondition is checked
    // here rather than inside the fence so a refusal can never be
    // confused with a half-finished rebuild.
    if (scope === "vector") {
      throw new ContributionRebuildUnsupportedError(
        "vector-source-unavailable",
        { graphId, contribution: scope },
      );
    }
    const contributions = runtimeContributions();
    const withoutTeardown = contributions.find(
      (contribution) => contribution.dropDdl === undefined,
    );
    if (withoutTeardown !== undefined) {
      throw new ContributionRebuildUnsupportedError("no-drop-ddl", {
        graphId,
        contribution: scope,
        owner: withoutTeardown.owner,
        logicalName: withoutTeardown.logicalName,
        physicalName: withoutTeardown.tableName,
      });
    }
    const fence = deps.schemaWriteTransaction;
    if (fence === undefined) {
      throw new ContributionRebuildUnsupportedError("no-schema-fence", {
        graphId,
        contribution: scope,
        backend: dialect,
      });
    }

    // Hashing is async WebCrypto and independent of the fence, so the
    // signatures the stamps will carry are resolved before the schema
    // lock is taken rather than while it is held.
    const stamps = await Promise.all(
      contributions.map(async (contribution) => {
        const key = contributionKey(graphId, contribution);
        return {
          contribution,
          key,
          signature: await resolveContributionSignature(key, contribution),
        };
      }),
    );
    // The stamp below writes to the marker table; a database that has
    // never bootstrapped it would fail after the drop had already run.
    await deps.ensureMarkerTable();

    // This graph's durable markers, and whether the shared storage is on
    // disk at all. Both are read before the fence — the marker read decides
    // whether a rebuild that may not recreate the storage owes a refusal,
    // and a catalog probe cannot run inside the fence against a table that
    // may not exist without aborting the transaction on PostgreSQL.
    const markers = indexMarkerRows(graphId, await deps.getMarkers(graphId));
    const sharedTable = deps.fulltextTableName;
    const sharedTableExisted = await deps.tableExists(sharedTable);

    const rebuilt = await fence(graphId, async (tx) => {
      const record = tx.recordContributionMaterialization;
      if (record === undefined) {
        throw new ConfigurationError(
          "rebuildContribution requires a transaction-scoped backend that " +
            "can write contribution markers; without it the drop, recreate, " +
            "and stamp could not commit together.",
          {
            backend: dialect,
            capability: "contributions",
            operation: "rebuild",
          },
        );
      }

      // Database-scoped, because what follows may be database-global DDL
      // that the per-graph fence does not serialize at all.
      await lockContributionDdl(tx);

      // The decision this whole path turns on: `dropDdl` is a `DROP TABLE`
      // on ONE physical table that holds every graph's fulltext rows, so
      // running it under a per-graph fence would destroy content belonging
      // to graphs this process cannot even name — let alone rebuild, since
      // fulltext content is reconstructed from a graph's own nodes through
      // its own schema. The teardown is therefore graph-scoped by default
      // and only escalates to the drop when the drop takes nothing with it.
      //
      // Storage that was already absent is never dropped either: there is
      // nothing to tear down, and a table that appeared between the
      // pre-fence catalog probe and this lock would belong to whoever
      // created it. Recreating from `createDdl` and clearing this graph's
      // rows serves that state without betting on the probe.
      const unlockedForeignGraphIds =
        sharedTableExisted ?
          await readForeignGraphIds(tx, sharedTable, graphId)
        : [];
      // Two probes, deliberately. The first is unlocked and cheap, and its
      // only job is to keep the common case off the relation lock: a
      // "another graph has rows" verdict can only become MORE true while
      // this transaction runs, since nothing here deletes another graph's
      // rows, so acting on it without exclusion is safe. The drop verdict
      // is the unsafe direction — a writer committing after an unlocked
      // probe would be destroyed by the drop that probe authorized — so it
      // is never acted on until it has been re-established while holding
      // ACCESS EXCLUSIVE. A verdict that flips under the lock loses the
      // drop and keeps the lock, because PostgreSQL holds locks until
      // commit: that rebuild then serializes fulltext writers for its
      // duration, which is the rare and safe direction to be wrong in.
      const mayRecreate =
        sharedTableExisted && unlockedForeignGraphIds.length === 0;
      if (mayRecreate) await lockSharedFulltextTable(tx, sharedTable);
      const foreignGraphIds =
        mayRecreate ?
          await readForeignGraphIds(tx, sharedTable, graphId)
        : unlockedForeignGraphIds;
      const recreateStorage = mayRecreate && foreignGraphIds.length === 0;

      if (!recreateStorage) {
        // `stale` means the physical table is at a shape the current
        // declaration no longer produces, and the only repair for that is
        // the drop this rebuild just declined to run. Deleting this graph's
        // rows and re-stamping instead would publish the current signature
        // over a shape nothing verified — precisely the blessing the drift
        // guard exists to prevent. Refuse, before any DDL runs.
        const staleStamp = stamps.find(
          ({ key, signature }) =>
            diagnoseContribution(
              markers.get(key),
              signature,
              sharedTableExisted,
            ) === "stale",
        );
        if (staleStamp !== undefined) {
          throw new ContributionRebuildUnsupportedError(
            "shared-storage-in-use",
            {
              graphId,
              contribution: scope,
              owner: staleStamp.contribution.owner,
              logicalName: staleStamp.contribution.logicalName,
              physicalName: staleStamp.contribution.tableName,
              otherGraphIds: foreignGraphIds,
            },
          );
        }
      }

      for (const { contribution } of stamps) {
        if (recreateStorage) {
          // `dropDdl` is present on every entry — the refusal above
          // rejected the whole rebuild otherwise.
          for (const statement of contribution.dropDdl ?? []) {
            await tx.executeSchemaDdl(statement);
          }
        }
        for (const statement of contribution.createDdl) {
          await tx.executeSchemaDdl(statement);
        }
      }

      // Graph-scoped teardown when the storage was kept: the same
      // `DELETE ... WHERE graph_id` `clearGraph` owns, so the rebuild
      // removes exactly this graph's index content and nothing else. Only
      // the table the fulltext rows are keyed by `graph_id` in can be
      // scoped this way; a strategy that owns further tables keeps them
      // (they are recreated, never dropped, on this path).
      if (!recreateStorage) {
        await tx.executeStatement(
          asCompiledStatementSql(
            buildFulltextGraphDelete(sharedTable, graphId),
          ),
        );
      }

      // Refill before stamping, inside the same transaction. The order is
      // not cosmetic: a stamp that committed ahead of the content would
      // publish storage the hot-path gate considers healthy and that
      // answers every query with nothing.
      const stats = await repopulate(tx);

      const now = nowIso();
      for (const { contribution, signature } of stamps) {
        await record({
          ...identityOf(graphId, contribution),
          signature,
          attemptedAt: now,
          materializedAt: now,
          error: undefined,
        });
      }
      return {
        rebuilt: stamps.map(({ contribution }) => contribution.tableName),
        processed: stats.processed,
        repopulated: stats.repopulated,
        skipped: stats.skipped,
      } satisfies ContributionRebuildResult;
    });

    // Only after the fence commits: a positive cache entry written for a
    // rebuild that rolled back would bless a shape that is not on disk.
    for (const { key, signature } of stamps) {
      cacheInitializedSignature(key, signature);
    }
    return rebuilt;
  }

  function evictVectorSlot(slot: VectorSlot): void {
    if (deps.vectorStrategy === undefined) return;
    for (const contribution of deps.vectorStrategy.ownedTables(slot)) {
      const key = contributionKey(slot.graphId, contribution);
      uncacheableKeys.add(key);
      initializedSignatures.delete(key);
      computedSignatures.delete(key);
    }
  }

  async function dropVectorSlot(slot: VectorSlot): Promise<void> {
    if (deps.vectorStrategy === undefined) return;
    try {
      for (const contribution of deps.vectorStrategy.ownedTables(slot)) {
        await deps.deleteMarker(identityOf(slot.graphId, contribution));
      }
    } finally {
      // Cache eviction is conservative even when marker deletion fails: a
      // subsequent assertion re-reads durable state instead of trusting a
      // positive entry for a marker that may already have been deleted.
      evictVectorSlot(slot);
    }
  }

  return {
    ensureRuntimeContributions,
    assertInitialized,
    refuseUnavailableFulltext,
    refuseUnavailableNodeInsertProjections,
    ensureVectorSlot,
    ensureVectorSlots,
    assertVectorSlot,
    assertVectorSlots,
    assertNodeInsertProjections,
    resolveNodeProjectionEvidence,
    diagnoseNodeProjectionEvidence,
    dropVectorSlot,
    evictVectorSlot,
    verifyContributions,
    repairContributions,
    probeContributions,
    rebuildContribution,
  };
}
