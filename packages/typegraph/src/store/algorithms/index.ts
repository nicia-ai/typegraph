import { type GraphBackend } from "../../backend/types";
import { type GraphDef } from "../../core/define-graph";
import { type TemporalMode } from "../../core/types";
import {
  createSqlSchema,
  type RecordedReadBinding,
  type SqlSchema,
} from "../../query/compiler/schema";
import { getDialect } from "../../query/dialect";
import { type KindRegistry } from "../../registry/kind-registry";
import { assertNoRecordedCoordinate } from "../recorded-coordinate-guard";
import { type AlgorithmContext } from "./context";
import { executeDegree } from "./degree";
import {
  executeCanReach,
  executeNeighbors,
  executeReachable,
} from "./reachable";
import { executeShortestPath } from "./shortest-path";
import type {
  BaseTraversalOptions,
  DegreeOptions,
  InternalBaseTraversalOptions,
  InternalDegreeOptions,
  InternalNeighborsOptions,
  InternalReachableOptions,
  InternalShortestPathOptions,
  NeighborsOptions,
  ReachableNode,
  ReachableOptions,
  ShortestPathOptions,
  ShortestPathResult,
} from "./types";

/**
 * Raw node id or any object with an `id: string` field. Covers `Node`,
 * `NodeRef`, and the lightweight `ReachableNode` / `PathNode` shapes
 * returned by the algorithms themselves.
 *
 * Deliberately kind-agnostic: graph algorithms don't constrain the source
 * node's kind — you can start a traversal from any node reachable via the
 * given edge kinds. `NodeRef<N>` exists for the edge-endpoint case where
 * kind *is* load-bearing; using it here would paint a constraint onto a
 * contract that doesn't need one and would reject common patterns like
 * passing `ReachableNode` / cache entries / `{ id }` records straight
 * through.
 */
export type NodeIdentifier = string | Readonly<{ id: string }>;

function resolveNodeId(value: NodeIdentifier): string {
  return typeof value === "string" ? value : value.id;
}

export type GraphAlgorithms<G extends GraphDef> = Readonly<{
  /**
   * Finds the shortest directed path from `from` to `to` using the given
   * edge kinds. Returns `undefined` when no path exists within `maxHops`.
   *
   * @example
   * ```typescript
   * const path = await store.algorithms.shortestPath(alice, bob, {
   *   edges: ["knows"],
   *   maxHops: 6,
   * });
   * if (path) {
   *   console.log(`${path.depth} hops via`, path.nodes.map((n) => n.id));
   * }
   * ```
   */
  shortestPath: (
    from: NodeIdentifier,
    to: NodeIdentifier,
    options: ShortestPathOptions<G>,
  ) => Promise<ShortestPathResult | undefined>;

  /**
   * Returns every node reachable from `from` within `maxHops` edges of the
   * allowed kinds. Each node carries its minimum discovered depth.
   */
  reachable: (
    from: NodeIdentifier,
    options: ReachableOptions<G>,
  ) => Promise<readonly ReachableNode[]>;

  /**
   * Fast boolean check: is `to` reachable from `from` within `maxHops`
   * edges? Uses bidirectional BFS and stops when the frontiers meet.
   */
  canReach: (
    from: NodeIdentifier,
    to: NodeIdentifier,
    options: BaseTraversalOptions<G>,
  ) => Promise<boolean>;

  /**
   * Returns the k-hop neighborhood of a node. The source is always
   * excluded. `depth` defaults to 1, matching the common "immediate
   * neighbors" interpretation.
   */
  neighbors: (
    node: NodeIdentifier,
    options: NeighborsOptions<G>,
  ) => Promise<readonly ReachableNode[]>;

  /**
   * Counts active edges incident to `node`.
   *
   * With `direction: "both"` (default), self-loops contribute once.
   */
  degree: (node: NodeIdentifier, options?: DegreeOptions<G>) => Promise<number>;
}>;

export type InternalGraphAlgorithms<G extends GraphDef> = Readonly<{
  shortestPath: (
    from: NodeIdentifier,
    to: NodeIdentifier,
    options: InternalShortestPathOptions<G>,
  ) => Promise<ShortestPathResult | undefined>;
  reachable: (
    from: NodeIdentifier,
    options: InternalReachableOptions<G>,
  ) => Promise<readonly ReachableNode[]>;
  canReach: (
    from: NodeIdentifier,
    to: NodeIdentifier,
    options: InternalBaseTraversalOptions<G>,
  ) => Promise<boolean>;
  neighbors: (
    node: NodeIdentifier,
    options: InternalNeighborsOptions<G>,
  ) => Promise<readonly ReachableNode[]>;
  degree: (
    node: NodeIdentifier,
    options?: InternalDegreeOptions<G>,
  ) => Promise<number>;
}>;

export type CreateGraphAlgorithmsParams = Readonly<{
  graphId: string;
  graph: GraphDef;
  registry: KindRegistry;
  backend: GraphBackend;
  schema: SqlSchema | undefined;
  recordedReadBinding: RecordedReadBinding | undefined;
  defaultTemporalMode: TemporalMode;
  allowRecordedAsOf?: boolean;
}>;

function assertRecordedAsOfInternalOnly(
  options: unknown,
  method: string,
  allowRecordedAsOf: boolean,
): void {
  if (allowRecordedAsOf) return;
  assertNoRecordedCoordinate(options, {
    code: "ALGORITHM_RECORDED_ASOF_INTERNAL_ONLY",
    message: `recordedAsOf is only available through store.asOfRecorded(...).${method}(...).`,
    context: { method },
    suggestion:
      "Use store.asOfRecorded(recordedAt).reachable/shortestPath/canReach/neighbors/degree(...) instead of passing recordedAsOf directly.",
  });
}

export function createGraphAlgorithms<G extends GraphDef>(
  params: CreateGraphAlgorithmsParams,
): InternalGraphAlgorithms<G> {
  const allowRecordedAsOf = params.allowRecordedAsOf === true;
  const ctx: AlgorithmContext = {
    graphId: params.graphId,
    graph: params.graph,
    registry: params.registry,
    backend: params.backend,
    dialect: getDialect(params.backend.dialect),
    schema: params.schema ?? createSqlSchema(params.backend.tableNames),
    recordedReadBinding: params.recordedReadBinding,
    defaultTemporalMode: params.defaultTemporalMode,
  };

  return {
    shortestPath(from, to, options) {
      assertRecordedAsOfInternalOnly(
        options,
        "shortestPath",
        allowRecordedAsOf,
      );
      return executeShortestPath(
        ctx,
        resolveNodeId(from),
        resolveNodeId(to),
        options,
      );
    },
    reachable(from, options) {
      assertRecordedAsOfInternalOnly(options, "reachable", allowRecordedAsOf);
      return executeReachable(ctx, resolveNodeId(from), options);
    },
    canReach(from, to, options) {
      assertRecordedAsOfInternalOnly(options, "canReach", allowRecordedAsOf);
      return executeCanReach(
        ctx,
        resolveNodeId(from),
        resolveNodeId(to),
        options,
      );
    },
    neighbors(node, options) {
      assertRecordedAsOfInternalOnly(options, "neighbors", allowRecordedAsOf);
      return executeNeighbors(ctx, resolveNodeId(node), options);
    },
    degree(node, options) {
      assertRecordedAsOfInternalOnly(options, "degree", allowRecordedAsOf);
      return executeDegree(ctx, resolveNodeId(node), options ?? {});
    },
  };
}

export type {
  AlgorithmCyclePolicy,
  BaseTraversalOptions,
  DegreeOptions,
  InternalBaseTraversalOptions,
  InternalDegreeOptions,
  InternalNeighborsOptions,
  InternalReachableOptions,
  InternalShortestPathOptions,
  InternalTemporalAlgorithmOptions,
  NeighborsOptions,
  PathNode,
  ReachableNode,
  ReachableOptions,
  ShortestPathOptions,
  ShortestPathResult,
  TemporalAlgorithmOptions,
  TraversalDirection,
} from "./types";
