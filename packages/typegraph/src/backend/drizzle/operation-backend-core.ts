import { is, type SQL, sql as drizzleSql } from "drizzle-orm";

import {
  CompilerInvariantError,
  ConfigurationError,
  DatabaseOperationError,
  EdgeMatchIdentityConflictError,
  MigrationError,
  SchemaContentConflictError,
  StaleVersionError,
  UniquenessError,
} from "../../errors";
import type { SqlDialect } from "../../query/dialect/types";
import type { VectorSlot } from "../../query/dialect/vector-strategy";
import { sql } from "../../query/sql-fragment";
import type {
  CompiledStatementSql,
  CompiledTemporaryStatementSql,
} from "../../query/sql-intent";
import { asCompiledStatementSql } from "../../query/sql-intent";
import { type ClaimOwner, isSameClaimOwner } from "../../store/claims/axis";
import {
  type ConstrainedCardinality,
  edgeCardinalityClaimTarget,
  edgeClaimRelationMissing,
} from "../../store/claims/edge-claims";
import { chunk as chunkArray } from "../../utils/array";
import { requireDefined } from "../../utils/presence";
import {
  isDuplicatePrimaryKeyError,
  isDuplicateUniqueIndexError,
  isEdgeMatchIdentityStorageUnavailableError,
  isMissingTableError,
  isNotNullColumnViolation,
  type PrimaryKeyRelation,
} from "../../utils/sql-errors";
import { encodeTupleKey } from "../../utils/tuple-key";
import {
  AtomicEdgeBatchCardinalityRefusalError,
  type AtomicEdgeBatchCountInput,
  AtomicEdgeBatchEndpointRefusalError,
  type AtomicEdgeBatchExecutor,
  type AtomicEdgeBatchRowsInput,
} from "../capabilities/atomic-edge-batch";
import type {
  AtomicNodeBatchEntry,
  AtomicNodeBatchExecutor,
  AtomicNodeBatchInput,
} from "../capabilities/atomic-node-batch";
import type {
  AtomicSqlProgram,
  AtomicSqlProgramExecutor,
} from "../capabilities/atomic-sql-program";
import { rephaseNonTransactionalNodeClaimPlan } from "../capabilities/node-insert-projections";
import {
  assertGraphCommandConvergenceIsolation,
  assertGraphCommandCoordination,
  assertGraphCommandExecutionContext,
  type GraphCommandExecutionContext,
  normalizeGraphCommandIsolation,
} from "../command-contract";
import {
  resolveEdgeEndpointIds,
  resolveHeterogeneousEdgeRead,
} from "../edge-endpoint-sets";
import { nowIso as defaultNowIso } from "../row-mappers";
import { countSchemaKindRows } from "../schema-kind-emptiness";
import type {
  CheckUniqueBatchParams,
  CheckUniqueParams,
  ClaimEdgeCardinalityParams,
  CommitSchemaVersionIfKindsEmptyResult,
  CommitSchemaVersionParams,
  ConstraintFenceViolationRows,
  ContendedEdgeRow,
  CountEdgesByKindParams,
  CountEdgesFromParams,
  CountNodesByKindParams,
  DeleteEdgeParams,
  DeleteEdgesBatchParams,
  DeleteNodeParams,
  DeleteUniqueParams,
  DisjointOverlapRow,
  DurableEdgeBatchMembers,
  EdgeClaimOutcome,
  EdgeConvergeCreateCommand,
  EdgeConvergeCreateCommandResult,
  EdgeCreateCommandResult,
  EdgeExistsBetweenParams,
  EdgeRow,
  FindEdgesByEndpointSetParams,
  FindEdgesByHeterogeneousEndpointSetParams,
  FindEdgesByKindParams,
  FindEdgesConnectedToParams,
  FindNodesByKindParams,
  GraphBackend,
  GraphCommand,
  GraphCommandResult,
  GraphCommandSession,
  HardDeleteEdgeParams,
  HardDeleteNodeParams,
  HardDeleteUniquesByConcreteKindParams,
  HardDeleteUniquesByNodeIdsParams,
  InsertEdgeParams,
  InsertNodeParams,
  InsertUniqueParams,
  ManagedEdgeCreatePlan,
  ManagedNodeCreatePlan,
  NodeCreateCommandResult,
  NodeRow,
  PopulatedSchemaKind,
  PurgeEdgeClaimsParams,
  ReadConstraintFenceViolationsParams,
  SchemaKindEmptinessProbe,
  SchemaVersionRow,
  SchemaWriteFenceParams,
  SetActiveVersionParams,
  TransactionBackend,
  UniqueRow,
  UpdateEdgeParams,
  UpdateNodeParams,
  UpdateNodeSetParams,
  UpdateNodeSetResult,
} from "../types";
import { edgeMatchIdentityUniqueIndexName } from "./ddl";
import { type CompiledSqlQuery, type ExecutableSql } from "./execution/types";
import {
  type CommonOperationStrategy,
  createCachedTableExistence,
  type TableExistenceCacheOptions,
} from "./operations/strategy";

// The set-based claim acquisition is the widest sidecar statement: five row
// values, both endpoint probes, and the competing-holder predicate. `unique`
// is the widest cardinality because that predicate binds both destination
// fields as well as the source fields. Chunk every cardinality to that ceiling
// so a mixed batch cannot cross the driver's per-statement bind budget.
const ATOMIC_EDGE_CLAIM_PARAM_COUNT = 18;

function assertMatchingFusedEdgeClaim(
  params: InsertEdgeParams,
  claim: ClaimEdgeCardinalityParams,
): void {
  const matchesEdge =
    claim.graphId === params.graphId &&
    claim.edgeId === params.id &&
    claim.edgeKind === params.kind &&
    claim.fromKind === params.fromKind &&
    claim.fromId === params.fromId &&
    claim.toKind === params.toKind &&
    claim.toId === params.toId;
  if (matchesEdge) return;

  throw new CompilerInvariantError(
    "A fused edge cardinality claim must describe the edge being inserted.",
    {
      edge: {
        graphId: params.graphId,
        id: params.id,
        kind: params.kind,
        fromKind: params.fromKind,
        fromId: params.fromId,
        toKind: params.toKind,
        toId: params.toId,
      },
      claim: {
        graphId: claim.graphId,
        edgeId: claim.edgeId,
        edgeKind: claim.edgeKind,
        fromKind: claim.fromKind,
        fromId: claim.fromId,
        toKind: claim.toKind,
        toId: claim.toId,
      },
    },
  );
}

function assertMatchingNodeSchemaFence(
  params: InsertNodeParams,
  schemaFence: SchemaWriteFenceParams,
): void {
  if (schemaFence.graphId === params.graphId) return;

  throw new CompilerInvariantError(
    "A node schema fence must match its node graph.",
    {
      nodeGraphId: params.graphId,
      fenceGraphId: schemaFence.graphId,
      id: params.id,
    },
  );
}

function assertMatchingNodeSchemaFences(
  params: readonly InsertNodeParams[],
  schemaFence: SchemaWriteFenceParams,
): void {
  for (const nodeParams of params) {
    assertMatchingNodeSchemaFence(nodeParams, schemaFence);
  }
}

function assertMatchingEdgeSchemaFence(
  params: InsertEdgeParams,
  schemaFence: SchemaWriteFenceParams,
): void {
  if (schemaFence.graphId === params.graphId) return;

  throw new CompilerInvariantError(
    "An edge schema fence must match its edge graph.",
    {
      edgeGraphId: params.graphId,
      fenceGraphId: schemaFence.graphId,
      id: params.id,
    },
  );
}

function assertMatchingEdgeSchemaFences(
  params: readonly InsertEdgeParams[],
  schemaFence: SchemaWriteFenceParams,
): void {
  for (const edgeParams of params) {
    assertMatchingEdgeSchemaFence(edgeParams, schemaFence);
  }
}

/**
 * The owner a claim write proposes. Reading it off the params in one place is
 * what keeps the accept/refuse test comparing the same pair the SQL arms do.
 */
function claimOwnerOf(params: InsertUniqueParams): ClaimOwner {
  return { concreteKind: params.concreteKind, nodeId: params.nodeId };
}

/**
 * The internal operation backend — what `createCommonOperationBackend`
 * returns. Includes `commitSchemaVersion` and `setActiveVersion` so the
 * top-level backend wrappers can call them on a fresh tx-scoped
 * operation backend (created inside the dialect-specific
 * write-locking transaction). These methods are deliberately NOT on
 * the public `TransactionBackend` type — see the comment there.
 */
export type CommonOperationBackend = Pick<
  TransactionBackend,
  | "checkUnique"
  | "checkUniqueBatch"
  | "clearGraph"
  | "countEdgesByKind"
  | "countEdgesFrom"
  | "countNodesByKind"
  | "deleteEdge"
  | "deleteEdgesBatch"
  | "deleteNode"
  | "deleteUnique"
  | "edgeExistsBetween"
  | "executeTemporaryStatement"
  | "findEdgesByKind"
  | "findEdgesByEndpointSet"
  | "findEdgesByHeterogeneousEndpointSet"
  | "findEdgesConnectedTo"
  | "findNodesByKind"
  | "getActiveSchema"
  | "getEdge"
  | "getEdges"
  | "getNode"
  | "getNodes"
  | "getSchemaVersion"
  | "hardDeleteEdge"
  | "hardDeleteEdgesBatch"
  | "hardDeleteNode"
  | "claimEdgeCardinality"
  | "claimEdgeCardinalityGuarded"
  | "claimEdgeCardinalityBatch"
  | "hardDeleteUniquesByConcreteKind"
  | "hardDeleteUniquesByNodeIds"
  | "insertEdge"
  | "commands"
  | "insertEdgeNoReturn"
  | "insertEdgesBatch"
  | "insertEdgesBatchReturning"
  | "insertNode"
  | "insertNodeIfAbsent"
  | "insertNodeIfAbsentWithSchemaFence"
  | "insertNodeWithSchemaFence"
  | "lockSchemaVersionAndGraphWrite"
  | "insertNodeNoReturn"
  | "insertNodesBatch"
  | "insertNodesBatchReturning"
  | "insertUnique"
  | "insertUniqueBatch"
  | "purgeEdgeClaims"
  | "updateEdge"
  | "updateNode"
  | "updateNodeSet"
> &
  Readonly<{
    executeAtomicNodeBatch?: AtomicNodeBatchExecutor;
    executeAtomicEdgeBatch?: AtomicEdgeBatchExecutor;
    /**
     * The read-only fence audit. Not a `TransactionBackend` member — it is a
     * diagnostic the store runs at the top-level backend, and nothing inside a
     * write transaction reads it — so it is declared here rather than picked.
     */
    readConstraintFenceViolations: NonNullable<
      GraphBackend["readConstraintFenceViolations"]
    >;
    executeStatement: NonNullable<TransactionBackend["executeStatement"]>;
    commitSchemaVersion: (
      params: CommitSchemaVersionParams,
    ) => Promise<SchemaVersionRow>;
    setActiveVersion: (params: SetActiveVersionParams) => Promise<void>;
    executeSchemaDdl: (ddl: string) => Promise<void>;
    tableExists: (tableName: string) => Promise<boolean>;
  }> &
  DurableEdgeBatchMembers;

/**
 * The full internal shape the dialect operation-backend factories
 * build: a {@link TransactionBackend} that also exposes the schema-write
 * methods ({@link CommonOperationBackend}). Internal callers holding the
 * dialect's write-lock (`runSchemaWriteTransaction`) use it directly;
 * the public `transaction()` / `adoptTransaction()` boundary narrows it
 * to `TransactionBackend` so user callbacks can't reach
 * `commitSchemaVersion` / `setActiveVersion` and bypass the lock.
 */
export type InternalOperationBackend = TransactionBackend &
  CommonOperationBackend &
  Readonly<{
    deleteSchemaVectorSlotContribution: (slot: VectorSlot) => Promise<void>;
  }>;

const DRIZZLE_DIALECT_LABELS = {
  postgres: "Postgres",
  sqlite: "SQLite",
} as const satisfies Record<SqlDialect, string>;

/**
 * Assert an externally-supplied transaction handle is the expected
 * Drizzle dialect, narrowing it for `adoptTransaction`. A wrong-dialect
 * handle would otherwise surface as an opaque driver error mid-
 * transaction; this fails it loudly at the boundary instead.
 */
export function assertAdoptedDialect<T>(
  externalTx: unknown,
  brand: Parameters<typeof is>[1],
  backend: SqlDialect,
): asserts externalTx is T {
  if (is(externalTx, brand)) return;
  const label = DRIZZLE_DIALECT_LABELS[backend];
  throw new ConfigurationError(
    `adoptTransaction received a handle that is not a ${label} Drizzle ` +
      `transaction. Pass the \`tx\` from a ${label} ` +
      `\`db.transaction(...)\` opened on this backend's connection.`,
    { backend, capability: "adoptTransaction" },
  );
}

type OperationBackendExecution = Readonly<{
  compile: (query: ExecutableSql) => CompiledSqlQuery;
  execAll: <TRow>(query: ExecutableSql) => Promise<readonly TRow[]>;
  execGet: <TRow>(query: ExecutableSql) => Promise<TRow | undefined>;
  execRun: (query: ExecutableSql) => Promise<void>;
}>;

type OperationBackendBatchConfig = Readonly<{
  checkUniqueBatchChunkSize: number;
  edgeInsertBatchSize: number;
  edgeSchemaFencedInsertBatchSize: number;
  findEdgesEndpointChunkSize: number;
  getEdgesChunkSize: number;
  getNodesChunkSize: number;
  nodeInsertBatchSize: number;
  nodeSchemaFencedInsertBatchSize: number;
  uniqueDeleteChunkSize: number;
  uniqueInsertBatchSize: number;
}>;

type OperationBackendRowMappers = Readonly<{
  toEdgeRow: (row: Record<string, unknown>) => EdgeRow;
  toNodeRow: (row: Record<string, unknown>) => NodeRow;
  toSchemaVersionRow: (row: Record<string, unknown>) => SchemaVersionRow;
  toUniqueRow: (row: Record<string, unknown>) => UniqueRow;
}>;

type CreateCommonOperationBackendOptions = Readonly<{
  atomicSqlProgramExecutor?: AtomicSqlProgramExecutor;
  batchConfig: OperationBackendBatchConfig;
  commandSession: GraphCommandSession;
  execution: OperationBackendExecution;
  maxBindParameters: number;
  nowIso?: (() => string) | undefined;
  operationStrategy: CommonOperationStrategy;
  rowMappers: OperationBackendRowMappers;
  /** Present only on bundled dialect backends that own the fused SQL contract. */
  schemaFenceLockClause?: SQL | undefined;
  /** Present only for a bundled PostgreSQL transaction-scoped backend. */
  schemaGraphWriteLockNamespace?: string | undefined;
  /** Present only for a bundled PostgreSQL transaction-scoped backend. */
  edgeCardinalityInsertFusion?: boolean | undefined;
  /** Present only for bundled projection-aware operation backends. */
  nodeProjectionInsertFusion?: boolean | undefined;
  /** Claim plans require a caller-owned transaction to roll back refusals. */
  nodeClaimInsertFusion?: boolean | undefined;
  /** Read-only prerequisite gate run before a fused projection statement. */
  beforeNodeProjectionInsert?:
    | ((params: InsertNodeParams, plan: ManagedNodeCreatePlan) => Promise<void>)
    | undefined;
  /** Error-path projection storage classifier; must rethrow or return never. */
  refuseNodeProjectionError?:
    | ((
        params: InsertNodeParams,
        plan: ManagedNodeCreatePlan,
        error: unknown,
      ) => Promise<never>)
    | undefined;
  tableExistenceCache?: TableExistenceCacheOptions | undefined;
}>;

/**
 * The entity refs a duplicate-key classification reports back. Nodes carry a
 * kind of their own; an edge's `kind` is its edge kind, which the insert params
 * also carry.
 */
type AttemptedInsert = Readonly<{ kind: string; id: string }>;
type AttemptedEdgeMatchIdentity = Readonly<{
  id: string;
  identityName: string;
  kind: string;
}>;

function duplicateKeyOperationError(
  entity: "node" | "edge",
  attempted: readonly AttemptedInsert[],
  cause: unknown,
): DatabaseOperationError {
  return new DatabaseOperationError(
    `Insert ${entity} failed: a row with this identity already exists`,
    {
      operation: "insert",
      entity,
      reason: "duplicate_key",
      attempted,
    },
    { cause },
  );
}

/**
 * Runs an insert and converts a PRIMARY KEY duplicate-key refusal into a
 * classified {@link DatabaseOperationError} carrying the rows it attempted.
 *
 * The translation stops here rather than reaching for the store's "already
 * exists" error because that is a store-level judgement: the backend's job is to
 * say *what the engine refused and why* in terms callers can branch on, instead
 * of letting a `DrizzleQueryError` whose `.message` is the raw INSERT text
 * escape as the operation's outcome (issue #410). The create paths translate it
 * onward; every other caller sees a system error, exactly as before.
 *
 * Any other failure — including a 23505 from a declared `unique: true` index on
 * the same relation — propagates untouched.
 */
async function withDuplicateKeyClassification<T>(
  run: () => Promise<T>,
  context: Readonly<{
    entity: "node" | "edge";
    relation: PrimaryKeyRelation;
    attempted: readonly AttemptedInsert[];
    matchIdentities?: readonly AttemptedEdgeMatchIdentity[] | undefined;
  }>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isDuplicatePrimaryKeyError(error, context.relation)) {
      throw duplicateKeyOperationError(
        context.entity,
        context.attempted,
        error,
      );
    }
    if (
      context.matchIdentities !== undefined &&
      isDuplicateUniqueIndexError(error, {
        table: context.relation.table,
        indexName: edgeMatchIdentityUniqueIndexName(context.relation.table),
        sqliteColumns: [
          "graph_id",
          "kind",
          "match_identity_name",
          "match_identity_key",
        ],
      })
    ) {
      throw new EdgeMatchIdentityConflictError(
        { attempted: context.matchIdentities },
        { cause: error },
      );
    }
    throw error;
  }
}

async function withAtomicEdgeEndpointRefusalClassification<T>(
  run: () => Promise<T>,
  constraint: Readonly<{ table: string; column: string }>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isNotNullColumnViolation(error, constraint)) {
      throw new AtomicEdgeBatchEndpointRefusalError(error);
    }
    throw error;
  }
}

async function withAtomicEdgeCardinalityRefusalClassification<T>(
  run: () => Promise<T>,
  constraint: Readonly<{ table: string; column: string }>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isNotNullColumnViolation(error, constraint)) {
      throw new AtomicEdgeBatchCardinalityRefusalError(error);
    }
    throw error;
  }
}

async function withAtomicEdgeDurableRefusalClassification<T>(
  run: () => Promise<T>,
  relation: PrimaryKeyRelation,
  constraint: Readonly<{ table: string; column: string }>,
  attempted: readonly AttemptedEdgeMatchIdentity[] | undefined,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      attempted !== undefined &&
      isNotNullColumnViolation(error, constraint)
    ) {
      throw new EdgeMatchIdentityConflictError({ attempted }, { cause: error });
    }
    throw error;
  }
}

/**
 * Translate a missing edge match-identity column or arbiter for every edge
 * insert route. A plain edge write still targets these columns because the
 * physical edge row has a stable shape; it therefore needs the same typed
 * migration guidance as a durable write when an older database is used.
 */
async function withEdgeInsertClassification<T>(
  run: () => Promise<T>,
  params: readonly InsertEdgeParams[],
  durableIdentityName?: string,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throwEdgeInsertStorageUnavailable(error, params, durableIdentityName);
  }
}

function assertCompleteAtomicChunks(
  actualCounts: readonly number[],
  expectedChunks: readonly (readonly unknown[])[],
  entity: "node" | "edge",
): void {
  const mismatchedChunk = expectedChunks.findIndex(
    (expectedChunk, index) => actualCounts[index] !== expectedChunk.length,
  );
  if (mismatchedChunk === -1 && actualCounts.length === expectedChunks.length) {
    return;
  }
  const slot = mismatchedChunk === -1 ? expectedChunks.length : mismatchedChunk;
  throw new CompilerInvariantError(
    `Atomic ${entity} batch returned a partial chunk result.`,
    {
      slot,
      expected: expectedChunks[slot]?.length,
      actual: actualCounts[slot],
    },
  );
}

function decodeNoEdgeRows(): readonly EdgeRow[] {
  return [];
}

async function withAtomicNodeBatchClassifications<T>(
  run: () => Promise<T>,
  entries: readonly AtomicNodeBatchEntry[],
  operationStrategy: CommonOperationStrategy,
): Promise<T> {
  const attempted = attemptedInserts(entries.map((entry) => entry.params));
  try {
    return await withDuplicateKeyClassification(run, {
      entity: "node",
      relation: operationStrategy.primaryKeyConstraints.nodes,
      attempted,
    });
  } catch (error) {
    if (
      entries.some((entry) => entry.idSource === "caller") &&
      isNotNullColumnViolation(
        error,
        operationStrategy.atomicNodeRefusalConstraints.liveIdentity,
      )
    ) {
      throw duplicateKeyOperationError("node", attempted, error);
    }
    throw error;
  }
}

async function executeClassifiedAtomicEdgeBatch<TSlot, TResult>(
  atomicExecutor: AtomicSqlProgramExecutor,
  program: AtomicSqlProgram<TSlot, TResult>,
  relation: PrimaryKeyRelation,
  refusalConstraints: CommonOperationStrategy["atomicEdgeRefusalConstraints"],
  params: readonly InsertEdgeParams[],
  claims: readonly ClaimEdgeCardinalityParams[],
): Promise<TResult> {
  const matchIdentities = attemptedEdgeMatchIdentities(params);
  try {
    // Classifiers are intentionally nested from the broad edge-insert wrapper
    // to the narrow sentinel refusals. Each inner layer recognizes only its
    // own storage signal; the outer layers preserve the public error contract.
    return await withEdgeInsertClassification(
      () =>
        withDuplicateKeyClassification(
          () =>
            withAtomicEdgeEndpointRefusalClassification(
              () =>
                withAtomicEdgeCardinalityRefusalClassification(
                  () =>
                    withAtomicEdgeDurableRefusalClassification(
                      () => atomicExecutor.execute(program),
                      relation,
                      refusalConstraints.durableIdentity,
                      matchIdentities,
                    ),
                  refusalConstraints.cardinality,
                ),
              refusalConstraints.endpoint,
            ),
          {
            entity: "edge",
            relation,
            attempted: attemptedInserts(params),
            matchIdentities,
          },
        ),
      params,
    );
  } catch (error) {
    if (claims.length > 0 && isMissingTableError(error)) {
      throw edgeClaimRelationMissing(requireDefined(params[0]).graphId, error);
    }
    throw error;
  }
}

function attemptedEdgeMatchIdentities(
  params: readonly InsertEdgeParams[],
): readonly AttemptedEdgeMatchIdentity[] | undefined {
  const attempted = params.flatMap((item) =>
    item.matchIdentity === undefined ?
      []
    : [
        {
          id: item.id,
          identityName: item.matchIdentity.name,
          kind: item.kind,
        },
      ],
  );
  return attempted.length === 0 ? undefined : attempted;
}

function throwDurableIdentityStorageUnavailable(
  error: unknown,
  params: InsertEdgeParams,
  identityName: string,
): never {
  if (!isEdgeMatchIdentityStorageUnavailableError(error)) throw error;
  throw new ConfigurationError(
    "Backend declares durable edge match identity support, but its storage has not been provisioned.",
    {
      code: "EDGE_MATCH_IDENTITY_STORAGE_UNAVAILABLE",
      capability: "durableEdgeMatchIdentity",
      graphId: params.graphId,
      edgeKind: params.kind,
      identityName,
    },
    {
      suggestion:
        "Initialize or migrate the graph through the schema manager before using a durable identity store.",
      cause: error,
    },
  );
}

function throwEdgeInsertStorageUnavailable(
  error: unknown,
  params: readonly InsertEdgeParams[],
  durableIdentityName?: string,
): never {
  if (!isEdgeMatchIdentityStorageUnavailableError(error)) throw error;

  const firstParams = requireDefined(params[0]);
  const durableParams = params.find(
    (item) => item.matchIdentity !== undefined,
  );
  const identityName =
    durableIdentityName ?? durableParams?.matchIdentity?.name;
  if (identityName !== undefined) {
    throwDurableIdentityStorageUnavailable(
      error,
      durableParams ?? firstParams,
      identityName,
    );
  }

  throw new ConfigurationError(
    "Edge match identity storage is not provisioned for this backend.",
    {
      code: "EDGE_MATCH_IDENTITY_STORAGE_UNAVAILABLE",
      graphId: firstParams.graphId,
      edgeKind: firstParams.kind,
    },
    {
      suggestion:
        "Initialize or migrate the graph through the schema manager before inserting edges.",
      cause: error,
    },
  );
}

/**
 * The entity refs of an insert's rows, copied out of the insert params so the
 * error carries identity alone and never the props alongside it.
 */
function attemptedInserts(
  params: readonly AttemptedInsert[],
): readonly AttemptedInsert[] {
  return params.map((item) => ({ kind: item.kind, id: item.id }));
}

function verifyExpectedActiveVersion(
  graphId: string,
  expected: CommitSchemaVersionParams["expected"],
  actualActiveVersion: number,
): void {
  const expectedVersion = expected.kind === "active" ? expected.version : 0;
  assertActiveSchemaVersion(graphId, expectedVersion, actualActiveVersion);
}

export function assertActiveSchemaVersion(
  graphId: string,
  expectedVersion: number,
  actualActiveVersion: number,
): void {
  if (actualActiveVersion !== expectedVersion) {
    throw new StaleVersionError({
      graphId,
      expected: expectedVersion,
      actual: actualActiveVersion,
    });
  }
}

/**
 * Runs the populated-kind guard and schema commit on one transaction-scoped
 * backend. The dialect wrapper is responsible for fencing ordinary entity
 * writes before calling this helper.
 */
export async function commitSchemaVersionIfKindsEmpty(
  backend: CommonOperationBackend,
  params: CommitSchemaVersionParams,
  probes: readonly SchemaKindEmptinessProbe[],
): Promise<CommitSchemaVersionIfKindsEmptyResult> {
  const [existing, active] = await Promise.all([
    backend.getSchemaVersion(params.graphId, params.version),
    backend.getActiveSchema(params.graphId),
  ]);

  // Preserve commitSchemaVersion's conflict and idempotency precedence. A
  // retry of an already-active identical version is success regardless of
  // current row counts; a conflicting same-version document remains a
  // content conflict rather than being masked as a populated-kind refusal.
  if (
    existing !== undefined &&
    (existing.is_active || existing.schema_hash !== params.schemaHash)
  ) {
    return {
      status: "committed",
      row: await backend.commitSchemaVersion(params),
    };
  }

  verifyExpectedActiveVersion(
    params.graphId,
    params.expected,
    active?.version ?? 0,
  );

  const populated: PopulatedSchemaKind[] = [];
  for (const probe of probes) {
    const count = await countSchemaKindRows(backend, params.graphId, probe);
    if (count > 0) populated.push({ ...probe, count });
  }

  if (populated.length > 0) {
    return { status: "populated", kinds: populated };
  }

  return {
    status: "committed",
    row: await backend.commitSchemaVersion(params),
  };
}

export function createCommonOperationBackend(
  options: CreateCommonOperationBackendOptions,
): CommonOperationBackend {
  const {
    batchConfig,
    commandSession,
    execution,
    maxBindParameters,
    operationStrategy,
    rowMappers,
  } = options;
  const nowIso = options.nowIso ?? defaultNowIso;

  // Positive results are cached by default because on standard schemas the
  // recorded DDL is stable; Postgres disables that cache because visibility is
  // search_path-sensitive. Missing tables stay re-probable unless a caller opts
  // into negative caching.
  const tableExists = createCachedTableExistence(
    (tableName) =>
      execution.execGet<Record<string, unknown>>(
        operationStrategy.buildTableExists(tableName),
      ),
    options.tableExistenceCache,
  );

  async function runIgnorableClearStatement(
    statement: Readonly<{
      query: ExecutableSql;
      ignoreMissingTable?: boolean;
      requiredTableName?: string;
    }>,
  ): Promise<void> {
    // The existence pre-check is the guard for tables that predate a schema
    // addition (e.g. the recorded relations). It works in or out of a
    // transaction, unlike a SAVEPOINT — which is invalid in autocommit mode on
    // PostgreSQL and would break clear() on a non-transactional backend.
    if (
      statement.ignoreMissingTable === true &&
      statement.requiredTableName !== undefined &&
      !(await tableExists(statement.requiredTableName))
    ) {
      return;
    }
    await execution.execRun(statement.query);
  }

  /**
   * THE edge-claim driver, shared by the single and batch members: lock every
   * entry's row in one statement, then run the conditional takeover for the
   * entries a DIFFERENT edge holds.
   *
   * The two statements exist because one cannot do the job: deciding inside the
   * upsert reads the pre-lock snapshot of the edges relation under READ
   * COMMITTED, so two concurrent writers would both see "the incumbent is not
   * live yet" and both commit. Statement 1 is therefore decision-free — it only
   * makes the row exist, takes its lock and reports the COMMITTED holder — and
   * statement 2 re-evaluates liveness after that lock is held.
   *
   * Duplicate conflict targets are refused rather than collapsed: a multi-row
   * upsert cannot affect one row twice, so two entries claiming one axis would
   * silently leave one of them unfenced. The application layer's pending
   * cardinality state refuses in-batch collisions first, which makes this a
   * defensive invariant rather than a semantic path.
   */
  async function claimEdgeCardinalityEntries(
    entries: readonly ClaimEdgeCardinalityParams[],
  ): Promise<readonly EdgeClaimOutcome[]> {
    if (entries.length === 0) return [];

    const targetKey = (entry: ClaimEdgeCardinalityParams): string => {
      const target = edgeCardinalityClaimTarget(entry);
      return `${target.axis}\u0000${target.key}`;
    };
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = targetKey(entry);
      if (seen.has(key)) {
        throw new DatabaseOperationError(
          "Two edge claims in one batch name the same cardinality axis and key; " +
            "a multi-row upsert cannot affect one row twice.",
          { operation: "insert", entity: "edge" },
        );
      }
      seen.add(key);
    }

    const outcomes = new Map<string, EdgeClaimOutcome>();
    // One claim row per inserted edge, so the edge-insert budget is the right
    // ceiling for the multi-row lock statement.
    for (const chunk of chunkArray(entries, batchConfig.edgeInsertBatchSize)) {
      const lockQuery = operationStrategy.buildLockEdgeClaims(chunk, nowIso());
      const rows = await execution.execAll<{
        axis: string;
        key: string;
        holder_edge_id: string;
      }>(lockQuery);
      const holderByTarget = new Map(
        rows.map((row) => [`${row.axis}\u0000${row.key}`, row.holder_edge_id]),
      );
      for (const entry of chunk) {
        const key = targetKey(entry);
        const holder = holderByTarget.get(key);
        if (holder === undefined || holder === entry.edgeId) {
          outcomes.set(key, { status: "claimed" });
          continue;
        }
        const takeOver = await execution.execAll<{ holder_edge_id: string }>(
          operationStrategy.buildTakeOverEdgeClaim(entry, nowIso()),
        );
        outcomes.set(
          key,
          takeOver.length > 0 ?
            { status: "claimed" }
          : { status: "refused", holderEdgeId: holder },
        );
      }
    }
    return entries.map(
      (entry) => outcomes.get(targetKey(entry)) ?? { status: "claimed" },
    );
  }

  /**
   * Single-claim fast path. The lock statement reports both the committed
   * claim holder and whether a claimless live edge already occupies the axis.
   * A stale foreign holder is taken over only through a second guarded
   * statement whose fresh snapshot rechecks the entire axis.
   */
  async function claimEdgeCardinalityGuarded(
    params: ClaimEdgeCardinalityParams,
  ): Promise<EdgeClaimOutcome> {
    const rows = await execution.execAll<{
      holder_edge_id: string;
      has_incumbent: boolean | number;
    }>(operationStrategy.buildLockEdgeClaimGuarded(params, nowIso()));
    const locked = rows[0];
    if (locked === undefined) {
      throw new DatabaseOperationError(
        "Guarded edge claim did not return its locked claim row.",
        { operation: "insert", entity: "edge" },
      );
    }
    const hasIncumbent =
      locked.has_incumbent === true || locked.has_incumbent === 1;
    if (locked.holder_edge_id === params.edgeId) {
      return hasIncumbent ?
          { status: "refused", holderEdgeId: params.edgeId }
        : { status: "claimed" };
    }
    if (hasIncumbent) {
      return { status: "refused", holderEdgeId: locked.holder_edge_id };
    }

    const takeOver = await execution.execAll<{ holder_edge_id: string }>(
      operationStrategy.buildTakeOverEdgeClaimGuarded(params, nowIso()),
    );
    return takeOver.length > 0 ?
        { status: "claimed" }
      : { status: "refused", holderEdgeId: locked.holder_edge_id };
  }

  // Returns 0 when no row is currently active — that's the sentinel
  // `expected: { kind: "initial" }` matches against.
  async function readActiveVersion(graphId: string): Promise<number> {
    const row = await execution.execGet<Record<string, unknown>>(
      operationStrategy.buildGetActiveSchema(graphId),
    );
    return row === undefined ? 0 : rowMappers.toSchemaVersionRow(row).version;
  }

  const schemaFenceLockClause = options.schemaFenceLockClause;
  const schemaFenceMembers =
    schemaFenceLockClause === undefined ?
      {}
    : {
        async insertNodeIfAbsentWithSchemaFence(
          params: InsertNodeParams,
          schemaFence: SchemaWriteFenceParams,
        ): Promise<NodeRow | undefined> {
          assertMatchingNodeSchemaFence(params, schemaFence);
          const query =
            operationStrategy.buildInsertNodeIfAbsentWithSchemaFence(
              params,
              nowIso(),
              schemaFence,
              schemaFenceLockClause,
            );
          const row = await execution.execGet<Record<string, unknown>>(query);
          return row === undefined ? undefined : rowMappers.toNodeRow(row);
        },

        async insertNodeWithSchemaFence(
          params: InsertNodeParams,
          schemaFence: SchemaWriteFenceParams,
        ): Promise<NodeRow | undefined> {
          assertMatchingNodeSchemaFence(params, schemaFence);
          const query = operationStrategy.buildInsertNodeWithSchemaFence(
            params,
            nowIso(),
            schemaFence,
            schemaFenceLockClause,
          );
          const row = await withDuplicateKeyClassification(
            () => execution.execGet<Record<string, unknown>>(query),
            {
              entity: "node",
              relation: operationStrategy.primaryKeyConstraints.nodes,
              attempted: attemptedInserts([params]),
            },
          );
          return row === undefined ? undefined : rowMappers.toNodeRow(row);
        },
      };

  const atomicSqlProgramExecutor = options.atomicSqlProgramExecutor;
  const atomicNodeBatchMembers =
    (
      atomicSqlProgramExecutor === undefined ||
      schemaFenceLockClause === undefined
    ) ?
      {}
    : (() => {
        function executeAtomicNodeBatch(
          input: AtomicNodeBatchInput & Readonly<{ resultMode: "count" }>,
        ): Promise<number>;
        function executeAtomicNodeBatch(
          input: AtomicNodeBatchInput & Readonly<{ resultMode: "rows" }>,
        ): Promise<readonly NodeRow[]>;
        async function executeAtomicNodeBatch(
          input: AtomicNodeBatchInput,
        ): Promise<number | readonly NodeRow[]> {
          if (input.entries.length === 0) {
            return input.resultMode === "count" ? 0 : [];
          }
          assertMatchingNodeSchemaFences(
            input.entries.map((entry) => entry.params),
            input.schemaFence,
          );

          const timestamp = nowIso();
          const sourceGroups = ["generated", "caller"] as const;
          const chunks = sourceGroups.flatMap((idSource) =>
            chunkArray(
              input.entries.filter((entry) => entry.idSource === idSource),
              batchConfig.nodeSchemaFencedInsertBatchSize,
            ),
          );
          const atomicExecutor = requireDefined(atomicSqlProgramExecutor);
          const atomicSchemaFenceLockClause = requireDefined(
            schemaFenceLockClause,
          );

          if (input.resultMode === "count") {
            const slots = chunks.map((chunk) => ({
              statement: execution.compile(
                operationStrategy.buildAtomicNodeBatchWithSchemaFence(
                  chunk,
                  timestamp,
                  input.schemaFence,
                  atomicSchemaFenceLockClause,
                  "count",
                ),
              ),
              cardinality: "many" as const,
              decode: (rows: readonly Readonly<Record<string, unknown>>[]) =>
                rows.length,
            }));
            const program = {
              slots,
              assemble(counts: readonly number[]): number {
                if (counts.every((count) => count === 0)) return 0;
                assertCompleteAtomicChunks(counts, chunks, "node");
                return input.entries.length;
              },
            } satisfies AtomicSqlProgram<number, number>;
            return withAtomicNodeBatchClassifications(
              () => atomicExecutor.execute(program),
              input.entries,
              operationStrategy,
            );
          }

          const slots = chunks.map((chunk) => ({
            statement: execution.compile(
              operationStrategy.buildAtomicNodeBatchWithSchemaFence(
                chunk,
                timestamp,
                input.schemaFence,
                atomicSchemaFenceLockClause,
                "rows",
              ),
            ),
            cardinality: "many" as const,
            decode: (rows: readonly Readonly<Record<string, unknown>>[]) =>
              rows.map((row) => rowMappers.toNodeRow(row)),
          }));
          const program = {
            slots,
            assemble(
              rowChunks: readonly (readonly NodeRow[])[],
            ): readonly NodeRow[] {
              if (rowChunks.every((rows) => rows.length === 0)) return [];
              const rows = rowChunks.flat();
              if (rows.length !== input.entries.length) {
                throw new CompilerInvariantError(
                  "Atomic node batch returned a partial row result.",
                  { expected: input.entries.length, actual: rows.length },
                );
              }
              const byIdentity = new Map<string, NodeRow>();
              for (const row of rows) {
                const key = encodeTupleKey([row.graph_id, row.kind, row.id]);
                if (byIdentity.has(key)) {
                  throw new CompilerInvariantError(
                    "Atomic node batch returned a duplicate result row.",
                    { graphId: row.graph_id, kind: row.kind, id: row.id },
                  );
                }
                byIdentity.set(key, row);
              }
              return input.entries.map((entry) => {
                const key = encodeTupleKey([
                  entry.params.graphId,
                  entry.params.kind,
                  entry.params.id,
                ]);
                const row = byIdentity.get(key);
                if (row === undefined) {
                  throw new CompilerInvariantError(
                    "Atomic node batch returned a row outside its input set.",
                    {
                      graphId: entry.params.graphId,
                      kind: entry.params.kind,
                      id: entry.params.id,
                    },
                  );
                }
                return row;
              });
            },
          } satisfies AtomicSqlProgram<readonly NodeRow[], readonly NodeRow[]>;
          return withAtomicNodeBatchClassifications(
            () => atomicExecutor.execute(program),
            input.entries,
            operationStrategy,
          );
        }

        return { executeAtomicNodeBatch } satisfies Readonly<{
          executeAtomicNodeBatch: AtomicNodeBatchExecutor;
        }>;
      })();

  const atomicEdgeBatchMembers =
    (
      atomicSqlProgramExecutor === undefined ||
      schemaFenceLockClause === undefined
    ) ?
      {}
    : (() => {
        const atomicExecutor = requireDefined(atomicSqlProgramExecutor);
        const atomicSchemaFenceLockClause = requireDefined(
          schemaFenceLockClause,
        );

        async function executeAtomicEdgeBatch(
          input: AtomicEdgeBatchCountInput,
        ): Promise<number>;
        async function executeAtomicEdgeBatch(
          input: AtomicEdgeBatchRowsInput,
        ): Promise<readonly EdgeRow[]>;
        async function executeAtomicEdgeBatch(
          input: AtomicEdgeBatchCountInput | AtomicEdgeBatchRowsInput,
        ): Promise<number | readonly EdgeRow[]> {
          if (input.params.length === 0) {
            return input.resultMode === "count" ? 0 : [];
          }
          assertMatchingEdgeSchemaFences(input.params, input.schemaFence);
          const paramsByGraphAndId = new Map(
            input.params.map((params) => [
              encodeTupleKey([params.graphId, params.id]),
              params,
            ]),
          );
          for (const claim of input.claims) {
            const params = paramsByGraphAndId.get(
              encodeTupleKey([claim.graphId, claim.edgeId]),
            );
            if (params === undefined) {
              throw new CompilerInvariantError(
                "An atomic edge batch claim has no matching input row.",
                { graphId: claim.graphId, edgeId: claim.edgeId },
              );
            }
            assertMatchingFusedEdgeClaim(params, claim);
          }

          const timestamp = nowIso();
          const chunks = chunkArray(
            input.params,
            batchConfig.edgeSchemaFencedInsertBatchSize,
          );
          const atomicEdgeClaimBatchSize = Math.max(
            1,
            Math.floor((maxBindParameters - 2) / ATOMIC_EDGE_CLAIM_PARAM_COUNT),
          );
          function appendClaimSlots<TResult>(
            slots: AtomicSqlProgram<TResult, unknown>["slots"][number][],
            claims: readonly ClaimEdgeCardinalityParams[],
            decode: AtomicSqlProgram<
              TResult,
              unknown
            >["slots"][number]["decode"],
          ): void {
            for (const claimChunk of chunkArray(
              claims,
              atomicEdgeClaimBatchSize,
            )) {
              slots.push(
                {
                  statement: execution.compile(
                    operationStrategy.buildDeleteStaleAtomicEdgeClaims(
                      claimChunk,
                      input.schemaFence,
                      atomicSchemaFenceLockClause,
                    ),
                  ),
                  cardinality: "none",
                  decode,
                },
                {
                  statement: execution.compile(
                    operationStrategy.buildAcquireAtomicEdgeClaims(
                      claimChunk,
                      timestamp,
                      input.schemaFence,
                      atomicSchemaFenceLockClause,
                    ),
                  ),
                  cardinality: "none",
                  decode,
                },
                {
                  statement: execution.compile(
                    operationStrategy.buildAssertAtomicEdgeClaimsOwned(
                      claimChunk,
                      timestamp,
                      input.schemaFence,
                      atomicSchemaFenceLockClause,
                    ),
                  ),
                  cardinality: "none",
                  decode,
                },
              );
            }
          }
          if (input.resultMode === "count") {
            const edgeSlotIndexes: number[] = [];
            const slots: AtomicSqlProgram<number, number>["slots"][number][] =
              [];
            appendClaimSlots(slots, input.claims, (rows) => rows.length);
            for (const chunk of chunks) {
              edgeSlotIndexes.push(slots.length);
              slots.push({
                statement: execution.compile(
                  operationStrategy.buildInsertEdgesBatchWithSchemaFence(
                    chunk,
                    timestamp,
                    input.schemaFence,
                    atomicSchemaFenceLockClause,
                  ),
                ),
                cardinality: "many",
                decode: (rows) => rows.length,
              });
            }
            const program = {
              slots,
              assemble(slotCounts: readonly number[]): number {
                const counts = edgeSlotIndexes.map((index) =>
                  requireDefined(slotCounts[index]),
                );
                if (counts.every((count) => count === 0)) return 0;
                assertCompleteAtomicChunks(counts, chunks, "edge");
                return counts.reduce((total, count) => total + count, 0);
              },
            } satisfies AtomicSqlProgram<number, number>;
            return executeClassifiedAtomicEdgeBatch(
              atomicExecutor,
              program,
              operationStrategy.primaryKeyConstraints.edges,
              operationStrategy.atomicEdgeRefusalConstraints,
              input.params,
              input.claims,
            );
          }

          const edgeSlotIndexes: number[] = [];
          const slots: AtomicSqlProgram<
            readonly EdgeRow[],
            readonly EdgeRow[]
          >["slots"][number][] = [];
          appendClaimSlots(slots, input.claims, decodeNoEdgeRows);
          for (const chunk of chunks) {
            edgeSlotIndexes.push(slots.length);
            slots.push({
              statement: execution.compile(
                operationStrategy.buildInsertEdgesBatchReturningWithSchemaFence(
                  chunk,
                  timestamp,
                  input.schemaFence,
                  atomicSchemaFenceLockClause,
                ),
              ),
              cardinality: "many",
              decode: (rows) => rows.map((row) => rowMappers.toEdgeRow(row)),
            });
          }
          const program = {
            slots,
            assemble(
              slotRows: readonly (readonly EdgeRow[])[],
            ): readonly EdgeRow[] {
              const rowChunks = edgeSlotIndexes.map((index) =>
                requireDefined(slotRows[index]),
              );
              if (rowChunks.every((rows) => rows.length === 0)) return [];
              assertCompleteAtomicChunks(
                rowChunks.map((rows) => rows.length),
                chunks,
                "edge",
              );
              const inputOrder = new Map(
                input.params.map((params, index) => [params.id, index]),
              );
              const rows = rowChunks.flat();
              const seenIds = new Set<string>();
              for (const row of rows) {
                if (!inputOrder.has(row.id)) {
                  throw new CompilerInvariantError(
                    "Atomic edge batch returned a row outside its input set.",
                    { id: row.id },
                  );
                }
                if (seenIds.has(row.id)) {
                  throw new CompilerInvariantError(
                    "Atomic edge batch returned a duplicate result row.",
                    { id: row.id },
                  );
                }
                seenIds.add(row.id);
              }
              return rows.toSorted(
                (left, right) =>
                  (inputOrder.get(left.id) ?? 0) -
                  (inputOrder.get(right.id) ?? 0),
              );
            },
          } satisfies AtomicSqlProgram<readonly EdgeRow[], readonly EdgeRow[]>;
          return executeClassifiedAtomicEdgeBatch(
            atomicExecutor,
            program,
            operationStrategy.primaryKeyConstraints.edges,
            operationStrategy.atomicEdgeRefusalConstraints,
            input.params,
            input.claims,
          );
        }

        return { executeAtomicEdgeBatch } satisfies Readonly<{
          executeAtomicEdgeBatch: AtomicEdgeBatchExecutor;
        }>;
      })();

  const schemaGraphWriteLockNamespace = options.schemaGraphWriteLockNamespace;
  const buildLockSchemaVersionAndGraphWrite =
    operationStrategy.buildLockSchemaVersionAndGraphWrite;
  const schemaGraphWriteFenceMembers =
    (
      schemaGraphWriteLockNamespace === undefined ||
      buildLockSchemaVersionAndGraphWrite === undefined
    ) ?
      {}
    : {
        async lockSchemaVersionAndGraphWrite(params: SchemaWriteFenceParams) {
          const row = await execution.execGet<Record<string, unknown>>(
            buildLockSchemaVersionAndGraphWrite(
              params,
              schemaGraphWriteLockNamespace,
            ),
          );
          if (row !== undefined) {
            return normalizeGraphCommandIsolation(row["transaction_isolation"]);
          }

          // A blocked `FOR SHARE` can recheck the old active row out of its
          // statement snapshot without substituting the winner's new row. As
          // in the ordinary fence, diagnose with a fresh, non-locking read.
          const settledRow = await execution.execGet<Record<string, unknown>>(
            operationStrategy.buildGetActiveSchema(params.graphId),
          );
          const settled =
            settledRow === undefined ? undefined : (
              rowMappers.toSchemaVersionRow(settledRow)
            );
          throw new StaleVersionError({
            graphId: params.graphId,
            expected: params.expectedVersion,
            actual: settled?.version ?? 0,
          });
        },
      };

  const buildEdgeCardinalityInsert =
    operationStrategy.buildInsertEdgeIfEndpointsLiveWithCardinalityClaim;
  const executeEdgeCardinalityInsert =
    (
      options.edgeCardinalityInsertFusion === true &&
      buildEdgeCardinalityInsert !== undefined
    ) ?
      async function executeEdgeCardinalityInsert(
        params: InsertEdgeParams,
        claim: ClaimEdgeCardinalityParams,
      ): Promise<EdgeRow | undefined> {
        assertMatchingFusedEdgeClaim(params, claim);
        const query = buildEdgeCardinalityInsert(params, claim, nowIso());
        const row = await withEdgeInsertClassification(
          () =>
            withDuplicateKeyClassification(
              () => execution.execGet<Record<string, unknown>>(query),
              {
                entity: "edge",
                relation: operationStrategy.primaryKeyConstraints.edges,
                attempted: attemptedInserts([params]),
                matchIdentities: attemptedEdgeMatchIdentities([params]),
              },
            ),
          [params],
        );
        return row === undefined ? undefined : rowMappers.toEdgeRow(row);
      }
    : undefined;

  const buildInsertNodeWithProjections =
    operationStrategy.buildInsertNodeWithProjections;

  async function executeNodeManagedCreate(
    plan: ManagedNodeCreatePlan,
  ): Promise<NodeCreateCommandResult> {
    if (plan.mode.kind === "schema-fenced") {
      assertMatchingNodeSchemaFence(plan.params, plan.mode.schemaFence);
    }
    if (plan.claims.length > 0 && plan.mode.kind === "schema-fenced") {
      return {
        outcome: "unsupported",
        entity: "node",
        dimensions: ["schemaFence", "claims"],
      };
    }
    const rephasedPlan =
      options.nodeClaimInsertFusion === true ?
        undefined
      : rephaseNonTransactionalNodeClaimPlan(plan);
    if (
      plan.claims.length > 0 &&
      options.nodeClaimInsertFusion !== true &&
      rephasedPlan === undefined
    ) {
      return { outcome: "unsupported", entity: "node", dimensions: ["claims"] };
    }
    const executablePlan = rephasedPlan ?? plan;
    const { params } = executablePlan;
    const plannedClaims = executablePlan.claims;
    if (
      executablePlan.mode.kind === "schema-fenced" &&
      options.schemaFenceLockClause === undefined
    ) {
      return {
        outcome: "unsupported",
        entity: "node",
        dimensions: ["schemaFence"],
      };
    }
    if (
      executablePlan.projections.length > 0 &&
      (options.nodeProjectionInsertFusion !== true ||
        buildInsertNodeWithProjections === undefined)
    ) {
      return {
        outcome: "unsupported",
        entity: "node",
        dimensions: ["projections"],
      };
    }

    if (
      (plannedClaims.length > 0 || executablePlan.projections.length > 0) &&
      buildInsertNodeWithProjections === undefined
    ) {
      return {
        outcome: "unsupported",
        entity: "node",
        dimensions:
          plannedClaims.length === 0 ? ["projections"]
          : executablePlan.projections.length === 0 ? ["claims"]
          : ["claims", "projections"],
      };
    }

    if (plannedClaims.length === 0 && executablePlan.projections.length === 0) {
      const query =
        executablePlan.mode.kind === "schema-fenced" ?
          operationStrategy.buildInsertNodeWithSchemaFence(
            params,
            nowIso(),
            executablePlan.mode.schemaFence,
            options.schemaFenceLockClause ?? drizzleSql.raw(""),
          )
        : operationStrategy.buildInsertNode(params, nowIso());
      const row = await withDuplicateKeyClassification(
        () => execution.execGet<Record<string, unknown>>(query),
        {
          entity: "node",
          relation: operationStrategy.primaryKeyConstraints.nodes,
          attempted: attemptedInserts([params]),
        },
      );
      return row === undefined ?
          { outcome: "rejected", entity: "node", reason: "unknown" }
        : {
            outcome: "created",
            entity: "node",
            row: rowMappers.toNodeRow(row),
          };
    }

    if (buildInsertNodeWithProjections === undefined) {
      throw new CompilerInvariantError(
        "The backend accepted a managed node plan it cannot compile.",
        { graphId: params.graphId, kind: params.kind, id: params.id },
      );
    }
    const query = buildInsertNodeWithProjections(
      params,
      executablePlan,
      nowIso(),
      options.schemaFenceLockClause,
    );
    if (query === undefined) {
      return {
        outcome: "unsupported",
        entity: "node",
        dimensions: ["projections"],
      };
    }
    await options.beforeNodeProjectionInsert?.(params, executablePlan);
    const row = await (async () => {
      try {
        return await withDuplicateKeyClassification(
          () => execution.execGet<Record<string, unknown>>(query),
          {
            entity: "node",
            relation: operationStrategy.primaryKeyConstraints.nodes,
            attempted: attemptedInserts([params]),
          },
        );
      } catch (error) {
        if (options.refuseNodeProjectionError !== undefined) {
          return options.refuseNodeProjectionError(
            params,
            executablePlan,
            error,
          );
        }
        throw error;
      }
    })();
    if (row?.["write_discriminator"] === "claim_conflict") {
      const constraintName = row["claim_constraint_name"];
      const holderKind = row["claim_holder_kind"];
      const holderId = row["claim_holder_id"];
      const axis = row["claim_axis"];
      if (
        typeof constraintName !== "string" ||
        typeof holderKind !== "string" ||
        typeof holderId !== "string" ||
        typeof axis !== "string"
      ) {
        throw new CompilerInvariantError(
          "A planned node claim refusal returned incomplete conflict metadata.",
          { graphId: params.graphId, kind: params.kind, id: params.id },
        );
      }
      const conflictingClaim = plannedClaims.find((claim) => {
        if (
          claim.constraintName !== constraintName ||
          claim.key !== row["claim_key"]
        ) {
          return false;
        }
        if (claim.verdict.kind === "disjointness") {
          return claim.axis === axis;
        }
        return claim.verdict.probeAxes.includes(axis);
      });
      const fields =
        conflictingClaim?.verdict.kind === "uniqueness" ?
          conflictingClaim.verdict.fields
        : [];
      throw new UniquenessError({
        constraintName,
        kind: holderKind,
        existingId: holderId,
        newId: params.id,
        fields,
        axis,
      });
    }
    if (row === undefined && executablePlan.mode.kind === "ordinary") {
      throw new DatabaseOperationError(
        "Fused node projection insert failed: no row returned",
        { operation: "insert", entity: "node", reason: "no_row_returned" },
      );
    }
    return row === undefined ?
        { outcome: "rejected", entity: "node", reason: "unknown" }
      : { outcome: "created", entity: "node", row: rowMappers.toNodeRow(row) };
  }

  async function executeEdgeEndpointInsert(
    params: InsertEdgeParams,
  ): Promise<EdgeRow | undefined> {
    const query = operationStrategy.buildInsertEdgeIfEndpointsLive(
      params,
      nowIso(),
    );
    const row = await withEdgeInsertClassification(
      () =>
        withDuplicateKeyClassification(
          () => execution.execGet<Record<string, unknown>>(query),
          {
            entity: "edge",
            relation: operationStrategy.primaryKeyConstraints.edges,
            attempted: attemptedInserts([params]),
            matchIdentities: attemptedEdgeMatchIdentities([params]),
          },
        ),
      [params],
    );
    return row === undefined ? undefined : rowMappers.toEdgeRow(row);
  }

  async function executeEdgeSchemaFencedInsert(
    params: InsertEdgeParams,
    schemaFence: SchemaWriteFenceParams,
  ): Promise<EdgeRow | undefined> {
    const schemaLockClause = options.schemaFenceLockClause;
    if (schemaLockClause === undefined) {
      throw new ConfigurationError(
        "This backend cannot execute a managed edge create with a schema fence.",
        {
          capability: "commands",
          command: "edge.create",
          dimension: "schemaFence",
        },
      );
    }
    const query =
      operationStrategy.buildInsertEdgeIfEndpointsLiveWithSchemaFence(
        params,
        nowIso(),
        schemaFence,
        schemaLockClause,
      );
    const row = await withEdgeInsertClassification(
      () =>
        withDuplicateKeyClassification(
          () => execution.execGet<Record<string, unknown>>(query),
          {
            entity: "edge",
            relation: operationStrategy.primaryKeyConstraints.edges,
            attempted: attemptedInserts([params]),
            matchIdentities: attemptedEdgeMatchIdentities([params]),
          },
        ),
      [params],
    );
    return row === undefined ? undefined : rowMappers.toEdgeRow(row);
  }

  async function executeEdgeManagedCreate(
    plan: ManagedEdgeCreatePlan,
  ): Promise<EdgeCreateCommandResult> {
    const { params } = plan;
    if (
      plan.schemaFence !== undefined &&
      plan.schemaFence.graphId !== params.graphId
    ) {
      throw new CompilerInvariantError(
        "A managed edge create's schema fence must match its edge graph.",
        {
          edgeGraphId: params.graphId,
          fenceGraphId: plan.schemaFence.graphId,
          id: params.id,
        },
      );
    }
    if (plan.schemaFence !== undefined && plan.cardinalityClaim !== undefined) {
      return {
        outcome: "unsupported",
        entity: "edge",
        dimensions: ["schemaFence", "cardinalityClaim"],
      };
    }
    if (
      plan.schemaFence !== undefined &&
      options.schemaFenceLockClause === undefined
    ) {
      return {
        outcome: "unsupported",
        entity: "edge",
        dimensions: ["schemaFence"],
      };
    }
    if (
      plan.cardinalityClaim !== undefined &&
      executeEdgeCardinalityInsert === undefined
    ) {
      return {
        outcome: "unsupported",
        entity: "edge",
        dimensions: ["cardinalityClaim"],
      };
    }

    let row: EdgeRow | undefined;
    if (plan.schemaFence !== undefined) {
      row = await executeEdgeSchemaFencedInsert(params, plan.schemaFence);
    } else if (plan.cardinalityClaim === undefined) {
      row = await executeEdgeEndpointInsert(params);
    } else {
      // The unsupported case is returned above before any SQL executes.
      if (executeEdgeCardinalityInsert === undefined) {
        throw new CompilerInvariantError(
          "Edge create plan support changed between preflight and execution.",
          {
            capability: "commands",
            command: "edge.create",
            dimension: "cardinalityClaim",
          },
        );
      }
      row = await executeEdgeCardinalityInsert(params, plan.cardinalityClaim);
    }

    return row === undefined ?
        { outcome: "rejected", entity: "edge", reason: "unknown" }
      : { outcome: "created", entity: "edge", row };
  }

  async function executeEdgeConvergeCreate(
    command: EdgeConvergeCreateCommand,
    context: GraphCommandExecutionContext,
  ): Promise<EdgeConvergeCreateCommandResult> {
    const { plan } = command;
    const { params } = plan;
    if (
      plan.schemaFence !== undefined &&
      plan.schemaFence.graphId !== params.graphId
    ) {
      throw new CompilerInvariantError(
        "A convergent edge create's schema fence must match its edge graph.",
        {
          edgeGraphId: params.graphId,
          fenceGraphId: plan.schemaFence.graphId,
          id: params.id,
        },
      );
    }
    const durable = command.match.kind === "durable";
    // Dynamic convergence still requires the caller's coordinated snapshot.
    // Durable convergence delegates that decision to the row-level unique
    // arbiter and may therefore execute directly on a root session.
    if (
      plan.cardinalityClaim !== undefined ||
      operationStrategy.buildConvergeEdgeCreate === undefined ||
      (!durable && !operationStrategy.dynamicEdgeConvergence) ||
      (!durable && context.coordination === "none") ||
      (plan.schemaFence !== undefined &&
        options.schemaFenceLockClause === undefined)
    ) {
      return {
        outcome: "unsupported",
        entity: "edge",
        dimensions: ["convergence"],
      };
    }

    const query = operationStrategy.buildConvergeEdgeCreate({
      params,
      match: command.match,
      timestamp: nowIso(),
      ...(plan.schemaFence === undefined ?
        {}
      : {
          schemaFence: plan.schemaFence,
          schemaLockClause: requireDefined(options.schemaFenceLockClause),
        }),
    });
    const row = await withEdgeInsertClassification(
      () =>
        withDuplicateKeyClassification(
          () => execution.execGet<Record<string, unknown>>(query),
          {
            entity: "edge",
            relation: operationStrategy.primaryKeyConstraints.edges,
            attempted: attemptedInserts([params]),
            matchIdentities: attemptedEdgeMatchIdentities([params]),
          },
        ),
      [params],
      command.match.kind === "durable" ? command.match.identity.name : undefined,
    );
    if (row === undefined) {
      return { outcome: "rejected", entity: "edge", reason: "unknown" };
    }
    switch (row["write_discriminator"]) {
      case 0:
      case "0": {
        return {
          outcome: "found",
          entity: "edge",
          row: rowMappers.toEdgeRow(row),
        };
      }
      case 1:
      case "1": {
        return {
          outcome: "created",
          entity: "edge",
          row: rowMappers.toEdgeRow(row),
        };
      }
      default: {
        throw new CompilerInvariantError(
          "A convergent edge create returned an unknown write discriminator.",
          { graphId: params.graphId, kind: params.kind, id: params.id },
        );
      }
    }
  }

  async function executeCommand(
    command: GraphCommand,
    context: GraphCommandExecutionContext,
  ): Promise<GraphCommandResult> {
    assertGraphCommandExecutionContext(context);
    if (context.session !== commandSession) {
      throw new CompilerInvariantError(
        "An authoritative graph command context does not match its bound command port.",
        { boundSession: commandSession, contextSession: context.session },
      );
    }
    if (context.coordination !== "none") {
      assertGraphCommandCoordination(
        commandsPort,
        command,
        context.coordination,
      );
    }
    switch (command.kind) {
      case "node.create": {
        return executeNodeManagedCreate(command.plan);
      }
      case "edge.create": {
        return executeEdgeManagedCreate(command.plan);
      }
      case "edge.converge-create": {
        if (context.coordination !== "none") {
          // Keep the built-in port safe for direct callers that bypass the
          // public authoritative-command helper.
          assertGraphCommandConvergenceIsolation(
            commandsPort,
            context.coordination,
          );
        }
        return executeEdgeConvergeCreate(command, context);
      }
      default: {
        command satisfies never;
        throw new CompilerInvariantError(
          "The command port received an unknown command.",
          { capability: "commands" },
        );
      }
    }
  }

  const commandsPort = { session: commandSession, execute: executeCommand };

  return {
    tableExists,

    ...schemaFenceMembers,
    ...atomicNodeBatchMembers,
    ...atomicEdgeBatchMembers,
    ...schemaGraphWriteFenceMembers,
    commands: commandsPort,

    async executeSchemaDdl(ddl: string): Promise<void> {
      await execution.execRun(asCompiledStatementSql(sql.raw(ddl)));
    },

    async executeStatement(query: CompiledStatementSql): Promise<void> {
      await execution.execRun(query);
    },

    async executeTemporaryStatement(
      query: CompiledTemporaryStatementSql,
    ): Promise<void> {
      await execution.execRun(query);
    },

    async insertNode(params: InsertNodeParams): Promise<NodeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertNode(params, timestamp);
      const row = await withDuplicateKeyClassification(
        () => execution.execGet<Record<string, unknown>>(query),
        {
          entity: "node",
          relation: operationStrategy.primaryKeyConstraints.nodes,
          attempted: attemptedInserts([params]),
        },
      );
      if (!row)
        throw new DatabaseOperationError(
          "Insert node failed: no row returned",
          {
            operation: "insert",
            entity: "node",
            reason: "no_row_returned",
          },
        );
      return rowMappers.toNodeRow(row);
    },

    async insertNodeIfAbsent(
      params: InsertNodeParams,
    ): Promise<NodeRow | undefined> {
      const query = operationStrategy.buildInsertNodeIfAbsent(params, nowIso());
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row === undefined ? undefined : rowMappers.toNodeRow(row);
    },

    async insertNodeNoReturn(params: InsertNodeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertNodeNoReturn(
        params,
        timestamp,
      );
      await withDuplicateKeyClassification(() => execution.execRun(query), {
        entity: "node",
        relation: operationStrategy.primaryKeyConstraints.nodes,
        attempted: attemptedInserts([params]),
      });
    },

    async insertNodesBatch(params: readonly InsertNodeParams[]): Promise<void> {
      if (params.length === 0) {
        return;
      }
      const timestamp = nowIso();
      for (const chunk of chunkArray(params, batchConfig.nodeInsertBatchSize)) {
        const query = operationStrategy.buildInsertNodesBatch(chunk, timestamp);
        await withDuplicateKeyClassification(() => execution.execRun(query), {
          entity: "node",
          relation: operationStrategy.primaryKeyConstraints.nodes,
          attempted: attemptedInserts(chunk),
        });
      }
    },

    async insertNodesBatchReturning(
      params: readonly InsertNodeParams[],
    ): Promise<readonly NodeRow[]> {
      if (params.length === 0) {
        return [];
      }
      const timestamp = nowIso();
      const allRows: NodeRow[] = [];
      for (const chunk of chunkArray(params, batchConfig.nodeInsertBatchSize)) {
        const query = operationStrategy.buildInsertNodesBatchReturning(
          chunk,
          timestamp,
        );
        const rows = await withDuplicateKeyClassification(
          () => execution.execAll<Record<string, unknown>>(query),
          {
            entity: "node",
            relation: operationStrategy.primaryKeyConstraints.nodes,
            attempted: attemptedInserts(chunk),
          },
        );
        allRows.push(...rows.map((row) => rowMappers.toNodeRow(row)));
      }
      return allRows;
    },

    async getNode(
      graphId: string,
      kind: string,
      id: string,
    ): Promise<NodeRow | undefined> {
      const query = operationStrategy.buildGetNode(graphId, kind, id);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toNodeRow(row) : undefined;
    },

    async getNodes(
      graphId: string,
      kind: string,
      ids: readonly string[],
    ): Promise<readonly NodeRow[]> {
      if (ids.length === 0) return [];
      const allRows: NodeRow[] = [];
      for (const chunk of chunkArray(ids, batchConfig.getNodesChunkSize)) {
        const query = operationStrategy.buildGetNodes(graphId, kind, chunk);
        const rows = await execution.execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => rowMappers.toNodeRow(row)));
      }
      return allRows;
    },

    async updateNode(params: UpdateNodeParams): Promise<NodeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildUpdateNode(params, timestamp);
      const row = await execution.execGet<Record<string, unknown>>(query);
      if (!row)
        throw new DatabaseOperationError(
          "Update node failed: no row returned",
          {
            operation: "update",
            entity: "node",
            reason: "no_row_returned",
          },
        );
      return rowMappers.toNodeRow(row);
    },

    async updateNodeSet(
      params: UpdateNodeSetParams,
    ): Promise<UpdateNodeSetResult> {
      if (
        Object.keys(params.patch).length === 0 &&
        (params.unsetProperties?.length ?? 0) === 0
      ) {
        throw new ConfigurationError(
          "Set-based node update requires at least one property",
          { operation: "updateNodeSet", kind: params.kind },
        );
      }
      if (params.candidateIdColumn.length === 0) {
        throw new ConfigurationError(
          "Set-based node update requires a candidate id column",
          { operation: "updateNodeSet", kind: params.kind },
        );
      }
      const timestamp = nowIso();
      const query = operationStrategy.buildUpdateNodeSet(params, timestamp);
      const rows = await execution.execAll<Record<string, unknown>>(query);
      const updatedRows = rows.map((row) => rowMappers.toNodeRow(row));
      return { affectedCount: updatedRows.length, rows: updatedRows };
    },

    async deleteNode(params: DeleteNodeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildDeleteNode(params, timestamp);
      await execution.execRun(query);
    },

    // IMPORTANT: This cascade is not atomic. Callers must ensure this runs
    // within a transaction to prevent partial deletion on intermediate failure.
    //
    // Embeddings are NOT cleaned up here: they live in per-`(nodeKind,
    // fieldPath)` strategy-owned tables addressable only with the slot
    // context the graph-agnostic backend lacks. The store's hard-delete
    // path (`executeNodeHardDelete`) drives `deleteNodeEmbeddings`, which
    // resolves each embedding field and routes a per-field
    // `backend.deleteEmbedding` through the active vector strategy.
    async hardDeleteNode(params: HardDeleteNodeParams): Promise<void> {
      const deleteUniquesQuery = operationStrategy.buildHardDeleteUniquesByNode(
        params.graphId,
        params.kind,
        params.id,
      );
      await execution.execRun(deleteUniquesQuery);

      const deleteFulltextStatements =
        operationStrategy.buildDeleteFulltextByNode(
          params.graphId,
          params.kind,
          params.id,
        );
      for (const stmt of deleteFulltextStatements) {
        await execution.execRun(stmt);
      }

      const deleteEdgesQuery = operationStrategy.buildHardDeleteEdgesByNode(
        params.graphId,
        params.kind,
        params.id,
      );
      await execution.execRun(deleteEdgesQuery);

      const query = operationStrategy.buildHardDeleteNode(params);
      await execution.execRun(query);
    },

    async insertEdge(params: InsertEdgeParams): Promise<EdgeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertEdge(params, timestamp);
      const row = await withEdgeInsertClassification(
        () =>
          withDuplicateKeyClassification(
            () => execution.execGet<Record<string, unknown>>(query),
            {
              entity: "edge",
              relation: operationStrategy.primaryKeyConstraints.edges,
              attempted: attemptedInserts([params]),
              matchIdentities: attemptedEdgeMatchIdentities([params]),
            },
          ),
        [params],
      );
      if (!row)
        throw new DatabaseOperationError(
          "Insert edge failed: no row returned",
          {
            operation: "insert",
            entity: "edge",
            reason: "no_row_returned",
          },
        );
      return rowMappers.toEdgeRow(row);
    },

    async insertEdgeNoReturn(params: InsertEdgeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertEdgeNoReturn(
        params,
        timestamp,
      );
      await withEdgeInsertClassification(
        () =>
          withDuplicateKeyClassification(() => execution.execRun(query), {
            entity: "edge",
            relation: operationStrategy.primaryKeyConstraints.edges,
            attempted: attemptedInserts([params]),
            matchIdentities: attemptedEdgeMatchIdentities([params]),
          }),
        [params],
      );
    },

    async insertEdgesBatch(params: readonly InsertEdgeParams[]): Promise<void> {
      if (params.length === 0) {
        return;
      }
      const timestamp = nowIso();
      for (const chunk of chunkArray(params, batchConfig.edgeInsertBatchSize)) {
        const query = operationStrategy.buildInsertEdgesBatch(chunk, timestamp);
        await withEdgeInsertClassification(
          () =>
            withDuplicateKeyClassification(() => execution.execRun(query), {
              entity: "edge",
              relation: operationStrategy.primaryKeyConstraints.edges,
              attempted: attemptedInserts(chunk),
              matchIdentities: attemptedEdgeMatchIdentities(chunk),
            }),
          chunk,
        );
      }
    },

    async insertEdgesBatchReturning(
      params: readonly InsertEdgeParams[],
    ): Promise<readonly EdgeRow[]> {
      if (params.length === 0) {
        return [];
      }
      const timestamp = nowIso();
      const allRows: EdgeRow[] = [];
      for (const chunk of chunkArray(params, batchConfig.edgeInsertBatchSize)) {
        const query = operationStrategy.buildInsertEdgesBatchReturning(
          chunk,
          timestamp,
        );
        const rows = await withEdgeInsertClassification(
          () =>
            withDuplicateKeyClassification(
              () => execution.execAll<Record<string, unknown>>(query),
              {
                entity: "edge",
                relation: operationStrategy.primaryKeyConstraints.edges,
                attempted: attemptedInserts(chunk),
                matchIdentities: attemptedEdgeMatchIdentities(chunk),
              },
            ),
          chunk,
        );
        allRows.push(...rows.map((row) => rowMappers.toEdgeRow(row)));
      }
      return allRows;
    },

    async insertEdgesDurableBatchReturning(
      params: readonly InsertEdgeParams[],
    ): Promise<readonly EdgeRow[]> {
      if (params.length === 0) return [];
      const missingIdentityIds = params
        .filter((item) => item.matchIdentity === undefined)
        .map((item) => item.id);
      if (missingIdentityIds.length > 0) {
        throw new CompilerInvariantError(
          "A durable edge batch requires match identity storage on every row.",
          { missingIds: missingIdentityIds },
        );
      }
      const timestamp = nowIso();
      const allRows: EdgeRow[] = [];
      for (const chunk of chunkArray(params, batchConfig.edgeInsertBatchSize)) {
        const query = operationStrategy.buildInsertEdgesDurableBatchReturning(
          chunk,
          timestamp,
        );
        const rows = await withEdgeInsertClassification(
          () =>
            withDuplicateKeyClassification(
              () => execution.execAll<Record<string, unknown>>(query),
              {
                entity: "edge",
                relation: operationStrategy.primaryKeyConstraints.edges,
                attempted: attemptedInserts(chunk),
                matchIdentities: attemptedEdgeMatchIdentities(chunk),
              },
            ),
          chunk,
        );
        allRows.push(...rows.map((row) => rowMappers.toEdgeRow(row)));
      }
      return allRows;
    },

    async getEdge(graphId: string, id: string): Promise<EdgeRow | undefined> {
      const query = operationStrategy.buildGetEdge(graphId, id);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toEdgeRow(row) : undefined;
    },

    async getEdges(
      graphId: string,
      ids: readonly string[],
    ): Promise<readonly EdgeRow[]> {
      if (ids.length === 0) return [];
      const allRows: EdgeRow[] = [];
      for (const chunk of chunkArray(ids, batchConfig.getEdgesChunkSize)) {
        const query = operationStrategy.buildGetEdges(graphId, chunk);
        const rows = await execution.execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => rowMappers.toEdgeRow(row)));
      }
      return allRows;
    },

    async updateEdge(params: UpdateEdgeParams): Promise<EdgeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildUpdateEdge(params, timestamp);
      const row = await execution.execGet<Record<string, unknown>>(query);
      if (!row)
        throw new DatabaseOperationError(
          "Update edge failed: no row returned",
          {
            operation: "update",
            entity: "edge",
            reason: "no_row_returned",
          },
        );
      return rowMappers.toEdgeRow(row);
    },

    async deleteEdge(params: DeleteEdgeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildDeleteEdge(params, timestamp);
      await execution.execRun(query);
    },

    async hardDeleteEdge(params: HardDeleteEdgeParams): Promise<void> {
      const query = operationStrategy.buildHardDeleteEdge(params);
      await execution.execRun(query);
    },

    async deleteEdgesBatch(params: DeleteEdgesBatchParams): Promise<void> {
      if (params.ids.length === 0) return;
      const timestamp = nowIso();
      // The soft-delete UPDATE binds one extra parameter (the `deleted_at`
      // timestamp) on top of the graphId + id-list that `getEdgesChunkSize`
      // is budgeted for, so a full chunk would overflow the bind limit by 1.
      // Reserve a slot for the timestamp. The hard-delete batch below has no
      // such extra bind and keeps the full chunk size.
      const softDeleteChunkSize = Math.max(
        1,
        batchConfig.getEdgesChunkSize - 1,
      );
      for (const chunk of chunkArray(params.ids, softDeleteChunkSize)) {
        const query = operationStrategy.buildDeleteEdgesBatch(
          { graphId: params.graphId, ids: chunk },
          timestamp,
        );
        await execution.execRun(query);
      }
    },

    async hardDeleteEdgesBatch(params: DeleteEdgesBatchParams): Promise<void> {
      if (params.ids.length === 0) return;
      for (const chunk of chunkArray(
        params.ids,
        batchConfig.getEdgesChunkSize,
      )) {
        const query = operationStrategy.buildHardDeleteEdgesBatch({
          graphId: params.graphId,
          ids: chunk,
        });
        await execution.execRun(query);
      }
    },

    async countEdgesFrom(params: CountEdgesFromParams): Promise<number> {
      const query = operationStrategy.buildCountEdgesFrom(params);
      const row = await execution.execGet<{ count: string | number }>(query);
      return Number(row?.count ?? 0);
    },

    async edgeExistsBetween(params: EdgeExistsBetweenParams): Promise<boolean> {
      const query = operationStrategy.buildEdgeExistsBetween(params);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row !== undefined;
    },

    async findEdgesConnectedTo(
      params: FindEdgesConnectedToParams,
    ): Promise<readonly EdgeRow[]> {
      const query = operationStrategy.buildFindEdgesConnectedTo(params);
      const rows = await execution.execAll<Record<string, unknown>>(query);
      return rows.map((row) => rowMappers.toEdgeRow(row));
    },

    async findNodesByKind(
      params: FindNodesByKindParams,
    ): Promise<readonly NodeRow[]> {
      const query = operationStrategy.buildFindNodesByKind(params);
      const rows = await execution.execAll<Record<string, unknown>>(query);
      return rows.map((row) => rowMappers.toNodeRow(row));
    },

    async countNodesByKind(params: CountNodesByKindParams): Promise<number> {
      const query = operationStrategy.buildCountNodesByKind(params);
      const row = await execution.execGet<{ count: string | number }>(query);
      return Number(row?.count ?? 0);
    },

    async findEdgesByKind(
      params: FindEdgesByKindParams,
    ): Promise<readonly EdgeRow[]> {
      const query = operationStrategy.buildFindEdgesByKind(params);
      const rows = await execution.execAll<Record<string, unknown>>(query);
      return rows.map((row) => rowMappers.toEdgeRow(row));
    },

    async findEdgesByEndpointSet(
      params: FindEdgesByEndpointSetParams,
    ): Promise<readonly EdgeRow[]> {
      const ids = resolveEdgeEndpointIds(params);
      // Each endpoint id lands in exactly one chunk (the set is deduped), so
      // every endpoint's rows come back from a single statement in that
      // statement's order — the per-endpoint ordering and `limitPerEndpoint`
      // cap therefore hold across the whole read even though the concatenated
      // result is only globally ordered when one chunk covers the set.
      const edgeRows: EdgeRow[] = [];
      for (const idChunk of chunkArray(
        ids,
        batchConfig.findEdgesEndpointChunkSize,
      )) {
        const query = operationStrategy.buildFindEdgesByEndpointSet(
          params,
          idChunk,
        );
        const rows = await execution.execAll<Record<string, unknown>>(query);
        for (const row of rows) edgeRows.push(rowMappers.toEdgeRow(row));
      }
      return edgeRows;
    },

    async findEdgesByHeterogeneousEndpointSet(
      params: FindEdgesByHeterogeneousEndpointSetParams,
    ): Promise<readonly EdgeRow[]> {
      const { edgeKinds, endpoints, endpointChunkSize } =
        resolveHeterogeneousEdgeRead(params, maxBindParameters);
      if (edgeKinds.length === 0 || endpoints.length === 0) return [];

      const edgeRows: EdgeRow[] = [];
      for (const endpointChunk of chunkArray(endpoints, endpointChunkSize)) {
        const query =
          operationStrategy.buildFindEdgesByHeterogeneousEndpointSet(
            params,
            endpointChunk,
            edgeKinds,
          );
        const rows = await execution.execAll<Record<string, unknown>>(query);
        for (const row of rows) edgeRows.push(rowMappers.toEdgeRow(row));
      }
      return edgeRows;
    },

    async countEdgesByKind(params: CountEdgesByKindParams): Promise<number> {
      const query = operationStrategy.buildCountEdgesByKind(params);
      const row = await execution.execGet<{ count: string | number }>(query);
      return Number(row?.count ?? 0);
    },

    async insertUnique(params: InsertUniqueParams): Promise<void> {
      const query = operationStrategy.buildInsertUnique(params);
      const result = await execution.execGet<{
        node_id: string;
        concrete_kind: string;
      }>(query);

      if (
        result &&
        !isSameClaimOwner(
          { concreteKind: result.concrete_kind, nodeId: result.node_id },
          claimOwnerOf(params),
        )
      ) {
        throw new UniquenessError({
          constraintName: params.constraintName,
          // The holder's own kind, never `nodeKind`: that column carries the
          // claim AXIS, which a shared scope folds across kinds, so it need not
          // be the holder's kind and usually is not.
          kind: result.concrete_kind,
          existingId: result.node_id,
          newId: params.nodeId,
          fields: [],
          // The axis THIS statement attempted — `mapClaimRefusal`'s only way to
          // tell two disjoint pairs (or two scoped constraints) sharing a key
          // apart, since `constraintName` alone does not.
          axis: params.nodeKind,
        });
      }
    },

    async insertUniqueBatch(
      entries: readonly InsertUniqueParams[],
    ): Promise<void> {
      if (entries.length === 0) return;

      // A multi-row upsert cannot affect one row twice, so collapse exact
      // duplicates and reject two entries claiming the same conflict target
      // for different OWNERS up front. Comparing ids alone would dedupe a
      // namesake under another kind into the first entry's claim and accept
      // both — the in-statement twin of the conflict the row-level arms refuse.
      // Batch validation pre-rejects real conflicts, so this is a defensive
      // invariant, not a semantic path.
      const targetKey = (entry: InsertUniqueParams): string =>
        `${entry.nodeKind}\u0000${entry.constraintName}\u0000${entry.key}`;
      const byTarget = new Map<string, InsertUniqueParams>();
      for (const entry of entries) {
        const existing = byTarget.get(targetKey(entry));
        if (existing === undefined) {
          byTarget.set(targetKey(entry), entry);
          continue;
        }
        if (!isSameClaimOwner(claimOwnerOf(existing), claimOwnerOf(entry))) {
          throw new UniquenessError({
            constraintName: entry.constraintName,
            kind: existing.concreteKind,
            existingId: existing.nodeId,
            newId: entry.nodeId,
            fields: [],
            axis: entry.nodeKind,
          });
        }
      }
      const deduped = [...byTarget.values()];

      for (const chunk of chunkArray(
        deduped,
        batchConfig.uniqueInsertBatchSize,
      )) {
        const query = operationStrategy.buildInsertUniqueBatch(chunk);
        const rows = await execution.execAll<{
          node_kind: string;
          constraint_name: string;
          key: string;
          node_id: string;
          concrete_kind: string;
        }>(query);
        const ownerByTarget = new Map<string, ClaimOwner>(
          rows.map((row) => [
            `${row.node_kind}\u0000${row.constraint_name}\u0000${row.key}`,
            { concreteKind: row.concrete_kind, nodeId: row.node_id },
          ]),
        );
        for (const entry of chunk) {
          const owner = ownerByTarget.get(targetKey(entry));
          if (
            owner !== undefined &&
            !isSameClaimOwner(owner, claimOwnerOf(entry))
          ) {
            throw new UniquenessError({
              constraintName: entry.constraintName,
              kind: owner.concreteKind,
              existingId: owner.nodeId,
              newId: entry.nodeId,
              fields: [],
              axis: entry.nodeKind,
            });
          }
        }
      }
    },

    async deleteUnique(params: DeleteUniqueParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildDeleteUnique(params, timestamp);
      await execution.execRun(query);
    },

    async hardDeleteUniquesByNodeIds(
      params: HardDeleteUniquesByNodeIdsParams,
    ): Promise<void> {
      const nodeIds = [...new Set(params.nodeIds)];
      for (const chunk of chunkArray(
        nodeIds,
        batchConfig.uniqueDeleteChunkSize,
      )) {
        const query = operationStrategy.buildHardDeleteUniquesByNodeIds({
          ...params,
          nodeIds: chunk,
        });
        await execution.execRun(query);
      }
    },

    async hardDeleteUniquesByConcreteKind(
      params: HardDeleteUniquesByConcreteKindParams,
    ): Promise<void> {
      const query =
        operationStrategy.buildHardDeleteUniquesByConcreteKind(params);
      await execution.execRun(query);
    },

    async claimEdgeCardinality(
      params: ClaimEdgeCardinalityParams,
    ): Promise<EdgeClaimOutcome> {
      const [outcome] = await claimEdgeCardinalityEntries([params]);
      return outcome ?? { status: "claimed" };
    },

    claimEdgeCardinalityGuarded,

    claimEdgeCardinalityBatch(
      entries: readonly ClaimEdgeCardinalityParams[],
    ): Promise<readonly EdgeClaimOutcome[]> {
      return claimEdgeCardinalityEntries(entries);
    },

    async purgeEdgeClaims(params: PurgeEdgeClaimsParams): Promise<void> {
      const edgeIds = [...new Set(params.edgeIds)];
      // One claim row per edge at most, so the edge-read chunk budget is the
      // right ceiling for a list of edge ids.
      for (const chunk of chunkArray(edgeIds, batchConfig.getEdgesChunkSize)) {
        const query = operationStrategy.buildPurgeEdgeClaims({
          ...params,
          edgeIds: chunk,
        });
        await execution.execRun(query);
      }
    },

    async readConstraintFenceViolations(
      params: ReadConstraintFenceViolationsParams,
    ): Promise<ConstraintFenceViolationRows> {
      const uniqueRows =
        params.uniqueConstraintNames.length === 0 ?
          []
        : await execution.execAll<{
            node_kind: string;
            constraint_name: string;
            key: string;
            concrete_kind: string;
            node_id: string;
          }>(
            operationStrategy.buildContendedUniqueRowAudit(
              params.graphId,
              params.uniqueConstraintNames,
            ),
          );
      const contendedUniqueRows = uniqueRows.map((row) => ({
        nodeKind: row.node_kind,
        constraintName: row.constraint_name,
        key: row.key,
        concreteKind: row.concrete_kind,
        nodeId: row.node_id,
      }));

      // One statement per declared cardinality, because that is the
      // granularity at which the population's key and liveness differ.
      const edgeKindsByCardinality = new Map<
        ConstrainedCardinality,
        string[]
      >();
      for (const declaration of params.edgeCardinalities) {
        const kinds = edgeKindsByCardinality.get(declaration.cardinality) ?? [];
        kinds.push(declaration.edgeKind);
        edgeKindsByCardinality.set(declaration.cardinality, kinds);
      }
      const contendedEdgeRows: ContendedEdgeRow[] = [];
      for (const [cardinality, edgeKinds] of edgeKindsByCardinality) {
        const rows = await execution.execAll<{
          edge_id: string;
          edge_kind: string;
          from_kind: string;
          from_id: string;
          to_kind: string;
          to_id: string;
        }>(
          operationStrategy.buildContendedEdgeRowAudit(
            params.graphId,
            cardinality,
            edgeKinds,
          ),
        );
        for (const row of rows) {
          contendedEdgeRows.push({
            edgeKind: row.edge_kind,
            cardinality,
            edgeId: row.edge_id,
            fromKind: row.from_kind,
            fromId: row.from_id,
            toKind: row.to_kind,
            toId: row.to_id,
          });
        }
      }

      const disjointOverlaps: DisjointOverlapRow[] = [];
      for (const kinds of params.disjointKindPairs) {
        const rows = await execution.execAll<{ node_id: string }>(
          operationStrategy.buildDisjointOverlapAudit(params.graphId, kinds),
        );
        for (const row of rows)
          disjointOverlaps.push({ kinds, nodeId: row.node_id });
      }

      return { contendedUniqueRows, contendedEdgeRows, disjointOverlaps };
    },

    async checkUnique(
      params: CheckUniqueParams,
    ): Promise<UniqueRow | undefined> {
      const query = operationStrategy.buildCheckUnique(params);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toUniqueRow(row) : undefined;
    },

    async checkUniqueBatch(
      params: CheckUniqueBatchParams,
    ): Promise<readonly UniqueRow[]> {
      if (params.keys.length === 0) return [];
      const allRows: UniqueRow[] = [];
      for (const chunk of chunkArray(
        params.keys,
        batchConfig.checkUniqueBatchChunkSize,
      )) {
        const query = operationStrategy.buildCheckUniqueBatch({
          ...params,
          keys: chunk,
        });
        const rows = await execution.execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => rowMappers.toUniqueRow(row)));
      }
      return allRows;
    },

    async getActiveSchema(
      graphId: string,
    ): Promise<SchemaVersionRow | undefined> {
      const query = operationStrategy.buildGetActiveSchema(graphId);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toSchemaVersionRow(row) : undefined;
    },

    async getSchemaVersion(
      graphId: string,
      version: number,
    ): Promise<SchemaVersionRow | undefined> {
      const query = operationStrategy.buildGetSchemaVersion(graphId, version);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toSchemaVersionRow(row) : undefined;
    },

    async commitSchemaVersion(
      params: CommitSchemaVersionParams,
    ): Promise<SchemaVersionRow> {
      // The top-level backend wraps this method in a transaction with
      // appropriate write-locking (BEGIN IMMEDIATE on SQLite,
      // pg_advisory_xact_lock on Postgres) so the read-then-write
      // sequence below is serialized against concurrent commits.

      const existingRaw = await execution.execGet<Record<string, unknown>>(
        operationStrategy.buildGetSchemaVersion(params.graphId, params.version),
      );
      const actualActiveVersion = await readActiveVersion(params.graphId);

      // Same-version-different-hash → content conflict. Always wins
      // over CAS: a hash disagreement is operator-intervention
      // territory regardless of which writer "got there first."
      if (existingRaw !== undefined) {
        const existing = rowMappers.toSchemaVersionRow(existingRaw);
        if (existing.schema_hash !== params.schemaHash) {
          throw new SchemaContentConflictError({
            graphId: params.graphId,
            version: params.version,
            existingHash: existing.schema_hash,
            incomingHash: params.schemaHash,
          });
        }
        // Same-version-same-hash already active → idempotent success.
        // Skips the CAS intentionally: same hash means identical
        // content, so there's no disagreement for the caller to refetch.
        if (existing.is_active) {
          return existing;
        }
        // Same-version-same-hash but inactive: orphan row left by a
        // crashed earlier commit. Reactivation requires CAS because
        // we're about to flip the active pointer — fall through.
        verifyExpectedActiveVersion(
          params.graphId,
          params.expected,
          actualActiveVersion,
        );
        const reactivate = operationStrategy.buildSetActiveSchema(
          params.graphId,
          params.version,
        );
        await execution.execRun(reactivate.deactivateAll);
        await execution.execRun(reactivate.activateVersion);
        // Project the result instead of re-SELECTing: the partial
        // unique index guarantees this is the only active row for the
        // graph after the UPDATEs above.
        return { ...existing, is_active: true };
      }

      verifyExpectedActiveVersion(
        params.graphId,
        params.expected,
        actualActiveVersion,
      );

      // Fresh insert path. For the "active" expected case, deactivate
      // the prior active row first so the partial unique index (one
      // active per graph) is satisfied at every statement boundary.
      // The "initial" case has no prior active, so skip.
      //
      // `tests/backends/postgres/schema-write-fence-race.test.ts` reproduces
      // this ordering by hand to hold a flip uncommitted; changing it there
      // too keeps the Postgres write fence's race coverage honest.
      if (params.expected.kind === "active") {
        const flip = operationStrategy.buildSetActiveSchema(
          params.graphId,
          params.version,
        );
        await execution.execRun(flip.deactivateAll);
      }

      const timestamp = nowIso();
      const insertQuery = operationStrategy.buildInsertSchema(
        {
          graphId: params.graphId,
          version: params.version,
          schemaHash: params.schemaHash,
          schemaDoc: params.schemaDoc,
          isActive: true,
        },
        timestamp,
      );
      const insertedRaw =
        await execution.execGet<Record<string, unknown>>(insertQuery);
      if (!insertedRaw) {
        throw new DatabaseOperationError(
          "Insert schema failed: no row returned",
          { operation: "insert", entity: "schema" },
        );
      }
      return rowMappers.toSchemaVersionRow(insertedRaw);
    },

    async setActiveVersion(params: SetActiveVersionParams): Promise<void> {
      const actualActiveVersion = await readActiveVersion(params.graphId);
      verifyExpectedActiveVersion(
        params.graphId,
        params.expected,
        actualActiveVersion,
      );

      const targetRaw = await execution.execGet<Record<string, unknown>>(
        operationStrategy.buildGetSchemaVersion(params.graphId, params.version),
      );
      if (!targetRaw) {
        throw new MigrationError(
          `Cannot activate version ${params.version}: version does not exist for graph "${params.graphId}".`,
          {
            graphId: params.graphId,
            fromVersion: actualActiveVersion,
            toVersion: params.version,
            reason: "version-not-found",
          },
        );
      }

      const queries = operationStrategy.buildSetActiveSchema(
        params.graphId,
        params.version,
      );
      await execution.execRun(queries.deactivateAll);
      await execution.execRun(queries.activateVersion);
    },

    async clearGraph(graphId: string): Promise<void> {
      const statements = operationStrategy.buildClearGraph(graphId);
      for (const statement of statements) {
        await runIgnorableClearStatement(statement);
      }
    },
  };
}
