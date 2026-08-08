/**
 * Node Operations for Store
 *
 * Handles node CRUD operations: create, update, delete.
 *
 * ## A write asserts every component its verdict READ
 *
 * `performNodeUpdate` is a probe-and-write pair: it reads the row, decides from
 * what it finds, and then writes. Under PostgreSQL READ COMMITTED a concurrent
 * `hardDelete` + recreate re-resolves `(graph_id, kind, id)` between the two,
 * so anything the decision consumed and the statement does not restate is a
 * decision that can land on a row it was never computed for — and the write
 * reports success. Every value read off the probed row, and where it is
 * asserted:
 *
 *  - `kind` / `id` — the write key itself, restated in every UPDATE's `WHERE`.
 *  - `deleted_at` (which leg runs, and whether to sample a resurrection
 *    instant) — asserted as `deleted_at IS NULL` on the in-place leg and
 *    `IS NOT NULL` on the resurrecting one, so each leg can only hit a row in
 *    the state it was chosen for.
 *  - `valid_from` — asserted via `UpdateNodeParams.expectedValidFrom` WHEN the
 *    window verdict read it ({@link ValidityWindowVerdict}): the caller stated
 *    a `validFrom` to compare against the row's, or a lone `validTo` to invert
 *    against it. A plain `update({ props })` states no window, so the verdict
 *    is independent of the row's bound and the write carries no predicate for
 *    it — the same "only what it asserted" rule the edge identity components
 *    follow, and for the same reason: inventing a predicate for a component the
 *    caller made no claim about refuses writes that are legitimate. A
 *    resurrection is judged against the write instant rather than the row's
 *    bound, so it asserts none either; its own tombstone predicate fences it.
 *  - `props` — read twice, as the merge base for the caller's partial update
 *    and as the `oldProps` side of the uniqueness diff — and NOT assertable: a
 *    props blob is TEXT on SQLite and `jsonb` on PostgreSQL, and neither
 *    comparison is stable under key reordering. Bounded instead, two ways: the
 *    sidecar writes are gated on the primary UPDATE's rowcount (see
 *    `applyNodeUpdate`), and
 *    {@link performNodeUpdateWithResurrectionRecovery} re-reads and re-merges
 *    whenever a predicate catches a replaced row.
 *  - the uniques-table row behind `getOrCreateByConstraint` — read to resolve
 *    WHICH node the key names. Not assertable by the node UPDATE (it is a
 *    different table); bounded by the constraint write fence, which makes the
 *    probe and the write it authorizes commit under one per-graph mutual
 *    exclusion. Its `deleted_at`, however, is NOT the owner of "does this write
 *    resurrect" — both the single and bulk paths read that from the node row
 *    they are about to write, because one decision with two owners drifts.
 */
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
import { assertJsonValue } from "../../core/json-value";
import {
  type JsonValue,
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
import { refKey } from "../../identity/service";
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
import { sql, type SqlFragment } from "../../query/sql-fragment";
import type { CompiledSelectSql } from "../../query/sql-intent";
import { asCompiledRowsSql } from "../../query/sql-intent";
import { type KindRegistry } from "../../registry/kind-registry";
import { canonicalEqual } from "../../schema/canonical";
import {
  assertOrderedValidityWindow,
  assertWritableValidityWindow,
  nowIso,
  validateOptionalCanonicalIsoDate,
} from "../../utils/date";
import { generateId } from "../../utils/id";
import { createDataKeyedBag, hasOwnKey } from "../../utils/object";
import { requireDefined } from "../../utils/presence";
import { encodeTupleKey } from "../../utils/tuple-key";
import { type UpsertDirtyCheck } from "../collections/coalesce";
import { type UpsertUpdateNodeInput } from "../collections/node-collection";
import {
  checkDisjointnessConstraint,
  type ConstraintContext,
  type ConstraintFenceReason,
  nodeWriteNeedsConstraintFence,
} from "../constraints";
import { getEmbeddingFields } from "../embedding-sync";
import { getSearchableFields } from "../fulltext-sync";
import {
  nodeInsertDispatch,
  runInsertBatch,
  runInsertBatchReturning,
  runInsertNoReturn,
} from "../insert-dispatch";
import { getNodeRowsByIds } from "../node-fetch";
import { type GraphWriteLock } from "../recorded-capture/clock";
import { type NodeRow, rowToNode } from "../row-mappers";
import {
  type BulkOperationHookContext,
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
  createAlreadyExistsError,
  withAlreadyExistsTranslation,
} from "./already-exists";
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
  schemaVersion: number | undefined;
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
  createBulkOperationContext: (
    operation: "updateWhere",
    kind: string,
  ) => BulkOperationHookContext;
  withBulkOperationHooks: <T extends Readonly<{ affectedCount: number }>>(
    ctx: BulkOperationHookContext,
    fn: () => Promise<T>,
  ) => Promise<T>;
  identity?: Readonly<{
    lock: (target: GraphBackend | TransactionBackend) => Promise<void>;
    foldCreated: (
      target: GraphBackend | TransactionBackend,
      references: readonly Readonly<{ kind: string; id: string }>[],
    ) => Promise<void>;
    detachDeleted: (
      target: GraphBackend | TransactionBackend,
      ref: Readonly<{ kind: string; id: string }>,
      mode: "soft" | "hard",
    ) => Promise<void>;
  }>;
}>;

type NodeCreatePrepared = Readonly<{
  kind: string;
  id: string;
  nodeKind: NodeType;
  validatedProps: Record<string, unknown>;
  uniqueConstraints: readonly UniqueConstraint[];
  insertParams: InsertNodeParams;
  /**
   * `true` when the caller supplied `input.id`. A generated id cannot
   * already exist under another kind, so identity folding can skip its
   * cross-kind probe entirely for those rows.
   */
  idProvided: boolean;
  /**
   * The soft-deleted row occupying this id, or `undefined` when the id is
   * free. Named for what it can hold rather than what it was read as: the
   * duplicate-existence probe in {@link finishNodeCreatePreparation} throws
   * on a LIVE row, so what survives is always a tombstone awaiting
   * resurrection. Carrying it here is what lets the create path route
   * insert-vs-resurrect without re-reading the same (graph, kind, id).
   */
  tombstone: BackendNodeRow | undefined;
}>;

type CachedNodeRow = Awaited<ReturnType<GraphBackend["getNode"]>>;
type CachedUniqueRow = Awaited<ReturnType<GraphBackend["checkUnique"]>>;

// ============================================================
// Helper Functions
// ============================================================

// Own-key membership, matching `store.getNodePropsSchema` and the collections
// proxy: kind names are arbitrary identifiers, so a `toString`-named kind that
// is NOT registered would otherwise read the inherited function as its
// registration and fail with a `TypeError` off `registration.type` instead of
// the `KindNotFoundError` this guard exists to raise.
function getNodeRegistration<G extends GraphDef>(graph: G, kind: string) {
  if (!hasOwnKey(graph.nodes, kind)) throw new KindNotFoundError(kind, "node");
  const registration = graph.nodes[kind];
  if (registration === undefined) throw new KindNotFoundError(kind, "node");
  return registration;
}

/**
 * WHICH constraint makes this node write one whose probe no database key
 * repeats at write time, so it must take the per-graph write fence — or be
 * refused where no fence exists. The classification itself lives with the
 * constraints ({@link file://../constraints.ts nodeWriteNeedsConstraintFence});
 * this is only the graph-def lookup that feeds it.
 *
 * A kind this graph does not define answers `undefined`: choosing the fence
 * must not become the thing that reports an unknown kind, which the write path
 * raises from inside its hooked transaction where `onError` observes it.
 */
function nodeFencesConstraintProbe<G extends GraphDef>(
  ctx: Pick<NodeOperationContext<G>, "graph" | "registry">,
  kind: string,
  operation: "create" | "update",
): ConstraintFenceReason | undefined {
  if (!hasOwnKey(ctx.graph.nodes, kind)) return undefined;
  return nodeWriteNeedsConstraintFence(
    ctx.registry,
    kind,
    getNodeRegistration(ctx.graph, kind).unique ?? [],
    operation,
  );
}

/**
 * A batch fences when ANY item does — one transaction, so one constrained
 * member makes the whole write constrained, and the first such member names the
 * class a refusal would report.
 */
function nodeBatchFencesConstraintProbe<G extends GraphDef>(
  ctx: Pick<NodeOperationContext<G>, "graph" | "registry">,
  inputs: readonly Readonly<{ kind: string }>[],
  operation: "create" | "update",
): ConstraintFenceReason | undefined {
  for (const input of inputs) {
    const reason = nodeFencesConstraintProbe(ctx, input.kind, operation);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

function buildNodeCacheKey(graphId: string, kind: string, id: string): string {
  return encodeTupleKey([graphId, kind, id]);
}

function buildUniqueCacheKey(
  graphId: string,
  nodeKind: string,
  constraintName: string,
  key: string,
): string {
  return encodeTupleKey([graphId, nodeKind, constraintName, key]);
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
  idProvided: boolean;
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

  const validFrom = validateOptionalCanonicalIsoDate(
    input.validFrom,
    "validFrom",
  );
  const validTo = validateOptionalCanonicalIsoDate(input.validTo, "validTo");
  // A stated pair must be ordered. A lone historical validTo is NOT an error on
  // an insert — it means "born already ended" (see
  // assertWritableValidityWindow). Both create paths (single and batch) draft
  // through here, so this is the only insert-side check needed.
  assertOrderedValidityWindow(`${kind} "${id}"`, validFrom, validTo);

  return {
    kind,
    id,
    idProvided: input.id !== undefined,
    nodeKind,
    uniqueConstraints: registration.unique ?? [],
    validatedProps,
    validFrom,
    validTo,
  };
}

/**
 * The async half: existence, disjointness, and uniqueness checks.
 *
 * The existence probe's row is returned on the prepared record so fresh
 * inserts avoid a second read. Resurrection is the rare exception: it
 * re-checks the row immediately before writing because another transaction
 * may have resurrected it after preparation.
 */
async function finishNodeCreatePreparation<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  draft: NodeCreateDraft,
  backend: GraphBackend | TransactionBackend,
): Promise<NodeCreatePrepared> {
  const { kind, id, validatedProps, uniqueConstraints } = draft;

  // This is the fast-path existence gate. Resurrection repeats it immediately
  // before the update because the row can change while constraints are checked.
  const existingNode = await backend.getNode(ctx.graphId, kind, id);
  if (existingNode && !existingNode.deleted_at) {
    throw createAlreadyExistsError("node", kind, id);
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
    idProvided: draft.idProvided,
    tombstone: existingNode,
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

/**
 * The created references identity folding actually has to consider.
 *
 * Folding looks for a live node carrying the SAME id under a DIFFERENT kind.
 * A generated id is fresh — nothing can already hold it — so only
 * caller-supplied ids can participate, and a batch of purely auto-id creates
 * needs no cross-kind probe at all.
 */
function foldReferences(
  preparedCreates: readonly NodeCreatePrepared[],
): readonly Readonly<{ kind: string; id: string }>[] {
  return preparedCreates
    .filter((prepared) => prepared.idProvided)
    .map((prepared) => ({ kind: prepared.kind, id: prepared.id }));
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
 * The exact props an update would persist: the caller's partial input merged
 * over the current props and run through the kind's Zod schema (defaults
 * applied, values normalized). Also returns the resolved registration so
 * callers need not look it up again. Operates on PARSED props so both the write
 * path (which parses the row) and the coalesce dirty-check (which may compare
 * against a batch-local running value, never a row) share one validation.
 */
function computeNodeUpdate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  id: string,
  existingProps: Record<string, unknown>,
  inputProps: Partial<Record<string, unknown>>,
) {
  const registration = getNodeRegistration(ctx.graph, kind);
  const validatedProps = validateNodeProps(
    registration.type.schema,
    { ...existingProps, ...inputProps },
    { kind, operation: "update", id },
  );
  return { registration, validatedProps };
}

/**
 * Row-based wrapper over {@link computeNodeUpdate} for the write path. Reads the
 * kind/id off the row (a `getNode(kind, id)` result always carries the
 * requested kind), matching {@link resolveEdgeUpdateProps}.
 */
function resolveNodeUpdateProps<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  existing: Pick<NodeRow, "kind" | "id" | "props">,
  inputProps: Partial<Record<string, unknown>>,
) {
  const existingProps = rowPropsToObject(existing.props);
  const { registration, validatedProps } = computeNodeUpdate(
    ctx,
    existing.kind,
    existing.id,
    existingProps,
    inputProps,
  );
  return { registration, existingProps, validatedProps };
}

/**
 * The coalesce dirty-check: returns the props an `upsertById` would persist and
 * whether they equal `existingProps` (so the write can be skipped). Compares on
 * the storage-normalized representation (validated, key-order-independent), so
 * it answers exactly "would the persisted JSON differ?". `existingProps` is the
 * PARSED current props — the row's, or the batch-local running value for a
 * repeated id in `bulkUpsertById`.
 */
export function nodeUpsertDirtyCheck<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  id: string,
  existingProps: Record<string, unknown>,
  inputProps: Record<string, unknown>,
): UpsertDirtyCheck {
  const { validatedProps } = computeNodeUpdate(
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

async function performNodeUpdate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: UpsertUpdateNodeInput,
  backend: GraphBackend | TransactionBackend,
  lock: GraphWriteLock,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Node> {
  const { kind, id } = input;

  const existing = await backend.getNode(ctx.graphId, kind, id);
  if (!existing) throw new NodeNotFoundError(kind, id);

  const { registration, validatedProps } = resolveNodeUpdateProps(
    ctx,
    existing,
    input.props,
  );
  const nodeKind = registration.type;

  const validFrom = validateOptionalCanonicalIsoDate(
    input.validFrom,
    "validFrom",
  );
  const validTo = validateOptionalCanonicalIsoDate(input.validTo, "validTo");
  // A node resurrection RESETS `valid_from` (see `buildUpdateNode`), so the
  // effective lower bound is the write instant rather than the row's stored
  // one. That instant is sampled HERE and then travels to the backend as an
  // explicit `validFrom`, because the guard has to measure the bound the write
  // will actually store: left to default, `resolveValidFrom` would stamp the
  // backend's own, strictly later, sample, and a `validTo` at this instant
  // would pass the guard as zero-width and land as negative width a
  // millisecond later (issue #413). An in-place update keeps the row's stored
  // bound, which no write rewrites and so needs no prediction.
  const resurrectionInstant =
    options?.clearDeleted === true && existing.deleted_at !== undefined ?
      nowIso()
    : undefined;
  // A resurrection STORES a stated `validFrom` (it rewrites the whole window);
  // an in-place update never does, so one that differs from the row's stored
  // bound is refused rather than accepted and dropped.
  const windowVerdict = assertWritableValidityWindow(
    `${kind} "${id}"`,
    validFrom,
    resurrectionInstant === undefined ?
      {
        effectiveValidFrom: existing.valid_from,
        appliesStatedValidFrom: false,
      }
    : { effectiveValidFrom: resurrectionInstant, appliesStatedValidFrom: true },
    validTo,
  );

  const writeContext = createNodeWriteContext(ctx.graphId, ctx.registry, lock);
  // `validFrom` reaches the backend only through a resurrecting write (see
  // UpdateNodeParams): a live row's lower bound is history and stays put.
  const effectiveValidFrom = validFrom ?? resurrectionInstant;
  const shared = {
    schema: nodeKind.schema,
    validatedProps,
    uniqueConstraints: registration.unique ?? [],
    ...(effectiveValidFrom !== undefined && { validFrom: effectiveValidFrom }),
    ...(validTo !== undefined && { validTo }),
    // The bound the verdict above READ, carried into the UPDATE's own `WHERE`
    // so the row this writes is the row that was judged. Two conditions, and
    // both matter:
    //
    //  - the verdict consulted the effective bound at all. A plain
    //    `update({ props })` states no window, reads no bound, and stays
    //    unfenced by this — the same rule `UpdateEdgeParams`'s identity
    //    components follow, for the same reason: a component the caller made no
    //    claim about must not become a predicate that refuses legitimate
    //    writes.
    //  - the effective bound WAS the row's stored one. On a resurrection the
    //    guard is handed `resurrectionInstant` instead, so the verdict never
    //    looked at `existing.valid_from` and asserting it would fence on a
    //    value nothing read. That leg carries `deleted_at IS NOT NULL` as its
    //    own fence and converges through the recovery below.
    ...(resurrectionInstant === undefined &&
      windowVerdict.readEffectiveLowerBound && {
        // eslint-disable-next-line unicorn/no-null -- `expectedValidFrom` distinguishes "assert IS NULL" (null) from "assert nothing" (undefined); see UpdateNodeParams.
        expectedValidFrom: existing.valid_from ?? null,
      }),
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

/**
 * How many probe-and-write rounds a node update gets before it stops trying to
 * converge. One retry: enough to absorb a single concurrent recreate, bounded
 * so a peer that keeps replacing the row cannot livelock this caller (the same
 * shape, and the same reasoning, as `getOrCreateByEndpoints`'s bounded loop).
 */
const NODE_UPDATE_ATTEMPTS = 2;

/**
 * Runs a node update and CONVERGES on the row that is actually there when a
 * predicated UPDATE matches nothing.
 *
 * `performNodeUpdate` is a probe-and-write pair, and both of the predicates its
 * statement carries beyond `(graph_id, kind, id)` can stop matching between the
 * two under PostgreSQL READ COMMITTED:
 *
 *  - `deleted_at IS NOT NULL` on the resurrecting leg — a peer resurrected the
 *    tombstone first;
 *  - `expectedValidFrom` on the in-place leg — a peer hard-deleted and
 *    recreated the row, so the bound this update's window verdict was computed
 *    against is gone.
 *
 * Both are the SAME event from the caller's side: the row moved under a
 * decision already made. Neither may surface as the zero-row
 * `DatabaseOperationError` the backend raises, which is an internal sentinel
 * and names nothing a caller can act on. So this re-reads and re-derives:
 *
 *  - row gone, or tombstoned where the leg needs a live one — `NodeNotFoundError`,
 *    exactly what the pre-write probe would have thrown;
 *  - row live — retry the whole thing. The retry re-reads, re-merges the
 *    caller's partial props over the CURRENT props, and re-judges the window
 *    against the CURRENT bound, so a stated window that no longer fits is
 *    refused with the same typed `ValidationError` the first attempt would have
 *    raised. A resurrection that lost its race converges to an ordinary update,
 *    which is upsert's documented semantics: the peer owns the new window, this
 *    late writer owns the properties — and a caller that STATED a lower bound
 *    for the resurrection it lost is therefore refused rather than silently
 *    updated without it.
 *
 * Retrying rather than refusing is what keeps the fence from being a behavior
 * regression: the losing writer still lands its properties, on the row that is
 * really there, judged against the bounds that row really carries.
 */
async function performNodeUpdateWithResurrectionRecovery<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: UpsertUpdateNodeInput,
  target: GraphBackend | TransactionBackend,
  lock: GraphWriteLock,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Node> {
  for (let attempt = 1; attempt <= NODE_UPDATE_ATTEMPTS; attempt += 1) {
    try {
      // Only the FIRST attempt may resurrect: reaching a retry means the row is
      // live, and an ordinary update is what converges on it.
      return await performNodeUpdate(
        ctx,
        input,
        target,
        lock,
        attempt === 1 ? options : undefined,
      );
    } catch (error) {
      if (!isNodeUpdateNoRowError(error) || attempt === NODE_UPDATE_ATTEMPTS) {
        throw nodeUpdateRaceError(input, error);
      }
      const current = await target.getNode(ctx.graphId, input.kind, input.id);
      if (current === undefined || current.deleted_at !== undefined) {
        throw new NodeNotFoundError(input.kind, input.id);
      }
    }
  }
  // Unreachable: the loop either returns or throws on its last attempt.
  throw new NodeNotFoundError(input.kind, input.id);
}

/**
 * The error a caller sees when a node update exhausts its attempts, or fails
 * with something that is not the zero-row sentinel.
 *
 * A non-sentinel error passes through untouched. The sentinel does not: it says
 * "the statement matched nothing", which after {@link NODE_UPDATE_ATTEMPTS}
 * rounds means a peer is replacing this row faster than this writer can read
 * it. That is a contention fact, and it is reported as one rather than as a
 * missing node — the node is present, it just is not staying still.
 */
function nodeUpdateRaceError(
  input: UpsertUpdateNodeInput,
  error: unknown,
): unknown {
  if (!isNodeUpdateNoRowError(error)) return error;
  return new DatabaseOperationError(
    `Node update for ${input.kind} "${input.id}" could not be applied to a stable row after ${NODE_UPDATE_ATTEMPTS} attempts: the row was removed and recreated between each read and its write. A concurrent writer is replacing this node faster than it can be read; serialize the writers, or retry.`,
    {
      operation: "update",
      entity: "node",
      attempted: [{ kind: input.kind, id: input.id }],
    },
    { cause: error },
  );
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
          const groupKey = encodeTupleKey([kindToCheck, constraint.name]);
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
): Promise<readonly NodeCreatePrepared[]> {
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

  return preparedCreates;
}

type CreatePartition = Readonly<{
  inserts: readonly NodeCreatePrepared[];
  resurrections: readonly NodeCreatePrepared[];
}>;

/**
 * Splits prepared creates into fresh inserts and tombstone resurrections.
 *
 * Purely in-memory: preparation already read each id's row under this write
 * lock (batched through `getNodes` when the backend has it, per-row through
 * the validation cache otherwise) and carried it on the prepared record, so
 * routing costs no additional round trip.
 */
function partitionCreates(
  preparedCreates: readonly NodeCreatePrepared[],
): CreatePartition {
  const inserts: NodeCreatePrepared[] = [];
  const resurrections: NodeCreatePrepared[] = [];

  for (const prepared of preparedCreates) {
    if (prepared.tombstone === undefined) {
      inserts.push(prepared);
    } else {
      resurrections.push(prepared);
    }
  }
  return { inserts, resurrections };
}

function isNodeUpdateNoRowError(
  error: unknown,
): error is DatabaseOperationError {
  return (
    error instanceof DatabaseOperationError &&
    error.details.operation === "update" &&
    error.details.entity === "node" &&
    error.details.reason === "no_row_returned"
  );
}

async function resurrectPreparedNode<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  target: GraphBackend | TransactionBackend,
  lock: GraphWriteLock,
  prepared: NodeCreatePrepared,
): Promise<BackendNodeRow> {
  const current = await target.getNode(ctx.graphId, prepared.kind, prepared.id);
  if (current === undefined) {
    throw new DatabaseOperationError(
      `Node tombstone disappeared before resurrection: ${prepared.kind} ${prepared.id}`,
      { operation: "update", entity: "node" },
    );
  }
  if (current.deleted_at === undefined) {
    throw createAlreadyExistsError("node", prepared.kind, prepared.id);
  }
  try {
    return await applyNodeUpdate(
      createNodeWriteContext(ctx.graphId, ctx.registry, lock),
      {
        existing: current,
        clearDeleted: true,
        schema: prepared.nodeKind.schema,
        validatedProps: prepared.validatedProps,
        uniqueConstraints: prepared.uniqueConstraints,
        ...(prepared.insertParams.validFrom === undefined ?
          {}
        : { validFrom: prepared.insertParams.validFrom }),
        ...(prepared.insertParams.validTo === undefined ?
          {}
        : { validTo: prepared.insertParams.validTo }),
      },
      target,
    );
  } catch (error) {
    if (!isNodeUpdateNoRowError(error)) throw error;
    // The UPDATE itself has a tombstone predicate, closing the remaining gap
    // between the re-read and write. Translate a peer resurrection into the
    // create API's stable duplicate error instead of leaking a 0-row update.
    const afterFailure = await target.getNode(
      ctx.graphId,
      prepared.kind,
      prepared.id,
    );
    if (afterFailure !== undefined && afterFailure.deleted_at === undefined) {
      throw createAlreadyExistsError("node", prepared.kind, prepared.id);
    }
    throw error;
  }
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
      const identity = ctx.identity;
      if (identity !== undefined) await identity.lock(target);
      const prepared = await validateAndPrepareNodeCreate(
        ctx,
        input,
        id,
        target,
        options,
      );

      const existing = prepared.tombstone;
      if (existing !== undefined) {
        const resurrected = await resurrectPreparedNode(
          ctx,
          target,
          lock,
          prepared,
        );
        if (identity !== undefined) {
          await identity.foldCreated(target, foldReferences([prepared]));
        }
        return shouldReturnRow ? rowToNode(resurrected) : undefined;
      }

      // The existence probe above is not the last word: on an engine that does
      // not serialize the two writers, a concurrent create of the same new id
      // can commit between the probe and this INSERT, and only the engine's
      // refusal reports it. Both routes to that conclusion raise the same error.
      const row = await withAlreadyExistsTranslation("node", async () => {
        if (shouldReturnRow) return target.insertNode(prepared.insertParams);
        await runInsertNoReturn(
          nodeInsertDispatch(target),
          prepared.insertParams,
        );
        return;
      });

      await finalizeNodeCreate(ctx, prepared, target, lock);
      if (identity !== undefined) {
        await identity.foldCreated(target, foldReferences([prepared]));
      }

      if (row === undefined) return;
      return rowToNode(row);
    },
    {
      fencesConstraintProbe: nodeFencesConstraintProbe(ctx, kind, "create"),
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

  await runInWriteTransaction(
    ctx,
    backend,
    async (target, lock) => {
      const identity = ctx.identity;
      if (identity !== undefined) await identity.lock(target);
      const preparedCreates = await prepareBatchCreates(ctx, inputs, target);

      const partition = partitionCreates(preparedCreates);
      await withAlreadyExistsTranslation("node", () =>
        runInsertBatch(
          nodeInsertDispatch(target),
          partition.inserts.map((prepared) => prepared.insertParams),
        ),
      );
      for (const prepared of partition.resurrections) {
        await resurrectPreparedNode(ctx, target, lock, prepared);
      }
      await finalizeNodeCreateBatch(ctx, partition.inserts, target, lock);
      if (identity !== undefined) {
        await identity.foldCreated(target, foldReferences(preparedCreates));
      }
    },
    {
      fencesConstraintProbe: nodeBatchFencesConstraintProbe(
        ctx,
        inputs,
        "create",
      ),
    },
  );
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

  return runInWriteTransaction(
    ctx,
    backend,
    async (target, lock) => {
      const identity = ctx.identity;
      if (identity !== undefined) await identity.lock(target);
      const preparedCreates = await prepareBatchCreates(
        ctx,
        inputs,
        target,
        options,
      );

      const partition = partitionCreates(preparedCreates);
      const inserted = await withAlreadyExistsTranslation("node", () =>
        runInsertBatchReturning(
          nodeInsertDispatch(target),
          partition.inserts.map((prepared) => prepared.insertParams),
        ),
      );
      const resurrected: BackendNodeRow[] = [];
      for (const prepared of partition.resurrections) {
        resurrected.push(
          await resurrectPreparedNode(ctx, target, lock, prepared),
        );
      }
      await finalizeNodeCreateBatch(ctx, partition.inserts, target, lock);
      const byReference = new Map(
        [...inserted, ...resurrected].map((row) => [
          refKey({ kind: row.kind, id: row.id }),
          row,
        ]),
      );
      const rows = preparedCreates.map((prepared) =>
        requireDefined(
          byReference.get(refKey({ kind: prepared.kind, id: prepared.id })),
          `Missing written row for ${prepared.kind} ${prepared.id}`,
        ),
      );
      if (identity !== undefined) {
        await identity.foldCreated(target, foldReferences(preparedCreates));
      }

      return rows.map((row) => rowToNode(row));
    },
    {
      fencesConstraintProbe: nodeBatchFencesConstraintProbe(
        ctx,
        inputs,
        "create",
      ),
    },
  );
}

// ============================================================
// Node Update Operations
// ============================================================

export async function executeNodeUpdate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: UpsertUpdateNodeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Node> {
  const opContext = ctx.createOperationContext(
    "update",
    "node",
    input.kind,
    input.id,
  );
  return runHookedWriteOperation(
    ctx,
    opContext,
    backend,
    async (target, lock) => {
      const identity = ctx.identity;
      if (options?.clearDeleted && identity !== undefined) {
        await identity.lock(target);
      }
      const node = await performNodeUpdateWithResurrectionRecovery(
        ctx,
        input,
        target,
        lock,
        options,
      );
      if (options?.clearDeleted && identity !== undefined) {
        await identity.foldCreated(target, [
          { kind: input.kind, id: input.id },
        ]);
      }
      return node;
    },
    {
      fencesConstraintProbe: nodeFencesConstraintProbe(
        ctx,
        input.kind,
        "update",
      ),
    },
  );
}

/**
 * Executes an atomic, set-based update of current nodes. The backend returns
 * every after-image so the Store can validate the complete rows before
 * rebuilding all derived sidecars inside the same transaction.
 */
export async function executeNodeUpdateWhere<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  inputPatch: Record<string, unknown>,
  candidateIds: CompiledSelectSql,
  candidateIdColumn: string,
  backend: GraphBackend | TransactionBackend,
): Promise<Readonly<{ affectedCount: number }>> {
  const registration = getNodeRegistration(ctx.graph, kind);
  const schema = registration.type.schema;
  const uniqueConstraints = registration.unique ?? [];

  if (!backend.capabilities.transactions) {
    throw new ConfigurationError(
      "updateWhere() requires a transactional backend so validation and sidecars are atomic",
      { code: "SET_UPDATE_TRANSACTIONS_REQUIRED", kind },
    );
  }
  if (backend.updateNodeSet === undefined) {
    throw new ConfigurationError(
      "This backend does not support set-based node updates",
      { code: "SET_UPDATE_UNSUPPORTED", kind },
    );
  }
  if (Object.keys(inputPatch).length === 0) {
    throw new ValidationError("updateWhere() patch must not be empty", {
      entityType: "node",
      kind,
      operation: "update",
      issues: [{ path: "patch", message: "Provide at least one property" }],
    });
  }
  const unknownProperty = Object.keys(inputPatch).find(
    (property) => !Object.hasOwn(schema.shape, property),
  );
  if (unknownProperty !== undefined) {
    throw new ValidationError(
      `Unknown ${kind} property in updateWhere() patch: ${unknownProperty}`,
      {
        entityType: "node",
        kind,
        operation: "update",
        issues: [
          {
            path: unknownProperty,
            message: "Property is not declared by the node schema",
          },
        ],
      },
    );
  }

  const parsedPatch = validateNodeProps(schema.partial(), inputPatch, {
    kind,
    operation: "update",
  });
  // Data-keyed: `property` comes from the caller's patch object.
  const patch = createDataKeyedBag<JsonValue>();
  const unsetProperties: string[] = [];
  for (const [property, value] of Object.entries(parsedPatch)) {
    if (value === undefined) {
      unsetProperties.push(property);
      continue;
    }
    assertJsonValue(value, property, `Node "${kind}" updateWhere patch`);
    patch[property] = value as JsonValue;
  }
  if (Object.keys(patch).length === 0 && unsetProperties.length === 0) {
    throw new ValidationError(
      "updateWhere() patch has no recognized properties",
      {
        entityType: "node",
        kind,
        operation: "update",
        issues: [
          { path: "patch", message: "Provide a declared node property" },
        ],
      },
    );
  }

  if (
    uniqueConstraints.length > 0 &&
    (backend.hardDeleteUniquesByNodeIds === undefined ||
      backend.insertUniqueBatch === undefined ||
      backend.checkUniqueBatch === undefined)
  ) {
    throw new ConfigurationError(
      "updateWhere() requires batched uniqueness sidecar operations for constrained nodes",
      { code: "SET_UPDATE_UNIQUENESS_UNSUPPORTED", kind },
    );
  }
  if (
    getSearchableFields(schema).length > 0 &&
    (backend.upsertFulltext === undefined ||
      backend.deleteFulltext === undefined ||
      backend.upsertFulltextBatch === undefined ||
      backend.deleteFulltextBatch === undefined)
  ) {
    throw new ConfigurationError(
      "updateWhere() requires batched fulltext sidecar operations for searchable nodes",
      { code: "SET_UPDATE_FULLTEXT_UNSUPPORTED", kind },
    );
  }
  if (
    getEmbeddingFields(schema).length > 0 &&
    (backend.upsertEmbedding === undefined ||
      backend.deleteEmbedding === undefined ||
      backend.upsertEmbeddingBatch === undefined ||
      backend.deleteEmbeddingBatch === undefined)
  ) {
    throw new ConfigurationError(
      "updateWhere() requires batched vector sidecar operations for embedded nodes",
      { code: "SET_UPDATE_VECTOR_UNSUPPORTED", kind },
    );
  }

  const hookContext = ctx.createBulkOperationContext("updateWhere", kind);
  return ctx.withBulkOperationHooks(hookContext, () =>
    runInWriteTransaction(
      ctx,
      backend,
      async (target, lock) => {
        const updateNodeSet = target.updateNodeSet;
        if (updateNodeSet === undefined) {
          throw new ConfigurationError(
            "The transaction backend does not support set-based node updates",
            { code: "SET_UPDATE_UNSUPPORTED", kind },
          );
        }
        const hardDeleteUniquesByNodeIds = target.hardDeleteUniquesByNodeIds;
        if (
          uniqueConstraints.length > 0 &&
          (hardDeleteUniquesByNodeIds === undefined ||
            target.insertUniqueBatch === undefined ||
            target.checkUniqueBatch === undefined)
        ) {
          throw new ConfigurationError(
            "The transaction backend lacks batched uniqueness operations",
            { code: "SET_UPDATE_UNIQUENESS_UNSUPPORTED", kind },
          );
        }
        if (
          getSearchableFields(schema).length > 0 &&
          (target.upsertFulltext === undefined ||
            target.deleteFulltext === undefined ||
            target.upsertFulltextBatch === undefined ||
            target.deleteFulltextBatch === undefined)
        ) {
          throw new ConfigurationError(
            "The transaction backend lacks batched fulltext operations",
            { code: "SET_UPDATE_FULLTEXT_UNSUPPORTED", kind },
          );
        }
        if (
          getEmbeddingFields(schema).length > 0 &&
          (target.upsertEmbedding === undefined ||
            target.deleteEmbedding === undefined ||
            target.upsertEmbeddingBatch === undefined ||
            target.deleteEmbeddingBatch === undefined)
        ) {
          throw new ConfigurationError(
            "The transaction backend lacks batched vector operations",
            { code: "SET_UPDATE_VECTOR_UNSUPPORTED", kind },
          );
        }
        const result = await updateNodeSet({
          graphId: ctx.graphId,
          kind,
          patch,
          unsetProperties,
          candidateIds,
          candidateIdColumn,
        });
        if (result.affectedCount === 0) return { affectedCount: 0 };

        const sidecarItems = result.rows.map((row) => {
          const props = rowPropsToObject(row.props);
          const validatedProps = validateNodeProps(schema, props, {
            kind,
            operation: "update",
            id: row.id,
          });
          if (!canonicalEqual(validatedProps, props)) {
            throw new ValidationError(
              `Set update would persist a non-canonical ${kind} row`,
              {
                entityType: "node",
                kind,
                operation: "update",
                id: row.id,
                issues: [
                  {
                    path: "props",
                    message: "The complete row requires schema normalization",
                  },
                ],
              },
            );
          }
          return {
            kind,
            id: row.id,
            schema,
            props: validatedProps,
            uniqueConstraints,
          };
        });

        if (uniqueConstraints.length > 0) {
          const affectedIds = new Set(result.rows.map((row) => row.id));
          for (const constraint of uniqueConstraints) {
            const keyToId = new Map<string, string>();
            for (const item of sidecarItems) {
              if (!checkWherePredicate(constraint, item.props)) continue;
              const key = computeUniqueKey(
                item.props,
                constraint.fields,
                constraint.collation,
              );
              const priorId = keyToId.get(key);
              if (priorId !== undefined && priorId !== item.id) {
                throw new UniquenessError({
                  constraintName: constraint.name,
                  kind,
                  existingId: priorId,
                  newId: item.id,
                  fields: constraint.fields,
                });
              }
              keyToId.set(key, item.id);
            }
            const keys = [...keyToId.keys()];
            if (keys.length === 0) continue;
            for (const kindToCheck of getKindsForUniquenessCheck(
              kind,
              constraint.scope,
              ctx.registry,
            )) {
              const existingRows = await requireDefined(
                target.checkUniqueBatch,
              )({
                graphId: ctx.graphId,
                nodeKind: kindToCheck,
                constraintName: constraint.name,
                keys,
              });
              for (const existing of existingRows) {
                if (
                  existing.concrete_kind === kind &&
                  affectedIds.has(existing.node_id)
                ) {
                  continue;
                }
                throw new UniquenessError({
                  constraintName: constraint.name,
                  kind: kindToCheck,
                  existingId: existing.node_id,
                  newId: requireDefined(keyToId.get(existing.key)),
                  fields: constraint.fields,
                });
              }
            }
          }
          await requireDefined(hardDeleteUniquesByNodeIds)({
            graphId: ctx.graphId,
            concreteKind: kind,
            nodeIds: result.rows.map((row) => row.id),
          });
        }
        await applyNodeInsertSideEffectsBatch(
          createNodeWriteContext(ctx.graphId, ctx.registry, lock),
          sidecarItems,
          target,
        );
        return { affectedCount: result.affectedCount };
      },
      {
        didWrite: (result) => result.affectedCount > 0,
        // The set update re-checks every changed unique key across the
        // constraint's scope before rebuilding the sidecars, so a shared-scope
        // constraint makes it a constrained write like any other update.
        fencesConstraintProbe: nodeFencesConstraintProbe(ctx, kind, "update"),
      },
    ),
  );
}

/**
 * Executes a node update for upsert — bypasses operation hooks
 * and allows updating soft-deleted nodes when clearDeleted is set.
 */
export async function executeNodeUpsertUpdate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: UpsertUpdateNodeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Node> {
  return runInWriteTransaction(
    ctx,
    backend,
    async (target, lock) => {
      const identity = ctx.identity;
      if (options?.clearDeleted && identity !== undefined) {
        await identity.lock(target);
      }
      const node = await performNodeUpdateWithResurrectionRecovery(
        ctx,
        input,
        target,
        lock,
        options,
      );
      if (options?.clearDeleted && identity !== undefined) {
        await identity.foldCreated(target, [
          { kind: input.kind, id: input.id },
        ]);
      }
      return node;
    },
    {
      fencesConstraintProbe: nodeFencesConstraintProbe(
        ctx,
        input.kind,
        "update",
      ),
    },
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
      const identity = ctx.identity;
      if (identity !== undefined) await identity.lock(target);
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
      if (identity !== undefined) {
        await identity.detachDeleted(target, { kind, id }, "soft");
      }
    },
  );
}

/**
 * Soft-deletes a batch without per-item operation hooks.
 *
 * Batch collection methods deliberately omit per-item hooks for throughput.
 * Owning the write transaction here also prevents a per-item success from
 * being reported before the batch's outer COMMIT.
 */
export async function executeNodeDeleteBatch<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  ids: readonly string[],
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  await runInWriteTransaction(
    ctx,
    backend,
    async (target, lock) => {
      const identity = ctx.identity;
      if (identity !== undefined) await identity.lock(target);
      const registration = getNodeRegistration(ctx.graph, kind);
      const writeContext = createNodeWriteContext(
        ctx.graphId,
        ctx.registry,
        lock,
      );
      let affectedCount = 0;

      for (const id of ids) {
        // This is both the existence gate and the concurrency-correct
        // pre-image consumed by uniqueness cleanup. It must stay inside the
        // batch transaction after the graph write lock is held.
        const preflight = await target.getNode(ctx.graphId, kind, id);
        if (!preflight || !isLiveNodeRow(preflight)) continue;

        await applyNodeSoftDelete(
          writeContext,
          {
            existing: preflight,
            schema: registration.type.schema,
            uniqueConstraints: registration.unique ?? [],
            onDelete: registration.onDelete,
          },
          target,
        );
        if (identity !== undefined) {
          await identity.detachDeleted(target, { kind, id }, "soft");
        }
        affectedCount += 1;
      }

      return affectedCount;
    },
    { didWrite: (affectedCount) => affectedCount > 0 },
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
      const identity = ctx.identity;
      if (identity !== undefined) await identity.lock(target);
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
      if (identity !== undefined) {
        await identity.detachDeleted(target, { kind, id }, "hard");
      }
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

  const conditions: SqlFragment[] = [
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

  type Result = Readonly<{ node: Node; action: GetOrCreateAction }>;

  // Steps 2-6 are one convergence attempt: the batch probe runs outside any
  // transaction and each write leg opens its own, so a concurrent create can
  // reserve a key between them. The uniques primary key catches that and raises
  // `UniquenessError`; re-running the whole attempt converges on the winner's
  // row. Without this the single-item path retried and the batch failed
  // outright, which is the asymmetry #428 called out.
  async function attempt(): Promise<Result[]> {
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
        });
      }
    }

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
          node: requireDefined(createdNodes[batchIndex]),
          action: "created",
        };
      }
    }

    // Step 5: Handle existing nodes (fetch/update/resurrect)
    for (const entry of toFetch) {
      const { index, concreteKind, validatedProps, nodeId } = entry;

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

      // Read from the NODE ROW this loop just fetched, not from the uniques row
      // the batch probe captured back in step 2 — the single-item path has
      // always derived it here (see `executeNodeGetOrCreateByConstraint`), and
      // one decision with two owners drifts. The uniques copy is also the
      // staler of the two: step 4's creates run between the probe and this
      // read, and a peer can soft-delete or resurrect the node in that window.
      // Whether this write RESURRECTS has to come from the row it will target.
      const isSoftDeleted = existingRow.deleted_at !== undefined;

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
      const sourceResult = requireDefined(results[sourceIndex]);
      results[index] = { node: sourceResult.node, action: "found" };
    }

    return results;
  }

  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof UniquenessError)) throw error;
    return attempt();
  }
}
