import { type SQL, sql } from "drizzle-orm";

import type { GraphDef } from "../../core/define-graph";
import { compileKindFilter } from "../../query/compiler/predicate-utils";
import { asCompiledRowsSql } from "../../query/sql-intent";
import { compareCodePoints } from "../../utils/compare";
import {
  type AlgorithmContext,
  assertEdgeKinds,
  assertGraphAnalyticsSupported,
  type InternalTraversalOptions,
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
  assertGraphAnalyticsSupported(ctx, "weaklyConnectedComponents", {
    requiresWindowFunctions: true,
  });
  const maxIterations = resolveMaxIterations(
    options.maxIterations,
    DEFAULT_WCC_MAX_ITERATIONS,
    "weaklyConnectedComponents",
  );
  const nodeKinds =
    options.nodeKinds === undefined ?
      undefined
    : [...new Set(options.nodeKinds)].toSorted((left, right) =>
        compareCodePoints(left, right),
      );
  const traversalOptions: InternalTraversalOptions = {
    edges: options.edges,
    direction: "both",
    ...pickTemporalOptions(options),
    ...(options.workingMemory === undefined ?
      {}
    : { workingMemory: options.workingMemory }),
  };

  return runIterativeGraphOperation(ctx, traversalOptions, {
    algorithm: "weaklyConnectedComponents",
    maxIterations,
    createWorkingTable,
    initialize: (context) => initializeWorkingTable(context, nodeKinds),
    runRound: runLabelPropagationRound,
    hasConverged(state) {
      return state.changedCount === 0;
    },
    extractResult: extractMemberships,
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
      improved_round INTEGER NOT NULL,
      PRIMARY KEY (graph_id, run_id, node_kind, node_id)
    )
  `;
}

async function initializeWorkingTable(
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
       next_label_id, next_label_kind, improved_round)
    SELECT
      ${graphId}, ${runId}, n.id, n.kind, n.id, n.kind, n.id, n.kind, 0
    FROM ${operation.schema.nodesTable} n
    WHERE n.graph_id = ${graphId}
      AND ${nodeKindFilter}
      AND ${operation.nodeTemporalFilter}
  `);
  await context.executeTemporary(sql`
    CREATE INDEX ${frontierIndexIdentifier(context)}
    ON ${workingTable} (graph_id, run_id, improved_round)
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
  iteration: number,
): Promise<IterationState> {
  for (const edgeKinds of context.operation.edgeKindChunks) {
    await propagateChunkLabels(context, edgeKinds, iteration);
  }
  const changedRows = await applyNextLabels(context, iteration);
  return {
    changedCount: changedRows.length,
    workingTableSize: state.workingTableSize,
  };
}

/**
 * Propagates the minimum neighbor label along one edge-kind chunk. The
 * expansion deliberately skips the target-node visibility join. The working
 * table was seeded through the same graph/kind/temporal filters inside the
 * same snapshot, WCC never inserts rows after seeding, source labels are
 * projected from the frontier, and each target is joined against the working
 * table below. Membership is therefore the visibility-and-scope proof, so a
 * per-edge `typegraph_nodes` lookup would only re-check what the frontier and
 * `scoped_target` already guarantee.
 */
async function propagateChunkLabels(
  context: IterativeGraphRunContext,
  edgeKinds: readonly string[],
  iteration: number,
): Promise<void> {
  const { operation, workingTable, graphId, runId } = context;
  const expansion = compileWorkingTableEdgeExpansion(
    operation,
    workingTable,
    sql`
      w.graph_id = ${graphId}
      AND w.run_id = ${runId}
      AND w.improved_round = ${iteration - 1}
    `,
    "both",
    edgeKinds,
    sql`w.label_id AS source_label_id, w.label_kind AS source_label_kind`,
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
        expanded.source_label_id AS label_id,
        expanded.source_label_kind AS label_kind
      FROM (${expansion}) expanded
      JOIN ${workingTable} scoped_target
        ON scoped_target.graph_id = ${graphId}
        AND scoped_target.run_id = ${runId}
        AND scoped_target.node_id = expanded.target_id
        AND scoped_target.node_kind = expanded.target_kind
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
  iteration: number,
): Promise<readonly ChangedRow[]> {
  return context.backend.execute<ChangedRow>(
    asCompiledRowsSql(sql`
      UPDATE ${context.workingTable}
      SET label_id = next_label_id,
          label_kind = next_label_kind,
          improved_round = ${iteration}
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

  return rows.map((row) => ({
    id: row.node_id,
    kind: row.node_kind,
    componentId: row.component_id,
    componentKind: row.component_kind,
    size: Number(row.component_size),
  }));
}
