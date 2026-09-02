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
 */
import type { AtomicSqlProgramExecutor } from "../../capabilities/atomic-sql-program";
import type { ContributionMaterializer } from "../contribution-materializations";
import type { createCommonOperationBackend } from "../operation-backend-core";
import { resolveAtomicNodeProjectionRequirements } from "../operations/node-projections";
import type { OperationFusionHooks } from "./profile";

/**
 * The options `createCommonOperationBackend` accepts, recovered through its
 * own signature rather than re-declared here: that type is intentionally
 * module-private in `../operation-backend-core`, and re-declaring its shape
 * by hand is exactly the kind of second copy that drifts.
 */
type CommonOperationOptions = Parameters<typeof createCommonOperationBackend>[0];

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
