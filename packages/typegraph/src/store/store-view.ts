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
  type RecordedInstant,
  resolveReadCoordinate,
  withRecordedCoordinate,
} from "../core/temporal";
import {
  type AnyEdgeType,
  type NodeId,
  type NodeType,
  type TemporalMode,
} from "../core/types";
import { ConfigurationError } from "../errors";
import { type InitialQueryBuilder } from "../query/builder";
import {
  type BaseTraversalOptions,
  type DegreeOptions,
  type InternalGraphAlgorithms,
  type NeighborsOptions,
  type NodeIdentifier,
  type PageRankOptions,
  type PageRankScore,
  type PersonalizedPageRankOptions,
  type ReachableNode,
  type ReachableOptions,
  type ShortestPathOptions,
  type ShortestPathResult,
  type TemporalAlgorithmOptions,
  type WeaklyConnectedComponentMembership,
  type WeaklyConnectedComponentsOptions,
  type WeightedShortestPathOptions,
  type WeightedShortestPathResult,
} from "./algorithms";
import {
  CURRENT_ONLY_READ_NAMES,
  EDGE_BATCH_READ_NAMES,
  type EDGE_TEMPORAL_READ_NAMES,
  type NODE_TEMPORAL_READ_NAMES,
  type RECORDED_POINT_READ_NAMES,
} from "./collection-surface";
import {
  withCoordinate,
  withValidCoordinate,
} from "./collections/temporal-read-params";
import { type StoreSearch } from "./search-facade";
import { type Store } from "./store";
import {
  type InternalSubgraphOptions,
  type SubgraphOptions,
  type SubgraphProject,
  type SubgraphResult,
} from "./subgraph";
import {
  type EdgeCollection,
  type NodeCollection,
  type NodeCurrentReads,
  type RecordedStoreViewEdgeCollection,
  type RecordedStoreViewEdgeCollections,
  type RecordedStoreViewNodeCollection,
  type RecordedStoreViewNodeCollections,
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
> = Omit<
  SubgraphOptions<G, EK, NK, P>,
  "temporalMode" | "asOf" | "recordedAsOf"
>;

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

/**
 * `weightedShortestPath` options with the temporal axis removed (the pin
 * supplies it).
 */
export type StoreViewWeightedShortestPathOptions<G extends GraphDef> = Omit<
  WeightedShortestPathOptions<G>,
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

/** WCC options with the temporal axis removed (the view's pin supplies it). */
export type StoreViewWeaklyConnectedComponentsOptions<G extends GraphDef> =
  Omit<WeaklyConnectedComponentsOptions<G>, keyof TemporalAlgorithmOptions>;

/** PageRank options with the temporal axis removed (the view supplies it). */
export type StoreViewPageRankOptions<G extends GraphDef> = Omit<
  PageRankOptions<G>,
  keyof TemporalAlgorithmOptions
>;

/** Personalized PageRank options pinned to the view's temporal coordinate. */
export type StoreViewPersonalizedPageRankOptions<G extends GraphDef> = Omit<
  PersonalizedPageRankOptions<G>,
  keyof TemporalAlgorithmOptions
>;

/** Graph-algorithm facade sealed to a {@link StoreView}'s coordinate. */
export type StoreViewGraphAlgorithms<G extends GraphDef> = Readonly<{
  shortestPath: (
    from: NodeIdentifier,
    to: NodeIdentifier,
    options: StoreViewShortestPathOptions<G>,
  ) => Promise<ShortestPathResult | undefined>;
  weightedShortestPath: (
    from: NodeIdentifier,
    to: NodeIdentifier,
    options: StoreViewWeightedShortestPathOptions<G>,
  ) => Promise<WeightedShortestPathResult | undefined>;
  reachable: (
    from: NodeIdentifier,
    options: StoreViewReachableOptions<G>,
  ) => Promise<readonly ReachableNode[]>;
  canReach: (
    from: NodeIdentifier,
    to: NodeIdentifier,
    options: StoreViewCanReachOptions<G>,
  ) => Promise<boolean>;
  neighbors: (
    node: NodeIdentifier,
    options: StoreViewNeighborsOptions<G>,
  ) => Promise<readonly ReachableNode[]>;
  degree: (
    node: NodeIdentifier,
    options?: StoreViewDegreeOptions<G>,
  ) => Promise<number>;
  weaklyConnectedComponents: (
    options: StoreViewWeaklyConnectedComponentsOptions<G>,
  ) => Promise<readonly WeaklyConnectedComponentMembership[]>;
  pageRank: (
    options: StoreViewPageRankOptions<G>,
  ) => Promise<readonly PageRankScore[]>;
  personalizedPageRank: (
    options: StoreViewPersonalizedPageRankOptions<G>,
  ) => Promise<readonly PageRankScore[]>;
}>;

function isReadCoordinate(
  coordinate: StoreViewCoordinate | ReadCoordinate,
): coordinate is ReadCoordinate {
  return "valid" in coordinate;
}

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
 * Returns a function that refuses a deferred edge batch read
 * ({@link EDGE_BATCH_READ_NAMES}) on a read-only view. These reads are *reads*,
 * not writes, but they resolve through `store.batch(...)` — a DataLoader context
 * a view does not expose — so the view cannot honor them. The refusal is
 * synchronous because the live method returns a `BatchableQuery` synchronously
 * (it is invoked, not awaited), so a misuse fail-louds at the call site instead
 * of being routed through the write-refusal fallthrough and mislabeled a write.
 */
function createBatchReadRefusal(
  entity: "node" | "edge",
  method: string,
  coordinate: ReadCoordinate,
): () => never {
  return () => {
    throw new ConfigurationError(
      `'${method}' is not available on a read-only StoreView (${describeCoordinate(coordinate)}). ` +
        `Batch endpoint reads resolve through store.batch(...), which a view does not expose — ` +
        `use the live Store's batch loader, or the view's findFrom / findTo / findByEndpoints for single reads.`,
      {
        code: "STORE_VIEW_BATCH_UNAVAILABLE",
        entity,
        method,
        ...coordinateContext(coordinate),
      },
    );
  };
}

function createRecordedUnsupportedRefusal(
  entity: "node" | "edge",
  method: string,
  coordinate: ReadCoordinate,
): () => Promise<never> {
  return () =>
    Promise.reject(
      new ConfigurationError(
        `'${method}' is not available on a RecordedStoreView (${describeCoordinate(coordinate)}). ` +
          `Recorded-time reads are reconstructing reads; this view exposes only query, ` +
          `subgraph, graph algorithms, and point getById/getByIds collection reads.`,
        {
          code: "RECORDED_STORE_VIEW_UNSUPPORTED",
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
 * Deferred edge batch reads ({@link EDGE_BATCH_READ_NAMES}): refused on every
 * view (current or temporal) because they resolve through `store.batch(...)`,
 * which a view does not expose. Routed to {@link createBatchReadRefusal} so they
 * are categorized as reads rather than misrouted through the write fallthrough.
 */
const EDGE_BATCH_READS: ReadonlySet<string> = new Set(EDGE_BATCH_READ_NAMES);

/**
 * Wraps a `reads` object so its supported reads pass through while any other
 * method that exists on the live collection is handled by `resolveLiveOnly` —
 * the one piece that differs between the read-only (valid-time) and recorded
 * facades. The frozen target and the rejecting `set` / `defineProperty` /
 * `deleteProperty` traps make the view read-only by construction at runtime, and
 * `Object.hasOwn` — not `in` — lets inherited `Object.prototype` members
 * (`toString`, `valueOf`, …) pass straight through so coercion / logging works.
 */
function collectionReadProxy<T extends object>(
  reads: T,
  live: object,
  resolveLiveOnly: (property: string) => unknown,
): T {
  const target = Object.freeze(reads) as T;
  return new Proxy(target, {
    get(target, property, receiver) {
      if (
        typeof property === "string" &&
        !Object.hasOwn(target, property) &&
        Object.hasOwn(live, property)
      ) {
        return resolveLiveOnly(property);
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

/**
 * Read-only valid-time collection facade. Writes refuse synchronously
 * ({@link createReadOnlyRefusal}); current-state-only reads refuse via Promise
 * rejection on a temporal pin but are delegated to the live collection on a
 * `current` view ({@link CURRENT_ONLY_READS}).
 */
function readOnlyCollectionProxy<T extends object>(
  reads: T,
  live: object,
  coordinate: ReadCoordinate,
  entity: "node" | "edge",
): T {
  const isCurrent = coordinate.valid.mode === "current";
  return collectionReadProxy(reads, live, (property) => {
    if (CURRENT_ONLY_READS.has(property)) {
      return isCurrent ?
          (live as Record<string, unknown>)[property]
        : createCurrentOnlyRefusal(entity, property, coordinate);
    }
    if (EDGE_BATCH_READS.has(property)) {
      return createBatchReadRefusal(entity, property, coordinate);
    }
    return createReadOnlyRefusal(entity, property, coordinate);
  });
}

/**
 * Recorded-time collection facade: any live-collection method that is not a
 * supported reconstructing read refuses uniformly.
 */
function recordedCollectionProxy<T extends object>(
  reads: T,
  live: object,
  coordinate: ReadCoordinate,
  entity: "node" | "edge",
): T {
  return collectionReadProxy(reads, live, (property) => {
    if (EDGE_BATCH_READS.has(property)) {
      return createBatchReadRefusal(entity, property, coordinate);
    }
    return createRecordedUnsupportedRefusal(entity, property, coordinate);
  });
}

function pinnedNodeCollection(
  live: NodeCollection<NodeType, string>,
  coordinate: ReadCoordinate,
): StoreViewNodeCollection<NodeType> {
  const temporal = withValidCoordinate(coordinate);
  // Only the temporal reads live in the literal; the proxy serves the
  // current-only reads (delegate on a `current` pin, refuse on a temporal pin).
  const reads: Omit<
    StoreViewNodeCollection<NodeType>,
    keyof NodeCurrentReads<NodeType>
  > &
    Readonly<{
      [
        Method in (typeof NODE_TEMPORAL_READ_NAMES)[number]
      ]: StoreViewNodeCollection<NodeType>[Method];
    }> = {
    getById: (id) => live.getById(id, temporal),
    getByIds: (ids) => live.getByIds(ids, temporal),
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
  const temporal = withValidCoordinate(coordinate);
  const reads: StoreViewEdgeCollection<AnyEdgeType, NodeType, NodeType> &
    Readonly<{
      [
        Method in (typeof EDGE_TEMPORAL_READ_NAMES)[number]
      ]: StoreViewEdgeCollection<AnyEdgeType, NodeType, NodeType>[Method];
    }> = {
    getById: (id) => live.getById(id, temporal),
    getByIds: (ids) => live.getByIds(ids, temporal),
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
 * collections. Shared by the valid-time and recorded views' `nodes` and
 * `edges`: indexing the live proxy throws `KindNotFoundError` for an unknown
 * kind, so the view refuses an unknown kind the same way the live store does —
 * while interop probes ({@link NON_KIND_KEYS}) resolve to `undefined`. `wrap`
 * receives the resolved `kind` so the recorded view can route point reads
 * through the store's recorded seams.
 */
function pinnedCollections<L, W>(
  live: object,
  coordinate: ReadCoordinate,
  isKind: (kind: string) => boolean,
  wrap: (kind: string, liveCollection: L, coordinate: ReadCoordinate) => W,
): Record<string, W> {
  const cache = new Map<string, W>();
  return new Proxy(
    {},
    {
      get(target, kind, receiver) {
        if (typeof kind !== "string") return;
        if (!isKind(kind)) {
          if (NON_KIND_KEYS.has(kind)) return;
          if (Object.hasOwn(Object.prototype, kind)) {
            const inheritedValue: unknown = Reflect.get(target, kind, receiver);
            return inheritedValue;
          }
        }
        const cached = cache.get(kind);
        if (cached !== undefined) return cached;
        const wrapped = wrap(
          kind,
          (live as Record<string, L>)[kind]!,
          coordinate,
        );
        cache.set(kind, wrapped);
        return wrapped;
      },
    },
  );
}

function pinnedNodeCollectionsFor<G extends GraphDef, W>(
  store: Store<G>,
  coordinate: ReadCoordinate,
  wrap: (
    kind: string,
    live: NodeCollection<NodeType, string>,
    coordinate: ReadCoordinate,
  ) => W,
): Record<string, W> {
  return pinnedCollections(
    store.nodes,
    coordinate,
    (kind) => Object.hasOwn(store.graph.nodes, kind),
    wrap,
  );
}

function pinnedEdgeCollectionsFor<G extends GraphDef, W>(
  store: Store<G>,
  coordinate: ReadCoordinate,
  wrap: (
    kind: string,
    live: EdgeCollection<AnyEdgeType, NodeType, NodeType>,
    coordinate: ReadCoordinate,
  ) => W,
): Record<string, W> {
  return pinnedCollections(
    store.edges,
    coordinate,
    (kind) => Object.hasOwn(store.graph.edges, kind),
    wrap,
  );
}

function recordedNodeCollection<G extends GraphDef>(
  store: Store<G>,
  kind: string,
  live: NodeCollection<NodeType, string>,
  coordinate: ReadCoordinate,
): RecordedStoreViewNodeCollection<NodeType> {
  const reads: RecordedStoreViewNodeCollection<NodeType> &
    Readonly<{
      [
        Method in (typeof RECORDED_POINT_READ_NAMES)[number]
      ]: RecordedStoreViewNodeCollection<NodeType>[Method];
    }> = {
    getById: (id) => store.recordedNodeGetById(kind, id, coordinate),
    getByIds: (ids) => store.recordedNodeGetByIds(kind, ids, coordinate),
  };
  return recordedCollectionProxy(reads, live, coordinate, "node");
}

function recordedEdgeCollection<G extends GraphDef>(
  store: Store<G>,
  kind: string,
  live: EdgeCollection<AnyEdgeType, NodeType, NodeType>,
  coordinate: ReadCoordinate,
): RecordedStoreViewEdgeCollection<AnyEdgeType, NodeType, NodeType> {
  const reads: RecordedStoreViewEdgeCollection<
    AnyEdgeType,
    NodeType,
    NodeType
  > &
    Readonly<{
      [
        Method in (typeof RECORDED_POINT_READ_NAMES)[number]
      ]: RecordedStoreViewEdgeCollection<
        AnyEdgeType,
        NodeType,
        NodeType
      >[Method];
    }> = {
    getById: (id) => store.recordedEdgeGetById(kind, id, coordinate),
    getByIds: (ids) => store.recordedEdgeGetByIds(kind, ids, coordinate),
  };
  return recordedCollectionProxy(reads, live, coordinate, "edge");
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

type SearchInvocation = (...args: readonly unknown[]) => unknown;

function searchProxy<G extends GraphDef>(
  resolve: (method: string) => SearchInvocation | undefined,
): StoreSearch<G> {
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
      return resolve(method);
    },
    has(target, method) {
      if (typeof method !== "string") return Reflect.has(target, method);
      if (NON_KIND_KEYS.has(method)) return false;
      if (Object.hasOwn(Object.prototype, method)) return true;
      return resolve(method) !== undefined;
    },
  });
}

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
      (store.search as unknown as Record<string, SearchInvocation>)
    : undefined;
  return searchProxy<G>((method) => {
    if (live !== undefined && READ_SEARCH_METHODS.has(method)) {
      const liveMethod = live[method];
      if (liveMethod !== undefined) {
        return (...args: readonly unknown[]) =>
          Reflect.apply(liveMethod, live, args);
      }
    }
    return () => Promise.reject(searchRefusal(method, coordinate, isCurrent));
  });
}

/**
 * Builds the error a refused {@link RecordedStoreView} search method rejects
 * with. Unlike {@link searchRefusal}, the recorded view refuses search for
 * *every* method regardless of the composed valid-time mode, so there is no
 * `current` delegating branch.
 */
function recordedSearchRefusal(
  method: string,
  coordinate: ReadCoordinate,
): ConfigurationError {
  return new ConfigurationError(
    `store.search.${method} is not available on a RecordedStoreView (${describeCoordinate(coordinate)}). ` +
      `The fulltext / vector index reflects current state only and cannot answer a ` +
      `recorded-time query. Run search on the live Store.`,
    {
      code: "RECORDED_STORE_VIEW_SEARCH_UNSUPPORTED",
      method,
      ...coordinateContext(coordinate),
    },
  );
}

/**
 * The recorded view's search facade: every method refuses. It never delegates
 * to the live `store.search` even when the composed valid-time mode is
 * `current` — a recorded-time read reconstructs from the history relations,
 * while the fulltext / vector index reflects current state only, so serving a
 * live hit would be a silent lie. A Proxy (not a fixed literal) so a future
 * `StoreSearch` method refuses too instead of resolving to `undefined`.
 */
function recordedSearch<G extends GraphDef>(
  coordinate: ReadCoordinate,
): StoreSearch<G> {
  return searchProxy<G>(
    (method) => () => Promise.reject(recordedSearchRefusal(method, coordinate)),
  );
}

// ============================================================
// Coordinate-pinned view base
// ============================================================

/**
 * Shared base for the read-only views. Holds the pinned {@link ReadCoordinate}
 * and delegates the graph algorithms, `subgraph`, and `query` to the live store
 * with that coordinate flattened into each call. {@link StoreView} (valid-time)
 * and {@link RecordedStoreView} (recorded-time) extend it; only the surfaces
 * that genuinely differ — collections, search, and the coordinate-changing
 * helpers — live on the subclasses.
 */
abstract class CoordinatePinnedView<G extends GraphDef> {
  protected readonly store: Store<G>;
  protected readonly coordinate: ReadCoordinate;
  #algorithmFacade: StoreViewGraphAlgorithms<G> | undefined;
  #internalAlgorithms: InternalGraphAlgorithms<G> | undefined;

  constructor(store: Store<G>, coordinate: ReadCoordinate) {
    this.store = store;
    this.coordinate = coordinate;
  }

  /** The temporal mode this view reads in. */
  get mode(): TemporalMode {
    return this.coordinate.valid.mode;
  }

  /** The pinned valid-time `asOf` timestamp, or `undefined` for other modes. */
  get asOf(): string | undefined {
    return this.coordinate.valid.asOf;
  }

  /**
   * A query builder pinned to this view's coordinate. The temporal axis is
   * sealed: calling `.temporal(...)` on the returned builder throws, so the
   * view's coordinate cannot be overridden on a per-query basis.
   */
  query(): InitialQueryBuilder<G, "sealed"> {
    return this.store.sealedQuery(this.coordinate);
  }

  protected internalAlgorithms(): InternalGraphAlgorithms<G> {
    this.#internalAlgorithms ??= this.store.algorithmsAtCoordinate(
      this.coordinate,
    );
    return this.#internalAlgorithms;
  }

  /** Graph algorithms pinned to this view's immutable temporal coordinate. */
  get algorithms(): StoreViewGraphAlgorithms<G> {
    this.#algorithmFacade ??= Object.freeze({
      shortestPath: (from, to, options) => this.shortestPath(from, to, options),
      weightedShortestPath: (from, to, options) =>
        this.weightedShortestPath(from, to, options),
      reachable: (from, options) => this.reachable(from, options),
      canReach: (from, to, options) => this.canReach(from, to, options),
      neighbors: (node, options) => this.neighbors(node, options),
      degree: (node, options) => this.degree(node, options),
      weaklyConnectedComponents: (options) =>
        this.weaklyConnectedComponents(options),
      pageRank: (options) => this.pageRank(options),
      personalizedPageRank: (options) => this.personalizedPageRank(options),
    });
    return this.#algorithmFacade;
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
    const internalOptions = {
      ...options,
      ...withCoordinate(this.coordinate),
    } as InternalSubgraphOptions<G, EK, NK, P>;
    return this.store.subgraphAtCoordinate(rootId, internalOptions);
  }

  /** Shortest path between two nodes at this view's pinned coordinate. */
  shortestPath(
    from: NodeIdentifier,
    to: NodeIdentifier,
    options: StoreViewShortestPathOptions<G>,
  ): Promise<ShortestPathResult | undefined> {
    return this.internalAlgorithms().shortestPath(from, to, {
      ...options,
      ...withCoordinate(this.coordinate),
    });
  }

  /** Minimum-total-weight path at this view's pinned coordinate. */
  weightedShortestPath(
    from: NodeIdentifier,
    to: NodeIdentifier,
    options: StoreViewWeightedShortestPathOptions<G>,
  ): Promise<WeightedShortestPathResult | undefined> {
    return this.internalAlgorithms().weightedShortestPath(from, to, {
      ...options,
      ...withCoordinate(this.coordinate),
    });
  }

  /** Nodes reachable from `from` at this view's pinned coordinate. */
  reachable(
    from: NodeIdentifier,
    options: StoreViewReachableOptions<G>,
  ): Promise<readonly ReachableNode[]> {
    return this.internalAlgorithms().reachable(from, {
      ...options,
      ...withCoordinate(this.coordinate),
    });
  }

  /** Whether `to` is reachable from `from` at this view's pinned coordinate. */
  canReach(
    from: NodeIdentifier,
    to: NodeIdentifier,
    options: StoreViewCanReachOptions<G>,
  ): Promise<boolean> {
    return this.internalAlgorithms().canReach(from, to, {
      ...options,
      ...withCoordinate(this.coordinate),
    });
  }

  /** The k-hop neighborhood of `node` at this view's pinned coordinate. */
  neighbors(
    node: NodeIdentifier,
    options: StoreViewNeighborsOptions<G>,
  ): Promise<readonly ReachableNode[]> {
    return this.internalAlgorithms().neighbors(node, {
      ...options,
      ...withCoordinate(this.coordinate),
    });
  }

  /** Counts active edges incident to `node` at this view's pinned coordinate. */
  degree(
    node: NodeIdentifier,
    options?: StoreViewDegreeOptions<G>,
  ): Promise<number> {
    return this.internalAlgorithms().degree(node, {
      ...options,
      ...withCoordinate(this.coordinate),
    });
  }

  /** Exact WCC memberships at this view's pinned coordinate. */
  weaklyConnectedComponents(
    options: StoreViewWeaklyConnectedComponentsOptions<G>,
  ): Promise<readonly WeaklyConnectedComponentMembership[]> {
    return this.internalAlgorithms().weaklyConnectedComponents({
      ...options,
      ...withCoordinate(this.coordinate),
    });
  }

  /** Global PageRank scores at this view's pinned coordinate. */
  pageRank(
    options: StoreViewPageRankOptions<G>,
  ): Promise<readonly PageRankScore[]> {
    return this.internalAlgorithms().pageRank({
      ...options,
      ...withCoordinate(this.coordinate),
    });
  }

  /** Personalized PageRank scores at this view's pinned coordinate. */
  personalizedPageRank(
    options: StoreViewPersonalizedPageRankOptions<G>,
  ): Promise<readonly PageRankScore[]> {
    return this.internalAlgorithms().personalizedPageRank({
      ...options,
      ...withCoordinate(this.coordinate),
    });
  }
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
export class StoreView<G extends GraphDef> extends CoordinatePinnedView<G> {
  #nodes: StoreViewNodeCollections<G> | undefined;
  #edges: StoreViewEdgeCollections<G> | undefined;
  #search: StoreSearch<G> | undefined;

  constructor(
    store: Store<G>,
    coordinate: StoreViewCoordinate | ReadCoordinate,
  ) {
    super(
      store,
      isReadCoordinate(coordinate) ? coordinate : (
        resolveReadCoordinate(
          coordinate.mode,
          coordinate.asOf,
          'Use store.asOf("2026-01-01T00:00:00.000Z") or store.view({ mode: "asOf", asOf }).',
        )
      ),
    );
  }

  /** Adds a recorded-time pin, returning the narrow reconstructing view. */
  asOfRecorded(recordedAsOf: RecordedInstant): RecordedStoreView<G> {
    return new RecordedStoreView(
      this.store,
      withRecordedCoordinate(this.coordinate, recordedAsOf),
    );
  }

  /** Read-only node collections pinned to this view's coordinate. */
  get nodes(): StoreViewNodeCollections<G> {
    this.#nodes ??= pinnedNodeCollectionsFor(
      this.store,
      this.coordinate,
      (_kind, live: NodeCollection<NodeType, string>, coordinate) =>
        pinnedNodeCollection(live, coordinate),
    ) as unknown as StoreViewNodeCollections<G>;
    return this.#nodes;
  }

  /** Read-only edge collections pinned to this view's coordinate. */
  get edges(): StoreViewEdgeCollections<G> {
    this.#edges ??= pinnedEdgeCollectionsFor(
      this.store,
      this.coordinate,
      (
        _kind,
        live: EdgeCollection<AnyEdgeType, NodeType, NodeType>,
        coordinate,
      ) => pinnedEdgeCollection(live, coordinate),
    ) as unknown as StoreViewEdgeCollections<G>;
    return this.#edges;
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
    this.#search ??= pinnedSearch<G>(this.store, this.coordinate);
    return this.#search;
  }
}

/**
 * A narrow recorded-time read lens. It preserves the valid-time coordinate
 * carried by the source view and adds a recorded/system-time pin. Collection
 * reads are intentionally limited to point reconstruction; broad collection
 * predicates, endpoint reads, search, and further coordinate changes are absent
 * from the typed surface and refused by the runtime proxies for JS callers.
 */
export class RecordedStoreView<
  G extends GraphDef,
> extends CoordinatePinnedView<G> {
  #nodes: RecordedStoreViewNodeCollections<G> | undefined;
  #edges: RecordedStoreViewEdgeCollections<G> | undefined;

  constructor(store: Store<G>, coordinate: ReadCoordinate) {
    super(store, coordinate);
    if (!store.recordedReadBound) {
      throw new ConfigurationError(
        "asOfRecorded() requires a recorded read relation.",
        { code: "ASOF_RECORDED_REQUIRES_BINDING" },
        {
          suggestion:
            "Create the store with createStore(graph, backend, { history: true }) to bind TypeGraph's built-in captured relation, or pass { recordedRead: recordedRelation({ schema }) } for an externally populated recorded relation.",
        },
      );
    }
    if (coordinate.recorded === undefined) {
      throw new ConfigurationError(
        "RecordedStoreView requires a recorded-time coordinate.",
        { code: "RECORDED_STORE_VIEW_MISSING_COORDINATE" },
      );
    }

    // `search` is intentionally absent from the typed recorded surface (a TS
    // caller gets a compile error). It is installed here as a runtime-only
    // backstop — invisible to the class type — so a JS caller reaching past the
    // types gets a clear refusal rather than a bare `TypeError`. The fulltext /
    // vector index reflects current state only and cannot answer a
    // recorded-time query; the facade refuses every method. Mirrors the
    // per-collection runtime refusals ({@link recordedCollectionProxy}).
    let searchBackstop: StoreSearch<G> | undefined;
    Object.defineProperty(this, "search", {
      enumerable: false,
      get(): StoreSearch<G> {
        searchBackstop ??= recordedSearch<G>(coordinate);
        return searchBackstop;
      },
    });
  }

  /** The recorded/system-time timestamp this view reconstructs. */
  get asOfRecorded(): string {
    const recorded = this.coordinate.recorded;
    if (recorded === undefined) {
      throw new ConfigurationError(
        "RecordedStoreView requires a recorded-time coordinate.",
        { code: "RECORDED_STORE_VIEW_MISSING_COORDINATE" },
      );
    }
    return recorded.asOf;
  }

  /** Recorded-time node point-read collections. */
  get nodes(): RecordedStoreViewNodeCollections<G> {
    this.#nodes ??= pinnedNodeCollectionsFor(
      this.store,
      this.coordinate,
      (kind, live: NodeCollection<NodeType, string>, coordinate) =>
        recordedNodeCollection(this.store, kind, live, coordinate),
    ) as unknown as RecordedStoreViewNodeCollections<G>;
    return this.#nodes;
  }

  /** Recorded-time edge point-read collections. */
  get edges(): RecordedStoreViewEdgeCollections<G> {
    this.#edges ??= pinnedEdgeCollectionsFor(
      this.store,
      this.coordinate,
      (
        kind,
        live: EdgeCollection<AnyEdgeType, NodeType, NodeType>,
        coordinate,
      ) => recordedEdgeCollection(this.store, kind, live, coordinate),
    ) as unknown as RecordedStoreViewEdgeCollections<G>;
    return this.#edges;
  }
}
