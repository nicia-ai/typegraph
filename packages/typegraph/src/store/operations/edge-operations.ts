/**
 * Edge Operations for Store
 *
 * Handles edge CRUD operations: create, update, delete.
 */
import {
  createBackendOverlay,
  type EdgeRow as BackendEdgeRow,
  type GraphBackend,
  type GraphReadBackend,
  type InsertEdgeParams,
  rowPropsToObject,
  type TransactionBackend,
} from "../../backend/types";
import { validateEdgeEndpoints } from "../../constraints";
import { type GraphDef } from "../../core/define-graph";
import {
  type Cardinality,
  type KindEntity,
  type TemporalMode,
} from "../../core/types";
import {
  CardinalityError,
  DatabaseOperationError,
  EdgeNotFoundError,
  EndpointNotFoundError,
  KindNotFoundError,
  ValidationError,
} from "../../errors";
import { validateEdgeProps } from "../../errors/validation";
import { type SqlSchema } from "../../query/compiler/schema";
import { type KindRegistry } from "../../registry/kind-registry";
import { canonicalEqual } from "../../schema/canonical";
import { validateOptionalCanonicalIsoDate } from "../../utils/date";
import { generateId } from "../../utils/id";
import { type UpsertDirtyCheck } from "../collections/coalesce";
import {
  checkCardinalityConstraint,
  type ConstraintContext,
} from "../constraints";
import {
  edgeInsertDispatch,
  runInsertBatch,
  runInsertBatchReturning,
  runInsertNoReturn,
} from "../insert-dispatch";
import { type EdgeRow, rowToEdge } from "../row-mappers";
import {
  type CreateEdgeInput,
  type Edge,
  type GetOrCreateAction,
  type IfExistsMode,
  type OperationHookContext,
} from "../types";
import {
  runHookedWriteOperation,
  runInWriteTransaction,
} from "./write-transaction";

// ============================================================
// Types
// ============================================================

/**
 * Context for edge operations.
 */
export type EdgeOperationContext<G extends GraphDef> = Readonly<{
  graph: G;
  graphId: string;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
  revisionSchema: SqlSchema;
  registry: KindRegistry;
  createOperationContext: (
    operation: "create" | "update" | "delete",
    entity: KindEntity,
    kind: string,
    id: string,
  ) => OperationHookContext;
  withOperationHooks: <T>(
    ctx: OperationHookContext,
    fn: () => Promise<T>,
  ) => Promise<T>;
}>;

// ============================================================
// Helper Functions
// ============================================================

function getEdgeRegistration<G extends GraphDef>(graph: G, kind: string) {
  const registration = graph.edges[kind];
  if (registration === undefined) throw new KindNotFoundError(kind, "edge");
  return registration;
}

type EdgeCreatePrepared = Readonly<{
  insertParams: InsertEdgeParams;
  cardinality: Cardinality;
}>;

function buildEdgeEndpointCacheKey(
  graphId: string,
  kind: string,
  id: string,
): string {
  return `${graphId}\u0000${kind}\u0000${id}`;
}

function buildEdgeFromCacheKey(
  graphId: string,
  edgeKind: string,
  fromKind: string,
  fromId: string,
): string {
  return `${graphId}\u0000${edgeKind}\u0000${fromKind}\u0000${fromId}`;
}

function buildEdgeBetweenCacheKey(
  graphId: string,
  edgeKind: string,
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
): string {
  return `${graphId}\u0000${edgeKind}\u0000${fromKind}\u0000${fromId}\u0000${toKind}\u0000${toId}`;
}

function buildCountEdgesFromCacheKey(
  params: Parameters<GraphBackend["countEdgesFrom"]>[0],
): string {
  const activeOnly = params.activeOnly === true ? "1" : "0";
  return `${params.graphId}\u0000${params.edgeKind}\u0000${params.fromKind}\u0000${params.fromId}\u0000${activeOnly}`;
}

function buildInsertEdgeParams(
  graphId: string,
  id: string,
  kind: string,
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
  props: Record<string, unknown>,
  validFrom: string | undefined,
  validTo: string | undefined,
): InsertEdgeParams {
  const insertParams: {
    graphId: string;
    id: string;
    kind: string;
    fromKind: string;
    fromId: string;
    toKind: string;
    toId: string;
    props: Record<string, unknown>;
    validFrom?: string;
    validTo?: string;
  } = {
    graphId,
    id,
    kind,
    fromKind,
    fromId,
    toKind,
    toId,
    props,
  };
  if (validFrom !== undefined) insertParams.validFrom = validFrom;
  if (validTo !== undefined) insertParams.validTo = validTo;
  return insertParams;
}

function incrementPendingCount(counts: Map<string, number>, key: string): void {
  const previous = counts.get(key) ?? 0;
  counts.set(key, previous + 1);
}

function createEdgeBatchValidationBackend(
  backend: GraphBackend | TransactionBackend,
): Readonly<{
  backend: GraphBackend | TransactionBackend;
  registerPendingEdgeForCardinality: (
    insertParams: InsertEdgeParams,
    cardinality: Cardinality,
  ) => void;
  seedEndpointRow: (
    graphId: string,
    kind: string,
    id: string,
    row: Awaited<ReturnType<GraphBackend["getNode"]>>,
  ) => void;
}> {
  const endpointCache = new Map<
    string,
    Awaited<ReturnType<GraphBackend["getNode"]>>
  >();
  const countEdgesFromCache = new Map<string, number>();
  const edgeExistsCache = new Map<string, boolean>();
  const pendingOneCounts = new Map<string, number>();
  const pendingOneActiveCounts = new Map<string, number>();
  const pendingUniquePairs = new Set<string>();

  async function getNodeCached(
    graphId: string,
    kind: string,
    id: string,
  ): Promise<Awaited<ReturnType<GraphBackend["getNode"]>>> {
    const cacheKey = buildEdgeEndpointCacheKey(graphId, kind, id);
    if (endpointCache.has(cacheKey)) {
      return endpointCache.get(cacheKey);
    }
    const node = await backend.getNode(graphId, kind, id);
    endpointCache.set(cacheKey, node);
    return node;
  }

  // Lets batch preparation prime the endpoint cache from one getNodes
  // round trip per (kind) instead of a per-edge getNode probe for each
  // from/to endpoint — mirrors seedNodeRow in createNodeBatchValidationBackend.
  // Seeding an absent result (`undefined`) is meaningful — it marks the key
  // as known-missing so the per-edge check skips the backend read. An
  // earlier lookup or seed always wins; seeding never overwrites.
  function seedEndpointRow(
    graphId: string,
    kind: string,
    id: string,
    row: Awaited<ReturnType<GraphBackend["getNode"]>>,
  ): void {
    const cacheKey = buildEdgeEndpointCacheKey(graphId, kind, id);
    if (endpointCache.has(cacheKey)) return;
    endpointCache.set(cacheKey, row);
  }

  async function countEdgesFromCached(
    params: Parameters<GraphBackend["countEdgesFrom"]>[0],
  ): Promise<number> {
    const cacheKey = buildCountEdgesFromCacheKey(params);
    let baseCount = countEdgesFromCache.get(cacheKey);
    if (baseCount === undefined) {
      baseCount = await backend.countEdgesFrom(params);
      countEdgesFromCache.set(cacheKey, baseCount);
    }
    const pendingKey = buildEdgeFromCacheKey(
      params.graphId,
      params.edgeKind,
      params.fromKind,
      params.fromId,
    );
    const pendingCount =
      params.activeOnly === true ?
        (pendingOneActiveCounts.get(pendingKey) ?? 0)
      : (pendingOneCounts.get(pendingKey) ?? 0);
    return baseCount + pendingCount;
  }

  async function edgeExistsBetweenCached(
    params: Parameters<GraphBackend["edgeExistsBetween"]>[0],
  ): Promise<boolean> {
    const cacheKey = buildEdgeBetweenCacheKey(
      params.graphId,
      params.edgeKind,
      params.fromKind,
      params.fromId,
      params.toKind,
      params.toId,
    );
    if (pendingUniquePairs.has(cacheKey)) {
      return true;
    }
    if (edgeExistsCache.has(cacheKey)) {
      return edgeExistsCache.get(cacheKey) ?? false;
    }
    const exists = await backend.edgeExistsBetween(params);
    edgeExistsCache.set(cacheKey, exists);
    return exists;
  }

  function registerPendingEdgeForCardinality(
    insertParams: InsertEdgeParams,
    cardinality: Cardinality,
  ): void {
    const fromCacheKey = buildEdgeFromCacheKey(
      insertParams.graphId,
      insertParams.kind,
      insertParams.fromKind,
      insertParams.fromId,
    );
    if (cardinality === "one") {
      incrementPendingCount(pendingOneCounts, fromCacheKey);
      return;
    }
    if (cardinality === "oneActive") {
      if (insertParams.validTo === undefined) {
        incrementPendingCount(pendingOneActiveCounts, fromCacheKey);
      }
      return;
    }
    if (cardinality === "unique") {
      const uniqueCacheKey = buildEdgeBetweenCacheKey(
        insertParams.graphId,
        insertParams.kind,
        insertParams.fromKind,
        insertParams.fromId,
        insertParams.toKind,
        insertParams.toId,
      );
      pendingUniquePairs.add(uniqueCacheKey);
    }
  }

  const validationBackend = createBackendOverlay(backend, {
    getNode: getNodeCached,
    countEdgesFrom: countEdgesFromCached,
    edgeExistsBetween: edgeExistsBetweenCached,
  } satisfies Partial<GraphBackend | TransactionBackend>);

  return {
    backend: validationBackend,
    registerPendingEdgeForCardinality,
    seedEndpointRow,
  };
}

async function validateAndPrepareEdgeCreate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: CreateEdgeInput,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<EdgeCreatePrepared> {
  const kind = input.kind;
  const fromKind = input.fromKind;
  const toKind = input.toKind;

  // Validate kind exists and get registration
  const registration = getEdgeRegistration(ctx.graph, kind);
  const edgeKind = registration.type;

  // Validate endpoint types
  const endpointError = validateEdgeEndpoints(
    kind,
    fromKind,
    toKind,
    registration,
    ctx.registry,
  );
  if (endpointError) throw endpointError;

  // Validate source node exists
  const fromNode = await backend.getNode(ctx.graphId, fromKind, input.fromId);
  if (!fromNode || fromNode.deleted_at) {
    throw new EndpointNotFoundError({
      edgeKind: kind,
      endpoint: "from",
      nodeKind: fromKind,
      nodeId: input.fromId,
    });
  }

  // Validate target node exists
  const toNode = await backend.getNode(ctx.graphId, toKind, input.toId);
  if (!toNode || toNode.deleted_at) {
    throw new EndpointNotFoundError({
      edgeKind: kind,
      endpoint: "to",
      nodeKind: toKind,
      nodeId: input.toId,
    });
  }

  // Validate props with full context
  const validatedProps = validateEdgeProps(edgeKind.schema, input.props, {
    kind,
    operation: "create",
  });

  // Validate temporal fields
  const validFrom = validateOptionalCanonicalIsoDate(
    input.validFrom,
    "validFrom",
  );
  const validTo = validateOptionalCanonicalIsoDate(input.validTo, "validTo");

  // Check cardinality constraints
  const cardinality = registration.cardinality ?? "many";
  const constraintContext: ConstraintContext = {
    graphId: ctx.graphId,
    registry: ctx.registry,
    backend,
  };
  await checkCardinalityConstraint(
    constraintContext,
    kind,
    cardinality,
    fromKind,
    input.fromId,
    toKind,
    input.toId,
    validTo,
  );

  return {
    cardinality,
    insertParams: buildInsertEdgeParams(
      ctx.graphId,
      id,
      kind,
      fromKind,
      input.fromId,
      toKind,
      input.toId,
      validatedProps,
      validFrom,
      validTo,
    ),
  };
}

// ============================================================
// Edge Operations
// ============================================================

/**
 * Executes an edge create operation.
 */
async function executeEdgeCreateInternal<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: CreateEdgeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{ returnRow?: boolean }>,
): Promise<Edge | undefined> {
  const kind = input.kind;
  const id = input.id ?? generateId();
  const opContext = ctx.createOperationContext("create", "edge", kind, id);
  const shouldReturnRow = options?.returnRow ?? true;

  return runHookedWriteOperation(ctx, opContext, backend, async (target) => {
    const prepared = await validateAndPrepareEdgeCreate(ctx, input, id, target);

    let row: BackendEdgeRow | undefined;
    if (shouldReturnRow) {
      row = await target.insertEdge(prepared.insertParams);
    } else {
      await runInsertNoReturn(
        edgeInsertDispatch(target),
        prepared.insertParams,
      );
    }

    if (row === undefined) return;
    return rowToEdge(row);
  });
}

/**
 * Executes an edge create operation and returns the created edge.
 */
export async function executeEdgeCreate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: CreateEdgeInput,
  backend: GraphBackend | TransactionBackend,
): Promise<Edge> {
  const result = await executeEdgeCreateInternal(ctx, input, backend, {
    returnRow: true,
  });
  if (!result) {
    throw new DatabaseOperationError(
      "Edge create failed: expected created edge row",
      { operation: "insert", entity: "edge" },
    );
  }
  return result;
}

/**
 * Executes an edge create operation without returning the created edge payload.
 */
export async function executeEdgeCreateNoReturn<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: CreateEdgeInput,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  await executeEdgeCreateInternal(ctx, input, backend, { returnRow: false });
}

/**
 * Batch-primes an edge batch's endpoint validation cache with one
 * `getNodes` round trip per distinct (kind) referenced across every
 * from/to endpoint in the batch, instead of a `getNode` probe per edge.
 * Mirrors `primeBatchValidationCaches`'s node-existence priming.
 */
async function primeEdgeBatchValidationCache<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  inputs: readonly CreateEdgeInput[],
  backend: GraphBackend | TransactionBackend,
  seedEndpointRow: (
    graphId: string,
    kind: string,
    id: string,
    row: Awaited<ReturnType<GraphBackend["getNode"]>>,
  ) => void,
): Promise<void> {
  if (backend.getNodes === undefined) return;

  const idsByKind = new Map<string, Set<string>>();
  const addEndpoint = (kind: string, id: string): void => {
    const ids = idsByKind.get(kind) ?? new Set<string>();
    ids.add(id);
    idsByKind.set(kind, ids);
  };
  for (const input of inputs) {
    addEndpoint(input.fromKind, input.fromId);
    addEndpoint(input.toKind, input.toId);
  }

  for (const [kind, ids] of idsByKind) {
    const orderedIds = [...ids];
    const rows = await backend.getNodes(ctx.graphId, kind, orderedIds);
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    for (const id of orderedIds) {
      seedEndpointRow(ctx.graphId, kind, id, rowsById.get(id));
    }
  }
}

/**
 * Shared batch preparation for edge creates: primes the endpoint
 * validation cache with one `getNodes` call per referenced kind, then
 * validates every input against the primed cache in order (so later
 * inputs see earlier ones' pending cardinality/uniqueness registrations).
 * Shared between the non-returning and RETURNING batch paths so both get
 * the same batched-prefetch treatment.
 */
async function prepareEdgeBatchCreates<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  inputs: readonly CreateEdgeInput[],
  backend: GraphBackend | TransactionBackend,
): Promise<{
  preparedCreates: EdgeCreatePrepared[];
  batchInsertParams: InsertEdgeParams[];
}> {
  const {
    backend: validationBackend,
    registerPendingEdgeForCardinality,
    seedEndpointRow,
  } = createEdgeBatchValidationBackend(backend);

  await primeEdgeBatchValidationCache(ctx, inputs, backend, seedEndpointRow);

  const preparedCreates: EdgeCreatePrepared[] = [];
  for (const input of inputs) {
    const id = input.id ?? generateId();
    const prepared = await validateAndPrepareEdgeCreate(
      ctx,
      input,
      id,
      validationBackend,
    );
    preparedCreates.push(prepared);
    registerPendingEdgeForCardinality(
      prepared.insertParams,
      prepared.cardinality,
    );
  }

  const batchInsertParams = preparedCreates.map(
    (prepared) => prepared.insertParams,
  );

  return { preparedCreates, batchInsertParams };
}

/**
 * Executes batched edge creates without returning inserted edge payloads.
 *
 * Note: `withOperationHooks` is intentionally skipped for batch throughput.
 * Per-item hooks would negate the performance benefit of batching.
 */
export async function executeEdgeCreateNoReturnBatch<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  inputs: readonly CreateEdgeInput[],
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  if (inputs.length === 0) {
    return;
  }

  await runInWriteTransaction(ctx, backend, async (target) => {
    const { batchInsertParams } = await prepareEdgeBatchCreates(
      ctx,
      inputs,
      target,
    );
    await runInsertBatch(edgeInsertDispatch(target), batchInsertParams);
  });
}

/**
 * Executes batched edge creates and returns the inserted edge payloads.
 *
 * Uses batch validation caching and a single multi-row INSERT with RETURNING
 * when the backend supports it. Falls back to sequential inserts otherwise.
 *
 * Note: `withOperationHooks` is intentionally skipped for batch throughput.
 * Per-item hooks would negate the performance benefit of batching.
 */
export async function executeEdgeCreateBatch<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  inputs: readonly CreateEdgeInput[],
  backend: GraphBackend | TransactionBackend,
): Promise<readonly Edge[]> {
  if (inputs.length === 0) {
    return [];
  }

  return runInWriteTransaction(ctx, backend, async (target) => {
    const { batchInsertParams } = await prepareEdgeBatchCreates(
      ctx,
      inputs,
      target,
    );

    const rows = await runInsertBatchReturning(
      edgeInsertDispatch(target),
      batchInsertParams,
    );

    return rows.map((row) => rowToEdge(row));
  });
}

/**
 * The exact props an edge update would persist: the caller's partial input
 * merged over the current props and run through the edge kind's Zod schema.
 * Operates on PARSED props so the write path and the coalesce dirty-check
 * (which may compare against a batch-local running value, never a row) share
 * one validation. Endpoints are the edge's identity and are not part of an
 * upsert-by-id update, so only props are involved.
 */
function computeEdgeUpdate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  kind: string,
  id: string,
  existingProps: Record<string, unknown>,
  inputProps: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  const registration = getEdgeRegistration(ctx.graph, kind);
  return validateEdgeProps(
    registration.type.schema,
    { ...existingProps, ...inputProps },
    { kind, operation: "update", id },
  );
}

/**
 * Row-based wrapper over {@link computeEdgeUpdate} for the write path.
 */
function resolveEdgeUpdateProps<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  existing: Pick<EdgeRow, "kind" | "id" | "props">,
  inputProps: Partial<Record<string, unknown>>,
): Readonly<{
  existingProps: Record<string, unknown>;
  validatedProps: Record<string, unknown>;
}> {
  const existingProps = rowPropsToObject(existing.props);
  const validatedProps = computeEdgeUpdate(
    ctx,
    existing.kind,
    existing.id,
    existingProps,
    inputProps,
  );
  return { existingProps, validatedProps };
}

/**
 * The edge coalesce dirty-check: returns the props an upsert would persist and
 * whether they equal `existingProps`. `existingProps` is the PARSED current
 * props — the edge's, or the batch-local running value for a repeated id.
 */
export function edgeUpsertDirtyCheck<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  kind: string,
  id: string,
  existingProps: Record<string, unknown>,
  inputProps: Record<string, unknown>,
): UpsertDirtyCheck {
  const validatedProps = computeEdgeUpdate(
    ctx,
    kind,
    id,
    existingProps,
    inputProps,
  );
  return {
    validatedProps,
    unchanged: canonicalEqual(validatedProps, existingProps),
  };
}

/**
 * Shared edge-update body: re-reads the edge inside the transaction, merges
 * and validates props, and writes. A plain update requires a live edge; a
 * resurrecting upsert (`clearDeleted`) may target a tombstoned one.
 */
async function performEdgeUpdate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: {
    id: string;
    props: Partial<Record<string, unknown>>;
    validTo?: string;
  },
  target: GraphBackend | TransactionBackend,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Edge> {
  const id = input.id;

  const existing = await target.getEdge(ctx.graphId, id);
  if (!existing || (!options?.clearDeleted && existing.deleted_at)) {
    throw new EdgeNotFoundError("unknown", id);
  }

  const { validatedProps } = resolveEdgeUpdateProps(ctx, existing, input.props);

  const validTo = validateOptionalCanonicalIsoDate(input.validTo, "validTo");

  const updateParams: {
    graphId: string;
    id: string;
    props: Record<string, unknown>;
    validTo?: string;
    clearDeleted?: boolean;
  } = {
    graphId: ctx.graphId,
    id,
    props: validatedProps,
  };
  if (validTo !== undefined) updateParams.validTo = validTo;
  if (options?.clearDeleted) updateParams.clearDeleted = true;

  const row = await target.updateEdge(updateParams);

  return rowToEdge(row);
}

/**
 * Executes an edge update operation.
 */
export async function executeEdgeUpdate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: {
    id: string;
    props: Partial<Record<string, unknown>>;
    validTo?: string;
  },
  backend: GraphBackend | TransactionBackend,
): Promise<Edge> {
  const id = input.id;

  // Read outside the transaction: the hook context needs the edge kind, and
  // hooks must WRAP the transaction (matching node operations and edge
  // create) so onOperationEnd reports success only after COMMIT — a hook
  // that fires inside the transaction would report success for a write that
  // a failed commit then rolls back. An absent edge also never opens an empty
  // transaction. The body re-reads inside the transaction, so a concurrent
  // delete between this gate and the write lock is still handled correctly.
  const gate = await backend.getEdge(ctx.graphId, id);
  if (!gate || gate.deleted_at) {
    throw new EdgeNotFoundError("unknown", id);
  }

  const opContext = ctx.createOperationContext("update", "edge", gate.kind, id);

  return runHookedWriteOperation(ctx, opContext, backend, (target) =>
    performEdgeUpdate(ctx, input, target),
  );
}

/**
 * Executes an edge update for upsert — bypasses the soft-delete check
 * and optionally clears `deleted_at`.
 */
export async function executeEdgeUpsertUpdate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: {
    id: string;
    props: Partial<Record<string, unknown>>;
    validTo?: string;
  },
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Edge> {
  return runInWriteTransaction(ctx, backend, (target) =>
    performEdgeUpdate(ctx, input, target, options),
  );
}

/**
 * Executes an edge delete operation.
 */
export async function executeEdgeDelete<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  // Gate outside the transaction so an absent/tombstoned edge never opens an
  // empty one; the gate row also supplies the kind for the hook context,
  // because hooks must WRAP the transaction (matching node operations and
  // edge create) so onOperationEnd reports success only after COMMIT.
  const gate = await backend.getEdge(ctx.graphId, id);
  if (!gate || gate.deleted_at) return;

  const opContext = ctx.createOperationContext("delete", "edge", gate.kind, id);

  return runHookedWriteOperation(ctx, opContext, backend, async (target) => {
    // No in-transaction preflight: the tombstone UPDATE is guarded by
    // `deleted_at IS NULL`, so a concurrent delete between the gate and
    // the write lock is a 0-row no-op — the statement itself is the
    // concurrency-correct check, and nothing here consumes the row.
    await target.deleteEdge({
      graphId: ctx.graphId,
      id,
    });
  });
}

/**
 * Executes an edge hard delete operation (permanent removal).
 *
 * Unlike soft delete, this permanently removes the edge from the database.
 */
export async function executeEdgeHardDelete<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  // Gate outside the transaction so an absent edge never opens an empty one;
  // hooks wrap the transaction (see executeEdgeDelete).
  const gate = await backend.getEdge(ctx.graphId, id);
  if (!gate) return;

  const opContext = ctx.createOperationContext("delete", "edge", gate.kind, id);

  return runHookedWriteOperation(ctx, opContext, backend, async (target) => {
    // No in-transaction preflight: DELETE by primary key is idempotent
    // (0 rows when concurrently removed) and nothing here consumes the
    // row.
    await target.hardDeleteEdge({
      graphId: ctx.graphId,
      id,
    });
  });
}

// ============================================================
// Get-Or-Create Operations
// ============================================================

// Delimiters for composite match keys
const RECORD_SEP = "\u001E";
const UNIT_SEP = "\u001F";
const UNDEFINED_SENTINEL = "\u001D";

/**
 * Validates that all `matchOn` fields exist in the edge schema shape.
 * Throws a ValidationError for invalid fields.
 */
function validateMatchOnFields(
  schema: { shape?: Record<string, unknown> },
  matchOn: readonly string[],
  edgeKind: string,
): void {
  if (matchOn.length === 0) return;
  const shape = schema.shape;
  if (shape === undefined) {
    throw new ValidationError(
      `Edge kind "${edgeKind}" has no schema shape to validate matchOn fields against`,
      {
        kind: edgeKind,
        operation: "create",
        issues: matchOn.map((field) => ({
          path: field,
          message: `Field "${field}" does not exist in edge schema`,
        })),
      },
    );
  }

  const invalidFields = matchOn.filter((field) => !(field in shape));
  if (invalidFields.length > 0) {
    throw new ValidationError(
      `Invalid matchOn fields for edge kind "${edgeKind}": ${invalidFields.join(", ")}`,
      {
        kind: edgeKind,
        operation: "create",
        issues: invalidFields.map((field) => ({
          path: field,
          message: `Field "${field}" does not exist in edge schema`,
        })),
      },
    );
  }
}

/**
 * Serializes a value for composite key construction.
 * Sorts object keys for deterministic ordering of nested values.
 */
function stableStringify(value: unknown): string {
  if (value === undefined) return UNDEFINED_SENTINEL;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const sorted = Object.keys(value).toSorted();
  const entries = sorted.map(
    (key) =>
      `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(",")}}`;
}

/**
 * Builds a deterministic composite key for edge matching.
 *
 * Format: `fromKind\u001EfromId\u001EtoKind\u001EtoId[\u001Efield\u001Fvalue]*`
 */
function buildEdgeCompositeKey(
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
  props: Record<string, unknown>,
  matchOn: readonly string[],
): string {
  const endpointPart = `${fromKind}${RECORD_SEP}${fromId}${RECORD_SEP}${toKind}${RECORD_SEP}${toId}`;
  if (matchOn.length === 0) return endpointPart;

  const sortedFields = [...matchOn].toSorted();
  const propertyParts = sortedFields.map(
    (field) =>
      `${RECORD_SEP}${field}${UNIT_SEP}${stableStringify(props[field])}`,
  );
  return endpointPart + propertyParts.join("");
}

/**
 * Endpoint-only key for grouping findEdgesByKind queries.
 */
function buildEndpointPairKey(
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
): string {
  return `${fromKind}${RECORD_SEP}${fromId}${RECORD_SEP}${toKind}${RECORD_SEP}${toId}`;
}

type EdgeMatch = Readonly<{
  liveRow: BackendEdgeRow | undefined;
  deletedRow: BackendEdgeRow | undefined;
}>;

/**
 * Finds the best matching edge from candidate rows.
 * Partitions into live vs deleted; prefers live.
 */
function findMatchingEdge(
  rows: readonly BackendEdgeRow[],
  matchOn: readonly string[],
  inputProps: Record<string, unknown>,
): EdgeMatch {
  let liveRow: BackendEdgeRow | undefined;
  let deletedRow: BackendEdgeRow | undefined;

  for (const row of rows) {
    if (matchOn.length > 0) {
      const rowProps = rowPropsToObject(row.props);
      const matches = matchOn.every(
        (field) =>
          stableStringify(rowProps[field]) ===
          stableStringify(inputProps[field]),
      );
      if (!matches) continue;
    }

    if (row.deleted_at === undefined) {
      liveRow ??= row;
    } else {
      deletedRow ??= row;
    }

    if (liveRow !== undefined) break;
  }

  return { liveRow, deletedRow };
}

/**
 * Executes a single findByEndpoints operation.
 *
 * Looks up an edge by endpoints and optional matchOn fields, honoring the
 * temporal coordinate in `options` (mode / asOf / excludeDeleted) the same way
 * `findFrom` / `findTo` do. Returns the matching edge, or undefined. By default
 * soft-deleted and out-of-window edges are excluded; under `includeTombstones`
 * (excludeDeleted = false) a soft-deleted edge can be returned.
 */
export async function executeEdgeFindByEndpoints<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  kind: string,
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
  backend: GraphReadBackend,
  options?: Readonly<{
    matchOn?: readonly string[];
    props?: Record<string, unknown>;
    excludeDeleted?: boolean;
    temporalMode?: TemporalMode;
    asOf?: string;
  }>,
): Promise<Edge | undefined> {
  const matchOn = options?.matchOn ?? [];
  const props = options?.props ?? {};

  const registration = getEdgeRegistration(ctx.graph, kind);
  const edgeKind = registration.type;

  if (matchOn.length > 0) {
    validateMatchOnFields(edgeKind.schema, matchOn, kind);
  }

  const candidateRows = await backend.findEdgesByKind({
    graphId: ctx.graphId,
    kind,
    fromKind,
    fromId,
    toKind,
    toId,
    excludeDeleted: options?.excludeDeleted ?? true,
    ...(options?.temporalMode !== undefined && {
      temporalMode: options.temporalMode,
    }),
    ...(options?.asOf !== undefined && { asOf: options.asOf }),
  });

  if (candidateRows.length === 0) return undefined;

  if (matchOn.length === 0) return rowToEdge(candidateRows[0]!);

  const { liveRow } = findMatchingEdge(candidateRows, matchOn, props);
  return liveRow === undefined ? undefined : rowToEdge(liveRow);
}

/**
 * Executes a single getOrCreateByEndpoints operation.
 */
export async function executeEdgeGetOrCreateByEndpoints<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  kind: string,
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
  props: Record<string, unknown>,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{
    matchOn?: readonly string[];
    ifExists?: IfExistsMode;
  }>,
): Promise<Readonly<{ edge: Edge; action: GetOrCreateAction }>> {
  const ifExists = options?.ifExists ?? "return";
  const matchOn = options?.matchOn ?? [];

  const registration = getEdgeRegistration(ctx.graph, kind);
  const edgeKind = registration.type;

  // Validate props
  const validatedProps = validateEdgeProps(edgeKind.schema, props, {
    kind,
    operation: "create",
  });

  // Validate matchOn fields
  validateMatchOnFields(edgeKind.schema, matchOn, kind);

  // Probe outside the transaction: with ifExists "return", the common found
  // path performs no write, so it must not pay for a write transaction
  // (BEGIN IMMEDIATE on SQLite, the per-graph advisory lock under history).
  // The transactional body re-queries, so a concurrent create between this
  // probe and the write lock is still handled correctly.
  if (ifExists === "return") {
    const probeRows = await backend.findEdgesByKind({
      graphId: ctx.graphId,
      kind,
      fromKind,
      fromId,
      toKind,
      toId,
      excludeDeleted: false,
      temporalMode: "includeTombstones",
    });
    const { liveRow: probedLiveRow } = findMatchingEdge(
      probeRows,
      matchOn,
      validatedProps,
    );
    if (probedLiveRow !== undefined) {
      return { edge: rowToEdge(probedLiveRow), action: "found" };
    }
  }

  // No enclosing transaction: each write leg opens its own (hooked, for the
  // create leg) transaction. An outer transaction here would make the nested
  // operation run directly inside it and fire its success hooks before THIS
  // wrapper's COMMIT — the durability contract hooks promise would be false.
  // A concurrent create that wins between the lookup and the write surfaces
  // as a cardinality conflict and is converged by one retry of the lookup.
  async function attempt(): Promise<
    Readonly<{ edge: Edge; action: GetOrCreateAction }>
  > {
    // Query all edges of this kind between (from, to) including tombstones
    const candidateRows = await backend.findEdgesByKind({
      graphId: ctx.graphId,
      kind,
      fromKind,
      fromId,
      toKind,
      toId,
      excludeDeleted: false,
      temporalMode: "includeTombstones",
    });

    const { liveRow, deletedRow } = findMatchingEdge(
      candidateRows,
      matchOn,
      validatedProps,
    );

    // No match → create new edge
    if (liveRow === undefined && deletedRow === undefined) {
      const input: CreateEdgeInput = {
        kind,
        fromKind,
        fromId,
        toKind,
        toId,
        props: validatedProps,
      };
      const edge = await executeEdgeCreate(ctx, input, backend);
      return { edge, action: "created" };
    }

    // Live match found
    if (liveRow !== undefined) {
      if (ifExists === "return") {
        return { edge: rowToEdge(liveRow), action: "found" };
      }
      // ifExists === "update"
      const edge = await executeEdgeUpsertUpdate(
        ctx,
        { id: liveRow.id, props: validatedProps },
        backend,
      );
      return { edge, action: "updated" };
    }

    // Deleted match only → check cardinality before resurrect
    const cardinality = registration.cardinality ?? "many";
    if (deletedRow === undefined) {
      throw new Error("Expected deletedRow to be defined");
    }
    const matchedDeletedRow = deletedRow;
    const effectiveValidTo = matchedDeletedRow.valid_to;
    const constraintContext: ConstraintContext = {
      graphId: ctx.graphId,
      registry: ctx.registry,
      backend,
    };
    await checkCardinalityConstraint(
      constraintContext,
      kind,
      cardinality,
      fromKind,
      fromId,
      toKind,
      toId,
      effectiveValidTo,
    );

    const edge = await executeEdgeUpsertUpdate(
      ctx,
      { id: matchedDeletedRow.id, props: validatedProps },
      backend,
      { clearDeleted: true },
    );
    return { edge, action: "resurrected" };
  }

  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof CardinalityError)) throw error;
    return attempt();
  }
}

/**
 * Executes a bulk getOrCreateByEndpoints operation.
 */
export async function executeEdgeBulkGetOrCreateByEndpoints<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  kind: string,
  items: readonly Readonly<{
    fromKind: string;
    fromId: string;
    toKind: string;
    toId: string;
    props: Record<string, unknown>;
  }>[],
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{
    matchOn?: readonly string[];
    ifExists?: IfExistsMode;
  }>,
): Promise<Readonly<{ edge: Edge; action: GetOrCreateAction }>[]> {
  if (items.length === 0) return [];

  const ifExists = options?.ifExists ?? "return";
  const matchOn = options?.matchOn ?? [];

  const registration = getEdgeRegistration(ctx.graph, kind);
  const edgeKind = registration.type;
  const cardinality = registration.cardinality ?? "many";

  // Validate matchOn fields once
  validateMatchOnFields(edgeKind.schema, matchOn, kind);

  // Step 1: Validate all props and compute composite keys
  const validated: {
    fromKind: string;
    fromId: string;
    toKind: string;
    toId: string;
    validatedProps: Record<string, unknown>;
    compositeKey: string;
    endpointKey: string;
  }[] = [];

  for (const item of items) {
    const validatedProps = validateEdgeProps(edgeKind.schema, item.props, {
      kind,
      operation: "create",
    });

    const compositeKey = buildEdgeCompositeKey(
      item.fromKind,
      item.fromId,
      item.toKind,
      item.toId,
      validatedProps,
      matchOn,
    );
    const endpointKey = buildEndpointPairKey(
      item.fromKind,
      item.fromId,
      item.toKind,
      item.toId,
    );

    validated.push({
      fromKind: item.fromKind,
      fromId: item.fromId,
      toKind: item.toKind,
      toId: item.toId,
      validatedProps,
      compositeKey,
      endpointKey,
    });
  }

  // Step 2: Group by unique endpoint pair
  const uniqueEndpoints = new Map<
    string,
    { fromKind: string; fromId: string; toKind: string; toId: string }
  >();
  for (const entry of validated) {
    if (!uniqueEndpoints.has(entry.endpointKey)) {
      uniqueEndpoints.set(entry.endpointKey, {
        fromKind: entry.fromKind,
        fromId: entry.fromId,
        toKind: entry.toKind,
        toId: entry.toId,
      });
    }
  }

  // Fetch all candidate rows, grouped by endpoint pair. Shared by the
  // outside-transaction probe (reading the root backend) and the
  // transactional body (re-reading through the transaction target).
  async function fetchRowsByEndpoint(
    reader: GraphReadBackend,
  ): Promise<ReadonlyMap<string, readonly BackendEdgeRow[]>> {
    const rowsByEndpoint = new Map<string, readonly BackendEdgeRow[]>();
    for (const [endpointKey, endpoint] of uniqueEndpoints) {
      const rows = await reader.findEdgesByKind({
        graphId: ctx.graphId,
        kind,
        fromKind: endpoint.fromKind,
        fromId: endpoint.fromId,
        toKind: endpoint.toKind,
        toId: endpoint.toId,
        excludeDeleted: false,
        temporalMode: "includeTombstones",
      });
      rowsByEndpoint.set(endpointKey, rows);
    }
    return rowsByEndpoint;
  }

  interface CreateEntry {
    index: number;
    input: CreateEdgeInput;
  }
  interface FetchEntry {
    index: number;
    row: BackendEdgeRow;
    isDeleted: boolean;
    validatedProps: Record<string, unknown>;
    fromKind: string;
    fromId: string;
    toKind: string;
    toId: string;
  }
  interface DuplicateEntry {
    index: number;
    sourceIndex: number;
  }
  interface Result {
    readonly edge: Edge;
    readonly action: GetOrCreateAction;
  }

  // Step 3: Partition into toCreate, toFetch, and duplicates
  function partitionEntries(
    rowsByEndpoint: ReadonlyMap<string, readonly BackendEdgeRow[]>,
  ): Readonly<{
    toCreate: CreateEntry[];
    toFetch: FetchEntry[];
    duplicateOf: DuplicateEntry[];
  }> {
    const toCreate: CreateEntry[] = [];
    const toFetch: FetchEntry[] = [];
    const duplicateOf: DuplicateEntry[] = [];
    const seenKeys = new Map<string, number>();

    for (const [index, entry] of validated.entries()) {
      // Check within-batch duplicate
      const previousIndex = seenKeys.get(entry.compositeKey);
      if (previousIndex !== undefined) {
        duplicateOf.push({ index, sourceIndex: previousIndex });
        continue;
      }
      seenKeys.set(entry.compositeKey, index);

      const candidateRows = rowsByEndpoint.get(entry.endpointKey) ?? [];
      const { liveRow, deletedRow } = findMatchingEdge(
        candidateRows,
        matchOn,
        entry.validatedProps,
      );

      if (liveRow === undefined && deletedRow === undefined) {
        toCreate.push({
          index,
          input: {
            kind,
            fromKind: entry.fromKind,
            fromId: entry.fromId,
            toKind: entry.toKind,
            toId: entry.toId,
            props: entry.validatedProps,
          },
        });
      } else {
        // At least one of liveRow/deletedRow is defined (both-undefined handled above)
        const bestRow = liveRow ?? deletedRow;
        if (bestRow === undefined) {
          throw new Error("Expected at least one of liveRow or deletedRow");
        }
        toFetch.push({
          index,
          row: bestRow,
          isDeleted: liveRow === undefined,
          validatedProps: entry.validatedProps,
          fromKind: entry.fromKind,
          fromId: entry.fromId,
          toKind: entry.toKind,
          toId: entry.toId,
        });
      }
    }

    return { toCreate, toFetch, duplicateOf };
  }

  // Probe outside the transaction: with ifExists "return" and every entry
  // matching a live edge, the whole call performs no write, so it must not
  // pay for a write transaction (BEGIN IMMEDIATE on SQLite, the per-graph
  // advisory lock under history). The transactional body re-queries, so a
  // concurrent write between this probe and the write lock is still handled
  // correctly.
  if (ifExists === "return") {
    const probe = partitionEntries(await fetchRowsByEndpoint(backend));
    const allFoundLive =
      probe.toCreate.length === 0 &&
      probe.toFetch.every((entry) => !entry.isDeleted);
    if (allFoundLive) {
      const found: Result[] = Array.from({ length: items.length });
      for (const entry of probe.toFetch) {
        found[entry.index] = { edge: rowToEdge(entry.row), action: "found" };
      }
      for (const { index, sourceIndex } of probe.duplicateOf) {
        found[index] = { edge: found[sourceIndex]!.edge, action: "found" };
      }
      return found;
    }
  }

  return runInWriteTransaction(ctx, backend, async (target) => {
    const { toCreate, toFetch, duplicateOf } = partitionEntries(
      await fetchRowsByEndpoint(target),
    );
    const results: Result[] = Array.from({ length: items.length });

    // Step 4: Execute creates in batch
    if (toCreate.length > 0) {
      const createInputs = toCreate.map((entry) => entry.input);
      const createdEdges = await executeEdgeCreateBatch(
        ctx,
        createInputs,
        target,
      );
      for (const [batchIndex, entry] of toCreate.entries()) {
        results[entry.index] = {
          edge: createdEdges[batchIndex]!,
          action: "created",
        };
      }
    }

    // Step 5: Handle existing edges (update/skip/resurrect)
    for (const entry of toFetch) {
      if (entry.isDeleted) {
        // Check cardinality before resurrect
        const effectiveValidTo = entry.row.valid_to;
        const constraintContext: ConstraintContext = {
          graphId: ctx.graphId,
          registry: ctx.registry,
          backend: target,
        };
        await checkCardinalityConstraint(
          constraintContext,
          kind,
          cardinality,
          entry.fromKind,
          entry.fromId,
          entry.toKind,
          entry.toId,
          effectiveValidTo,
        );

        const edge = await executeEdgeUpsertUpdate(
          ctx,
          { id: entry.row.id, props: entry.validatedProps },
          target,
          { clearDeleted: true },
        );
        results[entry.index] = { edge, action: "resurrected" };
      } else if (ifExists === "update") {
        const edge = await executeEdgeUpsertUpdate(
          ctx,
          { id: entry.row.id, props: entry.validatedProps },
          target,
        );
        results[entry.index] = { edge, action: "updated" };
      } else {
        results[entry.index] = { edge: rowToEdge(entry.row), action: "found" };
      }
    }

    // Step 6: Resolve within-batch duplicates
    for (const { index, sourceIndex } of duplicateOf) {
      const sourceResult = results[sourceIndex]!;
      results[index] = { edge: sourceResult.edge, action: "found" };
    }

    return results;
  });
}
