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
  isLiveNodeRow,
  type NodeRow as BackendNodeRow,
  rowPropsToObject,
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
  UniquenessError,
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
  type SqlSchema,
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
import { canonicalEqual } from "../../schema/canonical";
import { getNodeRowsByIds } from "../node-fetch";
import { type GraphWriteLock } from "../recorded-capture/clock";
import { type NodeRow, rowToNode } from "../row-mappers";
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
  createUniquenessContext,
} from "../uniqueness";
import {
  applyNodeHardDelete,
  applyNodeInsertSideEffects,
  applyNodeInsertSideEffectsBatch,
  applyNodeSoftDelete,
  applyNodeUpdate,
  createNodeWriteContext,
} from "./node-write-pipeline";
import {
  runHookedWriteOperation,
  runInWriteTransaction,
} from "./write-transaction";

// ============================================================
// Types
// ============================================================

export type NodeOperationContext<G extends GraphDef> = Readonly<{
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

// ============================================================
// Batch Validation Cache
//
// During batch operations, multiple items may reference the same
// nodes/unique keys. This cache avoids redundant backend lookups
// and tracks pending (not-yet-flushed) inserts so that later items
// in the batch can see earlier ones during validation.
// ============================================================

export function createNodeBatchValidationBackend(
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
  registerAppliedNodeUpdate: (
    kind: string,
    id: string,
    oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
    constraints: readonly UniqueConstraint[],
  ) => void;
  seedNodeRow: (kind: string, id: string, row: CachedNodeRow) => void;
  seedUniqueRow: (
    kind: string,
    constraintName: string,
    key: string,
    row: CachedUniqueRow,
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
      // The simulated cached row only needs a NodeRow-shaped valid_from
      // (string | undefined, never null) for existence/uniqueness checks,
      // which don't inspect its value — normalize import's explicit-NULL
      // sentinel away rather than widen this cache's row shape.
      valid_from: params.validFrom ?? undefined,
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

  // Reflects a completed in-slice node update in the uniqueness caches so a
  // later row's pre-check sees the post-update reservation state — the state
  // the sequential path's per-row backend read would observe. The batch path
  // primes the caches ONCE before routing, but an in-slice update mutates the
  // real backend's uniqueness rows directly; without reconciling here a later
  // create either (a) claims a value this update just freed yet gets rejected
  // against the stale reservation, or (b) passes the stale "free" cache for a
  // value this update just took and then violates the real constraint at
  // flush, aborting the whole import. Mirrors updateUniquenessEntries' key
  // diff: for each constraint whose key changed, the released old key becomes
  // free and the reserved new key becomes owned by this node, across every
  // kind the constraint's scope checks.
  function registerAppliedNodeUpdate(
    kind: string,
    id: string,
    oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
    constraints: readonly UniqueConstraint[],
  ): void {
    for (const constraint of constraints) {
      const oldApplies = checkWherePredicate(constraint, oldProps);
      const newApplies = checkWherePredicate(constraint, newProps);
      const oldKey =
        oldApplies ?
          computeUniqueKey(oldProps, constraint.fields, constraint.collation)
        : undefined;
      const newKey =
        newApplies ?
          computeUniqueKey(newProps, constraint.fields, constraint.collation)
        : undefined;
      if (oldKey === newKey) continue;

      const kindsToCheck = getKindsForUniquenessCheck(
        kind,
        constraint.scope,
        registry,
      );

      if (oldKey !== undefined) {
        for (const kindToCheck of kindsToCheck) {
          const cacheKey = buildUniqueCacheKey(
            graphId,
            kindToCheck,
            constraint.name,
            oldKey,
          );
          // This node released the key on the real backend, so it is now
          // free. Clear any pending reservation and record the known-free
          // state (overwriting a stale seeded owner) so a later create's
          // pre-check sees a vacancy instead of a redundant backend read.
          pendingUniqueOwners.delete(cacheKey);
          uniqueCache.set(cacheKey, undefined);
        }
      }
      if (newKey !== undefined) {
        for (const kindToCheck of kindsToCheck) {
          const cacheKey = buildUniqueCacheKey(
            graphId,
            kindToCheck,
            constraint.name,
            newKey,
          );
          // This node now holds the key on the real backend. A pending owner
          // shadows the seeded uniqueCache entry (checkUniqueCached consults
          // it first), matching registerPendingUniqueEntries' reservation.
          pendingUniqueOwners.set(cacheKey, id);
        }
      }
    }
  }

  // Seed functions let batch preparation prime the caches from one
  // getNodes / checkUniqueBatch round trip instead of a per-row probe.
  // Seeding an absent result (`undefined`) is meaningful — it marks the
  // key as known-missing so the per-row check skips the backend read.
  // Existing entries are never overwritten: a pending registration or an
  // earlier lookup always wins.
  function seedNodeRow(kind: string, id: string, row: CachedNodeRow): void {
    const cacheKey = buildNodeCacheKey(graphId, kind, id);
    if (nodeCache.has(cacheKey)) return;
    nodeCache.set(cacheKey, row);
  }

  function seedUniqueRow(
    kind: string,
    constraintName: string,
    key: string,
    row: CachedUniqueRow,
  ): void {
    const cacheKey = buildUniqueCacheKey(graphId, kind, constraintName, key);
    if (uniqueCache.has(cacheKey)) return;
    uniqueCache.set(cacheKey, row);
  }

  const validationBackend = createBackendOverlay(backend, {
    getNode: getNodeCached,
    checkUnique: checkUniqueCached,
  } satisfies Partial<GraphBackend | TransactionBackend>);

  return {
    backend: validationBackend,
    registerPendingNode,
    registerPendingUniqueEntries,
    registerAppliedNodeUpdate,
    seedNodeRow,
    seedUniqueRow,
  };
}

// ============================================================
// Shared Create Pipeline
// ============================================================

/**
 * The synchronous half of create preparation: kind resolution, Zod
 * validation, and date validation. Produces everything the async
 * constraint checks need, so batch preparation can validate every input
 * first and then prime the validation caches with batched reads before
 * running {@link finishNodeCreatePreparation} per row.
 */
/**
 * Internal create options threaded from operations that validated props
 * BEFORE calling into the create path. Never exposed on the public store
 * surface.
 */
type NodeCreateInternalOptions = Readonly<{
  /** `input.props` is already the output of `validateNodeProps`. */
  propsPreValidated?: boolean;
}>;

export type NodeCreateDraft = Readonly<{
  kind: string;
  id: string;
  nodeKind: NodeType;
  uniqueConstraints: readonly UniqueConstraint[];
  validatedProps: Record<string, unknown>;
  validFrom: string | undefined;
  validTo: string | undefined;
}>;

function draftNodeCreate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: CreateNodeInput,
  id: string,
  options?: NodeCreateInternalOptions,
): NodeCreateDraft {
  const kind = input.kind;
  const registration = getNodeRegistration(ctx.graph, kind);
  const nodeKind = registration.type;

  // getOrCreate / findByConstraint variants validate props up front (the
  // key computation needs the PARSED shape), then hand the validated
  // object here — re-running the full Zod parse on it would double the
  // validation cost of every create leg for no additional safety (hooks
  // wrap the transaction and cannot transform inputs in between).
  const validatedProps =
    options?.propsPreValidated === true ?
      input.props
    : validateNodeProps(nodeKind.schema, input.props, {
        kind,
        operation: "create",
      });

  return {
    kind,
    id,
    nodeKind,
    uniqueConstraints: registration.unique ?? [],
    validatedProps,
    validFrom: validateOptionalCanonicalIsoDate(input.validFrom, "validFrom"),
    validTo: validateOptionalCanonicalIsoDate(input.validTo, "validTo"),
  };
}

/** The async half: existence, disjointness, and uniqueness checks. */
async function finishNodeCreatePreparation<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  draft: NodeCreateDraft,
  backend: GraphBackend | TransactionBackend,
): Promise<NodeCreatePrepared> {
  const { kind, id, validatedProps, uniqueConstraints } = draft;

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
    nodeKind: draft.nodeKind,
    validatedProps,
    uniqueConstraints,
    insertParams: buildInsertNodeParams(
      ctx.graphId,
      kind,
      id,
      validatedProps,
      draft.validFrom,
      draft.validTo,
    ),
  };
}

async function validateAndPrepareNodeCreate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: CreateNodeInput,
  id: string,
  backend: GraphBackend | TransactionBackend,
  options?: NodeCreateInternalOptions,
): Promise<NodeCreatePrepared> {
  return finishNodeCreatePreparation(
    ctx,
    draftNodeCreate(ctx, input, id, options),
    backend,
  );
}

/**
 * Batched {@link finalizeNodeCreate}: applies every prepared create's
 * side effects through the batch pipeline (one uniqueness batch, one
 * fulltext/embedding batch per kind) instead of a per-row statement fan.
 */
async function finalizeNodeCreateBatch<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  preparedCreates: readonly NodeCreatePrepared[],
  backend: GraphBackend | TransactionBackend,
  lock: GraphWriteLock,
): Promise<void> {
  await applyNodeInsertSideEffectsBatch(
    createNodeWriteContext(ctx.graphId, ctx.registry, lock),
    preparedCreates.map((prepared) => ({
      kind: prepared.kind,
      id: prepared.id,
      schema: prepared.nodeKind.schema,
      props: prepared.validatedProps,
      uniqueConstraints: prepared.uniqueConstraints,
    })),
    backend,
  );
}

async function finalizeNodeCreate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  prepared: NodeCreatePrepared,
  backend: GraphBackend | TransactionBackend,
  lock: GraphWriteLock,
): Promise<void> {
  await applyNodeInsertSideEffects(
    createNodeWriteContext(ctx.graphId, ctx.registry, lock),
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

/**
 * The exact props an update would persist: the live row's stored props with
 * the caller's partial input merged over them, run through the kind's Zod
 * schema (defaults applied, values normalized). Shared by
 * {@link performNodeUpdate} and {@link isNodeUpsertUnchanged} so the coalesce
 * dirty-check and the write it guards can never disagree on "what would be
 * written".
 */
function resolveNodeUpdateProps<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  id: string,
  existing: Pick<NodeRow, "props">,
  inputProps: Partial<Record<string, unknown>>,
): Readonly<{
  existingProps: Record<string, unknown>;
  validatedProps: Record<string, unknown>;
}> {
  const registration = getNodeRegistration(ctx.graph, kind);
  const existingProps = rowPropsToObject(existing.props);
  const mergedProps = { ...existingProps, ...inputProps };
  const validatedProps = validateNodeProps(
    registration.type.schema,
    mergedProps,
    { kind, operation: "update", id },
  );
  return { existingProps, validatedProps };
}

/**
 * Whether an `upsertById` of `inputProps` onto the given live row would leave
 * the stored value unchanged — the coalesce dirty-check. Compares on the
 * storage-normalized representation (validated, key-order-independent), so it
 * answers exactly "would the persisted JSON differ?".
 *
 * Callers are responsible for the other coalescing preconditions (existing,
 * not soft-deleted, no explicit temporal override); this covers rule 4 only.
 */
export function isNodeUpsertUnchanged<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  existing: NodeRow,
  inputProps: Record<string, unknown>,
): boolean {
  const { existingProps, validatedProps } = resolveNodeUpdateProps(
    ctx,
    kind,
    existing.id,
    existing,
    inputProps,
  );
  return canonicalEqual(validatedProps, existingProps);
}

async function performNodeUpdate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: UpdateNodeInput,
  backend: GraphBackend | TransactionBackend,
  lock: GraphWriteLock,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Node> {
  const { kind, id } = input;
  const registration = getNodeRegistration(ctx.graph, kind);

  const existing = await backend.getNode(ctx.graphId, kind, id);
  if (!existing) throw new NodeNotFoundError(kind, id);

  const { validatedProps } = resolveNodeUpdateProps(
    ctx,
    kind,
    id,
    existing,
    input.props,
  );
  const nodeKind = registration.type;

  const validTo = validateOptionalCanonicalIsoDate(input.validTo, "validTo");

  const writeContext = createNodeWriteContext(ctx.graphId, ctx.registry, lock);
  const shared = {
    schema: nodeKind.schema,
    validatedProps,
    uniqueConstraints: registration.unique ?? [],
    ...(validTo !== undefined && { validTo }),
  };

  // A resurrecting upsert (clearDeleted) may target a tombstoned row; a plain
  // update must prove the row live — see NodeUpdateTarget.
  if (options?.clearDeleted) {
    const row = await applyNodeUpdate(
      writeContext,
      { ...shared, existing, clearDeleted: true },
      backend,
    );
    return rowToNode(row);
  }

  if (!isLiveNodeRow(existing)) throw new NodeNotFoundError(kind, id);
  const row = await applyNodeUpdate(
    writeContext,
    { ...shared, existing },
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

/**
 * Primes the batch validation caches with batched reads: one `getNodes`
 * per kind for existence probes and one `checkUniqueBatch` per
 * (constraint, kind) for uniqueness pre-checks. The per-row checks in
 * {@link finishNodeCreatePreparation} then hit memory instead of issuing
 * one probe per row. Backends without the batch primitives skip priming
 * and keep the per-row fallback.
 */
export async function primeBatchValidationCaches(
  ctx: Readonly<{ graphId: string; registry: KindRegistry }>,
  drafts: readonly NodeCreateDraft[],
  backend: GraphBackend | TransactionBackend,
  seams: Readonly<{
    seedNodeRow: (kind: string, id: string, row: CachedNodeRow) => void;
    seedUniqueRow: (
      kind: string,
      constraintName: string,
      key: string,
      row: CachedUniqueRow,
    ) => void;
  }>,
): Promise<void> {
  if (backend.getNodes !== undefined) {
    const idsByKind = new Map<string, Set<string>>();
    for (const draft of drafts) {
      const ids = idsByKind.get(draft.kind) ?? new Set<string>();
      ids.add(draft.id);
      idsByKind.set(draft.kind, ids);
    }
    for (const [kind, ids] of idsByKind) {
      const orderedIds = [...ids];
      const rows = await backend.getNodes(ctx.graphId, kind, orderedIds);
      const rowsById = new Map(rows.map((row) => [row.id, row]));
      for (const id of orderedIds) {
        seams.seedNodeRow(kind, id, rowsById.get(id));
      }
    }
  }

  if (backend.checkUniqueBatch !== undefined) {
    interface ProbeGroup {
      nodeKind: string;
      constraintName: string;
      keys: Set<string>;
    }
    const groups = new Map<string, ProbeGroup>();
    for (const draft of drafts) {
      for (const constraint of draft.uniqueConstraints) {
        if (!checkWherePredicate(constraint, draft.validatedProps)) continue;
        const key = computeUniqueKey(
          draft.validatedProps,
          constraint.fields,
          constraint.collation,
        );
        const kindsToCheck = getKindsForUniquenessCheck(
          draft.kind,
          constraint.scope,
          ctx.registry,
        );
        for (const kindToCheck of kindsToCheck) {
          const groupKey = kindToCheck + CACHE_KEY_SEPARATOR + constraint.name;
          const group = groups.get(groupKey) ?? {
            nodeKind: kindToCheck,
            constraintName: constraint.name,
            keys: new Set<string>(),
          };
          group.keys.add(key);
          groups.set(groupKey, group);
        }
      }
    }
    for (const group of groups.values()) {
      const orderedKeys = [...group.keys];
      const rows = await backend.checkUniqueBatch({
        graphId: ctx.graphId,
        nodeKind: group.nodeKind,
        constraintName: group.constraintName,
        keys: orderedKeys,
      });
      const rowsByKey = new Map(rows.map((row) => [row.key, row]));
      for (const key of orderedKeys) {
        seams.seedUniqueRow(
          group.nodeKind,
          group.constraintName,
          key,
          rowsByKey.get(key),
        );
      }
    }
  }
}

async function prepareBatchCreates<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  inputs: readonly CreateNodeInput[],
  backend: GraphBackend | TransactionBackend,
  options?: NodeCreateInternalOptions,
): Promise<{
  preparedCreates: NodeCreatePrepared[];
  batchInsertParams: InsertNodeParams[];
}> {
  const {
    backend: validationBackend,
    registerPendingNode,
    registerPendingUniqueEntries,
    seedNodeRow,
    seedUniqueRow,
  } = createNodeBatchValidationBackend(ctx.graphId, ctx.registry, backend);

  // Pass 1 (synchronous): validate every input and assign ids. This
  // surfaces a later row's validation error before an earlier row's
  // constraint error — both fail the whole batch, so ordering across
  // error categories is not part of the contract.
  const drafts = inputs.map((input) =>
    draftNodeCreate(ctx, input, input.id ?? generateId(), options),
  );

  await primeBatchValidationCaches(ctx, drafts, backend, {
    seedNodeRow,
    seedUniqueRow,
  });

  // Pass 2: per-row constraint checks against the primed caches, in input
  // order, registering pendings so later rows see earlier ones.
  const preparedCreates: NodeCreatePrepared[] = [];
  for (const draft of drafts) {
    const prepared = await finishNodeCreatePreparation(
      ctx,
      draft,
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
  options?: Readonly<{ returnRow?: boolean }> & NodeCreateInternalOptions,
): Promise<Node | undefined> {
  const kind = input.kind;
  const id = input.id ?? generateId();
  const opContext = ctx.createOperationContext("create", "node", kind, id);
  const shouldReturnRow = options?.returnRow ?? true;

  return runHookedWriteOperation(
    ctx,
    opContext,
    backend,
    async (target, lock) => {
      const prepared = await validateAndPrepareNodeCreate(
        ctx,
        input,
        id,
        target,
        options,
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

      await finalizeNodeCreate(ctx, prepared, target, lock);

      if (row === undefined) return;
      return rowToNode(row);
    },
  );
}

export async function executeNodeCreate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: CreateNodeInput,
  backend: GraphBackend | TransactionBackend,
  options?: NodeCreateInternalOptions,
): Promise<Node> {
  const result = await executeNodeCreateInternal(ctx, input, backend, {
    returnRow: true,
    ...options,
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

  await runInWriteTransaction(ctx, backend, async (target, lock) => {
    const { preparedCreates, batchInsertParams } = await prepareBatchCreates(
      ctx,
      inputs,
      target,
    );

    await runInsertBatch(nodeInsertDispatch(target), batchInsertParams);

    await finalizeNodeCreateBatch(ctx, preparedCreates, target, lock);
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
  options?: NodeCreateInternalOptions,
): Promise<readonly Node[]> {
  if (inputs.length === 0) return [];

  return runInWriteTransaction(ctx, backend, async (target, lock) => {
    const { preparedCreates, batchInsertParams } = await prepareBatchCreates(
      ctx,
      inputs,
      target,
      options,
    );

    const rows = await runInsertBatchReturning(
      nodeInsertDispatch(target),
      batchInsertParams,
    );

    await finalizeNodeCreateBatch(ctx, preparedCreates, target, lock);

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
  return runHookedWriteOperation(ctx, opContext, backend, (target, lock) =>
    performNodeUpdate(ctx, input, target, lock, options),
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
  return runInWriteTransaction(ctx, backend, (target, lock) =>
    performNodeUpdate(ctx, input, target, lock, options),
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
  // Gate outside hooks and transaction (matching edge deletes): an absent or
  // already-tombstoned node is a no-op, so it neither fires hooks nor opens a
  // write transaction (empty transactions are costly on libsql). The cascade
  // re-reads inside the transaction, so a node concurrently deleted between
  // this gate and the write lock is still handled correctly.
  const gate = await backend.getNode(ctx.graphId, kind, id);
  if (!gate || gate.deleted_at) return;

  const opContext = ctx.createOperationContext("delete", "node", kind, id);

  return runHookedWriteOperation(
    ctx,
    opContext,
    backend,
    async (target, lock) => {
      const registration = getNodeRegistration(ctx.graph, kind);
      // This preflight is NOT removable round-trip fat: the soft-delete
      // pipeline consumes the pre-image (uniqueness entries are keyed by
      // props-derived constraint keys), and this in-transaction read is
      // the concurrency-correct source for it.
      const preflight = await target.getNode(ctx.graphId, kind, id);
      if (!preflight || !isLiveNodeRow(preflight)) return;

      // The cascade (connected edges, uniques, embeddings, fulltext, node) is
      // not individually atomic, so it runs in one write transaction. Under
      // recorded-time capture this also collapses the cascade into a single
      // recorded commit instant instead of one instant per sub-write.
      await applyNodeSoftDelete(
        createNodeWriteContext(ctx.graphId, ctx.registry, lock),
        {
          existing: preflight,
          schema: registration.type.schema,
          uniqueConstraints: registration.unique ?? [],
          onDelete: registration.onDelete,
        },
        target,
      );
    },
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
  // Gate outside hooks and transaction so an absent node neither fires hooks
  // nor opens an empty transaction (see executeNodeDelete). The cascade
  // re-reads inside the transaction.
  const gate = await backend.getNode(ctx.graphId, kind, id);
  if (!gate) return;

  const opContext = ctx.createOperationContext("delete", "node", kind, id);

  return runHookedWriteOperation(
    ctx,
    opContext,
    backend,
    async (target, lock) => {
      const registration = getNodeRegistration(ctx.graph, kind);
      // No in-transaction preflight (unlike soft delete, whose pipeline
      // consumes the pre-image for uniqueness-key cleanup): every hard
      // cascade member is id-keyed and idempotent — the delete-behavior
      // check re-reads edges itself, `hardDeleteNode` deletes by primary
      // key, and embeddings clean up by id — so a node concurrently
      // removed between the gate and the write lock makes each statement
      // a 0-row no-op.

      // The cascade (edges, node, embeddings) is not individually atomic, so
      // it runs in one write transaction. Embeddings live in strategy-owned
      // per-`(kind, field)` tables, so they are cleaned up here rather than
      // in the backend's graph-agnostic `hardDeleteNode` cascade.
      await applyNodeHardDelete(
        createNodeWriteContext(ctx.graphId, ctx.registry, lock),
        {
          kind,
          id,
          schema: registration.type.schema,
          onDelete: registration.onDelete,
        },
        target,
      );
    },
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
      { propsPreValidated: true },
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

  // The probe runs outside any transaction (the found path is a pure read),
  // and each write leg opens its own hooked transaction. A concurrent create
  // can therefore reserve the key between the probe and the create — that
  // surfaces as UniquenessError, and the caller retries the probe once to
  // converge on the row the winner created.
  async function attempt(): Promise<
    Readonly<{ node: Node; action: GetOrCreateAction }>
  > {
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
        { propsPreValidated: true },
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
        { propsPreValidated: true },
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

  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof UniquenessError)) throw error;
    return attempt();
  }
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

  // GIN-family indexes serve containment / substring predicates, not the
  // equality probes bulkFindByIndex compiles — targeting one here would
  // silently probe with the wrong extraction semantics.
  if (declaration.method !== undefined) {
    throw new ConfigurationError(
      `bulkFindByIndex cannot probe index "${indexName}" (method ` +
        `"${declaration.method}"): only btree indexes serve equality probes.`,
      { indexName, kind, method: declaration.method },
    );
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

  if (index.fields.length === 0) {
    throw new ConfigurationError(
      `bulkFindByIndex requires an index with at least one prop-based field on index "${indexName}" (node kind "${kind}")`,
      { indexName, kind },
      {
        suggestion:
          "bulkFindByIndex probes by prop values from each item; an index declared with only keySystemColumns/coveringFields (no fields) has nothing to probe by.",
      },
    );
  }

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
      { propsPreValidated: true },
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
        { propsPreValidated: true },
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
