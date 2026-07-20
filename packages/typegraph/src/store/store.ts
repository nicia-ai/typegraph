/**
 * Main Store implementation for TypeGraph.
 *
 * The Store is the primary interface for interacting with a TypeGraph.
 * It coordinates:
 * - Node and edge CRUD operations
 * - Constraint validation
 * - Schema management
 * - Transaction handling
 */
import type { z } from "zod";

import {
  asGraphWriteBackend,
  asRawBackend,
  type GraphWriteBackend,
  type RawBackend,
} from "../backend/branded";
import { createGraphBackendProjection } from "../backend/graph-backend-projection";
import {
  createEdgeRowMapper,
  createNodeRowMapper,
  POSTGRES_ROW_MAPPER_CONFIG,
  SQLITE_ROW_MAPPER_CONFIG,
} from "../backend/row-mappers";
import {
  type AdapterBackend,
  type BackendCapabilities,
  createTransactionReadBackend,
  type GraphBackend,
  runOptionallyInTransaction,
  type SchemaVersionRow,
  type TransactionBackend,
  type TransactionOptions,
} from "../backend/types";
import {
  type AllNodeTypes,
  type EdgeKinds,
  type GraphDef,
  isKnownKind,
  type NodeKinds,
} from "../core/define-graph";
import {
  resolveEmbeddingFields,
  resolveGraphVectorSlots,
} from "../core/embedding";
import {
  asRecordedInstant,
  type ReadCoordinate,
  type RecordedInstant,
  resolveReadCoordinate,
  withRecordedCoordinate,
} from "../core/temporal";
import type {
  AnyEdgeType,
  EdgeId,
  KindEntity,
  NodeId,
  NodeType,
} from "../core/types";
import {
  ConfigurationError,
  EagerMaterializationError,
  KindNotFoundError,
} from "../errors";
import {
  buildIncompatibleChangeError,
  classifyModifications,
  type RequireEmptyEntry,
} from "../graph-extension/classify";
import { IncompatibleChangeError } from "../graph-extension/errors";
import { type GraphExtension } from "../graph-extension/extension-types";
import { mergeGraphExtension } from "../graph-extension/merge";
import { planRemovals, stripGraphExtension } from "../graph-extension/remove";
import { type VectorIndexDeclaration } from "../indexes/types";
import type { TraversalExpansion } from "../query/ast";
import {
  type BatchableQuery,
  type BatchResults,
  createInternalQueryBuilder,
  type InitialQueryBuilder,
  type QueryCoordinateState,
} from "../query/builder";
import {
  createRecordedReadBinding,
  createSqlSchema,
  type RecordedReadBinding,
  requireExternalRecordedReadSource,
  requireSqlSchema,
  type SqlSchema,
} from "../query/compiler/schema";
import { getDialect } from "../query/dialect";
import type { SqlDialect } from "../query/dialect/types";
import { type VectorSlot } from "../query/dialect/vector-strategy";
import { buildKindRegistry, type KindRegistry } from "../registry";
import {
  applyDeprecatedKinds,
  commitNewSchemaVersion,
  ensureSchema as ensureSchemaImpl,
  loadActiveSchemaWithBootstrap,
  loadAndMergeGraphExtensionDocument,
  loadAndVerifyGraph,
  parseSerializedSchema,
  type SchemaManagerOptions,
  type SchemaValidationResult,
} from "../schema/manager";
import { type SerializedSchema } from "../schema/types";
import { nowIso } from "../utils/date";
import { generateId } from "../utils/id";
import { requireDefined } from "../utils/presence";
import {
  createGraphAlgorithms,
  type GraphAlgorithms,
  type InternalGraphAlgorithms,
} from "./algorithms";
import {
  createEdgeCollectionsProxy,
  createNodeCollectionsProxy,
  type EdgeOperations,
  type NodeOperations,
} from "./collection-factory";
import { resolveTemporalReadParams } from "./collections/temporal-read-params";
import {
  createHistoryStoreBackendProjection,
  type HistoryStoreBackend,
} from "./history-store-backend";
import { introspectSchema, type SchemaIntrospection } from "./introspect";
import {
  backendSupportsIndexMaterialization,
  computeIndexSignature,
  materializeIndexes as materializeIndexesImpl,
  type MaterializeIndexesOptions,
  type MaterializeIndexesResult,
  materializeSystemIndexes as materializeSystemIndexesImpl,
  type MaterializeSystemIndexesOptions,
  vectorStatusKey,
} from "./materialize-indexes";
import {
  buildPendingKindRemoval,
  materializeRemovals as materializeRemovalsImpl,
  type MaterializeRemovalsOptions,
  type MaterializeRemovalsResult,
} from "./materialize-removals";
import {
  type EdgeOperationContext,
  edgeUpsertDirtyCheck,
  executeEdgeBulkGetOrCreateByEndpoints,
  executeEdgeCreate,
  executeEdgeCreateBatch,
  executeEdgeCreateNoReturnBatch,
  executeEdgeDelete,
  executeEdgeFindByEndpoints,
  executeEdgeGetOrCreateByEndpoints,
  executeEdgeHardDelete,
  executeEdgeUpdate,
  executeEdgeUpsertUpdate,
  executeNodeBulkFindByConstraint,
  executeNodeBulkFindByIndex,
  executeNodeBulkGetOrCreateByConstraint,
  executeNodeCreate,
  executeNodeCreateBatch,
  executeNodeCreateNoReturnBatch,
  executeNodeDelete,
  executeNodeFindByConstraint,
  executeNodeGetOrCreateByConstraint,
  executeNodeHardDelete,
  executeNodeUpdate,
  executeNodeUpsertUpdate,
  type NodeOperationContext,
  nodeUpsertDirtyCheck,
} from "./operations";
import {
  advanceRevisionClock,
  assertRecordedCaptureTransactionIsolation,
  assertRevisionTrackableBackend,
  createRecordedBackend,
  createRecordedTransactionScope,
  ensureRevisionOrigin,
  lockRecordedGraphWrite,
  readRecordedClock,
  recordedCaptureRequiresCallbackTransactionError,
  type RecordedFlushInstants,
  throwHistoryUnsafeSqlAccess,
  throwRevisionTrackingUnsafeSqlAccess,
  withRecordedFlushObserver,
  withRecordedRelationsPrecondition,
} from "./recorded-capture";
import { assertNoRecordedCoordinate } from "./recorded-coordinate-guard";
import {
  createRecordedReadService,
  type RecordedReadService,
} from "./recorded-read-service";
import { rowToEdge, rowToNode } from "./row-mappers";
import { STORE_RUNTIME, type StoreRuntime } from "./runtime-port";
import { StoreSearch } from "./search-facade";
import {
  RecordedStoreView,
  StoreView,
  type StoreViewCoordinate,
} from "./store-view";
import {
  executeSubgraph,
  type InternalSubgraphOptions,
  type SubgraphOptions,
  type SubgraphProject,
  type SubgraphResult,
} from "./subgraph";
import {
  createTransactionReceiptRecorder,
  type TransactionReceiptRecorder,
  wrapTransactionCollections,
} from "./transaction-receipt";
import {
  type AdapterTransactionContext,
  AUTO_REFRESH_STATISTICS_ROW_THRESHOLD,
  type DynamicEdgeCollection,
  type DynamicNodeCollection,
  type Edge,
  type GraphEdgeCollections,
  type GraphNodeCollections,
  type HistoryStoreOptions,
  type HookContext,
  type LiveStoreOptions,
  type MeasurableAdapterTransactionContext,
  type MeasurableTransactionContext,
  type Node,
  type OperationHookContext,
  type QueryOptions,
  type RecordedReadStoreOptions,
  type RecordedScanOptions,
  type RecordedScanPage,
  type ScopedMeasure,
  type StoreHooks,
  type StoreOptions,
  type StoreRef,
  TRANSACTION_RUNTIME,
  type TransactionContext,
  type TransactionOutcome,
  type UnboundLiveStoreOptions,
} from "./types";

type StoreSchemaMetadata = Readonly<{
  schemaVersion: number | undefined;
  schemaHash: string | undefined;
}>;

const UNKNOWN_SCHEMA_METADATA: StoreSchemaMetadata = Object.freeze({
  schemaVersion: undefined,
  schemaHash: undefined,
});

type CaughtUpVerb =
  "evolve" | "materialize" | "deprecate" | "undeprecate" | "remove" | "reembed";

/** Default page size for the {@link Store.reembedVectorField} re-embed loop. */
const DEFAULT_REEMBED_BATCH_SIZE = 200;

const CAUGHT_UP_VERB_DETAILS: Readonly<
  Record<CaughtUpVerb, Readonly<{ phrase: string; code: string }>>
> = {
  evolve: { phrase: "evolve", code: "EVOLVE_BEFORE_INITIALIZE" },
  materialize: {
    phrase: "materialize indexes on",
    code: "MATERIALIZE_BEFORE_INITIALIZE",
  },
  remove: { phrase: "remove kinds on", code: "REMOVE_BEFORE_INITIALIZE" },
  deprecate: {
    phrase: "deprecate kinds on",
    code: "DEPRECATE_BEFORE_INITIALIZE",
  },
  undeprecate: {
    phrase: "undeprecate kinds on",
    code: "DEPRECATE_BEFORE_INITIALIZE",
  },
  reembed: {
    phrase: "re-embed a vector field on",
    code: "REEMBED_BEFORE_INITIALIZE",
  },
};

const ROW_MAPPER_CONFIGS = {
  postgres: POSTGRES_ROW_MAPPER_CONFIG,
  sqlite: SQLITE_ROW_MAPPER_CONFIG,
} satisfies Record<SqlDialect, typeof POSTGRES_ROW_MAPPER_CONFIG>;

function rowMapperConfigFor(backend: GraphBackend | TransactionBackend) {
  return ROW_MAPPER_CONFIGS[backend.dialect];
}

// ============================================================
// Store Class
// ============================================================

/**
 * The Store provides typed access to a TypeGraph database.
 *
 * @example
 * ```typescript
 * const store = createStore(myGraph, backend);
 *
 * // Create nodes using collection API
 * const person = await store.nodes.Person.create({
 *   name: "Alice",
 *   email: "alice@example.com",
 * });
 *
 * const company = await store.nodes.Company.create({
 *   name: "Acme",
 *   industry: "Technology",
 * });
 *
 * // Create edges
 * await store.edges.worksAt.create(
 *   { kind: "Person", id: person.id },
 *   { kind: "Company", id: company.id },
 *   { role: "Engineer" }
 * );
 *
 * // Query with the fluent API
 * const results = await store.query()
 *   .from("Person", "p")
 *   .whereNode("p", (p) => p.name.eq("Alice"))
 *   .select((ctx) => ctx.p)
 *   .execute();
 * ```
 */

/**
 * Optional embedder for {@link Store.reembedVectorField}. Receives a batch of
 * the kind's nodes and returns a map of `nodeId → new embedding vector` (omit
 * an id to leave that node without an embedding). Called once per page; the
 * page size is `batchSize`.
 */
export type ReembedFunction = (
  nodes: readonly Node[],
) =>
  | Promise<ReadonlyMap<string, readonly number[]>>
  | ReadonlyMap<string, readonly number[]>;

/** Options for {@link Store.reembedVectorField}. */
export type ReembedVectorFieldOptions = Readonly<{
  /**
   * When supplied, drives a batched re-embed loop after recreating storage:
   * pages the kind's nodes, calls `embed(batch)`, and upserts the returned
   * vectors. When omitted, storage is recreated empty and the caller
   * re-embeds via normal `update()` / `upsertEmbedding` writes.
   */
  embed?: ReembedFunction;
  /** Re-embed page size. Default 200. */
  batchSize?: number;
}>;

/** Result of {@link Store.reembedVectorField}. */
export type ReembedVectorFieldResult = Readonly<{
  /** Whether the per-field storage was dropped and recreated. */
  recreated: boolean;
  /** Number of nodes whose embedding was re-written (0 without `embed`). */
  reembedded: number;
}>;

/** One place for the hooks' error normalization. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The `(hook context, operation body)` wrapper shape operation contexts carry. */
type OperationHookRunner = <T>(
  ctx: OperationHookContext,
  fn: () => Promise<T>,
) => Promise<T>;

/** A committed-inside-the-transaction operation awaiting the outer COMMIT. */
type PendingOperationOutcome = Readonly<{
  ctx: OperationHookContext;
  durationMs: number;
}>;

type TransactionRunResult<T> = Readonly<{
  result: T;
  recordedByGraph: RecordedFlushInstants | undefined;
}>;

/**
 * The flush result for a `withRecordedTransaction` on a store without history
 * capture: no recorded rows were closed, so no graph maps to an instant. Shared
 * (rather than allocated per call) — a `ReadonlyMap` is never mutated.
 */
const EMPTY_RECORDED_FLUSH_INSTANTS: RecordedFlushInstants = new Map();

function transactionOutcome<T>(
  result: T,
  recorder: TransactionReceiptRecorder,
  recordedByGraph: RecordedFlushInstants | undefined,
  graphId: string,
): TransactionOutcome<T> {
  const recorded = recordedByGraph?.get(graphId);
  return {
    result,
    receipt: recorder.snapshot(
      recorded === undefined ? undefined : asRecordedInstant(recorded),
    ),
  };
}

/** Clones an internal context without evaluating accessor properties. */
function overlayPropertyDescriptors<
  TBase extends object,
  TOverlay extends object,
>(base: TBase, overlay: TOverlay): TBase & TOverlay {
  return Object.defineProperties(Object.create(Reflect.getPrototypeOf(base)), {
    ...Object.getOwnPropertyDescriptors(base),
    ...Object.getOwnPropertyDescriptors(overlay),
  }) as TBase & TOverlay;
}

/** Keeps suppressed/JavaScript raw-SQL access fail-loud without advertising it. */
function defineUnavailableSqlGuard(context: object, guard: () => never): void {
  Object.defineProperty(context, "sql", {
    configurable: false,
    enumerable: true,
    get: guard,
  });
}

type StoreCore<G extends GraphDef> = Readonly<{
  [STORE_RUNTIME]: StoreRuntime<G>;
  graph: G;
  graphId: string;
  capabilities: BackendCapabilities;
  registry: KindRegistry;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
  revisionSchema: SqlSchema;
  recordedReadBound: boolean;
  nodes: GraphNodeCollections<G>;
  edges: GraphEdgeCollections<G>;
  algorithms: GraphAlgorithms<G>;
  search: StoreSearch<G>;
  getNodeCollection: (kind: string) => DynamicNodeCollection | undefined;
  getNodeCollectionOrThrow: (kind: string) => DynamicNodeCollection;
  getEdgeCollection: (kind: string) => DynamicEdgeCollection | undefined;
  getEdgeCollectionOrThrow: (kind: string) => DynamicEdgeCollection;
  getNodePropsSchema: (kind: string) => z.ZodObject<z.ZodRawShape> | undefined;
  getNodePropsSchemaOrThrow: (kind: string) => z.ZodObject<z.ZodRawShape>;
  getEdgePropsSchema: (kind: string) => z.ZodObject<z.ZodRawShape> | undefined;
  getEdgePropsSchemaOrThrow: (kind: string) => z.ZodObject<z.ZodRawShape>;
  introspect: () => SchemaIntrospection;
  query: () => InitialQueryBuilder<G, "open">;
  asOf: (asOf: string) => StoreView<G>;
  asOfRecorded: (recordedAsOf: RecordedInstant) => RecordedStoreView<G>;
  recordedNow: () => Promise<RecordedInstant | undefined>;
  revisionNow: () => Promise<string | undefined>;
  revisionOriginNow: () => Promise<string>;
  view: (coordinate: StoreViewCoordinate) => StoreView<G>;
  snapshot: () => StoreView<G>;
  batch: <
    const Queries extends readonly [
      BatchableQuery<unknown>,
      BatchableQuery<unknown>,
      ...BatchableQuery<unknown>[],
    ],
  >(
    ...queries: Queries
  ) => Promise<BatchResults<Queries>>;
  subgraph: <
    const EK extends EdgeKinds<G>,
    const NK extends NodeKinds<G> = NodeKinds<G>,
    const P extends SubgraphProject<G, NK, EK> | undefined = undefined,
  >(
    rootId: NodeId<AllNodeTypes<G>>,
    options: SubgraphOptions<G, EK, NK, P>,
  ) => Promise<SubgraphResult<G, NK, EK, P>>;
  clear: () => Promise<void>;
  refreshStatistics: () => Promise<void>;
  materializeIndexes: (
    options?: MaterializeIndexesOptions,
  ) => Promise<MaterializeIndexesResult>;
  materializeSystemIndexes: (
    options?: MaterializeSystemIndexesOptions,
  ) => Promise<MaterializeIndexesResult>;
  reembedVectorField: (
    kind: string,
    fieldPath: string,
    options?: ReembedVectorFieldOptions,
  ) => Promise<ReembedVectorFieldResult>;
  materializeRemovals: (
    options?: MaterializeRemovalsOptions,
  ) => Promise<MaterializeRemovalsResult>;
  close: () => Promise<void>;
}>;

type StoreTransactions<G extends GraphDef> = Readonly<{
  transaction: <T>(
    fn: (tx: TransactionContext<G>) => Promise<T>,
    options?: TransactionOptions,
  ) => Promise<T>;
  transactionWithReceipt: <T>(
    fn: (tx: MeasurableTransactionContext<G>) => Promise<T>,
    options?: TransactionOptions,
  ) => Promise<TransactionOutcome<T>>;
}>;

interface StoreEvolution<G extends GraphDef, TStore extends StoreCore<G>> {
  readonly evolve: <TRefStore extends StoreCore<G> = TStore>(
    extension: GraphExtension,
    options?: Readonly<{
      ref?: TStore extends TRefStore ? StoreRef<TRefStore> : never;
      eager?: MaterializeIndexesOptions;
    }>,
  ) => Promise<TStore>;
  readonly deprecateKinds: <TRefStore extends StoreCore<G> = TStore>(
    names: readonly string[],
    options?: Readonly<{
      ref?: TStore extends TRefStore ? StoreRef<TRefStore> : never;
    }>,
  ) => Promise<TStore>;
  readonly undeprecateKinds: <TRefStore extends StoreCore<G> = TStore>(
    names: readonly string[],
    options?: Readonly<{
      ref?: TStore extends TRefStore ? StoreRef<TRefStore> : never;
    }>,
  ) => Promise<TStore>;
  readonly removeKinds: <TRefStore extends StoreCore<G> = TStore>(
    names: readonly string[],
    options?: Readonly<{
      ref?: TStore extends TRefStore ? StoreRef<TRefStore> : never;
      eager?: MaterializeRemovalsOptions;
    }>,
  ) => Promise<TStore>;
}

function syncStoreReplacementRef<
  G extends GraphDef,
  TRefStore extends StoreCore<G>,
>(ref: StoreRef<TRefStore> | undefined, replacement: StoreCore<G>): void {
  if (ref === undefined) return;
  // StoreEvolution admits only refs whose value is a supertype of the returned
  // Store flavor. Runtime implementations use one broader class for every
  // overload, so the compiler cannot recover that public conditional here.
  ref.current = replacement as unknown as TRefStore;
}

/**
 * The default TypeGraph Store contract. It contains the complete graph API and
 * graph-owned transactions while keeping adapter-native handles, backend
 * internals, and caller-owned transaction adoption out of the public surface.
 */
export type Store<G extends GraphDef> = StoreCore<G> &
  StoreTransactions<G> &
  StoreEvolution<G, Store<G>>;

/**
 * A Store with explicit adapter interoperability. Adapter entrypoints return
 * this surface so native transaction handles remain precisely typed without
 * leaking into the default Store contract.
 */
export type AdapterStore<
  G extends GraphDef,
  TNativeTransaction,
> = StoreCore<G> &
  StoreEvolution<G, AdapterStore<G, TNativeTransaction>> &
  AdapterStoreTransactions<G, TNativeTransaction> &
  Readonly<{ backend: GraphBackend }>;

type AdapterStoreTransactions<
  G extends GraphDef,
  TNativeTransaction,
> = Readonly<{
  transaction: <T>(
    fn: (tx: AdapterTransactionContext<G, TNativeTransaction>) => Promise<T>,
    options?: TransactionOptions,
  ) => Promise<T>;
  transactionWithReceipt: <T>(
    fn: (
      tx: MeasurableAdapterTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>,
    options?: TransactionOptions,
  ) => Promise<TransactionOutcome<T>>;
  withTransaction: (
    externalTransaction: TNativeTransaction,
  ) => AdapterTransactionContext<G, TNativeTransaction>;
  withRecordedTransaction: <T>(
    externalTransaction: TNativeTransaction,
    fn: (
      tx: MeasurableAdapterTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>,
  ) => Promise<TransactionOutcome<T>>;
}>;

class StoreImplementation<G extends GraphDef, TNativeTransaction = unknown> {
  readonly [STORE_RUNTIME]: StoreRuntime<G>;
  readonly #graph: G;
  /**
   * Bare backend for DDL, vector-storage, and bulk-materialization work that must
   * bypass recorded capture. Graph-entity writes use `#backend` instead.
   */
  readonly #baseBackend: RawBackend;
  readonly #backend: GraphWriteBackend;
  readonly #adapterBackend: AdapterBackend<TNativeTransaction> | undefined;
  readonly #captureEnabled: boolean;
  readonly #revisionTrackingEnabled: boolean;
  #revisionOrigin: Promise<string> | undefined;
  readonly #recordedReadBinding: RecordedReadBinding | undefined;
  readonly #registry: KindRegistry;
  readonly #hooks: StoreHooks;
  readonly #schema: StoreOptions["schema"];
  readonly #recordedReads: RecordedReadService;
  readonly #schemaMetadata: StoreSchemaMetadata;
  readonly #defaultTraversalExpansion: TraversalExpansion;
  // Stored verbatim so `evolve()` can construct the next Store with
  // identical options. Reconstructing from the individual private
  // fields would silently drop any future StoreOptions field a
  // maintainer adds without also threading it through evolve.
  readonly #options: StoreOptions | undefined;
  #nodeCollections: GraphNodeCollections<G> | undefined;
  #edgeCollections: GraphEdgeCollections<G> | undefined;
  #algorithms: GraphAlgorithms<G> | undefined;
  #search: StoreSearch<G> | undefined;

  constructor(
    graph: G,
    backend: GraphBackend,
    options?: StoreOptions,
    schemaMetadata?: StoreSchemaMetadata,
    adapterBackend?: AdapterBackend<TNativeTransaction>,
  ) {
    this.#graph = graph;
    this.#baseBackend = asRawBackend(backend);
    this.#adapterBackend = adapterBackend;
    this.#captureEnabled = options?.history === true;
    this.#revisionTrackingEnabled =
      this.#captureEnabled || options?.revisionTracking === true;
    if (this.#revisionTrackingEnabled) {
      assertRevisionTrackableBackend(backend);
    }
    // Resolve the schema before wrapping so recorded-time capture targets the
    // same relations recorded reads do (the explicit `schema` option, not just
    // `backend.tableNames`).
    const explicitSchema =
      options?.schema === undefined ?
        undefined
      : requireSqlSchema(options.schema, "store schema");
    const resolvedSchema =
      explicitSchema ??
      (backend.tableNames ? createSqlSchema(backend.tableNames) : undefined);
    const readSchema = resolvedSchema ?? createSqlSchema(backend.tableNames);
    if (this.#captureEnabled && options?.recordedRead !== undefined) {
      throw new ConfigurationError(
        "recordedRead cannot be combined with history: true.",
        { code: "RECORDED_READ_CONFLICTS_WITH_HISTORY" },
        {
          suggestion:
            "Use { history: true } for TypeGraph-managed capture, or omit history and pass { recordedRead: recordedRelation({ schema }) } for an externally populated recorded relation.",
        },
      );
    }
    const externalRecordedRead = requireExternalRecordedReadSource(
      options?.recordedRead,
    );
    this.#recordedReadBinding =
      this.#captureEnabled ?
        createRecordedReadBinding(readSchema)
      : externalRecordedRead;
    this.#backend =
      this.#captureEnabled ?
        asGraphWriteBackend(createRecordedBackend(backend, resolvedSchema))
      : asGraphWriteBackend(backend);
    this.#schema = resolvedSchema;
    const rowMapperConfig = rowMapperConfigFor(this.#backend);
    this.#recordedReads = createRecordedReadService({
      graphId: graph.id,
      backend: this.#backend,
      recordedReadBinding: this.#recordedReadBinding,
      mapRecordedNodeRow: createNodeRowMapper(rowMapperConfig),
      mapRecordedEdgeRow: createEdgeRowMapper(rowMapperConfig),
    });
    this.#registry = buildKindRegistry(graph);
    this.#hooks = options?.hooks ?? {};
    this.#defaultTraversalExpansion =
      options?.queryDefaults?.traversalExpansion ?? "inverse";
    this.#options = options;
    this.#schemaMetadata = schemaMetadata ?? UNKNOWN_SCHEMA_METADATA;
    this[STORE_RUNTIME] = {
      backend: this.#backend,
      sealedQuery: (coordinate) => this.sealedQuery(coordinate),
      recordedNodeGetById: (kind, id, coordinate) =>
        this.recordedNodeGetById(kind, id, coordinate),
      recordedNodeGetByIds: (kind, ids, coordinate) =>
        this.recordedNodeGetByIds(kind, ids, coordinate),
      recordedNodeScan: (kind, coordinate, options) =>
        this.recordedNodeScan(kind, coordinate, options),
      recordedEdgeGetById: (kind, id, coordinate) =>
        this.recordedEdgeGetById(kind, id, coordinate),
      recordedEdgeGetByIds: (kind, ids, coordinate) =>
        this.recordedEdgeGetByIds(kind, ids, coordinate),
      recordedEdgeScan: (kind, coordinate, options) =>
        this.recordedEdgeScan(kind, coordinate, options),
      subgraphAtCoordinate: (rootId, subgraphOptions) =>
        this.subgraphAtCoordinate(rootId, subgraphOptions),
      algorithmsAtCoordinate: (coordinate) =>
        this.algorithmsAtCoordinate(coordinate),
    };
    Object.defineProperty(this, STORE_RUNTIME, {
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }

  // === Accessors ===

  /** The graph definition */
  get graph(): G {
    return this.#graph;
  }

  /** The graph ID */
  get graphId(): string {
    return this.#graph.id;
  }

  /** Runtime features available through this store's configured backend. */
  get capabilities(): BackendCapabilities {
    return this.#baseBackend.capabilities;
  }

  /** The kind registry for ontology lookups */
  get registry(): KindRegistry {
    return this.#registry;
  }

  /**
   * Whether recorded-time capture is enabled for this store.
   *
   * @internal
   */
  get historyEnabled(): boolean {
    return this.#captureEnabled;
  }

  /**
   * Whether this Store advances a durable revision anchor for graph writes.
   *
   * @internal
   */
  get revisionTrackingEnabled(): boolean {
    return this.#revisionTrackingEnabled;
  }

  /**
   * SQL schema that owns the durable revision clock relation.
   *
   * @internal
   */
  get revisionSchema(): SqlSchema {
    return this.#sqlSchema();
  }

  /**
   * Whether this store has a recorded read relation bound for reconstruction.
   *
   * @internal
   */
  get recordedReadBound(): boolean {
    return this.#recordedReadBinding !== undefined;
  }

  // === Collections ===

  /**
   * Node collections for ergonomic CRUD operations.
   *
   * @example
   * ```typescript
   * // Create a node
   * const person = await store.nodes.Person.create({ name: "Alice" });
   *
   * // Get by ID
   * const fetched = await store.nodes.Person.getById(person.id);
   *
   * // Find all
   * const people = await store.nodes.Person.find({ limit: 10 });
   * ```
   */
  get nodes(): GraphNodeCollections<G> {
    if (this.#nodeCollections === undefined) {
      this.#nodeCollections = createNodeCollectionsProxy(
        this.#graph,
        this.graphId,
        this.#registry,
        this.#backend,
        this.#nodeOperations,
      );
    }

    return this.#nodeCollections;
  }

  /**
   * Edge collections for ergonomic CRUD operations.
   *
   * @example
   * ```typescript
   * // Create an edge
   * const edge = await store.edges.worksAt.create(
   *   { kind: "Person", id: person.id },
   *   { kind: "Company", id: company.id },
   *   { role: "Engineer" }
   * );
   *
   * // Find edges from a node
   * const edges = await store.edges.worksAt.findFrom({ kind: "Person", id: person.id });
   * ```
   */
  get edges(): GraphEdgeCollections<G> {
    if (this.#edgeCollections === undefined) {
      this.#edgeCollections = createEdgeCollectionsProxy(
        this.#graph,
        this.graphId,
        this.#registry,
        this.#backend,
        this.#edgeOperations,
      );
    }

    return this.#edgeCollections;
  }

  // === Graph Algorithms ===

  /**
   * Tier 1 graph algorithms: shortest path, reachability, neighborhoods, and
   * degree centrality.
   *
   * Traversal calls use the iterative graph-operation substrate: a set-based
   * breadth-first frontier backed by a temporary working table, or a chunked
   * inline relation when the backend cannot pin a transactional connection.
   * `degree` uses a single count query. The facade is built lazily on first
   * access and cached for the lifetime of the store.
   *
   * @example
   * ```typescript
   * const path = await store.algorithms.shortestPath(alice, bob, {
   *   edges: ["knows"],
   * });
   *
   * const friends = await store.algorithms.neighbors(alice, {
   *   edges: ["knows"],
   *   depth: 2,
   * });
   * ```
   */
  get algorithms(): GraphAlgorithms<G> {
    if (this.#algorithms === undefined) {
      this.#algorithms = createGraphAlgorithms<G>({
        graphId: this.graphId,
        graph: this.#graph,
        registry: this.#registry,
        backend: this.#backend,
        schema: this.#schema,
        recordedReadBinding: this.#recordedReadBinding,
        defaultTemporalMode: this.#graph.defaults.temporalMode,
      });
    }
    return this.#algorithms;
  }

  // === Dynamic Collection Access ===

  /**
   * Resolves `kind` against `collections` (either `this.nodes` or a
   * transaction-scoped — and possibly receipt-wrapped — node collection map),
   * or `undefined` when the kind is not registered in this graph. Shared by
   * `getNodeCollection` and both transaction contexts' `getNodeCollection` so
   * a receipt-wrapped transaction counts writes made through the dynamic
   * lookup exactly like `this.#graph.nodes` membership is checked everywhere
   * else.
   */
  #resolveDynamicNodeCollection(
    collections: GraphNodeCollections<G>,
    kind: string,
  ): DynamicNodeCollection | undefined {
    if (!Object.hasOwn(this.#graph.nodes, kind)) return undefined;
    return collections[
      kind as keyof G["nodes"] & string
    ] as unknown as DynamicNodeCollection;
  }

  /**
   * Returns the node collection for the given kind, or undefined if the kind
   * is not registered in this graph.
   *
   * Use this for runtime string-keyed access when the kind is not known at
   * compile time (e.g., iterating all kinds, resolving from edge metadata,
   * dynamic admin UIs). For the post-evolve "I just added this kind, give
   * me the collection" pattern, prefer `getNodeCollectionOrThrow` — it
   * throws `KindNotFoundError` instead of forcing a null-check.
   */
  getNodeCollection(kind: string): DynamicNodeCollection | undefined {
    return this.#resolveDynamicNodeCollection(this.nodes, kind);
  }

  /**
   * Returns the node collection for the given kind. Throws
   * `KindNotFoundError` when the kind is not registered.
   *
   * The dominant graph-extension-kind access pattern: `await store.evolve(...)`
   * returns a new store, the caller immediately operates on the new
   * kind, and the null-check the optional variant requires is busywork.
   */
  getNodeCollectionOrThrow(kind: string): DynamicNodeCollection {
    const collection = this.getNodeCollection(kind);
    if (collection === undefined) {
      throw new KindNotFoundError(kind, "node", {
        graphId: this.graphId,
      });
    }
    return collection;
  }

  /**
   * Returns the edge collection for the given kind, or undefined if the kind
   * is not registered in this graph.
   *
   * Use this for runtime string-keyed access when the kind is not known at
   * compile time. For post-evolve access, prefer `getEdgeCollectionOrThrow`.
   */
  getEdgeCollection(kind: string): DynamicEdgeCollection | undefined {
    if (!Object.hasOwn(this.#graph.edges, kind)) return undefined;
    return this.edges[
      kind as keyof G["edges"] & string
    ] as unknown as DynamicEdgeCollection;
  }

  /**
   * Returns the edge collection for the given kind. Throws
   * `KindNotFoundError` when the kind is not registered.
   */
  getEdgeCollectionOrThrow(kind: string): DynamicEdgeCollection {
    const collection = this.getEdgeCollection(kind);
    if (collection === undefined) {
      throw new KindNotFoundError(kind, "edge", {
        graphId: this.graphId,
      });
    }
    return collection;
  }

  // === Dynamic Props Schema Access ===

  /**
   * Returns the Zod props schema for the given node kind, or `undefined`
   * if the kind is not registered. Identity-preserving: returns the
   * exact instance used by `.create()` / `.update()`, so a `parse()`
   * surfaces the same underlying Zod issues that `ValidationError`
   * wraps (operation-level checks like uniqueness and endpoints stay
   * in `collection.create`).
   */
  getNodePropsSchema(kind: string): z.ZodObject<z.ZodRawShape> | undefined {
    if (!Object.hasOwn(this.#graph.nodes, kind)) return undefined;
    return requireDefined(this.#graph.nodes[kind]).type.schema;
  }

  /**
   * Returns the Zod props schema for the given node kind. Throws
   * `KindNotFoundError` when the kind is not registered.
   */
  getNodePropsSchemaOrThrow(kind: string): z.ZodObject<z.ZodRawShape> {
    const schema = this.getNodePropsSchema(kind);
    if (schema === undefined) {
      throw new KindNotFoundError(kind, "node", {
        graphId: this.graphId,
      });
    }
    return schema;
  }

  /**
   * Returns the Zod props schema for the given edge kind, or `undefined`
   * if the kind is not registered. Symmetric with `getNodePropsSchema`.
   */
  getEdgePropsSchema(kind: string): z.ZodObject<z.ZodRawShape> | undefined {
    if (!Object.hasOwn(this.#graph.edges, kind)) return undefined;
    return requireDefined(this.#graph.edges[kind]).type.schema;
  }

  /**
   * Returns the Zod props schema for the given edge kind. Throws
   * `KindNotFoundError` when the kind is not registered.
   */
  getEdgePropsSchemaOrThrow(kind: string): z.ZodObject<z.ZodRawShape> {
    const schema = this.getEdgePropsSchema(kind);
    if (schema === undefined) {
      throw new KindNotFoundError(kind, "edge", {
        graphId: this.graphId,
      });
    }
    return schema;
  }

  /**
   * Returns a unified read of the merged schema — every compile-time
   * and graph-extension kind, every edge, every ontology relation,
   * with explicit `origin: "compile-time" | "runtime"` markers — plus
   * the persisted `extension` for round-tripping.
   *
   * Pure synchronous read built from the in-memory graph and the
   * already-merged graph-extension document. `schemaVersion` and `schemaHash`
   * are populated when the loader cached them at construction or after
   * `evolve` returns; consumers needing a fresh read should call
   * `backend.getActiveSchema(graphId)`.
   *
   * The return shape is the canonical schema-introspection surface:
   * the prior standalone `store.deprecatedKinds` accessor is replaced
   * by `introspect().deprecatedKinds`.
   */
  introspect(): SchemaIntrospection {
    return introspectSchema(this.#graph, {
      graphId: this.graphId,
      schemaVersion: this.#schemaMetadata.schemaVersion,
      schemaHash: this.#schemaMetadata.schemaHash,
    });
  }

  /**
   * Node operations bound to this store instance.
   */
  get #nodeOperations(): NodeOperations {
    return this.#buildNodeOperations(this.#createNodeOperationContext());
  }

  /**
   * Refreshes planner statistics after an autocommit bulk write that
   * reached the configured row threshold. A refresh failure must never
   * fail the (already committed) write — it degrades to a warning.
   */
  async #maybeRefreshStatisticsAfterBulk(rowCount: number): Promise<void> {
    const configured = this.#options?.autoRefreshStatistics;
    if (configured === false) return;
    const threshold = configured ?? AUTO_REFRESH_STATISTICS_ROW_THRESHOLD;
    if (rowCount < threshold) return;
    try {
      await this.refreshStatistics();
    } catch (error) {
      console.warn(
        "typegraph: statistics refresh after bulk write failed; run " +
          "store.refreshStatistics() to avoid stale planner statistics.",
        error,
      );
    }
  }

  #buildNodeOperations(ctx: NodeOperationContext<G>): NodeOperations {
    return {
      defaultTemporalMode: this.#graph.defaults.temporalMode,
      rowToNode: (row) => rowToNode(row),
      maybeRefreshStatisticsAfterBulk: (rowCount) =>
        this.#maybeRefreshStatisticsAfterBulk(rowCount),
      executeCreate: (input, backend) => executeNodeCreate(ctx, input, backend),
      executeCreateBatch: (inputs, backend) =>
        executeNodeCreateBatch(ctx, inputs, backend),
      executeCreateNoReturnBatch: (inputs, backend) =>
        executeNodeCreateNoReturnBatch(ctx, inputs, backend),
      executeUpdate: (input, backend, options) =>
        executeNodeUpdate(ctx, { ...input, id: input.id }, backend, options),
      executeUpsertUpdate: (input, backend, options) =>
        executeNodeUpsertUpdate(
          ctx,
          { ...input, id: input.id },
          backend,
          options,
        ),
      // Present only when opted in; its absence is the coalesce off switch.
      ...(this.#options?.coalesceUnchangedUpserts === true && {
        upsertDirtyCheck: (kind, id, existingProps, inputProps) =>
          nodeUpsertDirtyCheck(ctx, kind, id, existingProps, inputProps),
      }),
      executeDelete: (kind, id, backend) =>
        executeNodeDelete(ctx, kind, id, backend),
      executeHardDelete: (kind, id, backend) =>
        executeNodeHardDelete(ctx, kind, id, backend),
      temporalRowMatcher: (options) => this.#temporalRowMatcher(options),
      createQuery: () => this.query(),
      executeGetOrCreateByConstraint: (
        kind,
        constraintName,
        props,
        backend,
        options,
      ) =>
        executeNodeGetOrCreateByConstraint(
          ctx,
          kind,
          constraintName,
          props,
          backend,
          options,
        ),
      executeBulkGetOrCreateByConstraint: (
        kind,
        constraintName,
        items,
        backend,
        options,
      ) =>
        executeNodeBulkGetOrCreateByConstraint(
          ctx,
          kind,
          constraintName,
          items,
          backend,
          options,
        ),
      executeFindByConstraint: (kind, constraintName, props, backend) =>
        executeNodeFindByConstraint(ctx, kind, constraintName, props, backend),
      executeBulkFindByConstraint: (kind, constraintName, items, backend) =>
        executeNodeBulkFindByConstraint(
          ctx,
          kind,
          constraintName,
          items,
          backend,
        ),
      executeBulkFindByIndex: (kind, indexName, items, backend, options) =>
        executeNodeBulkFindByIndex(
          ctx,
          kind,
          indexName,
          items,
          backend,
          options,
        ),
    };
  }

  /**
   * Edge operations bound to this store instance.
   */
  get #edgeOperations(): EdgeOperations {
    return this.#buildEdgeOperations(this.#createEdgeOperationContext());
  }

  #buildEdgeOperations(ctx: EdgeOperationContext<G>): EdgeOperations {
    return {
      defaultTemporalMode: this.#graph.defaults.temporalMode,
      rowToEdge: (row) => rowToEdge(row),
      maybeRefreshStatisticsAfterBulk: (rowCount) =>
        this.#maybeRefreshStatisticsAfterBulk(rowCount),
      executeCreate: (input, backend) => executeEdgeCreate(ctx, input, backend),
      executeCreateBatch: (inputs, backend) =>
        executeEdgeCreateBatch(ctx, inputs, backend),
      executeCreateNoReturnBatch: (inputs, backend) =>
        executeEdgeCreateNoReturnBatch(ctx, inputs, backend),
      executeUpdate: (input, backend) => executeEdgeUpdate(ctx, input, backend),
      executeUpsertUpdate: (input, backend, options) =>
        executeEdgeUpsertUpdate(ctx, input, backend, options),
      // Present only when opted in; its absence is the coalesce off switch.
      ...(this.#options?.coalesceUnchangedUpserts === true && {
        upsertDirtyCheck: (kind, id, existingProps, inputProps) =>
          edgeUpsertDirtyCheck(ctx, kind, id, existingProps, inputProps),
      }),
      executeDelete: (id, backend) => executeEdgeDelete(ctx, id, backend),
      executeHardDelete: (id, backend) =>
        executeEdgeHardDelete(ctx, id, backend),
      temporalRowMatcher: (options) => this.#temporalRowMatcher(options),
      createQuery: () => this.query(),
      executeGetOrCreateByEndpoints: (
        kind,
        fromKind,
        fromId,
        toKind,
        toId,
        props,
        backend,
        options,
      ) =>
        executeEdgeGetOrCreateByEndpoints(
          ctx,
          kind,
          fromKind,
          fromId,
          toKind,
          toId,
          props,
          backend,
          options,
        ),
      executeBulkGetOrCreateByEndpoints: (kind, items, backend, options) =>
        executeEdgeBulkGetOrCreateByEndpoints(
          ctx,
          kind,
          items,
          backend,
          options,
        ),
      executeFindByEndpoints: (
        kind,
        fromKind,
        fromId,
        toKind,
        toId,
        backend,
        options,
      ) =>
        executeEdgeFindByEndpoints(
          ctx,
          kind,
          fromKind,
          fromId,
          toKind,
          toId,
          backend,
          options,
        ),
    };
  }

  // === Query Builder ===

  /**
   * Creates a query builder for this store.
   *
   * @example
   * ```typescript
   * const results = await store.query()
   *   .from("Person", "p")
   *   .whereNode("p", (p) => p.name.eq("Alice"))
   *   .select((ctx) => ctx.p)
   *   .execute();
   * ```
   */
  query(): InitialQueryBuilder<G, "open"> {
    return this.#createQueryForBackend(this.#backend);
  }

  /**
   * Internal seam for {@link StoreView.query}: a query builder pinned to a
   * view's {@link ReadCoordinate} with its temporal axis sealed
   * (`.temporal()` throws). Not part of the stable public API — construct a
   * view via {@link Store.view} / {@link Store.asOf} and call `.query()`.
   */
  sealedQuery(coordinate: ReadCoordinate): InitialQueryBuilder<G, "sealed"> {
    return this.#createQueryForBackend(
      this.#recordedReads.backendForCoordinate(coordinate, "recorded-query"),
      coordinate,
    );
  }

  #sqlSchema(): SqlSchema {
    return this.#schema ?? createSqlSchema(this.#backend.tableNames);
  }

  /**
   * Internal seam for {@link RecordedStoreView}: reconstruct a node point read
   * from the recorded-time relation while preserving live getById ordering and
   * duplicate-input behavior.
   *
   * @internal
   */
  async recordedNodeGetById<N extends NodeType>(
    kind: string,
    id: NodeId<N>,
    coordinate: ReadCoordinate,
  ): Promise<Node<N> | undefined> {
    return this.#recordedReads.nodeGetById(kind, id, coordinate);
  }

  /**
   * Internal seam for {@link RecordedStoreView}: reconstruct node point reads
   * from the recorded-time relation while preserving input order.
   *
   * @internal
   */
  async recordedNodeGetByIds<N extends NodeType>(
    kind: string,
    ids: readonly NodeId<N>[],
    coordinate: ReadCoordinate,
  ): Promise<readonly (Node<N> | undefined)[]> {
    return this.#recordedReads.nodeGetByIds(kind, ids, coordinate);
  }

  /** @internal Bounded recorded-time node enumeration for RecordedStoreView. */
  async recordedNodeScan<N extends NodeType>(
    kind: string,
    coordinate: ReadCoordinate,
    options?: RecordedScanOptions,
  ): Promise<RecordedScanPage<Node<N>>> {
    return this.#recordedReads.nodeScan(kind, coordinate, options);
  }

  /**
   * Internal seam for {@link RecordedStoreView}: reconstruct an edge point read
   * from the recorded-time relation while preserving live getById behavior.
   *
   * @internal
   */
  async recordedEdgeGetById<E extends AnyEdgeType>(
    kind: string,
    id: EdgeId<E>,
    coordinate: ReadCoordinate,
  ): Promise<Edge<E> | undefined> {
    return this.#recordedReads.edgeGetById(kind, id, coordinate);
  }

  /**
   * Internal seam for {@link RecordedStoreView}: reconstruct edge point reads
   * from the recorded-time relation while preserving input order.
   *
   * @internal
   */
  async recordedEdgeGetByIds<E extends AnyEdgeType>(
    kind: string,
    ids: readonly EdgeId<E>[],
    coordinate: ReadCoordinate,
  ): Promise<readonly (Edge<E> | undefined)[]> {
    return this.#recordedReads.edgeGetByIds(kind, ids, coordinate);
  }

  /** @internal Bounded recorded-time edge enumeration for RecordedStoreView. */
  async recordedEdgeScan<E extends AnyEdgeType>(
    kind: string,
    coordinate: ReadCoordinate,
    options?: RecordedScanOptions,
  ): Promise<RecordedScanPage<Edge<E>>> {
    return this.#recordedReads.edgeScan(kind, coordinate, options);
  }

  // === Temporal Views ===

  /**
   * Returns a read-only {@link StoreView} pinned to a valid-time instant.
   *
   * The view routes every supported read — `nodes` / `edges` collections,
   * `query()`, `subgraph()`, and the graph algorithms — through the
   * `asOf` coordinate, so they observe the graph as it was valid at `T`.
   * Writes stay on the live `Store`. Mirrors Datomic's `(d/as-of db t)`.
   *
   * @example
   * ```typescript
   * const past = store.asOf("2026-01-01T00:00:00.000Z");
   * const alice = await past.nodes.Person.getById(aliceId);
   * const names = await past
   *   .query()
   *   .from("Person", "p")
   *   .whereNode("p", (p) => p.name.eq("Alice"))
   *   .select((ctx) => ctx.p.name)
   *   .execute();
   * ```
   *
   * @param asOf - ISO-8601 timestamp to pin the valid-time coordinate to.
   */
  asOf(asOf: string): StoreView<G> {
    return new StoreView(this, { mode: "asOf", asOf });
  }

  /**
   * Returns a narrow read-only view pinned to a recorded/system-time instant.
   *
   * Direct `store.asOfRecorded(T)` is diagonal bitemporal sugar: it reads the
   * recorded-time relation as of `T` and uses the same `T` for the valid-time
   * axis. Use `store.asOf(validT).asOfRecorded(recordedT)` when the valid and
   * recorded axes should differ.
   *
   * The returned view exposes only reconstructing-safe reads: query,
   * subgraph, graph algorithms, and collection point reads.
   *
   * Prefer `await store.recordedNow()` as the anchor over a wall-clock
   * timestamp: recorded instants are monotonic and can run briefly ahead of the
   * wall clock under bursty writes, so a `new Date().toISOString()` passed here
   * may sort before the most recent commits and silently omit them.
   */
  asOfRecorded(recordedAsOf: RecordedInstant): RecordedStoreView<G> {
    const validCoordinate = resolveReadCoordinate(
      "asOf",
      recordedAsOf,
      "Use await store.recordedNow() as the anchor, or asRecordedInstant(value) only for an instant previously read from recordedNow().",
    );
    return new RecordedStoreView(
      this,
      withRecordedCoordinate(validCoordinate, recordedAsOf),
    );
  }

  /**
   * Returns the latest recorded-time instant captured for this graph — the
   * recorded high-water mark. After guarding the `undefined` case,
   * `store.asOfRecorded(checkpoint)` reconstructs everything committed so far, a
   * deterministic anchor that avoids guessing with the wall clock (recorded
   * instants are monotonic and can run briefly ahead of wall-clock time under
   * bursty writes). Capture each anchor right after the writes it should cover.
   *
   * Returns `undefined` until the first write has been captured, so on a
   * brand-new graph guard the composition — `asOfRecorded(undefined)` rejects
   * (an instant is required) rather than reconstructing an empty view. Read the
   * value first and only pass it to `asOfRecorded` once it is defined.
   *
   * **Graph-global, not caller-scoped.** This is the single high-water mark for
   * the whole graph, advanced by every committed capture from any writer — not
   * a per-write or per-caller value. An advance between two reads means
   * "something committed to this graph in between," *not* "the write this caller
   * just made landed." Do not use a `recordedNow()` advance as a "did my write
   * succeed?" signal: under any concurrent writer to the same graph it both
   * misses dropped writes and misfires on no-op writes. Confirm a specific write
   * by observing the write itself (its return value, or `store.transaction(...)`
   * success), not the global clock.
   */
  async recordedNow(): Promise<RecordedInstant | undefined> {
    if (!this.#captureEnabled) {
      throw new ConfigurationError(
        "recordedNow() requires a store created with { history: true }.",
        { code: "RECORDED_NOW_REQUIRES_HISTORY" },
        {
          suggestion:
            "Create the store with createStore(graph, backend, { history: true }) to enable recorded-time capture.",
        },
      );
    }
    const recordedAt = await withRecordedRelationsPrecondition(
      readRecordedClock(this.#backend, this.#sqlSchema(), this.graphId),
      { dialect: this.#backend.dialect, surface: "recorded-now" },
    );
    // The clock high-water mark is already a canonical recorded instant; brand
    // it so `asOfRecorded` accepts it without the caller re-wrapping.
    return recordedAt === undefined ? undefined : asRecordedInstant(recordedAt);
  }

  /**
   * Returns the durable graph revision used by graph branching. It is undefined
   * until the first successful tracked write, which is itself a stable initial
   * anchor. Unlike {@link recordedNow}, this is also available on a live Store
   * created with `{ revisionTracking: true }`.
   *
   * @internal
   */
  async revisionNow(): Promise<string | undefined> {
    if (!this.#revisionTrackingEnabled) return undefined;
    return readRecordedClock(this.#backend, this.#sqlSchema(), this.graphId);
  }

  /**
   * Returns the durable random namespace for this graph's revision clock. A
   * tracked base token combines it with {@link revisionNow}, preventing a
   * branch from one independent store from matching a coincident timestamp in
   * another store.
   *
   * @internal
   */
  async revisionOriginNow(): Promise<string> {
    if (!this.#revisionTrackingEnabled) {
      throw new ConfigurationError(
        "revisionOriginNow() requires revisionTracking: true or history: true.",
        { code: "REVISION_ORIGIN_REQUIRES_TRACKING" },
      );
    }
    const pendingOrigin =
      this.#revisionOrigin ??
      ensureRevisionOrigin(this.#baseBackend, this.#sqlSchema(), this.graphId);
    this.#revisionOrigin = pendingOrigin;
    try {
      return await pendingOrigin;
    } catch (error) {
      // A transient DDL/connection failure must not permanently poison this
      // Store's cached initialization promise. Preserve a newer in-flight
      // attempt if another caller replaced it before this rejection arrived.
      if (this.#revisionOrigin === pendingOrigin) {
        this.#revisionOrigin = undefined;
      }
      throw error;
    }
  }

  /**
   * Returns a read-only {@link StoreView} pinned to an arbitrary public
   * temporal mode. Use {@link Store.asOf} for the common valid-time case;
   * reach for `view` to pin `"current"`, `"includeEnded"`, or
   * `"includeTombstones"`.
   *
   * @example
   * ```typescript
   * const withTombstones = store.view({ mode: "includeTombstones" });
   * const everyEverVersion = await withTombstones.nodes.Person.find();
   * ```
   *
   * @param coordinate - The `(mode, asOf)` coordinate to pin. `asOf` is
   *   required when `mode` is `"asOf"` and rejected for every other mode.
   */
  view(coordinate: StoreViewCoordinate): StoreView<G> {
    return new StoreView(this, coordinate);
  }

  /**
   * Returns a read-only {@link StoreView} pinned to the current instant,
   * captured once at construction — a stable point-in-time snapshot. Unlike
   * `store.view({ mode: "current" })` (which tracks "now" live and can read
   * different surfaces against slightly different clocks), a snapshot pins one
   * `asOf` timestamp, so every surface observes the same instant. Sugar for
   * `store.asOf(new Date().toISOString())`; mirrors Datomic's `(d/db conn)`.
   *
   * @example
   * ```typescript
   * const snap = store.snapshot();
   * // Every read on `snap` sees the graph as of one fixed instant.
   * const a = await snap.nodes.Person.find();
   * const r = await snap.reachable(rootId, { edges: ["knows"] });
   * ```
   */
  snapshot(): StoreView<G> {
    return this.asOf(nowIso());
  }

  // === Search ===

  /**
   * Search-related operations (fulltext, hybrid, and rebuild).
   *
   * All search methods live under this facade to keep the top-level
   * Store API focused on CRUD + graph traversal. The facade is
   * lazy-initialized and cached for the lifetime of the store.
   *
   * @example
   * ```typescript
   * // Fulltext
   * const hits = await store.search.fulltext("Document", {
   *   query: "climate warming",
   *   limit: 10,
   *   includeSnippets: true,
   * });
   *
   * // Hybrid (vector + fulltext fused with RRF)
   * const ranked = await store.search.hybrid("Document", {
   *   limit: 10,
   *   vector: { fieldPath: "embedding", queryEmbedding: vec },
   *   fulltext: { query: "climate warming" },
   * });
   *
   * // Rebuild index after schema change
   * const stats = await store.search.rebuildFulltext();
   * ```
   */
  get search(): StoreSearch<G> {
    if (this.#search === undefined) {
      this.#search = new StoreSearch<G>({
        graphId: this.graphId,
        backend: this.#backend,
        registry: this.#registry,
        createQuery: () => this.query(),
      });
    }
    return this.#search;
  }

  // === Batch Query Execution ===

  /**
   * Executes multiple queries and returns a typed tuple of results.
   *
   * Each query preserves its own result type, projection, filtering, sorting,
   * and pagination.
   *
   * **Snapshot consistency is conditional.** When
   * `backend.capabilities.transactions` is `true`, queries run sequentially
   * on a single connection inside an implicit transaction and observe the
   * same database snapshot. When transactions are unavailable
   * (Cloudflare D1, `drizzle-orm/neon-http`), queries run sequentially over
   * independent connections and may observe writes that landed between them.
   * Branch on `backend.capabilities.transactions` if you need a guaranteed
   * snapshot.
   *
   * Read-only — use `bulkCreate`, `bulkInsert`, etc. for write batching.
   *
   * @example
   * ```typescript
   * const [people, companies] = await store.batch(
   *   store.query()
   *     .from("Person", "p")
   *     .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name })),
   *   store.query()
   *     .from("Company", "c")
   *     .select((ctx) => ({ id: ctx.c.id, name: ctx.c.name }))
   *     .orderBy("c", "name", "asc")
   *     .limit(5),
   * );
   * // people:    readonly { id: string; name: string }[]
   * // companies: readonly { id: string; name: string }[]
   * ```
   *
   * @param queries - Two or more executable queries (from `.select()` or set operations)
   * @returns A tuple with per-query typed results, preserving input order
   */
  async batch<
    const Queries extends readonly [
      BatchableQuery<unknown>,
      BatchableQuery<unknown>,
      ...BatchableQuery<unknown>[],
    ],
  >(...queries: Queries): Promise<BatchResults<Queries>> {
    // batch() is read-only, so it routes through the uncaptured backend. Going
    // through the capture wrapper would open a recorded-capture transaction
    // scope — which demands executeStatement on the transaction target — for a
    // path that performs no writes and needs no capture.
    return runOptionallyInTransaction(this.#baseBackend, async (target) => {
      const results: unknown[] = [];
      for (const query of queries) {
        const result = await query.executeOn(target);
        results.push(result);
      }
      return results as BatchResults<Queries>;
    });
  }

  // === Subgraph Extraction ===

  /**
   * Extracts a typed subgraph by traversing from a root node.
   *
   * Performs a BFS traversal from `rootId` following the specified edge kinds,
   * returning an indexed result with adjacency maps for immediate traversal.
   *
   * @example
   * ```typescript
   * const sg = await store.subgraph(run.id, {
   *   edges: ["has_task", "runs_agent", "uses_skill"],
   *   maxDepth: 4,
   * });
   *
   * // Root node (the traversal starting point)
   * console.log(sg.root?.kind);
   *
   * // Lookup by ID
   * const task = sg.nodes.get(taskId);
   *
   * // Forward adjacency: edges of a kind from a node
   * const taskEdges = sg.adjacency.get(run.id)?.get("has_task") ?? [];
   *
   * // Reverse adjacency: edges of a kind pointing to a node
   * const parentEdges = sg.reverseAdjacency.get(taskId)?.get("has_task") ?? [];
   * ```
   */
  async subgraph<
    const EK extends EdgeKinds<G>,
    const NK extends NodeKinds<G> = NodeKinds<G>,
    const P extends SubgraphProject<G, NK, EK> | undefined = undefined,
  >(
    rootId: NodeId<AllNodeTypes<G>>,
    options: SubgraphOptions<G, EK, NK, P>,
  ): Promise<SubgraphResult<G, NK, EK, P>> {
    // The public surface is valid-time only (`recordedAsOf` is typed `never`).
    // Guard JS callers who bypass the type so a leaked recorded pin can't
    // silently switch this read onto the recorded relation; recorded subgraph
    // reads come through subgraphAtCoordinate (store.asOfRecorded(...).subgraph).
    assertNoRecordedCoordinate(options, {
      code: "SUBGRAPH_RECORDED_ASOF_INTERNAL_ONLY",
      message:
        "recordedAsOf is only available through store.asOfRecorded(...).subgraph(...).",
      suggestion:
        "Use store.asOfRecorded(recordedAt).subgraph(rootId, options) instead of passing recordedAsOf directly.",
    });
    // After the guard, the public read is just the coordinate path with no
    // recorded pin — delegate so the executeSubgraph wiring lives in one place.
    return this.subgraphAtCoordinate(rootId, options);
  }

  /**
   * Internal seam for {@link StoreView} / {@link RecordedStoreView}: runs a
   * subgraph with a coordinate already flattened into the options (including a
   * recorded/system-time pin). Trusted caller — the public {@link Store.subgraph}
   * is the guarded entry point.
   *
   * @internal
   */
  subgraphAtCoordinate<
    const EK extends EdgeKinds<G>,
    const NK extends NodeKinds<G> = NodeKinds<G>,
    const P extends SubgraphProject<G, NK, EK> | undefined = undefined,
  >(
    rootId: NodeId<AllNodeTypes<G>>,
    options: InternalSubgraphOptions<G, EK, NK, P>,
  ): Promise<SubgraphResult<G, NK, EK, P>> {
    const coordinate = resolveReadCoordinate(
      options.temporalMode ?? this.#graph.defaults.temporalMode,
      options.asOf,
    );
    const readCoordinate =
      options.recordedAsOf === undefined ?
        coordinate
      : withRecordedCoordinate(coordinate, options.recordedAsOf);
    return executeSubgraph({
      graph: this.#graph,
      graphId: this.graphId,
      rootId,
      backend: this.#recordedReads.backendForCoordinate(
        readCoordinate,
        "recorded-subgraph",
      ),
      dialect: getDialect(this.#backend.dialect),
      schema: this.#schema,
      recordedReadBinding: this.#recordedReadBinding,
      options,
    });
  }

  /**
   * Internal seam for StoreView graph algorithms at a pinned coordinate.
   *
   * @internal
   */
  algorithmsAtCoordinate(
    coordinate: ReadCoordinate,
  ): InternalGraphAlgorithms<G> {
    return createGraphAlgorithms<G>({
      graphId: this.graphId,
      graph: this.#graph,
      registry: this.#registry,
      backend: this.#recordedReads.backendForCoordinate(
        coordinate,
        "recorded-graph-algorithm",
      ),
      schema: this.#schema,
      recordedReadBinding: this.#recordedReadBinding,
      defaultTemporalMode: this.#graph.defaults.temporalMode,
      allowRecordedAsOf: coordinate.recorded !== undefined,
    });
  }

  // === Transactions ===

  /**
   * Executes a function within a transaction.
   *
   * The transaction context provides the same collection API as the Store:
   * - `tx.nodes.Person.create(...)` - Create a node
   * - `tx.edges.worksAt.create(...)` - Create an edge
   * - `tx.backend` - a read-only backend projection bound to this transaction
   *
   * {@link AdapterStore} transaction callbacks additionally expose `tx.sql`,
   * the adapter-native handle bound to the same atomic boundary. Branch on
   * `tx.sqlAvailability`: `"available"` carries the handle and `"unavailable"`
   * carries `undefined`. History and revision-tracking contexts make `tx.sql`
   * unusable in their public types; reflective or type-suppressed runtime
   * access throws because raw SQL would bypass capture or the revision anchor.
   * Use typed collections or {@link AdapterStore.withRecordedTransaction} in
   * those modes.
   *
   * @example
   * ```typescript
   * await store.transaction(async (tx) => {
   *   const person = await tx.nodes.Person.create({ name: "Alice" });
   *   const company = await tx.nodes.Company.create({ name: "Acme" });
   *   await tx.edges.worksAt.create(
   *     { kind: "Person", id: person.id },
   *     { kind: "Company", id: company.id },
   *     { role: "Engineer" }
   *   );
   * });
   * ```
   *
   * @example Cross-store write via `tx.sql` (graph-owned boundary):
   * ```typescript
   * await store.transaction(async (tx) => {
   *   await tx.nodes.Document.update(documentId, props);
   *   if (tx.sqlAvailability !== "available") {
   *     throw new Error("This operation requires a SQL-backed transaction");
   *   }
   *   // Narrowing makes the precisely typed native handle available.
   *   const sqlTx = tx.sql as NodePgDatabase;
   *   await sqlTx.insert(documentVersions).values(versionRow);
   * });
   * ```
   *
   * **`tx.sql` shares the one pinned connection — await it, don't overlap it.**
   * TypeGraph serializes the statements *its own* collections issue, so a
   * `Promise.all` of graph writes is safe. A statement you issue through
   * `tx.sql` bypasses that queue: run it concurrently with a graph write (or
   * with another `tx.sql` statement) and two queries race on the one
   * transaction connection — the exact overlap Postgres removes in `pg@9`.
   * Await each `tx.sql` statement before starting the next write. TypeGraph
   * cannot police this: it never sees the raw handle's traffic, so it also
   * cannot drain a raw statement still in flight when the transaction commits.
   *
   * **Backends without transactions.** When `backend.capabilities.transactions`
   * is `false` (Cloudflare D1, `drizzle-orm/neon-http`), this method runs the
   * callback against the same backend used outside `transaction()` — writes
   * are applied as they happen and a thrown error does **not** roll back
   * earlier writes inside the callback. Branch on
   * `backend.capabilities.transactions` if you require atomicity:
   *
   * ```typescript
   * if (backend.capabilities.transactions) {
   *   await store.transaction(async (tx) => { ... });
   * } else {
   *   // sequential, non-atomic — handle partial-failure recovery yourself
   * }
   * ```
   *
   * @param fn The callback run inside the transaction boundary.
   * @param options Optional {@link TransactionOptions} forwarded to the
   *   backend (e.g. `isolationLevel: "serializable"` on Postgres). Backends
   *   without isolation-level support ignore it; the non-transactional
   *   fallback ignores it entirely. Stores created with `{ history: true }`
   *   require read-committed semantics for PostgreSQL recorded-clock capture and
   *   reject stronger snapshot isolation levels.
   */
  transaction<T>(
    this: AdapterHistoryStore<G, TNativeTransaction>,
    fn: (
      tx: AdapterHistoryTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;

  transaction<T>(
    fn: (tx: AdapterTransactionContext<G, TNativeTransaction>) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;

  async transaction<T>(
    fn:
      | ((tx: AdapterTransactionContext<G, TNativeTransaction>) => Promise<T>)
      | ((
          tx: AdapterHistoryTransactionContext<G, TNativeTransaction>,
        ) => Promise<T>),
    options?: TransactionOptions,
  ): Promise<T> {
    const invoke = fn as (
      tx: AdapterTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>;
    const { result } = await this.#runTransaction(invoke, options, undefined);
    return result;
  }

  /**
   * Runs a transaction exactly like {@link transaction} and additionally
   * returns a {@link TransactionOutcome} whose receipt summarizes the
   * completed write intents on the transaction-scoped collection surface.
   *
   * A dedicated method (rather than an option on `transaction()`) keeps the
   * return type tied to static dispatch: forwarding options through wrappers
   * can never change what a call returns. See {@link TransactionReceipt} for
   * exact count semantics.
   *
   * The receipt does not count writes that bypass the `tx.nodes.*` /
   * `tx.edges.*` collections, such as direct backend writes, raw SQL, or
   * import helpers. The adopted-commit sibling
   * {@link AdapterStore.withRecordedTransaction} also returns a
   * {@link TransactionOutcome}; only `withTransaction` (whose commit belongs
   * entirely to the caller with no flush point) produces no receipt. On
   * non-transactional backends, the receipt is still returned, but it describes
   * operations that individually committed rather than one atomic commit; if the
   * callback rejects on such a backend, no receipt is returned even though
   * earlier operations committed individually.
   *
   * For stores created with `{ history: true }`, `receipt.recorded` is the
   * recorded commit instant this transaction allocated for the store's
   * graph, or `undefined` when nothing was captured.
   *
   * The callback receives a {@link MeasurableTransactionContext}: call
   * `tx.measure((scoped) => ...)` to scope a sub-receipt to the writes made
   * through the `scoped` context (e.g. to attribute writes to user code the
   * caller invokes, excluding its own bookkeeping written through `tx`). See
   * {@link MeasurableTransactionContext} for semantics.
   *
   * @example
   * ```typescript
   * const outcome = await store.transactionWithReceipt(async (tx) => {
   *   const alice = await tx.nodes.Person.create({ name: "Alice" });
   *   return alice.id;
   * });
   * outcome.result; // Alice's id
   * outcome.receipt.writes; // { nodes: { Person: 1 }, edges: {}, total: 1 }
   * ```
   */
  transactionWithReceipt<T>(
    this: AdapterHistoryStore<G, TNativeTransaction>,
    fn: (
      tx: MeasurableAdapterHistoryTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<TransactionOutcome<T>>;

  transactionWithReceipt<T>(
    fn: (
      tx: MeasurableAdapterTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<TransactionOutcome<T>>;

  async transactionWithReceipt<T>(
    fn:
      | ((
          tx: MeasurableAdapterTransactionContext<G, TNativeTransaction>,
        ) => Promise<T>)
      | ((
          tx: MeasurableAdapterHistoryTransactionContext<G, TNativeTransaction>,
        ) => Promise<T>),
    options?: TransactionOptions,
  ): Promise<TransactionOutcome<T>> {
    const invoke = fn as (
      tx: AdapterTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>;
    const receiptRecorder = createTransactionReceiptRecorder();
    const { result, recordedByGraph } = await this.#runTransaction(
      invoke,
      options,
      receiptRecorder,
    );
    return transactionOutcome(
      result,
      receiptRecorder,
      recordedByGraph,
      this.graphId,
    );
  }

  async #runTransaction<T>(
    invoke: (
      tx: AdapterTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>,
    backendOptions: TransactionOptions | undefined,
    receiptRecorder: TransactionReceiptRecorder | undefined,
  ): Promise<TransactionRunResult<T>> {
    // Without a real transaction the tx-scoped collections would be
    // bound to the same backend as this.nodes/this.edges and exposing
    // the cached versions avoids rebuilding the proxies on every call.
    // An isolation-level request in the options is equally meaningless here.
    if (!this.#backend.capabilities.transactions) {
      let nodes = this.nodes;
      let edges = this.edges;
      if (receiptRecorder !== undefined) {
        ({ nodes, edges } = wrapTransactionCollections(
          nodes,
          edges,
          receiptRecorder,
        ));
      }
      const fallbackContext: AdapterTransactionContext<G, TNativeTransaction> =
        {
          nodes,
          edges,
          // No real transaction: `tx.sql` is absent and there is no atomicity.
          sqlAvailability: "unavailable",
          backend: createTransactionReadBackend(this.#backend),
          [TRANSACTION_RUNTIME]: {
            backend: this.#backend,
            runNodeOperationHooks: (operation, kind, id, hookedFunction) =>
              this.#withOperationHooks(
                this.#createOperationContext(operation, "node", kind, id),
                hookedFunction,
              ),
          },
          getNodeCollection: (kind: string) =>
            this.#resolveDynamicNodeCollection(nodes, kind),
        };
      Object.defineProperty(fallbackContext, TRANSACTION_RUNTIME, {
        configurable: false,
        enumerable: false,
        writable: false,
      });
      // `measure` on this non-transactional fallback scopes writes that
      // individually committed rather than one atomic commit, mirroring the
      // receipt caveat.
      const result = await invoke(
        receiptRecorder === undefined ? fallbackContext : (
          this.#attachMeasure(fallbackContext)
        ),
      );
      return { result, recordedByGraph: undefined };
    }

    // #134/#135: no gate here. The backend's transaction() wraps the
    // tx-scoped fulltext methods so the durable-marker assert fires at
    // point of use (a cached SELECT, never DDL). A transaction that
    // never touches fulltext requires no fulltext initialization.
    //
    // No per-graph write lock here either: under history capture the lock is
    // taken at each write boundary (runInWriteTransaction before any row work;
    // the recorded overlay before each row write), so a transaction whose
    // callback only reads never serializes against writers. Callers that need
    // read-before-write serialization across the whole callback (provenance
    // transitions) acquire the lock explicitly at callback start.
    //
    // Operation hooks inside the callback run BUFFERED: an operation nested
    // in this transaction completes only when the transaction commits, so its
    // onOperationEnd is held back until after COMMIT — and converted into
    // onError when the transaction fails — keeping "success" synonymous with
    // "durable" even for tx-scoped collection operations.
    const pending: PendingOperationOutcome[] = [];
    const runHooks = this.#createBufferedHookRunner(pending);
    let recordedByGraph: RecordedFlushInstants | undefined;
    const transactionOptions =
      receiptRecorder !== undefined && this.#captureEnabled ?
        withRecordedFlushObserver(backendOptions, (instants) => {
          recordedByGraph = instants;
        })
      : backendOptions;
    try {
      const run = async (
        txBackend: TransactionBackend,
        nativeTransaction: TNativeTransaction | undefined,
      ): Promise<T> =>
        invoke(
          this.#buildTransactionContext(
            txBackend,
            nativeTransaction,
            runHooks,
            receiptRecorder,
          ),
        );
      const result =
        this.#captureEnabled || this.#adapterBackend === undefined ?
          await this.#backend.transaction(
            (txBackend) => run(txBackend, undefined),
            transactionOptions,
          )
        : await this.#adapterBackend.transactionWithNative(
            (txBackend, nativeTransaction) => run(txBackend, nativeTransaction),
            transactionOptions,
          );
      for (const outcome of pending) {
        this.#hooks.onOperationEnd?.(outcome.ctx, {
          durationMs: outcome.durationMs,
        });
      }
      return { result, recordedByGraph };
    } catch (error) {
      const failure = asError(error);
      for (const outcome of pending) {
        this.#hooks.onError?.(outcome.ctx, failure);
      }
      throw error;
    }
  }

  /**
   * Adopts a caller-owned, already-open Drizzle transaction so the graph
   * store and the caller's relational writes commit or roll back as one
   * Postgres/SQLite transaction (#134).
   *
   * Use this when the **relational layer owns the transaction**: the
   * caller has opened a transaction and needs TypeGraph writes enlisted
   * on the *same* connection. Unlike {@link transaction}, this opens no
   * transaction — the caller's transaction is the single commit/rollback
   * boundary.
   *
   * `withTransaction` is driver-agnostic; how the caller opens the
   * transaction is not. **Async drivers** (node-postgres,
   * `neon-serverless` Pool, libsql) use `db.transaction(async …)`.
   * **Synchronous `better-sqlite3`** cannot — its driver rejects an
   * `async` transaction callback (`Transaction function cannot return a
   * promise`) and the async continuation would run outside the
   * rolled-back transaction — so the caller opens the transaction with
   * explicit `BEGIN`/`COMMIT`/`ROLLBACK` on the single connection
   * instead. See the "Cross-Store Transactions" recipe for both shapes.
   *
   * The returned context reuses this store's already-resolved
   * schema/registry: it runs **no** schema bootstrap, `evolve`, or
   * migration, and emits **no DDL** inside the caller's transaction.
   * Fulltext operations assert the durable materialization marker (a
   * cached SELECT) and throw {@link StoreNotInitializedError} on a
   * missing/stale/failed marker rather than migrating mid-transaction —
   * so boot the parent store via `createAdapterStoreWithSchema` once at
   * startup.
   *
   * @example
   * ```typescript
   * // Async driver (Postgres / libsql):
   * await db.transaction(async (sqlTx) => {
   *   const connector = await createConnectorRow(sqlTx, input); // Drizzle
   *   const txStore = store.withTransaction(sqlTx);
   *   await txStore.nodes.ArtifactSource.create({              // TypeGraph
   *     connectorId: connector.id,
   *   });
   * }); // one COMMIT / ROLLBACK across both layers
   * ```
   *
   * **The caller owns the connection — don't overlap writes on it.** The graph
   * store and your Drizzle writes share the one connection the caller's
   * transaction pinned. TypeGraph serializes the statements *its* collections
   * issue, but your raw Drizzle statements (and any graph write run alongside
   * them) are yours to sequence: a `Promise.all` mixing the two races two
   * queries on that connection — the overlap Postgres removes in `pg@9`. Await
   * each write before starting the next.
   *
   * Not available when the store was created with `{ history: true }`: a
   * caller-owned transaction context would let writes happen after capture has
   * lost its flush point. {@link AdapterHistoryStore} omits this method, while
   * the runtime guard still throws `ConfigurationError` if the public contract
   * is bypassed
   * (`RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION`) if the check is
   * suppressed. Use {@link AdapterStore.withRecordedTransaction} on a history-enabled
   * store, which adopts the same external transaction but flushes recorded-time
   * capture before the caller commits.
   *
   * @throws {ConfigurationError} when the store has history capture enabled
   *   (use {@link AdapterStore.withRecordedTransaction} instead), or when the backend
   *   cannot adopt an external transaction — either it is not a Drizzle
   *   Postgres/SQLite backend, or `backend.capabilities.transactions` is `false`
   *   (`drizzle-orm/neon-http`, Cloudflare D1, SQLite
   *   `transactionMode: "none"`). A non-atomic fallback is deliberately
   *   not offered here: the caller's relational write *would* still
   *   commit, defeating the purpose of cross-store atomicity.
   * @throws {StoreNotInitializedError} at point of use, when a fulltext
   *   operation on the returned context observes a missing/stale/failed
   *   durable materialization marker (parent store not booted via
   *   `createAdapterStoreWithSchema`). Rolls back the caller's transaction
   *   without emitting any DDL.
   */
  withTransaction(
    externalTx: TNativeTransaction,
  ): AdapterTransactionContext<G, TNativeTransaction> {
    if (this.#captureEnabled) {
      throw recordedCaptureRequiresCallbackTransactionError();
    }
    const adopt = this.#adapterBackend?.adoptTransaction;
    if (adopt === undefined) {
      throw new ConfigurationError(
        "This backend cannot adopt an external transaction for cross-store " +
          "atomicity. adoptTransaction is provided only by the Drizzle " +
          "Postgres/SQLite backends with transaction support. Check " +
          "backend.capabilities.transactions, or run the relational and " +
          "graph writes as separate transactions with manual compensation.",
        { capability: "adoptTransaction" },
      );
    }
    // The caller already owns the boundary, so `externalTx` *is* the
    // bound handle — surface it as `tx.sql` for symmetry with the
    // graph-owned `transaction()` path.
    return this.#buildTransactionContext(adopt(externalTx), externalTx);
  }

  /**
   * Adopts a caller-owned transaction while giving recorded-time capture a
   * flush point before the caller commits. Required when `history: true` is
   * enabled because returning a long-lived transaction context would let writes
   * happen after TypeGraph has lost the chance to close/open recorded rows.
   *
   * Capture flushes once, when `fn` resolves. The flush seals the capture
   * session, so a graph write made through the transaction context *after* `fn`
   * returns (e.g. retaining `tx` and writing once more before the caller's
   * COMMIT) throws rather than committing uncaptured — the post-flush write
   * cannot silently diverge history from live state. This sealing behavior is
   * unchanged by the receipt return.
   *
   * Returns a {@link TransactionOutcome} — the adopted path is the only way to
   * get exactly-once cursors and graph writes atomically on a history store, so
   * it surfaces the same receipt `transactionWithReceipt` does: `receipt.writes`
   * for drop detection (a non-delete change that wrote nothing) and
   * `receipt.recorded` as the per-transaction replay anchor. Destructure
   * `{ result, receipt }`:
   *
   * ```typescript
   * const { result, receipt } = await store.withRecordedTransaction(
   *   externalTx,
   *   async (tx) => tx.nodes.Document.update(documentId, props),
   * );
   * ```
   *
   * `receipt.recorded` is the recorded commit instant this transaction allocated
   * for the store's graph at the flush point (when `fn` resolved), and is
   * `undefined` when nothing was captured — a read-only `fn`, or a non-history
   * store (where the receipt still counts write intents but there is no recorded
   * time). To attribute writes when `fn` invokes user code that also
   * bookkeeps, use `tx.measure((scoped) => ...)` and have that code write
   * through the `scoped` context (see {@link MeasurableTransactionContext}).
   *
   * Write your own relational tables through the **external transaction handle
   * you passed in** (`externalTx`) — it *is* the pinned connection. `tx.sql` is
   * unavailable here (it is a fail-loud guard under history capture, since raw
   * SQL bypasses recorded-time capture, and `AdapterHistoryTransactionContext` types it
   * `sql?: never`). Writing through `externalTx` is the sanctioned way to get
   * cross-store atomicity on a history-enabled store:
   *
   * ```typescript
   * // Async driver (Postgres / libsql):
   * await db.transaction(async (pgTx) => {
   *   const { receipt } = await store.withRecordedTransaction(pgTx, async (tx) => {
   *     await tx.nodes.Document.update(documentId, props); // graph write
   *   });
   *   await pgTx.insert(streamCursors).values(cursorRow);  // your own table
   * }); // one COMMIT / ROLLBACK across both layers
   * ```
   *
   * The graph writes and your `externalTx` statements share the caller's one
   * pinned connection. TypeGraph serializes the statements its collections
   * issue; sequence your own raw statements (and don't `Promise.all` them with
   * graph writes) so two queries never race on that connection.
   */
  withRecordedTransaction<T>(
    this: AdapterHistoryStore<G, TNativeTransaction>,
    externalTx: TNativeTransaction,
    fn: (
      tx: MeasurableAdapterHistoryTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>,
  ): Promise<TransactionOutcome<T>>;

  withRecordedTransaction<T>(
    externalTx: TNativeTransaction,
    fn: (
      tx: MeasurableAdapterTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>,
  ): Promise<TransactionOutcome<T>>;

  async withRecordedTransaction<T>(
    externalTx: TNativeTransaction,
    fn:
      | ((
          tx: MeasurableAdapterTransactionContext<G, TNativeTransaction>,
        ) => Promise<T>)
      | ((
          tx: MeasurableAdapterHistoryTransactionContext<G, TNativeTransaction>,
        ) => Promise<T>),
  ): Promise<TransactionOutcome<T>> {
    const adopt = this.#adapterBackend?.adoptTransaction;
    if (adopt === undefined) {
      throw new ConfigurationError(
        "This backend cannot adopt an external transaction for recorded-time capture.",
        { capability: "adoptTransaction" },
        {
          suggestion:
            "Use a Drizzle PostgreSQL/SQLite backend with transaction support, or run writes through store.transaction(...).",
        },
      );
    }
    const txBackend = adopt(externalTx);
    if (this.#captureEnabled) {
      await assertRecordedCaptureTransactionIsolation(txBackend);
    }
    // A uniform `flush → RecordedFlushInstants` shape on both branches keeps the
    // outcome-building path identical; the non-history branch has no recorded
    // rows to close, so it flushes to an empty instant map.
    const scope =
      this.#captureEnabled ?
        createRecordedTransactionScope(txBackend, this.#sqlSchema())
      : {
          backend: txBackend,
          flush: (): Promise<RecordedFlushInstants> =>
            Promise.resolve(EMPTY_RECORDED_FLUSH_INSTANTS),
        };
    if (this.#captureEnabled) {
      await lockRecordedGraphWrite(scope.backend, this.graphId);
    }
    const receiptRecorder = createTransactionReceiptRecorder();
    const invoke = fn as (
      tx: AdapterTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>;
    const result = await invoke(
      this.#buildTransactionContext(
        scope.backend,
        externalTx,
        undefined,
        receiptRecorder,
      ),
    );
    // Flush allocates the recorded commit instant for this transaction's graph;
    // `transactionOutcome` reads this store's instant out of the returned map
    // (undefined when nothing was captured) into `receipt.recorded`.
    const recordedByGraph = await scope.flush();
    // Seal the context so a write through a retained `tx` after this returns
    // fails loud instead of persisting a row the snapshotted receipt can't
    // count. Under history capture the capture session already sealed on flush
    // (its guard throws before the live write); this covers the non-history
    // path, which has no capture session.
    if (!this.#captureEnabled) receiptRecorder.seal();
    return transactionOutcome(
      result,
      receiptRecorder,
      recordedByGraph,
      this.graphId,
    );
  }

  /**
   * Decorates a receipt-enabled transaction `context` with `measure`.
   * Attribution is structural: `measure` wraps the context's *own* (already
   * outer-recording) collections a second time with a fresh scope recorder, so a
   * write through the scoped context counts in the scope and — via the inner
   * wrapper it delegates to — the outer receipt, while a write through the outer
   * `context` never reaches the scope recorder. This makes overlapping/concurrent
   * measures safe by construction (each holds its own scope recorder) and lets
   * scopes nest: the scoped context is itself decorated, so `scoped.measure(...)`
   * chains one more wrapper. The scoped context's `getNodeCollection` resolves
   * against the scope-wrapped map too, so dynamic-kind writes are attributed like
   * `scoped.nodes.<Kind>`. The scope receipt's `recorded` is always undefined —
   * the recorded instant is a whole-transaction flush concern.
   */
  #attachMeasure(
    context: AdapterTransactionContext<G, TNativeTransaction>,
  ): MeasurableAdapterTransactionContext<G, TNativeTransaction> {
    const measure: ScopedMeasure<
      MeasurableAdapterTransactionContext<G, TNativeTransaction>
    > = async (fn) => {
      const scopeRecorder = createTransactionReceiptRecorder();
      const { nodes, edges } = wrapTransactionCollections(
        context.nodes,
        context.edges,
        scopeRecorder,
      );
      const scoped = this.#attachMeasure(
        overlayPropertyDescriptors(context, {
          nodes,
          edges,
          getNodeCollection: (kind: string) =>
            this.#resolveDynamicNodeCollection(nodes, kind),
        }),
      );
      const result = await fn(scoped);
      return { result, receipt: scopeRecorder.snapshot() };
    };
    return overlayPropertyDescriptors(context, { measure });
  }

  /**
   * Builds the `{ nodes, edges, sql }` projection bound to a
   * transaction-scoped backend. Shared verbatim by {@link transaction}
   * (TypeGraph opens the tx) and {@link withTransaction} (#134 — the
   * caller opened it) so both surfaces resolve collections, query
   * factories, and the reused graph/registry identically. When history capture
   * is disabled, `sql` is the raw Drizzle handle bound to the same transaction
   * (#140); when history capture is enabled it is replaced with a fail-loud
   * guard because raw graph writes would bypass recorded-time capture.
   */
  #buildTransactionContext(
    txBackend: TransactionBackend,
    sql?: TNativeTransaction,
    runHooks: OperationHookRunner = this.#immediateHookRunner(),
    receiptRecorder?: TransactionReceiptRecorder,
  ): AdapterTransactionContext<G, TNativeTransaction> {
    // No statistics auto-refresh inside a caller-provided transaction:
    // ANALYZE from another connection cannot see the uncommitted rows,
    // so it would only reset the counter without fixing the estimates.
    const txNodeOperations: NodeOperations = {
      ...this.#buildNodeOperations(this.#createNodeOperationContext(runHooks)),
      createQuery: () => this.#createQueryForBackend(txBackend),
      maybeRefreshStatisticsAfterBulk: undefined,
    };
    const txEdgeOperations: EdgeOperations = {
      ...this.#buildEdgeOperations(this.#createEdgeOperationContext(runHooks)),
      createQuery: () => this.#createQueryForBackend(txBackend),
      maybeRefreshStatisticsAfterBulk: undefined,
    };

    const runNodeOperationHooks = <T>(
      operation: "create" | "update" | "delete",
      kind: string,
      id: string,
      fn: () => Promise<T>,
    ): Promise<T> =>
      runHooks(this.#createOperationContext(operation, "node", kind, id), fn);

    let nodes = createNodeCollectionsProxy(
      this.#graph,
      this.graphId,
      this.#registry,
      txBackend,
      txNodeOperations,
    );

    let edges = createEdgeCollectionsProxy(
      this.#graph,
      this.graphId,
      this.#registry,
      txBackend,
      txEdgeOperations,
    );

    if (receiptRecorder !== undefined) {
      ({ nodes, edges } = wrapTransactionCollections(
        nodes,
        edges,
        receiptRecorder,
      ));
    }

    const getNodeCollection = (
      kind: string,
    ): DynamicNodeCollection | undefined =>
      this.#resolveDynamicNodeCollection(nodes, kind);

    // Honest capability discriminant for `tx.sql`. Capture/revision tracking
    // take precedence because they replace `tx.sql` with a fail-loud guard even
    // though the transaction itself is real; only a genuinely absent handle is
    // "unavailable" (this method runs on transactional backends — the
    // non-transactional fallback context is built in #runTransaction).
    const base = {
      nodes,
      edges,
      backend: createTransactionReadBackend(txBackend),
      [TRANSACTION_RUNTIME]: { backend: txBackend, runNodeOperationHooks },
      getNodeCollection,
    };

    let withSql: AdapterTransactionContext<G, TNativeTransaction>;
    if (this.#captureEnabled) {
      withSql = {
        ...base,
        sqlAvailability: "history",
      };
      defineUnavailableSqlGuard(withSql, () => throwHistoryUnsafeSqlAccess());
    } else if (this.#revisionTrackingEnabled) {
      withSql = {
        ...base,
        sqlAvailability: "revisionTracking",
      };
      defineUnavailableSqlGuard(withSql, () =>
        throwRevisionTrackingUnsafeSqlAccess(),
      );
    } else if (sql === undefined) {
      withSql = { ...base, sqlAvailability: "unavailable" };
    } else {
      withSql = { ...base, sql, sqlAvailability: "available" };
    }
    Object.defineProperty(withSql, TRANSACTION_RUNTIME, {
      configurable: false,
      enumerable: false,
      writable: false,
    });

    // Scoped write measurement (`tx.measure`) is only meaningful with a recorder
    // to scope; the plain `transaction()` path stays free of a `measure` the
    // caller has no receiver for.
    return receiptRecorder === undefined ? withSql : (
        this.#attachMeasure(withSql)
      );
  }

  // === Graph Lifecycle ===

  /**
   * Hard-deletes all data for this graph from the database.
   *
   * Removes all nodes, edges, uniqueness entries, embeddings, and schema versions
   * for this graph's ID. No hooks, no per-row logic. Wrapped in a transaction
   * when the backend supports it.
   *
   * The store is usable after clearing — new data can be created immediately.
   */
  async clear(): Promise<void> {
    const doClear = async (
      target: GraphBackend | TransactionBackend,
    ): Promise<void> => {
      if (this.#revisionTrackingEnabled) {
        await lockRecordedGraphWrite(target, this.graphId);
      }
      const previousRevision =
        this.#revisionTrackingEnabled && !this.#captureEnabled ?
          await readRecordedClock(target, this.#sqlSchema(), this.graphId)
        : undefined;
      await target.clearGraph(this.graphId);
      // `clearGraph` deletes the recorded-clock row alongside graph data.
      // Live revision tracking immediately seeds a fresh anchor so a pre-clear
      // branch cannot match a now-empty graph. History capture intentionally
      // preserves its long-standing `recordedNow() === undefined` clear
      // contract; a pre-clear history branch already carries a non-empty clock
      // value and therefore still fails the base-version precondition.
      if (this.#revisionTrackingEnabled && !this.#captureEnabled) {
        await advanceRevisionClock(
          target,
          this.#sqlSchema(),
          this.graphId,
          this.#baseBackend.capabilities.transactions,
          previousRevision,
        );
      }
    };

    await (this.#baseBackend.capabilities.transactions ?
      this.#baseBackend.transaction(async (tx) => doClear(tx))
    : doClear(this.#baseBackend));

    // `clearGraph` is graph-agnostic and can't reach the strategy-owned
    // per-`(kind, field)` vector tables, so reset them here — otherwise cleared
    // embeddings leak and a reused node id would resurface a stale vector.
    await this.#clearVectorStorage();

    // Reset lazy-initialized collection caches
    this.#nodeCollections = undefined;
    this.#edgeCollections = undefined;
    this.#algorithms = undefined;
    this.#search = undefined;
  }

  /**
   * Resets every declared embedding field's per-field storage for this graph by
   * dropping and recreating it empty. Drop+recreate (rather than DELETE) mirrors
   * `reembedVectorField` and keeps the backend's storage-ensure latch valid: the
   * table still exists after clear, so a later write finds it. Enumerated from
   * the in-memory registry (not the DB schema, which `clearGraph` just wiped).
   */
  async #clearVectorStorage(): Promise<void> {
    const backend = this.#baseBackend;
    const strategy = backend.vectorStrategy;
    if (strategy === undefined || backend.executeDdl === undefined) return;

    for (const [nodeKind, nodeType] of this.#registry.nodeKinds) {
      for (const field of resolveEmbeddingFields(nodeType.schema)) {
        const slot: VectorSlot = {
          graphId: this.graphId,
          nodeKind,
          fieldPath: field.fieldPath,
          dimensions: field.dimensions,
          metric: field.metric,
          indexType: field.indexType,
        };
        for (const ddl of strategy.buildDropStorage(slot)) {
          await backend.executeDdl(ddl);
        }
        for (const contribution of strategy.ownedTables(slot)) {
          for (const ddl of contribution.createDdl) {
            await backend.executeDdl(ddl);
          }
        }
      }
    }
  }

  // === Lifecycle ===

  /**
   * Refreshes the backend's query-planner statistics.
   *
   * Call this once after a large initial import or bulk backfill. The
   * planner uses table statistics to choose between TypeGraph's
   * multi-column indexes; without fresh stats a forward traversal can
   * pick a reverse index and run an order of magnitude slower than
   * needed. Autovacuum / background statistics will catch up
   * eventually, but calling this explicitly after a bulk load gives
   * you correct latencies immediately.
   *
   * Implementations:
   * - SQLite runs `ANALYZE`, populating `sqlite_stat1`
   * - PostgreSQL runs `ANALYZE` on the TypeGraph-managed tables
   *
   * Costs a few tens of milliseconds at the sizes this library is
   * designed for. Safe to call at any time.
   *
   * @example
   * ```typescript
   * // After a bulk import
   * for (const batch of batches) {
   *   await store.nodes.Document.bulkCreate(batch);
   * }
   * await store.refreshStatistics();
   * ```
   */
  async refreshStatistics(): Promise<void> {
    await this.#backend.refreshStatistics();
  }

  /**
   * Evolves the graph at runtime by merging a graph extension into the
   * current schema, atomically committing a new schema version, and
   * returning a fresh `Store` constructed against the merged graph.
   *
   * The `Store` is immutable — its registry, collections, and operation
   * contexts close over the graph at construction time — so callers
   * must use the returned store (or pass a `ref` to be re-pointed) for
   * any work involving the new kinds.
   *
   * **Cost for purely additive extensions is proportional to schema
   * document size, not row count.** The commit is a single CAS write.
   * Tightening changes against existing graph-extension-declared kinds run
   * row-count probes for those affected kinds so populated kinds can
   * be rejected without a backfill.
   *
   * **Concurrent evolve recovery.** On `StaleVersionError`, refetch the
   * current active schema (or dereference your `StoreRef`),
   * reconstruct your `Store`, and re-call `evolve(extension)` against
   * the new store. Re-validation may now surface deterministic errors
   * (e.g., another caller just added a kind that collides with yours,
   * or redeclared one of yours with a different shape). Don't loop
   * blindly — surface the error.
   *
   * @param extension - Graph extension produced by
   *   `defineGraphExtension(...)`.
   * @param options.ref - Optional handle whose `current` is overwritten
   *   atomically with the schema commit. Long-lived consumers
   *   (request handlers, background workers) that dereference through
   *   the ref see the new kinds on the *next* call.
   *
   * @throws {GraphExtensionValidationError} when the extension is
   *   structurally invalid.
   * @throws {KindCollisionError} when an extension kind shadows a
   *   compile-time kind (code `KIND_COLLISION`).
   * @throws {IncompatibleChangeError} when a redeclared kind narrows
   *   in a way the existing rows can't satisfy
   *   (code `INCOMPATIBLE_CHANGE`).
   * @throws {GraphExtensionUnresolvedEndpointError} when an edge
   *   endpoint references a kind that exists in neither the extension
   *   nor the host graph
   *   (code `GRAPH_EXTENSION_UNRESOLVED_ENDPOINT`).
   * @throws {StaleVersionError} when another writer has advanced the
   *   schema since this store was constructed; recovery as above.
   * @throws {SchemaContentConflictError} when a row already exists at
   *   the target version with a different content hash.
   */
  async evolve<TRefStore extends StoreCore<G>>(
    extension: GraphExtension,
    options?: Readonly<{
      ref?: StoreRef<TRefStore>;
      /**
       * When set, automatically run `materializeIndexes()` on the new
       * Store after the schema commit succeeds. Pass `{}` for default
       * behavior (all declared indexes, best-effort) or a populated
       * options object for finer control. Omit to defer materialization
       * to a later `materializeIndexes()` call.
       *
       * The schema-version write is NOT rolled back if materialization
       * produces failed entries — failure surfaces as
       * `EagerMaterializationError` thrown AFTER the new Store is
       * constructed and `ref.current` is updated, so the caller can
       * recover via the ref handle.
       */
      eager?: MaterializeIndexesOptions;
    }>,
  ): Promise<StoreImplementation<G, TNativeTransaction>> {
    // Catch up to the persisted state first (extension AND deprecated
    // set). Without this, a stale store applying an extension on top
    // of an out-of-date baseline would make ensureSchema diff against
    // the persisted schema and either treat missing-locally kinds as
    // removed (breaking MigrationError) or silently drop another
    // writer's deprecation flags. The CAS guard inside
    // commitSchemaVersion still serializes the actual commit. If the
    // stored extension redefines a local extension kind with a
    // different shape, classifyModifications throws
    // IncompatibleChangeError here — surfacing the divergence rather
    // than overwriting.
    const { activeRow, baseline } = await this.#loadCaughtUp("evolve");

    // Merge first so the "I evolved with the same extension again"
    // hot path short-circuits before we walk every property in
    // `classifyModifications`. The merge itself canonicalEqual-checks
    // and returns the input graph unchanged for no-op re-evolves.
    const merged = mergeGraphExtension(baseline, extension);

    // No-op evolve (extension already applied to the persisted state):
    // skip the schema commit. We compare against `baseline` (the
    // caught-up graph), not `this.#graph` (the local one). When
    // another writer has just committed the same extension, the local
    // store is stale — `baseline !== this.#graph` — but the merge is
    // still a structural no-op, so re-committing would only churn the
    // schema version. When the local store is also fresh
    // (`baseline === this.#graph`) we return `this` so repeated
    // `evolve(sameExt)` calls keep warm registry,
    // collection, and query caches; otherwise we return a clone
    // wrapping the caught-up baseline so `introspect()` reflects the
    // persisted version. Eager still runs in either case because the
    // contract is "schema committed AND indexes materialized" — the
    // local DB may have unmaterialized indexes even when the local
    // graph hasn't changed (restart-parity flow, prior failed
    // materialize).
    if (merged === baseline) {
      if (baseline === this.#graph) {
        syncStoreReplacementRef(options?.ref, this);
        if (options?.eager !== undefined) {
          await this.#runEagerOrThrow(this, options.eager);
        }
        return this;
      }
      const caughtUp = this.#cloneWithGraph(
        baseline,
        options?.ref,
        schemaMetadataFromRow(activeRow),
      );
      if (options?.eager !== undefined) {
        await this.#runEagerOrThrow(caughtUp, options.eager);
      }
      return caughtUp;
    }

    // Classification gates the schema commit. Same-shape re-evolves
    // already short-circuited above; here we know there's at least
    // one delta. Additive changes produce `allowed` deltas (no entry);
    // tightening changes produce `requireEmpty` entries that we
    // promote to incompatible only when the kind has rows; genuinely
    // incompatible changes (REMOVE_PROPERTY, TYPE_CHANGE) are
    // rejected unconditionally.
    const baselineDocument = baseline.extension ?? Object.freeze({});
    const classification = classifyModifications(baselineDocument, extension);
    if (classification.incompatible.length > 0) {
      throw new IncompatibleChangeError(
        classification.incompatible,
        this.graphId,
      );
    }
    if (classification.requireEmpty.length > 0) {
      const nonEmpty = await this.#probeEmptyKinds(classification.requireEmpty);
      const error = buildIncompatibleChangeError(
        classification,
        nonEmpty,
        this.graphId,
      );
      if (error !== undefined) throw error;
    }

    // Commit via `commitNewSchemaVersion` directly (the row-returning
    // sibling of `migrateSchema`). The classification step above is the
    // authoritative compatibility gate — `ensureSchema`'s
    // `isBackwardsCompatible` check would over-restrict ADD-required-
    // on-empty / TIGHTEN-on-empty modifications that the classifier
    // already approved.
    const committed = await commitNewSchemaVersion(
      this.#backend,
      merged,
      activeRow.version,
    );
    // Provision per-field vector tables + durable markers for any embedding
    // fields this evolution introduced (idempotent for fields that already
    // existed). `evolve()` is a privileged migrator path — it commits schema
    // versions and runs index DDL in eager mode — so emitting the table DDL
    // here mirrors how `createStoreWithSchema` provisions at first boot, and
    // keeps a runtime write to a freshly-added embedding field from hitting
    // an unmaterialized slot. The shared fulltext table needs no such step
    // (one table for all kinds); vectors are per-`(kind, field)`.
    await materializeVectorContributions(this.#backend, merged);
    const evolved = this.#cloneWithGraph(
      merged,
      options?.ref,
      schemaMetadataFromRow(committed),
    );
    if (options?.eager !== undefined) {
      await this.#runEagerOrThrow(evolved, options.eager);
    }
    return evolved;
  }

  async #runEagerOrThrow(
    store: StoreImplementation<G, TNativeTransaction>,
    eager: MaterializeIndexesOptions,
  ): Promise<void> {
    const result = await store.materializeIndexes(eager);
    if (result.results.some((entry) => entry.status === "failed")) {
      throw new EagerMaterializationError(result, this.graphId);
    }
  }

  /**
   * Marks the named node and edge kinds as soft-deprecated. Surfaces in
   * `store.introspect().deprecatedKinds` for introspection (codegen,
   * UI tooling, lints) but does not gate reads, writes, or queries —
   * deprecation is a signal, not a removal.
   *
   * Atomically commits a new schema version through the same primitive
   * `evolve()` uses, so concurrent deprecate/evolve calls produce
   * `StaleVersionError | SchemaContentConflictError` race losers that
   * the caller refetches and retries. Idempotent: re-deprecating a
   * kind that's already marked is a no-op (no version bump).
   *
   * @param names - Node or edge kind names to mark as deprecated.
   * @param options.ref - Optional handle to be re-pointed atomically
   *   with the schema commit, mirroring `evolve()`.
   *
   * @throws {ConfigurationError} on `DEPRECATE_BEFORE_INITIALIZE` (no
   *   schema yet) or `DEPRECATE_UNKNOWN_KIND` (name not on the graph).
   * @throws {StaleVersionError} when another writer has advanced the
   *   schema since this store was constructed; refetch and retry per
   *   the same recipe `evolve()` documents.
   * @throws {SchemaContentConflictError} when a row already exists at
   *   the target version with a different content hash.
   */
  async deprecateKinds<TRefStore extends StoreCore<G>>(
    names: readonly string[],
    options?: Readonly<{ ref?: StoreRef<TRefStore> }>,
  ): Promise<StoreImplementation<G, TNativeTransaction>> {
    return this.#updateDeprecatedKinds("add", names, options);
  }

  /**
   * Reverses `deprecateKinds(...)` for the named kinds. Same race +
   * idempotency semantics: removing a name that isn't currently
   * deprecated is a no-op for that name (the call as a whole is a
   * no-op only if every name was already absent).
   *
   * @param names - Node or edge kind names to remove from the
   *   deprecated set.
   * @param options.ref - Optional handle to be re-pointed atomically
   *   with the schema commit.
   *
   * @throws {ConfigurationError} on `DEPRECATE_BEFORE_INITIALIZE`.
   * @throws {StaleVersionError} on a CAS race with another writer.
   * @throws {SchemaContentConflictError} on a same-version content
   *   conflict.
   */
  async undeprecateKinds<TRefStore extends StoreCore<G>>(
    names: readonly string[],
    options?: Readonly<{ ref?: StoreRef<TRefStore> }>,
  ): Promise<StoreImplementation<G, TNativeTransaction>> {
    return this.#updateDeprecatedKinds("remove", names, options);
  }

  /**
   * Runs `CREATE INDEX` DDL for the indexes declared on this graph and
   * records per-deployment status in `typegraph_index_materializations`.
   * The status table is per-database (two replicas of the same
   * `schema_doc` are still two different databases for DDL purposes),
   * so the same call against two replicas materializes independently.
   *
   * Idempotent. Re-running the verb against an already-materialized
   * index is a no-op (`status: "alreadyMaterialized"`). Postgres uses
   * `CREATE INDEX CONCURRENTLY` so live tables never take an
   * `AccessExclusiveLock`. SQLite is single-writer regardless.
   *
   * Best-effort by default: a failed index records `status: "failed"`
   * with the error and the loop continues. Pass `{ stopOnError: true }`
   * to halt on the first failure.
   *
   * @param options.kinds - Restrict to indexes whose `kind` is in this
   *   set. Throws `ConfigurationError` (`code:
   *   "MATERIALIZE_UNKNOWN_KIND"`) if any name doesn't match a known
   *   compile-time or extension kind.
   * @param options.stopOnError - Halt on first failure. Default false.
   *
   * @throws {ConfigurationError} `MATERIALIZE_BACKEND_UNSUPPORTED` if
   *   the backend lacks `executeDdl`, `getIndexMaterialization`, or
   *   `recordIndexMaterialization`; `MATERIALIZE_UNKNOWN_KIND` for an
   *   unknown kind name; `MATERIALIZE_BEFORE_INITIALIZE` if the store
   *   has no schema yet.
   */
  async materializeIndexes(
    options?: MaterializeIndexesOptions,
  ): Promise<MaterializeIndexesResult> {
    const { activeRow, baseline } = await this.#loadCaughtUp("materialize");
    return materializeIndexesImpl(
      {
        graph: baseline,
        graphId: this.graphId,
        backend: this.#baseBackend,
        schemaVersion: activeRow.version,
      },
      options ?? {},
    );
  }

  /**
   * Materializes TypeGraph's own base-relation indexes
   * (`SYSTEM_INDEX_DECLARATIONS`) against the live database.
   *
   * Bootstrap DDL runs only on first boot, so a system index shipped in a
   * newer library version never reaches an already-initialized database on
   * its own. `createStoreWithSchema` runs this automatically; deployments
   * that boot with plain `createStore` / `createVerifiedStore` (zero-DDL by
   * contract) adopt new system indexes by calling this once under a role
   * that may run DDL. Same status-table, drift-signature, and Postgres
   * `CREATE INDEX CONCURRENTLY` claim semantics as `materializeIndexes`.
   */
  async materializeSystemIndexes(
    options?: MaterializeSystemIndexesOptions,
  ): Promise<MaterializeIndexesResult> {
    const { activeRow } = await this.#loadCaughtUp("materialize");
    return materializeSystemIndexesImpl(
      {
        backend: this.#baseBackend,
        graphId: this.graphId,
        schemaVersion: activeRow.version,
      },
      options ?? {},
    );
  }

  /**
   * Recreate a vector field's per-field storage at its current declared
   * dimension, then optionally re-embed existing rows.
   *
   * Use this after changing a field's `embedding(N)` to `embedding(M)` (e.g. a
   * new embedding model): the stored N-dim vectors are invalid under the new
   * dimension and must be recomputed, not converted. This drops and recreates
   * the per-`(graphId, kind, field)` table at the new dimension — a brief
   * window where the field returns no vector hits — resets its materialization
   * marker, then, when `options.embed` is supplied, pages the kind's nodes,
   * calls `embed(batch)`, and upserts the returned vectors. Without `embed`,
   * storage is recreated empty and the caller re-embeds via normal
   * `update()` / `upsertEmbedding` writes.
   *
   * @throws {ConfigurationError} when the backend has no vector strategy or
   *   cannot execute DDL, or `(kind, fieldPath)` is not a declared embedding.
   */
  async reembedVectorField(
    kind: string,
    fieldPath: string,
    options?: ReembedVectorFieldOptions,
  ): Promise<ReembedVectorFieldResult> {
    // Validate up front, before any drop/recreate side effects.
    if (
      options?.batchSize !== undefined &&
      (!Number.isInteger(options.batchSize) || options.batchSize <= 0)
    ) {
      throw new RangeError(
        `reembedVectorField batchSize must be a positive integer, got: ${options.batchSize}`,
      );
    }
    const { activeRow, baseline } = await this.#loadCaughtUp("reembed");
    const backend = this.#baseBackend;
    const strategy = backend.vectorStrategy;
    if (strategy === undefined || backend.executeDdl === undefined) {
      throw new ConfigurationError(
        "reembedVectorField requires a backend with a vector strategy and executeDdl.",
        {
          backend: backend.dialect,
          capability: "vector",
          operation: "reembed",
        },
      );
    }
    const declaration = (baseline.indexes ?? []).find(
      (candidate): candidate is VectorIndexDeclaration =>
        candidate.entity === "vector" &&
        candidate.kind === kind &&
        candidate.fieldPath === fieldPath,
    );
    if (declaration === undefined) {
      throw new ConfigurationError(
        `No embedding field "${kind}.${fieldPath}" is declared in the active schema.`,
        { kind, fieldPath, operation: "reembed" },
      );
    }

    const slot: VectorSlot = {
      graphId: this.graphId,
      nodeKind: kind,
      fieldPath,
      dimensions: declaration.dimensions,
      metric: declaration.metric,
      indexType: declaration.indexType,
    };

    // Recreate storage at the new dimension: drop, then re-create the per-
    // field table the strategy owns (libSQL/sqlite-vec also (re)create their
    // index/vtable here; pgvector's index is built via createVectorIndex
    // below). `ensureVectorSlotContribution({ force: true })` re-runs the
    // table DDL AND re-stamps the durable contribution marker at the new
    // signature, bypassing the drift-guard — this is the sanctioned shape
    // change. Without the marker reset, the post-reembed runtime assert would
    // see a stale marker and refuse every write. Backends without the marker
    // method (custom, pre-#135) fall back to raw recreate DDL.
    for (const ddl of strategy.buildDropStorage(slot)) {
      await backend.executeDdl(ddl);
    }
    if (backend.ensureVectorSlotContribution === undefined) {
      for (const contribution of strategy.ownedTables(slot)) {
        for (const ddl of contribution.createDdl) {
          await backend.executeDdl(ddl);
        }
      }
    } else {
      await backend.ensureVectorSlotContribution(slot, { force: true });
    }

    // Whether this backend would actually materialize an ANN index for the
    // declared slot — brute-force-only ("none") slots and index types the
    // backend doesn't advertise are skipped. Gates both the index (re)build
    // and the materialization-marker reset below so they stay in lockstep.
    const declaredIndexMaterializes =
      declaration.indexType !== "none" &&
      backend.capabilities.vector?.indexTypes.includes(
        declaration.indexType,
      ) === true;

    // (Re)build the ANN index with the field's DECLARED tuning. The table was
    // just recreated above, so createVectorIndex's own ensure is a safe no-op
    // even if the latch is stale.
    if (declaredIndexMaterializes && backend.createVectorIndex !== undefined) {
      await backend.createVectorIndex({
        graphId: this.graphId,
        nodeKind: kind,
        fieldPath,
        dimensions: declaration.dimensions,
        metric: declaration.metric,
        indexType: declaration.indexType,
        indexParams: {
          m: declaration.indexParams.m,
          efConstruction: declaration.indexParams.efConstruction,
          ...(declaration.indexParams.lists === undefined ?
            {}
          : { lists: declaration.indexParams.lists }),
        },
      });
    }

    // Reset the index-materialization marker so a later materializeIndexes()
    // sees the new-dimension signature as already materialized, not as drift.
    if (
      declaredIndexMaterializes &&
      backend.recordIndexMaterialization !== undefined
    ) {
      const tableName = strategy.tableName(this.graphId, kind, fieldPath);
      const signature = await computeIndexSignature(
        backend.dialect,
        tableName,
        declaration,
      );
      const now = nowIso();
      await backend.recordIndexMaterialization({
        indexName: vectorStatusKey(this.graphId, declaration.name),
        graphId: this.graphId,
        entity: "vector",
        kind,
        signature,
        schemaVersion: activeRow.version,
        attemptedAt: now,
        materializedAt: now,
        error: undefined,
      });
    }

    if (options?.embed === undefined) {
      return { recreated: true, reembedded: 0 };
    }

    if (backend.upsertEmbedding === undefined) {
      throw new ConfigurationError(
        "reembedVectorField with an `embed` callback requires a backend that supports upsertEmbedding.",
        {
          backend: backend.dialect,
          capability: "vector",
          operation: "reembed",
        },
      );
    }

    // Re-embed: page the kind's nodes, compute vectors, upsert. Offset paging
    // is stable because upserts target the per-field table, not the nodes table.
    const upsertEmbedding = backend.upsertEmbedding;
    const batchSize = options.batchSize ?? DEFAULT_REEMBED_BATCH_SIZE;
    const collection = this.getNodeCollectionOrThrow(kind);
    let reembedded = 0;
    let offset = 0;
    for (;;) {
      const batch = (await collection.find({
        limit: batchSize,
        offset,
      })) as readonly Node[];
      if (batch.length === 0) break;
      const vectors = await options.embed(batch);
      for (const node of batch) {
        const embedding = vectors.get(node.id);
        if (embedding === undefined) continue;
        await upsertEmbedding({
          graphId: this.graphId,
          nodeKind: kind,
          nodeId: node.id,
          fieldPath,
          embedding,
          dimensions: declaration.dimensions,
          metric: declaration.metric,
          indexType: declaration.indexType,
        });
        reembedded += 1;
      }
      offset += batch.length;
      if (batch.length < batchSize) break;
    }
    return { recreated: true, reembedded };
  }

  /**
   * Removes extension kinds from the schema with cascading edge and
   * ontology cleanup. Two-phase by design:
   *
   *   1. **Schema commit (this method).** Validates the removal,
   *      rebuilds the persisted extension without the named kinds
   *      (and without extension edges that lose their last endpoint),
   *      CAS-commits the new schema version, and queues
   *      per-deployment data-cleanup status. Millisecond budget.
   *   2. **Data cleanup (`materializeRemovals`).** Deletes the orphan
   *      rows from the nodes/edges tables. Bounded by row count.
   *
   * Pass `{ eager: {} }` to run the data-cleanup pass inline with
   * default options, or `{ eager: { ... } }` to scope it; otherwise
   * call `materializeRemovals()` later.
   *
   * Idempotent: removing a name that doesn't exist is a no-op (no
   * version bump). Removing an extension kind referenced by a compile-
   * time edge or ontology relation throws `KindHasReferentsError`.
   * Removing a compile-time kind throws `RemoveCompileTimeKindError` —
   * compile-time kinds are removed by recompiling and redeploying.
   *
   * @throws {RemoveCompileTimeKindError} when `names` includes a
   *   compile-time kind.
   * @throws {KindHasReferentsError} when an extension kind being
   *   removed is referenced by a compile-time declaration.
   * @throws {StaleVersionError} on a CAS race with another writer.
   * @throws {SchemaContentConflictError} on a same-version content
   *   conflict.
   */
  async removeKinds<TRefStore extends StoreCore<G>>(
    names: readonly string[],
    options?: Readonly<{
      ref?: StoreRef<TRefStore>;
      eager?: MaterializeRemovalsOptions;
    }>,
  ): Promise<StoreImplementation<G, TNativeTransaction>> {
    const { activeRow, baseline } = await this.#loadCaughtUp("remove");
    const plan = planRemovals(baseline, names);

    // True no-op: every name was either absent or already removed.
    // Mirrors the (un)deprecateKinds same-set short-circuit.
    if (
      plan.removedNodeKinds.length === 0 &&
      plan.removedEdgeKinds.length === 0
    ) {
      if (baseline === this.#graph) {
        syncStoreReplacementRef(options?.ref, this);
        return this;
      }
      return this.#cloneWithGraph(
        baseline,
        options?.ref,
        schemaMetadataFromRow(activeRow),
      );
    }

    // Build the post-removal graph: rebuild from the new
    // extension by re-applying the merge against the host
    // graph's compile-time slice. Take the host's compile-time
    // graph (the `Store<G>`'s original `#graph` minus extension
    // kinds) and merge the planned extension on top of it.
    const compileTimeGraph = stripGraphExtension(this.#graph);
    const merged =
      plan.document === undefined ?
        compileTimeGraph
      : mergeGraphExtension(compileTimeGraph, plan.document);
    const finalGraph = applyDeprecatedKinds(merged, baseline.deprecatedKinds);

    // Atomic schema commit via the lower-level `migrateSchema`
    // primitive — `ensureSchema`'s breaking-change check would
    // reject the kind removal as a destructive diff. The removal IS
    // destructive by design; that's why removeKinds is a separate
    // verb. Concurrent commits surface as `StaleVersionError` from
    // `commitSchemaVersion` (CAS check).
    const committedRow = await commitNewSchemaVersion(
      this.#backend,
      finalGraph,
      activeRow.version,
    );

    // Queue per-deployment data-cleanup status — one row per removed
    // kind. The status table is best-effort: if recordKindRemoval
    // throws, the schema commit is already done and the rows just
    // become invisible (queries against the kind go through the new
    // store). Operators reconcile via materializeRemovals later.
    const recordKindRemoval = this.#backend.recordKindRemoval;
    if (recordKindRemoval !== undefined) {
      if (this.#backend.ensureKindRemovalsTable !== undefined) {
        await this.#backend.ensureKindRemovalsTable();
      }
      const attemptedAt = nowIso();
      const newSchemaVersion = committedRow.version;
      const queue = (kindName: string, entity: KindEntity): Promise<void> =>
        recordKindRemoval(
          buildPendingKindRemoval({
            graphId: this.graphId,
            kindName,
            entity,
            schemaVersion: newSchemaVersion,
            attemptedAt,
          }),
        );
      // Independent rows on independent primary keys — issue in parallel.
      // For typical cascades (one kind + a few edges) this drops the
      // schema-commit budget by 30-100ms on Postgres.
      await Promise.all([
        ...plan.removedNodeKinds.map((name) => queue(name, "node")),
        ...plan.removedEdgeKinds.map((name) => queue(name, "edge")),
      ]);
    }

    const evolved = this.#cloneWithGraph(
      finalGraph,
      options?.ref,
      schemaMetadataFromRow(committedRow),
    );
    if (options?.eager !== undefined) {
      // Scope to just the kinds removed by THIS call (other pending
      // removals from prior calls aren't this caller's concern).
      const kinds = [...plan.removedNodeKinds, ...plan.removedEdgeKinds];
      await evolved.materializeRemovals({
        ...options.eager,
        kinds: options.eager.kinds ?? kinds,
      });
    }
    return evolved;
  }

  /**
   * Runs the data-cleanup phase for any kinds removed via
   * `removeKinds()` whose data has not yet been deleted on this
   * deployment. Safe to call repeatedly; idempotent.
   */
  async materializeRemovals(
    options?: MaterializeRemovalsOptions,
  ): Promise<MaterializeRemovalsResult> {
    return materializeRemovalsImpl(
      {
        graphId: this.graphId,
        backend: this.#baseBackend,
        captureRecordedRemovals: this.#captureEnabled,
        ...(this.#captureEnabled && { recordedSchema: this.#sqlSchema() }),
      },
      options ?? {},
    );
  }

  async #updateDeprecatedKinds<TRefStore extends StoreCore<G>>(
    direction: "add" | "remove",
    names: readonly string[],
    options: Readonly<{ ref?: StoreRef<TRefStore> }> | undefined,
  ): Promise<StoreImplementation<G, TNativeTransaction>> {
    const verb = direction === "add" ? "deprecate" : "undeprecate";
    const { activeRow, storedSchema, baseline } =
      await this.#loadCaughtUp(verb);
    const nextSet = new Set(baseline.deprecatedKinds);

    if (direction === "add") {
      for (const name of names) {
        if (!isKnownKind(baseline, name)) {
          // Deprecate accepts either node OR edge kinds — the runtime
          // kind type is reported as "node" here for the error
          // message default; consumers branch on `kindName` not
          // `entity` for this code path.
          throw new KindNotFoundError(
            name,
            isKnownEdgeKind(baseline, name) ? "edge" : "node",
            {
              graphId: this.graphId,
              suggestion:
                "Only kinds declared on the graph (compile-time or runtime) can be deprecated.",
            },
          );
        }
        nextSet.add(name);
      }
    } else {
      for (const name of names) nextSet.delete(name);
    }

    if (setsEqual(nextSet, baseline.deprecatedKinds)) {
      // True no-op only when the catch-up didn't change anything
      // either. Otherwise the caller's `this` reference is stale
      // relative to the persisted state — return a clone of the
      // caught-up baseline so they pick up another writer's
      // extension kinds and deprecation flags.
      if (baseline === this.#graph) {
        syncStoreReplacementRef(options?.ref, this);
        return this;
      }
      return this.#cloneWithGraph(
        baseline,
        options?.ref,
        schemaMetadataFromRow(activeRow),
      );
    }

    const merged = applyDeprecatedKinds(baseline, nextSet);
    const result = await ensureSchemaImpl(this.#backend, merged, {
      preloaded: { activeRow, storedSchema },
      autoMigrate: true,
    });
    // Use the committed row from the migration result when available,
    // skipping the post-commit `getActiveSchema` round-trip. The
    // `unchanged` / `pending` / `breaking` branches don't write a new
    // version, so the existing `activeRow` metadata is still authoritative.
    const metadata =
      result.status === "migrated" || result.status === "initialized" ?
        schemaMetadataFromRow(result.committedRow)
      : schemaMetadataFromRow(activeRow);
    return this.#cloneWithGraph(merged, options?.ref, metadata);
  }

  #catchUpToStored(storedSchema: SerializedSchema): G {
    // Strip the local extension slice before re-applying the persisted
    // extension. Otherwise a stale store whose `this.#graph` carries
    // extension kinds another writer has since removed would resurrect
    // them: `unionDocuments` unions local extension nodes/edges back in,
    // and the absent-from-stored kinds win the spread. Stripping first
    // makes the merge a function of the persisted document alone, so
    // removeKinds on one store cannot be silently undone by a stale peer.
    const compileTimeGraph = stripGraphExtension(this.#graph);
    const withGraphExtension =
      storedSchema.extension === undefined ?
        compileTimeGraph
      : mergeGraphExtension(compileTimeGraph, storedSchema.extension);
    return applyDeprecatedKinds(
      withGraphExtension,
      storedSchema.deprecatedKinds,
    );
  }

  /**
   * Loads the active schema row, parses it, and catches the in-memory
   * graph up to the persisted state — the shared preamble for
   * `evolve`, `materializeIndexes`, and `(un)deprecateKinds`.
   *
   * Throws `ConfigurationError` with a verb-specific code when the
   * graph has not been initialized yet. The catch-up step replays the
   * persisted graph-extension document and deprecation set on top of the
   * compile-time graph so we diff against the same baseline another
   * writer would; the CAS guard inside `commitSchemaVersion` still
   * serializes the actual commit.
   */
  async #loadCaughtUp(verb: CaughtUpVerb): Promise<{
    activeRow: SchemaVersionRow;
    storedSchema: SerializedSchema;
    baseline: G;
  }> {
    const activeRow = await loadActiveSchemaWithBootstrap(
      this.#backend,
      this.graphId,
    );
    if (activeRow === undefined) {
      const { phrase, code } = CAUGHT_UP_VERB_DETAILS[verb];
      throw new ConfigurationError(
        `Cannot ${phrase} graph "${this.graphId}": no schema has been initialized. Call createStoreWithSchema first.`,
        { code },
      );
    }
    const storedSchema = parseSerializedSchema(activeRow.schema_doc);
    const baseline = this.#catchUpToStored(storedSchema);
    return { activeRow, storedSchema, baseline };
  }

  /**
   * Probes each `requireEmpty` entry for any rows. Returns the set of
   * composite keys (`${entity}:${kindName}`) that have at least one
   * row — those entries need to be promoted from "allowed-on-empty"
   * to incompatible. Dispatches to `countNodesByKind` for `node`
   * entries and `countEdgesByKind` for `edge` entries (a single-
   * primitive probe would always return 0 for the wrong-entity case
   * and silently bypass the gate).
   *
   * Probes run in parallel; each entry is independent. Race window
   * (probe → CAS commit): another writer can insert a row into a
   * previously-empty kind. The schema commit still succeeds (CAS
   * guards on schema version, not row count); the new schema rejects
   * the inserted row at next read, which the operator inspects and
   * either deletes or reverts. Rare in practice; tighter elimination
   * would require `SELECT FOR UPDATE` on the rows table, too
   * heavyweight for a millisecond-budget operation.
   */
  async #probeEmptyKinds(
    requireEmpty: readonly RequireEmptyEntry[],
  ): Promise<Set<RequireEmptyEntry>> {
    const probes = requireEmpty.map(
      async (entry): Promise<readonly [RequireEmptyEntry, number]> => {
        const count =
          entry.entity === "node" ?
            await this.#backend.countNodesByKind({
              graphId: this.graphId,
              kind: entry.kindName,
            })
          : await this.#backend.countEdgesByKind({
              graphId: this.graphId,
              kind: entry.kindName,
            });
        return [entry, count];
      },
    );
    const results = await Promise.all(probes);
    const nonEmpty = new Set<RequireEmptyEntry>();
    for (const [entry, count] of results) {
      if (count > 0) nonEmpty.add(entry);
    }
    return nonEmpty;
  }

  #cloneWithGraph<TRefStore extends StoreCore<G>>(
    graph: G,
    ref: StoreRef<TRefStore> | undefined,
    schemaMetadata: StoreSchemaMetadata = this.#schemaMetadata,
  ): StoreImplementation<G, TNativeTransaction> {
    const next: StoreImplementation<G, TNativeTransaction> =
      this.#adapterBackend === undefined ?
        new StoreImplementation<G, TNativeTransaction>(
          graph,
          this.#baseBackend,
          this.#options,
          schemaMetadata,
        )
      : new AdapterStoreImplementation(
          graph,
          this.#adapterBackend,
          this.#options,
          schemaMetadata,
        );
    syncStoreReplacementRef(ref, next);
    return next;
  }

  /**
   * Closes the store and releases underlying resources.
   *
   * Note: When using the Drizzle adapter, this method does not close the database
   * connection itself, as Drizzle delegates connection management to the user.
   * You should close the underlying database connection (e.g., better-sqlite3 or pg pool)
   * using their respective APIs.
   */
  async close(): Promise<void> {
    await this.#backend.close();
  }

  // === Internal: Operation Contexts ===

  #immediateHookRunner(): OperationHookRunner {
    return <T>(ctx: OperationHookContext, fn: () => Promise<T>) =>
      this.#withOperationHooks(ctx, fn);
  }

  #createNodeOperationContext(
    runHooks: OperationHookRunner = this.#immediateHookRunner(),
  ): NodeOperationContext<G> {
    return {
      graph: this.#graph,
      graphId: this.graphId,
      historyEnabled: this.#captureEnabled,
      revisionTrackingEnabled: this.#revisionTrackingEnabled,
      revisionSchema: this.#sqlSchema(),
      registry: this.#registry,
      createOperationContext: (operation, entity, kind, id) =>
        this.#createOperationContext(operation, entity, kind, id),
      withOperationHooks: runHooks,
    };
  }

  #createEdgeOperationContext(
    runHooks: OperationHookRunner = this.#immediateHookRunner(),
  ): EdgeOperationContext<G> {
    return {
      graph: this.#graph,
      graphId: this.graphId,
      historyEnabled: this.#captureEnabled,
      revisionTrackingEnabled: this.#revisionTrackingEnabled,
      revisionSchema: this.#sqlSchema(),
      registry: this.#registry,
      createOperationContext: (operation, entity, kind, id) =>
        this.#createOperationContext(operation, entity, kind, id),
      withOperationHooks: runHooks,
    };
  }

  // === Internal: Hook Helpers ===

  #createHookContext(): HookContext {
    return {
      operationId: generateId(),
      graphId: this.graphId,
      startedAt: new Date(),
    };
  }

  #createOperationContext(
    operation: "create" | "update" | "delete",
    entity: KindEntity,
    kind: string,
    id: string,
  ): OperationHookContext {
    return {
      ...this.#createHookContext(),
      operation,
      entity,
      kind,
      id,
    };
  }

  async #withOperationHooks<T>(
    ctx: OperationHookContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.#hooks.onOperationStart?.(ctx);
    const startTime = Date.now();
    try {
      const result = await fn();
      this.#hooks.onOperationEnd?.(ctx, {
        durationMs: Date.now() - startTime,
      });
      return result;
    } catch (error) {
      this.#hooks.onError?.(ctx, asError(error));
      throw error;
    }
  }

  /**
   * A hook runner for operations that execute INSIDE an explicit
   * `store.transaction`: `onOperationStart` (and a failed operation's
   * `onError`) fire immediately — the attempt and the failure are real when
   * they happen — but a successful operation's `onOperationEnd` is only
   * BUFFERED. `transaction()` flushes the buffer after the backend COMMIT
   * succeeds, or converts every buffered success into `onError` when the
   * transaction fails, so `onOperationEnd` always means durably committed
   * even for operations nested in a caller-controlled transaction.
   */
  #createBufferedHookRunner(
    pending: PendingOperationOutcome[],
  ): OperationHookRunner {
    return async <T>(
      ctx: OperationHookContext,
      fn: () => Promise<T>,
    ): Promise<T> => {
      this.#hooks.onOperationStart?.(ctx);
      const startTime = Date.now();
      try {
        const result = await fn();
        pending.push({ ctx, durationMs: Date.now() - startTime });
        return result;
      } catch (error) {
        this.#hooks.onError?.(ctx, asError(error));
        throw error;
      }
    };
  }

  // === Internal: Temporal Filtering ===

  #temporalRowMatcher(options?: QueryOptions): (
    row: Readonly<{
      deleted_at: string | undefined;
      valid_from: string | undefined;
      valid_to: string | undefined;
    }>,
  ) => boolean {
    // Resolve the coordinate ONCE (via the shared resolveTemporalReadParams, so
    // the in-memory getById/getByIds filter cannot drift from the SQL-side
    // filter, and a non-canonical asOf is rejected here too). Returning a
    // predicate lets getByIds pin one instant for the whole batch instead of
    // recomputing nowIso() — and re-validating — per row.
    const { temporalMode, asOf } = resolveTemporalReadParams(
      options,
      this.#graph.defaults.temporalMode,
    );

    return (row) => {
      switch (temporalMode) {
        case "current":
        case "asOf": {
          // resolveTemporalReadParams always resolves an instant for these modes.
          if (row.deleted_at) return false;
          if (asOf !== undefined && row.valid_from && asOf < row.valid_from)
            return false;
          if (asOf !== undefined && row.valid_to && asOf >= row.valid_to)
            return false;
          return true;
        }
        case "includeEnded": {
          return !row.deleted_at;
        }
        case "includeTombstones": {
          return true;
        }
      }
    };
  }

  #createQueryForBackend<CoordinateState extends QueryCoordinateState = "open">(
    backend: GraphBackend | TransactionBackend,
    sealedCoordinate?: ReadCoordinate,
  ): InitialQueryBuilder<G, CoordinateState> {
    return createInternalQueryBuilder<G, CoordinateState>(
      this.graphId,
      this.#registry,
      {
        // TransactionBackend omits transaction/close, but query execution only needs
        // the read-path/query capabilities shared with GraphBackend.
        backend: backend as GraphBackend,
        dialect: backend.dialect,
        defaultTraversalExpansion: this.#defaultTraversalExpansion,
        ...(this.#schema !== undefined && { schema: this.#schema }),
        ...(this.#recordedReadBinding !== undefined && {
          recordedReadBinding: this.#recordedReadBinding,
        }),
        ...(sealedCoordinate !== undefined && { sealedCoordinate }),
      },
    );
  }
}

/** Runtime implementation for the explicit adapter-interoperability surface. */
class AdapterStoreImplementation<
  G extends GraphDef,
  TNativeTransaction,
> extends StoreImplementation<G, TNativeTransaction> {
  readonly backend: GraphBackend | HistoryStoreBackend;

  constructor(
    graph: G,
    backend: AdapterBackend<TNativeTransaction>,
    options?: StoreOptions,
    schemaMetadata?: StoreSchemaMetadata,
  ) {
    super(graph, backend, options, schemaMetadata, backend);
    // Projections remain mutable while they serve as internal overlay targets;
    // freeze only the final object exposed at this public boundary.
    this.backend =
      options?.history === true ?
        createHistoryStoreBackendProjection(this[STORE_RUNTIME].backend)
      : Object.freeze(
          createGraphBackendProjection(this[STORE_RUNTIME].backend),
        );
  }

  override async evolve<TRefStore extends StoreCore<G>>(
    extension: GraphExtension,
    options?: Readonly<{
      ref?: StoreRef<TRefStore>;
      eager?: MaterializeIndexesOptions;
    }>,
  ): Promise<AdapterStoreImplementation<G, TNativeTransaction>> {
    return this.#withAdapterReplacement(options?.ref, (replacementRef) =>
      super.evolve(
        extension,
        options?.eager === undefined ?
          { ref: replacementRef }
        : { eager: options.eager, ref: replacementRef },
      ),
    );
  }

  override async deprecateKinds<TRefStore extends StoreCore<G>>(
    names: readonly string[],
    options?: Readonly<{
      ref?: StoreRef<TRefStore>;
    }>,
  ): Promise<AdapterStoreImplementation<G, TNativeTransaction>> {
    return this.#withAdapterReplacement(options?.ref, (replacementRef) =>
      super.deprecateKinds(names, { ref: replacementRef }),
    );
  }

  override async undeprecateKinds<TRefStore extends StoreCore<G>>(
    names: readonly string[],
    options?: Readonly<{
      ref?: StoreRef<TRefStore>;
    }>,
  ): Promise<AdapterStoreImplementation<G, TNativeTransaction>> {
    return this.#withAdapterReplacement(options?.ref, (replacementRef) =>
      super.undeprecateKinds(names, { ref: replacementRef }),
    );
  }

  override async removeKinds<TRefStore extends StoreCore<G>>(
    names: readonly string[],
    options?: Readonly<{
      ref?: StoreRef<TRefStore>;
      eager?: MaterializeRemovalsOptions;
    }>,
  ): Promise<AdapterStoreImplementation<G, TNativeTransaction>> {
    return this.#withAdapterReplacement(options?.ref, (replacementRef) =>
      super.removeKinds(
        names,
        options?.eager === undefined ?
          { ref: replacementRef }
        : { eager: options.eager, ref: replacementRef },
      ),
    );
  }

  async #withAdapterReplacement<TRefStore extends StoreCore<G>>(
    ref: StoreRef<TRefStore> | undefined,
    operation: (ref: StoreRef<Store<G>>) => Promise<Store<G>>,
  ): Promise<AdapterStoreImplementation<G, TNativeTransaction>> {
    const tracked = createTrackedReplacementRef<G>(this);
    try {
      await operation(tracked.ref);
    } catch (error) {
      if (tracked.wasReplaced()) {
        const replacement = requireAdapterStoreImplementation<
          G,
          TNativeTransaction
        >(tracked.ref.current);
        syncAdapterReplacementRef(ref, replacement);
      }
      throw error;
    }
    const replacement = requireAdapterStoreImplementation<
      G,
      TNativeTransaction
    >(tracked.ref.current);
    syncAdapterReplacementRef(ref, replacement);
    return replacement;
  }
}

function createTrackedReplacementRef<G extends GraphDef>(
  initial: Store<G>,
): Readonly<{
  ref: StoreRef<Store<G>>;
  wasReplaced: () => boolean;
}> {
  let current = initial;
  let replaced = false;
  return {
    ref: {
      get current(): Store<G> {
        return current;
      },
      set current(next: Store<G>) {
        current = next;
        replaced = true;
      },
    },
    wasReplaced: () => replaced,
  };
}

function syncAdapterReplacementRef<
  G extends GraphDef,
  TNativeTransaction,
  TRefStore extends StoreCore<G>,
>(
  ref: StoreRef<TRefStore> | undefined,
  replacement: AdapterStoreImplementation<G, TNativeTransaction>,
): void {
  if (ref === undefined) return;
  // Public StoreEvolution only accepts refs whose value is a supertype of the
  // returned Store flavor. This implementation class is deliberately broader
  // because one runtime class backs live, recorded-read, and history overloads.
  ref.current = replacement as unknown as TRefStore;
}

function requireAdapterStoreImplementation<
  G extends GraphDef,
  TNativeTransaction,
>(store: Store<G>): AdapterStoreImplementation<G, TNativeTransaction> {
  if (isAdapterStoreImplementation<G, TNativeTransaction>(store)) return store;
  throw new ConfigurationError(
    "Adapter store replacement lost its adapter capabilities.",
    { code: "ADAPTER_STORE_REPLACEMENT_INVARIANT" },
  );
}

function isAdapterStoreImplementation<G extends GraphDef, TNativeTransaction>(
  store: Store<G>,
): store is AdapterStoreImplementation<G, TNativeTransaction> {
  return store instanceof AdapterStoreImplementation;
}

function asAdapterStoreSurface<G extends GraphDef, TNativeTransaction>(
  store: AdapterStoreImplementation<G, TNativeTransaction>,
):
  | AdapterStore<G, TNativeTransaction>
  | AdapterHistoryStore<G, TNativeTransaction>
  | AdapterRecordedReadStore<G, TNativeTransaction> {
  // One runtime implementation backs the three option-discriminated overloads.
  // It constructs the matching backend projection and replacement flavor, but
  // TypeScript cannot derive that structural union from constructor options.
  return store as unknown as
    | AdapterStore<G, TNativeTransaction>
    | AdapterHistoryStore<G, TNativeTransaction>
    | AdapterRecordedReadStore<G, TNativeTransaction>;
}

// ============================================================
// Factory Function
// ============================================================

export type AdapterHistoryTransactionContext<
  G extends GraphDef,
  TNativeTransaction,
> = Omit<
  AdapterTransactionContext<G, TNativeTransaction>,
  "sql" | "sqlAvailability"
> &
  Readonly<{
    sqlAvailability: "history";
  }>;

/**
 * The {@link AdapterHistoryTransactionContext} handed to a `withRecordedTransaction`
 * callback, extended with {@link ScopedMeasure}. Its `measure` scopes to a child
 * {@link MeasurableAdapterHistoryTransactionContext} (so nested scopes keep the
 * history-safe absent-`sql` / backend typing). Assignable to
 * {@link MeasurableTransactionContext} (and hence to {@link TransactionContext}),
 * so a projector helper typed against either still accepts it.
 */
export type MeasurableAdapterHistoryTransactionContext<
  G extends GraphDef,
  TNativeTransaction,
> = AdapterHistoryTransactionContext<G, TNativeTransaction> &
  Readonly<{
    measure: ScopedMeasure<
      MeasurableAdapterHistoryTransactionContext<G, TNativeTransaction>
    >;
  }>;

export type AdapterRecordedReadStore<
  G extends GraphDef,
  TNativeTransaction,
> = StoreCore<G> &
  StoreEvolution<G, AdapterRecordedReadStore<G, TNativeTransaction>> &
  AdapterStoreTransactions<G, TNativeTransaction> &
  Readonly<{
    backend: GraphBackend;
    recordedReadBound: true;
  }>;

export type RecordedReadStore<G extends GraphDef> = StoreCore<G> &
  StoreTransactions<G> &
  StoreEvolution<G, RecordedReadStore<G>> &
  Readonly<{ recordedReadBound: true }>;

export type HistoryStore<G extends GraphDef> = StoreCore<G> &
  StoreTransactions<G> &
  StoreEvolution<G, HistoryStore<G>> &
  Readonly<{
    historyEnabled: true;
    recordedReadBound: true;
  }>;

export type AdapterHistoryStore<
  G extends GraphDef,
  TNativeTransaction,
> = StoreCore<G> &
  StoreEvolution<G, AdapterHistoryStore<G, TNativeTransaction>> &
  AdapterHistoryStoreTransactions<G, TNativeTransaction> &
  Readonly<{
    backend: HistoryStoreBackend;
    historyEnabled: true;
    recordedReadBound: true;
  }>;

type AdapterHistoryStoreTransactions<
  G extends GraphDef,
  TNativeTransaction,
> = Readonly<{
  transaction: <T>(
    fn: (
      tx: AdapterHistoryTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>,
    options?: TransactionOptions,
  ) => Promise<T>;
  transactionWithReceipt: <T>(
    fn: (
      tx: MeasurableAdapterHistoryTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>,
    options?: TransactionOptions,
  ) => Promise<TransactionOutcome<T>>;
  withRecordedTransaction: <T>(
    externalTransaction: TNativeTransaction,
    fn: (
      tx: MeasurableAdapterHistoryTransactionContext<G, TNativeTransaction>,
    ) => Promise<T>,
  ) => Promise<TransactionOutcome<T>>;
}>;

/**
 * Creates a new Store instance.
 *
 * @param graph - The graph definition
 * @param backend - The database backend
 * @param options - Optional store configuration including observability hooks
 * @returns A new Store instance
 *
 * @example
 * ```typescript
 * // Basic usage
 * const store = createStore(graph, backend);
 *
 * // With observability hooks
 * const store = createStore(graph, backend, {
 *   hooks: {
 *     onOperationStart: (ctx) => {
 *       console.log(`Starting ${ctx.operation} on ${ctx.entity}:${ctx.kind}`);
 *     },
 *     onOperationEnd: (ctx, result) => {
 *       console.log(`Completed in ${result.durationMs}ms`);
 *     },
 *     onError: (ctx, error) => {
 *       console.error(`Operation ${ctx.operationId} failed:`, error);
 *     },
 *   },
 * });
 * ```
 */
export function createStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options: HistoryStoreOptions,
): HistoryStore<G>;
export function createStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options: RecordedReadStoreOptions,
): RecordedReadStore<G>;
export function createStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options?: UnboundLiveStoreOptions,
): Store<G>;
export function createStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options: LiveStoreOptions | undefined,
): Store<G> | RecordedReadStore<G>;
export function createStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options: StoreOptions | undefined,
): Store<G> | HistoryStore<G> | RecordedReadStore<G>;
export function createStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options?: StoreOptions,
): Store<G> | HistoryStore<G> | RecordedReadStore<G> {
  return new StoreImplementation<G>(graph, backend, options);
}

export function createAdapterStore<G extends GraphDef, TNativeTransaction>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options: HistoryStoreOptions,
): AdapterHistoryStore<G, TNativeTransaction>;
export function createAdapterStore<G extends GraphDef, TNativeTransaction>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options: RecordedReadStoreOptions,
): AdapterRecordedReadStore<G, TNativeTransaction>;
export function createAdapterStore<G extends GraphDef, TNativeTransaction>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options?: UnboundLiveStoreOptions,
): AdapterStore<G, TNativeTransaction>;
export function createAdapterStore<G extends GraphDef, TNativeTransaction>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options: LiveStoreOptions | undefined,
):
  | AdapterStore<G, TNativeTransaction>
  | AdapterRecordedReadStore<G, TNativeTransaction>;
export function createAdapterStore<G extends GraphDef, TNativeTransaction>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options: StoreOptions | undefined,
):
  | AdapterStore<G, TNativeTransaction>
  | AdapterHistoryStore<G, TNativeTransaction>
  | AdapterRecordedReadStore<G, TNativeTransaction>;
export function createAdapterStore<G extends GraphDef, TNativeTransaction>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options?: StoreOptions,
):
  | AdapterStore<G, TNativeTransaction>
  | AdapterHistoryStore<G, TNativeTransaction>
  | AdapterRecordedReadStore<G, TNativeTransaction> {
  return asAdapterStoreSurface(
    new AdapterStoreImplementation(graph, backend, options),
  );
}

function isKnownEdgeKind(graph: GraphDef, name: string): boolean {
  return Object.hasOwn(graph.edges, name);
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function schemaMetadataFromRow(
  row: SchemaVersionRow | undefined,
): StoreSchemaMetadata {
  if (row === undefined) return UNKNOWN_SCHEMA_METADATA;
  return Object.freeze({
    schemaVersion: row.version,
    schemaHash: row.schema_hash,
  });
}

function schemaMetadataForResult(
  activeRow: SchemaVersionRow | undefined,
  result: SchemaValidationResult,
): StoreSchemaMetadata {
  if (result.status === "initialized" || result.status === "migrated") {
    return schemaMetadataFromRow(result.committedRow);
  }
  return schemaMetadataFromRow(activeRow);
}

/**
 * Prefer the #129 contribution path; fall back to the pre-#129
 * `ensureFulltextTable` for backends that predate it. Idempotent and
 * cheap on a warm re-call (per-instance cache + recorded-signature
 * short-circuit).
 */
async function materializeRuntimeContributions(
  backend: GraphBackend,
  graphId: string,
): Promise<void> {
  if (backend.ensureRuntimeContributions) {
    await backend.ensureRuntimeContributions(graphId);
    return;
  }
  await backend.ensureFulltextTable?.(graphId);
}

/**
 * Privileged boot step: materialize every embedding `(kind, field)` slot's
 * per-field vector table + durable marker, enumerated from the graph via
 * {@link resolveGraphVectorSlots}. The vector counterpart of
 * {@link materializeRuntimeContributions} (fulltext) — runs once under the
 * privileged role inside `createStoreWithSchema` so a least-privilege runtime
 * can assert the markers (a cached SELECT) and write embeddings without
 * holding `CREATE` on the schema. No-op on backends without vector support
 * (both vector contribution methods absent, or `capabilities.vector`
 * unsupported) and for graphs that declare no embedding fields. Built-in
 * backends use the batch method; the singular loop is the compatibility path.
 *
 * `onDrift: "skip"`: a slot already provisioned at a DIFFERENT shape (the
 * declared dimension changed since the table was created) is warned about
 * and left untouched rather than refused — boot must stay reachable so the
 * operator can run `store.reembedVectorField(kind, fieldPath)`, the
 * sanctioned recreate-and-restamp path. Until then, writes to that slot
 * fail with a typed `stale` StoreNotInitializedError.
 */
async function materializeVectorContributions(
  backend: GraphBackend,
  graph: GraphDef,
): Promise<void> {
  if (backend.capabilities.vector?.supported !== true) return;
  const slots = resolveGraphVectorSlots(graph);
  const ensureVectorSlotContributions = backend.ensureVectorSlotContributions;
  if (ensureVectorSlotContributions !== undefined) {
    await ensureVectorSlotContributions(slots, { onDrift: "skip" });
    return;
  }
  const ensureVectorSlotContribution = backend.ensureVectorSlotContribution;
  if (ensureVectorSlotContribution === undefined) return;
  for (const slot of slots) {
    await ensureVectorSlotContribution(slot, { onDrift: "skip" });
  }
}

// ============================================================
// Async Factory with Schema Management
// ============================================================

// Re-export schema manager types
export type {
  SchemaManagerOptions,
  SchemaValidationResult,
} from "../schema/manager";

/**
 * Creates a store and ensures the schema is initialized/migrated.
 *
 * This is the recommended way to create a store in production.
 * It automatically:
 * - Creates base tables on a fresh database (if the backend supports bootstrapTables)
 * - Initializes the schema on first run (version 1)
 * - Auto-migrates safe changes (additive changes)
 * - Throws MigrationError for breaking changes
 *
 * @param graph - The graph definition
 * @param backend - The database backend
 * @param options - Store and schema options
 * @returns A tuple of [store, validationResult]
 *
 * @example
 * ```typescript
 * const [store, result] = await createStoreWithSchema(graph, backend);
 *
 * if (result.status === "initialized") {
 *   console.log("Schema initialized at version", result.version);
 * } else if (result.status === "migrated") {
 *   console.log(`Migrated from v${result.fromVersion} to v${result.toVersion}`);
 * } else if (result.status === "pending") {
 *   console.log(`Safe changes pending at version ${result.version}`);
 * }
 * ```
 */
export async function createStoreWithSchema<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options: HistoryStoreOptions & SchemaManagerOptions,
): Promise<[HistoryStore<G>, SchemaValidationResult]>;
export async function createStoreWithSchema<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options: RecordedReadStoreOptions & SchemaManagerOptions,
): Promise<[RecordedReadStore<G>, SchemaValidationResult]>;
export async function createStoreWithSchema<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options?: UnboundLiveStoreOptions & SchemaManagerOptions,
): Promise<[Store<G>, SchemaValidationResult]>;
export async function createStoreWithSchema<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options: (LiveStoreOptions & SchemaManagerOptions) | undefined,
): Promise<[Store<G> | RecordedReadStore<G>, SchemaValidationResult]>;
export async function createStoreWithSchema<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options: (StoreOptions & SchemaManagerOptions) | undefined,
): Promise<
  [Store<G> | HistoryStore<G> | RecordedReadStore<G>, SchemaValidationResult]
>;
export async function createStoreWithSchema<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options?: StoreOptions & SchemaManagerOptions,
): Promise<
  [Store<G> | HistoryStore<G> | RecordedReadStore<G>, SchemaValidationResult]
> {
  const prepared = await prepareStoreWithSchema(graph, backend, options);
  return [
    new StoreImplementation(
      prepared.graph,
      backend,
      options,
      prepared.schemaMetadata,
    ),
    prepared.result,
  ];
}

type PreparedStore<G extends GraphDef> = Readonly<{
  graph: G;
  result: SchemaValidationResult;
  schemaMetadata: StoreSchemaMetadata;
}>;

async function prepareStoreWithSchema<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options: (StoreOptions & SchemaManagerOptions) | undefined,
): Promise<PreparedStore<G>> {
  // Fold any persisted graph extension into the graph BEFORE
  // constructing the Store. The prefetched row + parsed schema thread
  // through to ensureSchema so each Store boot pays for one DB round
  // trip and one Zod parse, not two. Additional extension kinds are
  // reachable through the registry but invisible to the type system —
  // see `mergeGraphExtension`.
  const {
    graph: merged,
    activeRow,
    storedSchema,
  } = await loadAndMergeGraphExtensionDocument(backend, graph);

  const result = await ensureSchemaImpl(backend, merged, {
    ...options,
    preloaded: { activeRow, storedSchema },
  });

  // #135/#143: this is the single durable-marker writer, and it MUST
  // run after ensureSchemaImpl so the breaking-change gate is reached
  // first — otherwise contribution DDL derived from the new code graph
  // would hit a stale table shape and mask `MigrationError`.
  await materializeRuntimeContributions(backend, merged.id);
  // Provision every embedding field's per-`(kind, field)` vector table +
  // durable marker under the privileged role, so a least-privilege runtime
  // asserts the markers (SELECT) and writes embeddings without `CREATE`.
  await materializeVectorContributions(backend, merged);
  // Bring the base-relation system indexes up to this library version.
  // Bootstrap DDL only runs on first boot, so an index shipped in a newer
  // version reaches already-initialized databases here — this is the same
  // privileged-boot step the contributions above use. `systemIndexes:
  // "skip"` defers to an out-of-band store.materializeSystemIndexes()
  // for deployments that must not run index builds inline at boot.
  if (options?.systemIndexes !== "skip") {
    await materializeSystemIndexesOnBoot(backend, merged.id, result);
  }

  return {
    graph: merged,
    result,
    schemaMetadata: schemaMetadataForResult(activeRow, result),
  };
}

export async function createAdapterStoreWithSchema<
  G extends GraphDef,
  TNativeTransaction,
>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options: HistoryStoreOptions & SchemaManagerOptions,
): Promise<
  [AdapterHistoryStore<G, TNativeTransaction>, SchemaValidationResult]
>;
export async function createAdapterStoreWithSchema<
  G extends GraphDef,
  TNativeTransaction,
>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options: RecordedReadStoreOptions & SchemaManagerOptions,
): Promise<
  [AdapterRecordedReadStore<G, TNativeTransaction>, SchemaValidationResult]
>;
export async function createAdapterStoreWithSchema<
  G extends GraphDef,
  TNativeTransaction,
>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options?: UnboundLiveStoreOptions & SchemaManagerOptions,
): Promise<[AdapterStore<G, TNativeTransaction>, SchemaValidationResult]>;
export async function createAdapterStoreWithSchema<
  G extends GraphDef,
  TNativeTransaction,
>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options: (LiveStoreOptions & SchemaManagerOptions) | undefined,
): Promise<
  [
    (
      | AdapterStore<G, TNativeTransaction>
      | AdapterRecordedReadStore<G, TNativeTransaction>
    ),
    SchemaValidationResult,
  ]
>;
export async function createAdapterStoreWithSchema<
  G extends GraphDef,
  TNativeTransaction,
>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options: (StoreOptions & SchemaManagerOptions) | undefined,
): Promise<
  [
    (
      | AdapterStore<G, TNativeTransaction>
      | AdapterHistoryStore<G, TNativeTransaction>
      | AdapterRecordedReadStore<G, TNativeTransaction>
    ),
    SchemaValidationResult,
  ]
>;
export async function createAdapterStoreWithSchema<
  G extends GraphDef,
  TNativeTransaction,
>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options?: StoreOptions & SchemaManagerOptions,
): Promise<
  [
    (
      | AdapterStore<G, TNativeTransaction>
      | AdapterHistoryStore<G, TNativeTransaction>
      | AdapterRecordedReadStore<G, TNativeTransaction>
    ),
    SchemaValidationResult,
  ]
> {
  const prepared = await prepareStoreWithSchema(graph, backend, options);
  return [
    asAdapterStoreSurface(
      new AdapterStoreImplementation(
        prepared.graph,
        backend,
        options,
        prepared.schemaMetadata,
      ),
    ),
    prepared.result,
  ];
}

/**
 * Boot-path system-index materialization. Lenient where the explicit
 * `store.materializeSystemIndexes()` API is strict:
 *
 * - Backends without `executeDdl` / status primitives are skipped —
 *   their deployments keep the bootstrap-only behavior they had before
 *   system indexes were materialized at boot, instead of failing to boot.
 * - Skipped when the schema gate did not pass (`"breaking"`).
 * - Individual index failures degrade to a warning: system indexes are a
 *   performance concern, and a store that cannot build one must still
 *   come up (the operator retries via `store.materializeSystemIndexes()`).
 */
async function materializeSystemIndexesOnBoot(
  backend: GraphBackend,
  graphId: string,
  result: SchemaValidationResult,
): Promise<void> {
  if (result.status === "breaking") return;
  if (!backendSupportsIndexMaterialization(backend)) return;
  const schemaVersion =
    result.status === "migrated" ? result.toVersion : result.version;
  try {
    const { results } = await materializeSystemIndexesImpl(
      { backend: asRawBackend(backend), graphId, schemaVersion },
      {},
    );
    const failed = results.filter(
      (entryResult) => entryResult.status === "failed",
    );
    if (failed.length === 0) return;
    console.warn(
      `[typegraph] ${String(failed.length)} system index(es) failed to ` +
        `materialize at boot (${failed
          .map((entryResult) => entryResult.indexName)
          .join(", ")}); the store is usable but the affected access paths ` +
        "fall back to scans. Retry via store.materializeSystemIndexes().",
      failed[0]?.error,
    );
  } catch (error) {
    // Leniency must hold for infrastructure throws too (status-table
    // ensure/preload/record failures, claim writes) — not only per-index
    // build failures. A store that booted on the previous version must
    // still come up after an upgrade; the operator retries explicitly.
    console.warn(
      "[typegraph] system-index materialization failed at boot; the store " +
        "is usable but new system indexes were not adopted. Retry via " +
        "store.materializeSystemIndexes().",
      error,
    );
  }
}

/**
 * Creates a Store after **verifying** that the database is at the same
 * schema version as the code graph — without running any DDL, bootstrap,
 * or marker writes. The runtime counterpart of `createStoreWithSchema`
 * for the deployment model in "Database roles & least privilege":
 *
 * - **`createStoreWithSchema(graph, backend)`** runs DDL (bootstrap,
 *   safe auto-migrations, durable contribution materialization). Run it
 *   once at startup under a privileged role that holds `CREATE` / DDL.
 * - **`createVerifiedStore(graph, backend)`** is the zero-DDL runtime
 *   attach with a verification gate. Throws `MigrationError` when the
 *   persisted schema is behind the code graph (any pending change, safe
 *   or breaking), `ConfigurationError` when no schema has been
 *   initialized, or `StoreNotInitializedError` when the schema is
 *   current but the runtime-contribution markers are missing/stale.
 *   The runtime can use a least-privilege, DML-only database role.
 * - **`createStore(graph, backend)`** is the same zero-DDL attach
 *   *without* the verification gate — fastest, but schema drift goes
 *   undetected until a hot-path operation trips.
 *
 * Folds any persisted graph-extension document into the supplied graph
 * before building the Store, just like `createStoreWithSchema`.
 *
 * @param graph - The graph definition
 * @param backend - The database backend
 * @param options - Optional store configuration
 * @returns A tuple of [store, validationResult] — `result.status` is
 *   always `"unchanged"` on success
 *
 * @example
 * ```typescript
 * // Runtime — least-privilege, DML-only role. Zero DDL.
 * const [store, result] = await createVerifiedStore(graph, backend);
 * // result.status === "unchanged" — the privileged migrator is current.
 * ```
 *
 * @throws ConfigurationError if no schema has been initialized.
 * @throws MigrationError if the persisted schema is behind the code graph.
 * @throws StoreNotInitializedError if runtime-contribution markers are
 *   missing/stale/failed for this graph on this connection.
 */
export async function createVerifiedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options: HistoryStoreOptions,
): Promise<[HistoryStore<G>, SchemaValidationResult]>;
export async function createVerifiedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options: RecordedReadStoreOptions,
): Promise<[RecordedReadStore<G>, SchemaValidationResult]>;
export async function createVerifiedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options?: UnboundLiveStoreOptions,
): Promise<[Store<G>, SchemaValidationResult]>;
export async function createVerifiedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options: LiveStoreOptions | undefined,
): Promise<[Store<G> | RecordedReadStore<G>, SchemaValidationResult]>;
export async function createVerifiedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options: StoreOptions | undefined,
): Promise<
  [Store<G> | HistoryStore<G> | RecordedReadStore<G>, SchemaValidationResult]
>;
export async function createVerifiedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options?: StoreOptions,
): Promise<
  [Store<G> | HistoryStore<G> | RecordedReadStore<G>, SchemaValidationResult]
> {
  const prepared = await prepareVerifiedStore(graph, backend);
  return [
    new StoreImplementation(
      prepared.graph,
      backend,
      options,
      prepared.schemaMetadata,
    ),
    prepared.result,
  ];
}

async function prepareVerifiedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
): Promise<PreparedStore<G>> {
  const {
    graph: merged,
    activeRow,
    result,
  } = await loadAndVerifyGraph(backend, graph);
  return {
    graph: merged,
    result,
    schemaMetadata: schemaMetadataFromRow(activeRow),
  };
}

export async function createVerifiedAdapterStore<
  G extends GraphDef,
  TNativeTransaction,
>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options: HistoryStoreOptions,
): Promise<
  [AdapterHistoryStore<G, TNativeTransaction>, SchemaValidationResult]
>;
export async function createVerifiedAdapterStore<
  G extends GraphDef,
  TNativeTransaction,
>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options: RecordedReadStoreOptions,
): Promise<
  [AdapterRecordedReadStore<G, TNativeTransaction>, SchemaValidationResult]
>;
export async function createVerifiedAdapterStore<
  G extends GraphDef,
  TNativeTransaction,
>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options?: UnboundLiveStoreOptions,
): Promise<[AdapterStore<G, TNativeTransaction>, SchemaValidationResult]>;
export async function createVerifiedAdapterStore<
  G extends GraphDef,
  TNativeTransaction,
>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options: LiveStoreOptions | undefined,
): Promise<
  [
    (
      | AdapterStore<G, TNativeTransaction>
      | AdapterRecordedReadStore<G, TNativeTransaction>
    ),
    SchemaValidationResult,
  ]
>;
export async function createVerifiedAdapterStore<
  G extends GraphDef,
  TNativeTransaction,
>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options: StoreOptions | undefined,
): Promise<
  [
    (
      | AdapterStore<G, TNativeTransaction>
      | AdapterHistoryStore<G, TNativeTransaction>
      | AdapterRecordedReadStore<G, TNativeTransaction>
    ),
    SchemaValidationResult,
  ]
>;
export async function createVerifiedAdapterStore<
  G extends GraphDef,
  TNativeTransaction,
>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
  options?: StoreOptions,
): Promise<
  [
    (
      | AdapterStore<G, TNativeTransaction>
      | AdapterHistoryStore<G, TNativeTransaction>
      | AdapterRecordedReadStore<G, TNativeTransaction>
    ),
    SchemaValidationResult,
  ]
> {
  const prepared = await prepareVerifiedStore(graph, backend);
  return [
    asAdapterStoreSurface(
      new AdapterStoreImplementation(
        prepared.graph,
        backend,
        options,
        prepared.schemaMetadata,
      ),
    ),
    prepared.result,
  ];
}
