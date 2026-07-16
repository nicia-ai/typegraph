import { sql } from "drizzle-orm";

import { asCompiledRowsSql } from "../../query/sql-intent";
import { compareStrings } from "../../utils/compare";
import type { AlgorithmContext, InternalTraversalOptions } from "./context";
import {
  compareNodeIdentity,
  compileWorkingTableEdgeExpansion,
  compileWorkingTableExpansion,
  fetchVisibleWorkingNodes,
  type IterativeGraphOperation,
  type IterativeGraphRunContext,
  type NodeExpansion,
  type NodeIdentityKey,
  nodeIdentityKey,
  reduceExpandedWorkingSet,
  runIterativeGraphOperation,
  withInlineIterativeGraphOperation,
} from "./iterative-graph-operation";
import type {
  PathNode,
  ReachableNode,
  ShortestPathResult,
  TraversalDirection,
} from "./types";

type FrontierCandidate = Readonly<{
  id: string;
  kind: string;
  parentId: string;
  parentKind: string;
}>;

type VisitedNode = Readonly<{
  id: string;
  kind: string;
  depth: number;
  parentKey: NodeIdentityKey | undefined;
}>;

type WorkingRow = Readonly<{
  side: WorkingSide;
  node_id: string;
  node_kind: string;
  depth: number | string;
  predecessor_id: unknown;
  predecessor_kind: unknown;
}>;

type InsertedRow = Readonly<{ node_id: string }>;
type SeededRow = Readonly<{ node_id: string; node_kind: string }>;
type InsertedFrontierRow = Readonly<{
  node_id: string;
  node_kind: string;
  meeting_depth: unknown;
}>;
type WorkingSide = "forward" | "reverse";

type MeetingNode = Readonly<{
  id: string;
  kind: string;
  depth: number;
}>;

type FrontierRound = Readonly<{
  insertedCount: number;
  meeting: MeetingNode | undefined;
}>;

export async function findReachableNodes(
  ctx: AlgorithmContext,
  sourceId: string,
  maxHops: number,
  options: InternalTraversalOptions,
): Promise<readonly ReachableNode[]> {
  if (supportsTemporaryIteration(ctx)) {
    return findReachableNodesInWorkingTable(ctx, sourceId, maxHops, options);
  }
  return findReachableNodesInline(ctx, sourceId, maxHops, options);
}

export async function findShortestPath(
  ctx: AlgorithmContext,
  sourceId: string,
  targetId: string,
  maxHops: number,
  options: InternalTraversalOptions,
): Promise<ShortestPathResult | undefined> {
  if (supportsTemporaryIteration(ctx)) {
    return findShortestPathInWorkingTable(
      ctx,
      sourceId,
      targetId,
      maxHops,
      options,
    );
  }
  return findShortestPathInline(ctx, sourceId, targetId, maxHops, options);
}

function supportsTemporaryIteration(ctx: AlgorithmContext): boolean {
  // Working-table rounds fold their frontier and meeting bookkeeping into
  // `INSERT … RETURNING`, so an engine without RETURNING must take the
  // inline fallback.
  return (
    ctx.backend.capabilities.transactions &&
    ctx.backend.capabilities.returning !== false &&
    ctx.backend.executeTemporaryStatement !== undefined
  );
}

async function findReachableNodesInWorkingTable(
  ctx: AlgorithmContext,
  sourceId: string,
  maxHops: number,
  options: InternalTraversalOptions,
): Promise<readonly ReachableNode[]> {
  return runIterativeGraphOperation(ctx, options, {
    algorithm: "reachable",
    maxIterations: maxHops,
    createWorkingTable,
    async initialize(context) {
      const seeded = await seedWorkingSide(context, sourceId, "forward");
      return {
        depth: 0,
        frontierCount: seeded.length,
        workingTableSize: seeded.length,
      };
    },
    async runRound(context, state) {
      const nextDepth = state.depth + 1;
      const frontierCount = await expandReachableWorkingTableRound(
        context,
        "forward",
        state.depth,
        nextDepth,
        context.operation.direction,
      );
      return {
        depth: nextDepth,
        frontierCount,
        workingTableSize: state.workingTableSize + frontierCount,
      };
    },
    hasConverged(state) {
      return state.frontierCount === 0 || state.depth >= maxHops;
    },
    async extractResult(context) {
      const rows = await readWorkingRows(context, "forward");
      return rows
        .map((row) => ({
          id: row.node_id,
          kind: row.node_kind,
          depth: Number(row.depth),
        }))
        .toSorted(
          (left, right) =>
            left.depth - right.depth || compareNodeIdentity(left, right),
        );
    },
  });
}

async function findShortestPathInWorkingTable(
  ctx: AlgorithmContext,
  sourceId: string,
  targetId: string,
  maxHops: number,
  options: InternalTraversalOptions,
): Promise<ShortestPathResult | undefined> {
  return runIterativeGraphOperation(ctx, options, {
    algorithm: "shortestPath",
    maxIterations: maxHops,
    createWorkingTable,
    async initialize(context) {
      const forwardSeeds = await seedWorkingSide(context, sourceId, "forward");
      const reverseSeeds = await seedWorkingSide(context, targetId, "reverse");
      return {
        forwardDepth: 0,
        reverseDepth: 0,
        forwardFrontierCount: forwardSeeds.length,
        reverseFrontierCount: reverseSeeds.length,
        meeting: findSeedMeeting(forwardSeeds, reverseSeeds),
        workingTableSize: forwardSeeds.length + reverseSeeds.length,
      };
    },
    async runRound(context, state) {
      const expandForward =
        state.forwardFrontierCount <= state.reverseFrontierCount;
      const side = expandForward ? "forward" : "reverse";
      const currentDepth =
        expandForward ? state.forwardDepth : state.reverseDepth;
      const nextDepth = currentDepth + 1;
      const direction =
        expandForward ?
          context.operation.direction
        : reverseDirection(context.operation.direction);
      const round = await expandWorkingTableRound(
        context,
        side,
        currentDepth,
        nextDepth,
        direction,
        maxHops,
      );

      return {
        forwardDepth: expandForward ? nextDepth : state.forwardDepth,
        reverseDepth: expandForward ? state.reverseDepth : nextDepth,
        forwardFrontierCount:
          expandForward ? round.insertedCount : state.forwardFrontierCount,
        reverseFrontierCount:
          expandForward ? state.reverseFrontierCount : round.insertedCount,
        meeting: round.meeting,
        workingTableSize: state.workingTableSize + round.insertedCount,
      };
    },
    hasConverged(state) {
      return (
        state.meeting !== undefined ||
        state.forwardFrontierCount === 0 ||
        state.reverseFrontierCount === 0 ||
        state.forwardDepth + state.reverseDepth >= maxHops
      );
    },
    async extractResult(context, state) {
      if (state.meeting === undefined) return;
      const rows = await readWorkingRows(context);
      return buildShortestPath(
        nodeIdentityKey(state.meeting),
        createVisitedMapFromRows(rows, "forward"),
        createVisitedMapFromRows(rows, "reverse"),
      );
    },
  });
}

function createWorkingTable(context: IterativeGraphRunContext) {
  return sql`
    CREATE TEMP TABLE ${context.workingTable} (
        graph_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        side TEXT NOT NULL,
        node_id TEXT NOT NULL,
        node_kind TEXT NOT NULL,
        depth INTEGER NOT NULL,
        predecessor_id TEXT,
        predecessor_kind TEXT,
        meeting_depth INTEGER,
        PRIMARY KEY (graph_id, run_id, side, node_kind, node_id)
      )
  `;
}

/**
 * Seeds one traversal side and returns the seeded node identities from the
 * same statement, so the caller reads the frontier size (and, for
 * bidirectional search, the source-equals-target meeting) without a
 * follow-up COUNT round-trip.
 */
async function seedWorkingSide(
  context: IterativeGraphRunContext,
  nodeId: string,
  side: WorkingSide,
): Promise<readonly SeededRow[]> {
  const { operation, workingTable, graphId, runId } = context;
  return context.backend.execute<SeededRow>(
    asCompiledRowsSql(sql`
      INSERT INTO ${workingTable}
        (graph_id, run_id, side, node_id, node_kind, depth,
         predecessor_id, predecessor_kind)
      SELECT ${graphId}, ${runId}, ${side}, n.id, n.kind, 0, NULL, NULL
      FROM ${operation.schema.nodesTable} n
      WHERE n.graph_id = ${graphId}
        AND n.id = ${nodeId}
        AND ${operation.nodeTemporalFilter}
      ON CONFLICT (graph_id, run_id, side, node_kind, node_id) DO NOTHING
      RETURNING node_id, node_kind
    `),
  );
}

/**
 * Detects the depth-zero meeting for bidirectional search: a node seeded on
 * both sides (source equals target, possibly across kinds sharing that id).
 * Ties break like the SQL meeting probe used to — smallest node id, then
 * kind.
 */
function findSeedMeeting(
  forwardSeeds: readonly SeededRow[],
  reverseSeeds: readonly SeededRow[],
): MeetingNode | undefined {
  const reverseKeys = new Set(
    reverseSeeds.map((row) =>
      nodeIdentityKey({ id: row.node_id, kind: row.node_kind }),
    ),
  );
  let meeting: MeetingNode | undefined;
  for (const row of forwardSeeds) {
    const candidate = { id: row.node_id, kind: row.node_kind, depth: 0 };
    if (!reverseKeys.has(nodeIdentityKey(candidate))) continue;
    if (meeting === undefined || compareNodeIdentity(candidate, meeting) < 0) {
      meeting = candidate;
    }
  }
  return meeting;
}

/**
 * Expands one bidirectional round and detects meetings in the same
 * statement. Each inserted frontier row captures the opposite side's depth
 * for the same node identity (`meeting_depth`); a non-null value marks a
 * meeting. Only newly inserted rows can create a new meeting — both sides'
 * existing rows are immutable and any meeting among them would have
 * converged an earlier round — so the returned rows are a complete meeting
 * probe and the separate per-round meeting query is unnecessary.
 */
async function expandWorkingTableRound(
  context: IterativeGraphRunContext,
  side: WorkingSide,
  currentDepth: number,
  nextDepth: number,
  direction: TraversalDirection,
  maxHops: number,
): Promise<FrontierRound> {
  const oppositeSide: WorkingSide = side === "forward" ? "reverse" : "forward";
  let insertedCount = 0;
  let meeting: MeetingNode | undefined;
  for (const edgeKinds of context.operation.edgeKindChunks) {
    const sourceFilter = sql`
      w.graph_id = ${context.graphId}
      AND w.run_id = ${context.runId}
      AND w.side = ${side}
      AND w.depth = ${currentDepth}
    `;
    const expansion = compileWorkingTableExpansion(
      context.operation,
      context.workingTable,
      sourceFilter,
      direction,
      edgeKinds,
    );
    const rows = await context.backend.execute<InsertedFrontierRow>(
      asCompiledRowsSql(sql`
        INSERT INTO ${context.workingTable}
          (graph_id, run_id, side, node_id, node_kind, depth,
           predecessor_id, predecessor_kind, meeting_depth)
        SELECT
          ${context.graphId}, ${context.runId}, ${side},
          ranked.target_id, ranked.target_kind, ${nextDepth},
          ranked.source_id, ranked.source_kind,
          (
            SELECT opposite.depth
            FROM ${context.workingTable} opposite
            WHERE opposite.graph_id = ${context.graphId}
              AND opposite.run_id = ${context.runId}
              AND opposite.side = ${oppositeSide}
              AND opposite.node_id = ranked.target_id
              AND opposite.node_kind = ranked.target_kind
          )
        FROM (
          SELECT expanded.*,
            ROW_NUMBER() OVER (
              PARTITION BY expanded.target_kind, expanded.target_id
              ORDER BY expanded.source_id, expanded.source_kind
            ) AS candidate_rank
          FROM (${expansion}) expanded
        ) ranked
        WHERE ranked.candidate_rank = 1
          AND NOT EXISTS (
            SELECT 1
            FROM ${context.workingTable} visited
            WHERE visited.graph_id = ${context.graphId}
              AND visited.run_id = ${context.runId}
              AND visited.side = ${side}
              AND visited.node_id = ranked.target_id
              AND visited.node_kind = ranked.target_kind
          )
        ON CONFLICT (graph_id, run_id, side, node_kind, node_id) DO NOTHING
        RETURNING node_id, node_kind, meeting_depth
      `),
    );
    insertedCount += rows.length;
    meeting = selectRoundMeeting(meeting, rows, nextDepth, maxHops);
  }
  return { insertedCount, meeting };
}

/**
 * Folds one round's inserted rows into the best meeting so far, matching the
 * former SQL probe's selection: smallest total depth within `maxHops`, ties
 * broken by node id then kind.
 */
function selectRoundMeeting(
  currentMeeting: MeetingNode | undefined,
  rows: readonly InsertedFrontierRow[],
  nextDepth: number,
  maxHops: number,
): MeetingNode | undefined {
  let meeting = currentMeeting;
  for (const row of rows) {
    if (
      typeof row.meeting_depth !== "number" &&
      typeof row.meeting_depth !== "string"
    ) {
      continue;
    }
    const totalDepth = nextDepth + Number(row.meeting_depth);
    if (totalDepth > maxHops) continue;
    const candidate = {
      id: row.node_id,
      kind: row.node_kind,
      depth: totalDepth,
    };
    if (
      meeting === undefined ||
      candidate.depth < meeting.depth ||
      (candidate.depth === meeting.depth &&
        compareNodeIdentity(candidate, meeting) < 0)
    ) {
      meeting = candidate;
    }
  }
  return meeting;
}

/**
 * Reachability needs only minimum depth, not a reconstructable predecessor.
 * Reduce duplicate edge targets before checking target-node visibility so a
 * dense frontier performs one node lookup per candidate identity rather than
 * one lookup per incident edge.
 */
async function expandReachableWorkingTableRound(
  context: IterativeGraphRunContext,
  side: WorkingSide,
  currentDepth: number,
  nextDepth: number,
  direction: TraversalDirection,
): Promise<number> {
  let insertedCount = 0;
  for (const edgeKinds of context.operation.edgeKindChunks) {
    const sourceFilter = sql`
      w.graph_id = ${context.graphId}
      AND w.run_id = ${context.runId}
      AND w.side = ${side}
      AND w.depth = ${currentDepth}
    `;
    const edgeExpansion = compileWorkingTableEdgeExpansion(
      context.operation,
      context.workingTable,
      sourceFilter,
      direction,
      edgeKinds,
    );
    const rows = await context.backend.execute<InsertedRow>(
      asCompiledRowsSql(sql`
        INSERT INTO ${context.workingTable}
          (graph_id, run_id, side, node_id, node_kind, depth,
           predecessor_id, predecessor_kind)
        SELECT
          ${context.graphId}, ${context.runId}, ${side},
          candidates.target_id, candidates.target_kind, ${nextDepth},
          NULL, NULL
        FROM (
          SELECT DISTINCT expanded.target_id, expanded.target_kind
          FROM (${edgeExpansion}) expanded
        ) candidates
        JOIN ${context.operation.schema.nodesTable} n
          ON n.graph_id = ${context.graphId}
          AND n.id = candidates.target_id
          AND n.kind = candidates.target_kind
        WHERE ${context.operation.nodeTemporalFilter}
          AND NOT EXISTS (
            SELECT 1
            FROM ${context.workingTable} visited
            WHERE visited.graph_id = ${context.graphId}
              AND visited.run_id = ${context.runId}
              AND visited.side = ${side}
              AND visited.node_id = candidates.target_id
              AND visited.node_kind = candidates.target_kind
          )
        ON CONFLICT (graph_id, run_id, side, node_kind, node_id) DO NOTHING
        RETURNING node_id
      `),
    );
    insertedCount += rows.length;
  }
  return insertedCount;
}

async function readWorkingRows(
  context: IterativeGraphRunContext,
  side?: WorkingSide,
): Promise<readonly WorkingRow[]> {
  const sideFilter = side === undefined ? sql`TRUE` : sql`side = ${side}`;
  return context.backend.execute<WorkingRow>(
    asCompiledRowsSql(sql`
      SELECT side, node_id, node_kind, depth,
        predecessor_id, predecessor_kind
      FROM ${context.workingTable}
      WHERE graph_id = ${context.graphId}
        AND run_id = ${context.runId}
        AND ${sideFilter}
      ORDER BY side, depth, node_id, node_kind
    `),
  );
}

async function findReachableNodesInline(
  ctx: AlgorithmContext,
  sourceId: string,
  maxHops: number,
  options: InternalTraversalOptions,
): Promise<readonly ReachableNode[]> {
  return withInlineIterativeGraphOperation(ctx, options, async (operation) => {
    const sources = await fetchVisibleWorkingNodes(operation, [sourceId]);
    if (sources.length === 0) return [];

    const reached = new Map<NodeIdentityKey, ReachableNode>(
      sources.map((source) => [
        nodeIdentityKey(source),
        { id: source.id, kind: source.kind, depth: 0 },
      ]),
    );
    let workingSet: readonly PathNode[] = sources;

    for (let depth = 1; depth <= maxHops && workingSet.length > 0; depth++) {
      const candidates = await expandInlineWorkingSet(
        operation,
        workingSet,
        operation.direction,
        reached,
      );
      const nextWorkingSet = sortCandidates(candidates);
      for (const candidate of nextWorkingSet) {
        reached.set(nodeIdentityKey(candidate), {
          id: candidate.id,
          kind: candidate.kind,
          depth,
        });
      }
      workingSet = nextWorkingSet;
    }

    return [...reached.values()].toSorted(
      (left, right) =>
        left.depth - right.depth || compareNodeIdentity(left, right),
    );
  });
}

async function findShortestPathInline(
  ctx: AlgorithmContext,
  sourceId: string,
  targetId: string,
  maxHops: number,
  options: InternalTraversalOptions,
): Promise<ShortestPathResult | undefined> {
  return withInlineIterativeGraphOperation(ctx, options, async (operation) => {
    const visibleNodes = await fetchVisibleWorkingNodes(operation, [
      sourceId,
      targetId,
    ]);
    const sources = visibleNodes.filter((node) => node.id === sourceId);
    const targets = visibleNodes.filter((node) => node.id === targetId);
    if (sources.length === 0 || targets.length === 0) return;
    if (sourceId === targetId) return { nodes: [sources[0]!], depth: 0 };

    const forwardVisited = createVisitedMap(sources);
    const reverseVisited = createVisitedMap(targets);
    let forwardWorkingSet: readonly PathNode[] = sources;
    let reverseWorkingSet: readonly PathNode[] = targets;
    let forwardDepth = 0;
    let reverseDepth = 0;

    while (
      forwardWorkingSet.length > 0 &&
      reverseWorkingSet.length > 0 &&
      forwardDepth + reverseDepth < maxHops
    ) {
      const expandForward =
        forwardWorkingSet.length <= reverseWorkingSet.length;
      const activeVisited = expandForward ? forwardVisited : reverseVisited;
      const oppositeVisited = expandForward ? reverseVisited : forwardVisited;
      const currentWorkingSet =
        expandForward ? forwardWorkingSet : reverseWorkingSet;
      const direction =
        expandForward ?
          operation.direction
        : reverseDirection(operation.direction);
      const candidates = await expandInlineWorkingSet(
        operation,
        currentWorkingSet,
        direction,
        activeVisited,
      );
      const nextDepth = (expandForward ? forwardDepth : reverseDepth) + 1;
      const nextWorkingSet = sortCandidates(candidates);

      for (const candidate of nextWorkingSet) {
        activeVisited.set(nodeIdentityKey(candidate), {
          id: candidate.id,
          kind: candidate.kind,
          depth: nextDepth,
          parentKey: nodeIdentityKey({
            id: candidate.parentId,
            kind: candidate.parentKind,
          }),
        });
      }

      const meetingKey = findMeetingNodeKey(
        nextWorkingSet,
        activeVisited,
        oppositeVisited,
      );
      if (meetingKey !== undefined) {
        return buildShortestPath(meetingKey, forwardVisited, reverseVisited);
      }

      if (expandForward) {
        forwardWorkingSet = nextWorkingSet;
        forwardDepth = nextDepth;
      } else {
        reverseWorkingSet = nextWorkingSet;
        reverseDepth = nextDepth;
      }
    }
    return;
  });
}

async function expandInlineWorkingSet(
  operation: IterativeGraphOperation,
  workingSet: readonly PathNode[],
  direction: TraversalDirection,
  visited: ReadonlyMap<NodeIdentityKey, unknown>,
): Promise<ReadonlyMap<NodeIdentityKey, FrontierCandidate>> {
  return reduceExpandedWorkingSet(
    operation,
    workingSet,
    direction,
    (existing, expansion) => selectPredecessor(existing, expansion, visited),
  );
}

function selectPredecessor(
  existing: FrontierCandidate | undefined,
  expansion: NodeExpansion,
  visited: ReadonlyMap<NodeIdentityKey, unknown>,
): FrontierCandidate | undefined {
  if (visited.has(nodeIdentityKey(expansion.target))) return existing;
  if (
    existing !== undefined &&
    compareNodeIdentity(expansion.source, {
      id: existing.parentId,
      kind: existing.parentKind,
    }) >= 0
  ) {
    return existing;
  }
  return {
    id: expansion.target.id,
    kind: expansion.target.kind,
    parentId: expansion.source.id,
    parentKind: expansion.source.kind,
  };
}

function sortCandidates(
  candidates: ReadonlyMap<NodeIdentityKey, FrontierCandidate>,
): readonly FrontierCandidate[] {
  return [...candidates.values()].toSorted((left, right) =>
    compareNodeIdentity(left, right),
  );
}

function findMeetingNodeKey(
  candidates: readonly FrontierCandidate[],
  activeVisited: ReadonlyMap<NodeIdentityKey, VisitedNode>,
  oppositeVisited: ReadonlyMap<NodeIdentityKey, VisitedNode>,
): NodeIdentityKey | undefined {
  let best: Readonly<{ key: NodeIdentityKey; depth: number }> | undefined;
  for (const candidate of candidates) {
    const key = nodeIdentityKey(candidate);
    const active = activeVisited.get(key);
    const opposite = oppositeVisited.get(key);
    if (active === undefined || opposite === undefined) continue;
    const meeting = { key, depth: active.depth + opposite.depth };
    if (
      best === undefined ||
      meeting.depth < best.depth ||
      (meeting.depth === best.depth &&
        compareStrings(meeting.key, best.key) < 0)
    ) {
      best = meeting;
    }
  }
  return best?.key;
}

function buildShortestPath(
  meetingKey: NodeIdentityKey,
  forwardVisited: ReadonlyMap<NodeIdentityKey, VisitedNode>,
  reverseVisited: ReadonlyMap<NodeIdentityKey, VisitedNode>,
): ShortestPathResult {
  const forwardKeys: NodeIdentityKey[] = [];
  let cursor: NodeIdentityKey | undefined = meetingKey;
  while (cursor !== undefined) {
    forwardKeys.push(cursor);
    cursor = forwardVisited.get(cursor)?.parentKey;
  }
  forwardKeys.reverse();

  const pathKeys = [...forwardKeys];
  cursor = reverseVisited.get(meetingKey)?.parentKey;
  while (cursor !== undefined) {
    pathKeys.push(cursor);
    cursor = reverseVisited.get(cursor)?.parentKey;
  }

  const nodes = pathKeys.map((key) => {
    const node = forwardVisited.get(key) ?? reverseVisited.get(key);
    return { id: node?.id ?? "", kind: node?.kind ?? "" };
  });
  return { nodes, depth: nodes.length - 1 };
}

function createVisitedMap(
  nodes: readonly PathNode[],
): Map<NodeIdentityKey, VisitedNode> {
  return new Map(
    nodes.map((node) => [
      nodeIdentityKey(node),
      { id: node.id, kind: node.kind, depth: 0, parentKey: undefined },
    ]),
  );
}

function createVisitedMapFromRows(
  rows: readonly WorkingRow[],
  side: WorkingSide,
): Map<NodeIdentityKey, VisitedNode> {
  return new Map(
    rows
      .filter((row) => row.side === side)
      .map((row) => {
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
          depth: Number(row.depth),
          parentKey,
        } satisfies VisitedNode;
        return [nodeIdentityKey(node), node];
      }),
  );
}

function reverseDirection(direction: TraversalDirection): TraversalDirection {
  switch (direction) {
    case "out": {
      return "in";
    }
    case "in": {
      return "out";
    }
    case "both": {
      return "both";
    }
  }
}
