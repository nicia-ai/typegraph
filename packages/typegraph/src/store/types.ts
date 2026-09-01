/**
 * Store types for TypeGraph operations.
 */
import { type z } from "zod";

import {
  type BackendValidityEndMutation,
  type EdgeRow,
  type NodeRow,
  type TransactionBackend,
  type TransactionReadBackend,
} from "../backend/types";
import {
  type EdgeKinds,
  type GraphDef,
  type GraphIdentityConfig,
  type NodeKinds,
} from "../core/define-graph";
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
import type { IdentityFacade, IdentityWriteSummary } from "../identity/types";
import type { TraversalExpansion } from "../query/ast";
import type {
  RuntimeEdgeKind,
  RuntimeEdgeTypeFor,
  RuntimeNodeKind,
  RuntimeNodeTypeFor,
} from "./runtime-kind";

/**
 * An explicit validity-end mutation. Omission preserves the stored end,
 * `validTo` sets it, and `clearValidTo` reopens the window. The union keeps the
 * two write actions mutually exclusive without exposing public `null`.
 */
export type ValidityEndMutation = BackendValidityEndMutation;
import type {
  DynamicEdgeAccessor,
  DynamicNodeAccessor,
  DynamicNodeKind,
  DynamicNodeType,
} from "../query/builder";
import type { BatchableQuery, NodeAccessor } from "../query/builder/types";
import {
  type ExternalRecordedReadSource,
  type SqlSchema,
} from "../query/compiler/schema";
import type { Predicate } from "../query/predicates";
import { typeGraphGlobalSymbol } from "../utils/global-symbol";
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
}> &
  ValidityEndMutation;

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
}> &
  ValidityEndMutation;

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
 * Context for one SQL statement a query builder submits to the backend.
 *
 * A single logical query can emit more than one context, for example when a
 * selective projection falls back to a full-row fetch. Backend-internal setup
 * statements are not exposed as separate query-hook events.
 */
export type QueryHookContext = HookContext &
  Readonly<{
    /** The SQL statement being executed */
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
 * Context for one set-based collection mutation. The `operation` union is the exhaustive list of
 * what `onBulkOperationStart` / `onBulkOperationEnd` observe, so a batch method
 * absent from it (every `bulk*`, including `bulkDelete`) emits no bulk event.
 */
export type BulkOperationHookContext = HookContext &
  Readonly<{
    operation: "compareAndSet" | "updateWhere";
    entity: "node";
    kind: string;
  }>;

/**
 * Observability hooks for monitoring store operations.
 *
 * Note: Batch operations (`bulkCreate`, `bulkInsert`, `bulkUpsertById`,
 * `bulkDelete`) skip per-item operation hooks for throughput, and the bulk
 * hooks below do not stand in for them — those fire only for node
 * `compareAndSet` and `updateWhere`, so a batch method emits no hook events at all, neither
 * per-item nor bulk. Query hooks still fire normally.
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
  /** Called before each query-builder statement is submitted to the backend. */
  onQueryStart?: (ctx: QueryHookContext) => void;
  /** Called after each submitted query-builder statement succeeds. */
  onQueryEnd?: (
    ctx: QueryHookContext,
    result: Readonly<{ rowCount: number; durationMs: number }>,
  ) => void;
  /** Called before a CRUD operation starts */
  onOperationStart?: (ctx: OperationHookContext) => void;
  /** Called before a set-based collection mutation starts. */
  onBulkOperationStart?: (ctx: BulkOperationHookContext) => void;
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
    result: Readonly<{
      durationMs: number;
      /** The authoritative effect, or `unknown` when the command reports none. */
      outcome: "written" | "unchanged" | "unknown";
    }>,
  ) => void;
  /**
   * Called after a set-based mutation durably commits. Inside
   * `store.transaction`, emission is deferred until the enclosing commit.
   */
  onBulkOperationEnd?: (
    ctx: BulkOperationHookContext,
    result: Readonly<{ affectedCount: number; durationMs: number }>,
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

export type BaseStoreOptions = Readonly<{
  /** Observability hooks for monitoring */
  hooks?: StoreHooks;
  /**
   * Maintain a durable, graph-wide revision anchor for TypeGraph writes:
   * a random per-graph origin plus a monotonic revision clock. `branch()` uses
   * this anchor to validate that its base has not moved without
   * re-fingerprinting every live row, and cannot confuse a coincident clock in
   * a separately created store for its original base. `history: true` enables
   * the same tracking automatically through its recorded-time commit clock.
   *
   * This is intentionally opt-in for live stores: each successful graph write
   * advances the anchor inside its write transaction. On PostgreSQL, those
   * transactions take a graph-scoped advisory lock until commit; writes to the
   * same graph therefore serialize. Enable it for branchable graphs, but size
   * high-throughput multi-writer workloads for that trade-off.
   *
   * Writes performed directly through a backend — including raw graph-table
   * writes through `tx.sql` — bypass the anchor and are outside the
   * revision-tracking contract.
   */
  revisionTracking?: boolean;
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
  /**
   * Skip the write for an `upsertById`, `bulkUpsertById` item, or endpoint
   * get-or-create update whose validated props are value-identical to the
   * existing live row. Default off.
   *
   * Enable this for at-least-once / replay materializers. An event log that
   * re-delivers a byte-identical change would otherwise rewrite the row anyway:
   * today an `upsertById` on an existing id calls `updateNode`
   * unconditionally, allocating a fresh recorded instant and a new history row
   * per re-delivery.
   *
   * The win is scoped to re-delivery of the **current** value. A full
   * replay-from-zero over the current state still writes wherever the stream
   * superseded a value in place: re-applying an older value over the live row
   * is a genuine change (and restoring the current value afterwards is
   * another), so only streams whose rows never supersede each other replay
   * without churn. A rebuild that should avoid that re-walk belongs in a fresh
   * store — replay into it and publish it, rather than re-applying the log
   * over current state.
   *
   * When enabled, an upsert that would not change the stored value performs
   * **no write at all**: no `updateNode`, no recorded-time capture, no history
   * row, no revision-anchor advance, and no `update` operation hooks (nothing
   * happened, so nothing is reported). It resolves with the **existing** node,
   * preserving its original `validFrom` / `updatedAt` / `version`. An endpoint
   * get-or-create reports action `"found"` when its requested update is
   * coalesced; `"updated"` always means an UPDATE actually ran.
   * Node `getOrCreateByConstraint` updates are outside this option's scope and
   * still write on every `ifExists: "update"` match; replay projectors that
   * need coalescing should use `upsertById` for nodes.
   *
   * Receipt shape is unchanged and needs no new signal: a coalesced upsert
   * still counts as one write intent (`writes.total` includes it), but
   * captures nothing (`receipt.recorded` stays `undefined` when it is the only
   * write) — the same shape a no-op delete already produces, so a consumer
   * that carries the prior anchor forward on `recorded === undefined` handles
   * it unchanged.
   *
   * A write is coalesced only when **all** of the following hold; otherwise the
   * normal write happens:
   *   1. A value to compare against is known for the id: an existing row, or —
   *      for a repeated id in one bulk batch — the value an earlier item in that
   *      batch already queued (a create or an update).
   *   2. That row is not soft-deleted (a deleted row resurrects — a real
   *      change — and is never coalesced).
   *   3. Any requested `validFrom` / `validTo` names the window already stored;
   *      a changed or inapplicable temporal request reaches the write path.
   *   4. The new props, merged over the stored props and run through the
   *      kind's Zod schema (defaults applied, values normalized), are deeply
   *      value-identical to the stored props (key order aside).
   *
   * Default-off because some consumers *want* an audit row per re-delivery as
   * proof the event was reprocessed; coalescing removes that signal.
   */
  coalesceUnchangedUpserts?: boolean;
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

/** Live-store options that do not bind a recorded-read relation. */
export type UnboundLiveStoreOptions = LiveStoreOptions &
  Readonly<{ recordedRead?: undefined }>;

/** Live-store options with an explicitly bound recorded-read relation. */
export type RecordedReadStoreOptions = LiveStoreOptions &
  Readonly<{
    recordedRead: NonNullable<LiveStoreOptions["recordedRead"]>;
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
 * the new Store after each evolve call. When the ref is passed via
 * `evolve(extension, { ref })`, `current` is overwritten with the replacement
 * before a successful call resolves.
 *
 * **Request semantics.** Dereference once at request entry only when that
 * request will not change the schema. A schema-changing call such as
 * `evolve()` returns the Store for the resulting schema and updates
 * `ref.current`; a Store captured before that call remains pinned to the old
 * schema. Use the returned Store (or dereference `ref.current` again) for every
 * subsequent operation in the same request:
 *
 * ```ts
 * async function handleRequest(): Promise<void> {
 *   const store = ref.current;
 *   const evolved = await store.evolve(extension, { ref });
 *   await evolved.materializeIndexes();
 *   // ref.current === evolved
 * }
 * ```
 *
 * A `StoreRef` tracks only schema changes made by calls that receive that ref.
 * When another process or isolate can commit a schema version, compare
 * `getCommittedSchemaVersion()` with the cached version before reuse and call
 * `createVerifiedStore()` or `createVerifiedAdapterStore()` when it changes.
 *
 * Pure dereferenceable handle — no event/subscription machinery. If
 * consumers need eventing, they wrap the ref themselves.
 *
 * Generic over the held value (typically `Store<G>`) so the store
 * module can refer to it without importing the `Store` class into
 * `types.ts`. The type parameter is deliberately invariant: evolution writes
 * a replacement into `current`, so a ref for an adapter-only or history-only
 * Store must never be accepted by a Store that cannot preserve that surface.
 */
export interface StoreRef<in out T> {
  current: T;
}

// ============================================================
// Transaction Receipt Types
// ============================================================

/**
 * Result plus write summary. Returned by `store.transactionWithReceipt(fn)`,
 * `store.withRecordedTransaction(externalTx, fn)` (the adopted-commit path), and
 * `tx.measure(fn)` (a scoped sub-receipt). See {@link TransactionReceipt}.
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
    /** Completed identity assertion and retraction write intents. */
    identity: IdentityWriteSummary;
    /** Sum of all node, edge, and identity write intents. */
    total: number;
  }>;
  /**
   * The recorded commit instant allocated for this store's graph by this
   * transaction. Undefined when history capture is off, the transaction is
   * read-only, or no captured writes were flushed. **Always undefined on a
   * scoped receipt from {@link ScopedMeasure}** (`tx.measure`) — the recorded
   * instant is a per-transaction flush concern allocated once when the whole
   * transaction's capture flushes, unknowable mid-transaction.
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
 * Per-endpoint fan-out cap shared by the live and view forms of the edge
 * bulk endpoint reads.
 */
export type EdgeBulkFindOptions = Readonly<{
  /**
   * Maximum number of edges returned for each input endpoint. When omitted,
   * every input's edge set is unbounded. Must be a positive integer.
   *
   * The cap keeps each input's leading edges under the same ordering
   * `findFrom` / `findTo` return, so it bounds fan-out without reordering
   * anything.
   */
  limitPerInput?: number;
}>;

/**
 * Options for the edge bulk endpoint reads: the temporal coordinate every
 * edge read accepts, plus the per-endpoint fan-out cap.
 */
export type EdgeBulkFindEndpointOptions = QueryOptions & EdgeBulkFindOptions;

/** A kind-grouped source list for a heterogeneous bulk edge read. */
export type BulkEdgeSourceGroup<G extends GraphDef> = {
  [K in NodeKinds<G>]: Readonly<{
    kind: K;
    ids: readonly NodeId<G["nodes"][K]["type"]>[];
  }>;
}[NodeKinds<G>];

/** A node reference whose kind and branded id remain correlated. */
export type GraphNodeReference<G extends GraphDef> = {
  [K in NodeKinds<G>]: Readonly<{
    kind: K;
    id: NodeId<G["nodes"][K]["type"]>;
  }>;
}[NodeKinds<G>];

/** Runtime edge union narrowed to the selected graph edge kinds. */
export type GraphEdgeForKinds<G extends GraphDef, K extends EdgeKinds<G>> = {
  [P in K]: Edge<
    G["edges"][P]["type"],
    G["edges"][P]["from"][number],
    G["edges"][P]["to"][number]
  >;
}[K];

/** Input for {@link Store.bulkFindEdgesFrom}. */
export type BulkFindEdgesFromParams<
  G extends GraphDef,
  K extends EdgeKinds<G>,
> = Readonly<{
  sources: readonly BulkEdgeSourceGroup<G>[];
  edgeKinds: readonly K[];
}>;

/** One source bucket returned by {@link Store.bulkFindEdgesFrom}. */
export type BulkFindEdgesFromResult<
  G extends GraphDef,
  K extends EdgeKinds<G>,
> = Readonly<{
  source: GraphNodeReference<G>;
  edges: readonly GraphEdgeForKinds<G, K>[];
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
    /**
     * Valid-time start for a created or RESURRECTED edge — on a resurrection it
     * asserts the complete window, so an omitted `validTo` reopens the revived
     * row.
     *
     * A live edge's stored lower bound is history, so an in-place update
     * (`ifExists: "update"`) cannot store this: one naming a different instant is
     * REFUSED with `IMMUTABLE_VALIDITY_LOWER_BOUND_CODE`, and one restating the
     * bound the edge holds is accepted. Ignored when an existing edge is returned
     * (`ifExists: "return"`), which writes nothing at all — there the window
     * describes the edge to create if none is found.
     */
    validFrom?: string;
    /**
     * How an `ifExists: "update"` write treats a stated `validFrom` that differs
     * from the live edge's stored lower bound. Default: `"refuse"`.
     *
     * `"preserve"` makes `validFrom` create/resurrection-only input: it is still
     * validated, but a live update keeps the stored lower bound while applying
     * properties and `validTo`.
     */
    onImmutableLowerBound?: "preserve" | "refuse";
    /**
     * Valid-time end for a created, updated, or resurrected edge. `validTo` is
     * ignored when the operation returns an existing edge without writing;
     * `clearValidTo` instead requires `ifExists: "update"` on a live match and
     * is refused with `CLEAR_VALID_TO_REQUIRES_UPDATE` under return mode. May
     * not precede the row's effective start; see
     * `INVERTED_VALIDITY_WINDOW_CODE`.
     */
  }> &
    ValidityEndMutation;

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
  /**
   * Create a new node.
   *
   * `validFrom` defaults to the operation's creation timestamp when omitted —
   * unless a stated `validTo` at or before that instant would leave the row
   * readable at no coordinate, in which case the row is stored with NO lower
   * bound ("ended at T, start unknown") and `meta.validFrom` reads back as
   * `undefined`. A future `validTo` is unaffected.
   */
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

  /**
   * Update a node's properties and optionally set or clear its validity end.
   * Omitting both end options preserves the stored window.
   */
  update: (
    id: NodeId<N>,
    props: Partial<z.input<N["schema"]>>,
    options?: ValidityEndMutation,
  ) => Promise<Node<N>>;

  /**
   * Applies a property patch only while the current live row still has
   * caller-supplied exact property values. The identity and values participate in
   * the same set-based statement as the update, so a preceding read cannot
   * open a compare-and-set race. Returns `false` on a missing row or predicate
   * mismatch; neither case writes history or advances the row version.
   *
   * This is the narrow escape hatch for exceptional state recovery. It does
   * not widen schema-declared transition rules: callers state the exceptional
   * precondition at the call site and the complete after-image still passes
   * ordinary TypeGraph validation, uniqueness, history, and sidecar handling.
   */
  compareAndSet: (
    id: NodeId<N>,
    params: Readonly<{
      expected: Partial<z.input<N["schema"]>>;
      patch: Partial<z.input<N["schema"]>>;
    }>,
  ) => Promise<boolean>;

  /**
   * Updates every current node selected by the supplied predicates in one
   * set-based write. Relationship clauses are independent EXISTS predicates
   * and are ANDed with each other and with `where`.
   */
  updateWhere: (
    params: Readonly<{
      patch: Partial<z.input<N["schema"]>>;
      where?: (
        accessor: string extends N["kind"] ? DynamicNodeAccessor
        : NodeAccessor<N>,
      ) => Predicate;
      exists?: readonly Readonly<{
        edgeKind: string;
        direction: "out" | "in";
        relatedKind: string;
        whereEdge?: (accessor: DynamicEdgeAccessor) => Predicate;
        whereRelated?: (accessor: DynamicNodeAccessor) => Predicate;
      }>[];
      all?: true;
    }>,
  ) => Promise<Readonly<{ affectedCount: number }>>;

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
   *
   * `validFrom` defaults to the operation's creation timestamp when omitted —
   * unless a stated `validTo` at or before that instant would leave the row
   * readable at no coordinate, in which case the row is stored with NO lower
   * bound ("ended at T, start unknown") and `meta.validFrom` reads back as
   * `undefined`. A future `validTo` is unaffected.
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
   *
   * `validFrom` applies when the upsert CREATES the row and when it RESURRECTS
   * a tombstoned one — both write a fresh validity window — defaulting to the
   * operation's timestamp when omitted. That default is dropped when a stated
   * `validTo` at or before the write instant would leave the row readable at no
   * coordinate: NO lower bound is stored ("ended at T, start unknown") and
   * `meta.validFrom` reads back as `undefined`. A RESURRECTION takes the same
   * exception, decided against the instant it samples, so one stated window
   * reaches ONE stored shape whether the id is fresh or names a tombstone. An
   * update to a LIVE row stores no lower bound, because that row's is already
   * history, so one naming a different instant is REFUSED (`ValidationError`
   * carrying
   * `IMMUTABLE_VALIDITY_LOWER_BOUND_CODE`) rather than ignored. Restating the
   * bound the row already holds is accepted and changes nothing. Set
   * `onImmutableLowerBound: "preserve"` for event materializers whose
   * `validFrom` is create/resurrection input: a live update then preserves the
   * stored lower bound while still applying props and `validTo`.
   */
  upsertById: (
    id: string,
    props: z.input<N["schema"]>,
    options?: Readonly<{
      validFrom?: string;
      onImmutableLowerBound?: "preserve" | "refuse";
    }> &
      ValidityEndMutation,
  ) => Promise<Node<N>>;

  /**
   * Upsert a node from untyped data, relying on runtime Zod validation.
   *
   * Use this for dynamic dispatch (changesets, migrations, imports) where
   * the data shape is determined at runtime, not compile time.
   * The return type is fully typed — only the input gate is relaxed.
   *
   * `validFrom` applies when the upsert CREATES the row and when it RESURRECTS
   * a tombstoned one — both write a fresh validity window — defaulting to the
   * operation's timestamp when omitted. That default is dropped when a stated
   * `validTo` at or before the write instant would leave the row readable at no
   * coordinate: NO lower bound is stored ("ended at T, start unknown") and
   * `meta.validFrom` reads back as `undefined`. A RESURRECTION takes the same
   * exception, decided against the instant it samples, so one stated window
   * reaches ONE stored shape whether the id is fresh or names a tombstone. An
   * update to a LIVE row stores no lower bound, because that row's is already
   * history, so one naming a different instant is REFUSED (`ValidationError`
   * carrying
   * `IMMUTABLE_VALIDITY_LOWER_BOUND_CODE`) rather than ignored. Restating the
   * bound the row already holds is accepted and changes nothing. Set
   * `onImmutableLowerBound: "preserve"` for create/resurrection-only input.
   */
  upsertByIdFromRecord: (
    id: string,
    data: Record<string, unknown>,
    options?: Readonly<{
      validFrom?: string;
      onImmutableLowerBound?: "preserve" | "refuse";
    }> &
      ValidityEndMutation,
  ) => Promise<Node<N>>;

  /**
   * Create multiple nodes in a batch.
   *
   * More efficient than calling create() multiple times.
   * Use `bulkInsert` for the dedicated fast path that skips returning results.
   *
   * `validFrom` defaults to the operation's creation timestamp when omitted —
   * unless a stated `validTo` at or before that instant would leave the row
   * readable at no coordinate, in which case the row is stored with NO lower
   * bound ("ended at T, start unknown") and `meta.validFrom` reads back as
   * `undefined`. A future `validTo` is unaffected.
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
   *
   * Items are applied in order, so a **repeated id** within one batch is
   * last-write-wins: the first item creates or updates the row, and every later
   * copy is an update over the value the earlier item wrote — the same final row
   * the equivalent sequence of `upsertById` calls produces. This holds whether
   * or not the row existed before the batch.
   *
   * `validFrom` applies when the upsert CREATES the row and when it RESURRECTS
   * a tombstoned one — both write a fresh validity window — defaulting to the
   * operation's timestamp when omitted. That default is dropped when a stated
   * `validTo` at or before the write instant would leave the row readable at no
   * coordinate: NO lower bound is stored ("ended at T, start unknown") and
   * `meta.validFrom` reads back as `undefined`. A RESURRECTION takes the same
   * exception, decided against the instant it samples, so one stated window
   * reaches ONE stored shape whether the id is fresh or names a tombstone. An update to a LIVE row stores no lower
   * bound, because that row's is already history, so one naming a different
   * instant is REFUSED (`ValidationError` carrying
   * `IMMUTABLE_VALIDITY_LOWER_BOUND_CODE`) rather than ignored. Restating the
   * bound the row already holds is accepted and changes nothing. Per-item
   * `onImmutableLowerBound: "preserve"` makes the bound create/resurrection
   * input while a live update preserves the stored lower bound.
   *
   * **Limitation — a batch cannot hand a unique value from one row to
   * another.** Item order settles which value each id ends up with, but the
   * writes themselves are grouped: every create runs before every update. So a
   * batch where one item RELEASES a `unique` constraint value and a later item
   * CLAIMS it — `[{ id: "a", props: { email: "moved@x" } }, { id: "b", props:
   * { email: "shared@x" } }]` where `a` currently holds `"shared@x"` and `b` is
   * new — checks `b`'s create while `a` still reserves the value, and the whole
   * batch fails with a `UniquenessError`. The equivalent sequence of
   * single `upsertById` calls succeeds. A batch states the set of rows it wants,
   * not a script to reach them by; the failure is loud rather than silent, and
   * the workaround is to split the handoff across two batches (release, then
   * claim) or to apply those items as sequential `upsertById` calls.
   */
  bulkUpsertById: (
    items: readonly (Readonly<{
      id: string;
      props: z.input<N["schema"]>;
      validFrom?: string;
      onImmutableLowerBound?: "preserve" | "refuse";
    }> &
      ValidityEndMutation)[],
  ) => Promise<Node<N>[]>;

  /**
   * Replaces complete node documents by id.
   *
   * Missing ids are created. Tombstones are resurrected with a freshly stamped
   * validity window. Live rows preserve their stored validity window. Unlike
   * `bulkUpsertById`, every `props` value is a complete replacement: omitted
   * optional fields are removed rather than merged from the stored document.
   * Duplicate ids are refused because replacement describes a set, not an
   * ordered script.
   */
  bulkReplaceById: (
    items: readonly Readonly<{
      id: string;
      props: z.input<N["schema"]>;
    }>[],
  ) => Promise<Node<N>[]>;

  /**
   * Insert multiple nodes without returning results.
   *
   * This is the dedicated fast path for bulk inserts. Unlike `bulkCreate`
   * with `returnResults: false`, the intent is unambiguous: no results
   * are returned and the operation is wrapped in a transaction.
   *
   * `validFrom` defaults to the operation's creation timestamp when omitted —
   * unless a stated `validTo` at or before that instant would leave the row
   * readable at no coordinate, in which case the row is stored with NO lower
   * bound ("ended at T, start unknown") and `meta.validFrom` reads back as
   * `undefined`. A future `validTo` is unaffected.
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
   * `validFrom` defaults to the operation's creation timestamp when omitted —
   * unless a stated `validTo` at or before that instant would leave the row
   * readable at no coordinate, in which case the row is stored with NO lower
   * bound ("ended at T, start unknown") and `meta.validFrom` reads back as
   * `undefined`. A future `validTo` is unaffected.
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

  /**
   * Update an edge's properties and optionally set or clear its validity end.
   * Reopening a `oneActive` edge rechecks cardinality before the write.
   */
  update: (
    id: EdgeId<E>,
    props: Partial<z.input<E["schema"]>>,
    options?: ValidityEndMutation,
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
   * Find the edges from a SET of source nodes in one read.
   *
   * `findFrom` with a widened endpoint predicate and nothing else: the same
   * temporal model, the same soft-delete filtering, and the same per-source
   * ordering — but `from_id IN (...)` instead of `from_id = ?`, so a page of
   * N sources costs one statement per distinct source kind and bind-budget
   * chunk rather than N singleton statements.
   *
   * Results are grouped per input: the outer array is parallel to `froms`
   * (index `i` holds the edges of `froms[i]`), and repeated inputs each get
   * their own copy of the same edge set. Empty input returns `[]`; a source
   * with no edges gets an empty array. Large inputs are split across
   * statements to respect the backend's bound-parameter budget, which is
   * invisible in the result.
   *
   * Requires a backend implementing `findEdgesByEndpointSet` — both bundled
   * Drizzle backends do. On one that does not, this **refuses** with a
   * `ConfigurationError` rather than looping `findFrom` per input: asking for
   * a bulk read is asking for set-oriented statements, and silently issuing N
   * singleton statements is the cost surprise the method exists to remove.
   *
   * @param froms - Source nodes to read the edges of
   * @param options - Temporal coordinate plus optional `limitPerInput`
   * @throws {ConfigurationError} when the backend cannot read an endpoint set
   */
  bulkFindFrom: (
    froms: readonly NodeRef<From>[],
    options?: EdgeBulkFindEndpointOptions,
  ) => Promise<readonly Edge<E, From, To>[][]>;

  /**
   * Find the edges into a SET of target nodes in one read.
   *
   * Mirrors {@link EdgeCollection.bulkFindFrom} on the `to` endpoint.
   */
  bulkFindTo: (
    tos: readonly NodeRef<To>[],
    options?: EdgeBulkFindEndpointOptions,
  ) => Promise<readonly Edge<E, From, To>[][]>;

  /**
   * Deferred variant of `findFrom` for use with `store.batch()`.
   *
   * Returns a `BatchableQuery` instead of executing immediately. Accepts
   * the same temporal `options` as {@link EdgeCollection.findFrom}.
   *
   * Batching these still issues one statement per call — it does not merge
   * the reads, and whether they share a connection is up to the adapter. It
   * is not a snapshot: PostgreSQL's default read-committed isolation lets a
   * later read observe a commit the earlier ones did not. To read edges for
   * many sources in one statement, traverse from them in a single query.
   */
  batchFindFrom: (
    from: NodeRef<From>,
    options?: QueryOptions,
  ) => BatchableQuery<Edge<E, From, To>>;

  /**
   * Deferred variant of `findTo` for use with `store.batch()`.
   *
   * Returns a `BatchableQuery` instead of executing immediately. Accepts
   * the same temporal `options` as {@link EdgeCollection.findTo}. Costs one
   * statement per call, like {@link EdgeCollection.batchFindFrom}.
   */
  batchFindTo: (
    to: NodeRef<To>,
    options?: QueryOptions,
  ) => BatchableQuery<Edge<E, From, To>>;

  /**
   * Deferred variant of `findByEndpoints` for use with `store.batch()`.
   *
   * Returns a `BatchableQuery` that yields a 0-or-1 element array
   * (matching `findByEndpoints`' at-most-one semantics). Costs one statement
   * per call, like {@link EdgeCollection.batchFindFrom}.
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
   *
   * `validFrom` defaults to the operation's creation timestamp when omitted —
   * unless a stated `validTo` at or before that instant would leave the row
   * readable at no coordinate, in which case the row is stored with NO lower
   * bound ("ended at T, start unknown") and `meta.validFrom` reads back as
   * `undefined`. A future `validTo` is unaffected.
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
   *
   * Items are applied in order, so a **repeated id** within one batch is
   * last-write-wins: the first item creates or updates the edge, and every later
   * copy is an update over the value the earlier item wrote. This holds whether
   * or not the edge existed before the batch. An update never repoints an edge,
   * so every item's `from` / `to` must exactly restate the endpoints already
   * owned by that id (including an earlier item in the same batch). A mismatch
   * is refused with `ValidationError` carrying
   * `EDGE_IDENTITY_MISMATCH_CODE`; it is never silently ignored.
   *
   * `validFrom` applies when the upsert CREATES the edge and when it RESURRECTS
   * a tombstoned one. A create writes a fresh validity window, defaulting to the
   * operation's timestamp when omitted — unless a stated `validTo` at or before
   * that instant would leave the row readable at no coordinate, in which case NO
   * lower bound is stored ("ended at T, start unknown") and `meta.validFrom`
   * reads back as `undefined`. A resurrection stamps nothing: an edge RETAINS
   * its stored lower bound unless the item names a new one, so a `validTo`
   * before the retained bound is REFUSED rather than stamped over. An update to
   * a LIVE row stores no lower bound, because that row's is already history, so
   * one naming a different instant is REFUSED (`ValidationError` carrying
   * `IMMUTABLE_VALIDITY_LOWER_BOUND_CODE`) rather than ignored. Restating the
   * bound the row already holds is accepted and changes nothing.
   *
   * **Limitation — a batch cannot hand a constrained slot from one edge to
   * another.** Item order settles the final props, but the writes are grouped:
   * every create runs before every update. So a batch where one item frees the
   * slot a `cardinality` constraint allows and a later item claims it — ending
   * the lone `oneActive` edge from a source while creating its replacement —
   * checks the create while the old edge is still active, and the whole batch
   * fails with a `CardinalityError`. Applying the update first, as
   * separate `update` / `create` calls, succeeds. A batch states the set of
   * edges it wants, not a script to reach them by; the failure is loud rather
   * than silent, and the workaround is to split the handoff across two batches
   * (free the slot, then claim it) or to apply those items individually.
   */
  bulkUpsertById: (
    items: readonly (Readonly<{
      id: EdgeId<E>;
      from: NodeRef<From>;
      to: NodeRef<To>;
      props?: z.input<E["schema"]>;
      validFrom?: string;
    }> &
      ValidityEndMutation)[],
  ) => Promise<Edge<E, From, To>[]>;

  /**
   * Insert multiple edges without returning results.
   *
   * This is the dedicated fast path for bulk inserts. Unlike `bulkCreate`
   * with `returnResults: false`, the intent is unambiguous: no results
   * are returned and the operation is wrapped in a transaction.
   *
   * `validFrom` defaults to the operation's creation timestamp when omitted —
   * unless a stated `validTo` at or before that instant would leave the row
   * readable at no coordinate, in which case the row is stored with NO lower
   * bound ("ended at T, start unknown") and `meta.validFrom` reads back as
   * `undefined`. A future `validTo` is unaffected.
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
   *
   * The batch runs as one transaction, checking each id's kind against the
   * authoritative row as it goes. An id owned by another edge kind is
   * refused with `ValidationError` carrying `EDGE_IDENTITY_MISMATCH_CODE`;
   * because the whole batch is one transaction, that refusal rolls back
   * every delete already applied for an earlier id in the same batch.
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
   * `validFrom` applies on the create and RESURRECT branches. A create defaults
   * it to the operation's creation timestamp when omitted — unless a stated
   * `validTo` at or before that instant would leave the row readable at no
   * coordinate, in which case no lower bound is stored ("ended at T, start
   * unknown"). A resurrection stamps nothing: an edge RETAINS its stored lower
   * bound unless the call names a new one, so a `validTo` before the retained
   * bound is REFUSED rather than stamped over. On the `ifExists: "update"`
   * branch a live edge's lower bound is history and cannot be stored, so a
   * `validFrom` naming a different instant is REFUSED (`ValidationError`
   * carrying `IMMUTABLE_VALIDITY_LOWER_BOUND_CODE`); restating the bound the
   * edge holds is accepted. A returned existing edge (`ifExists: "return"`)
   * writes nothing and judges nothing — the window options describe the row to
   * create if none is found. `validTo` applies on create, update, and
   * resurrection, but not when an existing edge is returned without a write.
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
    items: readonly (Readonly<{
      from: NodeRef<From>;
      to: NodeRef<To>;
      props: z.input<E["schema"]>;
      validFrom?: string;
      onImmutableLowerBound?: "preserve" | "refuse";
    }> &
      ValidityEndMutation)[],
    options?: Pick<
      EdgeGetOrCreateByEndpointsOptions<E>,
      "matchOn" | "ifExists"
    >,
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

  /** Find the edges from a set of source nodes at the view's pinned coordinate. */
  bulkFindFrom: (
    froms: readonly NodeRef<From>[],
    options?: EdgeBulkFindOptions,
  ) => Promise<readonly Edge<E, From, To>[][]>;

  /** Find the edges into a set of target nodes at the view's pinned coordinate. */
  bulkFindTo: (
    tos: readonly NodeRef<To>[],
    options?: EdgeBulkFindOptions,
  ) => Promise<readonly Edge<E, From, To>[][]>;

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

/** Options for one bounded, forward-only recorded-time collection scan. */
export type RecordedScanOptions = Readonly<{
  /** Maximum entities to return. Defaults to 1,000 and cannot exceed 1,000. */
  limit?: number;
  /** Opaque cursor returned by the preceding page. */
  after?: string;
}>;

/** One page from a deterministic recorded-time collection scan. */
export type RecordedScanPage<T> = Readonly<{
  /** Entities ordered by canonical id ascending. */
  data: readonly T[];
  /** Cursor for the next page, or `undefined` when the scan is complete. */
  nextCursor: string | undefined;
  /** Whether another page exists after this one. */
  hasNextPage: boolean;
}>;

/** Recorded-time reconstructing reads for one node kind. */
export type RecordedStoreViewNodeCollection<N extends NodeType> = Pick<
  StoreViewNodeCollection<N>,
  (typeof RECORDED_POINT_READ_NAMES)[number]
> &
  Readonly<{
    /** Scan one bounded page at the view's pinned coordinate. */
    scan: (options?: RecordedScanOptions) => Promise<RecordedScanPage<Node<N>>>;
  }>;

/** Recorded-time reconstructing reads for one edge kind. */
export type RecordedStoreViewEdgeCollection<
  E extends AnyEdgeType,
  From extends NodeType = NodeType,
  To extends NodeType = NodeType,
> = Pick<
  StoreViewEdgeCollection<E, From, To>,
  (typeof RECORDED_POINT_READ_NAMES)[number]
> &
  Readonly<{
    /** Scan one bounded page at the view's pinned coordinate. */
    scan: (
      options?: RecordedScanOptions,
    ) => Promise<RecordedScanPage<Edge<E, From, To>>>;
  }>;

/** Recorded-time edge collection derived from an `EdgeRegistration`. */
export type TypedRecordedStoreViewEdgeCollection<R extends EdgeRegistration> =
  RecordedStoreViewEdgeCollection<
    R["type"],
    EdgeFromTypes<R> extends NodeType ? EdgeFromTypes<R> : NodeType,
    EdgeToTypes<R> extends NodeType ? EdgeToTypes<R> : NodeType
  >;

/** Mapped type of all recorded-time node reconstructing-read collections. */
export type RecordedStoreViewNodeCollections<G extends GraphDef> = {
  [K in keyof G["nodes"] & string]-?: RecordedStoreViewNodeCollection<
    G["nodes"][K]["type"]
  >;
};

/** Mapped type of all recorded-time edge reconstructing-read collections. */
export type RecordedStoreViewEdgeCollections<G extends GraphDef> = {
  [K in keyof G["edges"] & string]-?: TypedRecordedStoreViewEdgeCollection<
    G["edges"][K]
  >;
};

// ============================================================
// Transaction Context
// ============================================================

/**
 * Whether — and why — `tx.sql` can be used on a transaction context. A single
 * required discriminant covering exactly the four states raw-SQL access can be
 * in, so an adapter caller branches on capability instead of truthiness-testing
 * `tx.sql`. The non-available variants omit `sql` entirely, so even reading the
 * handle requires first narrowing `sqlAvailability` to `"available"`. The
 * runtime object keeps a fail-loud getter under history / revision tracking for
 * JavaScript and type-suppressed callers. See
 * {@link AdapterTransactionContext} for the per-value semantics.
 */
export type SqlAvailability =
  "available" | "history" | "revisionTracking" | "unavailable";

type AdapterTransactionSqlAccess<TNativeTransaction> =
  | Readonly<{
      sql: TNativeTransaction;
      sqlAvailability: "available";
    }>
  | Readonly<{
      sqlAvailability: "history" | "revisionTracking";
    }>
  | Readonly<{
      sqlAvailability: "unavailable";
    }>;

export const TRANSACTION_RUNTIME: unique symbol = typeGraphGlobalSymbol(
  "transaction-runtime-v1",
);

type TransactionRuntime = Readonly<{
  backend: TransactionBackend;
  runNodeOperationHooks: <T>(
    operation: "create" | "update" | "delete",
    kind: string,
    id: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
}>;

/**
 * The portable transaction context mirrors the Store's typed graph operations
 * while exposing only a read-only backend projection bound to the transaction.
 * Adapter-native handles are available only through
 * {@link AdapterTransactionContext}; arbitrary backend writes are absent from
 * every public transaction context. TypeGraph's non-enumerable symbol port is
 * an unsupported implementation detail, not a JavaScript security boundary:
 * reflective code can still discover symbol properties.
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
type TransactionCollections<G extends GraphDef> = Readonly<{
  [TRANSACTION_RUNTIME]: TransactionRuntime;
  nodes: GraphNodeCollections<G>;
  edges: GraphEdgeCollections<G>;
  /** Read-only backend projection bound to the same graph transaction. */
  backend: TransactionReadBackend;
  /**
   * Runtime string-keyed node collection access, mirroring
   * `Store.getNodeCollection`. Returns `undefined` when `kind` is not
   * registered in this graph.
   */
  getNodeCollection: <const K extends string>(
    kind: K,
  ) => DynamicNodeCollection<K> | undefined;
}> &
  (G["identity"] extends GraphIdentityConfig ?
    Readonly<{ identity: IdentityFacade<G> }>
  : Readonly<Record<never, never>>);

/**
 * A portable transaction context containing only TypeGraph-owned graph
 * operations. Managed Stores use this surface so adapter-native handles never
 * enter their public contract.
 */
export type TransactionContext<G extends GraphDef> = TransactionCollections<G>;

/**
 * A transaction context exposed by an {@link AdapterStore}. In addition to the
 * portable graph collections, it carries the adapter-native handle when that
 * capability is available. The TypeGraph backend remains the same runtime
 * read projection as the portable context; adapter-native writes intentionally
 * go through `sql`, making that escape hatch explicit.
 */
export type AdapterTransactionContext<
  G extends GraphDef,
  TNativeTransaction,
> = TransactionCollections<G> & AdapterTransactionSqlAccess<TNativeTransaction>;

/**
 * Scoped write measurement, available only on the receipt-enabled transaction
 * contexts (`transactionWithReceipt`, `withRecordedTransaction`). Runs `fn`,
 * passing it a **scoped context** — a second view over the same transaction — and
 * returns a {@link TransactionOutcome} whose receipt counts exactly the writes
 * made *through that scoped context* (`scoped.nodes` / `scoped.edges`).
 *
 * Attribution is by **which context you write through**, not by timing. A write
 * through the scoped context counts in both the scope and the outer receipt (it
 * happened in the transaction); a write through the outer `tx` during the scope
 * counts only in the outer receipt. This makes overlapping and concurrent
 * measures safe by construction — two scopes running under `Promise.all`, each
 * writing through its own scoped context, never cross-count. Nesting composes:
 * `scoped.measure(...)` opens a child scope that counts in itself, every
 * ancestor scope, and the outer receipt.
 *
 * Counts otherwise inherit {@link TransactionReceipt} (bulk by input length, a
 * rejected write counts 0). The returned receipt's `recorded` is **always
 * `undefined`**: the recorded commit instant is a per-transaction flush concern,
 * unknowable mid-transaction.
 */
export type ScopedMeasure<Context> = <T>(
  fn: (scoped: Context) => Promise<T>,
) => Promise<TransactionOutcome<T>>;

/**
 * A {@link TransactionContext} that also exposes {@link ScopedMeasure}. Only the
 * receipt-enabled entry points (`transactionWithReceipt`,
 * `withRecordedTransaction`) hand a callback this type; plain `transaction()`
 * contexts have no recorder and therefore no `measure`, keeping that path
 * zero-overhead. Assignable to {@link TransactionContext}, so a projector helper
 * typed `(tx: TransactionContext<G>) => ...` accepts a measurable context. The
 * scoped context handed to `measure` is itself measurable, so scopes nest.
 */
export type MeasurableTransactionContext<G extends GraphDef> =
  TransactionContext<G> &
    Readonly<{
      measure: ScopedMeasure<MeasurableTransactionContext<G>>;
    }>;

/** Receipt-enabled transaction context for an {@link AdapterStore}. */
export type MeasurableAdapterTransactionContext<
  G extends GraphDef,
  TNativeTransaction,
> = AdapterTransactionContext<G, TNativeTransaction> &
  Readonly<{
    measure: ScopedMeasure<
      MeasurableAdapterTransactionContext<G, TNativeTransaction>
    >;
  }>;

// ============================================================
// Dynamic Collection Types (widened for runtime dispatch)
// ============================================================

/**
 * A node returned by a runtime string-keyed collection.
 *
 * Its nominal node-type brand proves the value passed through the dynamic
 * collection API while its properties remain runtime-schema-shaped.
 */
export type DynamicNode<K extends string = string> = Node<DynamicNodeType<K>>;

declare const DYNAMIC_NODE_REFERENCE_BRAND: unique symbol;

/** A nominal lightweight reference returned by runtime-aware identity reads. */
export type DynamicNodeReference<K extends string = string> = Readonly<{
  kind: DynamicNodeKind<K>;
  id: NodeId<DynamicNodeType<K>>;
  [DYNAMIC_NODE_REFERENCE_BRAND]: true;
}>;

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
 * the full `NodeCollection` API but with a nominal `DynamicNodeType` and
 * `string` constraint names instead of the specific generic parameters, since
 * the concrete type is not known at compile time.
 *
 * ID parameters accept plain `string` instead of branded `NodeId<N>`, since
 * the dynamic path typically receives IDs from edge metadata, snapshots,
 * or external input where the brand is not available.
 */
export type DynamicNodeCollection<K extends string = string> = WidenBrandedIds<
  NodeCollection<DynamicNodeType<K>, string>
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

/** A node collection narrowed by Store-issued runtime-kind evidence. */
export type RuntimeNodeCollection<T extends RuntimeNodeKind> = WidenBrandedIds<
  NodeCollection<RuntimeNodeTypeFor<T>, string>
>;

/** An edge collection narrowed by Store-issued runtime-kind evidence. */
export type RuntimeEdgeCollection<T extends RuntimeEdgeKind> = WidenBrandedIds<
  EdgeCollection<RuntimeEdgeTypeFor<T>, NodeType, NodeType>
>;

/** One kind-grouped source input for a token-validated heterogeneous read. */
export type RuntimeBulkEdgeSourceGroup<T extends RuntimeNodeKind> =
  T extends RuntimeNodeKind ? Readonly<{ kind: T; ids: readonly string[] }>
  : never;

/** A source reference narrowed to the node token that licensed it. */
export type RuntimeNodeReferenceFor<T extends RuntimeNodeKind> =
  T extends RuntimeNodeKind ?
    Readonly<{
      kind: T["kind"];
      id: NodeId<RuntimeNodeTypeFor<T>>;
    }>
  : never;

/** An edge value narrowed to the edge token that licensed its read. */
export type RuntimeEdgeFor<T extends RuntimeEdgeKind> =
  T extends RuntimeEdgeKind ? Edge<RuntimeEdgeTypeFor<T>, NodeType, NodeType>
  : never;

/** Input for {@link Store.bulkFindRuntimeEdgesFrom}. */
export type BulkFindRuntimeEdgesFromParams<
  NT extends RuntimeNodeKind,
  ET extends RuntimeEdgeKind,
> = Readonly<{
  sources: readonly RuntimeBulkEdgeSourceGroup<NT>[];
  edgeKinds: readonly ET[];
}>;

/** One source bucket returned by {@link Store.bulkFindRuntimeEdgesFrom}. */
export type BulkFindRuntimeEdgesFromResult<
  NT extends RuntimeNodeKind,
  ET extends RuntimeEdgeKind,
> = Readonly<{
  source: RuntimeNodeReferenceFor<NT>;
  edges: readonly RuntimeEdgeFor<ET>[];
}>;

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
