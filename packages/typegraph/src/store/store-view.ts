/**
 * StoreView — a read-only `(mode, asOf)` lens over a {@link Store}.
 *
 * A `StoreView` pins a temporal coordinate and routes every supported
 * read through it, mirroring Datomic's `(d/as-of db t)` database value
 * and SQL:2011 `FOR SYSTEM_TIME AS OF`. It is *read-only by
 * construction*: mutating "the graph as of last Tuesday" is incoherent,
 * so writes stay on the live `Store`.
 *
 * The view is an explicit read context, not a single default flip — the
 * temporal seam is not uniform across surfaces (the query builder
 * hardcodes `"current"`, `subgraph` reads `graph.defaults` directly,
 * collections apply a per-call default). The view therefore injects its
 * pinned {@link ReadCoordinate} into each surface it hands out through one
 * helper ({@link withCoordinate}), so a future temporal axis (recorded
 * time) lands on every surface at once instead of splitting by surface.
 *
 * Built on the public `Store` surface (plus one internal sealed-query
 * seam), so it composes the same reads `branch()` / `merge()` consume.
 */
import {
  type AllNodeTypes,
  type EdgeKinds,
  type GraphDef,
  type NodeKinds,
} from "../core/define-graph";
import {
  coordinateContext,
  describeCoordinate,
  type ReadCoordinate,
  resolveReadCoordinate,
} from "../core/temporal";
import {
  type AnyEdgeType,
  type NodeId,
  type NodeType,
  type TemporalMode,
} from "../core/types";
import { ConfigurationError } from "../errors";
import { type QueryBuilder } from "../query/builder";
import {
  type BaseTraversalOptions,
  type DegreeOptions,
  type NeighborsOptions,
  type NodeIdentifier,
  type ReachableNode,
  type ReachableOptions,
  type ShortestPathOptions,
  type ShortestPathResult,
  type TemporalAlgorithmOptions,
} from "./algorithms";
import { withCoordinate } from "./collections/temporal-read-params";
import { type StoreSearch } from "./search-facade";
import { type Store } from "./store";
import {
  type SubgraphOptions,
  type SubgraphProject,
  type SubgraphResult,
} from "./subgraph";
import {
  CURRENT_ONLY_READ_NAMES,
  type EdgeCollection,
  type NodeCollection,
  type NodeCurrentReads,
  type StoreViewEdgeCollection,
  type StoreViewEdgeCollections,
  type StoreViewNodeCollection,
  type StoreViewNodeCollections,
} from "./types";

// ============================================================
// Public coordinate + view-scoped option types
// ============================================================

/**
 * The temporal coordinate a {@link StoreView} pins. A discriminated union on
 * `mode`: `asOf` is *required* for `"asOf"` and *rejected* (`never`) for every
 * other mode, so the type mirrors the runtime contract. `view({ mode: "asOf" })`
 * (missing timestamp) and `view({ mode: "current", asOf })` (pinning an instant
 * outside `"asOf"`) are both compile errors, not merely runtime
 * `ValidationError`s.
 */
export type StoreViewCoordinate =
  | Readonly<{ mode: "asOf"; asOf: string }>
  | Readonly<{ mode: Exclude<TemporalMode, "asOf">; asOf?: never }>;

/**
 * {@link Store.subgraph} options with the temporal axis removed — the
 * view's pinned coordinate supplies it.
 */
export type StoreViewSubgraphOptions<
  G extends GraphDef,
  EK extends EdgeKinds<G>,
  NK extends NodeKinds<G>,
  P extends SubgraphProject<G, NK, EK> | undefined = undefined,
> = Omit<SubgraphOptions<G, EK, NK, P>, "temporalMode" | "asOf">;

/** `reachable` options with the temporal axis removed (the pin supplies it). */
export type StoreViewReachableOptions<G extends GraphDef> = Omit<
  ReachableOptions<G>,
  keyof TemporalAlgorithmOptions
>;

/** `shortestPath` options with the temporal axis removed (the pin supplies it). */
export type StoreViewShortestPathOptions<G extends GraphDef> = Omit<
  ShortestPathOptions<G>,
  keyof TemporalAlgorithmOptions
>;

/** `canReach` options with the temporal axis removed (the pin supplies it). */
export type StoreViewCanReachOptions<G extends GraphDef> = Omit<
  BaseTraversalOptions<G>,
  keyof TemporalAlgorithmOptions
>;

/** `neighbors` options with the temporal axis removed (the pin supplies it). */
export type StoreViewNeighborsOptions<G extends GraphDef> = Omit<
  NeighborsOptions<G>,
  keyof TemporalAlgorithmOptions
>;

/** `degree` options with the temporal axis removed (the pin supplies it). */
export type StoreViewDegreeOptions<G extends GraphDef> = Omit<
  DegreeOptions<G>,
  keyof TemporalAlgorithmOptions
>;

// ============================================================
// Read-only collection wrapping
// ============================================================

/**
 * Property keys that look like member access but are JS / Promise interop
 * probes, not graph kinds or collection methods. Resolving them to
 * `undefined` keeps `view.nodes` / `view.edges` (and the refusing search
 * facade) from being mistaken for a thenable when accidentally awaited,
 * and keeps inspection / serialization from tripping the unknown-kind
 * guard.
 */
const NON_KIND_KEYS: ReadonlySet<string> = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
]);

/**
 * Returns a function that refuses a write or unsupported-read method on a
 * read-only view with a descriptive error, rather than silently ignoring
 * the pin or failing with an opaque `undefined is not a function`.
 */
function createReadOnlyRefusal(
  entity: "node" | "edge",
  method: string,
  coordinate: ReadCoordinate,
): () => never {
  return () => {
    throw new ConfigurationError(
      `'${method}' is not available on a read-only StoreView (${describeCoordinate(coordinate)}). ` +
        `A time-pinned view is a read perspective — perform writes on the live Store.`,
      {
        code: "STORE_VIEW_READ_ONLY",
        entity,
        method,
        ...coordinateContext(coordinate),
      },
    );
  };
}

/**
 * Returns a function that refuses a current-state-only read (constraint /
 * index / endpoint lookup) on a *temporal* view via Promise rejection. Such
 * reads have no temporal axis — they always reflect current state — so on a
 * non-`current` pin they would silently lie. On a `current` view they are
 * delegated straight to the live collection instead of refused.
 */
function createCurrentOnlyRefusal(
  entity: "node" | "edge",
  method: string,
  coordinate: ReadCoordinate,
): () => Promise<never> {
  return () =>
    Promise.reject(
      new ConfigurationError(
        `'${method}' is not available on a StoreView (${describeCoordinate(coordinate)}). ` +
          `Constraint / index / endpoint lookups read current state only and ` +
          `cannot honor a temporal coordinate — use a current-mode view or the live Store.`,
        {
          code: "STORE_VIEW_CURRENT_ONLY",
          entity,
          method,
          ...coordinateContext(coordinate),
        },
      ),
    );
}

/**
 * Current-state-only collection reads: they take no temporal coordinate, so
 * the view delegates them on a `current` pin and refuses them on a temporal
 * pin rather than silently returning current data. Derived from the same
 * {@link CURRENT_ONLY_READ_NAMES} array that defines the `NodeCurrentReads`
 * type, so the runtime routing decision cannot drift from the type partition.
 */
const CURRENT_ONLY_READS: ReadonlySet<string> = new Set(
  CURRENT_ONLY_READ_NAMES,
);

/**
 * Wraps a `reads` object so its supported reads pass through while any
 * other method that exists on the live collection refuses. Writes refuse
 * synchronously ({@link createReadOnlyRefusal}); current-state-only reads
 * refuse via Promise rejection on a temporal pin but are delegated to the
 * live collection on a `current` view ({@link CURRENT_ONLY_READS}).
 *
 * The supported set is exactly `reads`' own keys, so it can never drift
 * from the methods actually implemented. The target is frozen and the
 * `set` / `defineProperty` / `deleteProperty` traps reject, so the view is
 * read-only by construction at runtime, not only at the type level.
 * `Object.hasOwn` — not `in` — so inherited `Object.prototype` members
 * (`toString`, `valueOf`, …) pass straight through and coercion / logging
 * of a view collection still works.
 */
function readOnlyCollectionProxy<T extends object>(
  reads: T,
  live: object,
  coordinate: ReadCoordinate,
  entity: "node" | "edge",
): T {
  const isCurrent = coordinate.valid.mode === "current";
  const target = Object.freeze(reads) as T;
  return new Proxy(target, {
    get(target, property, receiver) {
      if (
        typeof property === "string" &&
        !Object.hasOwn(target, property) &&
        Object.hasOwn(live, property)
      ) {
        if (CURRENT_ONLY_READS.has(property)) {
          return isCurrent ?
              (live as Record<string, unknown>)[property]
            : createCurrentOnlyRefusal(entity, property, coordinate);
        }
        return createReadOnlyRefusal(entity, property, coordinate);
      }
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      // Mirror `get`: a property is "present" if the proxy resolves a value for
      // it — the pinned reads (own keys of target), any live-collection method
      // (delegated or refused), or an inherited Object.prototype member. Keeps
      // `"method" in view.collection` consistent with property access.
      return (
        (typeof property === "string" && Object.hasOwn(live, property)) ||
        Reflect.has(target, property)
      );
    },
    set() {
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  });
}

function pinnedNodeCollection(
  live: NodeCollection<NodeType, string>,
  coordinate: ReadCoordinate,
): StoreViewNodeCollection<NodeType> {
  const temporal = withCoordinate(coordinate);
  // Only the temporal reads live in the literal; the proxy serves the
  // current-only reads (delegate on a `current` pin, refuse on a temporal pin).
  const reads: Omit<
    StoreViewNodeCollection<NodeType>,
    keyof NodeCurrentReads<NodeType>
  > = {
    getById: (id) => live.getById(id, temporal),
    getByIds: (ids) => live.getByIds(ids, temporal),
    // `live.find` is the NodeCollection read, not Array#find — the
    // (filter, temporal) shape trips the array-method heuristics.
    // eslint-disable-next-line unicorn/no-array-callback-reference, unicorn/no-array-method-this-argument
    find: (filter) => live.find(filter, temporal),
    count: () => live.count(temporal),
  };
  return readOnlyCollectionProxy(
    reads,
    live,
    coordinate,
    "node",
  ) as StoreViewNodeCollection<NodeType>;
}

function pinnedEdgeCollection(
  live: EdgeCollection<AnyEdgeType, NodeType, NodeType>,
  coordinate: ReadCoordinate,
): StoreViewEdgeCollection<AnyEdgeType, NodeType, NodeType> {
  const temporal = withCoordinate(coordinate);
  const reads: StoreViewEdgeCollection<AnyEdgeType, NodeType, NodeType> = {
    getById: (id) => live.getById(id, temporal),
    getByIds: (ids) => live.getByIds(ids, temporal),
    // `live.find` is the EdgeCollection read, not Array#find — the
    // (filter, temporal) shape trips the array-method heuristics.
    // eslint-disable-next-line unicorn/no-array-callback-reference, unicorn/no-array-method-this-argument
    find: (filter) => live.find(filter, temporal),
    count: (filter) => live.count(filter, temporal),
    findFrom: (from) => live.findFrom(from, temporal),
    findTo: (to) => live.findTo(to, temporal),
    findByEndpoints: (from, to, options) =>
      live.findByEndpoints(from, to, options, temporal),
  };
  return readOnlyCollectionProxy(reads, live, coordinate, "edge");
}

/**
 * Builds the lazy, per-kind caching proxy that fronts the pinned
 * collections. Shared by `nodes` and `edges`: indexing the live proxy
 * throws `KindNotFoundError` for an unknown kind, so the view refuses an
 * unknown kind the same way the live store does — while interop probes
 * ({@link NON_KIND_KEYS}) resolve to `undefined`.
 */
function pinnedCollections<L, W>(
  live: object,
  coordinate: ReadCoordinate,
  wrap: (liveCollection: L, coordinate: ReadCoordinate) => W,
): Record<string, W> {
  const cache = new Map<string, W>();
  return new Proxy(
    {},
    {
      get(_target, kind) {
        if (typeof kind !== "string" || NON_KIND_KEYS.has(kind)) return;
        const cached = cache.get(kind);
        if (cached !== undefined) return cached;
        const wrapped = wrap((live as Record<string, L>)[kind]!, coordinate);
        cache.set(kind, wrapped);
        return wrapped;
      },
    },
  );
}

// ============================================================
// Read-only search facade
// ============================================================

/**
 * The non-mutating read methods of {@link StoreSearch}. The `satisfies`
 * constraint binds each name to a real `StoreSearch` member, so a rename or
 * removal of one of these methods is a compile error here rather than a silent
 * routing gap. (Completeness for a *newly added* read method would need a
 * StoreSearch read/write type split, mirroring the node collection's — tracked
 * separately.)
 */
const READ_SEARCH_METHOD_NAMES = [
  "fulltext",
  "vector",
  "hybrid",
] as const satisfies readonly (keyof StoreSearch<GraphDef>)[];
const READ_SEARCH_METHODS: ReadonlySet<string> = new Set(
  READ_SEARCH_METHOD_NAMES,
);

/**
 * Builds the error a refused search method rejects with. A `current` view
 * still refuses the mutating maintenance op (`rebuildFulltext`) because the
 * view is read-only; a non-`current` view refuses *all* search because the
 * fulltext / vector index reflects current state only and historical
 * relevance is out of scope.
 */
function searchRefusal(
  method: string,
  coordinate: ReadCoordinate,
  isCurrent: boolean,
): ConfigurationError {
  return isCurrent ?
      new ConfigurationError(
        `store.search.${method} is a maintenance write and is not available on a ` +
          `read-only StoreView. Run it on the live Store.`,
        {
          code: "STORE_VIEW_READ_ONLY",
          method,
          ...coordinateContext(coordinate),
        },
      )
    : new ConfigurationError(
        `store.search.${method} is not available on a StoreView (${describeCoordinate(coordinate)}). ` +
          `The fulltext / vector index reflects current state only; historical ` +
          `relevance is out of scope for a temporal view. Use a current-mode ` +
          `view or query the live Store.`,
        {
          code: "STORE_VIEW_SEARCH_UNSUPPORTED",
          method,
          ...coordinateContext(coordinate),
        },
      );
}

/**
 * The view's search facade. On a `current` view the read methods
 * (`fulltext` / `vector` / `hybrid`) delegate to the live `store.search`;
 * every other case refuses via Promise rejection — `rebuildFulltext` (a
 * maintenance write) on any view, and *all* search on a non-`current`
 * view. A Proxy (not a fixed literal) so a future `StoreSearch` method is
 * refused, not silently passed through, on a temporal view.
 */
function pinnedSearch<G extends GraphDef>(
  store: Store<G>,
  coordinate: ReadCoordinate,
): StoreSearch<G> {
  const isCurrent = coordinate.valid.mode === "current";
  const live =
    isCurrent ?
      (store.search as unknown as Record<
        string,
        (...args: readonly unknown[]) => unknown
      >)
    : undefined;
  return new Proxy({} as StoreSearch<G>, {
    get(target, method, receiver) {
      // Interop probes must resolve to `undefined` so the facade is not
      // mistaken for a thenable.
      if (typeof method !== "string" || NON_KIND_KEYS.has(method)) {
        return;
      }
      // Inherited Object.prototype members (toString / valueOf / …) pass
      // through so coercion / logging of the facade stays safe.
      if (Object.hasOwn(Object.prototype, method)) {
        const inheritedValue: unknown = Reflect.get(target, method, receiver);
        return inheritedValue;
      }
      if (live !== undefined && READ_SEARCH_METHODS.has(method)) {
        return (...args: readonly unknown[]) => live[method]!(...args);
      }
      return () => Promise.reject(searchRefusal(method, coordinate, isCurrent));
    },
  });
}

// ============================================================
// StoreView
// ============================================================

/**
 * A read-only `(mode, asOf)` lens over a {@link Store}. Construct one via
 * {@link Store.asOf} (valid-time) or {@link Store.view} (any public
 * mode), never directly.
 *
 * @example
 * ```typescript
 * const past = store.asOf("2026-01-01T00:00:00.000Z");
 * const alice = await past.nodes.Person.getById(aliceId);
 * const jobs = await past.edges.worksAt.findFrom(alice!);
 * const reach = await past.reachable(alice!, { edges: ["knows"] });
 * ```
 */
export class StoreView<G extends GraphDef> {
  readonly #store: Store<G>;
  readonly #coordinate: ReadCoordinate;
  #nodes: StoreViewNodeCollections<G> | undefined;
  #edges: StoreViewEdgeCollections<G> | undefined;
  #search: StoreSearch<G> | undefined;

  constructor(store: Store<G>, coordinate: StoreViewCoordinate) {
    this.#store = store;
    this.#coordinate = resolveReadCoordinate(
      coordinate.mode,
      coordinate.asOf,
      'Use store.asOf("2026-01-01T00:00:00.000Z") or store.view({ mode: "asOf", asOf }).',
    );
  }

  /** The temporal mode this view reads in. */
  get mode(): TemporalMode {
    return this.#coordinate.valid.mode;
  }

  /** The pinned `asOf` timestamp, or `undefined` for non-`asOf` modes. */
  get asOf(): string | undefined {
    return this.#coordinate.valid.asOf;
  }

  /** Read-only node collections pinned to this view's coordinate. */
  get nodes(): StoreViewNodeCollections<G> {
    this.#nodes ??= pinnedCollections(
      this.#store.nodes,
      this.#coordinate,
      pinnedNodeCollection,
    ) as unknown as StoreViewNodeCollections<G>;
    return this.#nodes;
  }

  /** Read-only edge collections pinned to this view's coordinate. */
  get edges(): StoreViewEdgeCollections<G> {
    this.#edges ??= pinnedCollections(
      this.#store.edges,
      this.#coordinate,
      pinnedEdgeCollection,
    ) as unknown as StoreViewEdgeCollections<G>;
    return this.#edges;
  }

  /**
   * A query builder pinned to this view's coordinate. The temporal axis is
   * sealed: calling `.temporal(...)` on the returned builder throws, so the
   * view's coordinate cannot be overridden on a per-query basis.
   */
  query(): QueryBuilder<G> {
    return this.#store.sealedQuery(this.#coordinate);
  }

  /** Extracts a subgraph at this view's pinned coordinate. */
  subgraph<
    const EK extends EdgeKinds<G>,
    const NK extends NodeKinds<G> = NodeKinds<G>,
    const P extends SubgraphProject<G, NK, EK> | undefined = undefined,
  >(
    rootId: NodeId<AllNodeTypes<G>>,
    options: StoreViewSubgraphOptions<G, EK, NK, P>,
  ): Promise<SubgraphResult<G, NK, EK, P>> {
    return this.#store.subgraph(rootId, {
      ...options,
      ...withCoordinate(this.#coordinate),
    });
  }

  /** Shortest path between two nodes at this view's pinned coordinate. */
  shortestPath(
    from: NodeIdentifier,
    to: NodeIdentifier,
    options: StoreViewShortestPathOptions<G>,
  ): Promise<ShortestPathResult | undefined> {
    return this.#store.algorithms.shortestPath(from, to, {
      ...options,
      ...withCoordinate(this.#coordinate),
    });
  }

  /** Nodes reachable from `from` at this view's pinned coordinate. */
  reachable(
    from: NodeIdentifier,
    options: StoreViewReachableOptions<G>,
  ): Promise<readonly ReachableNode[]> {
    return this.#store.algorithms.reachable(from, {
      ...options,
      ...withCoordinate(this.#coordinate),
    });
  }

  /** Whether `to` is reachable from `from` at this view's pinned coordinate. */
  canReach(
    from: NodeIdentifier,
    to: NodeIdentifier,
    options: StoreViewCanReachOptions<G>,
  ): Promise<boolean> {
    return this.#store.algorithms.canReach(from, to, {
      ...options,
      ...withCoordinate(this.#coordinate),
    });
  }

  /** The k-hop neighborhood of `node` at this view's pinned coordinate. */
  neighbors(
    node: NodeIdentifier,
    options: StoreViewNeighborsOptions<G>,
  ): Promise<readonly ReachableNode[]> {
    return this.#store.algorithms.neighbors(node, {
      ...options,
      ...withCoordinate(this.#coordinate),
    });
  }

  /** Counts active edges incident to `node` at this view's pinned coordinate. */
  degree(
    node: NodeIdentifier,
    options?: StoreViewDegreeOptions<G>,
  ): Promise<number> {
    return this.#store.algorithms.degree(node, {
      ...options,
      ...withCoordinate(this.#coordinate),
    });
  }

  /**
   * Read-only search facade. On a `current` view the read methods
   * (`fulltext` / `vector` / `hybrid`) delegate to the live `store.search`,
   * while the mutating `rebuildFulltext` is refused — the view is read-only.
   * On any non-`current` pin every search method refuses: the fulltext /
   * vector index reflects current state only, so historical relevance is
   * out of scope.
   */
  get search(): StoreSearch<G> {
    this.#search ??= pinnedSearch<G>(this.#store, this.#coordinate);
    return this.#search;
  }
}
