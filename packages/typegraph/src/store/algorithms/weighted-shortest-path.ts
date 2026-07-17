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
import { compareCodePoints } from "../../utils/compare";
import type { AlgorithmContext, InternalTraversalOptions } from "./context";
import { assertEdgeKinds, resolveMaxIterations } from "./context";
import {
  compileWorkingTableExpansion,
  fetchVisibleWorkingNodes,
  type IterativeGraphOperation,
  type IterativeGraphRunContext,
  type NodeExpansion,
  type NodeIdentityKey,
  nodeIdentityKey,
  nodeIdentityKeyFromRow,
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
  /**
   * Cheapest known distance to any node with the target id, tracked in JS
   * from each round's RETURNING rows so the next round can prune with a
   * plain bound parameter instead of per-candidate subqueries.
   */
  bestTargetDistance: number | undefined;
}>;

type SeededRow = Readonly<{ node_id: string }>;
type ImprovedRow = Readonly<{ node_id: string; distance: number | string }>;

type FrontierRound = Readonly<{
  frontierCount: number;
  bestTargetDistance: number | undefined;
}>;

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
  // Structurally assignable — the internal options are the traversal options
  // plus the algorithm-only `maxIterations`, which the substrate ignores.
  const traversalOptions: WeightedTraversalOptions = options;

  // Non-negative weights make distance 0 unbeatable, so a self path needs
  // no relaxation rounds — only the weight audit (for deterministic data
  // errors) and a visibility check on the node itself.
  if (sourceId === targetId) {
    return findWeightedSelfPath(ctx, sourceId, traversalOptions);
  }

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
  // The inner projection extracts the JSON path once per edge; the outer
  // violation predicate then works over plain projected columns. Composing
  // the checks directly over `e.props` would re-parse the JSON payload for
  // every predicate branch on the audit's full edge scan.
  //
  // Both type predicates are the never-NULL, type-based dialect members —
  // jsonPathIsNull's PostgreSQL text-comparison form would misclassify a
  // JSON string "null" as null and go three-valued on a JSON null.
  const isNumber = dialect.jsonPathIsNumber(propsColumn, pointer);
  const isMissing = dialect.jsonPathIsMissingOrNull(propsColumn, pointer);
  const weightText = dialect.jsonExtractText(propsColumn, pointer);
  // CASE keeps the numeric extraction unreachable for non-numeric values:
  // PostgreSQL does not short-circuit OR/AND, and casting arbitrary text
  // would error before the audit could produce its typed report. The
  // extraction is jsonExtractNumber (PostgreSQL `numeric`), NOT the double
  // extraction the traversal uses: a JSON number beyond the float8 range
  // must reach the range check below instead of overflowing the cast.
  const weightNumber = sql`CASE WHEN ${isNumber} THEN ${dialect.jsonExtractNumber(propsColumn, pointer)} END`;
  const missingViolation =
    defaultWeight === undefined ?
      sql`audited.is_missing = 1`
    : dialect.booleanLiteral(false);
  const negativeViolation = sql`audited.is_number = 1 AND audited.weight_number < 0`;
  // CAST the bound to NUMERIC so PostgreSQL compares in the arbitrary-
  // precision domain — a numeric-vs-float8 comparison would coerce the
  // out-of-range value to float8 and overflow before comparing.
  const outOfRangeViolation = sql`audited.is_number = 1 AND ABS(audited.weight_number) > CAST(${Number.MAX_VALUE} AS NUMERIC)`;

  for (const edgeKinds of operation.edgeKindChunks) {
    const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), edgeKinds);
    const rows = await operation.backend.execute<WeightAuditRow>(
      asCompiledRowsSql(sql`
        SELECT audited.edge_id, audited.edge_kind, audited.weight_text,
          audited.is_number, audited.is_missing
        FROM (
          SELECT e.id AS edge_id, e.kind AS edge_kind,
            ${weightText} AS weight_text,
            ${weightNumber} AS weight_number,
            CASE WHEN ${isNumber} THEN 1 ELSE 0 END AS is_number,
            CASE WHEN ${isMissing} THEN 1 ELSE 0 END AS is_missing
          FROM ${operation.schema.edgesTable} e
          WHERE e.graph_id = ${operation.ctx.graphId}
            AND ${edgeKindFilter}
            AND ${operation.edgeTemporalFilter}
        ) audited
        WHERE (${missingViolation})
          OR (audited.is_missing = 0 AND audited.is_number = 0)
          OR (${negativeViolation})
          OR (${outOfRangeViolation})
        ORDER BY ${dialect.binaryText(sql`audited.edge_id`)}
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
  const reason = resolveInvalidWeightReason(row);
  const value =
    reason === "missing" || row.weight_text === null ?
      undefined
    : formatWeightValue(row.weight_text);
  return new InvalidEdgeWeightError({
    edgeId: row.edge_id,
    edgeKind: row.edge_kind,
    property: weightProperty,
    reason,
    ...(value === undefined ? {} : { value }),
  });
}

function resolveInvalidWeightReason(
  row: WeightAuditRow,
): InvalidEdgeWeightReason {
  if (flagIsSet(row.is_missing)) return "missing";
  if (!flagIsSet(row.is_number)) return "non_numeric";
  // A numeric violation is either negative or beyond the double range;
  // Number() maps an out-of-range magnitude to ±Infinity, which is exactly
  // the distinction needed here.
  return Number(row.weight_text) < 0 ? "negative" : "not_finite";
}

/** Coerces a driver-shaped 0/1 flag (number, bigint, or boolean) to boolean. */
function flagIsSet(value: unknown): boolean {
  return Number(value) !== 0;
}

/** Renders an extracted weight value for the error message. */
function formatWeightValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Node-identity comparison in code-point order — the order SQLite BINARY
 * and PostgreSQL `COLLATE "C"` sort in. Every JS-side tie-break in this
 * algorithm must reproduce the working-table round's `binaryText` ORDER BY,
 * and the substrate's UTF-16 `compareNodeIdentity` disagrees with it for
 * astral characters.
 */
function compareNodeIdentityCodePoints(
  left: PathNode,
  right: PathNode,
): number {
  return (
    compareCodePoints(left.id, right.id) ||
    compareCodePoints(left.kind, right.kind)
  );
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
  return runIterativeGraphOperation<
    WeightedState,
    WeightedShortestPathResult | undefined
  >(ctx, options, {
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
        // Seeds carry the source id, never the target's — the self-path
        // case is short-circuited before this plan runs.
        bestTargetDistance: undefined,
      };
    },
    async runRound(context, state, iteration) {
      const round = await relaxFrontierRound(
        context,
        targetId,
        iteration,
        state.bestTargetDistance,
      );
      return {
        frontierCount: round.frontierCount,
        // Overcounts by re-improved existing rows (RETURNING includes
        // updates); acceptable because the size only paces the substrate's
        // ANALYZE refresh, where too-early merely refreshes stats sooner.
        workingTableSize: state.workingTableSize + round.frontierCount,
        bestTargetDistance: round.bestTargetDistance,
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
 * predecessor), and upserts only strict distance improvements.
 *
 * Candidates costing at least `roundBound` — the cheapest path to the
 * target known at round start, tracked in JS from RETURNING rows — are
 * pruned. Sound because the audit guarantees non-negative weights: no
 * extension of such a candidate can beat the known path. A bound parameter
 * keeps the pruning O(1) per candidate and applies the same round-start
 * state on both execution paths, so they run identical round sequences.
 */
async function relaxFrontierRound(
  context: IterativeGraphRunContext,
  targetId: string,
  iteration: number,
  roundBound: number | undefined,
): Promise<FrontierRound> {
  const { operation, workingTable, graphId, runId } = context;
  const { dialect } = operation.ctx;
  let frontierCount = 0;
  let bestTargetDistance = roundBound;
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
          WHERE ${
            // Equal-distance candidates for the target id itself stay
            // admitted: when the id exists under several kinds, the
            // documented smallest-identity tie-break must see an equal-cost
            // target found in a later round, not have it pruned away.
            roundBound === undefined ?
              sql`TRUE`
            : sql`(candidates.candidate_distance < ${roundBound} OR (candidates.target_id = ${targetId} AND candidates.candidate_distance <= ${roundBound}))`
          }
        ) ranked
        WHERE ranked.candidate_rank = 1
        ON CONFLICT (graph_id, run_id, node_kind, node_id) DO UPDATE SET
          distance = excluded.distance,
          hops = excluded.hops,
          predecessor_id = excluded.predecessor_id,
          predecessor_kind = excluded.predecessor_kind,
          improved_round = excluded.improved_round
        WHERE excluded.distance < ${workingTable}.distance
        RETURNING node_id, distance
      `),
    );
    frontierCount += rows.length;
    for (const row of rows) {
      if (row.node_id !== targetId) continue;
      const distance = Number(row.distance);
      if (bestTargetDistance === undefined || distance < bestTargetDistance) {
        bestTargetDistance = distance;
      }
    }
  }
  return { frontierCount, bestTargetDistance };
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
      const node = {
        id: row.node_id,
        kind: row.node_kind,
        distance: Number(row.distance),
        hops: Number(row.hops),
        parentKey: nodeIdentityKeyFromRow(
          row.predecessor_id,
          row.predecessor_kind,
        ),
      } satisfies WeightedVisitedNode;
      return [nodeIdentityKey(node), node];
    }),
  );
}

/**
 * Zero-weight self path: audits the weight domain (so data errors surface
 * identically to a full traversal) and checks the node's visibility, with
 * no relaxation rounds. Multiple kinds sharing the id resolve to the
 * smallest node identity, matching the traversal tie-break.
 */
async function findWeightedSelfPath(
  ctx: AlgorithmContext,
  nodeId: string,
  options: WeightedTraversalOptions,
): Promise<WeightedShortestPathResult | undefined> {
  return withInlineIterativeGraphOperation(ctx, options, async (operation) => {
    await assertValidEdgeWeights(
      operation,
      options.weightProperty,
      options.defaultWeight,
    );
    const nodes = await fetchVisibleWorkingNodes(operation, [nodeId]);
    const node = nodes.toSorted((left, right) =>
      compareNodeIdentityCodePoints(left, right),
    )[0];
    if (node === undefined) return;
    return { nodes: [node], depth: 0, totalWeight: 0 };
  });
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
    if (sources.length === 0) return;

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
    let bestTargetDistance: number | undefined;
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
        // Mirrors the working-table prune: equal-distance candidates are
        // dropped unless they carry the target id, so a smaller-identity
        // target kind found later still reaches the result tie-break.
        if (
          roundBound !== undefined &&
          (candidate.distance > roundBound ||
            (candidate.distance === roundBound && candidate.id !== targetId))
        ) {
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
        compareNodeIdentityCodePoints(left, right),
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
  // Unreachable on a weighted run — the substrate rejects NULL weights with
  // an invariant error — but the field is optional, so narrow it.
  const weight = expansion.weight;
  if (weight === undefined) return existing;
  const sourceEntry = settled.get(nodeIdentityKey(expansion.source));
  if (sourceEntry === undefined) return existing;
  const candidateDistance = sourceEntry.distance + weight;
  if (
    existing !== undefined &&
    (existing.distance < candidateDistance ||
      (existing.distance === candidateDistance &&
        compareNodeIdentityCodePoints(
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
        compareNodeIdentityCodePoints(node, target) < 0)
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
      cursor.parentKey === undefined ?
        undefined
      : visited.get(cursor.parentKey);
  }

  return {
    nodes: reversedNodes.toReversed(),
    depth: target.hops,
    totalWeight: target.distance,
  };
}
