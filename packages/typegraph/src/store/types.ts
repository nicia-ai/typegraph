/**
 * Store types for TypeGraph operations.
 */
import { type z } from "zod";

import { type GraphDef } from "../core/define-graph";
import {
  type AnyEdgeType,
  type EdgeRegistration,
  type EdgeType,
  type NodeId,
  type NodeType,
  type TemporalMode,
} from "../core/types";
import type { TraversalExpansion } from "../query/ast";
import type { NodeAccessor } from "../query/builder/types";
import { type SqlSchema } from "../query/compiler/schema";
import type { Predicate } from "../query/predicates";

// ============================================================
// Node Instance Types
// ============================================================

/**
 * Metadata for a node instance.
 */
export type NodeMeta = Readonly<{
  version: number;
  validFrom: string | undefined;
  validTo: string | undefined;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | undefined;
}>;

/**
 * A node instance in the graph.
 *
 * Properties from the schema are spread at the top level for ergonomic access:
 * - `node.name` instead of `node.props.name`
 * - System metadata is under `node.meta.*`
 */
export type Node<N extends NodeType = NodeType> = Readonly<{
  kind: N["kind"];
  id: NodeId<N>;
  meta: NodeMeta;
}> &
  Readonly<z.infer<N["schema"]>>;

/**
 * Input for creating a node.
 */
export type CreateNodeInput<N extends NodeType = NodeType> = Readonly<{
  kind: N["kind"];
  id?: string; // Optional - will generate ULID if not provided
  props: z.infer<N["schema"]>;
  validFrom?: string;
  validTo?: string;
}>;

/**
 * Input for updating a node.
 */
export type UpdateNodeInput<N extends NodeType = NodeType> = Readonly<{
  kind: N["kind"];
  id: NodeId<N>;
  props: Partial<z.infer<N["schema"]>>;
  validTo?: string;
}>;

// ============================================================
// Edge Instance Types
// ============================================================

/**
 * Metadata for an edge instance.
 */
export type EdgeMeta = Readonly<{
  validFrom: string | undefined;
  validTo: string | undefined;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | undefined;
}>;

/**
 * An edge instance in the graph.
 *
 * Properties from the schema are spread at the top level for ergonomic access:
 * - `edge.role` instead of `edge.props.role`
 * - System metadata is under `edge.meta.*`
 */
export type Edge<E extends AnyEdgeType = EdgeType> = Readonly<{
  id: string;
  kind: E["kind"];
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  meta: EdgeMeta;
}> &
  Readonly<z.infer<E["schema"]>>;

/**
 * Input for creating an edge.
 */
export type CreateEdgeInput<E extends AnyEdgeType = EdgeType> = Readonly<{
  kind: E["kind"];
  id?: string; // Optional - will generate ULID if not provided
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  props: z.infer<E["schema"]>;
  validFrom?: string;
  validTo?: string;
}>;

/**
 * Input for updating an edge.
 */
export type UpdateEdgeInput<E extends AnyEdgeType = EdgeType> = Readonly<{
  id: string;
  props: Partial<z.infer<E["schema"]>>;
  validTo?: string;
}>;

// ============================================================
// Query Options
// ============================================================

/**
 * Options for node and edge queries.
 */
export type QueryOptions = Readonly<{
  /** Temporal mode for the query */
  temporalMode?: TemporalMode;
  /** Specific timestamp for asOf queries */
  asOf?: string;
}>;

// ============================================================
// Observability Hooks
// ============================================================

/**
 * Context passed to observability hooks.
 */
export type HookContext = Readonly<{
  /** Unique ID for this operation */
  operationId: string;
  /** Graph ID */
  graphId: string;
  /** Timestamp when operation started */
  startedAt: Date;
}>;

/**
 * Query hook context with SQL information.
 */
export type QueryHookContext = HookContext &
  Readonly<{
    /** The SQL query being executed */
    sql: string;
    /** Query parameters */
    params: readonly unknown[];
  }>;

/**
 * Operation hook context for CRUD operations.
 */
export type OperationHookContext = HookContext &
  Readonly<{
    /** Operation type */
    operation: "create" | "update" | "delete";
    /** Entity type */
    entity: "node" | "edge";
    /** Kind of node or edge */
    kind: string;
    /** Entity ID */
    id: string;
  }>;

/**
 * Observability hooks for monitoring store operations.
 *
 * Note: Batch operations (`bulkCreate`, `bulkInsert`, `bulkUpsertById`) skip
 * per-item operation hooks for throughput. Query hooks still fire normally.
 *
 * @example
 * ```typescript
 * const hooks: StoreHooks = {
 *   onQueryStart: (ctx) => {
 *     console.log(`[${ctx.operationId}] Query: ${ctx.sql}`);
 *   },
 *   onQueryEnd: (ctx, result) => {
 *     const duration = Date.now() - ctx.startedAt.getTime();
 *     console.log(`[${ctx.operationId}] Completed in ${duration}ms`);
 *   },
 *   onError: (ctx, error) => {
 *     console.error(`[${ctx.operationId}] Error:`, error);
 *   },
 * };
 *
 * const store = createStore(graph, backend, { hooks });
 * ```
 */
export type StoreHooks = Readonly<{
  /** Called before a query is executed */
  onQueryStart?: (ctx: QueryHookContext) => void;
  /** Called after a query completes successfully */
  onQueryEnd?: (
    ctx: QueryHookContext,
    result: Readonly<{ rowCount: number; durationMs: number }>,
  ) => void;
  /** Called before a CRUD operation starts */
  onOperationStart?: (ctx: OperationHookContext) => void;
  /** Called after a CRUD operation completes */
  onOperationEnd?: (
    ctx: OperationHookContext,
    result: Readonly<{ durationMs: number }>,
  ) => void;
  /** Called when an error occurs */
  onError?: (ctx: HookContext, error: Error) => void;
}>;

// ============================================================
// Store Configuration
// ============================================================

/**
 * Options for creating a store.
 */
export type StoreOptions = Readonly<{
  /** Observability hooks for monitoring */
  hooks?: StoreHooks;
  /** SQL schema configuration for custom table names */
  schema?: SqlSchema;
  /** Query default behaviors. */
  queryDefaults?: Readonly<{
    /** Default traversal ontology expansion mode (default: "inverse"). */
    traversalExpansion?: TraversalExpansion;
  }>;
}>;

// ============================================================
// Get-Or-Create Types
// ============================================================

/**
 * Behavior when a get-or-create operation matches an existing record.
 */
export type IfExistsMode = "return" | "update";

/**
 * Action taken by a get-or-create operation.
 */
export type GetOrCreateAction = "created" | "found" | "updated" | "resurrected";

/**
 * Result of a node getOrCreateByConstraint operation.
 */
export type NodeGetOrCreateByConstraintResult<N extends NodeType> = Readonly<{
  node: Node<N>;
  action: GetOrCreateAction;
}>;

/**
 * Options for node getOrCreateByConstraint operations.
 */
export type NodeGetOrCreateByConstraintOptions = Readonly<{
  /** Existing record behavior. Default: "return" */
  ifExists?: IfExistsMode;
}>;

/**
 * Result of an edge getOrCreateByEndpoints operation.
 */
export type EdgeGetOrCreateByEndpointsResult<E extends AnyEdgeType> = Readonly<{
  edge: Edge<E>;
  action: GetOrCreateAction;
}>;

/**
 * Options for edge findByEndpoints operations.
 */
export type EdgeFindByEndpointsOptions<E extends AnyEdgeType> = Readonly<{
  /**
   * Edge property fields to include in the match alongside the (from, to) endpoints.
   * When omitted, matches on endpoints only (returns first live edge).
   */
  matchOn?: readonly (keyof z.input<E["schema"]>)[];
  /** Property values to match against when matchOn is specified. */
  props?: Partial<z.input<E["schema"]>>;
}>;

/**
 * Options for edge getOrCreateByEndpoints operations.
 */
export type EdgeGetOrCreateByEndpointsOptions<E extends AnyEdgeType> =
  Readonly<{
    /**
     * Edge property fields to include in the match key alongside the (from, to) endpoints.
     * Default: `[]` — match on endpoints only.
     */
    matchOn?: readonly (keyof z.input<E["schema"]>)[];
    /** Existing record behavior. Default: "return" */
    ifExists?: IfExistsMode;
  }>;

// ============================================================
// Collection Interfaces
// ============================================================

/**
 * A collection of nodes of a specific type.
 *
 * Provides ergonomic CRUD operations for a single node type.
 */
export type NodeCollection<N extends NodeType> = Readonly<{
  /** Create a new node */
  create: (
    props: z.input<N["schema"]>,
    options?: Readonly<{ id?: string; validFrom?: string; validTo?: string }>,
  ) => Promise<Node<N>>;

  /** Get a node by ID */
  getById: (
    id: NodeId<N>,
    options?: QueryOptions,
  ) => Promise<Node<N> | undefined>;

  /** Get multiple nodes by ID, preserving input order (undefined for missing) */
  getByIds: (
    ids: readonly NodeId<N>[],
    options?: QueryOptions,
  ) => Promise<readonly (Node<N> | undefined)[]>;

  /** Update a node */
  update: (
    id: NodeId<N>,
    props: Partial<z.input<N["schema"]>>,
    options?: Readonly<{ validTo?: string }>,
  ) => Promise<Node<N>>;

  /** Delete a node (soft delete - sets deletedAt timestamp) */
  delete: (id: NodeId<N>) => Promise<void>;

  /**
   * Permanently delete a node from the database.
   *
   * Unlike `delete()` which performs a soft delete, this permanently
   * removes the node and its associated data (uniqueness entries, embeddings).
   *
   * **Warning:** This operation is irreversible and should be used carefully.
   * Consider using soft delete (`delete()`) for most use cases.
   *
   * @throws Error if edges are still connected to this node (delete edges first)
   */
  hardDelete: (id: NodeId<N>) => Promise<void>;

  /**
   * Find nodes matching criteria.
   *
   * Supports predicate filtering via the `where` option for SQL-level filtering.
   * For simple queries. Use store.query() for complex traversals.
   */
  find: (
    options?: Readonly<{
      where?: (accessor: NodeAccessor<N>) => Predicate;
      limit?: number;
      offset?: number;
      temporalMode?: TemporalMode;
      asOf?: string;
    }>,
  ) => Promise<Node<N>[]>;

  /** Count nodes matching criteria */
  count: (options?: QueryOptions) => Promise<number>;

  /**
   * Create or update a node.
   *
   * If a node with the given ID exists, updates it with the provided props.
   * Otherwise, creates a new node with that ID.
   */
  upsertById: (
    id: string,
    props: z.input<N["schema"]>,
    options?: Readonly<{ validFrom?: string; validTo?: string }>,
  ) => Promise<Node<N>>;

  /**
   * Create multiple nodes in a batch.
   *
   * More efficient than calling create() multiple times.
   * Use `bulkInsert` for the dedicated fast path that skips returning results.
   */
  bulkCreate: (
    items: readonly Readonly<{
      props: z.input<N["schema"]>;
      id?: string;
      validFrom?: string;
      validTo?: string;
    }>[],
  ) => Promise<Node<N>[]>;

  /**
   * Create or update multiple nodes in a batch.
   *
   * For each item, if a node with the given ID exists, updates it.
   * Otherwise, creates a new node with that ID.
   */
  bulkUpsertById: (
    items: readonly Readonly<{
      id: string;
      props: z.input<N["schema"]>;
      validFrom?: string;
      validTo?: string;
    }>[],
  ) => Promise<Node<N>[]>;

  /**
   * Insert multiple nodes without returning results.
   *
   * This is the dedicated fast path for bulk inserts. Unlike `bulkCreate`
   * with `returnResults: false`, the intent is unambiguous: no results
   * are returned and the operation is wrapped in a transaction.
   */
  bulkInsert: (
    items: readonly Readonly<{
      props: z.input<N["schema"]>;
      id?: string;
      validFrom?: string;
      validTo?: string;
    }>[],
  ) => Promise<void>;

  /**
   * Delete multiple nodes by ID.
   *
   * Atomic when the backend supports transactions. Silently ignores IDs
   * that don't exist.
   */
  bulkDelete: (ids: readonly NodeId<N>[]) => Promise<void>;

  /**
   * Find a node by uniqueness constraint.
   *
   * Looks up a live node by the named constraint key computed from `props`.
   * Returns the node if found, or undefined. Soft-deleted nodes are excluded.
   *
   * @param constraintName - Name of the uniqueness constraint to match on
   * @param props - Properties to compute the constraint key from
   */
  findByConstraint: (
    constraintName: string,
    props: z.input<N["schema"]>,
  ) => Promise<Node<N> | undefined>;

  /**
   * Batch version of findByConstraint.
   *
   * Results are returned in the same order as the input items.
   * Returns undefined for entries that don't match.
   */
  bulkFindByConstraint: (
    constraintName: string,
    items: readonly Readonly<{
      props: z.input<N["schema"]>;
    }>[],
  ) => Promise<(Node<N> | undefined)[]>;

  /**
   * Get an existing node by uniqueness constraint, or create a new one.
   *
   * Looks up a node by the named constraint key computed from `props`.
   * If found, returns it (optionally updating with `ifExists: "update"`).
   * If not found, creates a new node. Soft-deleted matches are always resurrected.
   *
   * @param constraintName - Name of the uniqueness constraint to match on
   * @param props - Full properties for create, or merge source for update
   * @param options - Existing record behavior (default: "return")
   */
  getOrCreateByConstraint: (
    constraintName: string,
    props: z.input<N["schema"]>,
    options?: NodeGetOrCreateByConstraintOptions,
  ) => Promise<NodeGetOrCreateByConstraintResult<N>>;

  /**
   * Batch version of getOrCreateByConstraint.
   *
   * Results are returned in the same order as the input items.
   * Atomic when the backend supports transactions.
   */
  bulkGetOrCreateByConstraint: (
    constraintName: string,
    items: readonly Readonly<{
      props: z.input<N["schema"]>;
    }>[],
    options?: NodeGetOrCreateByConstraintOptions,
  ) => Promise<NodeGetOrCreateByConstraintResult<N>[]>;
}>;

/**
 * Reference to a node endpoint (kind and id).
 *
 * Can be either an explicit `{ kind, id }` object or a Node instance.
 */
export type NodeRef = Readonly<{ kind: string; id: string }>;

/**
 * Type-safe reference to a node of a specific kind.
 *
 * Accepts either:
 * - A Node instance of the correct kind
 * - An explicit { kind, id } object with the correct kind name
 *
 * This provides compile-time checking that edge endpoints match the
 * allowed node kinds defined in the edge registration.
 */
export type TypedNodeRef<N extends NodeType> =
  | Node<N>
  | Readonly<{ kind: N["kind"]; id: string }>;

/**
 * Options for creating an edge.
 */
type EdgeCreateOptions = Readonly<{
  id?: string;
  validFrom?: string;
  validTo?: string;
}>;

/**
 * Arguments for edge creation, with props optional when schema allows empty object.
 *
 * Uses `{}` to check if an empty object literal satisfies the schema input type.
 */
/* eslint-disable @typescript-eslint/no-empty-object-type -- {} is intentional: checking if empty object satisfies schema */
type EdgeCreateArguments<E extends AnyEdgeType> =
  {} extends z.input<E["schema"]> ?
    [props?: z.input<E["schema"]>, options?: EdgeCreateOptions]
  : [props: z.input<E["schema"]>, options?: EdgeCreateOptions];
/* eslint-enable @typescript-eslint/no-empty-object-type */

/**
 * A collection of edges of a specific type.
 *
 * Provides ergonomic CRUD operations for a single edge type.
 * The From and To type parameters enforce that edge endpoints
 * match the allowed node types at compile time.
 *
 * @example
 * ```typescript
 * // Create an edge - pass Node objects directly
 * const edge = await store.edges.worksAt.create(alice, acme, { role: "Engineer" });
 *
 * // TypeScript error: Company is not a valid 'from' type for worksAt
 * // store.edges.worksAt.create(acme, alice, { role: "Engineer" });
 *
 * // For edges with empty schemas, props is optional
 * await store.edges.wrote.create(author, book);
 *
 * // Find edges from a node
 * const edges = await store.edges.worksAt.findFrom(alice);
 * ```
 */
export type EdgeCollection<
  E extends AnyEdgeType,
  From extends NodeType = NodeType,
  To extends NodeType = NodeType,
> = Readonly<{
  /**
   * Create a new edge.
   *
   * @param from - Source node (must be one of the allowed 'from' types)
   * @param to - Target node (must be one of the allowed 'to' types)
   * @param args - Edge properties (optional if schema is empty) and creation options
   */
  create: (
    from: TypedNodeRef<From>,
    to: TypedNodeRef<To>,
    ...args: EdgeCreateArguments<E>
  ) => Promise<Edge<E>>;

  /** Get an edge by ID */
  getById: (id: string, options?: QueryOptions) => Promise<Edge<E> | undefined>;

  /** Get multiple edges by ID, preserving input order (undefined for missing) */
  getByIds: (
    ids: readonly string[],
    options?: QueryOptions,
  ) => Promise<readonly (Edge<E> | undefined)[]>;

  /** Update an edge's properties */
  update: (
    id: string,
    props: Partial<z.input<E["schema"]>>,
    options?: Readonly<{ validTo?: string }>,
  ) => Promise<Edge<E>>;

  /** Find edges from a specific node */
  findFrom: (from: TypedNodeRef<From>) => Promise<Edge<E>[]>;

  /** Find edges to a specific node */
  findTo: (to: TypedNodeRef<To>) => Promise<Edge<E>[]>;

  /** Delete an edge (soft delete - sets deletedAt timestamp) */
  delete: (id: string) => Promise<void>;

  /**
   * Permanently delete an edge from the database.
   *
   * Unlike `delete()` which performs a soft delete, this permanently
   * removes the edge record.
   *
   * **Warning:** This operation is irreversible and should be used carefully.
   * Consider using soft delete (`delete()`) for most use cases.
   */
  hardDelete: (id: string) => Promise<void>;

  /** Find edges matching endpoint and pagination criteria */
  find: (
    options?: Readonly<{
      from?: TypedNodeRef<From>;
      to?: TypedNodeRef<To>;
      limit?: number;
      offset?: number;
      temporalMode?: TemporalMode;
      asOf?: string;
    }>,
  ) => Promise<Edge<E>[]>;

  /** Count edges matching criteria */
  count: (
    options?: Readonly<{
      from?: TypedNodeRef<From>;
      to?: TypedNodeRef<To>;
      temporalMode?: TemporalMode;
      asOf?: string;
    }>,
  ) => Promise<number>;

  /**
   * Create multiple edges in a batch.
   *
   * More efficient than calling create() multiple times.
   * Use `bulkInsert` for the dedicated fast path that skips returning results.
   */
  bulkCreate: (
    items: readonly Readonly<{
      from: TypedNodeRef<From>;
      to: TypedNodeRef<To>;
      props?: z.input<E["schema"]>;
      id?: string;
      validFrom?: string;
      validTo?: string;
    }>[],
  ) => Promise<Edge<E>[]>;

  /**
   * Create or update multiple edges in a batch.
   *
   * For each item, if an edge with the given ID exists, updates it.
   * Otherwise, creates a new edge with that ID.
   */
  bulkUpsertById: (
    items: readonly Readonly<{
      id: string;
      from: TypedNodeRef<From>;
      to: TypedNodeRef<To>;
      props?: z.input<E["schema"]>;
      validFrom?: string;
      validTo?: string;
    }>[],
  ) => Promise<Edge<E>[]>;

  /**
   * Insert multiple edges without returning results.
   *
   * This is the dedicated fast path for bulk inserts. Unlike `bulkCreate`
   * with `returnResults: false`, the intent is unambiguous: no results
   * are returned and the operation is wrapped in a transaction.
   */
  bulkInsert: (
    items: readonly Readonly<{
      from: TypedNodeRef<From>;
      to: TypedNodeRef<To>;
      props?: z.input<E["schema"]>;
      id?: string;
      validFrom?: string;
      validTo?: string;
    }>[],
  ) => Promise<void>;

  /**
   * Delete multiple edges by ID.
   *
   * Atomic when the backend supports transactions. Silently ignores IDs
   * that don't exist.
   */
  bulkDelete: (ids: readonly string[]) => Promise<void>;

  /**
   * Find a live edge by endpoints and optional property fields.
   *
   * Returns the first matching live edge, or undefined.
   * Soft-deleted edges are excluded.
   *
   * @param from - Source node
   * @param to - Target node
   * @param options - Match criteria (matchOn fields and property values)
   */
  findByEndpoints: (
    from: TypedNodeRef<From>,
    to: TypedNodeRef<To>,
    options?: EdgeFindByEndpointsOptions<E>,
  ) => Promise<Edge<E> | undefined>;

  /**
   * Get an existing edge by endpoints and optional property fields, or create a new one.
   *
   * Matches edges of this kind between `(from, to)`. When `matchOn` specifies
   * property fields, only edges whose properties match on those fields are considered.
   * Soft-deleted matches are resurrected when cardinality allows.
   *
   * @param from - Source node
   * @param to - Target node
   * @param props - Full properties for create, or merge source for update
   * @param options - Match criteria and conflict resolution
   */
  getOrCreateByEndpoints: (
    from: TypedNodeRef<From>,
    to: TypedNodeRef<To>,
    props: z.input<E["schema"]>,
    options?: EdgeGetOrCreateByEndpointsOptions<E>,
  ) => Promise<EdgeGetOrCreateByEndpointsResult<E>>;

  /**
   * Batch version of getOrCreateByEndpoints.
   *
   * Results are returned in the same order as the input items.
   * Atomic when the backend supports transactions.
   */
  bulkGetOrCreateByEndpoints: (
    items: readonly Readonly<{
      from: TypedNodeRef<From>;
      to: TypedNodeRef<To>;
      props: z.input<E["schema"]>;
    }>[],
    options?: EdgeGetOrCreateByEndpointsOptions<E>,
  ) => Promise<EdgeGetOrCreateByEndpointsResult<E>[]>;
}>;

// ============================================================
// Type Helpers
// ============================================================

/**
 * Extract the union of 'from' node types from an EdgeRegistration.
 */
type EdgeFromTypes<R extends EdgeRegistration> =
  R["from"] extends readonly (infer N)[] ? N : never;

/**
 * Extract the union of 'to' node types from an EdgeRegistration.
 */
type EdgeToTypes<R extends EdgeRegistration> =
  R["to"] extends readonly (infer N)[] ? N : never;

/**
 * Create a type-safe EdgeCollection from an EdgeRegistration.
 * Extracts the edge type and from/to node types automatically.
 */
export type TypedEdgeCollection<R extends EdgeRegistration> = EdgeCollection<
  R["type"],
  EdgeFromTypes<R> extends NodeType ? EdgeFromTypes<R> : NodeType,
  EdgeToTypes<R> extends NodeType ? EdgeToTypes<R> : NodeType
>;

// ============================================================
// Transaction Types
// ============================================================

/**
 * A typed transaction context with collection API.
 *
 * Provides the same `tx.nodes.*` and `tx.edges.*` API as the Store,
 * but operations are executed within the transaction scope.
 *
 * @example
 * ```typescript
 * await store.transaction(async (tx) => {
 *   const person = await tx.nodes.Person.create({ name: "Alice" });
 *   const company = await tx.nodes.Company.create({ name: "Acme" });
 *   // Pass nodes directly - their kind and id properties are used
 *   await tx.edges.worksAt.create(person, company, { role: "Engineer" });
 * });
 * ```
 */
export type TransactionContext<G extends GraphDef> = Readonly<{
  /** Node collections for the transaction */
  nodes: {
    [K in keyof G["nodes"] & string]-?: NodeCollection<G["nodes"][K]["type"]>;
  };

  /** Edge collections for the transaction */
  edges: {
    [K in keyof G["edges"] & string]-?: TypedEdgeCollection<G["edges"][K]>;
  };
}>;
