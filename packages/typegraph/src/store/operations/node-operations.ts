/**
 * Node Operations for Store
 *
 * Handles node CRUD operations: create, update, delete.
 */
import { type SQL, sql } from "drizzle-orm";

import {
  createBackendOverlay,
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
import {
  type KindEntity,
  type NodeType,
  type UniqueConstraint,
} from "../../core/types";
import {
  ConfigurationError,
  DatabaseOperationError,
  KindNotFoundError,
  NodeConstraintNotFoundError,
  NodeIndexNotFoundError,
  NodeNotFoundError,
  ValidationError,
} from "../../errors";
import { validateNodeProps } from "../../errors/validation";
import {
  compileIndexWhere,
  compileNodeIndexFieldKeys,
  type IndexCompilationContext,
} from "../../indexes/compiler";
import { type NodeIndexDeclaration } from "../../indexes/types";
import { type ValueType } from "../../query/ast";
import {
  createSqlSchema,
  DEFAULT_SQL_SCHEMA,
} from "../../query/compiler/schema";
import { getDialect } from "../../query/dialect";
import { type DialectAdapter } from "../../query/dialect/types";
import { type JsonPointer, resolveJsonPointer } from "../../query/json-pointer";
import { asCompiledRowsSql } from "../../query/sql-intent";
import { type KindRegistry } from "../../registry/kind-registry";
import { validateOptionalCanonicalIsoDate } from "../../utils/date";
import { generateId } from "../../utils/id";
import {
  checkDisjointnessConstraint,
  type ConstraintContext,
} from "../constraints";
import {
  nodeInsertDispatch,
  runInsertBatch,
  runInsertBatchReturning,
  runInsertNoReturn,
} from "../insert-dispatch";
import { getNodeRowsByIds } from "../node-fetch";
import { rowToNode } from "../row-mappers";
import {
  type CreateNodeInput,
  type GetOrCreateAction,
  type Node,
  type NodeBulkFindByIndexOptions,
  type NodeGetOrCreateByConstraintOptions,
  type OperationHookContext,
  type UpdateNodeInput,
} from "../types";
import {
  checkUniquenessConstraints,
  type UniquenessContext,
} from "../uniqueness";
import {
  applyNodeHardDelete,
  applyNodeInsertSideEffects,
  applyNodeSoftDelete,
  applyNodeUpdate,
} from "./node-write-pipeline";
import { runInWriteTransaction } from "./write-transaction";

// ============================================================
// Types
// ============================================================

export type NodeOperationContext<G extends GraphDef> = Readonly<{
  graph: G;
  graphId: string;
  historyEnabled: boolean;
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

  const validationBackend = createBackendOverlay(backend, {
    getNode: getNodeCached,
    checkUnique: checkUniqueCached,
  } satisfies Partial<GraphBackend | TransactionBackend>);

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

  const validFrom = validateOptionalCanonicalIsoDate(
    input.validFrom,
    "validFrom",
  );
  const validTo = validateOptionalCanonicalIsoDate(input.validTo, "validTo");

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
  await applyNodeInsertSideEffects(
    { graphId: ctx.graphId, registry: ctx.registry },
    {
      kind: prepared.kind,
      id: prepared.id,
      schema: prepared.nodeKind.schema,
      props: prepared.validatedProps,
      uniqueConstraints: prepared.uniqueConstraints,
    },
    backend,
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

  const validTo = validateOptionalCanonicalIsoDate(input.validTo, "validTo");

  const row = await applyNodeUpdate(
    { graphId: ctx.graphId, registry: ctx.registry },
    {
      kind,
      id,
      schema: nodeKind.schema,
      existingProps,
      validatedProps,
      uniqueConstraints: registration.unique ?? [],
      ...(validTo !== undefined && { validTo }),
      ...(options?.clearDeleted && { clearDeleted: true }),
    },
    backend,
  );

  return rowToNode(row);
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

  return ctx.withOperationHooks(opContext, () =>
    runInWriteTransaction(ctx, backend, async (target) => {
      const prepared = await validateAndPrepareNodeCreate(
        ctx,
        input,
        id,
        target,
      );

      let row: BackendNodeRow | undefined;
      if (shouldReturnRow) {
        row = await target.insertNode(prepared.insertParams);
      } else {
        await runInsertNoReturn(
          nodeInsertDispatch(target),
          prepared.insertParams,
        );
      }

      await finalizeNodeCreate(ctx, prepared, target);

      if (row === undefined) return;
      return rowToNode(row);
    }),
  );
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

  await runInWriteTransaction(ctx, backend, async (target) => {
    const { preparedCreates, batchInsertParams } = await prepareBatchCreates(
      ctx,
      inputs,
      target,
    );

    await runInsertBatch(nodeInsertDispatch(target), batchInsertParams);

    for (const prepared of preparedCreates) {
      await finalizeNodeCreate(ctx, prepared, target);
    }
  });
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

  return runInWriteTransaction(ctx, backend, async (target) => {
    const { preparedCreates, batchInsertParams } = await prepareBatchCreates(
      ctx,
      inputs,
      target,
    );

    const rows = await runInsertBatchReturning(
      nodeInsertDispatch(target),
      batchInsertParams,
    );

    for (const prepared of preparedCreates) {
      await finalizeNodeCreate(ctx, prepared, target);
    }

    return rows.map((row) => rowToNode(row));
  });
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
    runInWriteTransaction(ctx, backend, (target) =>
      performNodeUpdate(ctx, input, target, options),
    ),
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
  return runInWriteTransaction(ctx, backend, (target) =>
    performNodeUpdate(ctx, input, target, options),
  );
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

  return ctx.withOperationHooks(opContext, () =>
    runInWriteTransaction(ctx, backend, async (target) => {
      const registration = getNodeRegistration(ctx.graph, kind);
      const preflight = await target.getNode(ctx.graphId, kind, id);
      if (!preflight || preflight.deleted_at) return;

      // The cascade (connected edges, uniques, embeddings, fulltext, node) is
      // not individually atomic, so it runs in one write transaction. Under
      // recorded-time capture this also collapses the cascade into a single
      // recorded commit instant instead of one instant per sub-write.
      const existingProps = JSON.parse(preflight.props) as Record<
        string,
        unknown
      >;

      await applyNodeSoftDelete(
        { graphId: ctx.graphId, registry: ctx.registry },
        {
          kind,
          id,
          schema: registration.type.schema,
          existingProps,
          uniqueConstraints: registration.unique ?? [],
          onDelete: registration.onDelete,
        },
        target,
      );
    }),
  );
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

  return ctx.withOperationHooks(opContext, () =>
    runInWriteTransaction(ctx, backend, async (target) => {
      const registration = getNodeRegistration(ctx.graph, kind);
      const preflight = await target.getNode(ctx.graphId, kind, id);
      if (!preflight) return;

      // The cascade (edges, node, embeddings) is not individually atomic, so it
      // runs in one write transaction. Embeddings live in strategy-owned
      // per-`(kind, field)` tables, so they are cleaned up here rather than in
      // the backend's graph-agnostic `hardDeleteNode` cascade.
      await applyNodeHardDelete(
        { graphId: ctx.graphId, registry: ctx.registry },
        {
          kind,
          id,
          schema: registration.type.schema,
          onDelete: registration.onDelete,
        },
        target,
      );
    }),
  );
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
// Bulk Find-By-Index
// ============================================================

/**
 * Resolves a declared node index by name, validating the kind first.
 *
 * @throws {KindNotFoundError} when the node kind is not registered
 * @throws {NodeIndexNotFoundError} when no node index of that name exists
 */
function resolveNodeIndex<G extends GraphDef>(
  graph: G,
  kind: string,
  indexName: string,
): NodeIndexDeclaration {
  getNodeRegistration(graph, kind);

  const declaration = graph.indexes?.find(
    (candidate) =>
      candidate.entity === "node" &&
      candidate.kind === kind &&
      candidate.name === indexName,
  );

  if (declaration?.entity !== "node") {
    throw new NodeIndexNotFoundError(indexName, kind);
  }

  return declaration;
}

const INDEX_PROBE_EXPECTED_TYPEOF: Partial<Record<ValueType, string>> = {
  string: "string",
  number: "number",
  boolean: "boolean",
};

/**
 * Validates a single probe value against its declared index-field type.
 * Missing/null values are valid (null probes); only a present, scalar
 * value of the wrong type is rejected.
 */
function validateIndexProbeValue(
  value: unknown,
  valueType: ValueType | undefined,
  pointer: JsonPointer,
  kind: string,
): void {
  if (value === undefined || value === null) return;

  // Index keys are scalar; a non-scalar probe can't be bound and must fail
  // with a typed error rather than a cryptic driver bind error downstream.
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean" &&
    !(value instanceof Date)
  ) {
    throw indexProbeTypeError(
      pointer,
      kind,
      "a scalar (string, number, boolean, or Date)",
      value,
    );
  }

  if (valueType === "date") {
    if (value instanceof Date || typeof value === "string") return;
    throw indexProbeTypeError(
      pointer,
      kind,
      "date (Date or ISO string)",
      value,
    );
  }

  const expected = INDEX_PROBE_EXPECTED_TYPEOF[valueType ?? "unknown"];
  if (expected === undefined) return;
  if (typeof value !== expected) {
    throw indexProbeTypeError(pointer, kind, expected, value);
  }
}

function indexProbeTypeError(
  pointer: JsonPointer,
  kind: string,
  expected: string,
  value: unknown,
): ValidationError {
  return new ValidationError(
    `Index probe value for "${pointer}" on node kind "${kind}" has an incompatible type`,
    {
      entityType: "node",
      kind,
      issues: [
        {
          path: pointer,
          message: `Expected ${expected}, received ${typeof value}`,
          code: "invalid_type",
        },
      ],
    },
  );
}

/** Coerces a non-null probe value into a driver-bindable scalar. */
function coerceIndexProbeBind(
  value: unknown,
  adapter: DialectAdapter,
): unknown {
  return adapter.bindValue(normalizeProbeScalar(value as ProbeScalar));
}

type ProbeScalar = string | number | boolean | Date;

/**
 * Canonical scalar form of a validated probe value, shared by the dedup key
 * and the bound SQL value so the two can never drift (a Date and its ISO
 * string normalize identically — and produce identical predicates).
 */
function normalizeProbeScalar(value: ProbeScalar): string | number | boolean {
  return value instanceof Date ? value.toISOString() : value;
}

const PROBE_NULL_TAG = 0;
const PROBE_VALUE_TAG = 1;

/**
 * Stable dedup key for a probe tuple. Each slot is tagged so a null/undefined
 * value can never collide with a string that happens to equal a sentinel -
 * null maps to [0], a present scalar to [1, normalized].
 */
function canonicalIndexProbeKey(probe: readonly unknown[]): string {
  return JSON.stringify(
    probe.map((value) =>
      value === undefined || value === null ?
        [PROBE_NULL_TAG]
      : [PROBE_VALUE_TAG, normalizeProbeScalar(value as ProbeScalar)],
    ),
  );
}

/**
 * Batched candidate retrieval against a declared node index.
 *
 * Emits a single query against the nodes table: each input's indexed-field
 * values become a probe predicate (null-safe equality, reusing the index's
 * own extraction expressions so the planner can use the physical index), and
 * a `CASE` selector tags each matched row with the deduped probe group it
 * satisfies. Rows are grouped back to input positions in order; each input's
 * candidate set is ordered by node id.
 */
export async function executeNodeBulkFindByIndex<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  indexName: string,
  items: readonly Readonly<{ props: Record<string, unknown> }>[],
  backend: GraphBackend | TransactionBackend,
  options?: NodeBulkFindByIndexOptions,
): Promise<Node[][]> {
  if (items.length === 0) return [];

  const index = resolveNodeIndex(ctx.graph, kind, indexName);

  // Date-typed lookup keys can't satisfy the cross-backend parity guarantee:
  // SQLite compares stored ISO text byte-wise while Postgres compares
  // timestamptz instants, so equal instants in different ISO forms diverge.
  // Declare the gap rather than return backend-dependent results.
  if (index.fieldValueTypes.includes("date")) {
    throw new ConfigurationError(
      `bulkFindByIndex does not support date-typed key fields on index "${indexName}" (node kind "${kind}")`,
      { indexName, kind },
      {
        suggestion:
          "Date index keys compare differently across SQLite and PostgreSQL. Use a string-encoded key field, or query date predicates via store.query(...).where(...).",
      },
    );
  }

  const limitPerInput = options?.limitPerInput;
  if (
    limitPerInput !== undefined &&
    (!Number.isInteger(limitPerInput) || limitPerInput <= 0)
  ) {
    throw new ValidationError(
      "bulkFindByIndex limitPerInput must be a positive integer",
      {
        entityType: "node",
        kind,
        issues: [
          {
            path: "limitPerInput",
            message: `Expected a positive integer, received ${String(limitPerInput)}`,
            code: "invalid_value",
          },
        ],
      },
    );
  }

  const adapter = getDialect(backend.dialect);

  // 1. Extract + validate each input's indexed-field probe tuple.
  const probes: unknown[][] = items.map((item) =>
    index.fields.map((pointer, position) => {
      const value = resolveJsonPointer(item.props, pointer);
      validateIndexProbeValue(
        value,
        index.fieldValueTypes[position],
        pointer,
        kind,
      );
      return value;
    }),
  );

  // 2. Dedupe probe tuples; map each distinct tuple to its input positions.
  const groupByKey = new Map<string, number>();
  const groupProbes: unknown[][] = [];
  const groupToInputs: number[][] = [];
  for (const [inputIndex, probe] of probes.entries()) {
    const key = canonicalIndexProbeKey(probe);
    const existing = groupByKey.get(key);
    if (existing === undefined) {
      groupByKey.set(key, groupProbes.length);
      groupProbes.push(probe);
      groupToInputs.push([inputIndex]);
      continue;
    }
    groupToInputs[existing]?.push(inputIndex);
  }

  // 3. Build probe predicates shared by the CASE selector and WHERE filter.
  const schema =
    backend.tableNames ?
      createSqlSchema(backend.tableNames)
    : DEFAULT_SQL_SCHEMA;
  const compileContext: IndexCompilationContext = {
    dialect: backend.dialect,
    propsColumn: sql.raw(`"props"`),
    systemColumn: (column) => sql.raw(`"${column}"`),
  };
  const fieldKeys = compileNodeIndexFieldKeys(index, compileContext);

  const groupPredicates = groupProbes.map(
    (probe) =>
      sql`(${sql.join(
        fieldKeys.map((fieldKey, position) => {
          const value = probe[position];
          if (value === undefined || value === null) {
            return sql`${fieldKey} IS NULL`;
          }
          return adapter.nullSafeEquals(
            fieldKey,
            sql`${coerceIndexProbeBind(value, adapter)}`,
          );
        }),
        sql` AND `,
      )})`,
  );

  const caseBranches = groupPredicates.map(
    (predicate, group) => sql`WHEN ${predicate} THEN ${sql.raw(String(group))}`,
  );
  const probeIndexExpr = sql`CASE ${sql.join(caseBranches, sql` `)} ELSE NULL END`;

  const conditions: SQL[] = [
    sql`"graph_id" = ${ctx.graphId}`,
    sql`"kind" = ${kind}`,
    sql`"deleted_at" IS NULL`,
  ];
  if (index.where !== undefined) {
    conditions.push(compileIndexWhere(compileContext, index.where));
  }
  conditions.push(sql`(${sql.join(groupPredicates, sql` OR `)})`);
  const whereClause = sql.join(conditions, sql` AND `);

  // The probe matching runs against the nodes table; rows are hydrated
  // separately via the backend's normalized node reads so the returned
  // shape is identical to every other node API (props/timestamp
  // normalization is backend-owned, not re-derived from raw driver rows).
  const probedSelect = sql`SELECT "id", ${probeIndexExpr} AS probe_idx FROM ${schema.nodesTable} WHERE ${whereClause}`;

  // limitPerInput caps each input's candidates per probe group. When the
  // backend supports window functions we cap in SQL (`ROW_NUMBER()`), which
  // also avoids transferring excess ids on low-selectivity keys. Otherwise we
  // degrade gracefully: fetch all matching ids and cap per group in JS before
  // hydration — the cap stays correct, only the id transfer is unbounded.
  const capInSql =
    limitPerInput !== undefined && backend.capabilities.windowFunctions;

  const query =
    capInSql ?
      sql`SELECT "id", probe_idx FROM (SELECT "id", probe_idx, ROW_NUMBER() OVER (PARTITION BY probe_idx ORDER BY "id") AS probe_rank FROM (${probedSelect}) AS probed) AS ranked WHERE probe_rank <= ${limitPerInput} ORDER BY probe_idx, "id"`
    : sql`${probedSelect} ORDER BY probe_idx, "id"`;

  // 4. Execute, hydrate matched nodes, and group back to input positions.
  const rawMatches = await backend.execute<ProbeMatch>(
    asCompiledRowsSql(query),
  );
  const matches =
    limitPerInput !== undefined && !capInSql ?
      capMatchesPerGroup(rawMatches, limitPerInput)
    : rawMatches;

  const nodesById = await hydrateNodesById(
    backend,
    ctx.graphId,
    kind,
    matches.map((match) => match.id),
  );

  const results: Node[][] = Array.from({ length: items.length }, () => []);
  for (const match of matches) {
    const node = nodesById.get(match.id);
    if (node === undefined) continue;
    const inputs = groupToInputs[match.probe_idx];
    if (inputs === undefined) continue;
    for (const inputIndex of inputs) {
      results[inputIndex]?.push(node);
    }
  }

  return results;
}

type ProbeMatch = Readonly<{ id: string; probe_idx: number }>;

/**
 * Caps matches to the first `limitPerInput` per probe group (the JS-side
 * equivalent of the `ROW_NUMBER()` window). Relies on `matches` already being
 * ordered by `(probe_idx, id)`, so the kept rows are the lowest ids per group.
 */
function capMatchesPerGroup(
  matches: readonly ProbeMatch[],
  limitPerInput: number,
): ProbeMatch[] {
  const perGroupCount = new Map<number, number>();
  const capped: ProbeMatch[] = [];
  for (const match of matches) {
    const count = perGroupCount.get(match.probe_idx) ?? 0;
    if (count >= limitPerInput) continue;
    perGroupCount.set(match.probe_idx, count + 1);
    capped.push(match);
  }
  return capped;
}

/** Hydrates live nodes by id via the backend's normalized node reads. */
async function hydrateNodesById(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  kind: string,
  ids: readonly string[],
): Promise<Map<string, Node>> {
  const rowsById = await getNodeRowsByIds(backend, graphId, kind, ids);
  const nodesById = new Map<string, Node>();
  for (const [id, row] of rowsById) {
    if (row.deleted_at !== undefined) continue;
    nodesById.set(id, rowToNode(row));
  }
  return nodesById;
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
