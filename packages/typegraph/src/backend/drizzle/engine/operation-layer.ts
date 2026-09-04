/**
 * The shared operation-layer assembly both dialects build their
 * {@link InternalOperationBackend} through.
 *
 * `buildCommonOperationOptions` is the options-object half:
 * `createPostgresOperationBackend` and `createSqliteOperationBackend` (each
 * still dialect-owned) call it to produce the value they pass to
 * `createCommonOperationBackend` (`../operation-backend-core`), rather than
 * each building that object literal inline. Every field either comes
 * straight from a named dependency or is one of the three projection-
 * evidence callbacks below — byte-identical between dialects once
 * `contributionMaterializer` is threaded through as a dependency instead of
 * a closed-over binding.
 *
 * `createEngineOperationBackend` is the literal-assembly half: the object
 * every dialect's `create{Postgres,Sqlite}OperationBackend` returns, minus
 * the two members that genuinely cannot be shared (see its own doc
 * comment).
 */
import type { FulltextStrategy } from "../../../query/dialect/fulltext-strategy";
import type { SqlDialect } from "../../../query/dialect/types";
import type { VectorStrategy } from "../../../query/dialect/vector-strategy";
import type { SqlFragment } from "../../../query/sql-fragment";
import type { AtomicSqlProgramExecutor } from "../../capabilities/atomic-sql-program";
import type { FenceSql } from "../../capabilities/write-fence";
import type {
  BackendCapabilities,
  InsertNodeParams,
  ManagedNodeCreatePlan,
  TransactionBackend,
} from "../../types";
import type { ContributionMaterializer } from "../contribution-materializations";
import type {
  CompiledSqlQuery,
  ExecutableSql,
} from "../execution/types";
import {
  type createCommonOperationBackend,
  type InternalOperationBackend,
} from "../operation-backend-core";
import { resolveAtomicNodeProjectionRequirements } from "../operations/node-projections";
import type { TableExistenceCacheOptions } from "../operations/strategy";
import type { ContributionOperationMembers } from "./members/contribution-members";
import type { FulltextMembers } from "./members/fulltext-members";
import type { VectorMembers } from "./members/vector-members";
import type { EngineTableNames } from "./profile";

/**
 * The options `createCommonOperationBackend` accepts, recovered through its
 * own signature rather than re-declared here: that type is intentionally
 * module-private in `../operation-backend-core`, and re-declaring its shape
 * by hand is exactly the kind of second copy that drifts.
 */
type CommonOperationOptions = Parameters<typeof createCommonOperationBackend>[0];

/**
 * The operation-layer fusion knobs `buildCommonOperationOptions` reads to
 * assemble one `createCommonOperationBackend` options object for either
 * dialect. `atomicProgramsAtTransactionScope` is the one fact both dialects
 * report: whether the atomic SQL program executor is threaded into a
 * transaction-scoped operation backend at all (PostgreSQL always does;
 * SQLite's transaction-scoped backend excludes it — a real capability gap,
 * not drift). Every other member is PostgreSQL-only and optional for that
 * reason: SQLite's dialect factory builds a value with only
 * `atomicProgramsAtTransactionScope` set, and PostgreSQL's builds one with
 * every member present except the three transaction-scope-only keys
 * (`schemaGraphWriteLockNamespace`, `edgeCardinalityInsertFusion`,
 * `nodeClaimInsertFusion`), which its dialect factory itself omits outside a
 * transaction-scoped operation backend. `buildCommonOperationOptions` spreads
 * each optional member into the assembled options only when the dialect
 * supplied it, so the presence-or-absence decision stays where the
 * asymmetry actually lives — in what each dialect factory constructs — and
 * the shared assembly never branches on which dialect it was called for.
 */
type OperationFusionHooks = Readonly<{
  atomicProgramsAtTransactionScope: boolean;
  /** Always `true` when present; a bundled projection-aware backend fuses managed-node projections into its INSERT. */
  nodeProjectionInsertFusion?: true;
  /** Read-only prerequisite gate run before a fused projection statement. */
  beforeNodeProjectionInsert?: (
    params: InsertNodeParams,
    plan: ManagedNodeCreatePlan,
  ) => Promise<void>;
  /** Error-path projection storage classifier; must rethrow or return never. */
  refuseNodeProjectionError?: (
    params: InsertNodeParams,
    plan: ManagedNodeCreatePlan,
    error: unknown,
  ) => Promise<never>;
  /** Present only for a transaction-scoped operation backend. */
  schemaGraphWriteLockNamespace?: string;
  /** Present only for a transaction-scoped operation backend. */
  edgeCardinalityInsertFusion?: true;
  /** Present only for a transaction-scoped operation backend; claim plans require a caller-owned transaction to roll back refusals. */
  nodeClaimInsertFusion?: true;
  tableExistenceCache?: TableExistenceCacheOptions;
}>;

/**
 * What a dialect factory supplies to build its `createCommonOperationBackend`
 * options: every shared argument by name, plus `fusion` for the PostgreSQL-
 * only knobs (see {@link OperationFusionHooks}) and `contributionMaterializer`
 * for the three projection-evidence callbacks this assembly builds itself.
 */
export type CommonOperationOptionsDeps = Readonly<{
  batchConfig: CommonOperationOptions["batchConfig"];
  commandSession: CommonOperationOptions["commandSession"];
  execution: CommonOperationOptions["execution"];
  /** Absent on a connection with no atomic-program support at all. */
  atomicSqlProgramExecutor: AtomicSqlProgramExecutor | undefined;
  nowIso: CommonOperationOptions["nowIso"];
  maxBindParameters: CommonOperationOptions["maxBindParameters"];
  operationStrategy: CommonOperationOptions["operationStrategy"];
  rowMappers: CommonOperationOptions["rowMappers"];
  schemaFenceLockClause: CommonOperationOptions["schemaFenceLockClause"];
  contributionMaterializer: ContributionMaterializer;
  fusion: OperationFusionHooks;
}>;

/**
 * Assembles one `createCommonOperationBackend` options object from named
 * dependencies, identically for either dialect.
 *
 * The `atomicSqlProgramExecutor` spread is the one genuinely load-bearing
 * conditional: `exactOptionalPropertyTypes` gives that option no `|
 * undefined` (unlike every other optional member here), so the key must be
 * absent rather than present-with-undefined whenever the executor does not
 * apply. It does not apply when this is a transaction-scoped operation
 * backend on a dialect whose transaction scope excludes the executor
 * (`!fusion.atomicProgramsAtTransactionScope`) — SQLite today — or when no
 * executor was supplied at all. Every other PostgreSQL-only key
 * (`nodeProjectionInsertFusion`, `beforeNodeProjectionInsert`,
 * `refuseNodeProjectionError`, `schemaGraphWriteLockNamespace`,
 * `edgeCardinalityInsertFusion`, `nodeClaimInsertFusion`,
 * `tableExistenceCache`) is spread the same way — present only when
 * `fusion` supplies it — even though `createCommonOperationBackend`
 * happens to type those as `| undefined`: a dialect factory that never sets
 * one of these fields on `fusion` should never plant an explicit-`undefined`
 * key where today there is no key at all.
 */
export function buildCommonOperationOptions(
  deps: CommonOperationOptionsDeps,
): CommonOperationOptions {
  const { fusion } = deps;
  const transactionScoped = deps.commandSession === "transaction";
  const atomicSqlProgramExecutorExcludedAtScope =
    transactionScoped && !fusion.atomicProgramsAtTransactionScope;

  return {
    batchConfig: deps.batchConfig,
    commandSession: deps.commandSession,
    execution: deps.execution,
    ...(atomicSqlProgramExecutorExcludedAtScope ||
    deps.atomicSqlProgramExecutor === undefined ?
      {}
    : { atomicSqlProgramExecutor: deps.atomicSqlProgramExecutor }),
    nowIso: deps.nowIso,
    maxBindParameters: deps.maxBindParameters,
    operationStrategy: deps.operationStrategy,
    rowMappers: deps.rowMappers,
    schemaFenceLockClause: deps.schemaFenceLockClause,
    async resolveAtomicNodeProjectionEvidence(creates, updates) {
      const requirements = resolveAtomicNodeProjectionRequirements(
        creates,
        updates,
      );
      if (requirements === undefined) return [];
      return deps.contributionMaterializer.resolveNodeProjectionEvidence(
        requirements.graphId,
        requirements,
      );
    },
    async diagnoseAtomicNodeProjectionEvidence(
      creates,
      updates,
    ): Promise<void> {
      const requirements = resolveAtomicNodeProjectionRequirements(
        creates,
        updates,
      );
      if (requirements === undefined) return;
      await deps.contributionMaterializer.diagnoseNodeProjectionEvidence(
        requirements.graphId,
        requirements,
      );
    },
    async refuseAtomicNodeProjectionError(
      creates,
      updates,
      error,
    ): Promise<never> {
      const requirements = resolveAtomicNodeProjectionRequirements(
        creates,
        updates,
      );
      if (requirements === undefined) throw error;
      return deps.contributionMaterializer.refuseUnavailableNodeInsertProjections(
        requirements.graphId,
        requirements,
        error,
      );
    },
    ...(fusion.nodeProjectionInsertFusion === undefined ?
      {}
    : { nodeProjectionInsertFusion: fusion.nodeProjectionInsertFusion }),
    ...(fusion.beforeNodeProjectionInsert === undefined ?
      {}
    : { beforeNodeProjectionInsert: fusion.beforeNodeProjectionInsert }),
    ...(fusion.refuseNodeProjectionError === undefined ?
      {}
    : { refuseNodeProjectionError: fusion.refuseNodeProjectionError }),
    ...(fusion.schemaGraphWriteLockNamespace === undefined ?
      {}
    : {
        schemaGraphWriteLockNamespace: fusion.schemaGraphWriteLockNamespace,
      }),
    ...(fusion.edgeCardinalityInsertFusion === undefined ?
      {}
    : { edgeCardinalityInsertFusion: fusion.edgeCardinalityInsertFusion }),
    ...(fusion.nodeClaimInsertFusion === undefined ?
      {}
    : { nodeClaimInsertFusion: fusion.nodeClaimInsertFusion }),
    ...(fusion.tableExistenceCache === undefined ?
      {}
    : { tableExistenceCache: fusion.tableExistenceCache }),
  };
}

/**
 * What `createEngineOperationBackend` assembles into one
 * {@link InternalOperationBackend} literal, identically for either dialect.
 *
 * Every dependency here is already a finished member group or a single
 * dialect-owned closure — this function does no SQL of its own. The two
 * members it deliberately does NOT assemble are `execute` and `executeRaw`:
 * PostgreSQL's `execute` inspects the statement for an ANN index-scan brand
 * and re-wraps a filtered vector search in transaction-local GUC overrides,
 * and SQLite's `execute` / `executeRaw` both serialize through its queue —
 * neither is a body a shared assembly may pick between, so both stay
 * dialect-owned and arrive here pre-built as `rawSqlMembers`. `hybridSearch`
 * is the other member left out for the same reason (see each dialect
 * factory's own comment on `vectorEmbeddingMethods`): its dialect factory
 * spreads it onto this function's result afterward.
 */
export type CreateEngineOperationBackendDeps = Readonly<{
  /** `createCommonOperationBackend(buildCommonOperationOptions(...))` — built by the dialect factory's own `buildOperations` closure, which owns the execution primitives that options object closes over. */
  commonOperationMembers: ReturnType<typeof createCommonOperationBackend>;
  /** The transaction-scoped contribution stamp; see `./members/contribution-members`. */
  contributionOperationMembers: ContributionOperationMembers;
  /** The embedding CRUD/search/index group; see `./members/vector-members`. */
  vectorMembers: VectorMembers;
  /** The fulltext CRUD/search group; see `./members/fulltext-members`. */
  fulltextMembers: FulltextMembers;
  /** The dialect's raw-SQL escape hatch, built and bound to its own serialization story by the caller. */
  rawSqlMembers: Pick<TransactionBackend, "execute" | "executeRaw">;
  /**
   * The write-fence-holding half of a managed write: PostgreSQL's asserts
   * and holds a `FOR SHARE` row lock (or refuses, per the resolved fence
   * plan); SQLite's re-reads the active version under the writer slot its
   * own transaction framing already holds. Genuinely different bodies, so
   * threaded through as a finished closure rather than assembled here.
   */
  lockSchemaVersionForWrite: NonNullable<
    InternalOperationBackend["lockSchemaVersionForWrite"]
  >;
  /** The dialect's execution adapter's own `compile` — byte-identical wiring on both sides. */
  compile: (query: ExecutableSql) => CompiledSqlQuery;
  capabilities: BackendCapabilities;
  dialect: SqlDialect;
  tableNames: EngineTableNames;
  /** Absent when this backend has no fulltext support (`fulltext: false`). */
  fulltextStrategy: FulltextStrategy | undefined;
  /** Absent when this connection has no vector extension loaded. */
  vectorStrategy?: VectorStrategy;
  /**
   * The profile's declared lock-statement spelling — see
   * `GraphBackend.fenceSql`. Absent on a dialect that serializes writers
   * instead of taking a lock (SQLite).
   */
  fenceSql?: FenceSql | undefined;
}>;

/**
 * Assembles one dialect's {@link InternalOperationBackend} from its already-
 * built member groups and closures — the shared half of what
 * `create{Postgres,Sqlite}OperationBackend` return. See
 * {@link CreateEngineOperationBackendDeps} for what stays out and why.
 */
export function createEngineOperationBackend(
  deps: CreateEngineOperationBackendDeps,
): InternalOperationBackend {
  const {
    commonOperationMembers,
    contributionOperationMembers,
    vectorMembers,
    fulltextMembers,
    rawSqlMembers,
    lockSchemaVersionForWrite,
    compile,
    capabilities,
    dialect,
    tableNames,
    fulltextStrategy,
    vectorStrategy,
    fenceSql,
  } = deps;

  return {
    ...commonOperationMembers,
    ...rawSqlMembers,
    ...vectorMembers,
    ...contributionOperationMembers,

    capabilities,
    dialect,
    tableNames,
    ...(fulltextStrategy === undefined ? {} : { fulltextStrategy }),
    ...(vectorStrategy === undefined ? {} : { vectorStrategy }),
    ...(fenceSql === undefined ? {} : { fenceSql }),

    lockSchemaVersionForWrite,

    ...fulltextMembers,

    compileSql(
      query: SqlFragment,
    ): Readonly<{ sql: string; params: readonly unknown[] }> {
      return compile(query);
    },
  };
}
