import { type SQL, sql } from "drizzle-orm";

import type { GraphDef } from "../../core/define-graph";
import { compileKindFilter } from "../../query/compiler/predicate-utils";
import { asCompiledRowsSql } from "../../query/sql-intent";
import {
  type AlgorithmContext,
  assertEdgeKinds,
  assertGraphAnalyticsSupported,
  type InternalTraversalOptions,
  normalizeNodeKinds,
  pickTemporalOptions,
  resolveMaxIterations,
} from "./context";
import {
  compileWorkingTableEdgeExpansion,
  frontierIndexIdentifier,
  type IterativeGraphRunContext,
  runIterativeGraphOperation,
} from "./iterative-graph-operation";
import type {
  InternalLabelPropagationOptions,
  LabelPropagationMembership,
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
  label_id: string;
  label_kind: string;
}>;

const DEFAULT_LABEL_PROPAGATION_MAX_ITERATIONS = 1000;

/** Runs exact synchronous CDLP in the shared temporary-table loop. */
export async function executeLabelPropagation<G extends GraphDef>(
  ctx: AlgorithmContext,
  options: InternalLabelPropagationOptions<G>,
): Promise<readonly LabelPropagationMembership[]> {
  assertEdgeKinds(options.edges);
  assertGraphAnalyticsSupported(ctx, "labelPropagation", {
    requiresWindowFunctions: true,
  });
  const maxIterations = resolveMaxIterations(
    options.maxIterations,
    DEFAULT_LABEL_PROPAGATION_MAX_ITERATIONS,
    "labelPropagation",
  );
  const nodeKinds = normalizeNodeKinds(options.nodeKinds);
  const traversalOptions: InternalTraversalOptions = {
    edges: options.edges,
    direction: "both",
    ...pickTemporalOptions(options),
    ...(options.workingMemory === undefined ?
      {}
    : { workingMemory: options.workingMemory }),
  };

  return runIterativeGraphOperation(ctx, traversalOptions, {
    algorithm: "labelPropagation",
    maxIterations,
    createWorkingTable,
    initialize: (context) => initializeWorkingTables(context, nodeKinds),
    runRound: runLabelPropagationRound,
    hasConverged(state) {
      return state.changedCount === 0;
    },
    extractResult: extractMemberships,
    cleanup: dropNeighborTable,
  });
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
      changed_round INTEGER NOT NULL,
      active_round INTEGER NOT NULL,
      PRIMARY KEY (graph_id, run_id, node_kind, node_id)
    )
  `;
}

function neighborTableIdentifier(context: IterativeGraphRunContext) {
  return sql.identifier(
    `typegraph_iterative_n_${context.runId.replaceAll("-", "_")}`,
  );
}

function activeIndexIdentifier(context: IterativeGraphRunContext) {
  return sql.identifier(
    `typegraph_iterative_a_${context.runId.replaceAll("-", "_")}`,
  );
}

function reverseNeighborIndexIdentifier(context: IterativeGraphRunContext) {
  return sql.identifier(
    `typegraph_iterative_r_${context.runId.replaceAll("-", "_")}`,
  );
}

async function initializeWorkingTables(
  context: IterativeGraphRunContext,
  nodeKinds: readonly string[] | undefined,
): Promise<IterationState> {
  const { operation, workingTable, graphId, runId } = context;
  const nodeKindFilter =
    nodeKinds === undefined ?
      sql`TRUE`
    : compileKindFilter(sql.raw("n.kind"), nodeKinds);
  await context.executeTemporary(sql`
    INSERT INTO ${workingTable}
      (graph_id, run_id, node_id, node_kind, label_id, label_kind,
       next_label_id, next_label_kind, changed_round, active_round)
    SELECT
      ${graphId}, ${runId}, n.id, n.kind, n.id, n.kind, n.id, n.kind, 0, 1
    FROM ${operation.schema.nodesTable} n
    WHERE n.graph_id = ${graphId}
      AND ${nodeKindFilter}
      AND ${operation.nodeTemporalFilter}
  `);
  await context.executeTemporary(sql`
    CREATE INDEX ${frontierIndexIdentifier(context)}
    ON ${workingTable} (graph_id, run_id, changed_round)
  `);
  await context.executeTemporary(sql`
    CREATE INDEX ${activeIndexIdentifier(context)}
    ON ${workingTable} (graph_id, run_id, active_round)
  `);
  const neighborTable = neighborTableIdentifier(context);
  await context.executeTemporary(sql`
    CREATE TEMP TABLE ${neighborTable} (
      target_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      neighbor_id TEXT NOT NULL,
      neighbor_kind TEXT NOT NULL,
      PRIMARY KEY (target_kind, target_id, neighbor_kind, neighbor_id)
    )
  `);
  await context.executeTemporary(sql`
    CREATE INDEX ${reverseNeighborIndexIdentifier(context)}
    ON ${neighborTable}
      (neighbor_kind, neighbor_id, target_kind, target_id)
  `);
  for (const edgeKinds of operation.edgeKindChunks) {
    await materializeChunkNeighbors(context, edgeKinds);
  }
  const analyzeNeighbors =
    operation.ctx.dialect.analyzeTemporaryTable(neighborTable);
  if (analyzeNeighbors !== undefined) {
    await context.executeTemporary(analyzeNeighbors);
  }

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
  iteration: number,
): Promise<IterationState> {
  // Every node owns a distinct initial label, so every non-isolated node votes
  // in round one. Later rounds activate only neighbors of the changed frontier.
  if (iteration > 1) {
    await markActiveNeighbors(context, iteration);
  }
  await selectWinningLabels(context, iteration);
  const changedRows = await applyNextLabels(context, iteration);
  return {
    changedCount: changedRows.length,
    workingTableSize: state.workingTableSize,
  };
}

/** Marks exactly the nodes whose vote multiset may have changed this round. */
async function markActiveNeighbors(
  context: IterativeGraphRunContext,
  iteration: number,
): Promise<void> {
  const { workingTable, graphId, runId } = context;
  const neighborTable = neighborTableIdentifier(context);
  await context.executeTemporary(sql`
    WITH candidates AS (
      SELECT DISTINCT neighbors.target_id, neighbors.target_kind
      FROM ${workingTable} changed
      JOIN ${neighborTable} neighbors
        ON neighbors.neighbor_id = changed.node_id
        AND neighbors.neighbor_kind = changed.node_kind
      WHERE changed.graph_id = ${graphId}
        AND changed.run_id = ${runId}
        AND changed.changed_round = ${iteration - 1}
    )
    UPDATE ${workingTable} AS target
    SET active_round = ${iteration}
    FROM candidates
    WHERE target.graph_id = ${graphId}
      AND target.run_id = ${runId}
      AND target.node_id = candidates.target_id
      AND target.node_kind = candidates.target_kind
      AND target.active_round <> ${iteration}
  `);
}

/**
 * Materializes one bind-budget edge-kind chunk into the immutable neighbor
 * relation. The primary key collapses parallel edges and duplicate neighbors
 * across chunks; self-loops are excluded because a node is not its own
 * neighbor for CDLP.
 */
async function materializeChunkNeighbors(
  context: IterativeGraphRunContext,
  edgeKinds: readonly string[],
): Promise<void> {
  const { operation, workingTable, graphId, runId } = context;
  const expansion = compileWorkingTableEdgeExpansion(
    operation,
    workingTable,
    sql`
      w.graph_id = ${graphId}
      AND w.run_id = ${runId}
    `,
    "both",
    edgeKinds,
  );
  const neighborTable = neighborTableIdentifier(context);
  await context.executeTemporary(sql`
    INSERT INTO ${neighborTable}
      (target_id, target_kind, neighbor_id, neighbor_kind)
    SELECT DISTINCT
      expanded.source_id,
      expanded.source_kind,
      expanded.target_id,
      expanded.target_kind
    FROM (${expansion}) expanded
    JOIN ${workingTable} scoped_neighbor
      ON scoped_neighbor.graph_id = ${graphId}
      AND scoped_neighbor.run_id = ${runId}
      AND scoped_neighbor.node_id = expanded.target_id
      AND scoped_neighbor.node_kind = expanded.target_kind
    WHERE expanded.source_id <> expanded.target_id
      OR expanded.source_kind <> expanded.target_kind
    ON CONFLICT (target_kind, target_id, neighbor_kind, neighbor_id)
    DO NOTHING
  `);
}

async function selectWinningLabels(
  context: IterativeGraphRunContext,
  iteration: number,
): Promise<void> {
  const { operation, workingTable, graphId, runId } = context;
  const neighborTable = neighborTableIdentifier(context);
  const targetId = operation.ctx.dialect.binaryText(sql`totals.target_id`);
  const targetKind = operation.ctx.dialect.binaryText(sql`totals.target_kind`);
  const labelId = operation.ctx.dialect.binaryText(sql`totals.label_id`);
  const labelKind = operation.ctx.dialect.binaryText(sql`totals.label_kind`);
  await context.executeTemporary(sql`
    WITH totals AS (
      SELECT
        neighbors.target_id,
        neighbors.target_kind,
        neighbor.label_id,
        neighbor.label_kind,
        COUNT(*) AS total_votes
      FROM ${neighborTable} neighbors
      JOIN ${workingTable} active
        ON active.graph_id = ${graphId}
        AND active.run_id = ${runId}
        AND active.active_round = ${iteration}
        AND active.node_id = neighbors.target_id
        AND active.node_kind = neighbors.target_kind
      JOIN ${workingTable} neighbor
        ON neighbor.graph_id = ${graphId}
        AND neighbor.run_id = ${runId}
        AND neighbor.node_id = neighbors.neighbor_id
        AND neighbor.node_kind = neighbors.neighbor_kind
      GROUP BY
        target_id,
        target_kind,
        neighbor.label_id,
        neighbor.label_kind
    ), ranked AS (
      SELECT
        target_id,
        target_kind,
        label_id,
        label_kind,
        ROW_NUMBER() OVER (
          PARTITION BY ${targetKind}, ${targetId}
          ORDER BY total_votes DESC, ${labelId}, ${labelKind}
        ) AS label_rank
      FROM totals
    )
    UPDATE ${workingTable} AS target
    SET next_label_id = ranked.label_id,
        next_label_kind = ranked.label_kind
    FROM ranked
    WHERE target.graph_id = ${graphId}
      AND target.run_id = ${runId}
      AND target.active_round = ${iteration}
      AND target.node_id = ranked.target_id
      AND target.node_kind = ranked.target_kind
      AND ranked.label_rank = 1
      AND (
        target.next_label_id <> ranked.label_id
        OR target.next_label_kind <> ranked.label_kind
      )
  `);
}

function applyNextLabels(
  context: IterativeGraphRunContext,
  iteration: number,
): Promise<readonly ChangedRow[]> {
  return context.backend.execute<ChangedRow>(
    asCompiledRowsSql(sql`
      UPDATE ${context.workingTable}
      SET label_id = next_label_id,
          label_kind = next_label_kind,
          changed_round = ${iteration}
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
): Promise<readonly LabelPropagationMembership[]> {
  const { operation } = context;
  const labelId = operation.ctx.dialect.binaryText(sql`label_id`);
  const labelKind = operation.ctx.dialect.binaryText(sql`label_kind`);
  const nodeId = operation.ctx.dialect.binaryText(sql`node_id`);
  const nodeKind = operation.ctx.dialect.binaryText(sql`node_kind`);
  const rows = await context.backend.execute<MembershipRow>(
    asCompiledRowsSql(sql`
      SELECT
        node_id,
        node_kind,
        label_id,
        label_kind
      FROM ${context.workingTable}
      WHERE graph_id = ${context.graphId} AND run_id = ${context.runId}
      ORDER BY ${labelId}, ${labelKind}, ${nodeId}, ${nodeKind}
    `),
  );

  return rows.map((row) => ({
    id: row.node_id,
    kind: row.node_kind,
    labelId: row.label_id,
    labelKind: row.label_kind,
  }));
}

async function dropNeighborTable(
  context: IterativeGraphRunContext,
): Promise<void> {
  await context.executeTemporary(
    sql`DROP TABLE IF EXISTS ${neighborTableIdentifier(context)}`,
  );
}
