/**
 * Node Operations for Store
 *
 * Handles node CRUD operations: create, update, delete.
 */
import {
  type GraphBackend,
  type InsertNodeParams,
  type NodeRow as BackendNodeRow,
  type TransactionBackend,
  type UniqueRow,
} from "../../backend/types";
import {
  checkWherePredicate,
  computeUniqueKey,
  getKindsForUniquenessCheck,
} from "../../constraints";
import { type GraphDef } from "../../core/define-graph";
import { type NodeType, type UniqueConstraint } from "../../core/types";
import {
  DatabaseOperationError,
  KindNotFoundError,
  NodeConstraintNotFoundError,
  NodeNotFoundError,
  RestrictedDeleteError,
  ValidationError,
} from "../../errors";
import { validateNodeProps } from "../../errors/validation";
import { type KindRegistry } from "../../registry/kind-registry";
import { validateOptionalIsoDate } from "../../utils/date";
import { generateId } from "../../utils/id";
import {
  checkDisjointnessConstraint,
  type ConstraintContext,
} from "../constraints";
import {
  deleteNodeEmbeddings,
  type EmbeddingSyncContext,
  syncEmbeddings,
} from "../embedding-sync";
import {
  deleteNodeFulltext,
  type FulltextSyncContext,
  syncFulltext,
} from "../fulltext-sync";
import { rowToNode } from "../row-mappers";
import {
  type CreateNodeInput,
  type GetOrCreateAction,
  type Node,
  type NodeGetOrCreateByConstraintOptions,
  type OperationHookContext,
  type UpdateNodeInput,
} from "../types";
import {
  checkUniquenessConstraints,
  deleteUniquenessEntries,
  insertUniquenessEntries,
  type UniquenessContext,
  updateUniquenessEntries,
} from "../uniqueness";

// ============================================================
// Types
// ============================================================

export type NodeOperationContext<G extends GraphDef> = Readonly<{
  graph: G;
  graphId: string;
  registry: KindRegistry;
  createOperationContext: (
    operation: "create" | "update" | "delete",
    entity: "node" | "edge",
    kind: string,
    id: string,
  ) => OperationHookContext;
  withOperationHooks: <T>(
    ctx: OperationHookContext,
    fn: () => Promise<T>,
  ) => Promise<T>;
}>;

type NodeCreatePrepared = Readonly<{
  kind: string;
  id: string;
  nodeKind: NodeType;
  validatedProps: Record<string, unknown>;
  uniqueConstraints: readonly UniqueConstraint[];
  insertParams: InsertNodeParams;
}>;

type CachedNodeRow = Awaited<ReturnType<GraphBackend["getNode"]>>;
type CachedUniqueRow = Awaited<ReturnType<GraphBackend["checkUnique"]>>;

type DeleteMode = "soft" | "hard";

// ============================================================
// Helper Functions
// ============================================================

function getNodeRegistration<G extends GraphDef>(graph: G, kind: string) {
  const registration = graph.nodes[kind];
  if (registration === undefined) throw new KindNotFoundError(kind, "node");
  return registration;
}

const CACHE_KEY_SEPARATOR = "\u0000";

function buildNodeCacheKey(graphId: string, kind: string, id: string): string {
  return `${graphId}${CACHE_KEY_SEPARATOR}${kind}${CACHE_KEY_SEPARATOR}${id}`;
}

function buildUniqueCacheKey(
  graphId: string,
  nodeKind: string,
  constraintName: string,
  key: string,
): string {
  return `${graphId}${CACHE_KEY_SEPARATOR}${nodeKind}${CACHE_KEY_SEPARATOR}${constraintName}${CACHE_KEY_SEPARATOR}${key}`;
}

function createNodeAlreadyExistsError(
  kind: string,
  id: string,
): ValidationError {
  return new ValidationError(
    `Node already exists: ${kind}/${id}`,
    {
      entityType: "node",
      kind,
      operation: "create",
      id,
      issues: [{ path: "id", message: "A node with this ID already exists" }],
    },
    { suggestion: `Use a different ID or update the existing node.` },
  );
}

function buildInsertNodeParams(
  graphId: string,
  kind: string,
  id: string,
  props: Record<string, unknown>,
  validFrom: string | undefined,
  validTo: string | undefined,
): InsertNodeParams {
  const insertParams: {
    graphId: string;
    kind: string;
    id: string;
    props: Record<string, unknown>;
    validFrom?: string;
    validTo?: string;
  } = {
    graphId,
    kind,
    id,
    props,
  };
  if (validFrom !== undefined) insertParams.validFrom = validFrom;
  if (validTo !== undefined) insertParams.validTo = validTo;
  return insertParams;
}

function createPendingUniqueRow(
  graphId: string,
  nodeKind: string,
  constraintName: string,
  key: string,
  nodeId: string,
): UniqueRow {
  return {
    graph_id: graphId,
    node_kind: nodeKind,
    constraint_name: constraintName,
    key,
    node_id: nodeId,
    concrete_kind: nodeKind,
    deleted_at: undefined,
  };
}

function resolveConstraint<G extends GraphDef>(
  graph: G,
  kind: string,
  constraintName: string,
): UniqueConstraint {
  const registration = getNodeRegistration(graph, kind);
  const constraints = registration.unique ?? [];
  const constraint = constraints.find(
    (candidate) => candidate.name === constraintName,
  );
  if (constraint === undefined) {
    throw new NodeConstraintNotFoundError(constraintName, kind);
  }
  return constraint;
}

function createUniquenessContext(
  graphId: string,
  registry: KindRegistry,
  backend: GraphBackend | TransactionBackend,
): UniquenessContext {
  return { graphId, registry, backend };
}

function createEmbeddingSyncContext(
  graphId: string,
  nodeKind: string,
  nodeId: string,
  backend: GraphBackend | TransactionBackend,
): EmbeddingSyncContext {
  return { graphId, nodeKind, nodeId, backend };
}

function createFulltextSyncContext(
  graphId: string,
  nodeKind: string,
  nodeId: string,
  backend: GraphBackend | TransactionBackend,
): FulltextSyncContext {
  return { graphId, nodeKind, nodeId, backend };
}

// ============================================================
// Batch Validation Cache
//
// During batch operations, multiple items may reference the same
// nodes/unique keys. This cache avoids redundant backend lookups
// and tracks pending (not-yet-flushed) inserts so that later items
// in the batch can see earlier ones during validation.
// ============================================================

function createNodeBatchValidationBackend(
  graphId: string,
  registry: KindRegistry,
  backend: GraphBackend | TransactionBackend,
): Readonly<{
  backend: GraphBackend | TransactionBackend;
  registerPendingNode: (params: InsertNodeParams) => void;
  registerPendingUniqueEntries: (
    kind: string,
    id: string,
    props: Record<string, unknown>,
    constraints: readonly UniqueConstraint[],
  ) => void;
}> {
  const nodeCache = new Map<string, CachedNodeRow>();
  const pendingNodes = new Map<string, NonNullable<CachedNodeRow>>();
  const uniqueCache = new Map<string, CachedUniqueRow>();
  const pendingUniqueOwners = new Map<string, string>();

  async function getNodeCached(
    lookupGraphId: string,
    kind: string,
    id: string,
  ): Promise<CachedNodeRow> {
    const cacheKey = buildNodeCacheKey(lookupGraphId, kind, id);
    const pendingNode = pendingNodes.get(cacheKey);
    if (pendingNode !== undefined) return pendingNode;
    if (nodeCache.has(cacheKey)) return nodeCache.get(cacheKey);
    const existing = await backend.getNode(lookupGraphId, kind, id);
    nodeCache.set(cacheKey, existing);
    return existing;
  }

  async function checkUniqueCached(
    params: Parameters<GraphBackend["checkUnique"]>[0],
  ): Promise<CachedUniqueRow> {
    const cacheKey = buildUniqueCacheKey(
      params.graphId,
      params.nodeKind,
      params.constraintName,
      params.key,
    );
    const pendingOwner = pendingUniqueOwners.get(cacheKey);
    if (pendingOwner !== undefined) {
      return createPendingUniqueRow(
        params.graphId,
        params.nodeKind,
        params.constraintName,
        params.key,
        pendingOwner,
      );
    }
    if (uniqueCache.has(cacheKey)) return uniqueCache.get(cacheKey);
    const existing = await backend.checkUnique(params);
    uniqueCache.set(cacheKey, existing);
    return existing;
  }

  function registerPendingNode(params: InsertNodeParams): void {
    const cacheKey = buildNodeCacheKey(params.graphId, params.kind, params.id);
    pendingNodes.set(cacheKey, {
      graph_id: params.graphId,
      kind: params.kind,
      id: params.id,
      props: JSON.stringify(params.props),
      version: 1,
      valid_from: params.validFrom,
      valid_to: params.validTo,
      created_at: "",
      updated_at: "",
      deleted_at: undefined,
    });
  }

  function registerPendingUniqueEntries(
    kind: string,
    id: string,
    props: Record<string, unknown>,
    constraints: readonly UniqueConstraint[],
  ): void {
    for (const constraint of constraints) {
      if (!checkWherePredicate(constraint, props)) continue;

      const key = computeUniqueKey(
        props,
        constraint.fields,
        constraint.collation,
      );
      const concreteEntryKey = buildUniqueCacheKey(
        graphId,
        kind,
        constraint.name,
        key,
      );
      pendingUniqueOwners.set(concreteEntryKey, id);

      if (constraint.scope !== "kind") {
        const kindsToCheck = getKindsForUniquenessCheck(
          kind,
          constraint.scope,
          registry,
        );
        for (const kindToCheck of kindsToCheck) {
          const inheritedEntryKey = buildUniqueCacheKey(
            graphId,
            kindToCheck,
            constraint.name,
            key,
          );
          pendingUniqueOwners.set(inheritedEntryKey, id);
        }
      }
    }
  }

  // The cast is necessary because spreading a union type (GraphBackend | TransactionBackend)
  // produces an intersection of their members, which TypeScript can't narrow back to the union.
  const validationBackend = {
    ...backend,
    getNode: getNodeCached,
    checkUnique: checkUniqueCached,
  } as GraphBackend | TransactionBackend;

  return {
    backend: validationBackend,
    registerPendingNode,
    registerPendingUniqueEntries,
  };
}

// ============================================================
// Shared Create Pipeline
// ============================================================

async function validateAndPrepareNodeCreate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: CreateNodeInput,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<NodeCreatePrepared> {
  const kind = input.kind;
  const registration = getNodeRegistration(ctx.graph, kind);
  const nodeKind = registration.type;

  const validatedProps = validateNodeProps(nodeKind.schema, input.props, {
    kind,
    operation: "create",
  });

  const validFrom = validateOptionalIsoDate(input.validFrom, "validFrom");
  const validTo = validateOptionalIsoDate(input.validTo, "validTo");

  const existingNode = await backend.getNode(ctx.graphId, kind, id);
  if (existingNode && !existingNode.deleted_at) {
    throw createNodeAlreadyExistsError(kind, id);
  }

  const constraintContext: ConstraintContext = {
    graphId: ctx.graphId,
    registry: ctx.registry,
    backend,
  };
  await checkDisjointnessConstraint(constraintContext, kind, id);

  const uniqueConstraints = registration.unique ?? [];
  await checkUniquenessConstraints(
    createUniquenessContext(ctx.graphId, ctx.registry, backend),
    kind,
    id,
    validatedProps,
    uniqueConstraints,
  );

  return {
    kind,
    id,
    nodeKind,
    validatedProps,
    uniqueConstraints,
    insertParams: buildInsertNodeParams(
      ctx.graphId,
      kind,
      id,
      validatedProps,
      validFrom,
      validTo,
    ),
  };
}

async function finalizeNodeCreate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  prepared: NodeCreatePrepared,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  await insertUniquenessEntries(
    createUniquenessContext(ctx.graphId, ctx.registry, backend),
    prepared.kind,
    prepared.id,
    prepared.validatedProps,
    prepared.uniqueConstraints,
  );

  await syncEmbeddings(
    createEmbeddingSyncContext(
      ctx.graphId,
      prepared.kind,
      prepared.id,
      backend,
    ),
    prepared.nodeKind.schema,
    prepared.validatedProps,
  );

  await syncFulltext(
    createFulltextSyncContext(ctx.graphId, prepared.kind, prepared.id, backend),
    prepared.nodeKind.schema,
    prepared.validatedProps,
  );
}

// ============================================================
// Shared Update Pipeline
//
// executeNodeUpdate wraps this in operation hooks.
// executeNodeUpsertUpdate calls it directly (no hooks) for
// getOrCreate resurrections.
// ============================================================

async function performNodeUpdate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: UpdateNodeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Node> {
  const { kind, id } = input;
  const registration = getNodeRegistration(ctx.graph, kind);

  const existing = await backend.getNode(ctx.graphId, kind, id);
  if (!existing || (existing.deleted_at && !options?.clearDeleted)) {
    throw new NodeNotFoundError(kind, id);
  }

  const existingProps = JSON.parse(existing.props) as Record<string, unknown>;
  const mergedProps = { ...existingProps, ...input.props };

  const nodeKind = registration.type;
  const validatedProps = validateNodeProps(nodeKind.schema, mergedProps, {
    kind,
    operation: "update",
    id,
  });

  const validTo = validateOptionalIsoDate(input.validTo, "validTo");

  await updateUniquenessEntries(
    createUniquenessContext(ctx.graphId, ctx.registry, backend),
    kind,
    id,
    existingProps,
    validatedProps,
    registration.unique ?? [],
  );

  const updateParams: {
    graphId: string;
    kind: string;
    id: string;
    props: Record<string, unknown>;
    validTo?: string;
    incrementVersion?: boolean;
    clearDeleted?: boolean;
  } = {
    graphId: ctx.graphId,
    kind,
    id,
    props: validatedProps,
    incrementVersion: true,
  };
  if (validTo !== undefined) updateParams.validTo = validTo;
  if (options?.clearDeleted) updateParams.clearDeleted = true;

  const row = await backend.updateNode(updateParams);

  await syncEmbeddings(
    createEmbeddingSyncContext(ctx.graphId, kind, id, backend),
    nodeKind.schema,
    validatedProps,
  );

  await syncFulltext(
    createFulltextSyncContext(ctx.graphId, kind, id, backend),
    nodeKind.schema,
    validatedProps,
  );

  return rowToNode(row);
}

// ============================================================
// Shared Delete Pipeline
//
// Soft and hard delete share the same delete-behavior logic
// (restrict / cascade / disconnect). The only differences are:
// - whether soft-deleted nodes are skippable (soft) or deletable (hard)
// - which backend method removes edges and the node itself
// ============================================================

async function enforceDeleteBehavior<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  id: string,
  mode: DeleteMode,
  backend: GraphBackend | TransactionBackend,
  registration: ReturnType<typeof getNodeRegistration>,
): Promise<void> {
  const deleteBehavior = registration.onDelete ?? "restrict";
  const connectedEdges = await backend.findEdgesConnectedTo({
    graphId: ctx.graphId,
    nodeKind: kind,
    nodeId: id,
  });

  if (connectedEdges.length === 0) return;

  switch (deleteBehavior) {
    case "restrict": {
      const edgeKinds = [...new Set(connectedEdges.map((edge) => edge.kind))];
      throw new RestrictedDeleteError({
        nodeKind: kind,
        nodeId: id,
        edgeCount: connectedEdges.length,
        edgeKinds,
      });
    }

    case "cascade":
    case "disconnect": {
      // Both behaviors remove connected edges. "cascade" signals intent to
      // remove dependent data; "disconnect" signals intent to sever the
      // relationship. The effect is identical because edges cannot exist
      // without both endpoints.
      for (const edge of connectedEdges) {
        await (mode === "hard" ?
          backend.hardDeleteEdge({
            graphId: ctx.graphId,
            id: edge.id,
          })
        : backend.deleteEdge({
            graphId: ctx.graphId,
            id: edge.id,
          }));
      }
      break;
    }
  }
}

// ============================================================
// Shared Batch Preparation
//
// Both returning and non-returning batch creates share the same
// validate-and-register loop. This extracts it.
// ============================================================

async function prepareBatchCreates<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  inputs: readonly CreateNodeInput[],
  backend: GraphBackend | TransactionBackend,
): Promise<{
  preparedCreates: NodeCreatePrepared[];
  batchInsertParams: InsertNodeParams[];
}> {
  const {
    backend: validationBackend,
    registerPendingNode,
    registerPendingUniqueEntries,
  } = createNodeBatchValidationBackend(ctx.graphId, ctx.registry, backend);

  const preparedCreates: NodeCreatePrepared[] = [];

  for (const input of inputs) {
    const id = input.id ?? generateId();
    const prepared = await validateAndPrepareNodeCreate(
      ctx,
      input,
      id,
      validationBackend,
    );
    preparedCreates.push(prepared);
    registerPendingNode(prepared.insertParams);
    registerPendingUniqueEntries(
      prepared.kind,
      prepared.id,
      prepared.validatedProps,
      prepared.uniqueConstraints,
    );
  }

  const batchInsertParams = preparedCreates.map(
    (prepared) => prepared.insertParams,
  );

  return { preparedCreates, batchInsertParams };
}

// ============================================================
// Shared Constraint Lookup
//
// Both single and bulk find/getOrCreate operations need to look up
// unique constraint entries across all applicable kinds.
// ============================================================

async function findUniqueRowAcrossKinds(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  constraintName: string,
  key: string,
  kindsToCheck: readonly string[],
  includeDeleted: boolean,
): Promise<
  | { node_id: string; concrete_kind: string; deleted_at: string | undefined }
  | undefined
> {
  for (const kindToCheck of kindsToCheck) {
    const row = await backend.checkUnique({
      graphId,
      nodeKind: kindToCheck,
      constraintName,
      key,
      includeDeleted,
    });
    if (row !== undefined) return row;
  }
  return undefined;
}

interface UniqueMatchRow {
  node_id: string;
  concrete_kind: string;
  deleted_at: string | undefined;
}

async function batchCheckUniqueAcrossKinds(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  constraintName: string,
  uniqueKeys: readonly string[],
  kindsToCheck: readonly string[],
  includeDeleted: boolean,
): Promise<Map<string, UniqueMatchRow>> {
  const existingByKey = new Map<string, UniqueMatchRow>();

  for (const kindToCheck of kindsToCheck) {
    if (backend.checkUniqueBatch === undefined) {
      for (const key of uniqueKeys) {
        if (existingByKey.has(key)) continue;
        const row = await backend.checkUnique({
          graphId,
          nodeKind: kindToCheck,
          constraintName,
          key,
          includeDeleted,
        });
        if (row !== undefined) {
          existingByKey.set(row.key, row);
        }
      }
    } else {
      const rows = await backend.checkUniqueBatch({
        graphId,
        nodeKind: kindToCheck,
        constraintName,
        keys: uniqueKeys,
        includeDeleted,
      });
      for (const row of rows) {
        if (!existingByKey.has(row.key)) {
          existingByKey.set(row.key, row);
        }
      }
    }
  }

  return existingByKey;
}

// ============================================================
// Node Create Operations
// ============================================================

async function executeNodeCreateInternal<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: CreateNodeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{ returnRow?: boolean }>,
): Promise<Node | undefined> {
  const kind = input.kind;
  const id = input.id ?? generateId();
  const opContext = ctx.createOperationContext("create", "node", kind, id);
  const shouldReturnRow = options?.returnRow ?? true;

  return ctx.withOperationHooks(opContext, async () => {
    const prepared = await validateAndPrepareNodeCreate(
      ctx,
      input,
      id,
      backend,
    );

    let row: BackendNodeRow | undefined;
    if (shouldReturnRow) {
      row = await backend.insertNode(prepared.insertParams);
    } else {
      await (backend.insertNodeNoReturn?.(prepared.insertParams) ??
        backend.insertNode(prepared.insertParams));
    }

    await finalizeNodeCreate(ctx, prepared, backend);

    if (row === undefined) return;
    return rowToNode(row);
  });
}

export async function executeNodeCreate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: CreateNodeInput,
  backend: GraphBackend | TransactionBackend,
): Promise<Node> {
  const result = await executeNodeCreateInternal(ctx, input, backend, {
    returnRow: true,
  });
  if (!result) {
    throw new DatabaseOperationError(
      "Node create failed: expected created node row",
      { operation: "insert", entity: "node" },
    );
  }
  return result;
}

export async function executeNodeCreateNoReturn<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: CreateNodeInput,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  await executeNodeCreateInternal(ctx, input, backend, { returnRow: false });
}

/**
 * Executes batched node creates without returning inserted node payloads.
 *
 * Note: `withOperationHooks` is intentionally skipped for batch throughput.
 * Per-item hooks would negate the performance benefit of batching.
 */
export async function executeNodeCreateNoReturnBatch<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  inputs: readonly CreateNodeInput[],
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  if (inputs.length === 0) return;

  const { preparedCreates, batchInsertParams } = await prepareBatchCreates(
    ctx,
    inputs,
    backend,
  );

  if (backend.insertNodesBatch === undefined) {
    for (const insertParams of batchInsertParams) {
      await (backend.insertNodeNoReturn?.(insertParams) ??
        backend.insertNode(insertParams));
    }
  } else {
    await backend.insertNodesBatch(batchInsertParams);
  }

  for (const prepared of preparedCreates) {
    await finalizeNodeCreate(ctx, prepared, backend);
  }
}

/**
 * Executes batched node creates and returns the inserted node payloads.
 *
 * Uses batch validation caching and a single multi-row INSERT with RETURNING
 * when the backend supports it. Falls back to sequential inserts otherwise.
 *
 * Note: `withOperationHooks` is intentionally skipped for batch throughput.
 * Per-item hooks would negate the performance benefit of batching.
 */
export async function executeNodeCreateBatch<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  inputs: readonly CreateNodeInput[],
  backend: GraphBackend | TransactionBackend,
): Promise<readonly Node[]> {
  if (inputs.length === 0) return [];

  const { preparedCreates, batchInsertParams } = await prepareBatchCreates(
    ctx,
    inputs,
    backend,
  );

  let rows: readonly BackendNodeRow[];
  if (backend.insertNodesBatchReturning === undefined) {
    const sequentialRows: BackendNodeRow[] = [];
    for (const insertParams of batchInsertParams) {
      sequentialRows.push(await backend.insertNode(insertParams));
    }
    rows = sequentialRows;
  } else {
    rows = await backend.insertNodesBatchReturning(batchInsertParams);
  }

  for (const prepared of preparedCreates) {
    await finalizeNodeCreate(ctx, prepared, backend);
  }

  return rows.map((row) => rowToNode(row));
}

// ============================================================
// Node Update Operations
// ============================================================

export async function executeNodeUpdate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: UpdateNodeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Node> {
  const opContext = ctx.createOperationContext(
    "update",
    "node",
    input.kind,
    input.id,
  );
  return ctx.withOperationHooks(opContext, () =>
    performNodeUpdate(ctx, input, backend, options),
  );
}

/**
 * Executes a node update for upsert — bypasses operation hooks
 * and allows updating soft-deleted nodes when clearDeleted is set.
 */
export async function executeNodeUpsertUpdate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: UpdateNodeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Node> {
  return performNodeUpdate(ctx, input, backend, options);
}

// ============================================================
// Node Delete Operations
// ============================================================

export async function executeNodeDelete<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  const opContext = ctx.createOperationContext("delete", "node", kind, id);

  return ctx.withOperationHooks(opContext, async () => {
    const registration = getNodeRegistration(ctx.graph, kind);

    const existing = await backend.getNode(ctx.graphId, kind, id);
    if (!existing || existing.deleted_at) return;

    const existingProps = JSON.parse(existing.props) as Record<string, unknown>;

    await enforceDeleteBehavior(ctx, kind, id, "soft", backend, registration);

    await backend.deleteNode({ graphId: ctx.graphId, kind, id });

    await deleteUniquenessEntries(
      createUniquenessContext(ctx.graphId, ctx.registry, backend),
      kind,
      existingProps,
      registration.unique ?? [],
    );

    const nodeKind = registration.type;
    await deleteNodeEmbeddings(
      createEmbeddingSyncContext(ctx.graphId, kind, id, backend),
      nodeKind.schema,
    );
    await deleteNodeFulltext(
      createFulltextSyncContext(ctx.graphId, kind, id, backend),
      nodeKind.schema,
    );
  });
}

/**
 * Executes a node hard delete operation (permanent removal).
 *
 * Unlike soft delete, this permanently removes the node and all
 * associated data (uniqueness entries, embeddings) from the database.
 */
export async function executeNodeHardDelete<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  const opContext = ctx.createOperationContext("delete", "node", kind, id);

  return ctx.withOperationHooks(opContext, async () => {
    const registration = getNodeRegistration(ctx.graph, kind);

    const existing = await backend.getNode(ctx.graphId, kind, id);
    if (!existing) return;

    await enforceDeleteBehavior(ctx, kind, id, "hard", backend, registration);

    // The cascade (uniques, embeddings, edges, node) is not individually atomic,
    // so wrap in a transaction when the backend supports it.
    const hardDelete = async (
      target: GraphBackend | TransactionBackend,
    ): Promise<void> => {
      await target.hardDeleteNode({ graphId: ctx.graphId, kind, id });
    };

    await ("transaction" in backend && backend.capabilities.transactions ?
      backend.transaction(async (tx) => hardDelete(tx))
    : hardDelete(backend));
  });
}

// ============================================================
// Get-Or-Create Operations
// ============================================================

export async function executeNodeGetOrCreateByConstraint<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  constraintName: string,
  props: Record<string, unknown>,
  backend: GraphBackend | TransactionBackend,
  options?: NodeGetOrCreateByConstraintOptions,
): Promise<Readonly<{ node: Node; action: GetOrCreateAction }>> {
  const ifExists = options?.ifExists ?? "return";

  const registration = getNodeRegistration(ctx.graph, kind);
  const nodeKind = registration.type;
  const validatedProps = validateNodeProps(nodeKind.schema, props, {
    kind,
    operation: "create",
  });

  const constraint = resolveConstraint(ctx.graph, kind, constraintName);

  if (!checkWherePredicate(constraint, validatedProps)) {
    const node = await executeNodeCreate(
      ctx,
      { kind, props: validatedProps },
      backend,
    );
    return { node, action: "created" };
  }

  const key = computeUniqueKey(
    validatedProps,
    constraint.fields,
    constraint.collation,
  );

  const kindsToCheck = getKindsForUniquenessCheck(
    kind,
    constraint.scope,
    ctx.registry,
  );

  const existingUniqueRow = await findUniqueRowAcrossKinds(
    backend,
    ctx.graphId,
    constraint.name,
    key,
    kindsToCheck,
    true,
  );

  if (existingUniqueRow === undefined) {
    const node = await executeNodeCreate(
      ctx,
      { kind, props: validatedProps },
      backend,
    );
    return { node, action: "created" };
  }

  // Fetch using concrete_kind (may differ from requested kind
  // when scope is "kindWithSubClasses" and the match is on a sibling/parent kind)
  const existingRow = await backend.getNode(
    ctx.graphId,
    existingUniqueRow.concrete_kind,
    existingUniqueRow.node_id,
  );

  if (existingRow === undefined) {
    const node = await executeNodeCreate(
      ctx,
      { kind, props: validatedProps },
      backend,
    );
    return { node, action: "created" };
  }

  const isSoftDeleted = existingRow.deleted_at !== undefined;

  if (isSoftDeleted || ifExists === "update") {
    const concreteKind = existingUniqueRow.concrete_kind;
    const node = await executeNodeUpsertUpdate(
      ctx,
      {
        kind: concreteKind,
        id: existingRow.id as UpdateNodeInput["id"],
        props: validatedProps,
      },
      backend,
      { clearDeleted: isSoftDeleted },
    );
    return { node, action: isSoftDeleted ? "resurrected" : "updated" };
  }

  return { node: rowToNode(existingRow), action: "found" };
}

// ============================================================
// Find-By-Constraint Operations
// ============================================================

export async function executeNodeFindByConstraint<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  constraintName: string,
  props: Record<string, unknown>,
  backend: GraphBackend | TransactionBackend,
): Promise<Node | undefined> {
  const registration = getNodeRegistration(ctx.graph, kind);
  const nodeKind = registration.type;
  const validatedProps = validateNodeProps(nodeKind.schema, props, {
    kind,
    operation: "create",
  });

  const constraint = resolveConstraint(ctx.graph, kind, constraintName);
  if (!checkWherePredicate(constraint, validatedProps)) return undefined;

  const key = computeUniqueKey(
    validatedProps,
    constraint.fields,
    constraint.collation,
  );

  const kindsToCheck = getKindsForUniquenessCheck(
    kind,
    constraint.scope,
    ctx.registry,
  );

  const existingUniqueRow = await findUniqueRowAcrossKinds(
    backend,
    ctx.graphId,
    constraint.name,
    key,
    kindsToCheck,
    false,
  );

  if (existingUniqueRow === undefined) return undefined;

  const existingRow = await backend.getNode(
    ctx.graphId,
    existingUniqueRow.concrete_kind,
    existingUniqueRow.node_id,
  );

  if (existingRow === undefined || existingRow.deleted_at !== undefined)
    return undefined;

  return rowToNode(existingRow);
}

// ============================================================
// Bulk Find-By-Constraint
// ============================================================

/**
 * Validates all items and computes unique constraint keys.
 * Shared by both bulk find and bulk getOrCreate.
 */
function validateAndComputeKeys(
  nodeKind: NodeType,
  kind: string,
  constraint: UniqueConstraint,
  items: readonly Readonly<{ props: Record<string, unknown> }>[],
): { validatedProps: Record<string, unknown>; key: string | undefined }[] {
  const validated: {
    validatedProps: Record<string, unknown>;
    key: string | undefined;
  }[] = [];

  for (const item of items) {
    const validatedProps = validateNodeProps(nodeKind.schema, item.props, {
      kind,
      operation: "create",
    });
    const applies = checkWherePredicate(constraint, validatedProps);
    const key =
      applies ?
        computeUniqueKey(
          validatedProps,
          constraint.fields,
          constraint.collation,
        )
      : undefined;
    validated.push({ validatedProps, key });
  }

  return validated;
}

function collectUniqueKeys(
  validated: readonly { key: string | undefined }[],
): string[] {
  return [
    ...new Set(
      validated
        .map((entry) => entry.key)
        .filter((key): key is string => key !== undefined),
    ),
  ];
}

export async function executeNodeBulkFindByConstraint<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  constraintName: string,
  items: readonly Readonly<{ props: Record<string, unknown> }>[],
  backend: GraphBackend | TransactionBackend,
): Promise<(Node | undefined)[]> {
  if (items.length === 0) return [];

  const registration = getNodeRegistration(ctx.graph, kind);
  const nodeKind = registration.type;
  const constraint = resolveConstraint(ctx.graph, kind, constraintName);

  const validated = validateAndComputeKeys(nodeKind, kind, constraint, items);
  const uniqueKeys = collectUniqueKeys(validated);

  const kindsToCheck = getKindsForUniquenessCheck(
    kind,
    constraint.scope,
    ctx.registry,
  );

  const existingByKey =
    uniqueKeys.length > 0 ?
      await batchCheckUniqueAcrossKinds(
        backend,
        ctx.graphId,
        constraint.name,
        uniqueKeys,
        kindsToCheck,
        false,
      )
    : new Map<string, { node_id: string; concrete_kind: string }>();

  // Assemble results, deduplicating keys seen within the batch
  const results: (Node | undefined)[] = Array.from({ length: items.length });
  const seenKeys = new Map<string, number>();

  for (const [index, { key }] of validated.entries()) {
    if (key === undefined) {
      results[index] = undefined;
      continue;
    }

    const previousIndex = seenKeys.get(key);
    if (previousIndex !== undefined) {
      results[index] = results[previousIndex];
      continue;
    }
    seenKeys.set(key, index);

    const existing = existingByKey.get(key);
    if (existing === undefined) {
      results[index] = undefined;
      continue;
    }

    const existingRow = await backend.getNode(
      ctx.graphId,
      existing.concrete_kind,
      existing.node_id,
    );

    if (existingRow === undefined || existingRow.deleted_at !== undefined) {
      results[index] = undefined;
      continue;
    }

    results[index] = rowToNode(existingRow);
  }

  return results;
}

// ============================================================
// Bulk Get-Or-Create-By-Constraint
// ============================================================

export async function executeNodeBulkGetOrCreateByConstraint<
  G extends GraphDef,
>(
  ctx: NodeOperationContext<G>,
  kind: string,
  constraintName: string,
  items: readonly Readonly<{ props: Record<string, unknown> }>[],
  backend: GraphBackend | TransactionBackend,
  options?: NodeGetOrCreateByConstraintOptions,
): Promise<Readonly<{ node: Node; action: GetOrCreateAction }>[]> {
  if (items.length === 0) return [];

  const ifExists = options?.ifExists ?? "return";
  const registration = getNodeRegistration(ctx.graph, kind);
  const nodeKind = registration.type;
  const constraint = resolveConstraint(ctx.graph, kind, constraintName);

  // Step 1: Validate all props and compute keys
  const validated = validateAndComputeKeys(nodeKind, kind, constraint, items);
  const uniqueKeys = collectUniqueKeys(validated);

  const kindsToCheck = getKindsForUniquenessCheck(
    kind,
    constraint.scope,
    ctx.registry,
  );

  // Step 2: Batch-check existing keys
  const existingByKey =
    uniqueKeys.length > 0 ?
      await batchCheckUniqueAcrossKinds(
        backend,
        ctx.graphId,
        constraint.name,
        uniqueKeys,
        kindsToCheck,
        true,
      )
    : new Map<
        string,
        {
          node_id: string;
          concrete_kind: string;
          deleted_at: string | undefined;
        }
      >();

  // Step 3: Partition into toCreate, toFetch, and duplicates
  const toCreate: { index: number; input: CreateNodeInput }[] = [];
  const toFetch: {
    index: number;
    nodeId: string;
    concreteKind: string;
    validatedProps: Record<string, unknown>;
    isSoftDeleted: boolean;
  }[] = [];
  const duplicateOf: { index: number; sourceIndex: number }[] = [];
  const seenKeys = new Map<string, number>();

  for (const [index, { validatedProps, key }] of validated.entries()) {
    if (key === undefined) {
      toCreate.push({ index, input: { kind, props: validatedProps } });
      continue;
    }

    const previousIndex = seenKeys.get(key);
    if (previousIndex !== undefined) {
      duplicateOf.push({ index, sourceIndex: previousIndex });
      continue;
    }

    seenKeys.set(key, index);

    const existing = existingByKey.get(key);
    if (existing === undefined) {
      toCreate.push({ index, input: { kind, props: validatedProps } });
    } else {
      toFetch.push({
        index,
        nodeId: existing.node_id,
        concreteKind: existing.concrete_kind,
        validatedProps,
        isSoftDeleted: existing.deleted_at !== undefined,
      });
    }
  }

  type Result = Readonly<{ node: Node; action: GetOrCreateAction }>;
  const results: Result[] = Array.from({ length: items.length });

  // Step 4: Execute creates
  if (toCreate.length > 0) {
    const createInputs = toCreate.map((entry) => entry.input);
    const createdNodes = await executeNodeCreateBatch(
      ctx,
      createInputs,
      backend,
    );
    for (const [batchIndex, entry] of toCreate.entries()) {
      results[entry.index] = {
        node: createdNodes[batchIndex]!,
        action: "created",
      };
    }
  }

  // Step 5: Handle existing nodes (fetch/update/resurrect)
  for (const entry of toFetch) {
    const { index, concreteKind, validatedProps, isSoftDeleted, nodeId } =
      entry;

    const existingRow = await backend.getNode(
      ctx.graphId,
      concreteKind,
      nodeId,
    );

    if (existingRow === undefined) {
      const node = await executeNodeCreate(
        ctx,
        { kind, props: validatedProps },
        backend,
      );
      results[index] = { node, action: "created" };
      continue;
    }

    if (isSoftDeleted || ifExists === "update") {
      const node = await executeNodeUpsertUpdate(
        ctx,
        {
          kind: concreteKind,
          id: existingRow.id as UpdateNodeInput["id"],
          props: validatedProps,
        },
        backend,
        { clearDeleted: isSoftDeleted },
      );
      results[index] = {
        node,
        action: isSoftDeleted ? "resurrected" : "updated",
      };
    } else {
      results[index] = { node: rowToNode(existingRow), action: "found" };
    }
  }

  // Step 6: Resolve within-batch duplicates by copying the first occurrence's result
  for (const { index, sourceIndex } of duplicateOf) {
    const sourceResult = results[sourceIndex]!;
    results[index] = { node: sourceResult.node, action: "found" };
  }

  return results;
}
