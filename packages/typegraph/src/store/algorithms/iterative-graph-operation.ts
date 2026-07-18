import { type SQL, sql } from "drizzle-orm";

import {
  type GraphBackend,
  INTERNAL_TEMPORARY_WRITES,
  type TransactionBackend,
} from "../../backend/types";
import {
  CompilerInvariantError,
  ConfigurationError,
  GraphAlgorithmConvergenceError,
} from "../../errors";
import {
  compileKindFilter,
  sqlValueList,
} from "../../query/compiler/predicate-utils";
import {
  compileTemporalFilter,
  currentReadInstant,
} from "../../query/compiler/temporal";
import { type DialectAdapter } from "../../query/dialect/types";
import { jsonPointer } from "../../query/json-pointer";
import {
  asCompiledRowsSql,
  asCompiledTemporaryStatementSql,
} from "../../query/sql-intent";
import { compareCodePoints, compareStrings } from "../../utils/compare";
import { generateId } from "../../utils/id";
import { isPresent } from "../../utils/presence";
import type { AlgorithmContext, InternalTraversalOptions } from "./context";
import { resolveReadSchema, resolveTemporalOptions } from "./context";
import type { PathNode, TraversalDirection } from "./types";

type QueryBackend = Pick<GraphBackend, "capabilities" | "execute">;
type WorkingTableIdentifier = ReturnType<typeof sql.identifier>;

export type IterativeGraphOperation = Readonly<{
  backend: QueryBackend;
  ctx: AlgorithmContext;
  edgeKindChunks: readonly (readonly string[])[];
  direction: TraversalDirection;
  maxWorkingSetSize: number;
  nodeTemporalFilter: ReturnType<typeof compileTemporalFilter>;
  edgeTemporalFilter: ReturnType<typeof compileTemporalFilter>;
  schema: ReturnType<typeof resolveReadSchema>;
  /**
   * Validated caller-requested transaction-scoped memory override for
   * working-table rounds; `undefined` inherits the engine's configuration.
   */
  workingMemory: string | undefined;
  /**
   * Per-edge traversal weight over the expansion's edge alias `e`, compiled
   * from the caller's `weightProperty`/`defaultWeight`. When set, every edge
   * expansion carries it as a `weight` column; `undefined` for unweighted
   * operations.
   */
  weightExpression: SQL | undefined;
}>;

export type NodeIdentityKey = string & {
  readonly __nodeIdentityKey: unique symbol;
};

export type NodeExpansion = Readonly<{
  source: PathNode;
  target: PathNode;
  /** Edge weight; present exactly when the operation is weighted. */
  weight?: number;
}>;

type TemporaryStatementBackend = QueryBackend &
  Pick<TransactionBackend, "executeTemporaryStatement"> &
  Readonly<{
    executeTemporaryStatement: NonNullable<
      TransactionBackend["executeTemporaryStatement"]
    >;
  }>;

export type IterativeGraphRunContext = Readonly<{
  operation: IterativeGraphOperation;
  backend: TemporaryStatementBackend;
  workingTable: WorkingTableIdentifier;
  graphId: string;
  runId: string;
  executeTemporary: (query: SQL) => Promise<void>;
}>;

export type IterativeGraphState = Readonly<{
  workingTableSize: number;
}>;

export function frontierIndexIdentifier(context: IterativeGraphRunContext) {
  return sql.identifier(
    `typegraph_iterative_${context.runId.replaceAll("-", "_")}_frontier`,
  );
}

export type IterativeGraphPlan<
  State extends IterativeGraphState,
  Result,
> = Readonly<{
  algorithm: string;
  maxIterations: number;
  createWorkingTable: (context: IterativeGraphRunContext) => SQL;
  initialize: (context: IterativeGraphRunContext) => Promise<State>;
  runRound: (
    context: IterativeGraphRunContext,
    state: State,
    iteration: number,
  ) => Promise<State>;
  hasConverged: (state: State) => boolean;
  extractResult: (
    context: IterativeGraphRunContext,
    state: State,
  ) => Promise<Result>;
}>;

type ExpansionRow = Readonly<{
  source_id: string;
  source_kind: string;
  target_id: string;
  target_kind: string;
  /** Present when the operation is weighted; drivers may deliver text. */
  weight?: number | string | null;
}>;

type VisibleNodeRow = Readonly<{
  id: string;
  kind: string;
}>;

const DEFAULT_MAX_BIND_PARAMETERS = 999;
const RESERVED_TEMPORAL_BIND_PARAMETERS_PER_BRANCH = 12;
/** Headroom for the weight expression's path and default-weight binds. */
const RESERVED_WEIGHT_BIND_PARAMETERS_PER_BRANCH = 4;
/**
 * PostgreSQL initially estimates an un-analyzed temporary relation at one row.
 * Even a few dozen rows can distort join ordering on a dense edge expansion,
 * while ANALYZE remains a low-single-digit-millisecond operation at this size.
 * Keep the trigger below the 31-person smoke graph that exposed this cliff.
 */
export const WORKING_TABLE_ANALYZE_MINIMUM_ROWS = 16;
/** Caps statistics drift for growing BFS-style working tables at under 4x. */
export const WORKING_TABLE_ANALYZE_GROWTH_FACTOR = 4;

/**
 * Accepts only a plain integer with a binary unit suffix. The value reaches
 * the engine as a bound parameter, but a strict shape keeps the option from
 * ever smuggling arbitrary text into a settings statement and rejects
 * ambiguous inputs (fractions, spaces, unknown units) up front.
 */
const ITERATIVE_WORKING_MEMORY_PATTERN = /^(\d+)(kB|MB|GB)$/;

const WORKING_MEMORY_KILOBYTES_PER_UNIT: Readonly<Record<string, number>> = {
  kB: 1,
  MB: 1024,
  GB: 1024 * 1024,
};

/**
 * PostgreSQL's accepted `work_mem` range (in kB, its base unit). Values
 * outside it fail `set_config` mid-transaction with a raw engine error on
 * PostgreSQL while SQLite would silently accept them — so both backends
 * reject them up front with the same typed error instead.
 */
const MIN_WORKING_MEMORY_KILOBYTES = 64;
const MAX_WORKING_MEMORY_KILOBYTES = 2_147_483_647;

/**
 * Validates an explicitly requested working-memory override. `undefined`
 * means the caller did not opt in: the operation inherits the engine's
 * configured setting and emits no override — `work_mem` is a threshold each
 * sort/hash operator (and each parallel worker) may allocate up to, not a
 * per-operation budget, so silently raising it for every algorithm call
 * could multiply memory use far past what a DBA provisioned.
 */
function resolveWorkingMemory(
  workingMemory: string | undefined,
): string | undefined {
  if (workingMemory === undefined) return undefined;
  const match = ITERATIVE_WORKING_MEMORY_PATTERN.exec(workingMemory);
  if (match === null) {
    throw new ConfigurationError(
      `Iterative graph operation workingMemory must be digits followed by kB, MB, or GB (for example "64MB"), got ${JSON.stringify(workingMemory)}.`,
      { workingMemory },
    );
  }
  const kilobytes =
    Number(match[1]) * (WORKING_MEMORY_KILOBYTES_PER_UNIT[match[2] ?? ""] ?? 0);
  if (
    kilobytes < MIN_WORKING_MEMORY_KILOBYTES ||
    kilobytes > MAX_WORKING_MEMORY_KILOBYTES
  ) {
    throw new ConfigurationError(
      `Iterative graph operation workingMemory must be between ${MIN_WORKING_MEMORY_KILOBYTES}kB and ${MAX_WORKING_MEMORY_KILOBYTES}kB, got ${JSON.stringify(workingMemory)}.`,
      { workingMemory, kilobytes },
    );
  }
  return workingMemory;
}

/**
 * Opens the shared execution scope for iterative graph algorithms. The host
 * controls rounds and convergence; this scope supplies a snapshot-consistent,
 * bind-limit-aware SQL working relation for each round.
 *
 * The working relation is emitted as chunked `VALUES` rows rather than a
 * connection-local temporary table. That keeps the primitive portable to
 * backends such as D1 that cannot promise one pinned connection. Transactional
 * backends still run all rounds in one read-only snapshot.
 */
export async function withInlineIterativeGraphOperation<T>(
  ctx: AlgorithmContext,
  options: InternalTraversalOptions,
  run: (operation: IterativeGraphOperation) => Promise<T>,
): Promise<T> {
  if (ctx.backend.capabilities.transactions) {
    return ctx.backend.transaction(
      async (backend) => run(createOperation(ctx, options, backend)),
      {
        isolationLevel: "repeatable_read",
        accessMode: "read_only",
      },
    );
  }
  return run(createOperation(ctx, options, ctx.backend));
}

/**
 * Runs a compiler-defined iterative algorithm against a real temporary working
 * table. The primitive owns the read-only snapshot, iteration cap, convergence
 * check, and `finally` cleanup; the plan owns only table shape, round SQL, and
 * result extraction.
 */
export async function runIterativeGraphOperation<
  State extends IterativeGraphState,
  Result,
>(
  ctx: AlgorithmContext,
  options: InternalTraversalOptions,
  plan: IterativeGraphPlan<State, Result>,
): Promise<Result> {
  if (!ctx.backend.capabilities.transactions) {
    throw new ConfigurationError(
      "Temporary-table graph iteration requires a transactional backend.",
      { dialect: ctx.backend.dialect },
    );
  }

  return ctx.backend.transaction(
    async (backend) => {
      const temporaryBackend = requireTemporaryStatements(backend);
      const runId = generateId();
      const workingTable = sql.identifier(
        `typegraph_iterative_${runId.replaceAll("-", "_")}`,
      );
      const context: IterativeGraphRunContext = {
        operation: createOperation(ctx, options, temporaryBackend),
        backend: temporaryBackend,
        workingTable,
        graphId: ctx.graphId,
        runId,
        executeTemporary: async (query) => {
          await temporaryBackend.executeTemporaryStatement(
            asCompiledTemporaryStatementSql(query),
          );
        },
      };

      // Opt-in only: without an explicit workingMemory the rounds inherit
      // the engine's configured setting. When requested, the override is
      // transaction-scoped — `set_config(..., is_local => true)` reverts
      // when this transaction ends, so the session/server setting is never
      // touched. SQLite returns no statement here.
      if (context.operation.workingMemory !== undefined) {
        const workingMemoryStatement = ctx.dialect.setTransactionWorkingMemory(
          context.operation.workingMemory,
        );
        if (workingMemoryStatement !== undefined) {
          await context.executeTemporary(workingMemoryStatement);
        }
      }
      await context.executeTemporary(plan.createWorkingTable(context));
      let operationError: unknown;
      try {
        let state = await plan.initialize(context);
        let analyzedRowCount = await refreshWorkingTableStatistics(
          context,
          state.workingTableSize,
        );
        for (
          let iteration = 1;
          iteration <= plan.maxIterations && !plan.hasConverged(state);
          iteration++
        ) {
          state = await plan.runRound(context, state, iteration);
          // Statistics only pay off in a subsequent round: skip the refresh
          // when the operation just converged or the iteration budget is
          // spent — no further round will read the working table.
          if (iteration < plan.maxIterations && !plan.hasConverged(state)) {
            analyzedRowCount = await refreshWorkingTableStatistics(
              context,
              state.workingTableSize,
              analyzedRowCount,
            );
          }
        }
        if (!plan.hasConverged(state)) {
          throw new GraphAlgorithmConvergenceError(
            plan.algorithm,
            plan.maxIterations,
          );
        }
        return await plan.extractResult(context, state);
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        await dropWorkingTable(context, operationError);
      }
    },
    {
      isolationLevel: "repeatable_read",
      accessMode: "read_only",
      temporaryWrites: INTERNAL_TEMPORARY_WRITES,
    },
  );
}

export function shouldRefreshWorkingTableStatistics(
  workingTableSize: number,
  analyzedRowCount?: number,
): boolean {
  if (workingTableSize < WORKING_TABLE_ANALYZE_MINIMUM_ROWS) return false;
  if (analyzedRowCount === undefined) return true;
  return (
    workingTableSize >= analyzedRowCount * WORKING_TABLE_ANALYZE_GROWTH_FACTOR
  );
}

async function refreshWorkingTableStatistics(
  context: IterativeGraphRunContext,
  workingTableSize: number,
  analyzedRowCount?: number,
): Promise<number | undefined> {
  if (
    !shouldRefreshWorkingTableStatistics(workingTableSize, analyzedRowCount)
  ) {
    return analyzedRowCount;
  }
  const statement = context.operation.ctx.dialect.analyzeTemporaryTable(
    context.workingTable,
  );
  if (statement === undefined) return analyzedRowCount;
  await context.executeTemporary(statement);
  return workingTableSize;
}

async function dropWorkingTable(
  context: IterativeGraphRunContext,
  operationError: unknown,
): Promise<void> {
  try {
    await context.executeTemporary(
      sql`DROP TABLE IF EXISTS ${context.workingTable}`,
    );
  } catch (cleanupError) {
    // A failed PostgreSQL statement aborts the transaction, so DROP is
    // rejected too; rollback then owns cleanup. Preserve the algorithm's root
    // error instead of masking it with "transaction is aborted".
    if (operationError === undefined) throw cleanupError;
  }
}

export async function fetchVisibleWorkingNodes(
  operation: IterativeGraphOperation,
  nodeIds: readonly string[],
): Promise<readonly PathNode[]> {
  const nodes = new Map<NodeIdentityKey, PathNode>();
  for (const chunk of chunkValues(nodeIds, operation.maxWorkingSetSize)) {
    const query = sql`SELECT n.id, n.kind FROM ${operation.schema.nodesTable} n WHERE n.graph_id = ${operation.ctx.graphId} AND n.id IN (${sqlValueList(chunk)}) AND ${operation.nodeTemporalFilter}`;
    const rows = await operation.backend.execute<VisibleNodeRow>(
      asCompiledRowsSql(query),
    );
    for (const row of rows) nodes.set(nodeIdentityKey(row), row);
  }
  return [...nodes.values()].toSorted((left, right) =>
    compareNodeIdentity(left, right),
  );
}

/**
 * Expands one working-set round and reduces all matching edges by target-node
 * identity before returning to the host loop. Callers choose the reduction:
 * BFS keeps one predecessor, label-min keeps the smallest propagated label,
 * and other fixpoint algorithms can define their own associative merge.
 */
export async function reduceExpandedWorkingSet<T>(
  operation: IterativeGraphOperation,
  workingSet: readonly PathNode[],
  direction: TraversalDirection,
  reduce: (current: T | undefined, expansion: NodeExpansion) => T | undefined,
): Promise<ReadonlyMap<NodeIdentityKey, T>> {
  const reduced = new Map<NodeIdentityKey, T>();
  for (const edgeKinds of operation.edgeKindChunks) {
    for (const chunk of chunkValues(workingSet, operation.maxWorkingSetSize)) {
      const rows = await operation.backend.execute<ExpansionRow>(
        asCompiledRowsSql(
          compileExpansionQuery(operation, chunk, direction, edgeKinds),
        ),
      );
      for (const row of rows) {
        // A weighted operation compiles a weight column into every
        // expansion, and weighted algorithms audit their weight domain
        // before expanding — so a NULL weight here means either a plan
        // skipped that audit, or (on a backend without snapshot isolation)
        // a concurrent write invalidated a weight mid-run. Silently
        // dropping the edge would return plausible-but-wrong results.
        if (
          operation.weightExpression !== undefined &&
          !isPresent(row.weight)
        ) {
          throw new CompilerInvariantError(
            "Weighted graph expansion produced a NULL weight. Either the plan skipped its weight audit, or edge data changed concurrently during a run on a backend without snapshot isolation.",
            { source: row.source_id, target: row.target_id },
          );
        }
        const expansion = {
          source: { id: row.source_id, kind: row.source_kind },
          target: { id: row.target_id, kind: row.target_kind },
          ...(isPresent(row.weight) ? { weight: Number(row.weight) } : {}),
        } satisfies NodeExpansion;
        const targetKey = nodeIdentityKey(expansion.target);
        const selected = reduce(reduced.get(targetKey), expansion);
        if (selected !== undefined) reduced.set(targetKey, selected);
      }
    }
  }
  return reduced;
}

export function nodeIdentityKey(node: PathNode): NodeIdentityKey {
  return `${node.kind}\u0000${node.id}` as NodeIdentityKey;
}

/**
 * Builds a node-identity key from a working-table row's nullable
 * predecessor columns. Drivers deliver SQL NULL in varying shapes, so only
 * a string pair counts as a real predecessor.
 */
export function nodeIdentityKeyFromRow(
  id: unknown,
  kind: unknown,
): NodeIdentityKey | undefined {
  if (typeof id !== "string" || typeof kind !== "string") return undefined;
  return nodeIdentityKey({ id, kind });
}

export function compareNodeIdentity(left: PathNode, right: PathNode): number {
  return (
    compareCodePoints(left.id, right.id) ||
    compareCodePoints(left.kind, right.kind)
  );
}

type DirectionFields = Readonly<{
  joinField: "from_id" | "to_id";
  joinKindField: "from_kind" | "to_kind";
  targetField: "from_id" | "to_id";
  targetKindField: "from_kind" | "to_kind";
}>;

const OUTGOING_DIRECTION_FIELDS = {
  joinField: "from_id",
  joinKindField: "from_kind",
  targetField: "to_id",
  targetKindField: "to_kind",
} as const satisfies DirectionFields;

const INCOMING_DIRECTION_FIELDS = {
  joinField: "to_id",
  joinKindField: "to_kind",
  targetField: "from_id",
  targetKindField: "from_kind",
} as const satisfies DirectionFields;

function fieldsForDirection(
  direction: TraversalDirection,
): readonly DirectionFields[] {
  switch (direction) {
    case "out": {
      return [OUTGOING_DIRECTION_FIELDS];
    }
    case "in": {
      return [INCOMING_DIRECTION_FIELDS];
    }
    case "both": {
      return [OUTGOING_DIRECTION_FIELDS, INCOMING_DIRECTION_FIELDS];
    }
  }
}

function compileDirectionUnion(
  direction: TraversalDirection,
  compileDirection: (fields: DirectionFields) => SQL,
): SQL {
  return sql.join(
    fieldsForDirection(direction).map((fields) => compileDirection(fields)),
    sql` UNION ALL `,
  );
}

function compileExpansionQuery(
  operation: IterativeGraphOperation,
  workingSet: readonly PathNode[],
  direction: TraversalDirection,
  edgeKinds: readonly string[],
): ReturnType<typeof sql> {
  const workingValues = sql.join(
    workingSet.map((node) => sql`(${node.id}, ${node.kind})`),
    sql`, `,
  );
  const workingCte = sql`WITH working_set(node_id, node_kind) AS (VALUES ${workingValues})`;

  const expansion = compileDirectionUnion(direction, (fields) =>
    compileDirectionalExpansion(
      operation,
      sql`working_set`,
      sql`TRUE`,
      edgeKinds,
      fields.joinField,
      fields.joinKindField,
      fields.targetField,
      fields.targetKindField,
    ),
  );
  return sql`${workingCte} ${expansion}`;
}

export function compileWorkingTableExpansion(
  operation: IterativeGraphOperation,
  workingTable: WorkingTableIdentifier,
  sourceFilter: SQL,
  direction: TraversalDirection,
  edgeKinds: readonly string[],
): SQL {
  return compileDirectionUnion(direction, (fields) =>
    compileDirectionalExpansion(
      operation,
      workingTable,
      sourceFilter,
      edgeKinds,
      fields.joinField,
      fields.joinKindField,
      fields.targetField,
      fields.targetKindField,
    ),
  );
}

/**
 * Expands a working-table frontier through visible edges without joining target
 * nodes. Callers that reduce duplicate targets first can defer the target-node
 * visibility join until after that reduction, avoiding repeated point lookups
 * for the same target on dense frontiers. `sourceProjection` lets callers
 * carry trusted working-row state through the expansion without re-joining it.
 */
export function compileWorkingTableEdgeExpansion(
  operation: IterativeGraphOperation,
  workingTable: WorkingTableIdentifier,
  sourceFilter: SQL,
  direction: TraversalDirection,
  edgeKinds: readonly string[],
  sourceProjection?: SQL,
): SQL {
  return compileDirectionUnion(direction, (fields) =>
    compileDirectionalEdgeExpansion(
      operation,
      workingTable,
      sourceFilter,
      edgeKinds,
      fields.joinField,
      fields.joinKindField,
      fields.targetField,
      fields.targetKindField,
      sourceProjection,
    ),
  );
}

function compileDirectionalExpansion(
  operation: IterativeGraphOperation,
  workingRelation: SQL | WorkingTableIdentifier,
  sourceFilter: SQL,
  edgeKinds: readonly string[],
  joinField: "from_id" | "to_id",
  joinKindField: "from_kind" | "to_kind",
  targetField: "from_id" | "to_id",
  targetKindField: "from_kind" | "to_kind",
): ReturnType<typeof sql> {
  const edgeExpansion = compileDirectionalEdgeExpansion(
    operation,
    workingRelation,
    sourceFilter,
    edgeKinds,
    joinField,
    joinKindField,
    targetField,
    targetKindField,
  );
  const weightColumn =
    operation.weightExpression === undefined ? sql`` : sql`, expanded.weight`;
  return sql`SELECT expanded.source_id, expanded.source_kind, n.id AS target_id, n.kind AS target_kind${weightColumn} FROM (${edgeExpansion}) expanded JOIN ${operation.schema.nodesTable} n ON n.graph_id = ${operation.ctx.graphId} AND n.id = expanded.target_id AND n.kind = expanded.target_kind WHERE ${operation.nodeTemporalFilter}`;
}

function compileDirectionalEdgeExpansion(
  operation: IterativeGraphOperation,
  workingRelation: SQL | WorkingTableIdentifier,
  sourceFilter: SQL,
  edgeKinds: readonly string[],
  joinField: "from_id" | "to_id",
  joinKindField: "from_kind" | "to_kind",
  targetField: "from_id" | "to_id",
  targetKindField: "from_kind" | "to_kind",
  sourceProjection?: SQL,
): ReturnType<typeof sql> {
  const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), edgeKinds);
  const weightColumn =
    operation.weightExpression === undefined ?
      sql``
    : sql`, ${operation.weightExpression} AS weight`;
  const sourceColumns =
    sourceProjection === undefined ? sql`` : sql`, ${sourceProjection}`;
  return sql`SELECT w.node_id AS source_id, w.node_kind AS source_kind${sourceColumns}, e.${sql.raw(targetField)} AS target_id, e.${sql.raw(targetKindField)} AS target_kind${weightColumn} FROM ${workingRelation} w JOIN ${operation.schema.edgesTable} e ON e.${sql.raw(joinField)} = w.node_id AND e.${sql.raw(joinKindField)} = w.node_kind AND e.graph_id = ${operation.ctx.graphId} WHERE ${sourceFilter} AND ${edgeKindFilter} AND ${operation.edgeTemporalFilter}`;
}

function chunkValues<T>(
  values: readonly T[],
  chunkSize: number,
): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    chunks.push(values.slice(offset, offset + chunkSize));
  }
  return chunks;
}

function createOperation(
  ctx: AlgorithmContext,
  options: InternalTraversalOptions,
  backend: QueryBackend | TransactionBackend,
): IterativeGraphOperation {
  const temporal = resolveTemporalOptions(ctx, options);
  const currentTimestamp = currentReadInstant();
  const nodeTemporalFilter = compileTemporalFilter({
    mode: temporal.temporalMode,
    ...(temporal.asOf === undefined ? {} : { asOf: temporal.asOf }),
    ...(temporal.recordedAsOf === undefined ?
      {}
    : { recordedAsOf: temporal.recordedAsOf }),
    tableAlias: "n",
    currentTimestamp,
  });
  const edgeTemporalFilter = compileTemporalFilter({
    mode: temporal.temporalMode,
    ...(temporal.asOf === undefined ? {} : { asOf: temporal.asOf }),
    ...(temporal.recordedAsOf === undefined ?
      {}
    : { recordedAsOf: temporal.recordedAsOf }),
    tableAlias: "e",
    currentTimestamp,
  });
  const weightExpression =
    options.weightProperty === undefined ?
      undefined
    : compileWeightExpression(
        ctx.dialect,
        options.weightProperty,
        options.defaultWeight,
      );
  const direction = options.direction ?? "out";
  const branchCount = direction === "both" ? 2 : 1;
  const parameterLimit =
    backend.capabilities.maxBindParameters ?? DEFAULT_MAX_BIND_PARAMETERS;
  const reservedPerBranch =
    RESERVED_TEMPORAL_BIND_PARAMETERS_PER_BRANCH +
    (weightExpression === undefined ? 0 : (
      RESERVED_WEIGHT_BIND_PARAMETERS_PER_BRANCH
    ));
  const fixedParameters = branchCount * reservedPerBranch;
  const sharedBudget = parameterLimit - fixedParameters;
  const maxEdgeKindsPerQuery = Math.floor(sharedBudget / (branchCount + 2));
  if (maxEdgeKindsPerQuery < 1) {
    throw new ConfigurationError(
      "An iterative graph operation cannot fit its fixed filters within the backend bind-parameter limit.",
      { parameterLimit, direction },
    );
  }
  const edgeKindChunks = chunkValues(
    [...new Set(options.edges)].toSorted((left, right) =>
      compareStrings(left, right),
    ),
    maxEdgeKindsPerQuery,
  );
  const largestEdgeKindChunk = Math.max(
    ...edgeKindChunks.map((chunk) => chunk.length),
  );
  const maxWorkingSetSize = Math.floor(
    (parameterLimit -
      branchCount * (largestEdgeKindChunk + reservedPerBranch)) /
      2,
  );
  if (maxWorkingSetSize < 1) {
    throw new ConfigurationError(
      "An iterative graph operation cannot fit one working-set node within the backend bind-parameter limit.",
      { parameterLimit, direction },
    );
  }

  return {
    backend,
    ctx,
    edgeKindChunks,
    direction,
    maxWorkingSetSize,
    nodeTemporalFilter,
    edgeTemporalFilter,
    schema: resolveReadSchema(ctx, options),
    workingMemory: resolveWorkingMemory(options.workingMemory),
    weightExpression,
  };
}

/**
 * Compiles the per-edge weight expression over the expansion's edge alias
 * `e`. The extraction is cast to DOUBLE PRECISION — a spelling both engines
 * accept — so weight arithmetic is IEEE 754 double on both backends.
 * PostgreSQL's `::numeric` extraction would use exact decimal arithmetic and
 * could produce different accumulated distances (and therefore different
 * paths) than SQLite's binary doubles.
 *
 * The weight audit runs before any expansion, so by the time this expression
 * evaluates, every selected edge's property is a JSON number (never text the
 * cast could mangle or reject) or absent with a configured default.
 */
function compileWeightExpression(
  dialect: DialectAdapter,
  weightProperty: string,
  defaultWeight: number | undefined,
): SQL {
  const extracted = dialect.jsonExtractDouble(
    sql.raw("e.props"),
    jsonPointer([weightProperty]),
  );
  return defaultWeight === undefined ? extracted : (
      sql`COALESCE(${extracted}, ${defaultWeight})`
    );
}

/**
 * Whether the backend can host working-table rounds: a pinned transactional
 * connection, temporary-statement support, and `INSERT … RETURNING` for the
 * folded frontier bookkeeping. Callers without it take the inline
 * chunked-`VALUES` fallback.
 */
export function supportsTemporaryIteration(ctx: AlgorithmContext): boolean {
  return (
    ctx.backend.capabilities.transactions &&
    ctx.backend.capabilities.graphAnalytics?.supported !== false &&
    ctx.backend.capabilities.returning !== false &&
    ctx.backend.executeTemporaryStatement !== undefined
  );
}

function requireTemporaryStatements(
  backend: TransactionBackend,
): TemporaryStatementBackend {
  if (backend.executeTemporaryStatement === undefined) {
    throw new ConfigurationError(
      "Iterative graph operations require temporary-statement support on the transaction backend.",
      { dialect: backend.dialect },
      {
        suggestion:
          "Use a built-in SQLite/PostgreSQL backend or implement executeTemporaryStatement on the custom backend.",
      },
    );
  }
  return backend as TemporaryStatementBackend;
}
