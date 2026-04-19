/**
 * Shared types for Tier 1 graph algorithms.
 *
 * Algorithms operate over one or more edge kinds and may traverse edges
 * in the forward direction ("out"), reverse ("in"), or undirected ("both").
 */
import type { EdgeKinds, GraphDef } from "../../core/define-graph";
import type { TemporalMode } from "../../core/types";
import type { RecursiveCyclePolicy } from "../../query/ast";

/**
 * Direction of edge traversal.
 *
 * - `"out"` — follow edges from source to target (default)
 * - `"in"` — follow edges from target back to source
 * - `"both"` — undirected traversal over either endpoint
 */
export type TraversalDirection = "out" | "in" | "both";

/**
 * Cycle-handling strategy during recursive traversal.
 *
 * - `"prevent"` — skip any node already on the current path (default).
 *   Guarantees termination even in cyclic graphs.
 * - `"allow"` — permit revisiting nodes. Only safe with a bounded `maxHops`.
 *
 * Aliased to `RecursiveCyclePolicy` so algorithms and query-builder traversals
 * share a single canonical union.
 */
export type AlgorithmCyclePolicy = RecursiveCyclePolicy;

/**
 * Temporal filter options shared by every algorithm.
 *
 * Algorithms honor the same temporal model as the rest of the store: both
 * nodes and edges are filtered according to the resolved mode. `asOf` is
 * only consulted when the resolved mode is `"asOf"`. If neither option is
 * supplied, the algorithm falls back to `graph.defaults.temporalMode`.
 */
export type TemporalAlgorithmOptions = Readonly<{
  /** Temporal mode. Defaults to the graph's configured default. */
  temporalMode?: TemporalMode;
  /**
   * ISO-8601 timestamp used when `temporalMode` is `"asOf"`. Required in that
   * mode; ignored in all others.
   */
  asOf?: string;
}>;

/**
 * Base options for traversal-style algorithms.
 */
export type BaseTraversalOptions<G extends GraphDef> =
  TemporalAlgorithmOptions &
    Readonly<{
      /** Edge kinds to follow. At least one kind is required. */
      edges: readonly EdgeKinds<G>[];
      /**
       * Maximum number of hops to traverse. Defaults to 10.
       * Must be between 1 and 1000.
       */
      maxHops?: number;
      /** Direction of traversal (default: `"out"`). */
      direction?: TraversalDirection;
      /** Cycle policy (default: `"prevent"`). */
      cyclePolicy?: AlgorithmCyclePolicy;
    }>;

/**
 * A node reached during traversal, annotated with the shortest depth at which
 * it was first discovered.
 */
export type ReachableNode = Readonly<{
  id: string;
  kind: string;
  /** Number of edges traversed from the source. 0 for the source itself. */
  depth: number;
}>;

/**
 * A node along a shortest path. Endpoints are included.
 */
export type PathNode = Readonly<{
  id: string;
  kind: string;
}>;

/**
 * Result of `shortestPath`: the ordered node sequence and its length in hops.
 */
export type ShortestPathResult = Readonly<{
  /** Ordered nodes from source to target (inclusive). */
  nodes: readonly PathNode[];
  /** Number of edges traversed. Equals `nodes.length - 1`. */
  depth: number;
}>;

/**
 * Options for `shortestPath` and `canReach`. Reuses the base traversal
 * options; cycle policy defaults to `"prevent"` since both algorithms only
 * care about the first time a target is reached.
 */
export type ShortestPathOptions<G extends GraphDef> = BaseTraversalOptions<G>;

/**
 * Options for `reachable`.
 *
 * Returns every node reachable from the source within `maxHops`, each
 * annotated with its minimum discovered depth. `depth: 0` refers to the
 * source itself and is included unless `excludeSource` is `true`.
 */
export type ReachableOptions<G extends GraphDef> = BaseTraversalOptions<G> &
  Readonly<{
    /** Exclude the source node from the result set (default: `false`). */
    excludeSource?: boolean;
  }>;

/**
 * Options for `neighbors`.
 *
 * Like `reachable`, but the parameter is named `depth` for readability —
 * "2-hop neighbors" reads more naturally than "reachable with maxHops=2".
 * The source is always excluded.
 */
export type NeighborsOptions<G extends GraphDef> = TemporalAlgorithmOptions &
  Readonly<{
    /** Edge kinds to follow. At least one kind is required. */
    edges: readonly EdgeKinds<G>[];
    /** Maximum neighborhood depth (default: 1). Must be between 1 and 1000. */
    depth?: number;
    /** Direction of traversal (default: `"out"`). */
    direction?: TraversalDirection;
    /** Cycle policy (default: `"prevent"`). */
    cyclePolicy?: AlgorithmCyclePolicy;
  }>;

/**
 * Options for `degree`.
 *
 * Counts active edges incident to a node. With `direction: "both"`, an edge
 * that happens to be a self-loop (from === to) is counted once, not twice.
 */
export type DegreeOptions<G extends GraphDef> = TemporalAlgorithmOptions &
  Readonly<{
    /**
     * Edge kinds to count. If omitted, counts across all edge kinds in the
     * graph.
     */
    edges?: readonly EdgeKinds<G>[];
    /** Direction (default: `"both"`). */
    direction?: TraversalDirection;
  }>;
