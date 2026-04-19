import { type GraphBackend } from "../../backend/types";
import { type GraphDef } from "../../core/define-graph";
import { type TemporalMode } from "../../core/types";
import { createSqlSchema, type SqlSchema } from "../../query/compiler/schema";
import { getDialect } from "../../query/dialect";
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
   * edges? Short-circuits the underlying recursive CTE with `LIMIT 1`.
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

export type CreateGraphAlgorithmsParams = Readonly<{
  graphId: string;
  backend: GraphBackend;
  schema: SqlSchema | undefined;
  defaultTemporalMode: TemporalMode;
}>;

export function createGraphAlgorithms<G extends GraphDef>(
  params: CreateGraphAlgorithmsParams,
): GraphAlgorithms<G> {
  const ctx: AlgorithmContext = {
    graphId: params.graphId,
    backend: params.backend,
    dialect: getDialect(params.backend.dialect),
    schema:
      params.schema ??
      (params.backend.tableNames ?
        createSqlSchema(params.backend.tableNames)
      : createSqlSchema()),
    defaultTemporalMode: params.defaultTemporalMode,
  };

  return {
    shortestPath(from, to, options) {
      return executeShortestPath(
        ctx,
        resolveNodeId(from),
        resolveNodeId(to),
        options,
      );
    },
    reachable(from, options) {
      return executeReachable(ctx, resolveNodeId(from), options);
    },
    canReach(from, to, options) {
      return executeCanReach(
        ctx,
        resolveNodeId(from),
        resolveNodeId(to),
        options,
      );
    },
    neighbors(node, options) {
      return executeNeighbors(ctx, resolveNodeId(node), options);
    },
    degree(node, options) {
      return executeDegree(ctx, resolveNodeId(node), options ?? {});
    },
  };
}

export type {
  AlgorithmCyclePolicy,
  BaseTraversalOptions,
  DegreeOptions,
  NeighborsOptions,
  PathNode,
  ReachableNode,
  ReachableOptions,
  ShortestPathOptions,
  ShortestPathResult,
  TemporalAlgorithmOptions,
  TraversalDirection,
} from "./types";
