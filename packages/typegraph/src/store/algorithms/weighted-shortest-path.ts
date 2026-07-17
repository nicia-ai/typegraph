import { type SQL, sql } from "drizzle-orm";

import type { GraphDef } from "../../core/define-graph";
import {
  ConfigurationError,
  GraphAlgorithmConvergenceError,
  InvalidEdgeWeightError,
  type InvalidEdgeWeightReason,
} from "../../errors";
import { compileKindFilter } from "../../query/compiler/predicate-utils";
import { jsonPointer } from "../../query/json-pointer";
import { asCompiledRowsSql } from "../../query/sql-intent";
import type { AlgorithmContext, InternalTraversalOptions } from "./context";
import { assertEdgeKinds, resolveMaxIterations } from "./context";
import {
  compareNodeIdentity,
  compileWorkingTableExpansion,
  fetchVisibleWorkingNodes,
  type IterativeGraphOperation,
  type IterativeGraphRunContext,
  type NodeExpansion,
  type NodeIdentityKey,
  nodeIdentityKey,
  reduceExpandedWorkingSet,
  runIterativeGraphOperation,
  supportsTemporaryIteration,
  withInlineIterativeGraphOperation,
} from "./iterative-graph-operation";
import type {
  InternalWeightedShortestPathOptions,
  PathNode,
  WeightedShortestPathResult,
} from "./types";

const DEFAULT_WEIGHTED_SHORTEST_PATH_MAX_ITERATIONS = 1000;

const WEIGHTED_ALGORITHM_NAME = "weightedShortestPath";

/** Traversal options with the weight source guaranteed present. */
type WeightedTraversalOptions = InternalTraversalOptions &
  Readonly<{ weightProperty: string }>;

type WeightedState = Readonly<{
  frontierCount: number;
  workingTableSize: number;
}>;

type SeededRow = Readonly<{ node_id: string }>;
type ImprovedRow = Readonly<{ node_id: string }>;

type DistanceRow = Readonly<{
  node_id: string;
  node_kind: string;
  distance: number | string;
  hops: number | string;
  predecessor_id: unknown;
  predecessor_kind: unknown;
}>;

type WeightAuditRow = Readonly<{
  edge_id: string;
  edge_kind: string;
  weight_text: unknown;
  is_number: unknown;
  is_missing: unknown;
}>;

/**
 * A node settled by weighted relaxation: its best known distance from the
 * source, the hop count of the path achieving it, and the predecessor along
 * that path.
 */
type WeightedVisitedNode = Readonly<{
  id: string;
  kind: string;
  distance: number;
  hops: number;
  parentKey: NodeIdentityKey | undefined;
}>;

type WeightedCandidate = Readonly<{
  id: string;
  kind: string;
  distance: number;
  hops: number;
  parentId: string;
  parentKind: string;
}>;

/**
 * Finds the minimum-total-weight path from `sourceId` to `targetId` by
 * frontier-based label-correcting relaxation: each round relaxes the edges
 * out of the nodes improved in the previous round, keeping one best
 * `(distance, predecessor)` per node identity, until no distance improves.
 * Weights must be non-negative, which makes pruning against the best known
 * target distance safe: once a candidate costs at least as much as a path
 * already reaching the target, no extension of it can win.
 */
export async function executeWeightedShortestPath<G extends GraphDef>(
  ctx: AlgorithmContext,
  sourceId: string,
  targetId: string,
  options: InternalWeightedShortestPathOptions<G>,
): Promise<WeightedShortestPathResult | undefined> {
  assertEdgeKinds(options.edges);
  assertWeightOptions(options.weightProperty, options.defaultWeight);
  const maxIterations = resolveMaxIterations(
    options.maxIterations,
    DEFAULT_WEIGHTED_SHORTEST_PATH_MAX_ITERATIONS,
    WEIGHTED_ALGORITHM_NAME,
  );
  const traversalOptions: WeightedTraversalOptions = {
    edges: options.edges,
    weightProperty: options.weightProperty,
    ...(options.defaultWeight === undefined ?
      {}
    : { defaultWeight: options.defaultWeight }),
    ...(options.direction === undefined ?
      {}
    : { direction: options.direction }),
    ...(options.temporalMode === undefined ?
      {}
    : { temporalMode: options.temporalMode }),
    ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
    ...(options.recordedAsOf === undefined ?
      {}
    : { recordedAsOf: options.recordedAsOf }),
    ...(options.workingMemory === undefined ?
      {}
    : { workingMemory: options.workingMemory }),
  };

  if (supportsTemporaryIteration(ctx)) {
    return findWeightedShortestPathInWorkingTable(
      ctx,
      sourceId,
      targetId,
      maxIterations,
      traversalOptions,
    );
  }
  return findWeightedShortestPathInline(
    ctx,
    sourceId,
    targetId,
    maxIterations,
    traversalOptions,
  );
}

function assertWeightOptions(
  weightProperty: string,
  defaultWeight: number | undefined,
): void {
  if (typeof weightProperty !== "string" || weightProperty.length === 0) {
    throw new ConfigurationError(
      `${WEIGHTED_ALGORITHM_NAME} weightProperty must be a non-empty string.`,
      { weightProperty },
    );
  }
  if (
    defaultWeight !== undefined &&
    (!Number.isFinite(defaultWeight) || defaultWeight < 0)
  ) {
    throw new ConfigurationError(
      `${WEIGHTED_ALGORITHM_NAME} defaultWeight must be a finite non-negative number, got ${String(defaultWeight)}.`,
      { defaultWeight },
    );
  }
}

/**
 * Fails fast on the first visible edge of the selected kinds whose weight
 * violates the weighted-traversal contract: a non-numeric value, a negative
 * number, or a missing value with no configured default. Runs inside the
 * operation's snapshot before any relaxation round, so a weighted call
 * either observes a fully valid weight domain or throws — the traversal's
 * own weight cast never sees a value it could silently mangle.
 *
 * The audit deliberately covers every visible edge of the selected kinds,
 * not just edges the traversal happens to reach: reachability-dependent
 * validation would make the error nondeterministic in the data.
 */
async function assertValidEdgeWeights(
  operation: IterativeGraphOperation,
  weightProperty: string,
  defaultWeight: number | undefined,
): Promise<void> {
  const { dialect } = operation.ctx;
  const pointer = jsonPointer([weightProperty]);
  const propsColumn = sql.raw("e.props");
  const isNumber = dialect.jsonPathIsNumber(propsColumn, pointer);
  const isMissing = dialect.jsonPathIsNull(propsColumn, pointer);
  const weightText = dialect.jsonExtractText(propsColumn, pointer);
  // CASE keeps the cast unreachable for non-numeric values: PostgreSQL does
  // not short-circuit AND, and casting arbitrary text would error before the
  // audit could produce its typed report.
  const isNegative = sql`CASE WHEN ${isNumber} THEN CAST(${weightText} AS DOUBLE PRECISION) < 0 ELSE ${dialect.booleanLiteral(false)} END`;
  const missingViolation =
    defaultWeight === undefined ? isMissing : dialect.booleanLiteral(false);
  const invalid = sql`(${missingViolation}) OR ((NOT ${isMissing}) AND (NOT ${isNumber})) OR (${isNegative})`;

  for (const edgeKinds of operation.edgeKindChunks) {
    const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), edgeKinds);
    const rows = await operation.backend.execute<WeightAuditRow>(
      asCompiledRowsSql(sql`
        SELECT e.id AS edge_id, e.kind AS edge_kind,
          ${weightText} AS weight_text,
          CASE WHEN ${isNumber} THEN 1 ELSE 0 END AS is_number,
          CASE WHEN ${isMissing} THEN 1 ELSE 0 END AS is_missing
        FROM ${operation.schema.edgesTable} e
        WHERE e.graph_id = ${operation.ctx.graphId}
          AND ${edgeKindFilter}
          AND ${operation.edgeTemporalFilter}
          AND (${invalid})
        ORDER BY ${dialect.binaryText(sql`e.id`)}
        LIMIT 1
      `),
    );
    const row = rows[0];
    if (row !== undefined) {
      throw createInvalidEdgeWeightError(row, weightProperty);
    }
  }
}

function createInvalidEdgeWeightError(
  row: WeightAuditRow,
  weightProperty: string,
): InvalidEdgeWeightError {
  const reason: InvalidEdgeWeightReason =
    flagIsSet(row.is_missing) ? "missing"
    : flagIsSet(row.is_number) ? "negative"
    : "non_numeric";
  const value =
    reason === "missing" || row.weight_text === null ?
      undefined
    : String(row.weight_text);
  return new InvalidEdgeWeightError({
    edgeId: row.edge_id,
    edgeKind: row.edge_kind,
    property: weightProperty,
    reason,
    ...(value === undefined ? {} : { value }),
  });
}

/** Coerces a driver-shaped 0/1 flag (number, bigint, or boolean) to boolean. */
function flagIsSet(value: unknown): boolean {
  return Number(value) !== 0;
}

// ============================================================
// Working-table execution
// ============================================================

async function findWeightedShortestPathInWorkingTable(
  ctx: AlgorithmContext,
  sourceId: string,
  targetId: string,
  maxIterations: number,
  options: WeightedTraversalOptions,
): Promise<WeightedShortestPathResult | undefined> {
  return runIterativeGraphOperation(ctx, options, {
    algorithm: WEIGHTED_ALGORITHM_NAME,
    maxIterations,
    createWorkingTable,
    async initialize(context) {
      await assertValidEdgeWeights(
        context.operation,
        options.weightProperty,
        options.defaultWeight,
      );
      const seeded = await seedDistances(context, sourceId);
      return {
        frontierCount: seeded.length,
        workingTableSize: seeded.length,
      };
    },
    async runRound(context, state, iteration) {
      const frontierCount = await relaxFrontierRound(
        context,
        targetId,
        iteration,
      );
      return {
        frontierCount,
        workingTableSize: state.workingTableSize + frontierCount,
      };
    },
    hasConverged(state: WeightedState) {
      return state.frontierCount === 0;
    },
    async extractResult(context) {
      const visited = await readVisitedFromWorkingTable(context);
      return buildWeightedPathResult(visited, targetId);
    },
  });
}

function createWorkingTable(context: IterativeGraphRunContext): SQL {
  // DOUBLE PRECISION is accepted by both engines: PostgreSQL's float8, and
  // REAL affinity on SQLite — the same IEEE 754 double either way.
  return sql`
    CREATE TEMP TABLE ${context.workingTable} (
      graph_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_kind TEXT NOT NULL,
      distance DOUBLE PRECISION NOT NULL,
      hops INTEGER NOT NULL,
      predecessor_id TEXT,
      predecessor_kind TEXT,
      improved_round INTEGER NOT NULL,
      PRIMARY KEY (graph_id, run_id, node_kind, node_id)
    )
  `;
}

async function seedDistances(
  context: IterativeGraphRunContext,
  sourceId: string,
): Promise<readonly SeededRow[]> {
  const { operation, workingTable, graphId, runId } = context;
  return context.backend.execute<SeededRow>(
    asCompiledRowsSql(sql`
      INSERT INTO ${workingTable}
        (graph_id, run_id, node_id, node_kind, distance, hops,
         predecessor_id, predecessor_kind, improved_round)
      SELECT ${graphId}, ${runId}, n.id, n.kind, 0, 0, NULL, NULL, 0
      FROM ${operation.schema.nodesTable} n
      WHERE n.graph_id = ${graphId}
        AND n.id = ${sourceId}
        AND ${operation.nodeTemporalFilter}
      ON CONFLICT (graph_id, run_id, node_kind, node_id) DO NOTHING
      RETURNING node_id
    `),
  );
}

/**
 * Relaxes one round: expands the previous round's frontier through visible
 * edges, keeps the cheapest candidate per target identity (ties broken by
 * source id then kind in binary collation, so both backends pick the same
 * predecessor), and upserts only strict distance improvements. Candidates
 * that already cost at least as much as a known path to the target are
 * pruned — sound because the audit guarantees non-negative weights.
 */
async function relaxFrontierRound(
  context: IterativeGraphRunContext,
  targetId: string,
  iteration: number,
): Promise<number> {
  const { operation, workingTable, graphId, runId } = context;
  const { dialect } = operation.ctx;
  let frontierCount = 0;
  for (const edgeKinds of operation.edgeKindChunks) {
    const sourceFilter = sql`
      w.graph_id = ${graphId}
      AND w.run_id = ${runId}
      AND w.improved_round = ${iteration - 1}
    `;
    const expansion = compileWorkingTableExpansion(
      operation,
      workingTable,
      sourceFilter,
      operation.direction,
      edgeKinds,
    );
    const rows = await context.backend.execute<ImprovedRow>(
      asCompiledRowsSql(sql`
        INSERT INTO ${workingTable}
          (graph_id, run_id, node_id, node_kind, distance, hops,
           predecessor_id, predecessor_kind, improved_round)
        SELECT
          ${graphId}, ${runId}, ranked.target_id, ranked.target_kind,
          ranked.candidate_distance, ranked.candidate_hops,
          ranked.source_id, ranked.source_kind, ${iteration}
        FROM (
          SELECT candidates.*,
            ROW_NUMBER() OVER (
              PARTITION BY ${dialect.binaryText(sql`candidates.target_kind`)},
                ${dialect.binaryText(sql`candidates.target_id`)}
              ORDER BY candidates.candidate_distance,
                ${dialect.binaryText(sql`candidates.source_id`)},
                ${dialect.binaryText(sql`candidates.source_kind`)}
            ) AS candidate_rank
          FROM (
            SELECT expanded.source_id, expanded.source_kind,
              expanded.target_id, expanded.target_kind,
              frontier.distance + expanded.weight AS candidate_distance,
              frontier.hops + 1 AS candidate_hops
            FROM (${expansion}) expanded
            JOIN ${workingTable} frontier
              ON frontier.graph_id = ${graphId}
              AND frontier.run_id = ${runId}
              AND frontier.node_id = expanded.source_id
              AND frontier.node_kind = expanded.source_kind
          ) candidates
          WHERE NOT EXISTS (
            SELECT 1
            FROM ${workingTable} settled_target
            WHERE settled_target.graph_id = ${graphId}
              AND settled_target.run_id = ${runId}
              AND settled_target.node_id = ${targetId}
              AND settled_target.distance <= candidates.candidate_distance
          )
        ) ranked
        WHERE ranked.candidate_rank = 1
        ON CONFLICT (graph_id, run_id, node_kind, node_id) DO UPDATE SET
          distance = excluded.distance,
          hops = excluded.hops,
          predecessor_id = excluded.predecessor_id,
          predecessor_kind = excluded.predecessor_kind,
          improved_round = excluded.improved_round
        WHERE excluded.distance < ${workingTable}.distance
        RETURNING node_id
      `),
    );
    frontierCount += rows.length;
  }
  return frontierCount;
}

async function readVisitedFromWorkingTable(
  context: IterativeGraphRunContext,
): Promise<ReadonlyMap<NodeIdentityKey, WeightedVisitedNode>> {
  const rows = await context.backend.execute<DistanceRow>(
    asCompiledRowsSql(sql`
      SELECT node_id, node_kind, distance, hops,
        predecessor_id, predecessor_kind
      FROM ${context.workingTable}
      WHERE graph_id = ${context.graphId}
        AND run_id = ${context.runId}
    `),
  );
  return new Map(
    rows.map((row) => {
      const parentKey =
        (
          typeof row.predecessor_id !== "string" ||
          typeof row.predecessor_kind !== "string"
        ) ?
          undefined
        : nodeIdentityKey({
            id: row.predecessor_id,
            kind: row.predecessor_kind,
          });
      const node = {
        id: row.node_id,
        kind: row.node_kind,
        distance: Number(row.distance),
        hops: Number(row.hops),
        parentKey,
      } satisfies WeightedVisitedNode;
      return [nodeIdentityKey(node), node];
    }),
  );
}

// ============================================================
// Inline execution (backends without temporary-table support)
// ============================================================

async function findWeightedShortestPathInline(
  ctx: AlgorithmContext,
  sourceId: string,
  targetId: string,
  maxIterations: number,
  options: WeightedTraversalOptions,
): Promise<WeightedShortestPathResult | undefined> {
  return withInlineIterativeGraphOperation(ctx, options, async (operation) => {
    await assertValidEdgeWeights(
      operation,
      options.weightProperty,
      options.defaultWeight,
    );
    const sources = await fetchVisibleWorkingNodes(operation, [sourceId]);
    if (sources.length === 0) return undefined;

    const settled = new Map<NodeIdentityKey, WeightedVisitedNode>(
      sources.map((source) => [
        nodeIdentityKey(source),
        {
          id: source.id,
          kind: source.kind,
          distance: 0,
          hops: 0,
          parentKey: undefined,
        },
      ]),
    );
    let bestTargetDistance = sourceId === targetId ? 0 : undefined;
    let frontier: readonly PathNode[] = sources;
    let rounds = 0;

    while (frontier.length > 0) {
      if (rounds >= maxIterations) {
        throw new GraphAlgorithmConvergenceError(
          WEIGHTED_ALGORITHM_NAME,
          maxIterations,
        );
      }
      rounds++;

      const candidates = await reduceExpandedWorkingSet<WeightedCandidate>(
        operation,
        frontier,
        operation.direction,
        (existing, expansion) =>
          reduceWeightedCandidate(existing, expansion, settled),
      );

      // Prune against the best target distance as of the round start, the
      // same state the working-table round's pre-statement snapshot sees, so
      // both execution paths run identical round sequences.
      const roundBound = bestTargetDistance;
      const improved: PathNode[] = [];
      for (const [candidateKey, candidate] of candidates) {
        const existing = settled.get(candidateKey);
        if (existing !== undefined && existing.distance <= candidate.distance) {
          continue;
        }
        if (roundBound !== undefined && candidate.distance >= roundBound) {
          continue;
        }
        settled.set(candidateKey, {
          id: candidate.id,
          kind: candidate.kind,
          distance: candidate.distance,
          hops: candidate.hops,
          parentKey: nodeIdentityKey({
            id: candidate.parentId,
            kind: candidate.parentKind,
          }),
        });
        improved.push({ id: candidate.id, kind: candidate.kind });
        if (
          candidate.id === targetId &&
          (bestTargetDistance === undefined ||
            candidate.distance < bestTargetDistance)
        ) {
          bestTargetDistance = candidate.distance;
        }
      }
      frontier = improved.toSorted((left, right) =>
        compareNodeIdentity(left, right),
      );
    }

    return buildWeightedPathResult(settled, targetId);
  });
}

/**
 * Keeps the cheapest candidate per target identity; ties break by source id
 * then kind, mirroring the working-table round's ROW_NUMBER ordering.
 */
function reduceWeightedCandidate(
  existing: WeightedCandidate | undefined,
  expansion: NodeExpansion,
  settled: ReadonlyMap<NodeIdentityKey, WeightedVisitedNode>,
): WeightedCandidate | undefined {
  // Weighted operations always compile a weight column; the guard narrows
  // the optional field.
  const weight = expansion.weight;
  if (weight === undefined) return existing;
  const sourceEntry = settled.get(nodeIdentityKey(expansion.source));
  if (sourceEntry === undefined) return existing;
  const candidateDistance = sourceEntry.distance + weight;
  if (
    existing !== undefined &&
    (existing.distance < candidateDistance ||
      (existing.distance === candidateDistance &&
        compareNodeIdentity(
          { id: existing.parentId, kind: existing.parentKind },
          expansion.source,
        ) <= 0))
  ) {
    return existing;
  }
  return {
    id: expansion.target.id,
    kind: expansion.target.kind,
    distance: candidateDistance,
    hops: sourceEntry.hops + 1,
    parentId: expansion.source.id,
    parentKind: expansion.source.kind,
  };
}

// ============================================================
// Shared result construction
// ============================================================

/**
 * Selects the cheapest settled node matching the target id (ties by node id
 * then kind) and reconstructs the path by walking predecessors back to the
 * source. Returns `undefined` when the target was never settled.
 */
function buildWeightedPathResult(
  visited: ReadonlyMap<NodeIdentityKey, WeightedVisitedNode>,
  targetId: string,
): WeightedShortestPathResult | undefined {
  let target: WeightedVisitedNode | undefined;
  for (const node of visited.values()) {
    if (node.id !== targetId) continue;
    if (
      target === undefined ||
      node.distance < target.distance ||
      (node.distance === target.distance &&
        compareNodeIdentity(node, target) < 0)
    ) {
      target = node;
    }
  }
  if (target === undefined) return undefined;

  const reversedNodes: PathNode[] = [];
  let cursor: WeightedVisitedNode | undefined = target;
  while (cursor !== undefined) {
    reversedNodes.push({ id: cursor.id, kind: cursor.kind });
    cursor =
      cursor.parentKey === undefined ? undefined : visited.get(cursor.parentKey);
  }

  return {
    nodes: reversedNodes.toReversed(),
    depth: target.hops,
    totalWeight: target.distance,
  };
}
