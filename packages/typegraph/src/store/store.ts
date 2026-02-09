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
import { type GraphBackend } from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { createQueryBuilder, type QueryBuilder } from "../query/builder";
import { createSqlSchema } from "../query/compiler/schema";
import { buildKindRegistry, type KindRegistry } from "../registry";
import { nowIso } from "../utils/date";
import { generateId } from "../utils/id";
import {
  createEdgeCollectionsProxy,
  createNodeCollectionsProxy,
  type EdgeOperations,
  type NodeOperations,
} from "./collection-factory";
import {
  type EdgeOperationContext,
  executeEdgeCreate,
  executeEdgeDelete,
  executeEdgeHardDelete,
  executeEdgeUpdate,
  executeNodeCreate,
  executeNodeDelete,
  executeNodeHardDelete,
  executeNodeUpdate,
  type NodeOperationContext,
} from "./operations";
import {
  type EdgeRow,
  type NodeRow,
  rowToEdge,
  rowToNode,
} from "./row-mappers";
import {
  type HookContext,
  type NodeCollection,
  type OperationHookContext,
  type QueryOptions,
  type StoreHooks,
  type StoreOptions,
  type TransactionContext,
  type TypedEdgeCollection,
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

  constructor(graph: G, backend: GraphBackend, options?: StoreOptions) {
    this.#graph = graph;
    this.#backend = backend;
    this.#registry = buildKindRegistry(graph);
    this.#hooks = options?.hooks ?? {};
    this.#schema =
      options?.schema ??
      (backend.tableNames ? createSqlSchema(backend.tableNames) : undefined);
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
  get nodes(): {
    [K in keyof G["nodes"] & string]-?: NodeCollection<G["nodes"][K]["type"]>;
  } {
    return createNodeCollectionsProxy(
      this.#graph,
      this.graphId,
      this.#registry,
      this.#backend,
      this.#nodeOperations,
    );
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
  get edges(): {
    [K in keyof G["edges"] & string]-?: TypedEdgeCollection<G["edges"][K]>;
  } {
    return createEdgeCollectionsProxy(
      this.#graph,
      this.graphId,
      this.#registry,
      this.#backend,
      this.#edgeOperations,
    );
  }

  /**
   * Node operations bound to this store instance.
   */
  get #nodeOperations(): NodeOperations {
    const ctx = this.#createNodeOperationContext();
    return {
      rowToNode: (row) => rowToNode(row as NodeRow),
      executeCreate: (input, backend) => executeNodeCreate(ctx, input, backend),
      executeUpdate: (input, backend, options) =>
        executeNodeUpdate(ctx, { ...input, id: input.id }, backend, options),
      executeDelete: (kind, id, backend) =>
        executeNodeDelete(ctx, kind, id, backend),
      executeHardDelete: (kind, id, backend) =>
        executeNodeHardDelete(ctx, kind, id, backend),
      matchesTemporalMode: (row, options) =>
        this.#matchesTemporalMode(row, options),
    };
  }

  /**
   * Edge operations bound to this store instance.
   */
  get #edgeOperations(): EdgeOperations {
    const ctx = this.#createEdgeOperationContext();
    return {
      rowToEdge: (row) => rowToEdge(row as EdgeRow),
      executeCreate: (input, backend) => executeEdgeCreate(ctx, input, backend),
      executeUpdate: (input, backend) => executeEdgeUpdate(ctx, input, backend),
      executeDelete: (id, backend) => executeEdgeDelete(ctx, id, backend),
      executeHardDelete: (id, backend) =>
        executeEdgeHardDelete(ctx, id, backend),
      matchesTemporalMode: (row, options) =>
        this.#matchesTemporalMode(row, options),
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
    return createQueryBuilder<G>(this.graphId, this.#registry, {
      backend: this.#backend,
      dialect: this.#backend.dialect,
      ...(this.#schema !== undefined && { schema: this.#schema }),
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
   */
  async transaction<T>(
    fn: (tx: TransactionContext<G>) => Promise<T>,
  ): Promise<T> {
    return this.#backend.transaction(async (txBackend) => {
      // Create collections using transaction backend
      const nodes = createNodeCollectionsProxy(
        this.#graph,
        this.graphId,
        this.#registry,
        txBackend,
        this.#nodeOperations,
      );

      const edges = createEdgeCollectionsProxy(
        this.#graph,
        this.graphId,
        this.#registry,
        txBackend,
        this.#edgeOperations,
      );

      return fn({ nodes, edges });
    });
  }

  // === Lifecycle ===

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
  type SchemaManagerOptions,
  type SchemaValidationResult,
} from "../schema/manager";

/**
 * Creates a store and ensures the schema is initialized/migrated.
 *
 * This is the recommended way to create a store in production.
 * It automatically:
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
 * }
 * ```
 */
export async function createStoreWithSchema<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
  options?: StoreOptions & SchemaManagerOptions,
): Promise<[Store<G>, SchemaValidationResult]> {
  const store = createStore(graph, backend, options);
  const result = await ensureSchemaImpl(backend, graph, options);
  return [store, result];
}
