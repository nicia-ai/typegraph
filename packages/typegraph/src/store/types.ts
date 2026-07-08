/**
 * Store types for TypeGraph operations.
 */
import { type z } from "zod";

import {
  type AdoptedTransaction,
  type EdgeRow,
  type NodeRow,
  type TransactionBackend,
} from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { type RecordedInstant } from "../core/temporal";
import {
  type AnyEdgeType,
  type EdgeId,
  type EdgeRegistration,
  type EdgeType,
  type KindEntity,
  type NodeId,
  type NodeRegistration,
  type NodeType,
  type TemporalMode,
} from "../core/types";
import type { TraversalExpansion } from "../query/ast";
import type { BatchableQuery, NodeAccessor } from "../query/builder/types";
import {
  type ExternalRecordedReadSource,
  type SqlSchema,
} from "../query/compiler/schema";
import type { Predicate } from "../query/predicates";
import type {
  CURRENT_ONLY_READ_NAMES,
  EDGE_BATCH_READ_NAMES,
  EDGE_TEMPORAL_READ_NAMES,
  EDGE_WRITE_NAMES,
  NODE_TEMPORAL_READ_NAMES,
  NODE_WRITE_NAMES,
  RECORDED_POINT_READ_NAMES,
} from "./collection-surface";

// ============================================================
// Row-to-Meta Field Mapping
// ============================================================

/**
 * Canonical mapping from snake_case row fields to camelCase meta fields.
 *
 * This is the single source of truth for which row columns become metadata.
 * Both the Meta types and the row-to-meta functions in row-mappers.ts must
 * stay in sync with this mapping. If you add a temporal/audit column to a
 * row type, add the mapping here — the compiler will then force you to
 * update the row mapper functions as well (since their return type is
 * NodeMeta/EdgeMeta, which is derived from this mapping).
 */
type TemporalMetaFieldMap = Readonly<{
  valid_from: "validFrom";
  valid_to: "validTo";
  created_at: "createdAt";
  updated_at: "updatedAt";
  deleted_at: "deletedAt";
}>;

/**
 * Maps row fields to their camelCase meta counterparts, preserving types.
 */
type MapRowToMeta<
  R extends Readonly<Record<string, unknown>>,
  M extends Readonly<Record<string, string>>,
> = Readonly<{
  [SnakeKey in keyof M as M[SnakeKey] & string]: SnakeKey extends keyof R ?
    R[SnakeKey]
  : never;
}>;

// ============================================================
// Node Instance Types
// ============================================================

/**
 * Metadata for a node instance.
 * Derived from NodeRow via TemporalMetaFieldMap + version.
 *
 * Adding a new metadata column requires:
 * 1. Add the column to NodeRow in backend/types.ts
 * 2. Add the mapping to TemporalMetaFieldMap above
 * 3. The compiler will error in rowToNodeMeta() until you add the field there
 */
export type NodeMeta = MapRowToMeta<NodeRow, TemporalMetaFieldMap> &
  Readonly<{ version: NodeRow["version"] }>;

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
 * Derived from EdgeRow via TemporalMetaFieldMap (edges have no version).
 */
export type EdgeMeta = MapRowToMeta<EdgeRow, TemporalMetaFieldMap>;

/**
 * An edge instance in the graph.
 *
 * Properties from the schema are spread at the top level for ergonomic access:
 * - `edge.role` instead of `edge.props.role`
 * - System metadata is under `edge.meta.*`
 */
export type Edge<
  E extends AnyEdgeType = EdgeType,
  From extends NodeType = NodeType,
  To extends NodeType = NodeType,
> = Readonly<{
  id: EdgeId<E>;
  kind: E["kind"];
  fromKind: From["kind"];
  fromId: NodeId<From>;
  toKind: To["kind"];
  toId: NodeId<To>;
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
  id: EdgeId<E>;
  props: Partial<z.infer<E["schema"]>>;
  validTo?: string;
}>;

// ============================================================
// Query Options
// ============================================================

/**
 * Options for node and edge queries.
 */
export type NoRecordedCoordinate = Readonly<{
  /**
   * Recorded/system-time coordinates are internal-only and supplied by
   * RecordedStoreView. A public options object carrying this key is a type
   * error even when the object is pre-bound before the call site.
   */
  recordedAsOf?: never;
}>;

export type QueryOptions = NoRecordedCoordinate &
  Readonly<{
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
    entity: KindEntity;
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
  /**
   * Called after a CRUD operation completes AND is durably committed. For a
   * top-level operation that is when its own transaction commits; for an
   * operation inside `store.transaction`, emission is deferred until the
   * enclosing transaction commits — if that commit fails, the operation is
   * reported through `onError` instead. (Inside an adopted transaction —
   * `withTransaction` / `withRecordedTransaction` — the commit belongs to
   * the caller and cannot be observed, so this fires when the operation
   * completes within the still-open transaction.)
   */
  onOperationEnd?: (
    ctx: OperationHookContext,
    result: Readonly<{ durationMs: number }>,
  ) => void;
  /**
   * Called when an operation fails — including an operation that completed
   * inside a `store.transaction` whose commit then failed and rolled it
   * back.
   */
  onError?: (ctx: HookContext, error: Error) => void;
}>;

// ============================================================
// Store Configuration
// ============================================================

/**
 * Default row count at which an autocommit bulk write triggers an
 * automatic planner-statistics refresh. Below this, the refresh cost is
 * not worth paying per call and autovacuum/PRAGMA optimize cover it.
 */
export const AUTO_REFRESH_STATISTICS_ROW_THRESHOLD = 1000;

type BaseStoreOptions = Readonly<{
  /** Observability hooks for monitoring */
  hooks?: StoreHooks;
  /**
   * Automatic planner-statistics refresh after large autocommit bulk
   * writes (bulkCreate and bulkInsert on nodes and edges). Stale statistics after a
   * bulk load are a whole class of planner cliffs: the planner keeps
   * pre-load row estimates until ANALYZE runs. When a single
   * autocommit bulk write reaches the threshold
   * ({@link AUTO_REFRESH_STATISTICS_ROW_THRESHOLD} rows by default),
   * the store runs `refreshStatistics()` after the write commits.
   * Pass a number to change the threshold, or `false` to disable.
   * Bulk writes inside a caller-provided transaction never
   * auto-refresh (statistics cannot see uncommitted rows); refresh
   * manually after commit. `importGraph` handles its own refresh.
   */
  autoRefreshStatistics?: false | number;
  /** SQL schema configuration from createSqlSchema(...) for custom table names */
  schema?: SqlSchema;
  /** Query default behaviors. */
  queryDefaults?: Readonly<{
    /** Default traversal ontology expansion mode (default: "inverse"). */
    traversalExpansion?: TraversalExpansion;
  }>;
}>;

/**
 * Store options without built-in recorded-time capture. A recorded read relation
 * can still be bound explicitly for hosts that populate history externally.
 */
export type LiveStoreOptions = BaseStoreOptions &
  Readonly<{
    history?: false | undefined;
    recordedRead?: ExternalRecordedReadSource | undefined;
  }>;

/**
 * Store options with TypeGraph-managed recorded-time capture. `history: true`
 * captures TypeGraph writes and binds TypeGraph's built-in recorded relation
 * internally. Externally populated recorded read sources are read-only bindings
 * and are intentionally accepted only by {@link LiveStoreOptions}.
 */
export type HistoryStoreOptions = BaseStoreOptions &
  Readonly<{
    history: true;
    recordedRead?: never;
  }>;

/**
 * Options for creating a store.
 */
export type StoreOptions = LiveStoreOptions | HistoryStoreOptions;

/**
 * A mutable handle to the current `Store`, used by `store.evolve(...)`
 * so long-lived consumers can dereference through the ref and pick up
 * the new store after each evolve call. `current` is overwritten by
 * `evolve()` atomically with the schema commit when the ref is passed
 * via `evolve(extension, { ref })`.
 *
 * **Mid-request semantics.** `ref.current` flips on the *next* call
 * after evolve, not mid-handler. Dereference once at request entry and
 * reuse the captured `Store` for the duration:
 *
 * ```ts
 * async function handleRequest(): Promise<void> {
 *   const store = ref.current; // capture once
 *   const tag = await store.nodes.Tag?.create({ label: "..." });
 *   // ...further work on the same `store`...
 * }
 * ```
 *
 * Pure dereferenceable handle — no event/subscription machinery. If
 * consumers need eventing, they wrap the ref themselves.
 *
 * Generic over the held value (typically `Store<G>`) so the store
 * module can refer to it without importing the `Store` class into
 * `types.ts`.
 */
export interface StoreRef<T> {
  current: T;
}

// ============================================================
// Transaction Receipt Types
// ============================================================

/**
 * Summary returned by `store.transactionWithReceipt(fn)`.
 */
export type TransactionOutcome<T> = Readonly<{
  result: T;
  receipt: TransactionReceipt;
}>;

/**
 * Transaction write summary.
 *
 * Receipt counts are completed write intents at the collection surface, not
 * rows affected:
 *
 * 1. Every successful completion of a write method on `tx.nodes.*` /
 *    `tx.edges.*` counts. The authoritative method list is
 *    {@link NodeWrites} / {@link EdgeWrites}.
 * 2. Bulk methods count by input length; an empty bulk call (`bulkCreate([])`)
 *    counts 0.
 * 3. Single-row methods count 1 on resolve — including `delete` of an absent
 *    id and `getOrCreate*` that found an existing row. Consumers that need
 *    "did anything actually change" semantics apply their own per-operation
 *    policy.
 * 4. A method that rejects counts 0 — even when the backend applied part of a
 *    bulk input before failing. On SQLite a failed statement does not abort
 *    the surrounding transaction, so a caller that catches the rejection and
 *    commits can persist rows the receipt never counted. Do not read the
 *    receipt as rows-affected in that scenario.
 * 5. A node `delete` under `cascade` / `disconnect` removes connected edges
 *    through the backend, not the edge-collection surface; those removals do
 *    not appear in `edges`.
 * 6. Rows-affected fidelity is intentionally out of scope for this first
 *    version; a future extension could ask backends to return row counts.
 */
export type TransactionReceipt = Readonly<{
  writes: Readonly<{
    /** Completed node write intents by node kind. */
    nodes: Readonly<Record<string, number>>;
    /** Completed edge write intents by edge kind. */
    edges: Readonly<Record<string, number>>;
    /** Sum of all node and edge write intents. */
    total: number;
  }>;
  /**
   * The recorded commit instant allocated for this store's graph by this
   * transaction. Undefined when history capture is off, the transaction is
   * read-only, or no captured writes were flushed.
   */
  recorded?: RecordedInstant;
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
 * Options for node bulkFindByIndex operations.
 */
export type NodeBulkFindByIndexOptions = Readonly<{
  /**
   * Maximum number of candidate nodes returned per input item. When omitted,
   * each input's candidate set is unbounded. Must be a positive integer.
   *
   * Candidates are ordered deterministically by node id, so the cap is stable
   * across calls. Use this to bound fan-out on low-selectivity index keys.
   */
  limitPerInput?: number;
}>;

/**
 * Result of an edge getOrCreateByEndpoints operation.
 */
export type EdgeGetOrCreateByEndpointsResult<
  E extends AnyEdgeType,
  From extends NodeType = NodeType,
  To extends NodeType = NodeType,
> = Readonly<{
  edge: Edge<E, From, To>;
  action: GetOrCreateAction;
}>;

/**
 * Options for edge findByEndpoints operations.
 */
export type EdgeFindByEndpointsOptions<E extends AnyEdgeType> = Readonly<{
  /**
   * Edge property fields to include in the match alongside the (from, to) endpoints.
   * When omitted, matches on endpoints only (returns the first edge at the read coordinate).
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
export type NodeCollection<
  N extends NodeType,
  CN extends string = string,
> = Readonly<{
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
    filter?: Readonly<{
      where?: (accessor: NodeAccessor<N>) => Predicate;
      limit?: number;
      offset?: number;
    }>,
    temporal?: QueryOptions,
  ) => Promise<Node<N>[]>;

  /** Count nodes matching criteria */
  count: (temporal?: QueryOptions) => Promise<number>;

  /**
   * Create a node from untyped data, relying on runtime Zod validation.
   *
   * Use this for dynamic dispatch (changesets, migrations, imports) where
   * the data shape is determined at runtime, not compile time.
   * The return type is fully typed — only the input gate is relaxed.
   */
  createFromRecord: (
    data: Record<string, unknown>,
    options?: Readonly<{ id?: string; validFrom?: string; validTo?: string }>,
  ) => Promise<Node<N>>;

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
   * Upsert a node from untyped data, relying on runtime Zod validation.
   *
   * Use this for dynamic dispatch (changesets, migrations, imports) where
   * the data shape is determined at runtime, not compile time.
   * The return type is fully typed — only the input gate is relaxed.
   */
  upsertByIdFromRecord: (
    id: string,
    data: Record<string, unknown>,
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
    constraintName: CN,
    props: z.input<N["schema"]>,
  ) => Promise<Node<N> | undefined>;

  /**
   * Batch version of findByConstraint.
   *
   * Results are returned in the same order as the input items.
   * Returns undefined for entries that don't match.
   */
  bulkFindByConstraint: (
    constraintName: CN,
    items: readonly Readonly<{
      props: z.input<N["schema"]>;
    }>[],
  ) => Promise<(Node<N> | undefined)[]>;

  /**
   * Batched candidate retrieval against a declared node index.
   *
   * For each input item, TypeGraph computes the index lookup key from
   * `index.fields` (JSON-pointer extraction, partial-`where` applied to
   * stored rows, null-safe matching) and returns the live, non-soft-deleted
   * nodes that share that key. Unlike {@link bulkFindByConstraint}, the index
   * may be non-unique, so each input yields a (possibly empty) array.
   *
   * Results preserve input order; each inner array is ordered by node id.
   * Empty input returns `[]`. An unknown index name throws
   * `NodeIndexNotFoundError`; a type-incompatible indexed field throws
   * `ValidationError`. This is candidate retrieval, not a uniqueness or
   * identity guarantee.
   *
   * @param indexName - Name of the declared node index to match on
   * @param items - Records whose `props` supply the indexed-field values
   * @param options - Optional `limitPerInput` to bound per-input fan-out
   */
  bulkFindByIndex: (
    indexName: string,
    items: readonly Readonly<{
      props: Partial<z.input<N["schema"]>>;
    }>[],
    options?: NodeBulkFindByIndexOptions,
  ) => Promise<readonly Node<N>[][]>;

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
    constraintName: CN,
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
    constraintName: CN,
    items: readonly Readonly<{
      props: z.input<N["schema"]>;
    }>[],
    options?: NodeGetOrCreateByConstraintOptions,
  ) => Promise<NodeGetOrCreateByConstraintResult<N>[]>;
}>;

/**
 * Reference to a node of a specific kind.
 *
 * Accepts either:
 * - A Node instance of the correct kind
 * - An explicit { kind, id } object with the correct kind name
 *
 * This provides compile-time checking that edge endpoints match the
 * allowed node kinds defined in the edge registration.
 */
export type NodeRef<N extends NodeType = NodeType> =
  Node<N> | Readonly<{ kind: N["kind"]; id: string }>;

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
    from: NodeRef<From>,
    to: NodeRef<To>,
    ...args: EdgeCreateArguments<E>
  ) => Promise<Edge<E, From, To>>;

  /** Get an edge by ID */
  getById: (
    id: EdgeId<E>,
    options?: QueryOptions,
  ) => Promise<Edge<E, From, To> | undefined>;

  /** Get multiple edges by ID, preserving input order (undefined for missing) */
  getByIds: (
    ids: readonly EdgeId<E>[],
    options?: QueryOptions,
  ) => Promise<readonly (Edge<E, From, To> | undefined)[]>;

  /** Update an edge's properties */
  update: (
    id: EdgeId<E>,
    props: Partial<z.input<E["schema"]>>,
    options?: Readonly<{ validTo?: string }>,
  ) => Promise<Edge<E, From, To>>;

  /**
   * Find edges from a specific node.
   *
   * Honors the same temporal model as `getById` / `find`: with no
   * `options`, the graph's default `temporalMode` applies (excluding
   * soft-deleted edges and, in `current` / `asOf` modes, edges outside
   * their validity window). Pass `temporalMode` / `asOf` to read the
   * endpoint's edges at another temporal coordinate.
   */
  findFrom: (
    from: NodeRef<From>,
    options?: QueryOptions,
  ) => Promise<Edge<E, From, To>[]>;

  /**
   * Find edges to a specific node.
   *
   * Temporal semantics mirror {@link EdgeCollection.findFrom}.
   */
  findTo: (
    to: NodeRef<To>,
    options?: QueryOptions,
  ) => Promise<Edge<E, From, To>[]>;

  /**
   * Deferred variant of `findFrom` for use with `store.batch()`.
   *
   * Returns a `BatchableQuery` instead of executing immediately. Accepts
   * the same temporal `options` as {@link EdgeCollection.findFrom}.
   */
  batchFindFrom: (
    from: NodeRef<From>,
    options?: QueryOptions,
  ) => BatchableQuery<Edge<E, From, To>>;

  /**
   * Deferred variant of `findTo` for use with `store.batch()`.
   *
   * Returns a `BatchableQuery` instead of executing immediately. Accepts
   * the same temporal `options` as {@link EdgeCollection.findTo}.
   */
  batchFindTo: (
    to: NodeRef<To>,
    options?: QueryOptions,
  ) => BatchableQuery<Edge<E, From, To>>;

  /**
   * Deferred variant of `findByEndpoints` for use with `store.batch()`.
   *
   * Returns a `BatchableQuery` that yields a 0-or-1 element array
   * (matching `findByEndpoints`' at-most-one semantics).
   */
  batchFindByEndpoints: (
    from: NodeRef<From>,
    to: NodeRef<To>,
    options?: EdgeFindByEndpointsOptions<E>,
    temporal?: QueryOptions,
  ) => BatchableQuery<Edge<E, From, To>>;

  /** Delete an edge (soft delete - sets deletedAt timestamp) */
  delete: (id: EdgeId<E>) => Promise<void>;

  /**
   * Permanently delete an edge from the database.
   *
   * Unlike `delete()` which performs a soft delete, this permanently
   * removes the edge record.
   *
   * **Warning:** This operation is irreversible and should be used carefully.
   * Consider using soft delete (`delete()`) for most use cases.
   */
  hardDelete: (id: EdgeId<E>) => Promise<void>;

  /** Find edges matching endpoint and pagination criteria */
  find: (
    filter?: Readonly<{
      from?: NodeRef<From>;
      to?: NodeRef<To>;
      limit?: number;
      offset?: number;
    }>,
    temporal?: QueryOptions,
  ) => Promise<Edge<E, From, To>[]>;

  /** Count edges matching criteria */
  count: (
    filter?: Readonly<{
      from?: NodeRef<From>;
      to?: NodeRef<To>;
    }>,
    temporal?: QueryOptions,
  ) => Promise<number>;

  /**
   * Create multiple edges in a batch.
   *
   * More efficient than calling create() multiple times.
   * Use `bulkInsert` for the dedicated fast path that skips returning results.
   */
  bulkCreate: (
    items: readonly Readonly<{
      from: NodeRef<From>;
      to: NodeRef<To>;
      props?: z.input<E["schema"]>;
      id?: string;
      validFrom?: string;
      validTo?: string;
    }>[],
  ) => Promise<Edge<E, From, To>[]>;

  /**
   * Create or update multiple edges in a batch.
   *
   * For each item, if an edge with the given ID exists, updates it.
   * Otherwise, creates a new edge with that ID.
   */
  bulkUpsertById: (
    items: readonly Readonly<{
      id: EdgeId<E>;
      from: NodeRef<From>;
      to: NodeRef<To>;
      props?: z.input<E["schema"]>;
      validFrom?: string;
      validTo?: string;
    }>[],
  ) => Promise<Edge<E, From, To>[]>;

  /**
   * Insert multiple edges without returning results.
   *
   * This is the dedicated fast path for bulk inserts. Unlike `bulkCreate`
   * with `returnResults: false`, the intent is unambiguous: no results
   * are returned and the operation is wrapped in a transaction.
   */
  bulkInsert: (
    items: readonly Readonly<{
      from: NodeRef<From>;
      to: NodeRef<To>;
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
  bulkDelete: (ids: readonly EdgeId<E>[]) => Promise<void>;

  /**
   * Find an edge by endpoints and optional property fields.
   *
   * Returns the first matching edge at the read coordinate, or undefined.
   * Honors the temporal model like `findFrom` / `findTo`: by default
   * (`current` mode) soft-deleted and out-of-window edges are excluded; under
   * `includeTombstones` a soft-deleted edge can be returned.
   *
   * @param from - Source node
   * @param to - Target node
   * @param options - Match criteria (matchOn fields and property values)
   * @param temporal - Temporal coordinate. With no `temporal`, the graph's
   *   default `temporalMode` applies (so under the default `"current"` mode,
   *   edges outside their validity window are excluded). Pass
   *   `temporalMode` / `asOf` to read the edge as of another coordinate.
   */
  findByEndpoints: (
    from: NodeRef<From>,
    to: NodeRef<To>,
    options?: EdgeFindByEndpointsOptions<E>,
    temporal?: QueryOptions,
  ) => Promise<Edge<E, From, To> | undefined>;

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
    from: NodeRef<From>,
    to: NodeRef<To>,
    props: z.input<E["schema"]>,
    options?: EdgeGetOrCreateByEndpointsOptions<E>,
  ) => Promise<EdgeGetOrCreateByEndpointsResult<E, From, To>>;

  /**
   * Batch version of getOrCreateByEndpoints.
   *
   * Results are returned in the same order as the input items.
   * Atomic when the backend supports transactions.
   */
  bulkGetOrCreateByEndpoints: (
    items: readonly Readonly<{
      from: NodeRef<From>;
      to: NodeRef<To>;
      props: z.input<E["schema"]>;
    }>[],
    options?: EdgeGetOrCreateByEndpointsOptions<E>,
  ) => Promise<EdgeGetOrCreateByEndpointsResult<E, From, To>[]>;
}>;

// ============================================================
// Type Helpers
// ============================================================

/**
 * Extract uniqueness constraint names from a NodeRegistration.
 *
 * - Returns `never` when no uniqueness constraints are configured.
 * - Returns a literal union when names are inferred via `defineGraph` const params.
 * - Falls back to `string` when names are widened/dynamic.
 */
export type ConstraintNames<R extends NodeRegistration> =
  "unique" extends keyof R ?
    R["unique"] extends readonly { readonly name: infer N }[] ?
      N & string
    : string
  : never;

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

// ============================================================
// Graph Collection Maps
// ============================================================

/** Mapped type of all node collections for a graph. */
export type GraphNodeCollections<G extends GraphDef> = {
  [K in keyof G["nodes"] & string]-?: NodeCollection<
    G["nodes"][K]["type"],
    ConstraintNames<G["nodes"][K]>
  >;
};

/** Mapped type of all edge collections for a graph. */
export type GraphEdgeCollections<G extends GraphDef> = {
  [K in keyof G["edges"] & string]-?: TypedEdgeCollection<G["edges"][K]>;
};

// ============================================================
// StoreView read-only collection surfaces
// ============================================================

/** Temporal-aware node reads — a {@link StoreView} pins these. */
export type NodeTemporalReads<
  N extends NodeType,
  CN extends string = string,
> = Pick<NodeCollection<N, CN>, (typeof NODE_TEMPORAL_READ_NAMES)[number]>;

/**
 * Current-state-only node reads (constraint / index lookups). No temporal
 * axis, so a {@link StoreView} delegates them on a `current` pin and refuses
 * them on a temporal pin.
 */
export type NodeCurrentReads<
  N extends NodeType,
  CN extends string = string,
> = Pick<NodeCollection<N, CN>, (typeof CURRENT_ONLY_READ_NAMES)[number]>;

/** Node writes — never available on a read-only {@link StoreView}. */
export type NodeWrites<N extends NodeType, CN extends string = string> = Pick<
  NodeCollection<N, CN>,
  (typeof NODE_WRITE_NAMES)[number]
>;

/** Temporal-aware edge reads — a {@link StoreView} pins these. */
export type EdgeTemporalReads<
  E extends AnyEdgeType,
  From extends NodeType = NodeType,
  To extends NodeType = NodeType,
> = Pick<
  EdgeCollection<E, From, To>,
  (typeof EDGE_TEMPORAL_READ_NAMES)[number]
>;

/**
 * Deferred edge reads for `store.batch()` — absent from a {@link StoreView},
 * which has no batch context.
 */
export type EdgeBatchReads<
  E extends AnyEdgeType,
  From extends NodeType = NodeType,
  To extends NodeType = NodeType,
> = Pick<EdgeCollection<E, From, To>, (typeof EDGE_BATCH_READ_NAMES)[number]>;

/** Edge writes — never available on a read-only {@link StoreView}. */
export type EdgeWrites<
  E extends AnyEdgeType,
  From extends NodeType = NodeType,
  To extends NodeType = NodeType,
> = Pick<EdgeCollection<E, From, To>, (typeof EDGE_WRITE_NAMES)[number]>;

/**
 * The read-only node surface a {@link StoreView} exposes for one node kind.
 * The temporal reads drop the per-call temporal argument — the pin owns the
 * axis; the current reads ({@link NodeCurrentReads}) are exposed as-is
 * (delegated on a `current` view, refused on a temporal pin). Writes live on
 * the live `Store`. The conformance test asserts the temporal part equals the
 * pinned form of {@link NodeTemporalReads}.
 */
export type StoreViewNodeCollection<
  N extends NodeType,
  CN extends string = string,
> = Readonly<{
  /** Get a node by ID at the view's pinned coordinate. */
  getById: (id: NodeId<N>) => Promise<Node<N> | undefined>;

  /** Get multiple nodes by ID, preserving input order (undefined for missing). */
  getByIds: (
    ids: readonly NodeId<N>[],
  ) => Promise<readonly (Node<N> | undefined)[]>;

  /** Find nodes matching criteria at the view's pinned coordinate. */
  find: (
    filter?: Readonly<{
      where?: (accessor: NodeAccessor<N>) => Predicate;
      limit?: number;
      offset?: number;
    }>,
  ) => Promise<Node<N>[]>;

  /** Count nodes at the view's pinned coordinate. */
  count: () => Promise<number>;
}> &
  NodeCurrentReads<N, CN>;

/**
 * The read-only edge surface a {@link StoreView} exposes for one edge
 * kind, mirroring {@link StoreViewNodeCollection}. Every edge read —
 * including `findByEndpoints` — honors the pin via the same temporal model,
 * so (unlike nodes) there are no current-state-only edge reads.
 */
export type StoreViewEdgeCollection<
  E extends AnyEdgeType,
  From extends NodeType = NodeType,
  To extends NodeType = NodeType,
> = Readonly<{
  /** Get an edge by ID at the view's pinned coordinate. */
  getById: (id: EdgeId<E>) => Promise<Edge<E, From, To> | undefined>;

  /** Get multiple edges by ID, preserving input order (undefined for missing). */
  getByIds: (
    ids: readonly EdgeId<E>[],
  ) => Promise<readonly (Edge<E, From, To> | undefined)[]>;

  /** Find edges matching endpoint and pagination criteria. */
  find: (
    filter?: Readonly<{
      from?: NodeRef<From>;
      to?: NodeRef<To>;
      limit?: number;
      offset?: number;
    }>,
  ) => Promise<Edge<E, From, To>[]>;

  /** Count edges matching criteria at the view's pinned coordinate. */
  count: (
    filter?: Readonly<{ from?: NodeRef<From>; to?: NodeRef<To> }>,
  ) => Promise<number>;

  /** Find edges from a specific node at the view's pinned coordinate. */
  findFrom: (from: NodeRef<From>) => Promise<Edge<E, From, To>[]>;

  /** Find edges to a specific node at the view's pinned coordinate. */
  findTo: (to: NodeRef<To>) => Promise<Edge<E, From, To>[]>;

  /** Find the edge between two endpoints at the view's pinned coordinate. */
  findByEndpoints: (
    from: NodeRef<From>,
    to: NodeRef<To>,
    options?: EdgeFindByEndpointsOptions<E>,
  ) => Promise<Edge<E, From, To> | undefined>;
}>;

/**
 * Read-only view edge collection derived from an `EdgeRegistration`,
 * extracting the edge type and from/to node types — the read-only
 * counterpart of {@link TypedEdgeCollection}.
 */
export type TypedStoreViewEdgeCollection<R extends EdgeRegistration> =
  StoreViewEdgeCollection<
    R["type"],
    EdgeFromTypes<R> extends NodeType ? EdgeFromTypes<R> : NodeType,
    EdgeToTypes<R> extends NodeType ? EdgeToTypes<R> : NodeType
  >;

/** Mapped type of all read-only view node collections for a graph. */
export type StoreViewNodeCollections<G extends GraphDef> = {
  [K in keyof G["nodes"] & string]-?: StoreViewNodeCollection<
    G["nodes"][K]["type"]
  >;
};

/** Mapped type of all read-only view edge collections for a graph. */
export type StoreViewEdgeCollections<G extends GraphDef> = {
  [K in keyof G["edges"] & string]-?: TypedStoreViewEdgeCollection<
    G["edges"][K]
  >;
};

/** Recorded-time node point reads for one node kind. */
export type RecordedStoreViewNodeCollection<N extends NodeType> = Pick<
  StoreViewNodeCollection<N>,
  (typeof RECORDED_POINT_READ_NAMES)[number]
>;

/** Recorded-time edge point reads for one edge kind. */
export type RecordedStoreViewEdgeCollection<
  E extends AnyEdgeType,
  From extends NodeType = NodeType,
  To extends NodeType = NodeType,
> = Pick<
  StoreViewEdgeCollection<E, From, To>,
  (typeof RECORDED_POINT_READ_NAMES)[number]
>;

/** Recorded-time edge collection derived from an `EdgeRegistration`. */
export type TypedRecordedStoreViewEdgeCollection<R extends EdgeRegistration> =
  RecordedStoreViewEdgeCollection<
    R["type"],
    EdgeFromTypes<R> extends NodeType ? EdgeFromTypes<R> : NodeType,
    EdgeToTypes<R> extends NodeType ? EdgeToTypes<R> : NodeType
  >;

/** Mapped type of all recorded-time node point-read collections. */
export type RecordedStoreViewNodeCollections<G extends GraphDef> = {
  [K in keyof G["nodes"] & string]-?: RecordedStoreViewNodeCollection<
    G["nodes"][K]["type"]
  >;
};

/** Mapped type of all recorded-time edge point-read collections. */
export type RecordedStoreViewEdgeCollections<G extends GraphDef> = {
  [K in keyof G["edges"] & string]-?: TypedRecordedStoreViewEdgeCollection<
    G["edges"][K]
  >;
};

// ============================================================
// Transaction Context
// ============================================================

/**
 * A typed transaction context with collection API.
 *
 * Provides the same `tx.nodes.*` and `tx.edges.*` API as the Store,
 * but operations are executed within the transaction scope.
 *
 * `tx.sql` is the raw Drizzle handle **bound to this same
 * transaction** — use it to write the caller's own relational tables
 * inside the graph-owned transaction so both layers commit or roll
 * back together (the graph-owned counterpart of
 * {@link Store.withTransaction}, where the caller owns the boundary):
 *
 * ```typescript
 * await store.transaction(async (tx) => {
 *   await tx.nodes.Document.update(documentId, props);
 *   // `tx.sql` is the `AdoptedTransaction` union — cast to your
 *   // concrete Drizzle database type at the call site.
 *   const sqlTx = tx.sql as NodePgDatabase;
 *   await sqlTx.insert(documentVersions).values(versionRow);
 *   await sqlTx.insert(changeEvents).values(eventRow);
 * });
 * ```
 *
 * Per-backend semantics:
 * - **Postgres / libsql** (async drivers): `tx.sql` is the Drizzle
 *   transaction handle. Using the outer `db` instead would write on a
 *   *different* connection and silently escape the transaction — so
 *   `tx.sql` is a correctness requirement there.
 * - **better-sqlite3**: the single connection, framed by TypeGraph's
 *   `BEGIN`/`COMMIT`/`ROLLBACK`.
 * - **Durable Objects (`do-sqlite`)**: the bound Drizzle handle; the
 *   storage transaction is ambient, so writing the outer `db` also
 *   enlists — `tx.sql` is the explicit, portable form.
 *
 * It is `undefined` only on the non-transactional fallback
 * (`backend.capabilities.transactions === false` — e.g. Cloudflare
 * D1, `drizzle-orm/neon-http`), where `store.transaction()` runs the
 * callback with no atomicity and there is no transaction to enlist.
 * Its type is the `AdoptedTransaction` union; cast to your concrete
 * Drizzle database type at the call site.
 *
 * When the store was created with `{ history: true }`, `tx.sql` is present but
 * replaced by a fail-loud guard because raw SQL would bypass recorded-time
 * capture. Use the typed `tx.nodes` / `tx.edges` collections inside
 * `transaction()`, or use `store.withRecordedTransaction(externalTx, fn)` when
 * the relational layer owns the transaction boundary.
 *
 * @example
 * ```typescript
 * await store.transaction(async (tx) => {
 *   const person = await tx.nodes.Person.create({ name: "Alice" });
 *   const company = await tx.nodes.Company.create({ name: "Acme" });
 *   await tx.edges.worksAt.create(person, company, { role: "Engineer" });
 * });
 * ```
 */
export type TransactionContext<G extends GraphDef> = Readonly<{
  nodes: GraphNodeCollections<G>;
  edges: GraphEdgeCollections<G>;
  sql?: AdoptedTransaction;
  /**
   * The transaction-scoped backend the collections are bound to, for advanced
   * raw reads that must observe the transaction's snapshot (e.g. graph-merge's
   * in-transaction base@V re-validation). On the non-transactional fallback it
   * is the store's plain backend — reads work, but there is no snapshot.
   */
  backend: TransactionBackend;
  /**
   * Runtime string-keyed node collection access, mirroring
   * `Store.getNodeCollection` — for callers (e.g. provenance) that resolve a
   * kind dynamically rather than through the static `nodes.<Kind>` property.
   * Returns `undefined` when `kind` is not registered in this graph.
   */
  getNodeCollection(kind: string): DynamicNodeCollection | undefined;
  /**
   * @internal Runs a graph-owned node mutation through this transaction's
   * operation-hook lifecycle when the mutation cannot use a public collection
   * verb directly (provenance fact close/reopen). Routed through the
   * transaction's hook runner, so a successful operation's `onOperationEnd`
   * is deferred until the transaction commits.
   */
  runNodeOperationHooks<T>(
    operation: "create" | "update" | "delete",
    kind: string,
    id: string,
    fn: () => Promise<T>,
  ): Promise<T>;
}>;

// ============================================================
// Dynamic Collection Types (widened for runtime dispatch)
// ============================================================

/**
 * Replace branded `NodeId` / `EdgeId` with plain `string` in each
 * method's parameter list. Return types are preserved unchanged.
 *
 * Handles three shapes:
 * 1. Direct branded ID parameter → `string`
 * 2. `readonly NodeId[]` / `readonly EdgeId[]` → `readonly string[]`
 * 3. Branded IDs nested one level inside bulk-item object arrays
 */
type WidenBrandedIds<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R ?
    (...args: { [P in keyof A]: UnbrandParam<A[P]> }) => R
  : T[K];
};

/** Replace a branded ID with `string`, recursing one level into arrays. */
type UnbrandParam<T> =
  T extends NodeId<NodeType> ? string
  : T extends EdgeId<AnyEdgeType> ? string
  : T extends readonly NodeId<NodeType>[] ? readonly string[]
  : T extends readonly EdgeId<AnyEdgeType>[] ? readonly string[]
  : T extends readonly (infer Item extends Record<string, unknown>)[] ?
    readonly UnbrandRecord<Item>[]
  : T;

/** Replace branded ID values in object properties (does not recurse into nested structures). */
type UnbrandRecord<T extends Record<string, unknown>> = {
  readonly [K in keyof T]: T[K] extends NodeId<NodeType> ? string
  : T[K] extends EdgeId<AnyEdgeType> ? string
  : T[K];
};

/**
 * A node collection with widened generics for runtime string-keyed access.
 *
 * This is the return type of `store.getNodeCollection(kind)`. It exposes
 * the full `NodeCollection` API but with `NodeType` and `string` constraint
 * names instead of the specific generic parameters, since the concrete type
 * is not known at compile time.
 *
 * ID parameters accept plain `string` instead of branded `NodeId<N>`, since
 * the dynamic path typically receives IDs from edge metadata, snapshots,
 * or external input where the brand is not available.
 */
export type DynamicNodeCollection = WidenBrandedIds<
  NodeCollection<NodeType, string>
>;

/**
 * An edge collection with widened generics for runtime string-keyed access.
 *
 * This is the return type of `store.getEdgeCollection(kind)`. It exposes
 * the full `EdgeCollection` API but with `NodeType` endpoint types, since
 * the concrete from/to types are not known at compile time.
 *
 * ID parameters accept plain `string` instead of branded `EdgeId<E>`, since
 * the dynamic path typically receives IDs from edge metadata, snapshots,
 * or external input where the brand is not available.
 */
export type DynamicEdgeCollection = WidenBrandedIds<
  EdgeCollection<AnyEdgeType, NodeType, NodeType>
>;

// ============================================================
// Store Projection
// ============================================================

/**
 * A type-level projection of a store's surface onto a subset of its
 * node and edge collections.
 *
 * Node collections are projected with constraint names erased (`never`),
 * so constraint-based methods like `findByConstraint` become uncallable.
 * This is intentional: unique constraints are graph-registration-level
 * details that differ between graphs sharing the same node types.
 *
 * @example
 * ```typescript
 * type CoreStore = StoreProjection<
 *   typeof myGraph,
 *   "Document" | "Chunk",
 *   "hasChunk"
 * >;
 *
 * async function ingestChunk(
 *   store: CoreStore,
 *   document: Node<typeof Document>,
 *   text: string,
 * ) {
 *   const chunk = await store.nodes.Chunk.create({ text });
 *   await store.edges.hasChunk.create(document, chunk);
 *   return chunk;
 * }
 * ```
 *
 * Both `Store<G>` and `TransactionContext<G>` are structurally assignable
 * to a `StoreProjection` whose keys are a subset of `G`.
 */
export type StoreProjection<
  G extends GraphDef,
  N extends keyof G["nodes"] & string = never,
  E extends keyof G["edges"] & string = never,
> = Readonly<{
  nodes: { [K in N]-?: NodeCollection<G["nodes"][K]["type"], never> };
  edges: Pick<GraphEdgeCollections<G>, E>;
}>;
