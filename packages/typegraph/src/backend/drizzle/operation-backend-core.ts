import { is, type SQL, sql as drizzleSql } from "drizzle-orm";

import {
  CompilerInvariantError,
  ConfigurationError,
  DatabaseOperationError,
  DisjointError,
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
import {
  type ClaimOwner,
  compareClaimTargets,
  isSameClaimOwner,
} from "../../store/claims/axis";
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
  type AtomicDeleteBatchResult,
  AtomicEdgeBatchCardinalityRefusalError,
  type AtomicEdgeBatchCountInput,
  AtomicEdgeBatchEndpointRefusalError,
  type AtomicEdgeBatchExecutor,
  type AtomicEdgeBatchRowsInput,
  type AtomicEdgeConvergenceInput,
  type AtomicEdgeConvergenceResult,
  AtomicEdgeConvergenceTombstoneRefusalError,
  type AtomicEdgeDeleteBatchExecutor,
  type AtomicEdgeDeleteBatchInput,
  AtomicEdgeDeleteIdentityRefusalError,
  type AtomicEdgeMutationProgramExecutor,
  type AtomicEdgeResolvedMutationSetInput,
  type AtomicEdgeResolvedMutationSetResult,
  type AtomicEdgeResolvedUpdateBatchExecutor,
  type AtomicEdgeResolvedUpdateEntry,
  type AtomicNodeBatchEntry,
  type AtomicNodeBatchExecutor,
  type AtomicNodeBatchInput,
  atomicNodeClaimInputCost,
  type AtomicNodeClaimSupport,
  type AtomicNodeDeleteBatchExecutor,
  type AtomicNodeDeleteBatchInput,
  AtomicNodeDeleteRestrictedRefusalError,
  type AtomicNodePostimageEntry,
  type AtomicNodeProjectionSupport,
  type AtomicNodeReplacementBatchExecutor,
  type AtomicNodeReplacementEntry,
  type AtomicNodeResolvedMutationSetExecutor,
  type AtomicNodeResolvedUpdateBatchExecutor,
  type AtomicNodeResolvedUpdateEntry,
  supportsAtomicNodeClaims,
} from "../capabilities/atomic-mutation-program";
import type {
  AtomicSqlProgram,
  AtomicSqlProgramExecutor,
  CompiledAtomicSqlStatement,
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
  CompareAndSetNodeParams,
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
import type {
  AtomicNodeClaimEntry,
  AtomicNodeClaimOwnerRow,
} from "./operations/atomic-node-claims";
import type { AtomicContributionEvidence } from "./operations/contribution-evidence";
import {
  ATOMIC_CONTRIBUTION_ASSERTION_FIXED_BIND_COUNT,
  ATOMIC_CONTRIBUTION_EVIDENCE_BIND_COUNT,
} from "./operations/contribution-evidence";
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
const ATOMIC_EDGE_CONVERGENCE_PARAM_COUNT = 14;
const ATOMIC_EDGE_CONVERGENCE_FIXED_PARAM_COUNT = 2;
const ATOMIC_NODE_CLAIM_INPUT_PARAM_COUNT = 6;
const ATOMIC_NODE_INSERT_PARAM_COUNT = 9;
const ATOMIC_NODE_WRITE_FIXED_PARAM_COUNT = 4;
// The bundled fulltext lowering is the widest projection statement today.
// Compilation below independently refuses any strategy that exceeds the
// resulting budget, so a future strategy cannot silently invalidate this cost.
const ATOMIC_NODE_PROJECTION_FIXED_PARAM_COUNT = 4;
const ATOMIC_NODE_PROJECTION_MAX_PARAM_COUNT_PER_ENTRY = 6;

function chunkAtomicNodeEntriesByIdSource(
  entries: readonly AtomicNodeBatchEntry[],
  chunkSize: number,
): readonly (readonly AtomicNodeBatchEntry[])[] {
  return (["generated", "caller"] as const).flatMap((idSource) =>
    chunkArray(
      entries.filter((entry) => entry.idSource === idSource),
      chunkSize,
    ),
  );
}

function chunkByWeight<T>(
  items: readonly T[],
  maxWeight: number,
  weightOf: (item: T) => number,
): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentWeight = 0;
  for (const item of items) {
    const weight = weightOf(item);
    if (weight > maxWeight) {
      throw new CompilerInvariantError(
        "An atomic program member exceeded its declared bind budget.",
        { weight, maxWeight },
      );
    }
    if (current.length > 0 && currentWeight + weight > maxWeight) {
      chunks.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(item);
    currentWeight += weight;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function chunkAtomicNodeEntriesByClaimWork(
  entries: readonly AtomicNodeBatchEntry[],
  maxBindParameters: number,
): readonly (readonly AtomicNodeBatchEntry[])[] {
  const available = maxBindParameters - ATOMIC_NODE_WRITE_FIXED_PARAM_COUNT;
  return (["generated", "caller"] as const).flatMap((idSource) =>
    chunkByWeight(
      entries.filter((entry) => entry.idSource === idSource),
      available,
      (entry) =>
        ATOMIC_NODE_INSERT_PARAM_COUNT +
        atomicNodeClaimInputCost(entry.claims ?? []),
    ),
  );
}

function chunkAtomicNodeReplacementEntriesByClaimWork(
  entries: readonly AtomicNodeReplacementEntry[],
  maxBindParameters: number,
): readonly (readonly AtomicNodeReplacementEntry[])[] {
  const available = maxBindParameters - ATOMIC_NODE_WRITE_FIXED_PARAM_COUNT;
  return chunkByWeight(
    entries,
    available,
    (entry) =>
      ATOMIC_NODE_INSERT_PARAM_COUNT +
      atomicNodeClaimInputCost(entry.claims ?? []),
  );
}

/** Maximum plain replacement members whose chunks fit one atomic submission. */
export function atomicNodeReplacementSubmissionMaxEntries(
  maxBindParameters: number,
): number {
  const entriesPerStatement = Math.max(
    1,
    Math.floor(
      (maxBindParameters - ATOMIC_NODE_WRITE_FIXED_PARAM_COUNT) /
        ATOMIC_NODE_INSERT_PARAM_COUNT,
    ),
  );
  return Math.min(
    ATOMIC_RESOLVED_MUTATION_MAX_MEMBERS,
    atomicResolvedMutationSubmissionMaxEntries(entriesPerStatement),
  );
}

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

function assertResolvedNodeUpdateBatchInput(
  entries: readonly AtomicNodeResolvedUpdateEntry[],
  schemaFence: SchemaWriteFenceParams,
): void {
  const first = entries[0];
  if (first === undefined) return;
  const ids = new Set<string>();
  for (const entry of entries) {
    if (
      entry.graphId !== first.graphId ||
      entry.kind !== first.kind ||
      entry.graphId !== schemaFence.graphId ||
      ids.has(entry.id)
    ) {
      throw new CompilerInvariantError(
        "An atomic resolved node update requires distinct ids from one fenced graph and kind.",
        {
          expected: {
            graphId: first.graphId,
            kind: first.kind,
            fenceGraphId: schemaFence.graphId,
          },
          actual: { graphId: entry.graphId, kind: entry.kind, id: entry.id },
        },
      );
    }
    ids.add(entry.id);
  }
}

function assertResolvedEdgeUpdateBatchInput(
  entries: readonly AtomicEdgeResolvedUpdateEntry[],
  schemaFence: SchemaWriteFenceParams,
): void {
  const first = entries[0];
  if (first === undefined) return;
  const graphId = first.existing.graph_id;
  const kind = first.existing.kind;
  const ids = new Set<string>();
  for (const entry of entries) {
    const existing = entry.existing;
    if (
      existing.graph_id !== graphId ||
      existing.graph_id !== schemaFence.graphId ||
      existing.kind !== kind ||
      ids.has(existing.id)
    ) {
      throw new CompilerInvariantError(
        "An atomic resolved edge update requires distinct ids from one fenced graph and kind.",
        {
          expected: { graphId, kind, fenceGraphId: schemaFence.graphId },
          actual: {
            graphId: existing.graph_id,
            kind: existing.kind,
            id: existing.id,
          },
        },
      );
    }
    ids.add(existing.id);
  }
}

function assertResolvedNodeMutationSetInput(
  creates: readonly AtomicNodeBatchEntry[],
  updates: readonly AtomicNodeResolvedUpdateEntry[],
  schemaFence: SchemaWriteFenceParams,
): void {
  if (creates.length === 0 || updates.length === 0) {
    throw new CompilerInvariantError(
      "An atomic resolved node mutation set requires both creates and updates.",
    );
  }
  assertMatchingNodeSchemaFences(
    creates.map((entry) => entry.params),
    schemaFence,
  );
  assertResolvedNodeUpdateBatchInput(updates, schemaFence);
  const identities = [
    ...creates.map((entry) => ({
      graphId: entry.params.graphId,
      kind: entry.params.kind,
      id: entry.params.id,
    })),
    ...updates,
  ];
  const first = identities[0];
  if (first === undefined) return;
  const ids = new Set<string>();
  for (const identity of identities) {
    if (
      identity.graphId !== first.graphId ||
      identity.kind !== first.kind ||
      identity.graphId !== schemaFence.graphId ||
      ids.has(identity.id)
    ) {
      throw new CompilerInvariantError(
        "An atomic resolved node mutation set requires distinct ids from one fenced graph and kind.",
      );
    }
    ids.add(identity.id);
  }
  if (
    creates.some(
      (entry) => entry.idSource !== "caller" || (entry.claims?.length ?? 0) > 0,
    )
  ) {
    throw new CompilerInvariantError(
      "An atomic resolved node mutation set accepts only unclaimed caller-id creates.",
    );
  }
}

function assertResolvedEdgeMutationSetInput(
  creates: readonly InsertEdgeParams[],
  updates: readonly AtomicEdgeResolvedUpdateEntry[],
  schemaFence: SchemaWriteFenceParams,
): void {
  if (creates.length === 0 || updates.length === 0) {
    throw new CompilerInvariantError(
      "An atomic resolved edge mutation set requires both creates and updates.",
    );
  }
  assertMatchingEdgeSchemaFences(creates, schemaFence);
  assertResolvedEdgeUpdateBatchInput(updates, schemaFence);
  const identities = [
    ...creates.map((entry) => ({
      graphId: entry.graphId,
      kind: entry.kind,
      id: entry.id,
    })),
    ...updates.map((entry) => ({
      graphId: entry.existing.graph_id,
      kind: entry.existing.kind,
      id: entry.existing.id,
    })),
  ];
  const first = identities[0];
  if (first === undefined) return;
  const ids = new Set<string>();
  for (const identity of identities) {
    if (
      identity.graphId !== first.graphId ||
      identity.kind !== first.kind ||
      identity.graphId !== schemaFence.graphId ||
      ids.has(identity.id)
    ) {
      throw new CompilerInvariantError(
        "An atomic resolved edge mutation set requires distinct ids from one fenced graph and kind.",
      );
    }
    ids.add(identity.id);
  }
  if (creates.some((entry) => entry.matchIdentity !== undefined)) {
    throw new CompilerInvariantError(
      "An atomic resolved edge mutation set cannot carry durable match identity.",
    );
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
  | "compareAndSetNode"
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
    executeAtomicNodeReplacementBatch?: AtomicNodeReplacementBatchExecutor;
    executeAtomicNodeDeleteBatch?: AtomicNodeDeleteBatchExecutor;
    executeAtomicNodeResolvedUpdateBatch?: AtomicNodeResolvedUpdateBatchExecutor;
    executeAtomicNodeResolvedMutationSet?: AtomicNodeResolvedMutationSetExecutor;
    executeAtomicEdgeBatch?: AtomicEdgeBatchExecutor;
    executeAtomicEdgeDeleteBatch?: AtomicEdgeDeleteBatchExecutor;
    executeAtomicEdgeResolvedUpdateBatch?: AtomicEdgeResolvedUpdateBatchExecutor;
    executeAtomicEdgeMutationProgram?: AtomicEdgeMutationProgramExecutor;
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
  /** Local signature evidence compiled into an atomic projection program. */
  resolveAtomicNodeProjectionEvidence?:
    | ((
        creates: readonly AtomicNodePostimageEntry[],
        updates: readonly AtomicNodeResolvedUpdateEntry[],
      ) => Promise<readonly AtomicContributionEvidence[]>)
    | undefined;
  /** Failure-only durable marker diagnosis after an atomic refusal rolls back. */
  diagnoseAtomicNodeProjectionEvidence?:
    | ((
        creates: readonly AtomicNodePostimageEntry[],
        updates: readonly AtomicNodeResolvedUpdateEntry[],
      ) => Promise<void>)
    | undefined;
  /** Maps physical projection failures without weakening row classifications. */
  refuseAtomicNodeProjectionError?:
    | ((
        creates: readonly AtomicNodePostimageEntry[],
        updates: readonly AtomicNodeResolvedUpdateEntry[],
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

type AtomicEdgeConvergenceLowerer = Readonly<{
  maxEntries: number;
}> &
  ((
    input: Omit<AtomicEdgeConvergenceInput, "kind">,
  ) => Promise<readonly AtomicEdgeConvergenceResult[]>);

type AtomicEdgeResolvedMutationSetLowerer = Readonly<{
  maxEntries: number;
}> &
  ((
    input: Omit<AtomicEdgeResolvedMutationSetInput, "kind">,
  ) => Promise<AtomicEdgeResolvedMutationSetResult>);

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

async function withAtomicEdgeDeleteIdentityRefusalClassification<T>(
  run: () => Promise<T>,
  constraint: Readonly<{ table: string; column: string }>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isNotNullColumnViolation(error, constraint)) {
      throw new AtomicEdgeDeleteIdentityRefusalError(error);
    }
    throw error;
  }
}

async function withAtomicNodeDeleteRestrictionClassification<T>(
  run: () => Promise<T>,
  constraint: Readonly<{ table: string; column: string }>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isNotNullColumnViolation(error, constraint)) {
      throw new AtomicNodeDeleteRestrictedRefusalError(error);
    }
    throw error;
  }
}

type AtomicDeleteSlotResult =
  | Readonly<{ kind: "affected"; count: number }>
  | Readonly<{ kind: "claim-release" }>
  | Readonly<{ kind: "fence"; matched: boolean }>;

function assembleAtomicDeleteBatchResult(
  results: readonly AtomicDeleteSlotResult[],
): AtomicDeleteBatchResult {
  let fenceResult: Readonly<{ kind: "fence"; matched: boolean }> | undefined;
  let affectedCount = 0;
  for (const result of results) {
    if (result.kind === "affected") {
      affectedCount += result.count;
      continue;
    }
    if (result.kind === "claim-release") continue;
    if (fenceResult !== undefined) {
      throw new CompilerInvariantError(
        "Atomic delete program returned more than one schema-fence result.",
      );
    }
    fenceResult = result;
  }
  if (fenceResult === undefined) {
    throw new CompilerInvariantError(
      "Atomic delete program omitted its schema-fence result.",
    );
  }
  return {
    affectedCount,
    schemaFenceMatched: fenceResult.matched,
  };
}

type AtomicResolvedMutationSlot<TRow> =
  | Readonly<{ kind: "created"; rows: readonly TRow[] }>
  | Readonly<{ kind: "updated"; rows: readonly TRow[] }>
  | Readonly<{ kind: "postimages"; rows: readonly TRow[] }>
  | Readonly<{ kind: "projection" }>
  | Readonly<{ kind: "assertion" }>;

// A native submission is one transport request and one rollback boundary, so
// per-statement bind safety is necessary but not sufficient. Bound the number
// of mutation statements as well: a mixed set can spend one partial chunk on
// each side, hence K - 1 full chunks plus one member is the largest total that
// can never exceed K mutation statements. The absolute member ceiling keeps a
// high-bind PostgreSQL backend from turning the same contract into an enormous
// HTTP request merely because one SQL statement can carry many parameters.
const ATOMIC_MUTATION_MAX_MUTATION_STATEMENTS = 32;
const ATOMIC_RESOLVED_MUTATION_MAX_MEMBERS = 512;
const ATOMIC_RESOLVED_MUTATION_FIXED_PARAM_COUNT = 12;
const ATOMIC_NODE_RESOLVED_MUTATION_PARAMS_PER_ENTRY = 5;
const ATOMIC_EDGE_RESOLVED_MUTATION_PARAMS_PER_ENTRY = 14;

function atomicResolvedMutationStatementChunkSize(
  maxBindParameters: number,
  parametersPerEntry: number,
): number {
  return Math.max(
    1,
    Math.floor(
      (maxBindParameters - ATOMIC_RESOLVED_MUTATION_FIXED_PARAM_COUNT) /
        parametersPerEntry,
    ),
  );
}

function atomicResolvedMutationSubmissionMaxEntries(
  statementChunkSize: number,
): number {
  return Math.min(
    ATOMIC_RESOLVED_MUTATION_MAX_MEMBERS,
    statementChunkSize * (ATOMIC_MUTATION_MAX_MUTATION_STATEMENTS - 1) + 1,
  );
}

function pairAtomicMutationChunksWithIds<T>(
  chunks: readonly (readonly T[])[],
  ids: readonly string[],
): readonly Readonly<{ entries: readonly T[]; ids: readonly string[] }>[] {
  let offset = 0;
  return chunks.map((entries) => {
    const chunkIds = ids.slice(offset, offset + entries.length);
    offset += entries.length;
    return { entries, ids: chunkIds };
  });
}

function assembleAtomicResolvedMutationSet<TRow>(
  entity: "node" | "edge",
  results: readonly AtomicResolvedMutationSlot<TRow>[],
  createIds: readonly string[],
  updateIds: readonly string[],
  rowId: (row: TRow) => string,
  terminalCount: number,
): Readonly<{ created: readonly TRow[]; updated: readonly TRow[] }> {
  const assertionCount = results.filter(
    (result) => result.kind === "assertion",
  ).length;
  const postimageSlots = results.filter(
    (result) => result.kind === "postimages",
  );
  if (
    assertionCount !== terminalCount ||
    postimageSlots.length !== terminalCount
  ) {
    throw new CompilerInvariantError(
      `Atomic ${entity} mutation set returned an invalid terminal result.`,
      { assertions: assertionCount, postimages: postimageSlots.length },
    );
  }

  const postimages = postimageSlots.flatMap((slot) => slot.rows);
  if (postimages.length !== createIds.length + updateIds.length) {
    const mutationRows = results.flatMap((result) =>
      result.kind === "created" || result.kind === "updated" ? result.rows : [],
    );
    if (mutationRows.length > 0) {
      throw new CompilerInvariantError(
        `Atomic ${entity} mutation assertion allowed an incomplete postimage set.`,
      );
    }
    return { created: [], updated: [] };
  }

  const expectedIds = new Set([...createIds, ...updateIds]);
  const byId = new Map<string, TRow>();
  for (const row of postimages) {
    const id = rowId(row);
    if (!expectedIds.has(id)) {
      throw new CompilerInvariantError(
        `Atomic ${entity} mutation set returned a postimage outside its input set.`,
        { id },
      );
    }
    if (byId.has(id)) {
      throw new CompilerInvariantError(
        `Atomic ${entity} mutation set returned a duplicate postimage.`,
        { id },
      );
    }
    byId.set(id, row);
  }
  return {
    created: createIds.map((id) => requireDefined(byId.get(id))),
    updated: updateIds.map((id) => requireDefined(byId.get(id))),
  };
}

function buildAtomicResolvedMutationSetProgram<TRow, TCreate, TUpdate>(
  input: Readonly<{
    entity: "node" | "edge";
    createChunks: readonly (readonly TCreate[])[];
    updateChunks: readonly (readonly TUpdate[])[];
    createIds: readonly string[];
    updateIds: readonly string[];
    compileCreate: (chunk: readonly TCreate[]) => CompiledAtomicSqlStatement;
    compileUpdate: (updates: readonly TUpdate[]) => CompiledAtomicSqlStatement;
    compiledSidecars?: readonly CompiledAtomicSqlStatement[];
    compileAssertion: (
      creates: readonly TCreate[],
      updates: readonly TUpdate[],
    ) => CompiledAtomicSqlStatement;
    compilePostimages: (ids: readonly string[]) => CompiledAtomicSqlStatement;
    decodeRow: (row: Readonly<Record<string, unknown>>) => TRow;
    rowId: (row: TRow) => string;
  }>,
): AtomicSqlProgram<
  AtomicResolvedMutationSlot<TRow>,
  Readonly<{ created: readonly TRow[]; updated: readonly TRow[] }>
> {
  const createSlots = input.createChunks.map((chunk) => ({
    statement: input.compileCreate(chunk),
    cardinality: "many" as const,
    decode: (rows: readonly Readonly<Record<string, unknown>>[]) => ({
      kind: "created" as const,
      rows: rows.map((row) => input.decodeRow(row)),
    }),
  }));
  const updateSlots = input.updateChunks.map((updates) => ({
    statement: input.compileUpdate(updates),
    cardinality: "many" as const,
    decode: (rows: readonly Readonly<Record<string, unknown>>[]) => ({
      kind: "updated" as const,
      rows: rows.map((row) => input.decodeRow(row)),
    }),
  }));
  const terminals = [
    ...pairAtomicMutationChunksWithIds(input.createChunks, input.createIds).map(
      (chunk) => ({
        creates: chunk.entries,
        updates: [] as readonly TUpdate[],
        ids: chunk.ids,
      }),
    ),
    ...pairAtomicMutationChunksWithIds(input.updateChunks, input.updateIds).map(
      (chunk) => ({
        creates: [] as readonly TCreate[],
        updates: chunk.entries,
        ids: chunk.ids,
      }),
    ),
  ];
  return {
    slots: [
      ...createSlots,
      ...updateSlots,
      ...(input.compiledSidecars ?? []).map((statement) => ({
        statement,
        cardinality: "none" as const,
        decode: () => ({ kind: "projection" as const }),
      })),
      ...terminals.map((terminal) => ({
        statement: input.compileAssertion(terminal.creates, terminal.updates),
        cardinality: "none" as const,
        decode: () => ({ kind: "assertion" as const }),
      })),
      ...terminals.map((terminal) => ({
        statement: input.compilePostimages(terminal.ids),
        cardinality: "many" as const,
        decode: (rows: readonly Readonly<Record<string, unknown>>[]) => ({
          kind: "postimages" as const,
          rows: rows.map((row) => input.decodeRow(row)),
        }),
      })),
    ],
    assemble: (results) =>
      assembleAtomicResolvedMutationSet(
        input.entity,
        results,
        input.createIds,
        input.updateIds,
        input.rowId,
        terminals.length,
      ),
  };
}

type AtomicNodeProjectionSlot = Readonly<{ kind: "projection" }>;

function compileAtomicNodeProjectionSlots(
  operationStrategy: CommonOperationStrategy,
  execution: OperationBackendExecution,
  creates: readonly AtomicNodePostimageEntry[],
  updates: readonly AtomicNodeResolvedUpdateEntry[],
  timestamp: string,
  maxBindParameters: number,
): readonly Readonly<{
  statement: CompiledAtomicSqlStatement;
  cardinality: "none";
  decode: () => AtomicNodeProjectionSlot;
}>[] {
  if (
    !creates.some((entry) => (entry.projections?.length ?? 0) > 0) &&
    !updates.some((entry) => (entry.projections?.length ?? 0) > 0)
  ) {
    return [];
  }
  const chunkSize = Math.max(
    1,
    Math.floor(
      (maxBindParameters - ATOMIC_NODE_PROJECTION_FIXED_PARAM_COUNT) /
        ATOMIC_NODE_PROJECTION_MAX_PARAM_COUNT_PER_ENTRY,
    ),
  );
  const statements = operationStrategy.buildAtomicNodeProjectionStatements(
    creates,
    updates,
    timestamp,
    chunkSize,
  );
  if (statements === undefined) {
    throw new CompilerInvariantError(
      "An eligible atomic node projection family has no dialect lowering.",
    );
  }
  return statements.map((statement) => {
    const compiled = execution.compile(statement);
    if (compiled.params.length > maxBindParameters) {
      throw new CompilerInvariantError(
        "An atomic node projection statement exceeded the backend bind budget.",
        {
          actual: compiled.params.length,
          maximum: maxBindParameters,
        },
      );
    }
    return {
      statement: compiled,
      cardinality: "none" as const,
      decode: () => ({ kind: "projection" as const }),
    };
  });
}

async function compileAtomicNodeProjectionEvidenceSlots(
  operationStrategy: CommonOperationStrategy,
  execution: OperationBackendExecution,
  creates: readonly AtomicNodePostimageEntry[],
  updates: readonly AtomicNodeResolvedUpdateEntry[],
  timestamp: string,
  maxBindParameters: number,
  resolveEvidence:
    | ((
        creates: readonly AtomicNodePostimageEntry[],
        updates: readonly AtomicNodeResolvedUpdateEntry[],
      ) => Promise<readonly AtomicContributionEvidence[]>)
    | undefined,
): Promise<
  readonly Readonly<{
    statement: CompiledAtomicSqlStatement;
    cardinality: "none";
    decode: () => AtomicNodeProjectionSlot;
  }>[]
> {
  if (resolveEvidence === undefined) return [];
  const evidence = await resolveEvidence(creates, updates);
  if (evidence.length === 0) return [];
  const availableBinds =
    maxBindParameters - ATOMIC_CONTRIBUTION_ASSERTION_FIXED_BIND_COUNT;
  const chunkSize = Math.floor(
    availableBinds / ATOMIC_CONTRIBUTION_EVIDENCE_BIND_COUNT,
  );
  if (chunkSize < 1) {
    throw new CompilerInvariantError(
      "Atomic contribution evidence cannot fit the backend bind budget.",
      { maximum: maxBindParameters },
    );
  }
  return chunkArray(evidence, chunkSize).map((evidenceChunk) => {
    const compiled = execution.compile(
      operationStrategy.buildAssertAtomicNodeProjectionEvidence(
        timestamp,
        evidenceChunk,
      ),
    );
    if (compiled.params.length > maxBindParameters) {
      throw new CompilerInvariantError(
        "Atomic contribution evidence exceeded the backend bind budget.",
        { actual: compiled.params.length, maximum: maxBindParameters },
      );
    }
    return {
      statement: compiled,
      cardinality: "none" as const,
      decode: () => ({ kind: "projection" as const }),
    };
  });
}

function isAtomicMutationPostimageRefusal(
  error: unknown,
  operationStrategy: CommonOperationStrategy,
  entity: "node" | "edge",
  hasPostimageAssertion: boolean,
): boolean {
  const notNullConstraint =
    entity === "node" ?
      operationStrategy.atomicNodeRefusalConstraints.mutationPostimage
    : operationStrategy.atomicEdgeRefusalConstraints.mutationPostimage;
  const primaryKeyConstraint =
    entity === "node" ?
      operationStrategy.primaryKeyConstraints.nodes
    : operationStrategy.primaryKeyConstraints.edges;
  return (
    isNotNullColumnViolation(error, notNullConstraint) ||
    (hasPostimageAssertion &&
      isDuplicatePrimaryKeyError(error, primaryKeyConstraint)) ||
    (hasPostimageAssertion &&
      error instanceof DatabaseOperationError &&
      error.details.reason === "duplicate_key" &&
      isDuplicatePrimaryKeyError(error.cause, primaryKeyConstraint))
  );
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
  const durableParams = params.find((item) => item.matchIdentity !== undefined);
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

  async function runAtomicNodeSidecarProgram<TResult>(
    input: Readonly<{
      creates: readonly AtomicNodePostimageEntry[];
      updates: readonly AtomicNodeResolvedUpdateEntry[];
      operation: "insert" | "update" | "upsert";
      hasProjections: boolean;
      hasPostimageAssertion: boolean;
      run: () => Promise<TResult>;
      postimageRefusal?: () => TResult;
    }>,
  ): Promise<TResult> {
    if (!input.hasProjections && input.postimageRefusal === undefined) {
      return input.run();
    }
    try {
      return await input.run();
    } catch (error) {
      const projectionEvidenceRefusal =
        input.hasProjections &&
        isNotNullColumnViolation(
          error,
          operationStrategy.atomicNodeRefusalConstraints.projectionEvidence,
        );
      if (
        input.hasProjections &&
        (projectionEvidenceRefusal || isMissingTableError(error))
      ) {
        await options.diagnoseAtomicNodeProjectionEvidence?.(
          input.creates,
          input.updates,
        );
        if (projectionEvidenceRefusal) {
          throw new DatabaseOperationError(
            "Atomic node projection evidence changed before its refusal could be diagnosed.",
            { operation: input.operation, entity: "node" },
            { cause: error },
          );
        }
      }
      if (
        input.postimageRefusal !== undefined &&
        isAtomicMutationPostimageRefusal(
          error,
          operationStrategy,
          "node",
          input.hasPostimageAssertion,
        )
      ) {
        return input.postimageRefusal();
      }
      if (
        input.hasProjections &&
        options.refuseAtomicNodeProjectionError !== undefined
      ) {
        return options.refuseAtomicNodeProjectionError(
          input.creates,
          input.updates,
          error,
        );
      }
      throw error;
    }
  }

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
        const maxClaimInputCostPerEntry = Math.max(
          0,
          options.maxBindParameters -
            ATOMIC_NODE_WRITE_FIXED_PARAM_COUNT -
            ATOMIC_NODE_INSERT_PARAM_COUNT,
        );
        const claimSupport = Object.freeze({
          families: Object.freeze(["disjointness", "uniqueness"] as const),
          maxInputCostPerEntry: maxClaimInputCostPerEntry,
        } satisfies AtomicNodeClaimSupport);
        const projectionSupport = Object.freeze({
          families: operationStrategy.atomicNodeProjectionFamilies,
        } satisfies AtomicNodeProjectionSupport);

        function orderedAtomicNodeClaims<
          TEntry extends AtomicNodePostimageEntry,
        >(entries: readonly TEntry[]): readonly AtomicNodeClaimEntry<TEntry>[] {
          return entries
            .flatMap((entry, memberOrdinal) =>
              (entry.claims ?? []).map((claim, claimOrdinal) => ({
                memberOrdinal,
                claimOrdinal,
                entry,
                claim,
              })),
            )
            .toSorted((left, right) => {
              return compareClaimTargets(
                {
                  relation: "uniques",
                  graphId: left.entry.params.graphId,
                  axis: left.claim.axis,
                  constraintName: left.claim.constraintName,
                  key: left.claim.key,
                },
                {
                  relation: "uniques",
                  graphId: right.entry.params.graphId,
                  axis: right.claim.axis,
                  constraintName: right.claim.constraintName,
                  key: right.claim.key,
                },
              );
            });
        }

        function atomicNodeClaimTargetKey(
          entry: AtomicNodeClaimEntry<AtomicNodePostimageEntry>,
        ): string {
          return encodeTupleKey([
            entry.claim.axis,
            entry.claim.constraintName,
            entry.claim.key,
          ]);
        }

        function atomicNodeClaimOwnerKey(row: AtomicNodeClaimOwnerRow): string {
          return encodeTupleKey([row.node_kind, row.constraint_name, row.key]);
        }

        type AtomicNodeProgramSlot =
          | Readonly<{
              kind: "claims";
              entries: readonly AtomicNodeClaimEntry<AtomicNodePostimageEntry>[];
              rows: readonly AtomicNodeClaimOwnerRow[];
            }>
          | Readonly<{ kind: "cleanup" }>
          | AtomicNodeProjectionSlot
          | Readonly<{ kind: "assertion" }>
          | Readonly<{
              kind: "counts";
              chunk: readonly AtomicNodePostimageEntry[];
              count: number;
            }>
          | Readonly<{
              kind: "rows";
              chunk: readonly AtomicNodePostimageEntry[];
              rows: readonly NodeRow[];
            }>;

        function classifyAtomicNodeClaimResults(
          claimEntries: readonly AtomicNodeClaimEntry<AtomicNodePostimageEntry>[],
          results: readonly AtomicNodeProgramSlot[],
        ): "stale" | "owned" | DisjointError | UniquenessError {
          const ownerByTarget = new Map<string, ClaimOwner>();
          let returnedClaims = 0;
          for (const result of results) {
            if (result.kind !== "claims") continue;
            returnedClaims += result.rows.length;
            for (const row of result.rows) {
              ownerByTarget.set(atomicNodeClaimOwnerKey(row), {
                concreteKind: row.concrete_kind,
                nodeId: row.node_id,
              });
            }
          }
          if (returnedClaims === 0) return "stale";
          if (returnedClaims !== claimEntries.length) {
            throw new CompilerInvariantError(
              "Atomic node claim program returned a partial claim result.",
              { expected: claimEntries.length, actual: returnedClaims },
            );
          }

          for (const item of claimEntries.toSorted(
            (left, right) =>
              left.memberOrdinal - right.memberOrdinal ||
              left.claimOrdinal - right.claimOrdinal,
          )) {
            const claim = item.claim;
            const owner = ownerByTarget.get(atomicNodeClaimTargetKey(item));
            if (owner === undefined) {
              throw new CompilerInvariantError(
                "Atomic node claim program omitted a claim target.",
                {
                  memberOrdinal: item.memberOrdinal,
                  claimOrdinal: item.claimOrdinal,
                },
              );
            }
            const proposedOwner = {
              concreteKind: item.entry.params.kind,
              nodeId: item.entry.params.id,
            };
            if (!isSameClaimOwner(owner, proposedOwner)) {
              if (claim.verdict.kind === "disjointness") {
                return new DisjointError({
                  nodeId: item.entry.params.id,
                  attemptedKind: item.entry.params.kind,
                  conflictingKind: owner.concreteKind,
                });
              }
              return new UniquenessError({
                constraintName: claim.constraintName,
                kind: owner.concreteKind,
                existingId: owner.nodeId,
                newId: item.entry.params.id,
                fields: claim.verdict.fields,
                axis: claim.axis,
              });
            }
          }
          return "owned";
        }

        function requireAtomicNodeClaimWrite(
          claimEntries: readonly AtomicNodeClaimEntry<AtomicNodePostimageEntry>[],
          results: readonly AtomicNodeProgramSlot[],
          insertedCount: number,
        ): "stale" | "owned" {
          const verdict = classifyAtomicNodeClaimResults(claimEntries, results);
          if (verdict === "owned") return verdict;
          if (insertedCount !== 0) {
            throw new CompilerInvariantError(
              verdict === "stale" ?
                "A stale atomic node claim fence still inserted nodes."
              : "A refused atomic node claim program still inserted nodes.",
            );
          }
          if (
            verdict instanceof UniquenessError ||
            verdict instanceof DisjointError
          ) {
            throw verdict;
          }
          return verdict;
        }

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
          const chunks = chunkAtomicNodeEntriesByIdSource(
            input.entries,
            batchConfig.nodeSchemaFencedInsertBatchSize,
          );
          const atomicExecutor = requireDefined(atomicSqlProgramExecutor);
          const atomicSchemaFenceLockClause = requireDefined(
            schemaFenceLockClause,
          );
          const claimEntries = orderedAtomicNodeClaims(input.entries);
          if (claimEntries.length > 0) {
            if (
              input.entries.some(
                (entry) =>
                  !supportsAtomicNodeClaims(claimSupport, entry.claims ?? []),
              )
            ) {
              throw new CompilerInvariantError(
                "Atomic node claim program exceeded its declared per-member budget.",
                {
                  claimSupport,
                },
              );
            }
            const claimChunkSize = Math.max(
              1,
              Math.floor(
                (options.maxBindParameters - 2) /
                  ATOMIC_NODE_CLAIM_INPUT_PARAM_COUNT,
              ),
            );
            const nodeChunks = chunkAtomicNodeEntriesByClaimWork(
              input.entries,
              options.maxBindParameters,
            );
            function claimGateForChunk(chunk: readonly AtomicNodeBatchEntry[]) {
              const members = new Set<AtomicNodePostimageEntry>(chunk);
              const chunkClaims = claimEntries.filter((item) =>
                members.has(item.entry),
              );
              return chunkClaims.length === 0 ?
                  undefined
                : operationStrategy.buildAtomicNodeClaimGatePredicateWithSchemaFence(
                    chunkClaims,
                    input.schemaFence,
                    atomicSchemaFenceLockClause,
                  );
            }
            const claimChunks = chunkArray(claimEntries, claimChunkSize);
            const claimSlots: AtomicSqlProgram<
              AtomicNodeProgramSlot,
              unknown
            >["slots"] = claimChunks.map((chunk) => ({
              statement: execution.compile(
                operationStrategy.buildAtomicNodeClaimUpsertWithSchemaFence(
                  chunk,
                  input.schemaFence,
                  atomicSchemaFenceLockClause,
                ),
              ),
              cardinality: "many" as const,
              decode: (rows: readonly Readonly<Record<string, unknown>>[]) => ({
                kind: "claims" as const,
                entries: chunk,
                rows: rows.map((row) => ({
                  node_kind: String(row["node_kind"]),
                  constraint_name: String(row["constraint_name"]),
                  key: String(row["key"]),
                  node_id: String(row["node_id"]),
                  concrete_kind: String(row["concrete_kind"]),
                })),
              }),
            }));
            const cleanupSlots: AtomicSqlProgram<
              AtomicNodeProgramSlot,
              unknown
            >["slots"] = claimChunks.map((chunk) => ({
              statement: execution.compile(
                operationStrategy.buildAtomicNodeClaimCleanupWithSchemaFence(
                  chunk,
                  input.schemaFence,
                  atomicSchemaFenceLockClause,
                ),
              ),
              cardinality: "none" as const,
              decode: () => ({ kind: "cleanup" as const }),
            }));
            const projectionSlots = compileAtomicNodeProjectionSlots(
              operationStrategy,
              execution,
              input.entries,
              [],
              timestamp,
              options.maxBindParameters,
            );
            const projectionEvidenceSlots =
              await compileAtomicNodeProjectionEvidenceSlots(
                operationStrategy,
                execution,
                input.entries,
                [],
                timestamp,
                options.maxBindParameters,
                options.resolveAtomicNodeProjectionEvidence,
              );
            // A per-chunk gate can refuse one member while a different chunk
            // remains eligible. Assert every postimage inside the atomic
            // transport so no successful sibling can commit before the Store
            // diagnoses the refused claim from the rolled-back state.
            const assertionSlots: AtomicSqlProgram<
              AtomicNodeProgramSlot,
              unknown
            >["slots"] = nodeChunks.map((chunk) => ({
              statement: execution.compile(
                operationStrategy.buildAssertAtomicNodeMutationPostimages(
                  chunk,
                  [],
                  timestamp,
                  input.schemaFence,
                ),
              ),
              cardinality: "none" as const,
              decode: () => ({ kind: "assertion" as const }),
            }));

            if (input.resultMode === "count") {
              const nodeSlots: AtomicSqlProgram<
                AtomicNodeProgramSlot,
                unknown
              >["slots"] = nodeChunks.map((chunk) => {
                return {
                  statement: execution.compile(
                    operationStrategy.buildAtomicNodeBatchWithSchemaFence(
                      chunk,
                      timestamp,
                      input.schemaFence,
                      atomicSchemaFenceLockClause,
                      "count",
                      claimGateForChunk(chunk),
                    ),
                  ),
                  cardinality: "many" as const,
                  decode: (rows) => ({
                    kind: "counts" as const,
                    chunk,
                    count: rows.length,
                  }),
                };
              });
              const program = {
                slots: [
                  ...claimSlots,
                  ...nodeSlots,
                  ...cleanupSlots,
                  ...projectionSlots,
                  ...projectionEvidenceSlots,
                  ...assertionSlots,
                ],
                assemble(results: readonly AtomicNodeProgramSlot[]): number {
                  const counts = results.flatMap((result) =>
                    result.kind === "counts" ? [result.count] : [],
                  );
                  const insertedCount = counts.reduce(
                    (total, count) => total + count,
                    0,
                  );
                  const claimVerdict = requireAtomicNodeClaimWrite(
                    claimEntries,
                    results,
                    insertedCount,
                  );
                  if (claimVerdict === "stale") return 0;
                  assertCompleteAtomicChunks(counts, nodeChunks, "node");
                  return input.entries.length;
                },
              } satisfies AtomicSqlProgram<AtomicNodeProgramSlot, number>;
              return runAtomicNodeSidecarProgram({
                creates: input.entries,
                updates: [],
                operation: "insert",
                hasProjections: projectionSlots.length > 0,
                hasPostimageAssertion: assertionSlots.length > 0,
                run: () =>
                  withAtomicNodeBatchClassifications(
                    () => atomicExecutor.execute(program),
                    input.entries,
                    operationStrategy,
                  ),
                postimageRefusal: () => 0,
              });
            }

            const nodeSlots: AtomicSqlProgram<
              AtomicNodeProgramSlot,
              unknown
            >["slots"] = nodeChunks.map((chunk) => {
              return {
                statement: execution.compile(
                  operationStrategy.buildAtomicNodeBatchWithSchemaFence(
                    chunk,
                    timestamp,
                    input.schemaFence,
                    atomicSchemaFenceLockClause,
                    "rows",
                    claimGateForChunk(chunk),
                  ),
                ),
                cardinality: "many" as const,
                decode: (rows) => ({
                  kind: "rows" as const,
                  chunk,
                  rows: rows.map((row) => rowMappers.toNodeRow(row)),
                }),
              };
            });
            const program = {
              slots: [
                ...claimSlots,
                ...nodeSlots,
                ...cleanupSlots,
                ...projectionSlots,
                ...projectionEvidenceSlots,
                ...assertionSlots,
              ],
              assemble(
                results: readonly AtomicNodeProgramSlot[],
              ): readonly NodeRow[] {
                const rows = results.flatMap((result) =>
                  result.kind === "rows" ? result.rows : [],
                );
                const claimVerdict = requireAtomicNodeClaimWrite(
                  claimEntries,
                  results,
                  rows.length,
                );
                if (claimVerdict === "stale") return [];
                if (rows.length !== input.entries.length) {
                  throw new CompilerInvariantError(
                    "Atomic node claim program returned a partial node result.",
                    { expected: input.entries.length, actual: rows.length },
                  );
                }
                return rows;
              },
            } satisfies AtomicSqlProgram<
              AtomicNodeProgramSlot,
              readonly NodeRow[]
            >;
            return runAtomicNodeSidecarProgram({
              creates: input.entries,
              updates: [],
              operation: "insert",
              hasProjections: projectionSlots.length > 0,
              hasPostimageAssertion: assertionSlots.length > 0,
              run: () =>
                withAtomicNodeBatchClassifications(
                  () => atomicExecutor.execute(program),
                  input.entries,
                  operationStrategy,
                ),
              postimageRefusal: () => [],
            });
          }

          if (input.resultMode === "count") {
            const nodeSlots = chunks.map((chunk) => ({
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
              decode: (rows: readonly Readonly<Record<string, unknown>>[]) => ({
                kind: "counts" as const,
                chunk,
                count: rows.length,
              }),
            }));
            const projectionSlots = compileAtomicNodeProjectionSlots(
              operationStrategy,
              execution,
              input.entries,
              [],
              timestamp,
              options.maxBindParameters,
            );
            const projectionEvidenceSlots =
              await compileAtomicNodeProjectionEvidenceSlots(
                operationStrategy,
                execution,
                input.entries,
                [],
                timestamp,
                options.maxBindParameters,
                options.resolveAtomicNodeProjectionEvidence,
              );
            const assertionSlots =
              projectionSlots.length === 0 ?
                []
              : chunks.map((chunk) => ({
                  statement: execution.compile(
                    operationStrategy.buildAssertAtomicNodeMutationPostimages(
                      chunk,
                      [],
                      timestamp,
                      input.schemaFence,
                    ),
                  ),
                  cardinality: "none" as const,
                  decode: () => ({ kind: "assertion" as const }),
                }));
            const program = {
              slots: [
                ...nodeSlots,
                ...projectionSlots,
                ...projectionEvidenceSlots,
                ...assertionSlots,
              ],
              assemble(results: readonly AtomicNodeProgramSlot[]): number {
                const counts = results.flatMap((result) =>
                  result.kind === "counts" ? [result.count] : [],
                );
                if (counts.every((count) => count === 0)) return 0;
                assertCompleteAtomicChunks(counts, chunks, "node");
                return input.entries.length;
              },
            } satisfies AtomicSqlProgram<AtomicNodeProgramSlot, number>;
            return runAtomicNodeSidecarProgram({
              creates: input.entries,
              updates: [],
              operation: "insert",
              hasProjections: projectionSlots.length > 0,
              hasPostimageAssertion: assertionSlots.length > 0,
              run: () =>
                withAtomicNodeBatchClassifications(
                  () => atomicExecutor.execute(program),
                  input.entries,
                  operationStrategy,
                ),
              postimageRefusal: () => 0,
            });
          }

          const nodeSlots = chunks.map((chunk) => ({
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
            decode: (rows: readonly Readonly<Record<string, unknown>>[]) => ({
              kind: "rows" as const,
              chunk,
              rows: rows.map((row) => rowMappers.toNodeRow(row)),
            }),
          }));
          const projectionSlots = compileAtomicNodeProjectionSlots(
            operationStrategy,
            execution,
            input.entries,
            [],
            timestamp,
            options.maxBindParameters,
          );
          const projectionEvidenceSlots =
            await compileAtomicNodeProjectionEvidenceSlots(
              operationStrategy,
              execution,
              input.entries,
              [],
              timestamp,
              options.maxBindParameters,
              options.resolveAtomicNodeProjectionEvidence,
            );
          const assertionSlots =
            projectionSlots.length === 0 ?
              []
            : chunks.map((chunk) => ({
                statement: execution.compile(
                  operationStrategy.buildAssertAtomicNodeMutationPostimages(
                    chunk,
                    [],
                    timestamp,
                    input.schemaFence,
                  ),
                ),
                cardinality: "none" as const,
                decode: () => ({ kind: "assertion" as const }),
              }));
          const program = {
            slots: [
              ...nodeSlots,
              ...projectionSlots,
              ...projectionEvidenceSlots,
              ...assertionSlots,
            ],
            assemble(
              results: readonly AtomicNodeProgramSlot[],
            ): readonly NodeRow[] {
              const rowChunks = results.flatMap((result) =>
                result.kind === "rows" ? [result.rows] : [],
              );
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
          } satisfies AtomicSqlProgram<
            AtomicNodeProgramSlot,
            readonly NodeRow[]
          >;
          return runAtomicNodeSidecarProgram({
            creates: input.entries,
            updates: [],
            operation: "insert",
            hasProjections: projectionSlots.length > 0,
            hasPostimageAssertion: assertionSlots.length > 0,
            run: () =>
              withAtomicNodeBatchClassifications(
                () => atomicExecutor.execute(program),
                input.entries,
                operationStrategy,
              ),
            postimageRefusal: () => [],
          });
        }

        function acceptsAtomicNodeReplacementEntries(
          entries: readonly AtomicNodeReplacementEntry[],
        ): boolean {
          return (
            chunkAtomicNodeReplacementEntriesByClaimWork(
              entries,
              options.maxBindParameters,
            ).length <= ATOMIC_MUTATION_MAX_MUTATION_STATEMENTS
          );
        }

        async function executeAtomicNodeReplacementBatch(
          input: Parameters<AtomicNodeReplacementBatchExecutor>[0],
        ): Promise<readonly NodeRow[]> {
          if (input.entries.length === 0) return [];
          assertMatchingNodeSchemaFences(
            input.entries.map((entry) => entry.params),
            input.schemaFence,
          );
          const firstEntry = requireDefined(input.entries[0]);
          const identities = new Set<string>();
          for (const entry of input.entries) {
            if (
              entry.params.graphId !== firstEntry.params.graphId ||
              entry.params.kind !== firstEntry.params.kind
            ) {
              throw new CompilerInvariantError(
                "An atomic node replacement requires one graph and node kind.",
                {
                  expectedGraphId: firstEntry.params.graphId,
                  expectedKind: firstEntry.params.kind,
                  actualGraphId: entry.params.graphId,
                  actualKind: entry.params.kind,
                },
              );
            }
            const identity = encodeTupleKey([
              entry.params.graphId,
              entry.params.kind,
              entry.params.id,
            ]);
            if (identities.has(identity)) {
              throw new CompilerInvariantError(
                "An atomic node replacement requires distinct identities.",
              );
            }
            identities.add(identity);
            if (!supportsAtomicNodeClaims(claimSupport, entry.claims ?? [])) {
              throw new CompilerInvariantError(
                "Atomic node replacement exceeded its declared per-member claim budget.",
                { claimSupport },
              );
            }
          }

          const timestamp = nowIso();
          const atomicExecutor = requireDefined(atomicSqlProgramExecutor);
          const atomicSchemaFenceLockClause = requireDefined(
            schemaFenceLockClause,
          );
          const claimEntries = orderedAtomicNodeClaims(input.entries);
          const nodeChunks = chunkAtomicNodeReplacementEntriesByClaimWork(
            input.entries,
            options.maxBindParameters,
          );
          if (!acceptsAtomicNodeReplacementEntries(input.entries)) {
            throw new CompilerInvariantError(
              "Atomic node replacement exceeded its declared submission statement budget.",
              {
                actual: nodeChunks.length,
                maximum: ATOMIC_MUTATION_MAX_MUTATION_STATEMENTS,
              },
            );
          }

          const claimChunkSize = Math.max(
            1,
            Math.floor(
              (options.maxBindParameters - 2) /
                ATOMIC_NODE_CLAIM_INPUT_PARAM_COUNT,
            ),
          );
          const claimChunks = chunkArray(claimEntries, claimChunkSize);
          const claimSlots: AtomicSqlProgram<
            AtomicNodeProgramSlot,
            unknown
          >["slots"] = claimChunks.map((chunk) => ({
            statement: execution.compile(
              operationStrategy.buildAtomicNodeClaimUpsertWithSchemaFence(
                chunk,
                input.schemaFence,
                atomicSchemaFenceLockClause,
              ),
            ),
            cardinality: "many" as const,
            decode: (rows: readonly Readonly<Record<string, unknown>>[]) => ({
              kind: "claims" as const,
              entries: chunk,
              rows: rows.map((row) => ({
                node_kind: String(row["node_kind"]),
                constraint_name: String(row["constraint_name"]),
                key: String(row["key"]),
                node_id: String(row["node_id"]),
                concrete_kind: String(row["concrete_kind"]),
              })),
            }),
          }));
          const releaseChunkSize = Math.max(1, options.maxBindParameters - 5);
          const releaseSlots: AtomicSqlProgram<
            AtomicNodeProgramSlot,
            unknown
          >["slots"] =
            input.releaseClaims ?
              chunkArray(input.entries, releaseChunkSize).map((chunk) => ({
                statement: execution.compile(
                  operationStrategy.buildAtomicNodeReplacementClaimReleaseWithSchemaFence(
                    {
                      graphId: requireDefined(chunk[0]).params.graphId,
                      kind: requireDefined(chunk[0]).params.kind,
                      ids: chunk.map((entry) => entry.params.id),
                      timestamp,
                    },
                    input.schemaFence,
                    atomicSchemaFenceLockClause,
                  ),
                ),
                cardinality: "none" as const,
                decode: () => ({ kind: "cleanup" as const }),
              }))
            : [];
          function claimGateForChunk(
            chunk: readonly AtomicNodeReplacementEntry[],
          ): SQL | undefined {
            const members = new Set<AtomicNodePostimageEntry>(chunk);
            const chunkClaims = claimEntries.filter((item) =>
              members.has(item.entry),
            );
            return chunkClaims.length === 0 ?
                undefined
              : operationStrategy.buildAtomicNodeClaimGatePredicateWithSchemaFence(
                  chunkClaims,
                  input.schemaFence,
                  atomicSchemaFenceLockClause,
                );
          }
          const nodeSlots: AtomicSqlProgram<
            AtomicNodeProgramSlot,
            unknown
          >["slots"] = nodeChunks.map((chunk) => ({
            statement: execution.compile(
              operationStrategy.buildAtomicNodeReplacementBatchWithSchemaFence(
                chunk,
                timestamp,
                input.schemaFence,
                atomicSchemaFenceLockClause,
                claimGateForChunk(chunk),
              ),
            ),
            cardinality: "many" as const,
            decode: (rows: readonly Readonly<Record<string, unknown>>[]) => ({
              kind: "rows" as const,
              chunk,
              rows: rows.map((row) => rowMappers.toNodeRow(row)),
            }),
          }));
          const projectionSlots = compileAtomicNodeProjectionSlots(
            operationStrategy,
            execution,
            input.entries,
            [],
            timestamp,
            options.maxBindParameters,
          );
          const projectionEvidenceSlots =
            await compileAtomicNodeProjectionEvidenceSlots(
              operationStrategy,
              execution,
              input.entries,
              [],
              timestamp,
              options.maxBindParameters,
              options.resolveAtomicNodeProjectionEvidence,
            );
          const assertionSlots: AtomicSqlProgram<
            AtomicNodeProgramSlot,
            unknown
          >["slots"] = nodeChunks.map((chunk) => ({
            statement: execution.compile(
              operationStrategy.buildAssertAtomicNodeMutationPostimages(
                chunk,
                [],
                timestamp,
                input.schemaFence,
              ),
            ),
            cardinality: "none" as const,
            decode: () => ({ kind: "assertion" as const }),
          }));
          const program = {
            slots: [
              ...releaseSlots,
              ...claimSlots,
              ...nodeSlots,
              ...projectionSlots,
              ...projectionEvidenceSlots,
              ...assertionSlots,
            ],
            assemble(
              results: readonly AtomicNodeProgramSlot[],
            ): readonly NodeRow[] {
              const rows = results.flatMap((result) =>
                result.kind === "rows" ? result.rows : [],
              );
              if (claimEntries.length > 0) {
                const claimVerdict = requireAtomicNodeClaimWrite(
                  claimEntries,
                  results,
                  rows.length,
                );
                if (claimVerdict === "stale") return [];
              }
              if (rows.length !== input.entries.length) {
                throw new CompilerInvariantError(
                  "Atomic node replacement returned a partial result.",
                  { expected: input.entries.length, actual: rows.length },
                );
              }
              const byIdentity = new Map(
                rows.map((row) => [
                  encodeTupleKey([row.graph_id, row.kind, row.id]),
                  row,
                ]),
              );
              if (byIdentity.size !== rows.length) {
                throw new CompilerInvariantError(
                  "Atomic node replacement returned duplicate result rows.",
                );
              }
              return input.entries.map((entry) =>
                requireDefined(
                  byIdentity.get(
                    encodeTupleKey([
                      entry.params.graphId,
                      entry.params.kind,
                      entry.params.id,
                    ]),
                  ),
                  "Atomic node replacement omitted an input row.",
                ),
              );
            },
          } satisfies AtomicSqlProgram<
            AtomicNodeProgramSlot,
            readonly NodeRow[]
          >;
          return runAtomicNodeSidecarProgram({
            creates: input.entries,
            updates: [],
            operation: "upsert",
            hasProjections: projectionSlots.length > 0,
            hasPostimageAssertion: true,
            run: () => atomicExecutor.execute(program),
            postimageRefusal: () => [],
          });
        }

        const boundedExecuteAtomicNodeBatch = Object.assign(
          executeAtomicNodeBatch,
          { claimSupport, projectionSupport },
        );
        const executeAtomicNodeReplacement = Object.assign(
          executeAtomicNodeReplacementBatch,
          {
            accepts: acceptsAtomicNodeReplacementEntries,
            claimSupport,
            maxEntries: Object.freeze({
              plain: atomicNodeReplacementSubmissionMaxEntries(
                options.maxBindParameters,
              ),
              claimed: ATOMIC_RESOLVED_MUTATION_MAX_MEMBERS,
            }),
            projectionSupport,
            releasedClaimFamilies: claimSupport.families,
          },
        );
        return {
          executeAtomicNodeBatch: boundedExecuteAtomicNodeBatch,
          executeAtomicNodeReplacementBatch: executeAtomicNodeReplacement,
        } satisfies Readonly<{
          executeAtomicNodeBatch: AtomicNodeBatchExecutor;
          executeAtomicNodeReplacementBatch: AtomicNodeReplacementBatchExecutor;
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

  const atomicEdgeConvergenceMembers: Readonly<{
    executeAtomicEdgeConvergence?: AtomicEdgeConvergenceLowerer;
  }> =
    (
      atomicSqlProgramExecutor === undefined ||
      schemaFenceLockClause === undefined ||
      operationStrategy.buildAtomicConvergeEdges === undefined ||
      operationStrategy.buildAtomicConvergeEdgesTombstoneRefusal === undefined
    ) ?
      {}
    : (() => {
        const atomicExecutor = requireDefined(atomicSqlProgramExecutor);
        const atomicSchemaFenceLockClause = requireDefined(
          schemaFenceLockClause,
        );
        const buildCreate = requireDefined(
          operationStrategy.buildAtomicConvergeEdges,
        );
        const buildTombstoneRefusal = requireDefined(
          operationStrategy.buildAtomicConvergeEdgesTombstoneRefusal,
        );
        // The INSERT is the widest constant-size slot. Derive the public
        // ceiling from that exact row shape so eligibility cannot outrun the
        // transport's bind budget.
        const maxEntries = Math.max(
          0,
          Math.floor(
            (maxBindParameters - ATOMIC_EDGE_CONVERGENCE_FIXED_PARAM_COUNT) /
              ATOMIC_EDGE_CONVERGENCE_PARAM_COUNT,
          ),
        );

        const executeAtomicEdgeConvergence = Object.assign(
          async (
            input: Omit<AtomicEdgeConvergenceInput, "kind">,
          ): Promise<readonly AtomicEdgeConvergenceResult[]> => {
            if (input.entries.length === 0) return [];
            if (input.entries.length > maxEntries) {
              throw new CompilerInvariantError(
                "Atomic edge convergence exceeded its declared program budget.",
                { entries: input.entries.length, maxEntries },
              );
            }
            const inputIdentityKeys = new Set<string>();
            for (const entry of input.entries) {
              if (
                entry.params.graphId !== input.schemaFence.graphId ||
                entry.match.kind !== "durable" ||
                entry.params.matchIdentity?.name !==
                  entry.match.identity.name ||
                entry.params.matchIdentity.key !== entry.match.identity.key
              ) {
                throw new CompilerInvariantError(
                  "Atomic edge convergence input crossed its durable identity or schema fence.",
                  { graphId: entry.params.graphId, id: entry.params.id },
                );
              }
              const identityKey = encodeTupleKey([
                entry.params.graphId,
                entry.params.kind,
                entry.match.identity.name,
                entry.match.identity.key,
              ]);
              if (inputIdentityKeys.has(identityKey)) {
                throw new CompilerInvariantError(
                  "Atomic edge convergence received a duplicate durable identity.",
                  { graphId: entry.params.graphId, id: entry.params.id },
                );
              }
              inputIdentityKeys.add(identityKey);
            }

            const timestamp = nowIso();
            const builderInput = {
              entries: input.entries,
              timestamp,
              schemaFence: input.schemaFence,
              schemaLockClause: atomicSchemaFenceLockClause,
            };
            const program = {
              slots: [
                {
                  statement: execution.compile(buildCreate(builderInput)),
                  cardinality: "many" as const,
                  decode: (
                    rows: readonly Readonly<Record<string, unknown>>[],
                  ) => rows.map((row) => rowMappers.toEdgeRow(row)),
                },
                {
                  statement: execution.compile(
                    buildTombstoneRefusal({
                      entries: builderInput.entries,
                      schemaFence: builderInput.schemaFence,
                      schemaLockClause: builderInput.schemaLockClause,
                    }),
                  ),
                  cardinality: "none" as const,
                  decode: decodeNoEdgeRows,
                },
              ],
              assemble(
                results: readonly (readonly EdgeRow[])[],
              ): readonly AtomicEdgeConvergenceResult[] {
                const rows = requireDefined(results[0]);
                if (rows.length === 0) return [];
                if (rows.length !== input.entries.length) {
                  throw new CompilerInvariantError(
                    "Atomic edge convergence returned a partial result set.",
                    { expected: input.entries.length, actual: rows.length },
                  );
                }
                const rowsByIdentity = new Map<string, EdgeRow>();
                for (const row of rows) {
                  if (
                    row.match_identity_name === undefined ||
                    row.match_identity_key === undefined ||
                    row.deleted_at !== undefined
                  ) {
                    throw new CompilerInvariantError(
                      "Atomic edge convergence returned an invalid live identity.",
                      { id: row.id, kind: row.kind },
                    );
                  }
                  const key = encodeTupleKey([
                    row.graph_id,
                    row.kind,
                    row.match_identity_name,
                    row.match_identity_key,
                  ]);
                  if (rowsByIdentity.has(key)) {
                    throw new CompilerInvariantError(
                      "Atomic edge convergence returned a duplicate identity.",
                      { id: row.id, kind: row.kind },
                    );
                  }
                  rowsByIdentity.set(key, row);
                }
                return input.entries.map((entry) => {
                  if (entry.match.kind !== "durable") {
                    throw new CompilerInvariantError(
                      "Atomic edge convergence result mapping received a dynamic identity.",
                    );
                  }
                  const key = encodeTupleKey([
                    entry.params.graphId,
                    entry.params.kind,
                    entry.match.identity.name,
                    entry.match.identity.key,
                  ]);
                  const row = rowsByIdentity.get(key);
                  if (row === undefined) {
                    throw new CompilerInvariantError(
                      "Atomic edge convergence omitted a durable identity.",
                      { id: entry.params.id, kind: entry.params.kind },
                    );
                  }
                  return {
                    row,
                    outcome: row.id === entry.params.id ? "created" : "found",
                  };
                });
              },
            } satisfies AtomicSqlProgram<
              readonly EdgeRow[],
              readonly AtomicEdgeConvergenceResult[]
            >;

            try {
              return await executeClassifiedAtomicEdgeBatch(
                atomicExecutor,
                program,
                operationStrategy.primaryKeyConstraints.edges,
                operationStrategy.atomicEdgeRefusalConstraints,
                input.entries.map((entry) => entry.params),
                [],
              );
            } catch (error) {
              if (
                isNotNullColumnViolation(
                  error,
                  operationStrategy.atomicEdgeRefusalConstraints
                    .tombstoneConvergence,
                )
              ) {
                throw new AtomicEdgeConvergenceTombstoneRefusalError(error);
              }
              throw error;
            }
          },
          { maxEntries },
        );

        return { executeAtomicEdgeConvergence } satisfies Readonly<{
          executeAtomicEdgeConvergence: AtomicEdgeConvergenceLowerer;
        }>;
      })();

  const atomicNodeDeleteBatchMembers =
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
        // Claim release is widest: fence graph/version, graph, kind, and the
        // timestamp in both SET and owner-postimage predicates beside each id.
        const chunkSize = Math.max(1, maxBindParameters - 6);

        async function executeAtomicNodeDeleteBatch(
          input: AtomicNodeDeleteBatchInput,
        ): Promise<AtomicDeleteBatchResult> {
          if (input.ids.length === 0) {
            return { affectedCount: 0, schemaFenceMatched: true };
          }
          if (input.graphId !== input.schemaFence.graphId) {
            throw new CompilerInvariantError(
              "Atomic node delete batch crossed its schema fence graph.",
              {
                graphId: input.graphId,
                fenceGraphId: input.schemaFence.graphId,
              },
            );
          }
          const timestamp = nowIso();
          const deleteSlots = chunkArray(input.ids, chunkSize).map((ids) => ({
            statement: execution.compile(
              operationStrategy.buildAtomicNodeDeleteBatchWithSchemaFence(
                { ...input, ids },
                timestamp,
                atomicSchemaFenceLockClause,
              ),
            ),
            cardinality: "many" as const,
            decode: (rows: readonly Readonly<Record<string, unknown>>[]) =>
              ({ kind: "affected", count: rows.length }) as const,
          }));
          const claimReleaseSlots = chunkArray(input.ids, chunkSize).map(
            (ids) => ({
              statement: execution.compile(
                operationStrategy.buildAtomicDeletedNodeClaimReleaseWithSchemaFence(
                  {
                    graphId: input.graphId,
                    kind: input.kind,
                    ids,
                    timestamp,
                  },
                  input.schemaFence,
                  atomicSchemaFenceLockClause,
                ),
              ),
              cardinality: "none" as const,
              decode: () => ({ kind: "claim-release" as const }),
            }),
          );
          const program = {
            slots: [
              ...deleteSlots,
              ...claimReleaseSlots,
              {
                statement: execution.compile(
                  operationStrategy.buildSchemaFenceProbe(
                    input.schemaFence,
                    atomicSchemaFenceLockClause,
                  ),
                ),
                cardinality: "many" as const,
                decode: (rows: readonly Readonly<Record<string, unknown>>[]) =>
                  ({ kind: "fence", matched: rows.length === 1 }) as const,
              },
            ],
            assemble: (results: readonly AtomicDeleteSlotResult[]) =>
              assembleAtomicDeleteBatchResult(results),
          } satisfies AtomicSqlProgram<
            AtomicDeleteSlotResult,
            AtomicDeleteBatchResult
          >;

          return withAtomicNodeDeleteRestrictionClassification(
            () => atomicExecutor.execute(program),
            operationStrategy.atomicNodeRefusalConstraints.deleteRestricted,
          );
        }

        const executeAtomicNodeDeleteBatchWithClaimCleanup = Object.assign(
          executeAtomicNodeDeleteBatch,
          {
            releasedClaimFamilies: ["disjointness", "uniqueness"] as const,
          },
        );
        return {
          executeAtomicNodeDeleteBatch:
            executeAtomicNodeDeleteBatchWithClaimCleanup,
        } satisfies Readonly<{
          executeAtomicNodeDeleteBatch: AtomicNodeDeleteBatchExecutor;
        }>;
      })();

  const atomicNodeResolvedUpdateBatchMembers =
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
        // Each member binds its id in CASE, membership and preimage predicates,
        // plus props and version. Leave a conservative fixed allowance for the
        // graph/kind/fence/timestamp/count binds.
        const statementChunkSize = atomicResolvedMutationStatementChunkSize(
          maxBindParameters,
          ATOMIC_NODE_RESOLVED_MUTATION_PARAMS_PER_ENTRY,
        );
        const maxEntries =
          atomicResolvedMutationSubmissionMaxEntries(statementChunkSize);

        const executeAtomicNodeResolvedUpdateBatch = Object.assign(
          async (
            input: Parameters<AtomicNodeResolvedUpdateBatchExecutor>[0],
          ) => {
            if (input.entries.length === 0) return [];
            assertResolvedNodeUpdateBatchInput(
              input.entries,
              input.schemaFence,
            );
            const timestamp = nowIso();
            const updateChunks = chunkArray(input.entries, statementChunkSize);
            const projectionSlots = compileAtomicNodeProjectionSlots(
              operationStrategy,
              execution,
              [],
              input.entries,
              timestamp,
              options.maxBindParameters,
            );
            const projectionEvidenceSlots =
              await compileAtomicNodeProjectionEvidenceSlots(
                operationStrategy,
                execution,
                [],
                input.entries,
                timestamp,
                options.maxBindParameters,
                options.resolveAtomicNodeProjectionEvidence,
              );
            const first = requireDefined(input.entries[0]);
            const program = buildAtomicResolvedMutationSetProgram({
              entity: "node",
              createChunks: [],
              updateChunks,
              createIds: [],
              updateIds: input.entries.map((entry) => entry.id),
              compileCreate: () => {
                throw new CompilerInvariantError(
                  "An update-only node program compiled a create chunk.",
                );
              },
              compileUpdate: (updates) =>
                execution.compile(
                  operationStrategy.buildAtomicNodeResolvedUpdateBatch(
                    updates,
                    timestamp,
                    input.schemaFence,
                    atomicSchemaFenceLockClause,
                  ),
                ),
              compiledSidecars: [
                ...projectionSlots,
                ...projectionEvidenceSlots,
              ].map((slot) => slot.statement),
              compileAssertion: (_creates, updates) =>
                execution.compile(
                  operationStrategy.buildAssertAtomicNodeMutationPostimages(
                    [],
                    updates,
                    timestamp,
                    input.schemaFence,
                  ),
                ),
              compilePostimages: (ids) =>
                execution.compile(
                  operationStrategy.buildReadAtomicNodeMutationPostimages(
                    input.schemaFence.graphId,
                    first.kind,
                    ids,
                    input.schemaFence,
                  ),
                ),
              decodeRow: (row) => rowMappers.toNodeRow(row),
              rowId: (row) => row.id,
            });
            return runAtomicNodeSidecarProgram({
              creates: [],
              updates: input.entries,
              operation: "update",
              hasProjections: projectionSlots.length > 0,
              hasPostimageAssertion: true,
              run: async () => {
                const result = await atomicExecutor.execute(program);
                return result.updated;
              },
              postimageRefusal: () => [],
            });
          },
          {
            maxEntries,
            projectionSupport: Object.freeze({
              families: operationStrategy.atomicNodeProjectionFamilies,
            } satisfies AtomicNodeProjectionSupport),
          },
        ) satisfies AtomicNodeResolvedUpdateBatchExecutor;

        return { executeAtomicNodeResolvedUpdateBatch };
      })();

  const atomicNodeResolvedMutationSetMembers =
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
        // The guarded update is the widest per-member statement. Assertions,
        // postimage reads, creates, and projection sidecars are independently
        // chunked and compile-count ratchets keep every slot within this budget.
        const statementChunkSize = atomicResolvedMutationStatementChunkSize(
          maxBindParameters,
          ATOMIC_NODE_RESOLVED_MUTATION_PARAMS_PER_ENTRY,
        );
        const maxEntries =
          atomicResolvedMutationSubmissionMaxEntries(statementChunkSize);

        const executeAtomicNodeResolvedMutationSet = Object.assign(
          async (
            input: Parameters<AtomicNodeResolvedMutationSetExecutor>[0],
          ) => {
            const entryCount = input.creates.length + input.updates.length;
            if (entryCount === 0) return { created: [], updated: [] };
            assertResolvedNodeMutationSetInput(
              input.creates,
              input.updates,
              input.schemaFence,
            );
            const timestamp = nowIso();
            const firstIdentity = input.creates[0]?.params ?? input.updates[0];
            const projectionSlots = compileAtomicNodeProjectionSlots(
              operationStrategy,
              execution,
              input.creates,
              input.updates,
              timestamp,
              options.maxBindParameters,
            );
            const projectionEvidenceSlots =
              await compileAtomicNodeProjectionEvidenceSlots(
                operationStrategy,
                execution,
                input.creates,
                input.updates,
                timestamp,
                options.maxBindParameters,
                options.resolveAtomicNodeProjectionEvidence,
              );
            const program = buildAtomicResolvedMutationSetProgram({
              entity: "node",
              createChunks: chunkArray(
                input.creates,
                Math.min(
                  batchConfig.nodeSchemaFencedInsertBatchSize,
                  statementChunkSize,
                ),
              ),
              updateChunks: chunkArray(input.updates, statementChunkSize),
              createIds: input.creates.map((entry) => entry.params.id),
              updateIds: input.updates.map((entry) => entry.id),
              compileCreate: (chunk) =>
                execution.compile(
                  operationStrategy.buildAtomicNodeBatchWithSchemaFence(
                    chunk,
                    timestamp,
                    input.schemaFence,
                    atomicSchemaFenceLockClause,
                    "rows",
                  ),
                ),
              compileUpdate: (updates) =>
                execution.compile(
                  operationStrategy.buildAtomicNodeResolvedUpdateBatch(
                    updates,
                    timestamp,
                    input.schemaFence,
                    atomicSchemaFenceLockClause,
                  ),
                ),
              compiledSidecars: [
                ...projectionSlots,
                ...projectionEvidenceSlots,
              ].map((slot) => slot.statement),
              compileAssertion: (creates, updates) =>
                execution.compile(
                  operationStrategy.buildAssertAtomicNodeMutationPostimages(
                    creates,
                    updates,
                    timestamp,
                    input.schemaFence,
                  ),
                ),
              compilePostimages: (ids) =>
                execution.compile(
                  operationStrategy.buildReadAtomicNodeMutationPostimages(
                    input.schemaFence.graphId,
                    requireDefined(firstIdentity).kind,
                    ids,
                    input.schemaFence,
                  ),
                ),
              decodeRow: (row) => rowMappers.toNodeRow(row),
              rowId: (row) => row.id,
            });

            return runAtomicNodeSidecarProgram({
              creates: input.creates,
              updates: input.updates,
              operation: "upsert",
              hasProjections: projectionSlots.length > 0,
              hasPostimageAssertion: true,
              run: () =>
                withAtomicNodeBatchClassifications(
                  () => atomicExecutor.execute(program),
                  input.creates,
                  operationStrategy,
                ),
              postimageRefusal: () => ({ created: [], updated: [] }),
            });
          },
          {
            maxEntries,
            projectionSupport: Object.freeze({
              families: operationStrategy.atomicNodeProjectionFamilies,
            } satisfies AtomicNodeProjectionSupport),
          },
        ) satisfies AtomicNodeResolvedMutationSetExecutor;

        return { executeAtomicNodeResolvedMutationSet };
      })();

  const atomicEdgeDeleteBatchMembers =
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
        // Per chunk: fence graph/version (2), timestamp (1), expected kind
        // in both SET arms and the live-row predicate (3), graph id (1), ids.
        const chunkSize = Math.max(1, maxBindParameters - 7);

        async function executeAtomicEdgeDeleteBatch(
          input: AtomicEdgeDeleteBatchInput,
        ): Promise<AtomicDeleteBatchResult> {
          if (input.ids.length === 0) {
            return { affectedCount: 0, schemaFenceMatched: true };
          }
          if (input.graphId !== input.schemaFence.graphId) {
            throw new CompilerInvariantError(
              "Atomic edge delete batch crossed its schema fence graph.",
              {
                graphId: input.graphId,
                fenceGraphId: input.schemaFence.graphId,
              },
            );
          }
          const timestamp = nowIso();
          const chunks = chunkArray(input.ids, chunkSize);
          const deleteSlots = chunks.map((ids) => ({
            statement: execution.compile(
              operationStrategy.buildAtomicEdgeDeleteBatchWithSchemaFence(
                { ...input, ids },
                timestamp,
                atomicSchemaFenceLockClause,
              ),
            ),
            cardinality: "many" as const,
            decode: (rows: readonly Readonly<Record<string, unknown>>[]) =>
              ({ kind: "affected", count: rows.length }) as const,
          }));
          const program = {
            slots: [
              ...deleteSlots,
              {
                statement: execution.compile(
                  operationStrategy.buildSchemaFenceProbe(
                    input.schemaFence,
                    atomicSchemaFenceLockClause,
                  ),
                ),
                cardinality: "many" as const,
                decode: (rows: readonly Readonly<Record<string, unknown>>[]) =>
                  ({ kind: "fence", matched: rows.length === 1 }) as const,
              },
            ],
            assemble: (results: readonly AtomicDeleteSlotResult[]) =>
              assembleAtomicDeleteBatchResult(results),
          } satisfies AtomicSqlProgram<
            AtomicDeleteSlotResult,
            AtomicDeleteBatchResult
          >;

          return withAtomicEdgeDeleteIdentityRefusalClassification(
            () => atomicExecutor.execute(program),
            operationStrategy.atomicEdgeRefusalConstraints.deleteIdentity,
          );
        }

        return { executeAtomicEdgeDeleteBatch } satisfies Readonly<{
          executeAtomicEdgeDeleteBatch: AtomicEdgeDeleteBatchExecutor;
        }>;
      })();

  const atomicEdgeResolvedUpdateBatchMembers =
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

        const statementChunkSize = atomicResolvedMutationStatementChunkSize(
          maxBindParameters,
          ATOMIC_EDGE_RESOLVED_MUTATION_PARAMS_PER_ENTRY,
        );
        const maxEntries =
          atomicResolvedMutationSubmissionMaxEntries(statementChunkSize);
        const executeAtomicEdgeResolvedUpdateBatch = Object.assign(
          async (
            input: Parameters<AtomicEdgeResolvedUpdateBatchExecutor>[0],
          ) => {
            if (input.entries.length === 0) return [];
            assertResolvedEdgeUpdateBatchInput(
              input.entries,
              input.schemaFence,
            );
            let timestamp = nowIso();
            while (
              input.entries.some(
                (entry) => entry.existing.updated_at === timestamp,
              )
            ) {
              timestamp = new Date(Date.parse(timestamp) + 1).toISOString();
            }
            const program = buildAtomicResolvedMutationSetProgram({
              entity: "edge",
              createChunks: [],
              updateChunks: chunkArray(input.entries, statementChunkSize),
              createIds: [],
              updateIds: input.entries.map((entry) => entry.existing.id),
              compileCreate: () => {
                throw new CompilerInvariantError(
                  "An update-only edge program compiled a create chunk.",
                );
              },
              compileUpdate: (updates) =>
                execution.compile(
                  operationStrategy.buildAtomicEdgeResolvedUpdateBatch(
                    updates,
                    timestamp,
                    input.schemaFence,
                    atomicSchemaFenceLockClause,
                  ),
                ),
              compileAssertion: (_creates, updates) =>
                execution.compile(
                  operationStrategy.buildAssertAtomicEdgeMutationPostimages(
                    [],
                    updates,
                    timestamp,
                    input.schemaFence,
                  ),
                ),
              compilePostimages: (ids) =>
                execution.compile(
                  operationStrategy.buildReadAtomicEdgeMutationPostimages(
                    input.schemaFence.graphId,
                    ids,
                    input.schemaFence,
                  ),
                ),
              decodeRow: (row) => rowMappers.toEdgeRow(row),
              rowId: (row) => row.id,
            });
            try {
              const result = await atomicExecutor.execute(program);
              return result.updated;
            } catch (error) {
              if (
                isAtomicMutationPostimageRefusal(
                  error,
                  operationStrategy,
                  "edge",
                  true,
                )
              ) {
                return [];
              }
              throw error;
            }
          },
          { maxEntries },
        ) satisfies AtomicEdgeResolvedUpdateBatchExecutor;

        return { executeAtomicEdgeResolvedUpdateBatch };
      })();

  const atomicEdgeResolvedMutationSetMembers: Readonly<{
    executeAtomicEdgeResolvedMutationSet?: AtomicEdgeResolvedMutationSetLowerer;
  }> =
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
        // As for nodes, the guarded update is the widest per-member statement;
        // every other slot is independently chunked under the same budget.
        const statementChunkSize = atomicResolvedMutationStatementChunkSize(
          maxBindParameters,
          ATOMIC_EDGE_RESOLVED_MUTATION_PARAMS_PER_ENTRY,
        );
        const maxEntries =
          atomicResolvedMutationSubmissionMaxEntries(statementChunkSize);

        const executeAtomicEdgeResolvedMutationSet = Object.assign(
          async (
            input: Omit<AtomicEdgeResolvedMutationSetInput, "kind">,
          ): Promise<AtomicEdgeResolvedMutationSetResult> => {
            const entryCount = input.creates.length + input.updates.length;
            if (entryCount === 0) return { created: [], updated: [] };
            assertResolvedEdgeMutationSetInput(
              input.creates,
              input.updates,
              input.schemaFence,
            );
            let timestamp = nowIso();
            while (
              input.updates.some(
                (entry) => entry.existing.updated_at === timestamp,
              )
            ) {
              timestamp = new Date(Date.parse(timestamp) + 1).toISOString();
            }
            const program = buildAtomicResolvedMutationSetProgram({
              entity: "edge",
              createChunks: chunkArray(
                input.creates,
                Math.min(
                  batchConfig.edgeSchemaFencedInsertBatchSize,
                  statementChunkSize,
                ),
              ),
              updateChunks: chunkArray(input.updates, statementChunkSize),
              createIds: input.creates.map((entry) => entry.id),
              updateIds: input.updates.map((entry) => entry.existing.id),
              compileCreate: (chunk) =>
                execution.compile(
                  operationStrategy.buildInsertEdgesBatchReturningWithSchemaFence(
                    chunk,
                    timestamp,
                    input.schemaFence,
                    atomicSchemaFenceLockClause,
                  ),
                ),
              compileUpdate: (updates) =>
                execution.compile(
                  operationStrategy.buildAtomicEdgeResolvedUpdateBatch(
                    updates,
                    timestamp,
                    input.schemaFence,
                    atomicSchemaFenceLockClause,
                  ),
                ),
              compileAssertion: (creates, updates) =>
                execution.compile(
                  operationStrategy.buildAssertAtomicEdgeMutationPostimages(
                    creates,
                    updates,
                    timestamp,
                    input.schemaFence,
                  ),
                ),
              compilePostimages: (ids) =>
                execution.compile(
                  operationStrategy.buildReadAtomicEdgeMutationPostimages(
                    input.schemaFence.graphId,
                    ids,
                    input.schemaFence,
                  ),
                ),
              decodeRow: (row) => rowMappers.toEdgeRow(row),
              rowId: (row) => row.id,
            });

            try {
              return await executeClassifiedAtomicEdgeBatch(
                atomicExecutor,
                program,
                operationStrategy.primaryKeyConstraints.edges,
                operationStrategy.atomicEdgeRefusalConstraints,
                input.creates,
                [],
              );
            } catch (error) {
              if (
                isAtomicMutationPostimageRefusal(
                  error,
                  operationStrategy,
                  "edge",
                  true,
                )
              ) {
                return { created: [], updated: [] };
              }
              throw error;
            }
          },
          {
            maxEntries,
          },
        );

        return { executeAtomicEdgeResolvedMutationSet } satisfies Readonly<{
          executeAtomicEdgeResolvedMutationSet: AtomicEdgeResolvedMutationSetLowerer;
        }>;
      })();

  const atomicEdgeMutationProgramMembers =
    (
      atomicEdgeConvergenceMembers.executeAtomicEdgeConvergence === undefined ||
      atomicEdgeResolvedMutationSetMembers.executeAtomicEdgeResolvedMutationSet ===
        undefined
    ) ?
      {}
    : (() => {
        const convergence = requireDefined(
          atomicEdgeConvergenceMembers.executeAtomicEdgeConvergence,
        );
        const resolvedSet = requireDefined(
          atomicEdgeResolvedMutationSetMembers.executeAtomicEdgeResolvedMutationSet,
        );
        async function executeAtomicEdgeMutation(
          input: AtomicEdgeResolvedMutationSetInput,
        ): Promise<AtomicEdgeResolvedMutationSetResult>;
        async function executeAtomicEdgeMutation(
          input: AtomicEdgeConvergenceInput,
        ): Promise<readonly AtomicEdgeConvergenceResult[]>;
        async function executeAtomicEdgeMutation(
          input:
            AtomicEdgeResolvedMutationSetInput | AtomicEdgeConvergenceInput,
        ): Promise<
          | AtomicEdgeResolvedMutationSetResult
          | readonly AtomicEdgeConvergenceResult[]
        > {
          switch (input.kind) {
            case "resolved-set": {
              return resolvedSet({
                creates: input.creates,
                updates: input.updates,
                schemaFence: input.schemaFence,
              });
            }
            case "durable-convergence": {
              return convergence({
                entries: input.entries,
                schemaFence: input.schemaFence,
              });
            }
            default: {
              input satisfies never;
              throw new CompilerInvariantError(
                "Atomic edge mutation program received an unknown variant.",
              );
            }
          }
        }
        const executeAtomicEdgeMutationProgram = Object.assign(
          executeAtomicEdgeMutation,
          {
            maxEntries: {
              resolvedSet: resolvedSet.maxEntries,
              durableConvergence: convergence.maxEntries,
            },
          },
        ) satisfies AtomicEdgeMutationProgramExecutor;
        return { executeAtomicEdgeMutationProgram };
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
      command.match.kind === "durable" ?
        command.match.identity.name
      : undefined,
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
    ...atomicNodeDeleteBatchMembers,
    ...atomicNodeResolvedUpdateBatchMembers,
    ...atomicNodeResolvedMutationSetMembers,
    ...atomicEdgeDeleteBatchMembers,
    ...atomicEdgeResolvedUpdateBatchMembers,
    ...atomicEdgeMutationProgramMembers,
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

    async compareAndSetNode(
      params: CompareAndSetNodeParams,
    ): Promise<UpdateNodeSetResult> {
      if (
        Object.keys(params.patch).length === 0 &&
        (params.unsetProperties?.length ?? 0) === 0
      ) {
        throw new ConfigurationError(
          "Node compare-and-set requires at least one property patch",
          { operation: "compareAndSetNode", kind: params.kind },
        );
      }
      if (
        Object.keys(params.expectedProperties).length === 0 &&
        params.expectedAbsentProperties.length === 0
      ) {
        throw new ConfigurationError(
          "Node compare-and-set requires at least one expected property",
          { operation: "compareAndSetNode", kind: params.kind },
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
      // `getEdgesChunkSize` budgets graphId + ids. Soft delete additionally
      // binds the tombstone timestamp and, when stated, the asserted kind.
      const softDeleteChunkSize = Math.max(
        1,
        batchConfig.getEdgesChunkSize - 1 - (params.kind === undefined ? 0 : 1),
      );
      for (const chunk of chunkArray(params.ids, softDeleteChunkSize)) {
        const query = operationStrategy.buildDeleteEdgesBatch(
          {
            graphId: params.graphId,
            ids: chunk,
            ...(params.kind === undefined ? {} : { kind: params.kind }),
          },
          timestamp,
        );
        await execution.execRun(query);
      }
    },

    async hardDeleteEdgesBatch(params: DeleteEdgesBatchParams): Promise<void> {
      if (params.ids.length === 0) return;
      const hardDeleteChunkSize = Math.max(
        1,
        batchConfig.getEdgesChunkSize - (params.kind === undefined ? 0 : 1),
      );
      for (const chunk of chunkArray(params.ids, hardDeleteChunkSize)) {
        const query = operationStrategy.buildHardDeleteEdgesBatch({
          graphId: params.graphId,
          ids: chunk,
          ...(params.kind === undefined ? {} : { kind: params.kind }),
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
