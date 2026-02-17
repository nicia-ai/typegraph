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
import { rowToNode } from "../row-mappers";
import {
  type CreateNodeInput,
  type Node,
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

/**
 * Context for node operations.
 */
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

// ============================================================
// Helper Functions
// ============================================================

function getNodeRegistration<G extends GraphDef>(graph: G, kind: string) {
  const registration = graph.nodes[kind];
  if (registration === undefined) throw new KindNotFoundError(kind, "node");
  return registration;
}

type NodeCreatePrepared = Readonly<{
  kind: string;
  id: string;
  nodeKind: NodeType;
  validatedProps: Record<string, unknown>;
  uniqueConstraints: readonly UniqueConstraint[];
  insertParams: InsertNodeParams;
}>;

function buildNodeCacheKey(graphId: string, kind: string, id: string): string {
  return `${graphId}\u0000${kind}\u0000${id}`;
}

function buildUniqueCacheKey(
  graphId: string,
  nodeKind: string,
  constraintName: string,
  key: string,
): string {
  return `${graphId}\u0000${nodeKind}\u0000${constraintName}\u0000${key}`;
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
  const nodeCache = new Map<
    string,
    Awaited<ReturnType<GraphBackend["getNode"]>>
  >();
  const pendingNodes = new Map<
    string,
    NonNullable<Awaited<ReturnType<GraphBackend["getNode"]>>>
  >();
  const uniqueCache = new Map<
    string,
    Awaited<ReturnType<GraphBackend["checkUnique"]>>
  >();
  const pendingUniqueOwners = new Map<string, string>();

  async function getNodeCached(
    lookupGraphId: string,
    kind: string,
    id: string,
  ): Promise<Awaited<ReturnType<GraphBackend["getNode"]>>> {
    const cacheKey = buildNodeCacheKey(lookupGraphId, kind, id);
    const pendingNode = pendingNodes.get(cacheKey);
    if (pendingNode !== undefined) {
      return pendingNode;
    }
    if (nodeCache.has(cacheKey)) {
      return nodeCache.get(cacheKey);
    }
    const existing = await backend.getNode(lookupGraphId, kind, id);
    nodeCache.set(cacheKey, existing);
    return existing;
  }

  async function checkUniqueCached(
    params: Parameters<GraphBackend["checkUnique"]>[0],
  ): Promise<Awaited<ReturnType<GraphBackend["checkUnique"]>>> {
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
    if (uniqueCache.has(cacheKey)) {
      return uniqueCache.get(cacheKey);
    }
    const existing = await backend.checkUnique(params);
    uniqueCache.set(cacheKey, existing);
    return existing;
  }

  function registerPendingNode(params: InsertNodeParams): void {
    const cacheKey = buildNodeCacheKey(params.graphId, params.kind, params.id);
    const pendingNode: NonNullable<
      Awaited<ReturnType<GraphBackend["getNode"]>>
    > = {
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
    };
    pendingNodes.set(cacheKey, pendingNode);
  }

  function registerPendingUniqueEntries(
    kind: string,
    id: string,
    props: Record<string, unknown>,
    constraints: readonly UniqueConstraint[],
  ): void {
    for (const constraint of constraints) {
      if (!checkWherePredicate(constraint, props)) {
        continue;
      }
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

  // Override specific methods on the backend for validation caching.
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

async function validateAndPrepareNodeCreate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: CreateNodeInput,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<NodeCreatePrepared> {
  const kind = input.kind;

  // Validate kind exists and get registration
  const registration = getNodeRegistration(ctx.graph, kind);

  // Validate props with full context
  const nodeKind = registration.type;
  const validatedProps = validateNodeProps(nodeKind.schema, input.props, {
    kind,
    operation: "create",
  });

  // Validate temporal fields
  const validFrom = validateOptionalIsoDate(input.validFrom, "validFrom");
  const validTo = validateOptionalIsoDate(input.validTo, "validTo");

  // Check if node with this kind:id already exists
  const existingNode = await backend.getNode(ctx.graphId, kind, id);
  if (existingNode && !existingNode.deleted_at) {
    throw createNodeAlreadyExistsError(kind, id);
  }

  // Check disjointness constraints (for multi-kind nodes with same ID)
  const constraintContext: ConstraintContext = {
    graphId: ctx.graphId,
    registry: ctx.registry,
    backend,
  };
  await checkDisjointnessConstraint(constraintContext, kind, id);

  // Check uniqueness constraints
  const uniquenessContext: UniquenessContext = {
    graphId: ctx.graphId,
    registry: ctx.registry,
    backend,
  };
  const uniqueConstraints = registration.unique ?? [];
  await checkUniquenessConstraints(
    uniquenessContext,
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
  const uniquenessContext: UniquenessContext = {
    graphId: ctx.graphId,
    registry: ctx.registry,
    backend,
  };
  await insertUniquenessEntries(
    uniquenessContext,
    prepared.kind,
    prepared.id,
    prepared.validatedProps,
    prepared.uniqueConstraints,
  );

  const embeddingSyncContext: EmbeddingSyncContext = {
    graphId: ctx.graphId,
    nodeKind: prepared.kind,
    nodeId: prepared.id,
    backend,
  };
  await syncEmbeddings(
    embeddingSyncContext,
    prepared.nodeKind.schema,
    prepared.validatedProps,
  );
}

// ============================================================
// Node Operations
// ============================================================

/**
 * Executes a node create operation.
 */
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

/**
 * Executes a node create operation and returns the created node.
 */
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

/**
 * Executes a node create operation without returning the created node payload.
 */
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
  if (inputs.length === 0) {
    return;
  }

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
  if (inputs.length === 0) {
    return [];
  }

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

/**
 * Executes a node update operation.
 */
export async function executeNodeUpdate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: UpdateNodeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Node> {
  const kind = input.kind;
  const id = input.id;
  const opContext = ctx.createOperationContext("update", "node", kind, id);

  return ctx.withOperationHooks(opContext, async () => {
    // Validate kind exists and get registration
    const registration = getNodeRegistration(ctx.graph, kind);

    // Get existing node
    const existing = await backend.getNode(ctx.graphId, kind, id);
    // If clearDeleted is set, allow updating deleted nodes (used by upsert)
    if (!existing || (existing.deleted_at && !options?.clearDeleted)) {
      throw new NodeNotFoundError(kind, id);
    }

    // Merge props
    const existingProps = JSON.parse(existing.props) as Record<string, unknown>;
    const mergedProps = { ...existingProps, ...input.props };

    // Validate merged props with full context
    const nodeKind = registration.type;
    const validatedProps = validateNodeProps(nodeKind.schema, mergedProps, {
      kind,
      operation: "update",
      id,
    });

    // Validate temporal fields
    const validTo = validateOptionalIsoDate(input.validTo, "validTo");

    // Handle uniqueness constraint changes
    const uniquenessContext: UniquenessContext = {
      graphId: ctx.graphId,
      registry: ctx.registry,
      backend,
    };
    await updateUniquenessEntries(
      uniquenessContext,
      kind,
      id,
      existingProps,
      validatedProps,
      registration.unique ?? [],
    );

    // Update node - conditionally include optional fields
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

    // Sync embeddings with updated props
    const embeddingSyncContext: EmbeddingSyncContext = {
      graphId: ctx.graphId,
      nodeKind: kind,
      nodeId: id,
      backend,
    };
    await syncEmbeddings(embeddingSyncContext, nodeKind.schema, validatedProps);

    return rowToNode(row);
  });
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
  const kind = input.kind;
  const id = input.id;

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

  const uniquenessContext: UniquenessContext = {
    graphId: ctx.graphId,
    registry: ctx.registry,
    backend,
  };
  await updateUniquenessEntries(
    uniquenessContext,
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

  const embeddingSyncContext: EmbeddingSyncContext = {
    graphId: ctx.graphId,
    nodeKind: kind,
    nodeId: id,
    backend,
  };
  await syncEmbeddings(embeddingSyncContext, nodeKind.schema, validatedProps);

  return rowToNode(row);
}

/**
 * Executes a node delete operation.
 */
export async function executeNodeDelete<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  const opContext = ctx.createOperationContext("delete", "node", kind, id);

  return ctx.withOperationHooks(opContext, async () => {
    // Validate kind exists and get registration
    const registration = getNodeRegistration(ctx.graph, kind);

    // Fetch node props BEFORE soft-delete so we can compute unique keys
    const existing = await backend.getNode(ctx.graphId, kind, id);
    if (!existing || existing.deleted_at) {
      // Node already deleted or doesn't exist - nothing to do
      return;
    }
    const existingProps = JSON.parse(existing.props) as Record<string, unknown>;

    // Check delete behavior
    const deleteBehavior = registration.onDelete ?? "restrict";
    const connectedEdges = await backend.findEdgesConnectedTo({
      graphId: ctx.graphId,
      nodeKind: kind,
      nodeId: id,
    });

    if (connectedEdges.length > 0) {
      switch (deleteBehavior) {
        case "restrict": {
          // Block deletion if edges exist
          const edgeKinds = [
            ...new Set(connectedEdges.map((edge) => edge.kind)),
          ];
          throw new RestrictedDeleteError({
            nodeKind: kind,
            nodeId: id,
            edgeCount: connectedEdges.length,
            edgeKinds,
          });
        }

        case "cascade":
        case "disconnect": {
          // Both behaviors delete connected edges. "cascade" signals intent to
          // remove dependent data; "disconnect" signals intent to sever the
          // relationship. The effect is identical because edges cannot exist
          // without both endpoints.
          for (const edge of connectedEdges) {
            await backend.deleteEdge({
              graphId: ctx.graphId,
              id: edge.id,
            });
          }
          break;
        }
      }
    }

    await backend.deleteNode({
      graphId: ctx.graphId,
      kind,
      id,
    });

    // Delete uniqueness entries
    const uniquenessContext: UniquenessContext = {
      graphId: ctx.graphId,
      registry: ctx.registry,
      backend,
    };
    await deleteUniquenessEntries(
      uniquenessContext,
      kind,
      existingProps,
      registration.unique ?? [],
    );

    // Delete embeddings
    const nodeKind = registration.type;
    const embeddingSyncContext: EmbeddingSyncContext = {
      graphId: ctx.graphId,
      nodeKind: kind,
      nodeId: id,
      backend,
    };
    await deleteNodeEmbeddings(embeddingSyncContext, nodeKind.schema);
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
    // Validate kind exists and get registration
    const registration = getNodeRegistration(ctx.graph, kind);

    // Check if node exists (we don't care about deleted_at for hard delete)
    const existing = await backend.getNode(ctx.graphId, kind, id);
    if (!existing) {
      // Node doesn't exist - nothing to do
      return;
    }

    // Check delete behavior for connected edges
    const deleteBehavior = registration.onDelete ?? "restrict";
    const connectedEdges = await backend.findEdgesConnectedTo({
      graphId: ctx.graphId,
      nodeKind: kind,
      nodeId: id,
    });

    if (connectedEdges.length > 0) {
      switch (deleteBehavior) {
        case "restrict": {
          // Block deletion if edges exist
          const edgeKinds = [
            ...new Set(connectedEdges.map((edge) => edge.kind)),
          ];
          throw new RestrictedDeleteError({
            nodeKind: kind,
            nodeId: id,
            edgeCount: connectedEdges.length,
            edgeKinds,
          });
        }

        case "cascade":
        case "disconnect": {
          // Both behaviors hard-delete connected edges. See soft-delete
          // counterpart for rationale.
          for (const edge of connectedEdges) {
            await backend.hardDeleteEdge({
              graphId: ctx.graphId,
              id: edge.id,
            });
          }
          break;
        }
      }
    }

    // Hard delete the node (backend handles uniqueness entries and embeddings).
    // The cascade (uniques, embeddings, edges, node) is not individually atomic,
    // so wrap in a transaction when the backend supports it.
    const hardDelete = async (
      target: GraphBackend | TransactionBackend,
    ): Promise<void> => {
      await target.hardDeleteNode({
        graphId: ctx.graphId,
        kind,
        id,
      });
    };

    await ("transaction" in backend && backend.capabilities.transactions ?
      backend.transaction(async (tx) => hardDelete(tx))
    : hardDelete(backend));
  });
}
