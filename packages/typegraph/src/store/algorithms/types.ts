/**
 * Shared types for Tier 1 graph algorithms.
 *
 * Algorithms operate over one or more edge kinds and may traverse edges
 * in the forward direction ("out"), reverse ("in"), or undirected ("both").
 */
import type { EdgeKinds, GraphDef, NodeKinds } from "../../core/define-graph";
import type { RecordedInstant } from "../../core/temporal";
import type { TemporalMode } from "../../core/types";
import type { RecursiveCyclePolicy } from "../../query/ast";
import type { NoRecordedCoordinate } from "../types";

/**
 * Direction of edge traversal.
 *
 * - `"out"` — follow edges from source to target (default)
 * - `"in"` — follow edges from target back to source
 * - `"both"` — undirected traversal over either endpoint
 */
export type TraversalDirection = "out" | "in" | "both";

/**
 * Cycle-handling option retained for compatibility with recursive query-builder
 * traversals. Store algorithms are set-based and visit each node once at its
 * minimum depth, so `"prevent"` and `"allow"` produce the same algorithm
 * result. Aliased to `RecursiveCyclePolicy` so both APIs share one union.
 */
export type AlgorithmCyclePolicy = RecursiveCyclePolicy;

/**
 * Temporal filter options shared by every algorithm.
 *
 * Algorithms honor the same temporal model as the rest of the store: both
 * nodes and edges are filtered according to the resolved mode. `asOf` is
 * required when the resolved mode is `"asOf"` and rejected for every other
 * mode. If neither option is supplied, the algorithm falls back to
 * `graph.defaults.temporalMode`.
 */
export type TemporalAlgorithmOptions = NoRecordedCoordinate &
  Readonly<{
    /** Temporal mode. Defaults to the graph's configured default. */
    temporalMode?: TemporalMode;
    /**
     * ISO-8601 timestamp pinning the read. Required when `temporalMode` is
     * `"asOf"`; rejected (throws `ValidationError`) for every other mode.
     */
    asOf?: string;
  }>;

export type InternalTemporalAlgorithmOptions = Omit<
  TemporalAlgorithmOptions,
  "recordedAsOf"
> &
  Readonly<{ recordedAsOf?: RecordedInstant }>;

/**
 * Transaction-scoped memory budget for iterative graph rounds.
 *
 * Applies to backends with a per-operation memory setting (PostgreSQL
 * `work_mem`, applied via `SET LOCAL` semantics inside the operation's own
 * transaction — the session and server settings are never modified). SQLite
 * has no equivalent setting and ignores the option. The value must be a
 * plain integer with a `kB`, `MB`, or `GB` suffix; defaults to `"64MB"`.
 */
export type IterativeMemoryOptions = Readonly<{
  /** Per-operation round memory budget, e.g. `"64MB"` (the default). */
  workingMemory?: string;
}>;

/**
 * Base options for traversal-style algorithms.
 */
export type BaseTraversalOptions<G extends GraphDef> =
  TemporalAlgorithmOptions &
    IterativeMemoryOptions &
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
      /** Compatibility option; set-based algorithms always visit a node once. */
      cyclePolicy?: AlgorithmCyclePolicy;
    }>;

export type InternalBaseTraversalOptions<G extends GraphDef> =
  InternalTemporalAlgorithmOptions &
    Omit<BaseTraversalOptions<G>, keyof TemporalAlgorithmOptions>;

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

export type InternalShortestPathOptions<G extends GraphDef> =
  InternalBaseTraversalOptions<G>;

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

export type InternalReachableOptions<G extends GraphDef> =
  InternalBaseTraversalOptions<G> &
    Omit<ReachableOptions<G>, keyof BaseTraversalOptions<G>>;

/**
 * Options for `neighbors`.
 *
 * Like `reachable`, but the parameter is named `depth` for readability —
 * "2-hop neighbors" reads more naturally than "reachable with maxHops=2".
 * The source is always excluded.
 */
export type NeighborsOptions<G extends GraphDef> = TemporalAlgorithmOptions &
  IterativeMemoryOptions &
  Readonly<{
    /** Edge kinds to follow. At least one kind is required. */
    edges: readonly EdgeKinds<G>[];
    /** Maximum neighborhood depth (default: 1). Must be between 1 and 1000. */
    depth?: number;
    /** Direction of traversal (default: `"out"`). */
    direction?: TraversalDirection;
    /** Compatibility option; set-based algorithms always visit a node once. */
    cyclePolicy?: AlgorithmCyclePolicy;
  }>;

export type InternalNeighborsOptions<G extends GraphDef> =
  InternalTemporalAlgorithmOptions &
    Omit<NeighborsOptions<G>, keyof TemporalAlgorithmOptions>;

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

export type InternalDegreeOptions<G extends GraphDef> =
  InternalTemporalAlgorithmOptions &
    Omit<DegreeOptions<G>, keyof TemporalAlgorithmOptions>;

/**
 * Options for exact weakly connected components.
 *
 * Selected edges are treated as undirected, regardless of their declared
 * direction. By default every visible graph node is returned; `nodeKinds`
 * restricts the operation to the induced subgraph over those kinds. Nodes in
 * scope with no selected incident edge form singleton components.
 */
export type WeaklyConnectedComponentsOptions<G extends GraphDef> =
  TemporalAlgorithmOptions &
    IterativeMemoryOptions &
    Readonly<{
      /** Edge kinds whose undirected projection defines connectivity. */
      edges: readonly EdgeKinds<G>[];
      /** Optional node kinds defining the induced subgraph to analyze. */
      nodeKinds?: readonly NodeKinds<G>[];
      /** Maximum label-propagation rounds before throwing. Defaults to 1000. */
      maxIterations?: number;
    }>;

export type InternalWeaklyConnectedComponentsOptions<G extends GraphDef> =
  InternalTemporalAlgorithmOptions &
    Omit<WeaklyConnectedComponentsOptions<G>, keyof TemporalAlgorithmOptions>;

/** One node's membership in an exact weakly connected component. */
export type WeaklyConnectedComponentMembership = Readonly<{
  id: string;
  kind: string;
  /** Deterministic minimum node id in this component. */
  componentId: string;
  /** Kind paired with `componentId`; node identity is `(kind, id)`. */
  componentKind: string;
  /** Number of visible nodes in this component. */
  size: number;
}>;
