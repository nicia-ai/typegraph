import { type SQL, sql } from "drizzle-orm";

import {
  type GraphBackend,
  INTERNAL_TEMPORARY_WRITES,
  type TransactionBackend,
} from "../../backend/types";
import {
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
import {
  asCompiledRowsSql,
  asCompiledTemporaryStatementSql,
} from "../../query/sql-intent";
import { compareStrings } from "../../utils/compare";
import { generateId } from "../../utils/id";
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
}>;

export type NodeIdentityKey = string & {
  readonly __nodeIdentityKey: unique symbol;
};

export type NodeExpansion = Readonly<{
  source: PathNode;
  target: PathNode;
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
}>;

type VisibleNodeRow = Readonly<{
  id: string;
  kind: string;
}>;

const DEFAULT_MAX_BIND_PARAMETERS = 999;
const RESERVED_TEMPORAL_BIND_PARAMETERS_PER_BRANCH = 12;
/**
 * PostgreSQL initially estimates an un-analyzed temporary relation at one row.
 * A 64x miss is large enough to distort join ordering, while ANALYZE remains a
 * low-single-digit-millisecond operation at this size.
 */
export const WORKING_TABLE_ANALYZE_MINIMUM_ROWS = 64;
/** Caps statistics drift for growing BFS-style working tables at under 4x. */
export const WORKING_TABLE_ANALYZE_GROWTH_FACTOR = 4;

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
          if (!plan.hasConverged(state)) {
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
        const expansion = {
          source: { id: row.source_id, kind: row.source_kind },
          target: { id: row.target_id, kind: row.target_kind },
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

export function compareNodeIdentity(left: PathNode, right: PathNode): number {
  return (
    compareStrings(left.id, right.id) || compareStrings(left.kind, right.kind)
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

  switch (direction) {
    case "out": {
      return sql`${workingCte} ${compileDirectionalExpansion(operation, sql`working_set`, sql`TRUE`, edgeKinds, "from_id", "from_kind", "to_id", "to_kind")}`;
    }
    case "in": {
      return sql`${workingCte} ${compileDirectionalExpansion(operation, sql`working_set`, sql`TRUE`, edgeKinds, "to_id", "to_kind", "from_id", "from_kind")}`;
    }
    case "both": {
      const outgoing = compileDirectionalExpansion(
        operation,
        sql`working_set`,
        sql`TRUE`,
        edgeKinds,
        "from_id",
        "from_kind",
        "to_id",
        "to_kind",
      );
      const incoming = compileDirectionalExpansion(
        operation,
        sql`working_set`,
        sql`TRUE`,
        edgeKinds,
        "to_id",
        "to_kind",
        "from_id",
        "from_kind",
      );
      return sql`${workingCte} ${outgoing} UNION ALL ${incoming}`;
    }
  }
}

export function compileWorkingTableExpansion(
  operation: IterativeGraphOperation,
  workingTable: WorkingTableIdentifier,
  sourceFilter: SQL,
  direction: TraversalDirection,
  edgeKinds: readonly string[],
): SQL {
  switch (direction) {
    case "out": {
      return compileDirectionalExpansion(
        operation,
        workingTable,
        sourceFilter,
        edgeKinds,
        "from_id",
        "from_kind",
        "to_id",
        "to_kind",
      );
    }
    case "in": {
      return compileDirectionalExpansion(
        operation,
        workingTable,
        sourceFilter,
        edgeKinds,
        "to_id",
        "to_kind",
        "from_id",
        "from_kind",
      );
    }
    case "both": {
      const outgoing = compileDirectionalExpansion(
        operation,
        workingTable,
        sourceFilter,
        edgeKinds,
        "from_id",
        "from_kind",
        "to_id",
        "to_kind",
      );
      const incoming = compileDirectionalExpansion(
        operation,
        workingTable,
        sourceFilter,
        edgeKinds,
        "to_id",
        "to_kind",
        "from_id",
        "from_kind",
      );
      return sql`${outgoing} UNION ALL ${incoming}`;
    }
  }
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
  const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), edgeKinds);
  return sql`SELECT w.node_id AS source_id, w.node_kind AS source_kind, n.id AS target_id, n.kind AS target_kind FROM ${workingRelation} w JOIN ${operation.schema.edgesTable} e ON e.${sql.raw(joinField)} = w.node_id AND e.${sql.raw(joinKindField)} = w.node_kind AND e.graph_id = ${operation.ctx.graphId} JOIN ${operation.schema.nodesTable} n ON n.graph_id = e.graph_id AND n.id = e.${sql.raw(targetField)} AND n.kind = e.${sql.raw(targetKindField)} WHERE ${sourceFilter} AND ${edgeKindFilter} AND ${operation.edgeTemporalFilter} AND ${operation.nodeTemporalFilter}`;
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
  const direction = options.direction ?? "out";
  const branchCount = direction === "both" ? 2 : 1;
  const parameterLimit =
    backend.capabilities.maxBindParameters ?? DEFAULT_MAX_BIND_PARAMETERS;
  const fixedParameters =
    branchCount * RESERVED_TEMPORAL_BIND_PARAMETERS_PER_BRANCH;
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
      branchCount *
        (largestEdgeKindChunk + RESERVED_TEMPORAL_BIND_PARAMETERS_PER_BRANCH)) /
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
  };
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
