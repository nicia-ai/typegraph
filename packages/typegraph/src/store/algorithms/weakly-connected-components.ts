import { type SQL, sql } from "drizzle-orm";

import type { GraphDef } from "../../core/define-graph";
import {
  ConfigurationError,
  UnsupportedBackendCapabilityError,
} from "../../errors";
import { asCompiledRowsSql } from "../../query/sql-intent";
import { compareCodePoints } from "../../utils/compare";
import {
  type AlgorithmContext,
  assertEdgeKinds,
  type InternalTraversalOptions,
} from "./context";
import {
  compileWorkingTableExpansion,
  type IterativeGraphRunContext,
  runIterativeGraphOperation,
} from "./iterative-graph-operation";
import type {
  InternalWeaklyConnectedComponentsOptions,
  WeaklyConnectedComponentMembership,
} from "./types";

type IterationState = Readonly<{
  changedCount: number;
  workingTableSize: number;
}>;
type CountRow = Readonly<{ count: number | string }>;
type ChangedRow = Readonly<{ node_id: string }>;
type MembershipRow = Readonly<{
  node_id: string;
  node_kind: string;
  component_id: string;
  component_kind: string;
  component_size: number | string;
}>;

const DEFAULT_WCC_MAX_ITERATIONS = 1000;

/** Runs exact label-min weakly connected components in the shared SQL loop. */
export async function executeWeaklyConnectedComponents<G extends GraphDef>(
  ctx: AlgorithmContext,
  options: InternalWeaklyConnectedComponentsOptions<G>,
): Promise<readonly WeaklyConnectedComponentMembership[]> {
  assertEdgeKinds(options.edges);
  assertWeaklyConnectedComponentsSupported(ctx);
  const maxIterations = resolveMaxIterations(options.maxIterations);
  const traversalOptions: InternalTraversalOptions = {
    edges: options.edges,
    direction: "both",
    ...(options.temporalMode === undefined ?
      {}
    : { temporalMode: options.temporalMode }),
    ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
    ...(options.recordedAsOf === undefined ?
      {}
    : { recordedAsOf: options.recordedAsOf }),
  };

  return runIterativeGraphOperation(ctx, traversalOptions, {
    algorithm: "weaklyConnectedComponents",
    maxIterations,
    createWorkingTable,
    initialize: initializeWorkingTable,
    runRound: runLabelPropagationRound,
    hasConverged(state) {
      return state.changedCount === 0;
    },
    extractResult: extractMemberships,
  });
}

function assertWeaklyConnectedComponentsSupported(ctx: AlgorithmContext): void {
  if (
    ctx.backend.capabilities.graphAnalytics?.supported === true &&
    ctx.backend.capabilities.windowFunctions
  ) {
    return;
  }

  throw new UnsupportedBackendCapabilityError(
    "weaklyConnectedComponents",
    "graphAnalytics",
    {
      dialect: ctx.backend.dialect,
      supported: ctx.backend.capabilities.graphAnalytics?.supported === true,
      windowFunctions: ctx.backend.capabilities.windowFunctions,
    },
    "Use a built-in transactional SQLite/PostgreSQL backend, or declare graphAnalytics support on a compatible custom backend.",
  );
}

function resolveMaxIterations(value: number | undefined): number {
  const maxIterations = value ?? DEFAULT_WCC_MAX_ITERATIONS;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
    throw new ConfigurationError(
      `weaklyConnectedComponents maxIterations must be a positive safe integer, got ${String(maxIterations)}.`,
      { maxIterations },
    );
  }
  return maxIterations;
}

function createWorkingTable(context: IterativeGraphRunContext): SQL {
  return sql`
    CREATE TEMP TABLE ${context.workingTable} (
      graph_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_kind TEXT NOT NULL,
      label_id TEXT NOT NULL,
      label_kind TEXT NOT NULL,
      next_label_id TEXT NOT NULL,
      next_label_kind TEXT NOT NULL,
      PRIMARY KEY (graph_id, run_id, node_kind, node_id)
    )
  `;
}

async function initializeWorkingTable(
  context: IterativeGraphRunContext,
): Promise<IterationState> {
  const { operation, workingTable, graphId, runId } = context;
  await context.executeTemporary(sql`
    INSERT INTO ${workingTable}
      (graph_id, run_id, node_id, node_kind, label_id, label_kind,
       next_label_id, next_label_kind)
    SELECT
      ${graphId}, ${runId}, n.id, n.kind, n.id, n.kind, n.id, n.kind
    FROM ${operation.schema.nodesTable} n
    WHERE n.graph_id = ${graphId}
      AND ${operation.nodeTemporalFilter}
  `);

  const rows = await context.backend.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS count
      FROM ${workingTable}
      WHERE graph_id = ${graphId} AND run_id = ${runId}
    `),
  );
  const workingTableSize = Number(rows[0]?.count ?? 0);
  return { changedCount: workingTableSize, workingTableSize };
}

async function runLabelPropagationRound(
  context: IterativeGraphRunContext,
  state: IterationState,
): Promise<IterationState> {
  await resetNextLabels(context);
  for (const edgeKinds of context.operation.edgeKindChunks) {
    await propagateChunkLabels(context, edgeKinds);
  }
  const changedRows = await applyNextLabels(context);
  return {
    changedCount: changedRows.length,
    workingTableSize: state.workingTableSize,
  };
}

async function resetNextLabels(
  context: IterativeGraphRunContext,
): Promise<void> {
  await context.executeTemporary(sql`
    UPDATE ${context.workingTable}
    SET next_label_id = label_id, next_label_kind = label_kind
    WHERE graph_id = ${context.graphId} AND run_id = ${context.runId}
  `);
}

async function propagateChunkLabels(
  context: IterativeGraphRunContext,
  edgeKinds: readonly string[],
): Promise<void> {
  const { operation, workingTable, graphId, runId } = context;
  const expansion = compileWorkingTableExpansion(
    operation,
    workingTable,
    sql`w.graph_id = ${graphId} AND w.run_id = ${runId}`,
    "both",
    edgeKinds,
  );
  const candidateId = operation.ctx.dialect.binaryText(sql`ranked.label_id`);
  const candidateKind = operation.ctx.dialect.binaryText(
    sql`ranked.label_kind`,
  );
  const currentId = operation.ctx.dialect.binaryText(sql`target.next_label_id`);
  const currentKind = operation.ctx.dialect.binaryText(
    sql`target.next_label_kind`,
  );
  const sourceId = operation.ctx.dialect.binaryText(sql`source.label_id`);
  const sourceKind = operation.ctx.dialect.binaryText(sql`source.label_kind`);
  const targetId = operation.ctx.dialect.binaryText(sql`source.target_id`);
  const targetKind = operation.ctx.dialect.binaryText(sql`source.target_kind`);

  await context.executeTemporary(sql`
    WITH candidates AS (
      SELECT
        expanded.target_id,
        expanded.target_kind,
        source.label_id,
        source.label_kind
      FROM (${expansion}) expanded
      JOIN ${workingTable} source
        ON source.graph_id = ${graphId}
        AND source.run_id = ${runId}
        AND source.node_id = expanded.source_id
        AND source.node_kind = expanded.source_kind
    ), ranked AS (
      SELECT
        target_id,
        target_kind,
        label_id,
        label_kind,
        ROW_NUMBER() OVER (
          PARTITION BY ${targetKind}, ${targetId}
          ORDER BY ${sourceId}, ${sourceKind}
        ) AS candidate_rank
      FROM candidates source
    )
    UPDATE ${workingTable} AS target
    SET next_label_id = ranked.label_id,
        next_label_kind = ranked.label_kind
    FROM ranked
    WHERE target.graph_id = ${graphId}
      AND target.run_id = ${runId}
      AND target.node_id = ranked.target_id
      AND target.node_kind = ranked.target_kind
      AND ranked.candidate_rank = 1
      AND (
        ${candidateId} < ${currentId}
        OR (
          ${candidateId} = ${currentId}
          AND ${candidateKind} < ${currentKind}
        )
      )
  `);
}

function applyNextLabels(
  context: IterativeGraphRunContext,
): Promise<readonly ChangedRow[]> {
  return context.backend.execute<ChangedRow>(
    asCompiledRowsSql(sql`
      UPDATE ${context.workingTable}
      SET label_id = next_label_id, label_kind = next_label_kind
      WHERE graph_id = ${context.graphId}
        AND run_id = ${context.runId}
        AND (
          label_id <> next_label_id OR label_kind <> next_label_kind
        )
      RETURNING node_id
    `),
  );
}

async function extractMemberships(
  context: IterativeGraphRunContext,
): Promise<readonly WeaklyConnectedComponentMembership[]> {
  const { operation } = context;
  const componentId = operation.ctx.dialect.binaryText(sql`label_id`);
  const componentKind = operation.ctx.dialect.binaryText(sql`label_kind`);
  const nodeId = operation.ctx.dialect.binaryText(sql`node_id`);
  const nodeKind = operation.ctx.dialect.binaryText(sql`node_kind`);
  const rows = await context.backend.execute<MembershipRow>(
    asCompiledRowsSql(sql`
      SELECT
        node_id,
        node_kind,
        label_id AS component_id,
        label_kind AS component_kind,
        COUNT(*) OVER (
          PARTITION BY ${componentKind}, ${componentId}
        ) AS component_size
      FROM ${context.workingTable}
      WHERE graph_id = ${context.graphId} AND run_id = ${context.runId}
      ORDER BY ${componentId}, ${componentKind}, ${nodeId}, ${nodeKind}
    `),
  );

  return rows
    .map((row) => ({
      id: row.node_id,
      kind: row.node_kind,
      componentId: row.component_id,
      componentKind: row.component_kind,
      size: Number(row.component_size),
    }))
    .toSorted(compareMemberships);
}

function compareMemberships(
  left: WeaklyConnectedComponentMembership,
  right: WeaklyConnectedComponentMembership,
): number {
  return (
    compareCodePoints(left.componentId, right.componentId) ||
    compareCodePoints(left.componentKind, right.componentKind) ||
    compareCodePoints(left.id, right.id) ||
    compareCodePoints(left.kind, right.kind)
  );
}
