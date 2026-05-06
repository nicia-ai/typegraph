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
import {
  type GraphBackend,
  runOptionallyInTransaction,
  type TransactionBackend,
} from "../backend/types";
import {
  type AllNodeTypes,
  type EdgeKinds,
  type GraphDef,
  type NodeKinds,
} from "../core/define-graph";
import type { NodeId } from "../core/types";
import { ConfigurationError } from "../errors";
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
import { type RuntimeGraphDocument } from "../runtime/document-types";
import { mergeRuntimeExtension } from "../runtime/merge";
import {
  loadActiveSchemaWithBootstrap,
  parseSerializedSchema,
} from "../schema/manager";
import { nowIso } from "../utils/date";
import { generateId } from "../utils/id";
import { createGraphAlgorithms, type GraphAlgorithms } from "./algorithms";
import {
  createEdgeCollectionsProxy,
  createNodeCollectionsProxy,
  type EdgeOperations,
  type NodeOperations,
} from "./collection-factory";
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

  constructor(graph: G, backend: GraphBackend, options?: StoreOptions) {
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
   * dynamic admin UIs).
   */
  getNodeCollection(kind: string): DynamicNodeCollection | undefined {
    if (!Object.hasOwn(this.#graph.nodes, kind)) return undefined;
    return this.nodes[
      kind as keyof G["nodes"] & string
    ] as unknown as DynamicNodeCollection;
  }

  /**
   * Returns the edge collection for the given kind, or undefined if the kind
   * is not registered in this graph.
   *
   * Use this for runtime string-keyed access when the kind is not known at
   * compile time.
   */
  getEdgeCollection(kind: string): DynamicEdgeCollection | undefined {
    if (!Object.hasOwn(this.#graph.edges, kind)) return undefined;
    return this.edges[
      kind as keyof G["edges"] & string
    ] as unknown as DynamicEdgeCollection;
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
   * Evolves the graph at runtime by merging a runtime extension document
   * into the current schema, atomically committing a new schema version,
   * and returning a fresh `Store` constructed against the merged graph.
   *
   * The `Store` is immutable — its registry, collections, and operation
   * contexts close over the graph at construction time — so callers
   * must use the returned store (or pass a `ref` to be re-pointed) for
   * any work involving the new kinds.
   *
   * **Cost is proportional to schema document size, not row count.** The
   * commit is a single CAS write; `evolve()` never reads or scans data
   * rows, so the runtime is independent of the table's row count.
   *
   * **Concurrent evolve recovery.** On `StaleVersionError`, refetch the
   * current active schema (or dereference your `StoreRef`),
   * reconstruct your `Store`, and re-call `evolve(extension)` against
   * the new store. Re-validation may now surface deterministic errors
   * (e.g., another caller just added a kind that collides with yours,
   * or redeclared one of yours with a different shape). Don't loop
   * blindly — surface the error.
   *
   * @param extension - Runtime extension document produced by
   *   `defineRuntimeExtension(...)`.
   * @param options.ref - Optional handle whose `current` is overwritten
   *   atomically with the schema commit. Long-lived consumers
   *   (request handlers, background workers) that dereference through
   *   the ref see the new kinds on the *next* call.
   *
   * @throws {RuntimeExtensionValidationError} when the document is
   *   structurally invalid.
   * @throws {ConfigurationError} on kind-name collisions with
   *   compile-time kinds (`RUNTIME_KIND_NAME_COLLISION`),
   *   redefinitions of existing runtime kinds with a different shape
   *   (`RUNTIME_KIND_REDEFINITION`), or unresolvable edge endpoints
   *   (`RUNTIME_EXTENSION_UNRESOLVED_ENDPOINT`).
   * @throws {StaleVersionError} when another writer has advanced the
   *   schema since this store was constructed; recovery as above.
   * @throws {SchemaContentConflictError} when a row already exists at
   *   the target version with a different content hash.
   */
  async evolve(
    extension: RuntimeGraphDocument,
    options?: Readonly<{ ref?: StoreRef<Store<G>> }>,
  ): Promise<Store<G>> {
    const activeRow = await loadActiveSchemaWithBootstrap(
      this.#backend,
      this.graphId,
    );
    if (activeRow === undefined) {
      throw new ConfigurationError(
        `Cannot evolve graph "${this.graphId}": no schema has been initialized. Call createStoreWithSchema first.`,
        { code: "EVOLVE_BEFORE_INITIALIZE" },
      );
    }

    // Catch up to the persisted state first. If another process has
    // evolved the graph since this Store was constructed, the active
    // row's runtimeDocument contains kinds that this.#graph doesn't —
    // applying the new extension on top of the stale local view would
    // make ensureSchema diff against the persisted schema and treat
    // the missing-locally kinds as removed (a breaking-change
    // MigrationError). Auto-merging the stored doc into the baseline
    // makes evolve self-healing across multi-process races; the CAS
    // guard inside commitSchemaVersion still serializes the actual
    // commit. If the stored doc redefines a local runtime kind with a
    // different shape, the merge throws RUNTIME_KIND_REDEFINITION
    // here — surfacing the divergence rather than overwriting.
    const storedSchema = parseSerializedSchema(activeRow.schema_doc);
    const baselineGraph =
      storedSchema.runtimeDocument === undefined ?
        this.#graph
      : mergeRuntimeExtension(this.#graph, storedSchema.runtimeDocument);
    const merged = mergeRuntimeExtension(baselineGraph, extension);

    // No-op evolve (extension already applied): return `this` so the
    // agent loop's repeated `evolve(sameExt)` keeps warm registry,
    // collection, and query caches instead of discarding them on every
    // call. The reference comparison only holds when both merges
    // (stored + extension) returned their input unchanged.
    if (merged === this.#graph) {
      if (options?.ref !== undefined) options.ref.current = this;
      return this;
    }

    // Delegate the serialize → hash → diff → commit dance to
    // `ensureSchema`. It already implements the same-hash short-circuit
    // and the migrate-via-CAS commit; reusing it avoids computing
    // serializeSchema + computeSchemaHash twice (once here, once in
    // migrateSchema). Runtime extensions are additive only, so the
    // diff is always backwards-compatible — autoMigrate succeeds.
    await ensureSchemaImpl(this.#backend, merged, {
      preloaded: { activeRow, storedSchema },
      autoMigrate: true,
    });
    return this.#cloneWithGraph(merged, options?.ref);
  }

  #cloneWithGraph(graph: G, ref: StoreRef<Store<G>> | undefined): Store<G> {
    const next = createStore(graph, this.#backend, this.#options);
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
    entity: "node" | "edge",
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

// ============================================================
// Async Factory with Schema Management
// ============================================================

// Re-export schema manager types
export type {
  SchemaManagerOptions,
  SchemaValidationResult,
} from "../schema/manager";

import {
  ensureSchema as ensureSchemaImpl,
  loadAndMergeRuntimeDocument,
  type SchemaManagerOptions,
  type SchemaValidationResult,
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
  // Fold any persisted runtime extension document into the graph
  // BEFORE constructing the Store. The prefetched row + parsed schema
  // thread through to ensureSchema so each Store boot pays for one DB
  // round trip and one Zod parse, not two. Additional runtime kinds
  // are reachable through the registry but invisible to the type
  // system — see `mergeRuntimeExtension`.
  const {
    graph: merged,
    activeRow,
    storedSchema,
  } = await loadAndMergeRuntimeDocument(backend, graph);

  const store = createStore(merged, backend, options);
  const result = await ensureSchemaImpl(backend, merged, {
    ...options,
    preloaded: { activeRow, storedSchema },
  });
  return [store, result];
}
