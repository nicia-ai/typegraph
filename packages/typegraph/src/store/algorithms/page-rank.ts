import { type SQL, sql } from "drizzle-orm";

import type { GraphDef } from "../../core/define-graph";
import { ConfigurationError } from "../../errors";
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
  compareNodeIdentity,
  compileWorkingTableEdgeExpansion,
  type IterativeGraphRunContext,
  type NodeIdentityKey,
  nodeIdentityKey,
  runIterativeGraphOperation,
} from "./iterative-graph-operation";
import type {
  InternalPageRankOptions,
  InternalPersonalizedPageRankOptions,
  PageRankScore,
  PersonalizedPageRankSeed,
  TraversalDirection,
} from "./types";

type IterationState = Readonly<{
  activeScoreColumn: ScoreColumn;
  maximumChange: number;
  workingTableSize: number;
}>;

type ScoreColumn = "next_score" | "score";

type ResolvedPageRankOptions = Readonly<{
  dampingFactor: number;
  tolerance: number;
  maxIterations: number;
  nodeKinds: readonly string[] | undefined;
}>;

type PageRankAlgorithm = "pageRank" | "personalizedPageRank";

type NormalizedSeed = Readonly<{
  id: string;
  kind: string;
  weight: number;
}>;

type CountRow = Readonly<{ count: number | string }>;
type MetricRow = Readonly<{ value: number | string | null }>;
type IdentityRow = Readonly<{ node_id: string; node_kind: string }>;
type ScoreRow = Readonly<{
  node_id: string;
  node_kind: string;
  score: number | string;
}>;

const DEFAULT_DAMPING_FACTOR = 0.85;
const DEFAULT_TOLERANCE = 1e-8;
const DEFAULT_MAX_ITERATIONS = 1000;
const DEFAULT_MAX_BIND_PARAMETERS = 999;

/** Computes global PageRank with a uniform teleport distribution. */
export async function executePageRank<G extends GraphDef>(
  ctx: AlgorithmContext,
  options: InternalPageRankOptions<G>,
): Promise<readonly PageRankScore[]> {
  return executePageRankOperation(ctx, options, undefined);
}

/** Computes personalized PageRank with a weighted multi-seed teleport vector. */
export async function executePersonalizedPageRank<G extends GraphDef>(
  ctx: AlgorithmContext,
  options: InternalPersonalizedPageRankOptions<G>,
): Promise<readonly PageRankScore[]> {
  return executePageRankOperation(ctx, options, normalizeSeeds(options.seeds));
}

function executePageRankOperation<G extends GraphDef>(
  ctx: AlgorithmContext,
  options: InternalPageRankOptions<G>,
  seeds: readonly NormalizedSeed[] | undefined,
): Promise<readonly PageRankScore[]> {
  const algorithm: PageRankAlgorithm =
    seeds === undefined ? "pageRank" : "personalizedPageRank";
  assertEdgeKinds(options.edges);
  assertGraphAnalyticsSupported(ctx, algorithm);
  const resolved = resolvePageRankOptions(options, algorithm);
  const traversalOptions: InternalTraversalOptions = {
    edges: options.edges,
    direction: options.direction ?? "out",
    ...pickTemporalOptions(options),
    ...(options.workingMemory === undefined ?
      {}
    : { workingMemory: options.workingMemory }),
  };

  return runIterativeGraphOperation(ctx, traversalOptions, {
    algorithm,
    maxIterations: resolved.maxIterations,
    createWorkingTable,
    initialize: (context) =>
      initializeWorkingTable(context, resolved.nodeKinds, seeds),
    runRound: (context, state) =>
      runPowerIterationRound(context, state, resolved.dampingFactor),
    hasConverged(state) {
      return state.maximumChange <= resolved.tolerance;
    },
    extractResult: extractScores,
  });
}

function resolvePageRankOptions<G extends GraphDef>(
  options: InternalPageRankOptions<G>,
  algorithm: PageRankAlgorithm,
): ResolvedPageRankOptions {
  const dampingFactor = options.dampingFactor ?? DEFAULT_DAMPING_FACTOR;
  if (
    !Number.isFinite(dampingFactor) ||
    dampingFactor < 0 ||
    dampingFactor >= 1
  ) {
    throw new ConfigurationError(
      `PageRank dampingFactor must be finite and in [0, 1), got ${String(dampingFactor)}.`,
      { dampingFactor },
    );
  }

  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new ConfigurationError(
      `PageRank tolerance must be finite and greater than 0, got ${String(tolerance)}.`,
      { tolerance },
    );
  }

  return {
    dampingFactor,
    tolerance,
    maxIterations: resolveMaxIterations(
      options.maxIterations,
      DEFAULT_MAX_ITERATIONS,
      algorithm,
    ),
    nodeKinds:
      options.nodeKinds === undefined ?
        undefined
      : [...new Set(options.nodeKinds)].toSorted((left, right) =>
          compareCodePoints(left, right),
        ),
  };
}

function normalizeSeeds<G extends GraphDef>(
  seeds: readonly PersonalizedPageRankSeed<G>[],
): readonly NormalizedSeed[] {
  if (seeds.length === 0) {
    throw new ConfigurationError(
      "Personalized PageRank requires at least one seed.",
      { seeds },
    );
  }

  const combined = new Map<NodeIdentityKey, NormalizedSeed>();
  for (const seed of seeds) {
    if (
      typeof seed.id !== "string" ||
      seed.id.length === 0 ||
      typeof seed.kind !== "string" ||
      seed.kind.length === 0
    ) {
      throw new ConfigurationError(
        "Personalized PageRank seed id and kind must be non-empty strings.",
        { seed },
      );
    }
    const weight = seed.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new ConfigurationError(
        `Personalized PageRank seed weight must be finite and greater than 0, got ${String(weight)}.`,
        { seed },
      );
    }
    const key = nodeIdentityKey(seed);
    const previous = combined.get(key);
    const combinedWeight = (previous?.weight ?? 0) + weight;
    if (!Number.isFinite(combinedWeight)) {
      throw new ConfigurationError(
        "Personalized PageRank seed weights overflowed while combining duplicate seeds.",
        { seed },
      );
    }
    combined.set(key, { id: seed.id, kind: seed.kind, weight: combinedWeight });
  }

  const combinedSeeds = [...combined.values()];
  let maximumWeight = 0;
  for (const seed of combinedSeeds) {
    maximumWeight = Math.max(maximumWeight, seed.weight);
  }
  const scaledTotal = combinedSeeds.reduce(
    (total, seed) => total + seed.weight / maximumWeight,
    0,
  );
  return combinedSeeds
    .map((seed) => {
      const weight = seed.weight / maximumWeight / scaledTotal;
      if (weight === 0) {
        throw new ConfigurationError(
          "Personalized PageRank seed weights differ too much to normalize without underflow.",
          { seed },
        );
      }
      return { id: seed.id, kind: seed.kind, weight };
    })
    .toSorted((left, right) => compareNodeIdentity(left, right));
}

function createWorkingTable(context: IterativeGraphRunContext): SQL {
  return sql`
    CREATE TEMP TABLE ${context.workingTable} (
      graph_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_kind TEXT NOT NULL,
      score DOUBLE PRECISION NOT NULL,
      next_score DOUBLE PRECISION NOT NULL,
      personalization DOUBLE PRECISION NOT NULL,
      out_weight DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (graph_id, run_id, node_kind, node_id)
    )
  `;
}

async function initializeWorkingTable(
  context: IterativeGraphRunContext,
  nodeKinds: readonly string[] | undefined,
  seeds: readonly NormalizedSeed[] | undefined,
): Promise<IterationState> {
  const { operation, workingTable, graphId, runId } = context;
  const nodeKindFilter =
    nodeKinds === undefined ?
      sql`TRUE`
    : compileKindFilter(sql.raw("n.kind"), nodeKinds);
  await context.executeTemporary(sql`
    INSERT INTO ${workingTable}
      (graph_id, run_id, node_id, node_kind, score, next_score,
       personalization, out_weight)
    SELECT ${graphId}, ${runId}, n.id, n.kind, 0.0, 0.0, 0.0, 0.0
    FROM ${operation.schema.nodesTable} n
    WHERE n.graph_id = ${graphId}
      AND ${nodeKindFilter}
      AND ${operation.nodeTemporalFilter}
  `);

  const countRows = await context.backend.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS count
      FROM ${workingTable}
      WHERE graph_id = ${graphId} AND run_id = ${runId}
    `),
  );
  const workingTableSize = Number(countRows[0]?.count ?? 0);
  if (workingTableSize === 0) {
    if (seeds !== undefined) {
      throw missingSeedError(seeds);
    }
    return {
      activeScoreColumn: "score",
      maximumChange: 0,
      workingTableSize,
    };
  }

  if (seeds === undefined) {
    const uniformWeight = 1 / workingTableSize;
    await context.executeTemporary(sql`
      UPDATE ${workingTable}
      SET score = ${uniformWeight},
          personalization = ${uniformWeight}
      WHERE graph_id = ${graphId} AND run_id = ${runId}
    `);
  } else {
    await initializePersonalization(context, seeds);
  }

  for (const edgeKinds of operation.edgeKindChunks) {
    await accumulateOutWeights(context, edgeKinds);
  }
  return {
    activeScoreColumn: "score",
    maximumChange: Number.POSITIVE_INFINITY,
    workingTableSize,
  };
}

async function initializePersonalization(
  context: IterativeGraphRunContext,
  seeds: readonly NormalizedSeed[],
): Promise<void> {
  const parameterLimit =
    context.operation.backend.capabilities.maxBindParameters ??
    DEFAULT_MAX_BIND_PARAMETERS;
  const seedChunkSize = Math.floor((parameterLimit - 2) / 3);
  if (seedChunkSize < 1) {
    throw new ConfigurationError(
      "Personalized PageRank cannot fit one seed within the backend bind-parameter limit.",
      { parameterLimit },
    );
  }

  for (let offset = 0; offset < seeds.length; offset += seedChunkSize) {
    const chunk = seeds.slice(offset, offset + seedChunkSize);
    const values = sql.join(
      chunk.map(
        (seed) =>
          sql`(${seed.id}, ${seed.kind}, CAST(${seed.weight} AS DOUBLE PRECISION))`,
      ),
      sql`, `,
    );
    await context.executeTemporary(sql`
      WITH seed_values(node_id, node_kind, weight) AS (VALUES ${values})
      UPDATE ${context.workingTable} AS target
      SET score = seed_values.weight,
          personalization = seed_values.weight
      FROM seed_values
      WHERE target.graph_id = ${context.graphId}
        AND target.run_id = ${context.runId}
        AND target.node_id = seed_values.node_id
        AND target.node_kind = seed_values.node_kind
    `);
  }

  const matchedRows = await context.backend.execute<IdentityRow>(
    asCompiledRowsSql(sql`
      SELECT node_id, node_kind
      FROM ${context.workingTable}
      WHERE graph_id = ${context.graphId}
        AND run_id = ${context.runId}
        AND personalization > 0
    `),
  );
  const matched = new Set(
    matchedRows.map((row) =>
      nodeIdentityKey({ id: row.node_id, kind: row.node_kind }),
    ),
  );
  const missing = seeds.filter((seed) => !matched.has(nodeIdentityKey(seed)));
  if (missing.length > 0) throw missingSeedError(missing);
}

function missingSeedError(
  seeds: readonly NormalizedSeed[],
): ConfigurationError {
  return new ConfigurationError(
    "Personalized PageRank seeds must identify visible nodes inside the selected induced subgraph.",
    { missingSeeds: seeds.map((seed) => ({ id: seed.id, kind: seed.kind })) },
  );
}

async function accumulateOutWeights(
  context: IterativeGraphRunContext,
  edgeKinds: readonly string[],
): Promise<void> {
  const { operation, workingTable, graphId, runId } = context;
  const expansion = compileWorkingTableEdgeExpansion(
    operation,
    workingTable,
    sql`w.graph_id = ${graphId} AND w.run_id = ${runId}`,
    operation.direction,
    edgeKinds,
  );
  const transitionWeight = compileTransitionWeight(operation.direction);

  await context.executeTemporary(sql`
    WITH scoped_edges AS (
      SELECT
        expanded.source_id,
        expanded.source_kind,
        ${transitionWeight} AS transition_weight
      FROM (${expansion}) expanded
      JOIN ${workingTable} scoped_target
        ON scoped_target.graph_id = ${graphId}
        AND scoped_target.run_id = ${runId}
        AND scoped_target.node_id = expanded.target_id
        AND scoped_target.node_kind = expanded.target_kind
    ), degrees AS (
      SELECT source_id, source_kind, SUM(transition_weight) AS out_weight
      FROM scoped_edges
      GROUP BY source_id, source_kind
    )
    UPDATE ${workingTable} AS target
    SET out_weight = target.out_weight + degrees.out_weight
    FROM degrees
    WHERE target.graph_id = ${graphId}
      AND target.run_id = ${runId}
      AND target.node_id = degrees.source_id
      AND target.node_kind = degrees.source_kind
  `);
}

function compileTransitionWeight(direction: TraversalDirection): SQL {
  if (direction !== "both") return sql`1.0`;
  // `both` emits one row per edge endpoint. A self-loop appears in both
  // branches, so each incidence contributes one half and the physical edge
  // retains total transition weight one. Parallel self-loops remain distinct.
  return sql`
    CASE
      WHEN expanded.source_id = expanded.target_id
       AND expanded.source_kind = expanded.target_kind
      THEN 0.5
      ELSE 1.0
    END
  `;
}

async function runPowerIterationRound(
  context: IterativeGraphRunContext,
  state: IterationState,
  dampingFactor: number,
): Promise<IterationState> {
  const sourceScoreColumn = state.activeScoreColumn;
  const targetScoreColumn: ScoreColumn =
    sourceScoreColumn === "score" ? "next_score" : "score";
  await resetTargetScores(
    context,
    sourceScoreColumn,
    targetScoreColumn,
    dampingFactor,
  );

  for (const edgeKinds of context.operation.edgeKindChunks) {
    await accumulateContributions(
      context,
      edgeKinds,
      dampingFactor,
      sourceScoreColumn,
      targetScoreColumn,
    );
  }

  const maximumChange = await readMaximumChange(
    context,
    sourceScoreColumn,
    targetScoreColumn,
  );
  return {
    activeScoreColumn: targetScoreColumn,
    maximumChange,
    workingTableSize: state.workingTableSize,
  };
}

async function resetTargetScores(
  context: IterativeGraphRunContext,
  sourceScoreColumn: ScoreColumn,
  targetScoreColumn: ScoreColumn,
  dampingFactor: number,
): Promise<void> {
  const sourceScore = sql.identifier(sourceScoreColumn);
  const targetScore = sql.identifier(targetScoreColumn);
  await context.executeTemporary(sql`
    UPDATE ${context.workingTable}
    SET ${targetScore} = personalization * (
      ${1 - dampingFactor} + ${dampingFactor} * (
        SELECT COALESCE(SUM(dangling.${sourceScore}), 0.0)
        FROM ${context.workingTable} dangling
        WHERE dangling.graph_id = ${context.graphId}
          AND dangling.run_id = ${context.runId}
          AND dangling.out_weight = 0.0
      )
    )
    WHERE graph_id = ${context.graphId} AND run_id = ${context.runId}
  `);
}

async function accumulateContributions(
  context: IterativeGraphRunContext,
  edgeKinds: readonly string[],
  dampingFactor: number,
  sourceScoreColumn: ScoreColumn,
  targetScoreColumn: ScoreColumn,
): Promise<void> {
  const { operation, workingTable, graphId, runId } = context;
  const sourceScore = sql.identifier(sourceScoreColumn);
  const targetScore = sql.identifier(targetScoreColumn);
  const expansion = compileWorkingTableEdgeExpansion(
    operation,
    workingTable,
    sql`w.graph_id = ${graphId} AND w.run_id = ${runId}`,
    operation.direction,
    edgeKinds,
    sql`w.${sourceScore} AS source_score, w.out_weight AS source_out_weight`,
  );
  const transitionWeight = compileTransitionWeight(operation.direction);

  await context.executeTemporary(sql`
    WITH scoped_edges AS (
      SELECT
        expanded.target_id,
        expanded.target_kind,
        expanded.source_score,
        expanded.source_out_weight,
        ${transitionWeight} AS transition_weight
      FROM (${expansion}) expanded
      JOIN ${workingTable} scoped_target
        ON scoped_target.graph_id = ${graphId}
        AND scoped_target.run_id = ${runId}
        AND scoped_target.node_id = expanded.target_id
        AND scoped_target.node_kind = expanded.target_kind
      WHERE expanded.source_out_weight > 0.0
    ), contributions AS (
      SELECT
        target_id,
        target_kind,
        SUM(source_score * transition_weight / source_out_weight) AS score
      FROM scoped_edges
      GROUP BY target_id, target_kind
    )
    UPDATE ${workingTable} AS target
    SET ${targetScore} = target.${targetScore} + ${dampingFactor} * contributions.score
    FROM contributions
    WHERE target.graph_id = ${graphId}
      AND target.run_id = ${runId}
      AND target.node_id = contributions.target_id
      AND target.node_kind = contributions.target_kind
  `);
}

async function readMaximumChange(
  context: IterativeGraphRunContext,
  sourceScoreColumn: ScoreColumn,
  targetScoreColumn: ScoreColumn,
): Promise<number> {
  const sourceScore = sql.identifier(sourceScoreColumn);
  const targetScore = sql.identifier(targetScoreColumn);
  const rows = await context.backend.execute<MetricRow>(
    asCompiledRowsSql(sql`
      SELECT COALESCE(MAX(ABS(${targetScore} - ${sourceScore})), 0.0) AS value
      FROM ${context.workingTable}
      WHERE graph_id = ${context.graphId} AND run_id = ${context.runId}
    `),
  );
  return Number(rows[0]?.value ?? 0);
}

async function extractScores(
  context: IterativeGraphRunContext,
  state: IterationState,
): Promise<readonly PageRankScore[]> {
  const score = sql.identifier(state.activeScoreColumn);
  const nodeId = context.operation.ctx.dialect.binaryText(sql`node_id`);
  const nodeKind = context.operation.ctx.dialect.binaryText(sql`node_kind`);
  const rows = await context.backend.execute<ScoreRow>(
    asCompiledRowsSql(sql`
      SELECT node_id, node_kind, ${score} AS score
      FROM ${context.workingTable}
      WHERE graph_id = ${context.graphId} AND run_id = ${context.runId}
      ORDER BY ${score} DESC, ${nodeId}, ${nodeKind}
    `),
  );
  return rows.map((row) => ({
    id: row.node_id,
    kind: row.node_kind,
    score: Number(row.score),
  }));
}
