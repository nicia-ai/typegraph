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
  type GraphBackend,
  runOptionallyInTransaction,
  type SchemaVersionRow,
  type TransactionBackend,
} from "../backend/types";
import {
  type AllNodeTypes,
  type EdgeKinds,
  type GraphDef,
  isKnownKind,
  type NodeKinds,
} from "../core/define-graph";
import type { KindEntity, NodeId } from "../core/types";
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
import type { TraversalExpansion } from "../query/ast";
import {
  type BatchableQuery,
  type BatchResults,
  createQueryBuilder,
  type QueryBuilder,
} from "../query/builder";
import { createSqlSchema } from "../query/compiler/schema";
import { getDialect } from "../query/dialect";
import { buildKindRegistry, type KindRegistry } from "../registry";
import {
  applyDeprecatedKinds,
  commitNewSchemaVersion,
  ensureSchema as ensureSchemaImpl,
  loadActiveSchemaWithBootstrap,
  loadAndMergeGraphExtensionDocument,
  parseSerializedSchema,
  type SchemaManagerOptions,
  type SchemaValidationResult,
} from "../schema/manager";
import { type SerializedSchema } from "../schema/types";
import { nowIso } from "../utils/date";
import { generateId } from "../utils/id";
import { createGraphAlgorithms, type GraphAlgorithms } from "./algorithms";
import {
  createEdgeCollectionsProxy,
  createNodeCollectionsProxy,
  type EdgeOperations,
  type NodeOperations,
} from "./collection-factory";
import { introspectSchema, type SchemaIntrospection } from "./introspect";
import {
  materializeIndexes as materializeIndexesImpl,
  type MaterializeIndexesOptions,
  type MaterializeIndexesResult,
} from "./materialize-indexes";
import {
  buildPendingKindRemoval,
  materializeRemovals as materializeRemovalsImpl,
  type MaterializeRemovalsOptions,
  type MaterializeRemovalsResult,
} from "./materialize-removals";
import {
  type EdgeOperationContext,
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
} from "./operations";
import { rowToEdge, rowToNode } from "./row-mappers";
import { StoreSearch } from "./search-facade";
import {
  executeSubgraph,
  type SubgraphOptions,
  type SubgraphProject,
  type SubgraphResult,
} from "./subgraph";
import {
  type DynamicEdgeCollection,
  type DynamicNodeCollection,
  type GraphEdgeCollections,
  type GraphNodeCollections,
  type HookContext,
  type OperationHookContext,
  type QueryOptions,
  type StoreHooks,
  type StoreOptions,
  type StoreRef,
  type TransactionContext,
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
  | "evolve"
  | "materialize"
  | "deprecate"
  | "undeprecate"
  | "remove";

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
};

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
export class Store<G extends GraphDef> {
  readonly #graph: G;
  readonly #backend: GraphBackend;
  readonly #registry: KindRegistry;
  readonly #hooks: StoreHooks;
  readonly #schema: StoreOptions["schema"];
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
  ) {
    this.#graph = graph;
    this.#backend = backend;
    this.#registry = buildKindRegistry(graph);
    this.#hooks = options?.hooks ?? {};
    this.#schema =
      options?.schema ??
      (backend.tableNames ? createSqlSchema(backend.tableNames) : undefined);
    this.#defaultTraversalExpansion =
      options?.queryDefaults?.traversalExpansion ?? "inverse";
    this.#options = options;
    this.#schemaMetadata = schemaMetadata ?? UNKNOWN_SCHEMA_METADATA;
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

  /** The kind registry for ontology lookups */
  get registry(): KindRegistry {
    return this.#registry;
  }

  /** The database backend */
  get backend(): GraphBackend {
    return this.#backend;
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
   * Each call compiles to a single recursive-CTE query against the backend.
   * The facade is built lazily on first access and cached for the lifetime
   * of the store.
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
        backend: this.#backend,
        schema: this.#schema,
        defaultTemporalMode: this.#graph.defaults.temporalMode,
      });
    }
    return this.#algorithms;
  }

  // === Dynamic Collection Access ===

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
    if (!Object.hasOwn(this.#graph.nodes, kind)) return undefined;
    return this.nodes[
      kind as keyof G["nodes"] & string
    ] as unknown as DynamicNodeCollection;
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
    return this.#graph.nodes[kind]!.type.schema;
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
    return this.#graph.edges[kind]!.type.schema;
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
    const ctx = this.#createNodeOperationContext();
    return {
      defaultTemporalMode: this.#graph.defaults.temporalMode,
      rowToNode: (row) => rowToNode(row),
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
      executeDelete: (kind, id, backend) =>
        executeNodeDelete(ctx, kind, id, backend),
      executeHardDelete: (kind, id, backend) =>
        executeNodeHardDelete(ctx, kind, id, backend),
      matchesTemporalMode: (row, options) =>
        this.#matchesTemporalMode(row, options),
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
    };
  }

  /**
   * Edge operations bound to this store instance.
   */
  get #edgeOperations(): EdgeOperations {
    const ctx = this.#createEdgeOperationContext();
    return {
      defaultTemporalMode: this.#graph.defaults.temporalMode,
      rowToEdge: (row) => rowToEdge(row),
      executeCreate: (input, backend) => executeEdgeCreate(ctx, input, backend),
      executeCreateBatch: (inputs, backend) =>
        executeEdgeCreateBatch(ctx, inputs, backend),
      executeCreateNoReturnBatch: (inputs, backend) =>
        executeEdgeCreateNoReturnBatch(ctx, inputs, backend),
      executeUpdate: (input, backend) => executeEdgeUpdate(ctx, input, backend),
      executeUpsertUpdate: (input, backend, options) =>
        executeEdgeUpsertUpdate(ctx, input, backend, options),
      executeDelete: (id, backend) => executeEdgeDelete(ctx, id, backend),
      executeHardDelete: (id, backend) =>
        executeEdgeHardDelete(ctx, id, backend),
      matchesTemporalMode: (row, options) =>
        this.#matchesTemporalMode(row, options),
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
  query(): QueryBuilder<G> {
    return this.#createQueryForBackend(this.#backend);
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
    return runOptionallyInTransaction(this.#backend, async (target) => {
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
    return executeSubgraph({
      graph: this.#graph,
      graphId: this.graphId,
      rootId,
      backend: this.#backend,
      dialect: getDialect(this.#backend.dialect),
      schema: this.#schema,
      options,
    });
  }

  // === Transactions ===

  /**
   * Executes a function within a transaction.
   *
   * The transaction context provides the same collection API as the Store:
   * - `tx.nodes.Person.create(...)` - Create a node
   * - `tx.edges.worksAt.create(...)` - Create an edge
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
   */
  async transaction<T>(
    fn: (tx: TransactionContext<G>) => Promise<T>,
  ): Promise<T> {
    // Without a real transaction the tx-scoped collections would be
    // bound to the same backend as this.nodes/this.edges and exposing
    // the cached versions avoids rebuilding the proxies on every call.
    if (!this.#backend.capabilities.transactions) {
      return fn({ nodes: this.nodes, edges: this.edges });
    }

    return this.#backend.transaction(async (txBackend) => {
      const txNodeOperations: NodeOperations = {
        ...this.#nodeOperations,
        createQuery: () => this.#createQueryForBackend(txBackend),
      };
      const txEdgeOperations: EdgeOperations = {
        ...this.#edgeOperations,
        createQuery: () => this.#createQueryForBackend(txBackend),
      };

      const nodes = createNodeCollectionsProxy(
        this.#graph,
        this.graphId,
        this.#registry,
        txBackend,
        txNodeOperations,
      );

      const edges = createEdgeCollectionsProxy(
        this.#graph,
        this.graphId,
        this.#registry,
        txBackend,
        txEdgeOperations,
      );

      return fn({ nodes, edges });
    });
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
      await target.clearGraph(this.graphId);
    };

    await (this.#backend.capabilities.transactions ?
      this.#backend.transaction(async (tx) => doClear(tx))
    : doClear(this.#backend));

    // Reset lazy-initialized collection caches
    this.#nodeCollections = undefined;
    this.#edgeCollections = undefined;
    this.#algorithms = undefined;
    this.#search = undefined;
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
  async evolve(
    extension: GraphExtension,
    options?: Readonly<{
      ref?: StoreRef<Store<G>>;
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
  ): Promise<Store<G>> {
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
        if (options?.ref !== undefined) options.ref.current = this;
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
    store: Store<G>,
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
  async deprecateKinds(
    names: readonly string[],
    options?: Readonly<{ ref?: StoreRef<Store<G>> }>,
  ): Promise<Store<G>> {
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
  async undeprecateKinds(
    names: readonly string[],
    options?: Readonly<{ ref?: StoreRef<Store<G>> }>,
  ): Promise<Store<G>> {
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
        backend: this.#backend,
        schemaVersion: activeRow.version,
      },
      options ?? {},
    );
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
  async removeKinds(
    names: readonly string[],
    options?: Readonly<{
      ref?: StoreRef<Store<G>>;
      eager?: MaterializeRemovalsOptions;
    }>,
  ): Promise<Store<G>> {
    const { activeRow, baseline } = await this.#loadCaughtUp("remove");
    const plan = planRemovals(baseline, names);

    // True no-op: every name was either absent or already removed.
    // Mirrors the (un)deprecateKinds same-set short-circuit.
    if (
      plan.removedNodeKinds.length === 0 &&
      plan.removedEdgeKinds.length === 0
    ) {
      if (baseline === this.#graph) {
        if (options?.ref !== undefined) options.ref.current = this;
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
      { graphId: this.graphId, backend: this.#backend },
      options ?? {},
    );
  }

  async #updateDeprecatedKinds(
    direction: "add" | "remove",
    names: readonly string[],
    options: Readonly<{ ref?: StoreRef<Store<G>> }> | undefined,
  ): Promise<Store<G>> {
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
        if (options?.ref !== undefined) options.ref.current = this;
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

  #cloneWithGraph(
    graph: G,
    ref: StoreRef<Store<G>> | undefined,
    schemaMetadata: StoreSchemaMetadata = this.#schemaMetadata,
  ): Store<G> {
    const next = new Store(graph, this.#backend, this.#options, schemaMetadata);
    if (ref !== undefined) ref.current = next;
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

  #createNodeOperationContext(): NodeOperationContext<G> {
    return {
      graph: this.#graph,
      graphId: this.graphId,
      registry: this.#registry,
      createOperationContext: (operation, entity, kind, id) =>
        this.#createOperationContext(operation, entity, kind, id),
      withOperationHooks: <T>(
        ctx: OperationHookContext,
        fn: () => Promise<T>,
      ) => this.#withOperationHooks(ctx, fn),
    };
  }

  #createEdgeOperationContext(): EdgeOperationContext<G> {
    return {
      graph: this.#graph,
      graphId: this.graphId,
      registry: this.#registry,
      createOperationContext: (operation, entity, kind, id) =>
        this.#createOperationContext(operation, entity, kind, id),
      withOperationHooks: <T>(
        ctx: OperationHookContext,
        fn: () => Promise<T>,
      ) => this.#withOperationHooks(ctx, fn),
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
      this.#hooks.onError?.(
        ctx,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  // === Internal: Temporal Filtering ===

  #matchesTemporalMode(
    row: {
      deleted_at: string | undefined;
      valid_from: string | undefined;
      valid_to: string | undefined;
    },
    options?: QueryOptions,
  ): boolean {
    const mode = options?.temporalMode ?? this.#graph.defaults.temporalMode;
    const asOf = options?.asOf ?? nowIso();

    switch (mode) {
      case "current":
      case "asOf": {
        if (row.deleted_at) return false;
        if (row.valid_from && asOf < row.valid_from) return false;
        if (row.valid_to && asOf >= row.valid_to) return false;
        return true;
      }
      case "includeEnded": {
        return !row.deleted_at;
      }
      case "includeTombstones": {
        return true;
      }
    }
  }

  #createQueryForBackend(
    backend: GraphBackend | TransactionBackend,
  ): QueryBuilder<G> {
    return createQueryBuilder<G>(this.graphId, this.#registry, {
      // TransactionBackend omits transaction/close, but query execution only needs
      // the read-path/query capabilities shared with GraphBackend.
      backend: backend as GraphBackend,
      dialect: backend.dialect,
      defaultTraversalExpansion: this.#defaultTraversalExpansion,
      ...(this.#schema !== undefined && { schema: this.#schema }),
    });
  }
}

// ============================================================
// Factory Function
// ============================================================

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
  options?: StoreOptions,
): Store<G> {
  return new Store(graph, backend, options);
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
  options?: StoreOptions & SchemaManagerOptions,
): Promise<[Store<G>, SchemaValidationResult]> {
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
  const store = new Store(
    merged,
    backend,
    options,
    schemaMetadataForResult(activeRow, result),
  );
  return [store, result];
}
