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
import { type z } from "zod";

import {
  type AtomicNodeBatchEntry,
  type AtomicNodeClaimSupport,
  type AtomicNodeDeleteBatchExecutor,
  AtomicNodeDeleteRestrictedRefusalError,
  type AtomicNodeProjection,
  type AtomicNodeReplacementEntry,
  type AtomicNodeResolvedUpdateBatchExecutor,
  supportsAtomicNodeClaims,
} from "../../backend/capabilities/atomic-mutation-program";
import { isBundledRootAutocommitEligible } from "../../backend/capabilities/autocommit-single-statement";
import { bindExtraIfReachable } from "../../backend/capabilities/bind";
import {
  BATCH_POINT_READ,
  type STATEMENT_EXECUTION,
  UNIQUE_SIDECAR_BATCH,
} from "../../backend/capabilities/bundle-registry";
import { resolveBackendFulltext } from "../../backend/capabilities/fulltext";
import {
  rephaseAtomicNodeClaimPlan,
  supportsNodeCreatePlan,
  supportsNodeInsertProjections,
} from "../../backend/capabilities/node-insert-projections";
import {
  type BundleVerdictOf,
  type ClaimsVerdictThunk,
  missingRequiredExtras,
} from "../../backend/capabilities/resolve";
import { isSchemaFencedInsertEligible } from "../../backend/capabilities/schema-fenced-insert";
import { deriveBackend } from "../../backend/derive-backend";
import {
  type EdgeRow as BackendEdgeRow,
  type GraphBackend,
  type InsertNodeParams,
  isLiveNodeRow,
  type NodeInsertProjection,
  type NodePropertyExpectation,
  type NodeRow as BackendNodeRow,
  rowPropsToObject,
  type TransactionBackend,
  type UniqueRow,
} from "../../backend/types";
import {
  checkDisjointness,
  checkWherePredicate,
  computeUniqueKey,
} from "../../constraints";
import { type GraphDef } from "../../core/define-graph";
import { assertJsonValue } from "../../core/json-value";
import {
  type JsonScalar,
  type JsonValue,
  type KindEntity,
  type NodeType,
  type UniqueConstraint,
} from "../../core/types";
import {
  CompilerInvariantError,
  CompositionExistenceError,
  ConfigurationError,
  DatabaseOperationError,
  KindNotFoundError,
  NodeConstraintNotFoundError,
  NodeIndexNotFoundError,
  NodeNotFoundError,
  RestrictedDeleteError,
  UniquenessError,
  ValidationError,
} from "../../errors";
import { validateNodeProps } from "../../errors/validation";
import { refKey } from "../../identity/service";
import { type IdentityTarget } from "../../identity/sql-target";
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
import { chunk } from "../../utils/array";
import {
  assertOrderedValidityWindow,
  assertWritableValidityWindow,
  nowIso,
  preservesImmutableLowerBound,
  resolveStampedValidityLowerBound,
  validateOptionalCanonicalIsoDate,
  validateStatedValidityLowerBound,
} from "../../utils/date";
import { generateId } from "../../utils/id";
import { createDataKeyedBag, hasOwnKey } from "../../utils/object";
import { requireDefined } from "../../utils/presence";
import { encodeTupleKey } from "../../utils/tuple-key";
import { type ClaimOwner, uniquenessProbeKinds } from "../claims/axis";
import {
  checkUniquenessConstraints,
  createUniquenessContext,
  groupNodeUniquenessProbes,
  isUniquenessClaimEntry,
  nodeClaimEntries,
  type NodeClaimItem,
  type NodeCreateClaimPlan,
  planNodeCreateClaims,
  probeUniqueKey,
  refuseNodeCreateClaimError,
} from "../claims/node-claims";
import { type UpsertDirtyCheck } from "../collections/coalesce";
import {
  type NodeSetUpdateRequest,
  type NodeUpsertUpdateBatchEntry,
  type UpsertUpdateNodeInput,
} from "../collections/node-collection";
import {
  checkDisjointnessConstraint,
  type ConstraintContext,
  type ConstraintFenceReason,
  edgeWriteNeedsConstraintFence,
  nodeDeleteNeedsConstraintFence,
  nodeWriteNeedsConstraintFence,
} from "../constraints";
import {
  getEmbeddingFields,
  resolveNodeEmbeddingProjections,
  resolveNodeEmbeddingProjectionTransitions,
} from "../embedding-sync";
import {
  assertFulltextMember,
  getSearchableFields,
  refuseFulltextUnavailable,
  resolveNodeFulltextProjection,
} from "../fulltext-sync";
import { getNodeRowsByIds } from "../node-fetch";
import { type GraphWriteLock } from "../recorded-capture/clock";
import {
  appliedResolvedMutationSet,
  type ResolvedMutationSetAttempt,
  ResolvedMutationSetMoved,
  unsupportedResolvedMutationSet,
} from "../resolved-mutation-set";
import { type NodeRow, rowToNode } from "../row-mappers";
import {
  type BulkOperationHookContext,
  compareAndSetAbsent,
  type CompositionAttachment,
  type CompositionNodeRef,
  type CreateNodeInput,
  type GetOrCreateAction,
  type Node,
  type NodeBulkFindByIndexOptions,
  type NodeGetOrCreateByConstraintOptions,
  type OperationHookContext,
  type OperationOutcomeFacts,
  type UpdateNodeInput,
} from "../types";
import {
  assertClearValidToSupported,
  assertValidityEndMutation,
} from "../validity-end";
import {
  createAlreadyExistsError,
  withAlreadyExistsTranslation,
} from "./already-exists";
import {
  assertAtomicDeleteSchemaFenceMatched,
  resolveAtomicNodeBatchExecutor,
  resolveAtomicNodeDeleteBatchExecutor,
  resolveAtomicNodeReplacementBatchProgram,
  resolveAtomicNodeResolvedMutationSetExecutor,
  resolveAtomicNodeResolvedUpdateBatchExecutor,
} from "./atomic-mutation-program";
import {
  AutocommitWriteRequiresTransaction,
  canFuseSchemaFenceInFirstWrite,
  isAutocommitSingleStatementWrite,
} from "./autocommit-single-statement";
import {
  cascadedPartReferences,
  type CompositionCascadePlan,
  planCompositionCascade,
} from "./composition-cascade";
import {
  assertCompositionExistencePreserved,
  buildCompositionCreateEdgeInput,
  type CompositionCreateWork,
  edgeCurrentlyAttachesPart,
  findLiveCompositionAttachment,
  resolveCompositionAttachment,
  resolveCompositionCreate,
} from "./composition-create";
import {
  edgeCardinalityDeclarations,
  edgeInsertWork,
  endCompositionEdgeWindow,
  validateAndPrepareEdgeCreate,
} from "./edge-operations";
import {
  type NodeDeleteMode,
  type NodeDeletePolicy,
  nodeDeletePolicyRequiresPortablePath,
  type NodeInsertSyncItem,
} from "./node-write-pipeline";
import {
  atomicResolvedUpdateAttemptBudget,
  booleanWriteResultChanges,
  type HookedWritePlanContext,
  type OverlaidSessionMint,
  runAtomicProgramWithHooks,
  runAutocommitSingleStatementWritePlan,
  runHookedWritePlan,
  runWritePlan,
  writeResultAlwaysChanges,
} from "./write-executor";
import { type NodeUpdateFences } from "./write-fences";
import {
  mixedBatchWritePlan,
  mixedWritePlan,
  nodeWritePlan,
} from "./write-plan";
import {
  type NodeCreateWork,
  type NodeWriteSession,
  unfencedTarget,
  type WriteSession,
  type WriteTarget,
} from "./write-session";
import {
  diagnoseFusedSchemaFenceNoRow,
  hasLeasedSchemaFence,
  lockSchemaVersionForStoreWrite,
  memoizeLeasedSchemaFence,
  type WriteTransactionMode,
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
  coalesceUnchangedUpsertsEnabled: boolean;
  revisionSchema: SqlSchema;
  registry: KindRegistry;
  /**
   * The `claims` bundle's memoized, at-most-once verdict thunk (ruling B7
   * refinement 2) — threaded through to `createNodeWriteContext` by
   * `runWritePlan`'s session mint, and called at the write-session sites that
   * issue or release a claim.
   */
  claimsVerdict: ClaimsVerdictThunk;
  /** Threaded from `store.ts`'s `#batchPointRead` — never re-resolved here. */
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>;
  /** Threaded from `store.ts`'s `#uniqueSidecarBatch` — never re-resolved here. */
  uniqueSidecarBatch: BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH>;
  /** Threaded from `store.ts`; exact transaction targets bind separately. */
  statementExecution: BundleVerdictOf<typeof STATEMENT_EXECUTION>;
  createOperationContext: (
    operation: "create" | "update" | "delete",
    entity: KindEntity,
    kind: string,
    id: string,
  ) => OperationHookContext;
  withOperationHooks: <T>(
    ctx: OperationHookContext,
    fn: () => Promise<T>,
    didWrite?: (result: T) => boolean,
    operationFacts?: (result: T) => OperationOutcomeFacts | undefined,
  ) => Promise<T>;
  /**
   * Reports the composition parts one node delete's cascade removed to this
   * transaction's receipt (`TransactionReceipt.cascadedParts`). Present only
   * inside a receipt-tracked transaction — a top-level delete has no receipt
   * to record into, which is why its absence is the off switch rather than a
   * wiring bug. The SAME refs the delete's `onOperationEnd` context carries,
   * from the same cascade plan, so the hook and the receipt cannot disagree.
   */
  recordCascadedParts?: (parts: readonly CompositionNodeRef[]) => void;
  createBulkOperationContext: (
    operation: "compareAndSet" | "updateWhere",
    kind: string,
  ) => BulkOperationHookContext;
  withBulkOperationHooks: <T extends Readonly<{ affectedCount: number }>>(
    ctx: BulkOperationHookContext,
    fn: () => Promise<T>,
  ) => Promise<T>;
  /**
   * The identity hooks a node write participates in, on {@link IdentityTarget}
   * — the projection identity STATEMENTS run against — so a fold or a detach
   * can be issued from inside a write frame, whose handle is the read-only
   * {@link WriteTarget}. Identity assertions are not node rows: they never
   * travel through the session, and this is their seam.
   */
  identity?: Readonly<{
    lock: (target: IdentityTarget) => Promise<void>;
    foldCreated: (
      target: IdentityTarget,
      references: readonly Readonly<{ kind: string; id: string }>[],
      cause: "fold" | "restore",
    ) => Promise<void>;
    detachDeleted: (
      target: IdentityTarget,
      ref: Readonly<{ kind: string; id: string }>,
      mode: "soft" | "hard",
    ) => Promise<void>;
    requireValidityEndCompatible: (
      target: IdentityTarget,
      ref: Readonly<{ kind: string; id: string }>,
      validTo: string,
    ) => Promise<void>;
  }>;
}>;

type NodeCreatePrepared = Readonly<{
  kind: string;
  id: string;
  nodeKind: NodeType;
  validatedProps: Record<string, unknown>;
  uniqueConstraints: readonly UniqueConstraint[];
  claimPlan: NodeCreateClaimPlan;
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
  /**
   * This caller-supplied id has no pre/post claims, so a first-party backend
   * can learn whether the primary-key slot is free from the INSERT itself.
   */
  insertIfAbsent: boolean;
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
 * The per-item constraint probes a batch write plan folds.
 *
 * "A batch fences when ANY item does" is `foldBatchConstraintProbe`'s rule
 * (`write-plan.ts`), which `mixedBatchWritePlan` applies to this function's
 * output — this only supplies the per-item classifications, so the fold
 * itself has one spelling rather than one here and one in the plan builder.
 */
function nodeBatchConstraintProbes<G extends GraphDef>(
  ctx: Pick<NodeOperationContext<G>, "graph" | "registry">,
  inputs: readonly Readonly<{ kind: string }>[],
  operation: "create" | "update",
): readonly (ConstraintFenceReason | undefined)[] {
  return inputs.map((input) =>
    nodeFencesConstraintProbe(ctx, input.kind, operation),
  );
}

/**
 * WHICH constraint makes a node DELETE a constrained write — the graph-def
 * lookup only. The classification itself lives with the constraints
 * ({@link file://../constraints.ts nodeDeleteNeedsConstraintFence}); this
 * mirrors {@link nodeFencesConstraintProbe}'s split from
 * `nodeWriteNeedsConstraintFence` above, so a new constraint kind teaches
 * one function, not every write path that calls it.
 *
 * A kind this graph does not define answers `undefined`: choosing the fence
 * must not become the thing that reports an unknown kind.
 */
function nodeDeleteConstraintProbe<G extends GraphDef>(
  ctx: Pick<NodeOperationContext<G>, "graph" | "registry">,
  kind: string,
): ConstraintFenceReason | undefined {
  if (!hasOwnKey(ctx.graph.nodes, kind)) return undefined;
  return nodeDeleteNeedsConstraintFence(ctx.registry, kind);
}

/**
 * Folds a composition cascade's consumed edge ids into a delete policy, for
 * the ROOT node's own delete-behavior enforcement — the cascade already
 * excludes these from every MEMBER's own restrict count (via the policy
 * `runCompositionCascade` builds for them); this is what excludes them from
 * the root's, so a whole declared `onDelete: "restrict"` with only
 * composition edges to its (now-deleted) parts still deletes.
 */
function withCascadeConsumedEdges(
  policy: NodeDeletePolicy | undefined,
  consumedEdgeIds: ReadonlySet<string>,
): NodeDeletePolicy | undefined {
  if (consumedEdgeIds.size === 0) return policy;
  const merged = new Set(policy?.consumedEdgeIds);
  for (const edgeId of consumedEdgeIds) merged.add(edgeId);
  return {
    enforceDeleteBehavior: policy?.enforceDeleteBehavior ?? true,
    consumedEdgeIds: merged,
    ...(policy?.cascadeComposition === undefined ?
      {}
    : { cascadeComposition: policy.cascadeComposition }),
  };
}

/**
 * Runs the composition cascade for one whole delete: plans the parts closure
 * under `lock` (`planCompositionCascade`), deletes each part LEAF-FIRST
 * through its own node-delete pipeline — `session.retireNode` /
 * `session.purgeNode`, exactly as a direct delete of that part would run, so
 * its own non-composition edges, uniqueness/claim release, embedding and
 * fulltext projections, and identity cascade all apply — then explicitly
 * deletes every composition edge the cascade consumed, since each member's
 * own delete-behavior enforcement was told to skip them (they would
 * otherwise survive: a `consumedEdgeIds` edge is excluded from BOTH the
 * restrict count and the cascade/disconnect removal of the delete that
 * consumed it).
 *
 * A no-op when `policy?.cascadeComposition` is `false` (merge apply's
 * request: the plan already carries the part deletions) or when the kind
 * declares no composition parts. Returns the plan either way, so the caller
 * can fold `consumedEdgeIds` into the ROOT's own policy
 * ({@link withCascadeConsumedEdges}).
 */
async function runCompositionCascade<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  id: string,
  target: WriteTarget,
  lock: GraphWriteLock,
  mode: NodeDeleteMode,
  policy: NodeDeletePolicy | undefined,
  session: NodeWriteSession,
): Promise<CompositionCascadePlan> {
  if (policy?.cascadeComposition === false) {
    return { members: [], consumedEdgeIds: new Set() };
  }
  const plan = await planCompositionCascade(
    { graphId: ctx.graphId, registry: ctx.registry, lock },
    kind,
    id,
    target,
  );
  if (plan.members.length === 0) return plan;

  const identity = ctx.identity;
  const memberPolicy: NodeDeletePolicy = {
    enforceDeleteBehavior: true,
    consumedEdgeIds: plan.consumedEdgeIds,
    cascadeComposition: false,
  };
  for (const member of plan.members) {
    const registration = getNodeRegistration(ctx.graph, member.kind);
    if (mode === "soft") {
      const preflight = await target.getNode(
        ctx.graphId,
        member.kind,
        member.id,
      );
      // Already gone (concurrently deleted, or already visited via another
      // path through the closure) — nothing to retire, but the edges this
      // cascade consumed still get cleaned up below.
      if (!preflight || !isLiveNodeRow(preflight)) continue;
      await session.retireNode(
        {
          existing: preflight,
          schema: registration.type.schema,
          uniqueConstraints: registration.unique ?? [],
          onDelete: registration.onDelete,
        },
        memberPolicy,
      );
      if (identity !== undefined) {
        await identity.detachDeleted(
          target,
          { kind: member.kind, id: member.id },
          "soft",
        );
      }
    } else {
      await session.purgeNode(
        {
          kind: member.kind,
          id: member.id,
          schema: registration.type.schema,
          onDelete: registration.onDelete,
        },
        memberPolicy,
      );
      if (identity !== undefined) {
        await identity.detachDeleted(
          target,
          { kind: member.kind, id: member.id },
          "hard",
        );
      }
    }
  }
  // The explicit cleanup that guarantees no composition edge row survives
  // its endpoints, even when a member's own onDelete is `restrict`: every
  // consumed edge was deliberately excluded from each endpoint's own
  // cascade/disconnect removal above.
  await session.deleteCompositionEdges([...plan.consumedEdgeIds], mode);
  return plan;
}

/**
 * The executor context this module's writes run under: the operation context
 * plus HOW it acquires the identity lock.
 *
 * The plan says WHETHER identity participates; the context says how. A graph
 * with no identity configured supplies no acquirer, and its plans declare no
 * participation — the two are derived from the same `ctx.identity`, which is
 * what makes "declared participation with no acquirer" an unreachable wiring
 * bug rather than a silently skipped lock.
 */
function nodeWritePlanContext<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
): HookedWritePlanContext {
  const identity = ctx.identity;
  if (identity === undefined) return ctx;
  return { ...ctx, identityLock: identity.lock };
}

/**
 * The participation a write declares, or `undefined` on a graph with no
 * identity — the one place the `if (identity !== undefined)` that used to be
 * re-spelled at every node write site now lives.
 */
function nodeRequiresIdentityLock<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
): boolean {
  return ctx.identity !== undefined;
}

/**
 * A generated id cannot already belong to another node, so it cannot take
 * part in identity folding. Keep the identity advisory lock for caller-
 * supplied ids, whose cross-kind collision probe and fold do need it.
 */
function nodeCreateRequiresIdentityLock<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: Readonly<{ id?: string }>,
): boolean {
  return input.id !== undefined && nodeRequiresIdentityLock(ctx);
}

/**
 * A schema fence can move into the first INSERT only when it remains the first
 * lock-bearing operation. Claims, identity, recorded capture and revision
 * tracking all acquire a lock before row work, so they deliberately retain the
 * ordinary explicit fence.
 */
/** Whether any member of a node-create batch can participate in identity. */
function nodeBatchCreateRequiresIdentityLock<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  inputs: readonly Readonly<{ id?: string }>[],
): boolean {
  return (
    nodeRequiresIdentityLock(ctx) &&
    inputs.some((input) => input.id !== undefined)
  );
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
  validFrom: string | null | undefined,
  validTo: string | undefined,
): InsertNodeParams {
  const insertParams: {
    graphId: string;
    kind: string;
    id: string;
    props: Record<string, unknown>;
    validFrom?: string | null;
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

/**
 * Materializes the claim row a not-yet-flushed batch member holds, so a later
 * member's probe reads the same shape it would read from the database.
 *
 * It invents no kind: the owner pair comes from the pending registration. The
 * predecessor wrote `concrete_kind: nodeKind` — the axis the probe QUERIED,
 * which the pending writer never supplied — so `Employee "X"` followed by
 * `Contractor "X"` on one shared-scope key read back as the same owner, the
 * in-batch refusal was suppressed, and the real one arrived at the flush as a
 * whole-batch abort. This is the third renderer of claim ownership; it must
 * agree with the TypeScript predicate and the SQL arms.
 */
function createPendingUniqueRow(
  graphId: string,
  nodeKind: string,
  constraintName: string,
  key: string,
  owner: ClaimOwner,
): UniqueRow {
  return {
    graph_id: graphId,
    node_kind: nodeKind,
    constraint_name: constraintName,
    key,
    node_id: owner.nodeId,
    concrete_kind: owner.concreteKind,
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

/**
 * The reads a batch's pending-aware validation answers itself.
 *
 * Published as the OVERLAY SPEC alongside the reader built from it, because
 * two different handles have to carry these answers: the caller reads through
 * `reader`, and interchange import ALSO hands the spec to the executor, which
 * decorates the write frame's own target with it so a session can be minted
 * over the same pending state. A decorated backend alone could not do that —
 * its static type would have to be the full backend union for the session mint
 * to accept it, which is the widening this seam exists to remove — and two
 * independently built overlays would be two spellings of one decision.
 */
export type NodeBatchValidationReads = Readonly<
  Pick<WriteTarget, "getNode" | "checkUnique">
>;

export function createNodeBatchValidationSeams(
  graphId: string,
  registry: KindRegistry,
  backend: WriteTarget,
): Readonly<{
  reads: NodeBatchValidationReads;
  reader: WriteTarget;
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
  // The pending OWNER PAIR, never the bare id: two batch members sharing an id
  // under different kinds are two claimants, and an id-keyed cache reads them
  // as one.
  const pendingUniqueOwners = new Map<string, ClaimOwner>();

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
      // which don't inspect its value — normalize the write protocol's explicit-NULL
      // sentinel away rather than widen this cache's row shape.
      valid_from: params.validFrom ?? undefined,
      valid_to: params.validTo,
      created_at: "",
      updated_at: "",
      deleted_at: undefined,
    });
  }

  // Records the claims a not-yet-flushed create will write, at the AXIS it will
  // write them: one entry per claim, not one per kind in scope. The fan-out
  // this replaces existed because the claim used to be written under the
  // node's own kind while the probe read every kind in scope; now both sides
  // name the axis, so a second entry would be a second spelling of the same
  // reservation.
  function registerPendingUniqueEntries(
    kind: string,
    id: string,
    props: Record<string, unknown>,
    constraints: readonly UniqueConstraint[],
  ): void {
    for (const entry of nodeClaimEntries(
      registry,
      kind,
      id,
      props,
      constraints,
      "create",
    )) {
      pendingUniqueOwners.set(
        buildUniqueCacheKey(
          graphId,
          entry.axis,
          entry.constraintName,
          entry.key,
        ),
        { concreteKind: kind, nodeId: id },
      );
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
  // flush, aborting the whole import. Mirrors the claim transition's key diff:
  // for each constraint whose key changed, the released old key becomes free
  // and the reserved new key becomes owned by this node AT ITS AXIS — the one
  // row the transition actually wrote — while the remaining kinds the probe
  // reads are recorded as vacant, which they are: the probe that let this
  // update through visited every one of them.
  function registerAppliedNodeUpdate(
    kind: string,
    id: string,
    oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
    constraints: readonly UniqueConstraint[],
  ): void {
    const owner: ClaimOwner = { concreteKind: kind, nodeId: id };
    const oldEntries = new Map(
      nodeClaimEntries(registry, kind, id, oldProps, constraints, "update").map(
        (entry) => [entry.constraintName, entry],
      ),
    );
    const newEntries = new Map(
      nodeClaimEntries(registry, kind, id, newProps, constraints, "update").map(
        (entry) => [entry.constraintName, entry],
      ),
    );

    for (const constraint of constraints) {
      const oldEntry = oldEntries.get(constraint.name);
      const newEntry = newEntries.get(constraint.name);
      if (oldEntry?.key === newEntry?.key) continue;

      const kindsToCheck = uniquenessProbeKinds(
        kind,
        constraint.scope,
        registry,
      );

      if (oldEntry !== undefined) {
        for (const kindToCheck of kindsToCheck) {
          const cacheKey = buildUniqueCacheKey(
            graphId,
            kindToCheck,
            constraint.name,
            oldEntry.key,
          );
          // This node released the key on the real backend, so it is now
          // free. Clear any pending reservation and record the known-free
          // state (overwriting a stale seeded owner) so a later create's
          // pre-check sees a vacancy instead of a redundant backend read.
          pendingUniqueOwners.delete(cacheKey);
          uniqueCache.set(cacheKey, undefined);
        }
      }
      if (newEntry !== undefined) {
        for (const kindToCheck of kindsToCheck) {
          const cacheKey = buildUniqueCacheKey(
            graphId,
            kindToCheck,
            constraint.name,
            newEntry.key,
          );
          if (kindToCheck === newEntry.axis) {
            // This node now holds the key on the real backend. A pending owner
            // shadows the seeded uniqueCache entry (checkUniqueCached consults
            // it first), matching registerPendingUniqueEntries' reservation.
            pendingUniqueOwners.set(cacheKey, owner);
            continue;
          }
          pendingUniqueOwners.delete(cacheKey);
          uniqueCache.set(cacheKey, undefined);
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

  const reads: NodeBatchValidationReads = {
    getNode: getNodeCached,
    checkUnique: checkUniqueCached,
  };

  return {
    reads,
    reader: deriveBackend(backend, reads),
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

/** Whether create preparation retains application probes or defers them to
 * the authoritative verdict returned by the planned insert statement. */
type NodeCreatePreparationMode =
  "probe" | "authoritative-plan" | "atomic-batch";

export type NodeCreateDraft = Readonly<{
  kind: string;
  id: string;
  idProvided: boolean;
  nodeKind: NodeType;
  uniqueConstraints: readonly UniqueConstraint[];
  validatedProps: Record<string, unknown>;
  validFrom: string | null | undefined;
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

  const validFrom = validateStatedValidityLowerBound(
    input.validFrom,
    "validFrom",
  );
  const validTo = validateOptionalCanonicalIsoDate(input.validTo, "validTo");
  // A stated pair must be ordered, and on an insert that is the COMPLETE rule.
  // A lone historical validTo is NOT an error — it means "born already ended"
  // (see assertWritableValidityWindow), and the insert stores no lower bound for
  // it rather than one past the stated end, so there is no effective bound left
  // for this layer to judge. Both create paths (single and batch) draft through
  // here, so this is the only insert-side check needed.
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
  backend: WriteTarget,
  allowInsertIfAbsent = true,
  mode: NodeCreatePreparationMode = "probe",
  preparedClaimPlan?: NodeCreateClaimPlan,
): Promise<NodeCreatePrepared> {
  const { kind, id, validatedProps, uniqueConstraints } = draft;
  const claimPlan =
    preparedClaimPlan ??
    planNodeCreateClaims(
      { graphId: ctx.graphId, registry: ctx.registry },
      { kind, id, props: validatedProps, constraints: uniqueConstraints },
    );

  // Claim-free caller ids are the one safe shape for an insert-first path. A
  // pre-insert claim would have to be compensated when `DO NOTHING` reports an
  // occupied row; keep that larger transition out of this optimization until it
  // has its own atomic claim outcome. `nodeClaimEntries` is the single owner of
  // whether either uniqueness or disjointness applies, so this does not grow a
  // second spelling of the constraint decision.
  const insertIfAbsent =
    allowInsertIfAbsent &&
    draft.idProvided &&
    backend.insertNodeIfAbsent !== undefined &&
    nodeClaimEntries(
      ctx.registry,
      kind,
      id,
      validatedProps,
      uniqueConstraints,
      "create",
    ).length === 0;

  // Generated ids are fresh by construction on the ordinary path. The atomic
  // path deliberately skips this read for caller ids too: its backend program
  // owns absent-insert, tombstone-resurrection, and live-duplicate semantics.
  const existingNode =
    mode === "atomic-batch" ? undefined
    : draft.idProvided && !insertIfAbsent ?
      await backend.getNode(ctx.graphId, kind, id)
    : undefined;
  if (existingNode && !existingNode.deleted_at) {
    throw createAlreadyExistsError("node", kind, id);
  }

  // A fresh row whose claims are going through the transaction-scoped
  // planned insert gets its ownership verdict from that statement. Keep the
  // same probes for fallback backends, no-return writes, and tombstones (the
  // latter route through the resurrection transition rather than this plan).
  const deferConstraintProbes =
    (mode === "authoritative-plan" || mode === "atomic-batch") &&
    existingNode === undefined &&
    claimPlan.claims.length > 0;
  if (mode !== "atomic-batch" && !deferConstraintProbes) {
    const constraintContext: ConstraintContext = {
      graphId: ctx.graphId,
      registry: ctx.registry,
      backend,
    };
    // Disjointness is also keyed by the id. A generated id cannot already be
    // present under a disjoint kind, so its cross-kind reads are the same pure
    // cost as the same-kind existence probe above.
    if (draft.idProvided && !insertIfAbsent) {
      await checkDisjointnessConstraint(constraintContext, kind, id);
    }

    await checkUniquenessConstraints(
      createUniquenessContext(
        ctx.graphId,
        ctx.registry,
        backend,
        ctx.uniqueSidecarBatch,
      ),
      kind,
      id,
      validatedProps,
      uniqueConstraints,
    );
  }

  return {
    kind,
    id,
    idProvided: draft.idProvided,
    claimPlan,
    tombstone: existingNode,
    insertIfAbsent,
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

/** What a prepared create hands the claim seam and the sync fans. */
function nodeCreateSideEffectItem(
  prepared: NodeCreatePrepared,
): NodeInsertSyncItem {
  return {
    kind: prepared.kind,
    id: prepared.id,
    schema: prepared.nodeKind.schema,
    props: prepared.validatedProps,
    uniqueConstraints: prepared.uniqueConstraints,
  };
}

function nodeCreateClaimItem(prepared: NodeCreatePrepared): NodeClaimItem {
  return {
    kind: prepared.kind,
    id: prepared.id,
    props: prepared.validatedProps,
    constraints: prepared.uniqueConstraints,
  };
}

/** Resolves every projection owed by a fresh generated-id node in one place. */
function resolveNodeInsertProjections(
  schema: z.ZodType,
  props: Record<string, unknown>,
): readonly NodeInsertProjection[] {
  const fulltext = resolveNodeFulltextProjection(schema, props);
  return [
    ...(fulltext === undefined ? [] : [fulltext]),
    ...resolveNodeEmbeddingProjections(schema, props),
  ];
}

/** Complete projection transitions for an atomic node postimage. */
function resolveAtomicNodeProjections(
  schema: z.ZodType,
  props: Record<string, unknown>,
  options?: Readonly<{ omitEmbeddingDeletes?: boolean }>,
): readonly AtomicNodeProjection[] {
  const fulltext = resolveNodeFulltextProjection(schema, props);
  return [
    ...(fulltext === undefined ? [] : [fulltext]),
    ...resolveNodeEmbeddingProjectionTransitions(schema, props, {
      omitDeletes: options?.omitEmbeddingDeletes === true,
    }),
  ];
}

/**
 * One prepared create as the session's insert unit: the row params, the claims
 * the row owes, and the sidecar inputs, as ONE value.
 *
 * This replaces the `finalizeNodeCreate` / `finalizeNodeCreateBatch` pair and
 * the claim seam the create paths used to open around their own insert. Each was
 * a HALF of a create, callable — and forgettable — on its own; the session takes
 * the whole unit and applies all three in the pinned order (pre-insert claims,
 * row, post-insert claims, sync fans).
 */
function nodeCreateWork(
  prepared: NodeCreatePrepared,
  projections: readonly NodeInsertProjection[] = [],
  allowNonTransactionalClaims = false,
): NodeCreateWork {
  return {
    params: prepared.insertParams,
    idGenerated: !prepared.idProvided,
    allowNonTransactionalClaims,
    claim: nodeCreateClaimItem(prepared),
    claimPlan: prepared.claimPlan,
    sideEffects: nodeCreateSideEffectItem(prepared),
    projections,
  };
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

type NodeUpdateExecutionOptions = Readonly<{
  clearDeleted?: boolean;
  replacementProps?: Record<string, unknown>;
}>;

async function performNodeUpdate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: UpsertUpdateNodeInput,
  session: NodeWriteSession,
  target: WriteTarget,
  options?: NodeUpdateExecutionOptions,
  resolvedExisting?: BackendNodeRow,
): Promise<Node> {
  const { kind, id } = input;

  assertValidityEndMutation(input, { entityType: "node", kind, id });

  const existing =
    resolvedExisting ?? (await target.getNode(ctx.graphId, kind, id));
  if (!existing) throw new NodeNotFoundError(kind, id);

  const { registration, validatedProps } =
    options?.replacementProps === undefined ?
      resolveNodeUpdateProps(ctx, existing, input.props)
    : {
        registration: getNodeRegistration(ctx.graph, kind),
        validatedProps: options.replacementProps,
      };
  const nodeKind = registration.type;

  const validTo = validateOptionalCanonicalIsoDate(input.validTo, "validTo");
  // A node resurrection RESETS `valid_from` (see `buildUpdateNode`), so its
  // effective lower bound is one this write stamps rather than the row's stored
  // one. The instant is sampled HERE and the bound resolved from it travels to
  // the backend as an explicit `validFrom`, because the guard has to measure
  // the bound the write will actually store: left to default, the builder's own
  // `resolveStampedValidityLowerBound` call would judge the backend's strictly
  // later sample, and a `validTo` at this instant would pass the guard as
  // zero-width and land as a different shape a millisecond later (issue #413).
  // An in-place update keeps the row's stored bound, which no write rewrites and
  // so needs no prediction.
  const resurrectionInstant =
    options?.clearDeleted === true && existing.deleted_at !== undefined ?
      nowIso()
    : undefined;
  // Event materializers may state the source row's lower bound on every
  // delivery while asking a live update to preserve the bound already stored.
  // This is explicit create/resurrection-only input, not the old silent drop:
  // the default remains `"refuse"`, and a resurrection still validates and
  // stores the stated value below.
  const preservesLiveLowerBound =
    resurrectionInstant === undefined &&
    preservesImmutableLowerBound(input.onImmutableLowerBound);
  const statedValidFrom = validateStatedValidityLowerBound(
    input.validFrom,
    "validFrom",
  );
  const validFrom = preservesLiveLowerBound ? undefined : statedValidFrom;
  // The bound this resurrection will STORE, decided by the same owner every
  // insert builder decides through, against the instant sampled above. Asking
  // the owner rather than assuming `resurrectionInstant` is what makes a
  // resurrection carrying only a historical `validTo` reach the shape a create
  // reaches — no lower bound, "ended at T, start unknown" — instead of being
  // refused for inverting against an instant the write would never have stored
  // (I12). `undefined` here means "no bound", which is nothing to invert
  // against, so the verdict below judges exactly what lands.
  const resurrectionBound =
    resurrectionInstant === undefined ? undefined : (
      resolveStampedValidityLowerBound(validFrom, validTo, resurrectionInstant)
    );
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
        effectiveBoundIsStored: true,
      }
    : {
        effectiveValidFrom: resurrectionBound,
        appliesStatedValidFrom: true,
        // The bound this write is about to stamp, not one the row holds.
        effectiveBoundIsStored: false,
      },
    validTo,
  );

  const shared = {
    schema: nodeKind.schema,
    validatedProps,
    uniqueConstraints: registration.unique ?? [],
    ...(validTo !== undefined && { validTo }),
    ...(input.clearValidTo === true && { clearValidTo: true as const }),
  };
  // The bound the verdict above READ, carried into the UPDATE's own `WHERE` so
  // the row this writes is the row that was judged. The verdict hands over the
  // predicate rather than a flag, so both conditions that decide it — did the
  // verdict consult the effective bound, and WAS that bound the row's stored
  // one — are answered where they are known. A plain `update({ props })`
  // states no window, reads no bound, and stays unfenced: the same rule
  // `UpdateEdgeParams`'s identity components follow, for the same reason. The
  // resurrecting leg is judged against `resurrectionInstant` and so fences on
  // `deleted_at IS NOT NULL` alone, converging through the recovery below.
  //
  // It is now a REQUIRED argument rather than a spread convention: an update
  // that forgot to carry the bound its verdict read is a compile error.
  const fences: NodeUpdateFences = {
    validityLowerBound: windowVerdict.storedLowerBoundFence,
  };

  // A resurrecting upsert (clearDeleted) may target a tombstoned row; a plain
  // update must prove the row live — see NodeUpdateTarget.
  if (options?.clearDeleted) {
    // Keyed on the SAME condition the verdict was, because only that condition
    // produces a verdict to state. With `resurrectionInstant` defined this is
    // the DECISION, never an absence: omitting the key would let
    // `buildUpdateNode` re-derive the bound against the backend's own, strictly
    // later `timestamp`, so the two layers would agree only while the two clocks
    // do — the #413 hazard, one layer out. `null` is how `UpdateNodeParams`
    // spells "store no lower bound", which is what this decision resolves to for
    // a resurrection that ends at or before the instant it judged.
    //
    // With it UNDEFINED this read found the row live — a peer resurrected it
    // between the collection's probe and here — so the verdict judged the row's
    // stored bound and stamped nothing. There is no decision to state, and
    // stating one anyway would write away a `validFrom` the guard just ACCEPTED
    // as equal to that stored bound. The statement usually matches no row
    // (`deleted_at IS NOT NULL`) and the recovery below re-reads, but a peer that
    // re-tombstones before the UPDATE makes it match, so this leg carries the
    // stated bound exactly as the in-place leg does.
    const resurrectionLowerBound =
      resurrectionInstant === undefined ?
        validFrom !== undefined && { validFrom }
        // eslint-disable-next-line unicorn/no-null -- `validFrom: null` means "store NULL"; omitting the key means "decide for me", and this path has already decided. See UpdateNodeParams.validFrom.
      : { validFrom: resurrectionBound ?? null };
    const row = await session.reviseNode(
      { ...shared, existing, clearDeleted: true, ...resurrectionLowerBound },
      fences,
    );
    return rowToNode(row);
  }

  if (!isLiveNodeRow(existing)) throw new NodeNotFoundError(kind, id);
  const row = await session.reviseNode(
    // An in-place update must not rewrite the stored bound, so it keeps the
    // conditional spread: `buildUpdateNode` ignores `validFrom` off the
    // resurrection leg, and stating one here would claim a rewrite that no
    // statement performs.
    { ...shared, existing, ...(validFrom !== undefined && { validFrom }) },
    fences,
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
  session: NodeWriteSession,
  target: WriteTarget,
  options?: NodeUpdateExecutionOptions,
  resolvedExisting?: BackendNodeRow,
): Promise<Node> {
  for (let attempt = 1; attempt <= NODE_UPDATE_ATTEMPTS; attempt += 1) {
    try {
      // Only the FIRST attempt may resurrect: reaching a retry means the row is
      // live, and an ordinary update is what converges on it.
      return await performNodeUpdate(
        ctx,
        input,
        session,
        target,
        attempt === 1 ? options
        : options?.replacementProps === undefined ? undefined
        : { replacementProps: options.replacementProps },
        attempt === 1 ? resolvedExisting : undefined,
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
  ctx: Readonly<{
    graphId: string;
    registry: KindRegistry;
    batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>;
    uniqueSidecarBatch: BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH>;
  }>,
  drafts: readonly NodeCreateDraft[],
  backend: WriteTarget,
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
  const boundGetNodes = bindExtraIfReachable(
    backend,
    ctx.batchPointRead.extras.getNodes,
    BATCH_POINT_READ.id,
  );
  if (boundGetNodes !== undefined) {
    const idsByKind = new Map<string, Set<string>>();
    for (const draft of drafts) {
      // Generated ids follow the same insert-first contract as the singleton
      // create path: there is no existing row to classify or resurrect, and a
      // vanishingly unlikely primary-key collision is authoritatively refused
      // by the INSERT. Priming those ids performed a guaranteed-empty read and
      // added one transport exchange to every generated-id bulk create.
      if (!draft.idProvided) continue;
      const ids = idsByKind.get(draft.kind) ?? new Set<string>();
      ids.add(draft.id);
      idsByKind.set(draft.kind, ids);
    }
    for (const [kind, ids] of idsByKind) {
      const orderedIds = [...ids];
      const rows = await boundGetNodes.getNodes(ctx.graphId, kind, orderedIds);
      const rowsById = new Map(rows.map((row) => [row.id, row]));
      for (const id of orderedIds) {
        seams.seedNodeRow(kind, id, rowsById.get(id));
      }
    }
  }

  const boundCheckUniqueBatch = bindExtraIfReachable(
    backend,
    ctx.uniqueSidecarBatch.extras.checkUniqueBatch,
    UNIQUE_SIDECAR_BATCH.id,
  );
  if (boundCheckUniqueBatch !== undefined) {
    const groups = groupNodeUniquenessProbes(
      ctx.registry,
      drafts.map((draft) => ({
        kind: draft.kind,
        entries: nodeClaimEntries(
          ctx.registry,
          draft.kind,
          draft.id,
          draft.validatedProps,
          draft.uniqueConstraints,
          "create",
        ),
      })),
    );
    for (const group of groups) {
      const rows = await boundCheckUniqueBatch.checkUniqueBatch({
        graphId: ctx.graphId,
        nodeKind: group.nodeKind,
        constraintName: group.constraintName,
        keys: group.keys,
      });
      const rowsByKey = new Map(rows.map((row) => [row.key, row]));
      for (const key of group.keys) {
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
  backend: WriteTarget,
  options?: NodeCreateInternalOptions,
): Promise<readonly NodeCreatePrepared[]> {
  const {
    reader: validationBackend,
    registerPendingNode,
    registerPendingUniqueEntries,
    seedNodeRow,
    seedUniqueRow,
  } = createNodeBatchValidationSeams(ctx.graphId, ctx.registry, backend);

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
      false,
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

/**
 * Prepares the closed atomic node-batch shape without any external reads.
 *
 * The draft and claim planners remain the owners of validation and claim
 * semantics. The atomic backend owns row-state semantics, so this preparation
 * records the caller/generated source for every id and rejects duplicate
 * (graph, kind, id) inputs before dispatch.
 */
async function prepareAtomicBatchCreates<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  inputs: readonly CreateNodeInput[],
  backend: WriteTarget,
  options?: NodeCreateInternalOptions,
): Promise<readonly NodeCreatePrepared[]> {
  const drafts = inputs.map((input) =>
    draftNodeCreate(ctx, input, input.id ?? generateId(), options),
  );

  const seen = new Set<string>();
  for (const draft of drafts) {
    const key = buildNodeCacheKey(ctx.graphId, draft.kind, draft.id);
    if (seen.has(key)) {
      throw createAlreadyExistsError("node", draft.kind, draft.id);
    }
    seen.add(key);
  }

  return Promise.all(
    drafts.map(async (draft) => {
      const claimPlan = planNodeCreateClaims(
        { graphId: ctx.graphId, registry: ctx.registry },
        {
          kind: draft.kind,
          id: draft.id,
          props: draft.validatedProps,
          constraints: draft.uniqueConstraints,
        },
      );
      return finishNodeCreatePreparation(
        ctx,
        draft,
        backend,
        false,
        "atomic-batch",
        claimPlan,
      );
    }),
  );
}

function atomicNodeBatchEntries(
  preparedCreates: readonly NodeCreatePrepared[],
  claimSupport: AtomicNodeClaimSupport | undefined,
): readonly AtomicNodeBatchEntry[] | undefined {
  const entries: AtomicNodeBatchEntry[] = [];
  const ownerByClaimTarget = new Map<
    string,
    Readonly<{ kind: string; id: string }>
  >();
  for (const prepared of preparedCreates) {
    const projections = resolveAtomicNodeProjections(
      prepared.nodeKind.schema,
      prepared.validatedProps,
      { omitEmbeddingDeletes: !prepared.idProvided },
    );
    if (prepared.claimPlan.claims.length === 0) {
      entries.push({
        idSource: prepared.idProvided ? "caller" : "generated",
        params: prepared.insertParams,
        projections,
      });
      continue;
    }

    const rephased = rephaseAtomicNodeClaimPlan(
      {
        entity: "node",
        params: prepared.insertParams,
        idGenerated: !prepared.idProvided,
        mode: { kind: "ordinary" },
        claims: prepared.claimPlan.claims,
        projections: [],
      },
      claimSupport,
    );
    if (rephased === undefined) return;
    for (const claim of rephased.claims) {
      const targetKey = encodeTupleKey([
        prepared.insertParams.graphId,
        claim.axis,
        claim.constraintName,
        claim.key,
      ]);
      const existingOwner = ownerByClaimTarget.get(targetKey);
      if (existingOwner !== undefined) {
        const error = new UniquenessError({
          constraintName: claim.constraintName,
          kind: existingOwner.kind,
          existingId: existingOwner.id,
          newId: prepared.id,
          fields:
            claim.verdict.kind === "uniqueness" ? claim.verdict.fields : [],
          axis: claim.axis,
        });
        refuseNodeCreateClaimError(error, prepared.claimPlan);
      }
      ownerByClaimTarget.set(targetKey, {
        kind: prepared.kind,
        id: prepared.id,
      });
    }
    entries.push({
      idSource: prepared.idProvided ? "caller" : "generated",
      params: prepared.insertParams,
      claims: rephased.claims,
      projections,
    });
  }
  if (
    entries.some(
      (entry) => !supportsAtomicNodeClaims(claimSupport, entry.claims ?? []),
    )
  ) {
    return;
  }
  return entries;
}

/**
 * Validates a replacement document once for both atomic and portable paths.
 * The portable update carries this complete postimage through its internal
 * replacement marker instead of parsing or merging it again.
 */
export function prepareNodeReplacement<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const schema = getNodeRegistration(ctx.graph, kind).type.schema;
  return validateNodeProps(schema, props, { kind, operation: "update" });
}

/**
 * Attempts one read-free, schema-fenced replacement program.
 *
 * `unsupported` proves that no SQL ran; the collection then enters the full
 * portable upsert path with the replacement patches prepared above.
 */
export async function executeNodeReplacementBatch<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  items: readonly Readonly<{ id: string; props: Record<string, unknown> }>[],
  backend: GraphBackend | TransactionBackend,
): Promise<ResolvedMutationSetAttempt<readonly Node[]>> {
  if (items.length === 0) return appliedResolvedMutationSet([]);
  const program = resolveAtomicNodeReplacementBatchProgram({
    backend,
    graph: ctx.graph,
    registry: ctx.registry,
    kind,
    entryCount: items.length,
    schemaVersion: ctx.schemaVersion,
    identityEnabled: ctx.identity !== undefined,
    historyEnabled: ctx.historyEnabled,
    revisionTrackingEnabled: ctx.revisionTrackingEnabled,
  });
  if (program === undefined) return unsupportedResolvedMutationSet();
  const { executor, releaseClaims } = program;

  const inputs = items.map((item) => ({
    kind,
    id: item.id,
    props: item.props,
  }));
  const preparedCreates = await prepareAtomicBatchCreates(
    ctx,
    inputs,
    backend,
    { propsPreValidated: true },
  );
  const createEntries = atomicNodeBatchEntries(
    preparedCreates,
    executor.claimSupport,
  );
  if (createEntries === undefined) return unsupportedResolvedMutationSet();
  const entries: readonly AtomicNodeReplacementEntry[] = createEntries.map(
    ({ params, claims, projections }) => ({
      params,
      ...(claims === undefined ? {} : { claims }),
      ...(projections === undefined ? {} : { projections }),
    }),
  );
  if (executor.accepts?.(entries) === false) {
    return unsupportedResolvedMutationSet();
  }
  const returnedRows = await withAtomicNodeClaimTranslation(
    preparedCreates,
    () =>
      executor({
        entries,
        releaseClaims,
        schemaFence: {
          graphId: ctx.graphId,
          expectedVersion: requireDefined(ctx.schemaVersion),
        },
      }),
  );
  if (returnedRows.length === 0) {
    await diagnoseAtomicNodeBatchNoRow(ctx, backend, preparedCreates);
  }
  if (returnedRows.length !== items.length) {
    throw new DatabaseOperationError(
      "Atomic node replacement returned a partial result.",
      {
        operation: "upsert",
        entity: "node",
        attempted: items.map((item) => ({ kind, id: item.id })),
      },
    );
  }
  memoizeLeasedSchemaFence(ctx, backend);
  return appliedResolvedMutationSet(
    restoreAtomicNodeBatchRows(ctx.graphId, preparedCreates, returnedRows).map(
      (row) => rowToNode(row),
    ),
  );
}

async function withAtomicNodeClaimTranslation<TResult>(
  preparedCreates: readonly NodeCreatePrepared[],
  execute: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await execute();
  } catch (error) {
    refuseNodeCreateClaimError(error, {
      entries: preparedCreates.flatMap(
        (prepared) => prepared.claimPlan.entries,
      ),
      claims: preparedCreates.flatMap((prepared) => prepared.claimPlan.claims),
      verdicts: preparedCreates.flatMap(
        (prepared) => prepared.claimPlan.verdicts,
      ),
    });
  }
}

/** Bounds concurrent custom-backend reads on the exceptional diagnosis path. */
const ATOMIC_NODE_CLAIM_DIAGNOSTIC_WINDOW_SIZE = 32;

type AtomicNodeClaimDiagnosticVerdict =
  Readonly<{ kind: "clear" }> | Readonly<{ kind: "refusal"; error: unknown }>;

const ATOMIC_NODE_CLAIM_CLEAR = { kind: "clear" } as const;

async function captureAtomicNodeClaimDiagnosticVerdicts(
  preparedCreates: readonly NodeCreatePrepared[],
  diagnose: (prepared: NodeCreatePrepared) => Promise<void>,
): Promise<readonly AtomicNodeClaimDiagnosticVerdict[]> {
  return Promise.all(
    preparedCreates.map(async (prepared) => {
      try {
        await diagnose(prepared);
        return ATOMIC_NODE_CLAIM_CLEAR;
      } catch (error) {
        return { kind: "refusal" as const, error };
      }
    }),
  );
}

async function runAtomicNodeClaimDiagnosticGroups<T>(
  groups: readonly T[],
  read: (group: T) => Promise<void>,
): Promise<void> {
  for (const window of chunk(
    groups,
    ATOMIC_NODE_CLAIM_DIAGNOSTIC_WINDOW_SIZE,
  )) {
    await Promise.all(window.map(async (group) => read(group)));
  }
}

async function diagnoseAtomicNodeDisjointness<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  backend: GraphBackend | TransactionBackend,
  preparedCreates: readonly NodeCreatePrepared[],
): Promise<readonly AtomicNodeClaimDiagnosticVerdict[]> {
  const boundGetNodes = bindExtraIfReachable(
    backend,
    ctx.batchPointRead.extras.getNodes,
    BATCH_POINT_READ.id,
  );
  const constraintContext: ConstraintContext = {
    graphId: ctx.graphId,
    registry: ctx.registry,
    backend,
  };
  if (boundGetNodes === undefined) {
    return captureAtomicNodeClaimDiagnosticVerdicts(
      preparedCreates,
      async (prepared) =>
        checkDisjointnessConstraint(
          constraintContext,
          prepared.kind,
          prepared.id,
        ),
    );
  }

  type DisjointReadGroup = Readonly<{ kind: string; ids: Set<string> }>;
  const disjointKindsByInput = preparedCreates.map((prepared) =>
    ctx.registry.getDisjointKinds(prepared.kind),
  );
  const groupsByKind = new Map<string, DisjointReadGroup>();
  for (const [index, prepared] of preparedCreates.entries()) {
    for (const kind of requireDefined(disjointKindsByInput[index])) {
      const group = groupsByKind.get(kind) ?? { kind, ids: new Set<string>() };
      group.ids.add(prepared.id);
      groupsByKind.set(kind, group);
    }
  }

  const rowsByReference = new Map<string, BackendNodeRow>();
  await runAtomicNodeClaimDiagnosticGroups(
    [...groupsByKind.values()],
    async (group) => {
      const rows = await boundGetNodes.getNodes(ctx.graphId, group.kind, [
        ...group.ids,
      ]);
      for (const row of rows) {
        rowsByReference.set(refKey({ kind: row.kind, id: row.id }), row);
      }
    },
  );

  return preparedCreates.map((prepared, index) => {
    for (const conflictingKind of requireDefined(disjointKindsByInput[index])) {
      const row = rowsByReference.get(
        refKey({ kind: conflictingKind, id: prepared.id }),
      );
      if (row === undefined || !isLiveNodeRow(row)) continue;
      const error = checkDisjointness(
        prepared.id,
        prepared.kind,
        [conflictingKind],
        ctx.registry,
      );
      if (error !== undefined) return { kind: "refusal" as const, error };
    }
    return ATOMIC_NODE_CLAIM_CLEAR;
  });
}

async function diagnoseAtomicNodeUniqueness<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  backend: GraphBackend | TransactionBackend,
  preparedCreates: readonly NodeCreatePrepared[],
): Promise<readonly AtomicNodeClaimDiagnosticVerdict[]> {
  const boundCheckUniqueBatch = bindExtraIfReachable(
    backend,
    ctx.uniqueSidecarBatch.extras.checkUniqueBatch,
    UNIQUE_SIDECAR_BATCH.id,
  );
  const uniquenessContext = createUniquenessContext(
    ctx.graphId,
    ctx.registry,
    backend,
    ctx.uniqueSidecarBatch,
  );
  if (boundCheckUniqueBatch === undefined) {
    return captureAtomicNodeClaimDiagnosticVerdicts(
      preparedCreates,
      async (prepared) =>
        checkUniquenessConstraints(
          uniquenessContext,
          prepared.kind,
          prepared.id,
          prepared.validatedProps,
          prepared.uniqueConstraints,
        ),
    );
  }

  const probeItems = preparedCreates.map((prepared) => ({
    kind: prepared.kind,
    entries: nodeClaimEntries(
      ctx.registry,
      prepared.kind,
      prepared.id,
      prepared.validatedProps,
      prepared.uniqueConstraints,
      "create",
    ),
  }));
  const groups = groupNodeUniquenessProbes(ctx.registry, probeItems);

  const rowsByTarget = new Map<string, UniqueRow>();
  await runAtomicNodeClaimDiagnosticGroups(groups, async (group) => {
    const rows = await boundCheckUniqueBatch.checkUniqueBatch({
      graphId: ctx.graphId,
      nodeKind: group.nodeKind,
      constraintName: group.constraintName,
      keys: group.keys,
    });
    for (const row of rows) {
      rowsByTarget.set(
        encodeTupleKey([group.nodeKind, group.constraintName, row.key]),
        row,
      );
    }
  });

  return Promise.all(
    preparedCreates.map(async (prepared, index) => {
      for (const entry of requireDefined(probeItems[index]).entries) {
        if (!isUniquenessClaimEntry(entry)) continue;
        try {
          await probeUniqueKey(
            uniquenessContext,
            prepared.kind,
            prepared.id,
            entry,
            (nodeKind, claimEntry) =>
              rowsByTarget.get(
                encodeTupleKey([
                  nodeKind,
                  claimEntry.constraintName,
                  claimEntry.key,
                ]),
              ),
          );
        } catch (error) {
          return { kind: "refusal" as const, error };
        }
      }
      return ATOMIC_NODE_CLAIM_CLEAR;
    }),
  );
}

/**
 * Diagnoses a database-enforced all-or-nothing claim refusal after rollback.
 *
 * The atomic program deliberately reports only the rollback sentinel: claim
 * ownership is read again from committed state so a successful sibling chunk
 * can never be mistaken for permission to commit. These are the same portable
 * verdict owners used outside the native program, preserving their typed errors
 * and input order on the failure-only path.
 */
async function diagnoseAtomicNodeBatchNoRow<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  backend: GraphBackend | TransactionBackend,
  preparedCreates: readonly NodeCreatePrepared[],
): Promise<never> {
  await diagnoseFusedSchemaFenceNoRow(ctx, backend);
  const hasSetOrientedDiagnosis =
    bindExtraIfReachable(
      backend,
      ctx.batchPointRead.extras.getNodes,
      BATCH_POINT_READ.id,
    ) !== undefined &&
    bindExtraIfReachable(
      backend,
      ctx.uniqueSidecarBatch.extras.checkUniqueBatch,
      UNIQUE_SIDECAR_BATCH.id,
    ) !== undefined;
  const diagnosticWindows =
    hasSetOrientedDiagnosis ?
      [preparedCreates]
    : chunk(preparedCreates, ATOMIC_NODE_CLAIM_DIAGNOSTIC_WINDOW_SIZE);
  for (const window of diagnosticWindows) {
    const [disjointnessVerdicts, uniquenessVerdicts] =
      hasSetOrientedDiagnosis ?
        await Promise.all([
          diagnoseAtomicNodeDisjointness(ctx, backend, window),
          diagnoseAtomicNodeUniqueness(ctx, backend, window),
        ])
      : [
          await diagnoseAtomicNodeDisjointness(ctx, backend, window),
          await diagnoseAtomicNodeUniqueness(ctx, backend, window),
        ];
    for (const [index] of window.entries()) {
      const disjointness = requireDefined(disjointnessVerdicts[index]);
      if (disjointness.kind === "refusal") throw disjointness.error;
      const uniqueness = requireDefined(uniquenessVerdicts[index]);
      if (uniqueness.kind === "refusal") throw uniqueness.error;
    }
  }
  throw new DatabaseOperationError(
    "Atomic node batch returned no postimages, but current schema-fence and " +
      "claim state do not explain the refusal. Database state may have " +
      "changed after the atomic program rolled back.",
    {
      operation: "insert",
      entity: "node",
      attempted: preparedCreates.map((prepared) => ({
        kind: prepared.kind,
        id: prepared.id,
      })),
    },
  );
}

/**
 * The backend may return rows in any order. Validate the complete result set
 * before restoring caller order so a malformed native result cannot silently
 * attach one returned payload to another input.
 */
function restoreAtomicNodeBatchRows(
  graphId: string,
  preparedCreates: readonly NodeCreatePrepared[],
  returnedRows: readonly BackendNodeRow[],
): readonly BackendNodeRow[] {
  const rowsByReference = new Map<string, BackendNodeRow>();
  for (const row of returnedRows) {
    if (row.graph_id !== graphId) {
      throw new CompilerInvariantError(
        "Atomic node batch returned a row for the wrong graph.",
        { expectedGraphId: graphId, actualGraphId: row.graph_id },
      );
    }
    const key = refKey({ kind: row.kind, id: row.id });
    if (rowsByReference.has(key)) {
      throw new CompilerInvariantError(
        "Atomic node batch returned duplicate node references.",
        { kind: row.kind, id: row.id },
      );
    }
    rowsByReference.set(key, row);
  }

  return preparedCreates.map((prepared) => {
    const row = rowsByReference.get(
      refKey({ kind: prepared.kind, id: prepared.id }),
    );
    if (row === undefined) {
      throw new CompilerInvariantError(
        "Atomic node batch omitted a written node row.",
        { kind: prepared.kind, id: prepared.id },
      );
    }
    return row;
  });
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
  session: NodeWriteSession,
  target: WriteTarget,
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
  // A create landing on a tombstone RESETS the window, so this leg stamps a
  // bound whenever the caller stated none — and it decides which one through
  // the same owner `performNodeUpdate`'s resurrection leg and every insert
  // builder use, against an instant sampled HERE. Two consequences. The stored
  // bound is the one this layer judged rather than the backend's strictly later
  // sample, so one write has one instant (issue #413). And a create carrying
  // only a historical `validTo` reaches the same stored shape on a tombstoned
  // id as on a fresh one — no lower bound (I12).
  const resurrectionInstant = nowIso();
  const resurrectionBound = resolveStampedValidityLowerBound(
    prepared.insertParams.validFrom,
    prepared.insertParams.validTo,
    resurrectionInstant,
  );
  try {
    return await session.reviseNode(
      {
        existing: current,
        clearDeleted: true,
        schema: prepared.nodeKind.schema,
        validatedProps: prepared.validatedProps,
        uniqueConstraints: prepared.uniqueConstraints,
        // The decision itself, never an absence — see the same spelling on
        // `performNodeUpdate`'s resurrection leg.
        // eslint-disable-next-line unicorn/no-null -- `validFrom: null` means "store NULL"; omitting the key means "decide for me", and this path has already decided. See UpdateNodeParams.validFrom.
        validFrom: resurrectionBound ?? null,
        ...(prepared.insertParams.validTo === undefined ?
          {}
        : { validTo: prepared.insertParams.validTo }),
      },
      // This resurrection reads no stored bound: it rewrites the whole window
      // and is fenced by the UPDATE's own `deleted_at IS NOT NULL` predicate,
      // so it asserts nothing about `valid_from`. `{}` is how a write states
      // that, and it is the only way to state it.
      { validityLowerBound: {} },
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

/**
 * THE preference rule when a key has claim rows at more than one kind — which a
 * database carrying pre-axis rows legitimately can, at the axis AND at a
 * concrete kind, with different owners:
 *
 * 1. Visit the AXIS first, then the remaining kinds in scope in code-point
 *    order — the order {@link uniquenessProbeKinds} defines, so this reads what
 *    the write path claims before it reads what an older version claimed.
 * 2. Prefer a LIVE row over a tombstoned one, wherever each was found: a
 *    tombstone is a released reservation, and reviving it while a live holder
 *    exists would hand the caller the wrong node.
 * 3. Among rows of the same liveness prefer the axis row, which rule 1 already
 *    delivers.
 *
 * Stated rather than left to iteration order because `getOrCreateByConstraint`
 * decides which node to revive from it.
 */
function prefersClaimRow(
  incumbent: UniqueMatchRow | undefined,
  candidate: UniqueMatchRow,
): boolean {
  if (incumbent === undefined) return true;
  return (
    incumbent.deleted_at !== undefined && candidate.deleted_at === undefined
  );
}

async function findUniqueRowAcrossKinds(
  backend: WriteTarget,
  graphId: string,
  constraintName: string,
  key: string,
  kindsToCheck: readonly string[],
  includeDeleted: boolean,
): Promise<UniqueMatchRow | undefined> {
  // `let` earns its place: a tombstoned hit does not end the search, because a
  // live row later in the order outranks it (rule 2).
  let preferred: UniqueMatchRow | undefined;
  for (const kindToCheck of kindsToCheck) {
    const row = await backend.checkUnique({
      graphId,
      nodeKind: kindToCheck,
      constraintName,
      key,
      includeDeleted,
    });
    if (row === undefined) continue;
    if (!prefersClaimRow(preferred, row)) continue;
    preferred = row;
    if (row.deleted_at === undefined) return row;
  }
  return preferred;
}

interface UniqueMatchRow {
  node_id: string;
  concrete_kind: string;
  deleted_at: string | undefined;
}

async function batchCheckUniqueAcrossKinds(
  backend: WriteTarget,
  uniqueSidecarBatch: BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH>,
  graphId: string,
  constraintName: string,
  uniqueKeys: readonly string[],
  kindsToCheck: readonly string[],
  includeDeleted: boolean,
): Promise<Map<string, UniqueMatchRow>> {
  const existingByKey = new Map<string, UniqueMatchRow>();
  const boundCheckUniqueBatch = bindExtraIfReachable(
    backend,
    uniqueSidecarBatch.extras.checkUniqueBatch,
    UNIQUE_SIDECAR_BATCH.id,
  );

  for (const kindToCheck of kindsToCheck) {
    if (boundCheckUniqueBatch === undefined) {
      for (const key of uniqueKeys) {
        const incumbent = existingByKey.get(key);
        if (incumbent !== undefined && incumbent.deleted_at === undefined) {
          continue;
        }
        const row = await backend.checkUnique({
          graphId,
          nodeKind: kindToCheck,
          constraintName,
          key,
          includeDeleted,
        });
        if (row !== undefined && prefersClaimRow(incumbent, row)) {
          existingByKey.set(row.key, row);
        }
      }
    } else {
      const rows = await boundCheckUniqueBatch.checkUniqueBatch({
        graphId,
        nodeKind: kindToCheck,
        constraintName,
        keys: uniqueKeys,
        includeDeleted,
      });
      for (const row of rows) {
        if (prefersClaimRow(existingByKey.get(row.key), row)) {
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

/**
 * Item E.2. Inserts one create's composition edge, in the SAME transaction
 * the node row lands in, through the ordinary edge-create validation/prepare
 * pipeline (`validateAndPrepareEdgeCreate`/`edgeInsertWork`,
 * `edge-operations.ts`) — the identical work a caller's own
 * `store.edges.<kind>.create(...)` would run, just issued against this
 * frame's `target`/`session` instead of opening a second write. A failed
 * edge (a lost `COMPOSITION_WHOLE_OCCUPIED` claim, a dead or missing whole
 * endpoint, a cardinality or acyclicity refusal) throws and aborts the node
 * create too — `edgeInsertClaims` (`composition-claims.ts`) remains the
 * sole owner of the claim; this adds none. A no-op when `work` is
 * `undefined` (the ordinary, no-`partOf` create), so every call site can
 * call it unconditionally.
 *
 * Item E.2: a required-existence part must never be BORN unattached.
 * `resolveCompositionCreate` already refuses a bare create with no `partOf`
 * for that reason, but the node's own validity window (`temporal`, forwarded
 * verbatim onto the composition edge) can still make the edge it DOES
 * create non-attaching from the start — e.g. a `population: "oneActive"`
 * pair created with a `validTo` already in the past. Left unchecked, that
 * create would succeed and `store.verifyConstraintFences()` would
 * immediately report the row as a `compositionExistence` violation. Checked
 * here, against the edge input this call is ABOUT to issue, with
 * `edgeCurrentlyAttachesPart` — the same predicate
 * `assertCompositionExistencePreserved`/`findLiveCompositionWhole`/the
 * constraint-fence audit all read — rather than a second, drift-prone
 * spelling of "does this edge attach".
 */
async function attachCompositionCreateEdge<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  session: WriteSession,
  target: WriteTarget,
  lock: GraphWriteLock,
  work: CompositionCreateWork | undefined,
  partId: string,
  temporal: Readonly<{ validFrom?: string | null; validTo?: string }> = {},
): Promise<void> {
  if (work === undefined) return;
  if (
    ctx.registry.compositionExistence(work.partKind) === "required" &&
    !edgeCurrentlyAttachesPart(ctx.registry, work.partKind, {
      kind: work.pair.viaEdgeKind,
      deleted_at: undefined,
      valid_to: temporal.validTo,
    })
  ) {
    throw new CompositionExistenceError({
      partKind: work.partKind,
      partId,
      situation: "create",
    });
  }
  const edgeInput = buildCompositionCreateEdgeInput(work, partId, temporal);
  const preparedEdge = await validateAndPrepareEdgeCreate(
    ctx,
    edgeInput,
    generateId(),
    target,
    {
      validateEndpoints: true,
      validateCardinality: true,
      validateAcyclicity: true,
      lock,
    },
  );
  await session.createEdgeNoReturn(edgeInsertWork(ctx, preparedEdge));
}

/**
 * Item E.2. The composition edge's temporal window, inherited verbatim from
 * the part's own INSERT params — the one place every create shape (single,
 * both batch shapes) reads `validFrom`/`validTo` off `insertParams` into
 * {@link attachCompositionCreateEdge}'s `temporal` parameter, so the three
 * call sites cannot drift on which fields they forward.
 */
function compositionTemporalFromInsertParams(
  insertParams: Pick<InsertNodeParams, "validFrom" | "validTo">,
): Readonly<{ validFrom?: string | null; validTo?: string }> {
  return {
    ...(insertParams.validFrom === undefined ?
      {}
    : { validFrom: insertParams.validFrom }),
    ...(insertParams.validTo === undefined ?
      {}
    : { validTo: insertParams.validTo }),
  };
}

/**
 * Item E.2. The two batch create paths' (`executeNodeCreateNoReturnBatch`,
 * `executeNodeCreateBatch`) shared per-input composition resolution: computed
 * from the ORIGINAL `inputs` (an item's `id` may be `undefined`, and must
 * reach `draftNodeCreate`'s `idProvided` check unresolved — pre-filling it
 * here would make every generated id look caller-supplied to the batch
 * preparation that follows), synchronous and read-free so the two refusal
 * arms throw before any row is touched. `undefined` entries (no composition
 * work) are kept, so the result stays index-aligned with `inputs`.
 */
function resolveBatchCompositionWorks<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  inputs: readonly CreateNodeInput[],
): readonly (CompositionCreateWork | undefined)[] {
  return inputs.map((input) => resolveCompositionCreate(ctx.registry, input));
}

/**
 * Item E.2. The constraint-fence probe one composition create owes for the
 * edge it is about to attach — `edgeComposition: true` makes
 * `edgeWriteNeedsConstraintFence` answer `"edgeComposition"` unconditionally,
 * so a backend that cannot hold the fence refuses the whole create rather
 * than writing a node it cannot attach. The single spelling of that probe,
 * reused by the single-create path, both batch create paths, and the
 * composition-restoring leg of `executeNodeUpsertUpdate`.
 */
function compositionEdgeConstraintFence<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  work: CompositionCreateWork,
): ConstraintFenceReason | undefined {
  return edgeWriteNeedsConstraintFence({
    ...edgeCardinalityDeclarations(ctx, work.pair.viaEdgeKind),
    composition: true,
  });
}

/**
 * Item E.2. The constraint-fence probes a batch's composition edges owe,
 * folded alongside the batch's own node probes by both create paths — one
 * spelling of "filter to the resolved works, then fence each one's realizing
 * edge kind" shared by `executeNodeCreateNoReturnBatch` and
 * `executeNodeCreateBatch`.
 */
function compositionBatchConstraintProbes<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  compositionWorks: readonly (CompositionCreateWork | undefined)[],
): readonly (ConstraintFenceReason | undefined)[] {
  return compositionWorks
    .filter((work): work is CompositionCreateWork => work !== undefined)
    .map((work) => compositionEdgeConstraintFence(ctx, work));
}

/**
 * Item E.2. After every node row in a batch exists (inserted or
 * resurrected), attaches each item's composition edge — one owner reached
 * from every prepared row by its id, so a mixed batch of
 * required/optional/no-`partOf` items each takes exactly the edge it owes.
 * `preparedCreates` preserves `inputs`' order (see `prepareBatchCreates`), so
 * zipping it against `compositionWorks` (index-aligned with the ORIGINAL
 * `inputs`, from {@link resolveBatchCompositionWorks}) is the one place a
 * resolved id and its composition work are joined. Shared by both batch
 * create paths so neither re-spells the zip or the attach loop.
 */
async function attachBatchCompositionCreateEdges<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  session: WriteSession,
  target: WriteTarget,
  lock: GraphWriteLock,
  preparedCreates: readonly NodeCreatePrepared[],
  compositionWorks: readonly (CompositionCreateWork | undefined)[],
): Promise<void> {
  const compositionWorkByPreparedId = new Map(
    preparedCreates
      .map((prepared, index) => [prepared.id, compositionWorks[index]] as const)
      .filter(
        (entry): entry is [string, CompositionCreateWork] =>
          entry[1] !== undefined,
      ),
  );
  for (const prepared of preparedCreates) {
    await attachCompositionCreateEdge(
      ctx,
      session,
      target,
      lock,
      compositionWorkByPreparedId.get(prepared.id),
      prepared.id,
      compositionTemporalFromInsertParams(prepared.insertParams),
    );
  }
}

/**
 * THE `partOf` POSTCONDITION a `getOrCreateByConstraint` call owes for a
 * match that resolved to `"found"` or `"updated"`: when this returns, the
 * resolved node holds exactly the stated attachment.
 *
 * The attachment is RESOLVED first, unconditionally
 * ({@link resolveCompositionAttachment}), before the live attachment is even
 * read: an undeclared whole kind, an unknown `via`, and an ambiguous omitted
 * `via` are configuration defects of the CALL, and a call that states one
 * must refuse identically whether the constraint matched an existing node or
 * created one. Resolving first is also what lets the dispositions below
 * compare the incumbent row against the resolved pair's realizing edge
 * rather than against `attachment.via` — so "via omitted" means "the one
 * declared pair", never "any realizing edge will do".
 *
 * Three dispositions, decided from the node's LIVE attachment
 * (`findLiveCompositionAttachment` — the same reader `reparent` and the
 * `situation: "existing"` diagnostic use):
 *
 * - it already holds this whole through the resolved pair's realizing edge:
 *   satisfied, no write — which is what makes a repeated get-or-create with
 *   the same `partOf` idempotent rather than a refusal;
 * - it holds NO live whole: the attachment is written now, through
 *   {@link executeNodeReparent} (whose no-current-attachment arm is exactly
 *   this write, under the same fence and the same final-state validation) —
 *   so an optional part found unattached is attached rather than told to
 *   attach itself, and a REQUIRED part found unattached (only reachable
 *   through rows written outside the store's write path) is repaired on the
 *   same terms;
 * - it holds a DIFFERENT whole, or the same whole through a different
 *   realizing edge: refused with `CompositionExistenceError`
 *   (`situation: "existing"`) naming both sides. Moving a part is
 *   `reparent`'s decision, never a side effect of a lookup.
 *
 * Shared by the single-item and bulk entries so neither re-spells it.
 */
async function applyExistingPartOfPostcondition<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  backend: GraphBackend | TransactionBackend,
  concreteKind: string,
  concreteId: string,
  attachment: CompositionAttachment,
): Promise<void> {
  const pair = resolveCompositionAttachment(
    ctx.registry,
    concreteKind,
    attachment,
  );

  const current = await findLiveCompositionAttachment(
    ctx.registry,
    backend,
    ctx.graphId,
    concreteKind,
    concreteId,
  );

  if (current === undefined) {
    await executeNodeReparent(
      ctx,
      concreteKind,
      concreteId,
      attachment,
      backend,
    );
    return;
  }

  const wholeMatches =
    current.whole.kind === attachment.kind &&
    current.whole.id === attachment.id;
  const viaMatches = current.edge.kind === pair.viaEdgeKind;
  if (wholeMatches && viaMatches) return;

  throw new CompositionExistenceError({
    partKind: concreteKind,
    partId: concreteId,
    situation: "existing",
    currentWhole: current.whole,
    ...(wholeMatches ? { currentVia: current.edge.kind } : {}),
    requestedWhole: { kind: attachment.kind, id: attachment.id },
    requestedVia: pair.viaEdgeKind,
  });
}

/**
 * Item E.2. `getOrCreateByConstraint`'s (single-item and bulk) six create
 * fallbacks each forward the caller's `partOf` onto the underlying
 * `executeNodeCreate` input — one spelling of that optional-field forward
 * instead of six copies of the same conditional spread.
 */
function createInputWithPartOf(
  kind: string,
  props: Record<string, unknown>,
  partOf: CompositionAttachment | undefined,
): CreateNodeInput {
  return { kind, props, ...(partOf === undefined ? {} : { partOf }) };
}

// ============================================================
// Node Reparent Operations
// ============================================================

/**
 * Moves one composition part to a new whole, atomically: one write plan, one
 * per-graph fence, the old attachment retired and the new one created inside
 * the SAME transaction.
 *
 * Why a first-class operation rather than "delete the edge, then create the
 * other one": those two writes cannot both hold. R4 gives a part exactly one
 * whole, so the create refuses (`COMPOSITION_WHOLE_OCCUPIED`) while the old
 * edge still holds the claim; and `existence: "required"` refuses the delete
 * (`CompositionExistenceError`, `situation: "detach"`) while the part is
 * live. Between them a caller has no legal order — this operation is the
 * order, with both invariants validated against the frame's FINAL state:
 *
 * - **one whole** — the new edge takes the composition claim only after the
 *   old row stopped holding it, so a concurrent attach still loses;
 * - **acyclicity over the oriented composition union** — the probe
 *   `validateAndPrepareEdgeCreate` runs sees the post-retire graph, so
 *   moving a subtree under one of its own former siblings is judged on where
 *   the part actually ends up, not on a transient state;
 * - **required existence never violated mid-way** — either retire arm (the
 *   window end and the delete) carries the part as `reattachedPart` evidence
 *   ({@link assertCompositionExistencePreserved}), so the refusal is applied
 *   with the frame's real end state rather than bypassed.
 *
 * The part keeps its id, its properties, and every descendant beneath it:
 * nothing below the part is rewritten, because a descendant's own
 * composition edge names its immediate whole, which this move does not
 * change.
 *
 * How the old attachment is retired follows the population declared on the
 * INCUMBENT row's own pair (resolved through the realizing edge that holds
 * the attachment, `KindRegistry.compositionPairVia`), so the row's meaning
 * survives the move: a `population: "one"` edge is DELETED (a `one` binding
 * persists for the row's whole life, ended or not, so an ended row would
 * still read as an attachment), while a `population: "oneActive"` edge has
 * its window ENDED at the move instant, leaving the previous membership
 * readable as valid-time history.
 *
 * The move instant is read ONCE and is both the incumbent window's `validTo`
 * and the new edge's `validFrom`, so the two halves of the move abut in valid
 * time: no `store.asOf(t)` coordinate shows the part with zero wholes, and
 * none shows it with two. A second clock read would open the first gap on any
 * clock and the second on a non-monotonic one (issue #242's failure mode),
 * and neither is fenceable — each write is legal at the instant it samples.
 *
 * Attaching to the whole the part already holds is accepted as a NO-OP (no
 * write, no history), not refused: reparent states a destination, and a
 * caller converging on one should not have to first ask where the part is.
 */
export async function executeNodeReparent<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  id: string,
  attachment: CompositionAttachment,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  if (!ctx.registry.isCompositionPart(kind)) {
    throw new ConfigurationError(
      `Node kind "${kind}" is not a composition part: it declares no partOf/hasPart pair toward any whole.`,
      { code: "COMPOSITION_NOT_A_PART", partKind: kind },
      {
        suggestion: `Declare \`partOf(${kind}, <Whole>, { via: ... })\` (or the mirrored \`hasPart\`) in the ontology, or move the relationship with an ordinary edge write.`,
      },
    );
  }
  // Synchronous and read-free: an undeclared pair, an unknown `via`, and an
  // ambiguous omitted `via` all refuse before any row is read or locked.
  const pair = resolveCompositionAttachment(ctx.registry, kind, attachment);
  const work: CompositionCreateWork = {
    pair,
    whole: { kind: attachment.kind, id: attachment.id },
    partKind: kind,
    props: attachment.props ?? {},
  };

  const gate = await backend.getNode(ctx.graphId, kind, id);
  if (!gate || !isLiveNodeRow(gate)) throw new NodeNotFoundError(kind, id);

  const opContext = ctx.createOperationContext("update", "node", kind, id);
  await runHookedWritePlan(
    nodeWritePlanContext(ctx),
    opContext,
    // `entity: "mixed"`: this frame writes only edges, but it writes TWO of
    // them through a session that must be able to reach both surfaces (the
    // retire uses the edge session, the attach the node frame's composition
    // helper). The probe is the composition edge's own — a backend that
    // cannot hold the fence refuses the move rather than retiring an
    // attachment it cannot replace.
    mixedWritePlan(compositionEdgeConstraintFence(ctx, work), false),
    backend,
    async (session, target, _overlaidSession, lock) => {
      // Re-read under the lock: the gate above is lock-free, and a
      // concurrent delete between the two must not leave this frame
      // attaching a tombstoned part to a live whole.
      const part = await target.getNode(ctx.graphId, kind, id);
      if (!part || !isLiveNodeRow(part)) throw new NodeNotFoundError(kind, id);

      const current = await findLiveCompositionAttachment(
        ctx.registry,
        target,
        ctx.graphId,
        kind,
        id,
      );
      if (
        current?.whole.kind === attachment.kind &&
        current.whole.id === attachment.id &&
        current.edge.kind === pair.viaEdgeKind
      ) {
        return false;
      }

      // ONE clock read for ONE move. The instant the incumbent window ends is
      // the instant the new attachment begins, so valid time has no interval
      // in which the part holds zero wholes (which `existence: "required"`
      // forbids) and none in which it holds two (which R4 forbids). Two
      // independent reads would produce the first on any clock and the second
      // on a non-monotonic one, and no fence catches either: each write is
      // legal at the instant it samples.
      const moveInstant = nowIso();

      if (current !== undefined) {
        // The population that governs how this ROW retires is the incumbent
        // pair's own, read through the realizing edge that actually holds the
        // attachment — not `compositionPopulation(kind)`, which re-derives it
        // from the part kind and agrees only because
        // `ONTOLOGY_COMPOSITION_POPULATION_MIXED` forbids a part kind's pairs
        // from disagreeing. Same reasoning as the cascade's pair lookup.
        const incumbentPair = requireDefined(
          ctx.registry.compositionPairVia(
            kind,
            current.whole.kind,
            current.edge.kind,
          ),
          `compositionPairVia(${kind}, ${current.whole.kind}, ${current.edge.kind}) is undefined for the edge kind that currently realizes this part's attachment`,
        );
        if (incumbentPair.population === "oneActive") {
          await endCompositionEdgeWindow(
            ctx,
            current.edge,
            { kind, id },
            moveInstant,
            session,
            target,
            lock,
          );
        } else {
          // Through the same owner every other retire path goes through, with
          // the reparent's `reattachedPart` evidence, so a rule added to
          // `assertCompositionExistencePreserved` later applies to a
          // `population: "one"` move too. `endCompositionEdgeWindow` reaches
          // it via `performEdgeUpdateConverging`; a direct `retireEdge` has no
          // other way in.
          await assertCompositionExistencePreserved(
            {
              graphId: ctx.graphId,
              registry: ctx.registry,
              lock,
              reattachedPart: { kind, id },
            },
            current.edge,
            target,
          );
          await session.retireEdge({
            id: current.edge.id,
            kind: current.edge.kind,
          });
        }
      }

      await attachCompositionCreateEdge(ctx, session, target, lock, work, id, {
        validFrom: moveInstant,
      });
      return true;
    },
    { didWrite: booleanWriteResultChanges },
  );
}

async function executeNodeCreateInternal<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: CreateNodeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{ returnRow?: boolean }> & NodeCreateInternalOptions,
): Promise<Node | undefined> {
  const kind = input.kind;
  const id = input.id ?? generateId();
  // Item E.2. Synchronous and read-free — throws BEFORE any row is touched
  // for the two refusal arms (required-existence with no `partOf`; a
  // `partOf` naming an undeclared pair), which is what makes cases where no
  // node row survives provable rather than merely likely.
  const compositionWork = resolveCompositionCreate(ctx.registry, input);
  const opContext = ctx.createOperationContext("create", "node", kind, id);
  const shouldReturnRow = options?.returnRow ?? true;
  const autocommitBackend =
    isBundledRootAutocommitEligible(backend) ? backend : undefined;
  const registeredKind =
    hasOwnKey(ctx.graph.nodes, kind) ?
      getNodeRegistration(ctx.graph, kind)
    : undefined;
  const candidate =
    registeredKind === undefined ? undefined : (
      ({
        backend,
        schemaVersion: ctx.schemaVersion,
        historyEnabled: ctx.historyEnabled,
        revisionTrackingEnabled: ctx.revisionTrackingEnabled,
        identityEnabled: ctx.identity !== undefined,
        idGenerated: input.id === undefined,
        kindRegistered: true,
        uniqueConstraintCount: registeredKind.unique?.length ?? 0,
        disjointKindCount: ctx.registry.getDisjointKinds(kind).length,
        schema: registeredKind.type.schema,
      } as const)
    );
  const schemaFenceInFirstWrite =
    candidate !== undefined &&
    canFuseSchemaFenceInFirstWrite({ kind: "node", candidate });
  // Item E.2: a composition create writes a second row (the edge) that must
  // land in the SAME transaction as the node — never a candidate for a
  // single-statement autocommit write, which has no transaction to share.
  const autocommitSingleStatement =
    compositionWork === undefined &&
    autocommitBackend !== undefined &&
    candidate !== undefined &&
    isAutocommitSingleStatementWrite({ kind: "node", candidate });
  // Item E.2: `mixedWritePlan` unconditionally — `entity` only widens the
  // STATIC session type `rowWork` receives (`createWriteSession` always
  // mints the full node+edge session; see `write-executor.ts`'s
  // `planFrame`), so this has no runtime effect on the ordinary,
  // no-`partOf` create. When this create owes a composition edge, the
  // constraint probe folds the node's own with the edge's — `edgeComposition
  // : true` makes `edgeWriteNeedsConstraintFence` answer `"edgeComposition"`
  // unconditionally, so a backend that cannot hold the fence refuses the
  // WHOLE create, naming the composition declaration, rather than writing a
  // node it cannot attach.
  const plan = mixedWritePlan(
    nodeFencesConstraintProbe(ctx, kind, "create") ??
      (compositionWork === undefined ? undefined : (
        compositionEdgeConstraintFence(ctx, compositionWork)
      )),
    nodeCreateRequiresIdentityLock(ctx, input),
  );

  const rowWork = async (
    session: WriteSession,
    target: WriteTarget,
    _overlaidSession: OverlaidSessionMint<"mixed">,
    lock: GraphWriteLock,
    transactionMode: WriteTransactionMode,
  ): Promise<Node | undefined> => {
    // The outer backend's mark chooses the optimistic plan, but a custom
    // transaction wrapper can replace its callback target. Re-check the
    // factory-owned origin at the actual write receiver before letting that
    // receiver carry the schema fence; otherwise a wrapper that dropped the
    // ordinary diagnostic fence could silently write a verified store.
    const targetBackend = unfencedTarget(target);
    // Item E.2: a composition create declines EVERY fused single-statement
    // shape (schema-fence fusion, projection fusion) — none has a slot for
    // the second row this write also owes, and a fused command is an
    // optimization attempt, not evidence its dimensions ran (the same
    // principle §5.4 applies to the BATCH fused programs, generalized here
    // to this function's own single-create fusions). It still takes the
    // ordinary portable schema-version lock below when the kind is
    // schema-fenced.
    const fuseSchemaFenceInFirstWrite =
      compositionWork === undefined &&
      schemaFenceInFirstWrite &&
      isSchemaFencedInsertEligible(targetBackend) &&
      !hasLeasedSchemaFence(ctx, targetBackend);
    if (schemaFenceInFirstWrite && !fuseSchemaFenceInFirstWrite) {
      await lockSchemaVersionForStoreWrite(ctx, targetBackend);
    }
    const identity = ctx.identity;
    const draft = draftNodeCreate(ctx, input, id, options);
    const claimPlan = planNodeCreateClaims(
      { graphId: ctx.graphId, registry: ctx.registry },
      {
        kind: draft.kind,
        id: draft.id,
        props: draft.validatedProps,
        constraints: draft.uniqueConstraints,
      },
    );
    const projections = resolveNodeInsertProjections(
      draft.nodeKind.schema,
      draft.validatedProps,
    );
    const preparationMode: NodeCreatePreparationMode =
      (
        shouldReturnRow &&
        !fuseSchemaFenceInFirstWrite &&
        supportsNodeCreatePlan(target, {
          params: buildInsertNodeParams(
            ctx.graphId,
            draft.kind,
            draft.id,
            draft.validatedProps,
            draft.validFrom,
            draft.validTo,
          ),
          idGenerated: !draft.idProvided,
          mode: { kind: "ordinary" },
          claims: claimPlan.claims,
          projections,
          allowNonTransactionalClaims:
            ctx.identity === undefined &&
            !ctx.historyEnabled &&
            !ctx.revisionTrackingEnabled,
        })
      ) ?
        "authoritative-plan"
      : "probe";
    const prepared = await finishNodeCreatePreparation(
      ctx,
      draft,
      target,
      true,
      preparationMode,
      claimPlan,
    );
    const projectionFusionEligible =
      compositionWork === undefined &&
      shouldReturnRow &&
      !prepared.idProvided &&
      projections.length > 0;
    const fuseProjections =
      projectionFusionEligible &&
      supportsNodeInsertProjections(target, projections);
    const fuseSchemaFenceProjections =
      fuseSchemaFenceInFirstWrite &&
      projectionFusionEligible &&
      supportsNodeInsertProjections(target, projections);

    // Item E.2: reads `prepared.insertParams`, the SAME source the batch
    // paths read, rather than `input` directly — one owner for "what
    // validity window does the composition edge inherit from its part",
    // shared by every create shape.
    const attachCompositionEdge = (): Promise<void> =>
      attachCompositionCreateEdge(
        ctx,
        session,
        target,
        lock,
        compositionWork,
        id,
        compositionTemporalFromInsertParams(prepared.insertParams),
      );

    const existing = prepared.tombstone;
    if (existing !== undefined) {
      const resurrected = await resurrectPreparedNode(
        ctx,
        session,
        target,
        prepared,
      );
      if (identity !== undefined) {
        await identity.foldCreated(
          target,
          foldReferences([prepared]),
          "restore",
        );
      }
      await attachCompositionEdge();
      return shouldReturnRow ? rowToNode(resurrected) : undefined;
    }

    if (fuseSchemaFenceInFirstWrite) {
      const schemaFence = {
        graphId: ctx.graphId,
        expectedVersion: requireDefined(ctx.schemaVersion),
      };
      const work =
        fuseSchemaFenceProjections ?
          nodeCreateWork(prepared, projections, false)
        : nodeCreateWork(prepared, [], false);
      const inserted =
        prepared.insertIfAbsent ?
          await session.createNodeIfAbsentWithSchemaFence(work, schemaFence)
        : await session.createNodeWithSchemaFence(work, schemaFence);
      if (inserted !== undefined) {
        memoizeLeasedSchemaFence(ctx, targetBackend);
        return shouldReturnRow ? rowToNode(inserted) : undefined;
      }

      // The fused statement's empty result is intentionally ambiguous. Its
      // ordinary active-schema diagnostic preserves the settled version in
      // StaleVersionError.details.actual without a second PostgreSQL lock.
      await diagnoseFusedSchemaFenceNoRow(ctx, targetBackend);
      // An empty INSERT result does not prove PostgreSQL evaluated the nested
      // locking subquery: an ON CONFLICT or other zero-row branch can make the
      // executor skip it. Acquire the portable fence before any fallback read
      // or later write relies on this transaction's lease.
      const directInteractiveAutocommit =
        autocommitSingleStatement &&
        transactionMode === "none" &&
        targetBackend.capabilities.execution.interactiveTransactions;
      if (directInteractiveAutocommit) {
        throw new AutocommitWriteRequiresTransaction();
      }
      if (!prepared.insertIfAbsent) {
        if (transactionMode !== "none") {
          await lockSchemaVersionForStoreWrite(ctx, targetBackend);
        }
        throw new DatabaseOperationError(
          `Fresh node insert returned no row: ${prepared.kind} ${prepared.id}`,
          { operation: "insert", entity: "node" },
        );
      }
      // A supplied id's fused statement returned no row because the id is
      // already occupied (the stale-version case already threw above) — the
      // occupancy check below re-reads to report the duplicate. On a
      // transaction this re-fences before that read, matching the
      // fresh-id branch above; a `"none"`-mode target (a batch engine's
      // fused statement already carried its own fence) has no ordinary
      // lock to take here.
      if (transactionMode !== "none") {
        await lockSchemaVersionForStoreWrite(ctx, targetBackend);
      }
    }

    if (fuseProjections && !fuseSchemaFenceProjections) {
      const row = await withAlreadyExistsTranslation("node", () =>
        session.createNode(
          nodeCreateWork(
            prepared,
            projections,
            ctx.identity === undefined &&
              !ctx.historyEnabled &&
              !ctx.revisionTrackingEnabled,
          ),
        ),
      );
      return rowToNode(row);
    }

    if (prepared.insertIfAbsent) {
      const inserted =
        fuseSchemaFenceInFirstWrite ? undefined : (
          await session.createNodeIfAbsent(nodeCreateWork(prepared))
        );
      if (inserted !== undefined) {
        if (identity !== undefined) {
          await identity.foldCreated(
            target,
            foldReferences([prepared]),
            "fold",
          );
        }
        await attachCompositionEdge();
        return shouldReturnRow ? rowToNode(inserted) : undefined;
      }

      // `ON CONFLICT DO NOTHING` leaves PostgreSQL's transaction usable. A
      // single read now classifies the occupied slot, rather than paying it
      // on every successful caller-supplied-id create.
      const occupied = await target.getNode(
        ctx.graphId,
        prepared.kind,
        prepared.id,
      );
      if (occupied === undefined) {
        throw new DatabaseOperationError(
          `Node disappeared after insert-if-absent conflict: ${prepared.kind} ${prepared.id}`,
          { operation: "insert", entity: "node" },
        );
      }
      if (occupied.deleted_at === undefined) {
        throw createAlreadyExistsError("node", prepared.kind, prepared.id);
      }
      // The tombstone-slot classification above is a read; resurrecting it is
      // a genuine write (`session.reviseNode`) outside the fused INSERT's
      // atomicity. When that INSERT's own no-row diagnosis left the schema
      // fence untaken for a `"none"`-mode target (see above), fail closed
      // here before the write, matching edge create's identical point.
      // `lockSchemaVersionForStoreWrite` throws the plain
      // `SCHEMA_WRITE_FENCE_UNSUPPORTED` limitation here, not
      // `BATCH_WRITE_UNSUPPORTED`: a tombstone resurrection needs a second
      // write outside the fused INSERT regardless of `unitOfWork`, which is
      // not one of `BatchWriteRefusalReason`'s five proven needs (an
      // interactive callback, a constraint probe, identity, history, or a
      // schema commit) — it is simply a write shape that cannot fuse, the
      // same plain limitation an ineligible write kind or a derived backend
      // reaches through this same call.
      if (fuseSchemaFenceInFirstWrite && transactionMode === "none") {
        await lockSchemaVersionForStoreWrite(ctx, targetBackend);
      }
      const resurrected = await resurrectPreparedNode(
        ctx,
        session,
        target,
        prepared,
      );
      if (identity !== undefined) {
        await identity.foldCreated(
          target,
          foldReferences([prepared]),
          "restore",
        );
      }
      await attachCompositionEdge();
      return shouldReturnRow ? rowToNode(resurrected) : undefined;
    }

    // The existence probe above is not the last word: on an engine that does
    // not serialize the two writers, a concurrent create of the same new id
    // can commit between the probe and this INSERT, and only the engine's
    // refusal reports it. Both routes to that conclusion raise the same error.
    //
    // The claims are the session's, at their declared placements: the
    // pre-insert group gates the row and is compensated away if it does not
    // land, the post-insert group follows it. The translation spans the fused
    // unit — claims, row AND sidecars — because the session applies them
    // together. That widening is inert: `isDuplicateKeyInsertError` fires only
    // on a classified node-INSERT duplicate, which no claim, fulltext or
    // embedding write raises. The alternative — the session owning the
    // translation — would change import's create-leg error type on a lost
    // race, which it must not.
    const row = await withAlreadyExistsTranslation("node", async () => {
      const work = nodeCreateWork(
        prepared,
        [],
        ctx.identity === undefined &&
          !ctx.historyEnabled &&
          !ctx.revisionTrackingEnabled,
      );
      if (shouldReturnRow) return session.createNode(work);
      await session.createNodeNoReturn(work);
      return;
    });

    if (identity !== undefined) {
      await identity.foldCreated(target, foldReferences([prepared]), "fold");
    }

    await attachCompositionEdge();

    if (row === undefined) return;
    return rowToNode(row);
  };

  if (autocommitSingleStatement) {
    return runAutocommitSingleStatementWritePlan(
      nodeWritePlanContext(ctx),
      opContext,
      plan,
      autocommitBackend,
      rowWork,
      { didWrite: writeResultAlwaysChanges },
    );
  }
  return runHookedWritePlan(
    nodeWritePlanContext(ctx),
    opContext,
    plan,
    backend,
    rowWork,
    {
      schemaFenceInFirstWrite,
      didWrite: writeResultAlwaysChanges,
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

  // Item E.2 — see `resolveBatchCompositionWorks`'s docblock.
  const compositionWorks = resolveBatchCompositionWorks(ctx, inputs);

  const atomicExecutor = resolveAtomicNodeBatchExecutor({
    backend,
    graph: ctx.graph,
    registry: ctx.registry,
    inputs,
    schemaVersion: ctx.schemaVersion,
    identityEnabled: ctx.identity !== undefined,
    historyEnabled: ctx.historyEnabled,
    revisionTrackingEnabled: ctx.revisionTrackingEnabled,
  });

  if (atomicExecutor !== undefined) {
    const preparedCreates = await prepareAtomicBatchCreates(
      ctx,
      inputs,
      backend,
    );
    const entries = atomicNodeBatchEntries(
      preparedCreates,
      atomicExecutor.claimSupport,
    );
    if (entries !== undefined) {
      const schemaFence = {
        graphId: ctx.graphId,
        expectedVersion: requireDefined(ctx.schemaVersion),
      };
      const insertedCount = await withAtomicNodeClaimTranslation(
        preparedCreates,
        () =>
          withAlreadyExistsTranslation("node", () =>
            atomicExecutor({ entries, resultMode: "count", schemaFence }),
          ),
      );
      if (insertedCount === 0) {
        await diagnoseAtomicNodeBatchNoRow(ctx, backend, preparedCreates);
      }
      if (insertedCount !== inputs.length) {
        throw new DatabaseOperationError(
          `Atomic node batch returned ${insertedCount} rows, expected ${inputs.length}`,
          {
            operation: "insert",
            entity: "node",
            attempted: preparedCreates.map((prepared) => ({
              kind: prepared.kind,
              id: prepared.id,
            })),
          },
        );
      }
      memoizeLeasedSchemaFence(ctx, backend);
      return;
    }
  }

  await runWritePlan(
    nodeWritePlanContext(ctx),
    mixedBatchWritePlan(
      [
        ...nodeBatchConstraintProbes(ctx, inputs, "create"),
        ...compositionBatchConstraintProbes(ctx, compositionWorks),
      ],
      nodeBatchCreateRequiresIdentityLock(ctx, inputs),
    ),
    backend,
    async (session, target, _overlaidSession, lock) => {
      const identity = ctx.identity;
      const preparedCreates = await prepareBatchCreates(ctx, inputs, target);

      const partition = partitionCreates(preparedCreates);
      // ## Resurrections follow the whole insert unit
      //
      // The batch INSERT, its claim groups and its sidecar batch are ONE session
      // call, so the resurrection updates that used to run BETWEEN the insert and
      // the fans now run after all of them. That is the one statement-order
      // difference this migration makes, and it is safe because the two groups
      // touch disjoint rows: a prepared create is either an insert or a
      // resurrection, never both, and the embedding/fulltext rows are
      // node-id-keyed. Their only shared resource is the claim relation — and two
      // batch members claiming one key are already refused during preparation,
      // which registers each row's pending claims so a later row sees an earlier
      // one ({@link prepareBatchCreates}). So no error this batch can raise
      // depends on which of the two groups writes first.
      await withAlreadyExistsTranslation("node", () =>
        session.createNodesNoReturn(
          partition.inserts.map((prepared) => nodeCreateWork(prepared)),
        ),
      );
      for (const prepared of partition.resurrections) {
        await resurrectPreparedNode(ctx, session, target, prepared);
      }
      if (identity !== undefined) {
        await identity.foldCreated(
          target,
          foldReferences(partition.inserts),
          "fold",
        );
        await identity.foldCreated(
          target,
          foldReferences(partition.resurrections),
          "restore",
        );
      }
      // Item E.2 — see `attachBatchCompositionCreateEdges`'s docblock.
      await attachBatchCompositionCreateEdges(
        ctx,
        session,
        target,
        lock,
        preparedCreates,
        compositionWorks,
      );
    },
    { didWrite: writeResultAlwaysChanges },
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

  // Item E.2 — see `executeNodeCreateNoReturnBatch`'s identical preamble.
  const compositionWorks = resolveBatchCompositionWorks(ctx, inputs);

  const atomicExecutor = resolveAtomicNodeBatchExecutor({
    backend,
    graph: ctx.graph,
    registry: ctx.registry,
    inputs,
    schemaVersion: ctx.schemaVersion,
    identityEnabled: ctx.identity !== undefined,
    historyEnabled: ctx.historyEnabled,
    revisionTrackingEnabled: ctx.revisionTrackingEnabled,
  });

  if (atomicExecutor !== undefined) {
    const preparedCreates = await prepareAtomicBatchCreates(
      ctx,
      inputs,
      backend,
      options,
    );
    const entries = atomicNodeBatchEntries(
      preparedCreates,
      atomicExecutor.claimSupport,
    );
    if (entries !== undefined) {
      const schemaFence = {
        graphId: ctx.graphId,
        expectedVersion: requireDefined(ctx.schemaVersion),
      };
      const returnedRows = await withAtomicNodeClaimTranslation(
        preparedCreates,
        () =>
          withAlreadyExistsTranslation("node", () =>
            atomicExecutor({ entries, resultMode: "rows", schemaFence }),
          ),
      );
      if (returnedRows.length === 0) {
        await diagnoseAtomicNodeBatchNoRow(ctx, backend, preparedCreates);
      }
      if (returnedRows.length !== preparedCreates.length) {
        throw new DatabaseOperationError(
          `Atomic node batch returned ${returnedRows.length} rows, expected ${preparedCreates.length}`,
          {
            operation: "insert",
            entity: "node",
            attempted: preparedCreates.map((prepared) => ({
              kind: prepared.kind,
              id: prepared.id,
            })),
          },
        );
      }
      memoizeLeasedSchemaFence(ctx, backend);
      return restoreAtomicNodeBatchRows(
        ctx.graphId,
        preparedCreates,
        returnedRows,
      ).map((row) => rowToNode(row));
    }
  }

  return runWritePlan(
    nodeWritePlanContext(ctx),
    mixedBatchWritePlan(
      [
        ...nodeBatchConstraintProbes(ctx, inputs, "create"),
        ...compositionBatchConstraintProbes(ctx, compositionWorks),
      ],
      nodeRequiresIdentityLock(ctx),
    ),
    backend,
    async (session, target, _overlaidSession, lock) => {
      const identity = ctx.identity;
      const preparedCreates = await prepareBatchCreates(
        ctx,
        inputs,
        target,
        options,
      );

      const partition = partitionCreates(preparedCreates);
      // One call for claims + row + sidecars, so the resurrections follow the
      // whole unit — same reasoning as {@link executeNodeCreateNoReturnBatch}.
      const inserted = await withAlreadyExistsTranslation("node", () =>
        session.createNodes(
          partition.inserts.map((prepared) => nodeCreateWork(prepared)),
        ),
      );
      const resurrected: BackendNodeRow[] = [];
      for (const prepared of partition.resurrections) {
        resurrected.push(
          await resurrectPreparedNode(ctx, session, target, prepared),
        );
      }
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
        await identity.foldCreated(
          target,
          foldReferences(partition.inserts),
          "fold",
        );
        await identity.foldCreated(
          target,
          foldReferences(partition.resurrections),
          "restore",
        );
      }
      // Item E.2 — see `attachBatchCompositionCreateEdges`'s docblock.
      await attachBatchCompositionCreateEdges(
        ctx,
        session,
        target,
        lock,
        preparedCreates,
        compositionWorks,
      );

      return rows.map((row) => rowToNode(row));
    },
    { didWrite: writeResultAlwaysChanges },
  );
}

// ============================================================
// Node Update Operations
// ============================================================

function resolveAtomicNodeUpdateExecutor<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  entries: readonly NodeUpsertUpdateBatchEntry[],
  backend: GraphBackend | TransactionBackend,
): AtomicNodeResolvedUpdateBatchExecutor | undefined {
  const first = entries[0];
  if (first === undefined) return;
  const distinctIds = new Set(entries.map((entry) => entry.input.id));
  if (
    distinctIds.size !== entries.length ||
    entries.some(
      (entry) =>
        entry.clearDeleted ||
        entry.input.validFrom !== undefined ||
        entry.input.validTo !== undefined ||
        entry.input.clearValidTo === true,
    )
  ) {
    return;
  }
  return resolveAtomicNodeResolvedUpdateBatchExecutor({
    backend,
    graph: ctx.graph,
    schemaVersion: ctx.schemaVersion,
    historyEnabled: ctx.historyEnabled,
    revisionTrackingEnabled: ctx.revisionTrackingEnabled,
    kind: first.input.kind,
    entryCount: entries.length,
    identityEnabled: ctx.identity !== undefined,
    registry: ctx.registry,
  });
}

export async function executeNodeUpdate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: UpsertUpdateNodeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Node> {
  // The capability refusal is taken on the backend the CALLER handed in, before
  // the frame opens: a stated `clearValidTo` a backend does not promise to apply
  // must be refused, never accepted and dropped, and no transaction is needed to
  // read a capability. Same placement as `executeNodeUpsertUpdate`'s.
  if (input.clearValidTo === true) {
    assertClearValidToSupported(backend, "node");
  }
  const atomicEntry = {
    input,
    clearDeleted: options?.clearDeleted === true,
  } satisfies NodeUpsertUpdateBatchEntry;
  const atomicExecutor = resolveAtomicNodeUpdateExecutor(
    ctx,
    [atomicEntry],
    backend,
  );
  const opContext = ctx.createOperationContext(
    "update",
    "node",
    input.kind,
    input.id,
  );
  if (atomicExecutor !== undefined) {
    return runAtomicProgramWithHooks(
      ctx,
      opContext,
      async () => {
        const nodes = await executeAtomicNodeResolvedUpdates(
          ctx,
          [atomicEntry],
          backend,
          atomicExecutor,
        );
        return requireDefined(nodes[0]);
      },
      writeResultAlwaysChanges,
    );
  }
  return runHookedWritePlan(
    nodeWritePlanContext(ctx),
    opContext,
    nodeWritePlan(
      nodeFencesConstraintProbe(ctx, input.kind, "update"),
      // Identity participates in an update when it RESURRECTS, and when it
      // states a validity end: a live-row update cannot change a node's kind, so
      // nothing folds, but an end reads the identity assertions that touch it.
      options?.clearDeleted === true || input.validTo !== undefined ?
        nodeRequiresIdentityLock(ctx)
      : false,
    ),
    backend,
    async (session, target) => {
      const validTo = validateOptionalCanonicalIsoDate(
        input.validTo,
        "validTo",
      );
      const identity = ctx.identity;
      if (identity !== undefined && validTo !== undefined) {
        await identity.requireValidityEndCompatible(
          target,
          { kind: input.kind, id: input.id },
          validTo,
        );
      }
      const node = await performNodeUpdateWithResurrectionRecovery(
        ctx,
        input,
        session,
        target,
        options,
      );
      if (options?.clearDeleted && identity !== undefined) {
        await identity.foldCreated(
          target,
          [{ kind: input.kind, id: input.id }],
          "restore",
        );
      }
      return node;
    },
    { didWrite: writeResultAlwaysChanges },
  );
}

function normalizeCompareAndSetExpectations(
  schema: z.ZodObject<z.ZodRawShape>,
  kind: string,
  inputExpected: Record<string, unknown>,
): Readonly<Record<string, NodePropertyExpectation>> {
  if (Object.keys(inputExpected).length === 0) {
    throw new ValidationError("compareAndSet() expected must not be empty", {
      entityType: "node",
      kind,
      operation: "update",
      issues: [{ path: "expected", message: "Provide at least one property" }],
    });
  }
  const unknownExpectedProperty = Object.keys(inputExpected).find(
    (property) => !Object.hasOwn(schema.shape, property),
  );
  if (unknownExpectedProperty !== undefined) {
    throw new ValidationError(
      `Unknown ${kind} property in compareAndSet() expected state: ${unknownExpectedProperty}`,
      {
        entityType: "node",
        kind,
        operation: "update",
        issues: [
          {
            path: unknownExpectedProperty,
            message: "Property is not declared by the node schema",
          },
        ],
      },
    );
  }

  const expected = createDataKeyedBag<NodePropertyExpectation>();
  const scalarExpectedInput = createDataKeyedBag<unknown>();
  for (const [property, value] of Object.entries(inputExpected)) {
    if (value === compareAndSetAbsent) {
      expected[property] = { kind: "absent" };
      continue;
    }
    if (value === undefined || (typeof value === "object" && value !== null)) {
      throw new ValidationError(
        `compareAndSet() expected property "${property}" must be a JSON scalar or compareAndSetAbsent`,
        {
          entityType: "node",
          kind,
          operation: "update",
          issues: [
            {
              path: property,
              message:
                "Expected a string, number, boolean, null, or compareAndSetAbsent",
            },
          ],
        },
      );
    }
    scalarExpectedInput[property] = value;
  }

  const parsedExpected = validateNodeProps(
    schema.partial(),
    scalarExpectedInput,
    { kind, operation: "update" },
  );
  for (const property of Object.keys(scalarExpectedInput)) {
    const value = parsedExpected[property];
    if (value === undefined || (typeof value === "object" && value !== null)) {
      throw new ValidationError(
        `compareAndSet() expected property "${property}" did not resolve to a JSON scalar`,
        {
          entityType: "node",
          kind,
          operation: "update",
          issues: [{ path: property, message: "Expected a JSON scalar" }],
        },
      );
    }
    assertJsonValue(
      value,
      property,
      `Node "${kind}" compareAndSet expected state`,
    );
    expected[property] = { kind: "value", value: value as JsonScalar };
  }
  return expected;
}

/**
 * Executes an atomic, set-based update of current nodes. The backend returns
 * every after-image so the Store can validate the complete rows before
 * rebuilding all derived sidecars inside the same transaction.
 */
export async function executeNodeSetUpdate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  inputPatch: Record<string, unknown>,
  candidateIds: CompiledSelectSql,
  candidateIdColumn: string,
  backend: GraphBackend | TransactionBackend,
  request: NodeSetUpdateRequest,
): Promise<Readonly<{ affectedCount: number }>> {
  const operation = request.operation;
  const registration = getNodeRegistration(ctx.graph, kind);
  const schema = registration.type.schema;
  const uniqueConstraints = registration.unique ?? [];

  if (!backend.capabilities.execution.interactiveTransactions) {
    throw new ConfigurationError(
      `${operation}() requires a transactional backend so validation and sidecars are atomic`,
      { code: "SET_UPDATE_TRANSACTIONS_REQUIRED", kind },
    );
  }
  if (operation === "updateWhere" && backend.updateNodeSet === undefined) {
    throw new ConfigurationError(
      "This backend does not support set-based node updates",
      { code: "SET_UPDATE_UNSUPPORTED", kind },
    );
  }
  if (
    operation === "compareAndSet" &&
    backend.compareAndSetNode === undefined
  ) {
    throw new ConfigurationError(
      "This backend does not support node compare-and-set",
      { code: "COMPARE_AND_SET_UNSUPPORTED", kind },
    );
  }
  if (Object.keys(inputPatch).length === 0) {
    throw new ValidationError(`${operation}() patch must not be empty`, {
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
      `Unknown ${kind} property in ${operation}() patch: ${unknownProperty}`,
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
    assertJsonValue(value, property, `Node "${kind}" ${operation} patch`);
    patch[property] = value as JsonValue;
  }
  if (Object.keys(patch).length === 0 && unsetProperties.length === 0) {
    throw new ValidationError(
      `${operation}() patch has no recognized properties`,
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

  const expected =
    request.operation === "compareAndSet" ?
      normalizeCompareAndSetExpectations(schema, kind, request.expected)
    : createDataKeyedBag<NodePropertyExpectation>();

  if (
    uniqueConstraints.length > 0 &&
    missingRequiredExtras(
      UNIQUE_SIDECAR_BATCH,
      ctx.uniqueSidecarBatch,
      "set-based node update",
    ).length > 0
  ) {
    throw new ConfigurationError(
      "updateWhere() requires batched uniqueness sidecar operations for constrained nodes",
      { code: "SET_UPDATE_UNIQUENESS_UNSUPPORTED", kind },
    );
  }
  if (getSearchableFields(schema).length > 0) {
    // A fulltext-off backend (`resolveBackendFulltext` returns `false`) gets
    // the same typed capability refusal every other fulltext entry point
    // raises, rather than the member-presence assertions below — those are
    // for a backend that DOES have fulltext but lacks one of the four
    // members the write plan calls, mirroring the batched-uniqueness and
    // batched-vector checks around it.
    if (resolveBackendFulltext(backend) === false) {
      refuseFulltextUnavailable(backend, kind);
    }
    // Fulltext is available, so a missing batch member here is not an
    // availability decision but a backend contract violation — the same
    // invariant `syncFulltextBatchForKind` asserts on its own members.
    assertFulltextMember(backend.upsertFulltext, "upsertFulltext", backend);
    assertFulltextMember(backend.deleteFulltext, "deleteFulltext", backend);
    assertFulltextMember(
      backend.upsertFulltextBatch,
      "upsertFulltextBatch",
      backend,
    );
    assertFulltextMember(
      backend.deleteFulltextBatch,
      "deleteFulltextBatch",
      backend,
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

  const hookContext = ctx.createBulkOperationContext(operation, kind);
  return ctx.withBulkOperationHooks(hookContext, () =>
    runWritePlan(
      nodeWritePlanContext(ctx),
      // The set update re-checks every changed unique key across the
      // constraint's scope before rebuilding the sidecars, so a shared-scope
      // constraint makes it a constrained write like any other update.
      // Identity does not participate: a set update rewrites props, and no
      // patch can change a node's kind.
      nodeWritePlan(nodeFencesConstraintProbe(ctx, kind, "update"), false),
      backend,
      (session) =>
        session.reviseNodeSet(
          operation === "compareAndSet" ?
            {
              operation: "compareAndSet",
              kind,
              schema,
              uniqueConstraints,
              patch,
              unsetProperties,
              candidateIds,
              candidateIdColumn,
              expected,
            }
          : {
              operation: "updateWhere",
              kind,
              schema,
              uniqueConstraints,
              patch,
              unsetProperties,
              candidateIds,
              candidateIdColumn,
            },
          // This path states no window — it patches properties — so the write
          // asserts no stored lower bound. The set UPDATE has no field to
          // carry one, so a future windowed set update is refused here rather
          // than run unfenced.
          { validityLowerBound: {} },
        ),
      { didWrite: (result) => result.affectedCount > 0 },
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
  options?: Readonly<{
    clearDeleted?: boolean;
    /**
     * Item E.2. Present only from `executeNodeGetOrCreateByConstraint`'s
     * resurrection leg: `partOf` restores the whole alone (Q2), in the SAME
     * transaction as the resurrecting write, so a lost composition claim or
     * a dead/missing whole aborts the resurrection too.
     */
    compositionWork?: CompositionCreateWork;
  }>,
): Promise<Node> {
  if (input.clearValidTo === true) {
    assertClearValidToSupported(backend, "node");
  }
  const compositionWork = options?.compositionWork;
  return runWritePlan(
    nodeWritePlanContext(ctx),
    // `mixedWritePlan` unconditionally — see `executeNodeCreateInternal`'s
    // identical note: `entity` only widens the STATIC session type, with no
    // runtime effect on a call that carries no `compositionWork`.
    mixedWritePlan(
      nodeFencesConstraintProbe(ctx, input.kind, "update") ??
        (compositionWork === undefined ? undefined : (
          compositionEdgeConstraintFence(ctx, compositionWork)
        )),
      // Conditional for the same reason as {@link executeNodeUpdate}: a
      // resurrecting upsert folds, and stating a validity end reads the
      // identity's other members, so both take the lock.
      options?.clearDeleted === true || input.validTo !== undefined ?
        nodeRequiresIdentityLock(ctx)
      : false,
    ),
    backend,
    async (session, target, _overlaidSession, lock) => {
      const validTo = validateOptionalCanonicalIsoDate(
        input.validTo,
        "validTo",
      );
      const identity = ctx.identity;
      if (identity !== undefined && validTo !== undefined) {
        await identity.requireValidityEndCompatible(
          target,
          { kind: input.kind, id: input.id },
          validTo,
        );
      }
      const node = await performNodeUpdateWithResurrectionRecovery(
        ctx,
        input,
        session,
        target,
        options,
      );
      if (options?.clearDeleted && identity !== undefined) {
        await identity.foldCreated(
          target,
          [{ kind: input.kind, id: input.id }],
          "restore",
        );
      }
      await attachCompositionCreateEdge(
        ctx,
        session,
        target,
        lock,
        compositionWork,
        input.id,
      );
      return node;
    },
    { didWrite: writeResultAlwaysChanges },
  );
}

/**
 * Executes an already-resolved set of node upsert updates under one write plan.
 *
 * Collection-level resolution still owns input order, repeated-id running
 * state, and create/update partitioning. This boundary owns the database work:
 * one graph fence and one write session cover the complete update set instead
 * of opening a managed frame for every member.
 */
export async function executeNodeResolvedMutationSet<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  creates: readonly CreateNodeInput[],
  updates: readonly NodeUpsertUpdateBatchEntry[],
  backend: GraphBackend | TransactionBackend,
): Promise<
  ResolvedMutationSetAttempt<
    Readonly<{ created: readonly Node[]; updated: readonly Node[] }>
  >
> {
  if (creates.length === 0 || updates.length === 0) {
    return unsupportedResolvedMutationSet();
  }
  const firstUpdate = requireDefined(updates[0]);
  const executor = resolveAtomicNodeResolvedMutationSetExecutor({
    backend,
    graph: ctx.graph,
    schemaVersion: ctx.schemaVersion,
    historyEnabled: ctx.historyEnabled,
    revisionTrackingEnabled: ctx.revisionTrackingEnabled,
    kind: firstUpdate.input.kind,
    creates,
    updateCount: updates.length,
    identityEnabled: ctx.identity !== undefined,
    registry: ctx.registry,
  });
  if (executor === undefined) return unsupportedResolvedMutationSet();
  const ids = new Set([
    ...creates.map((input) => requireDefined(input.id)),
    ...updates.map((entry) => entry.input.id),
  ]);
  if (ids.size !== creates.length + updates.length) {
    return unsupportedResolvedMutationSet();
  }
  if (
    updates.some(
      (entry) =>
        entry.clearDeleted ||
        entry.existing === undefined ||
        entry.input.validFrom !== undefined ||
        entry.input.validTo !== undefined ||
        entry.input.clearValidTo === true,
    )
  ) {
    return unsupportedResolvedMutationSet();
  }

  // The eligibility owner above excludes every node kind whose create planner
  // can emit claims. Preparation is allowed to normalize that proven shape,
  // not to reopen eligibility after the operation has committed to this
  // executor. A claim here therefore means those two owners drifted.
  const preparedCreates = await prepareAtomicBatchCreates(
    ctx,
    creates,
    backend,
  );
  const createEntries = atomicNodeBatchEntries(preparedCreates, undefined);
  if (createEntries === undefined) {
    throw new CompilerInvariantError(
      "An eligible resolved node mutation set produced unsupported create claims.",
    );
  }
  const resolvedUpdates = updates.map((entry) => {
    const existing = requireDefined(entry.existing);
    const validatedProps =
      entry.replacementProps ??
      resolveNodeUpdateProps(ctx, existing, entry.input.props).validatedProps;
    return {
      graphId: ctx.graphId,
      kind: entry.input.kind,
      id: entry.input.id,
      props: validatedProps,
      expectedVersion: existing.version,
      projections: resolveAtomicNodeProjections(
        getNodeRegistration(ctx.graph, entry.input.kind).type.schema,
        validatedProps,
      ),
    };
  });
  const result = await withAlreadyExistsTranslation("node", () =>
    executor({
      creates: createEntries,
      updates: resolvedUpdates,
      schemaFence: {
        graphId: ctx.graphId,
        expectedVersion: requireDefined(ctx.schemaVersion),
      },
    }),
  );
  if (result.created.length === 0 && result.updated.length === 0) {
    await diagnoseFusedSchemaFenceNoRow(ctx, backend);
    throw new ResolvedMutationSetMoved("node", executor);
  }
  if (
    result.created.length !== creates.length ||
    result.updated.length !== updates.length
  ) {
    throw new CompilerInvariantError(
      "Atomic resolved node mutation set returned a partial result.",
    );
  }
  memoizeLeasedSchemaFence(ctx, backend);
  const created = restoreAtomicNodeBatchRows(
    ctx.graphId,
    preparedCreates,
    result.created,
  ).map((row) => rowToNode(row));
  const updatedById = new Map(result.updated.map((row) => [row.id, row]));
  return appliedResolvedMutationSet({
    created,
    updated: updates.map((entry) =>
      rowToNode(requireDefined(updatedById.get(entry.input.id))),
    ),
  });
}

export async function executeNodeUpsertUpdateBatch<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  entries: readonly NodeUpsertUpdateBatchEntry[],
  backend: GraphBackend | TransactionBackend,
): Promise<readonly Node[]> {
  if (entries.length === 0) return [];
  for (const entry of entries) {
    if (entry.input.clearValidTo === true) {
      assertClearValidToSupported(backend, "node");
    }
  }

  const first = requireDefined(entries[0]);
  const distinctIds = new Set(entries.map((entry) => entry.input.id));
  const atomicExecutor = resolveAtomicNodeUpdateExecutor(ctx, entries, backend);
  if (atomicExecutor !== undefined) {
    return executeAtomicNodeResolvedUpdates(
      ctx,
      entries,
      backend,
      atomicExecutor,
    );
  }

  return runWritePlan(
    nodeWritePlanContext(ctx),
    nodeWritePlan(
      nodeFencesConstraintProbe(ctx, first.input.kind, "update"),
      entries.some(
        (entry) => entry.clearDeleted || entry.input.validTo !== undefined,
      ) && nodeRequiresIdentityLock(ctx),
    ),
    backend,
    async (session, target) => {
      const resolvedRows =
        (
          target.capabilities.execution.interactiveTransactions &&
          distinctIds.size === entries.length
        ) ?
          await getNodeRowsByIds(
            target,
            ctx.batchPointRead,
            ctx.graphId,
            first.input.kind,
            [...distinctIds],
          )
        : undefined;
      const nodes: Node[] = [];
      for (const entry of entries) {
        nodes.push(
          await performNodeUpdateWithResurrectionRecovery(
            ctx,
            entry.input,
            session,
            target,
            entry.clearDeleted || entry.replacementProps !== undefined ?
              {
                ...(entry.clearDeleted ? { clearDeleted: true } : {}),
                ...(entry.replacementProps === undefined ?
                  {}
                : { replacementProps: entry.replacementProps }),
              }
            : undefined,
            resolvedRows?.get(entry.input.id),
          ),
        );
        if (entry.clearDeleted && ctx.identity !== undefined) {
          await ctx.identity.foldCreated(
            target,
            [{ kind: entry.input.kind, id: entry.input.id }],
            "restore",
          );
        }
      }
      return nodes;
    },
    { didWrite: writeResultAlwaysChanges },
  );
}

async function executeAtomicNodeResolvedUpdates<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  entries: readonly NodeUpsertUpdateBatchEntry[],
  backend: GraphBackend | TransactionBackend,
  atomicExecutor: AtomicNodeResolvedUpdateBatchExecutor,
): Promise<readonly Node[]> {
  const maxAttempts = atomicResolvedUpdateAttemptBudget(
    entries.length,
    NODE_UPDATE_ATTEMPTS,
  );
  const first = requireDefined(entries[0]);
  const distinctIds = new Set(entries.map((entry) => entry.input.id));
  const supplied = entries.flatMap((entry) =>
    entry.existing === undefined ? [] : [entry.existing],
  );
  const fetched =
    supplied.length === entries.length ?
      undefined
    : await getNodeRowsByIds(
        backend,
        ctx.batchPointRead,
        ctx.graphId,
        first.input.kind,
        [...distinctIds],
      );
  let existing = fetched === undefined ? supplied : [...fetched.values()];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const byId = new Map(existing.map((row) => [row.id, row]));
    const missing = entries.find((entry) => {
      const row = byId.get(entry.input.id);
      return row === undefined || row.deleted_at !== undefined;
    });
    if (missing !== undefined) {
      // This update-only partition was resolved from live rows. Once a
      // refreshed preimage is absent or tombstoned, the requested update
      // target no longer exists; do not reinterpret it as a create or fall
      // through to a transactionless portable write.
      throw new NodeNotFoundError(first.input.kind, missing.input.id);
    }
    const resolved = entries.map((entry) => {
      const row = requireDefined(byId.get(entry.input.id));
      const validatedProps =
        entry.replacementProps ??
        resolveNodeUpdateProps(ctx, row, entry.input.props).validatedProps;
      return {
        graphId: ctx.graphId,
        kind: entry.input.kind,
        id: entry.input.id,
        props: validatedProps,
        expectedVersion: row.version,
        projections: resolveAtomicNodeProjections(
          getNodeRegistration(ctx.graph, entry.input.kind).type.schema,
          validatedProps,
        ),
      };
    });
    const rows = await atomicExecutor({
      entries: resolved,
      schemaFence: {
        graphId: ctx.graphId,
        expectedVersion: requireDefined(ctx.schemaVersion),
      },
    });
    if (rows.length === entries.length) {
      memoizeLeasedSchemaFence(ctx, backend);
      const returned = new Map(rows.map((row) => [row.id, row]));
      return entries.map((entry) =>
        rowToNode(requireDefined(returned.get(entry.input.id))),
      );
    }
    if (rows.length > 0) {
      throw new CompilerInvariantError(
        "Atomic resolved node update returned a partial result.",
        { expected: entries.length, actual: rows.length },
      );
    }
    await diagnoseFusedSchemaFenceNoRow(ctx, backend);
    if (attempt === maxAttempts) {
      throw new DatabaseOperationError(
        `Atomic node update could not be applied to stable rows after ${maxAttempts} attempts.`,
        {
          operation: "update",
          entity: "node",
          attempted: entries.map((entry) => ({
            kind: entry.input.kind,
            id: entry.input.id,
          })),
        },
      );
    }
    const refreshed = await getNodeRowsByIds(
      backend,
      ctx.batchPointRead,
      ctx.graphId,
      first.input.kind,
      [...distinctIds],
    );
    existing = [...refreshed.values()];
  }
  throw new CompilerInvariantError(
    "Atomic resolved node update exhausted its retry loop.",
  );
}

// ============================================================
// Node Delete Operations
// ============================================================

/**
 * One node delete's row-work result: whether it wrote, and which composition
 * parts its cascade removed.
 *
 * Carried on the RESULT rather than captured in a mutable local, because
 * `runInWriteTransaction` may retry the whole frame under the
 * `"optimistic-retry"` tier: a local would accumulate a rolled-back
 * attempt's parts alongside the surviving attempt's, while the result is
 * always the last attempt's alone.
 */
type NodeDeleteOutcome = Readonly<{
  wrote: boolean;
  /** Leaf-first, empty when the kind declares no composition parts. */
  cascadedParts: readonly CompositionNodeRef[];
}>;

const NODE_DELETE_NOT_WRITTEN: NodeDeleteOutcome = {
  wrote: false,
  cascadedParts: [],
};

/**
 * One batch node delete's row-work result: how many items it actually
 * retired, and every composition part their cascades removed, leaf-first
 * within each item and in the batch's own item order.
 *
 * On the RESULT for {@link NodeDeleteOutcome}'s reason — an
 * `"optimistic-retry"` replay of the frame must report the surviving
 * attempt's parts alone.
 */
type NodeDeleteBatchOutcome = Readonly<{
  affectedCount: number;
  cascadedParts: readonly CompositionNodeRef[];
}>;

function nodeDeleteWrote(outcome: NodeDeleteOutcome): boolean {
  return outcome.wrote;
}

/**
 * THE delete-operation facts its `onOperationEnd` context carries — see
 * {@link OperationOutcomeFacts}. Shared by the soft and hard single-delete
 * paths so the two cannot report the cascade differently.
 */
function nodeDeleteOperationFacts(
  outcome: NodeDeleteOutcome,
): OperationOutcomeFacts {
  return { cascadedParts: outcome.cascadedParts };
}

export async function executeNodeDelete<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  id: string,
  backend: GraphBackend | TransactionBackend,
  policy?: NodeDeletePolicy,
): Promise<void> {
  // Gate outside hooks and execution (matching edge deletes): an absent or
  // already-tombstoned node is a no-op, so it neither fires hooks nor submits
  // a write. Eligible plain deletes carry the live/restrict/schema verdicts in
  // one closed program. The portable cascade re-reads inside its transaction,
  // so a node concurrently deleted between this gate and the write lock is
  // still handled correctly.
  const gate = await backend.getNode(ctx.graphId, kind, id);
  if (!gate || gate.deleted_at) return;

  const opContext = ctx.createOperationContext("delete", "node", kind, id);

  // The fused atomic executor has no notion of `policy`: its restrict check
  // is a single, read-free SQL shape that cannot narrow the edges it counts
  // and cannot skip its own enforcement. A policy stating a dimension it
  // cannot honor therefore always takes the portable path below, which is
  // the only path that reads and honors `policy` (see
  // `enforceNodeDeleteBehavior`) — the fused command is an optimization
  // attempt, not evidence its dimensions ran, and must not be reached when a
  // dimension it cannot honor is in play. `nodeDeletePolicyRequiresPortablePath`
  // is the one owner of that decision across every policy dimension.
  const atomicExecutor =
    nodeDeletePolicyRequiresPortablePath(policy) ? undefined : (
      resolveAtomicNodeDeleteBatchExecutor({
        backend,
        graph: ctx.graph,
        kind,
        ids: [id],
        schemaVersion: ctx.schemaVersion,
        identityEnabled: ctx.identity !== undefined,
        registry: ctx.registry,
        historyEnabled: ctx.historyEnabled,
        revisionTrackingEnabled: ctx.revisionTrackingEnabled,
      })
    );
  if (atomicExecutor !== undefined) {
    await runAtomicProgramWithHooks(
      ctx,
      opContext,
      () => executeAtomicNodeDeletes(ctx, kind, [id], backend, atomicExecutor),
      (affectedCount) => affectedCount > 0,
    );
    return;
  }

  const outcome = await runHookedWritePlan(
    nodeWritePlanContext(ctx),
    opContext,
    nodeWritePlan(
      nodeDeleteConstraintProbe(ctx, kind),
      nodeRequiresIdentityLock(ctx),
    ),
    backend,
    async (
      session,
      target,
      _overlaidSession,
      lock,
    ): Promise<NodeDeleteOutcome> => {
      const identity = ctx.identity;
      const registration = getNodeRegistration(ctx.graph, kind);
      // This preflight is NOT removable round-trip fat: the soft-delete
      // pipeline consumes the pre-image (uniqueness entries are keyed by
      // props-derived constraint keys), and this in-transaction read is
      // the concurrency-correct source for it.
      const preflight = await target.getNode(ctx.graphId, kind, id);
      if (!preflight || !isLiveNodeRow(preflight)) {
        return NODE_DELETE_NOT_WRITTEN;
      }

      // Composition parts, leaf-first, BEFORE the whole itself — under the
      // per-graph write lock this write plan already fenced for a
      // composition whole (`nodeDeleteConstraintProbe`).
      const cascadePlan = await runCompositionCascade(
        ctx,
        kind,
        id,
        target,
        lock,
        "soft",
        policy,
        session,
      );

      // The cascade (connected edges, uniques, embeddings, fulltext, node) is
      // not individually atomic, so it runs in one write transaction. Under
      // recorded-time capture this also collapses the cascade into a single
      // recorded commit instant instead of one instant per sub-write.
      await session.retireNode(
        {
          existing: preflight,
          schema: registration.type.schema,
          uniqueConstraints: registration.unique ?? [],
          onDelete: registration.onDelete,
        },
        withCascadeConsumedEdges(policy, cascadePlan.consumedEdgeIds),
      );
      if (identity !== undefined) {
        await identity.detachDeleted(target, { kind, id }, "soft");
      }
      return {
        wrote: true,
        cascadedParts: cascadedPartReferences(cascadePlan),
      };
    },
    {
      didWrite: nodeDeleteWrote,
      operationFacts: nodeDeleteOperationFacts,
    },
  );
  ctx.recordCascadedParts?.(outcome.cascadedParts);
}

async function findConnectedEdgesForNodeBatch<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  ids: readonly string[],
  backend: GraphBackend | TransactionBackend,
): Promise<ReadonlyMap<string, readonly BackendEdgeRow[]> | undefined> {
  const setRead = backend.findEdgesByHeterogeneousEndpointSet;
  if (setRead === undefined) return;

  const uniqueIds = [...new Set(ids)];
  const edgeKinds = Object.keys(ctx.graph.edges);
  const connectedByNode = new Map<string, Map<string, BackendEdgeRow>>();
  for (const id of uniqueIds) connectedByNode.set(id, new Map());
  if (edgeKinds.length === 0) return;

  const endpoints = uniqueIds.map((id) => ({ kind, id }));
  const [fromRows, toRows] = await Promise.all([
    setRead({
      graphId: ctx.graphId,
      side: "from",
      endpoints,
      edgeKinds,
      excludeDeleted: true,
    }),
    setRead({
      graphId: ctx.graphId,
      side: "to",
      endpoints,
      edgeKinds,
      excludeDeleted: true,
    }),
  ]);
  // The closed program deliberately checks every stored edge kind, while the
  // heterogeneous set port is licensed by the reconciled graph's kind set.
  // No licensed rows after a refusal is therefore insufficient evidence: let
  // the caller recover through the kind-blind scalar authority.
  if (fromRows.length === 0 && toRows.length === 0) return;
  for (const row of fromRows) {
    connectedByNode.get(row.from_id)?.set(row.id, row);
  }
  for (const row of toRows) {
    connectedByNode.get(row.to_id)?.set(row.id, row);
  }
  return new Map(
    [...connectedByNode].map(([id, rows]) => [id, [...rows.values()]]),
  );
}

/**
 * Soft-deletes a batch without per-item operation hooks.
 *
 * Batch collection methods deliberately omit per-item hooks for throughput.
 * Owning the write transaction here also prevents a per-item success from
 * being reported before the batch's outer COMMIT.
 *
 * Takes no {@link NodeDeletePolicy} — every item's delete-behavior
 * enforcement always runs unnarrowed by a caller-supplied
 * `consumedEdgeIds` — but a composition whole in the batch still cascades to
 * its own parts: `runCompositionCascade` per item, under the one write
 * lock this batch's plan fences for when `kind` declares composition parts.
 *
 * Every item's cascaded parts are reported to the transaction receipt
 * (`ctx.recordCascadedParts`), accumulated on the row-work RESULT for the
 * reason {@link NodeDeleteOutcome} states: an `"optimistic-retry"` replay of
 * the frame must report the surviving attempt's parts alone, which a mutable
 * local spanning the retry could not. Per-item operation HOOKS stay absent,
 * as they are for every other dimension of a batch delete — the receipt is
 * transaction-scoped, not per-item.
 */
export async function executeNodeDeleteBatch<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  ids: readonly string[],
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  const atomicExecutor = resolveAtomicNodeDeleteBatchExecutor({
    backend,
    graph: ctx.graph,
    kind,
    ids,
    schemaVersion: ctx.schemaVersion,
    identityEnabled: ctx.identity !== undefined,
    registry: ctx.registry,
    historyEnabled: ctx.historyEnabled,
    revisionTrackingEnabled: ctx.revisionTrackingEnabled,
  });
  if (atomicExecutor !== undefined) {
    await executeAtomicNodeDeletes(ctx, kind, ids, backend, atomicExecutor);
    return;
  }

  const outcome = await runWritePlan(
    nodeWritePlanContext(ctx),
    nodeWritePlan(
      nodeDeleteConstraintProbe(ctx, kind),
      nodeRequiresIdentityLock(ctx),
    ),
    backend,
    async (
      session,
      target,
      _overlaidSession,
      lock,
    ): Promise<NodeDeleteBatchOutcome> => {
      const identity = ctx.identity;
      const registration = getNodeRegistration(ctx.graph, kind);
      let affectedCount = 0;
      const cascadedParts: CompositionNodeRef[] = [];

      for (const id of ids) {
        // This is both the existence gate and the concurrency-correct
        // pre-image consumed by uniqueness cleanup. It must stay inside the
        // batch transaction after the graph write lock is held.
        const preflight = await target.getNode(ctx.graphId, kind, id);
        if (!preflight || !isLiveNodeRow(preflight)) continue;

        const cascadePlan = await runCompositionCascade(
          ctx,
          kind,
          id,
          target,
          lock,
          "soft",
          undefined,
          session,
        );
        cascadedParts.push(...cascadedPartReferences(cascadePlan));

        await session.retireNode(
          {
            existing: preflight,
            schema: registration.type.schema,
            uniqueConstraints: registration.unique ?? [],
            onDelete: registration.onDelete,
          },
          withCascadeConsumedEdges(undefined, cascadePlan.consumedEdgeIds),
        );
        if (identity !== undefined) {
          await identity.detachDeleted(target, { kind, id }, "soft");
        }
        affectedCount += 1;
      }

      return { affectedCount, cascadedParts };
    },
    { didWrite: (result) => result.affectedCount > 0 },
  );
  ctx.recordCascadedParts?.(outcome.cascadedParts);
}

async function executeAtomicNodeDeletes<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  ids: readonly string[],
  backend: GraphBackend | TransactionBackend,
  atomicExecutor: AtomicNodeDeleteBatchExecutor,
): Promise<number> {
  try {
    const result = await atomicExecutor({
      graphId: ctx.graphId,
      kind,
      ids,
      schemaFence: {
        graphId: ctx.graphId,
        expectedVersion: requireDefined(ctx.schemaVersion),
      },
    });
    await assertAtomicDeleteSchemaFenceMatched(
      result.schemaFenceMatched,
      ctx,
      backend,
      "node",
    );
    return result.affectedCount;
  } catch (error) {
    if (!(error instanceof AtomicNodeDeleteRestrictedRefusalError)) throw error;
    const connectedById = await findConnectedEdgesForNodeBatch(
      ctx,
      kind,
      ids,
      backend,
    );
    for (const id of ids) {
      const connectedEdges =
        connectedById?.get(id) ??
        (await backend.findEdgesConnectedTo({
          graphId: ctx.graphId,
          nodeKind: kind,
          nodeId: id,
        }));
      if (connectedEdges.length === 0) continue;
      throw new RestrictedDeleteError({
        nodeKind: kind,
        nodeId: id,
        edgeCount: connectedEdges.length,
        edgeKinds: [...new Set(connectedEdges.map((edge) => edge.kind))],
      });
    }
    throw new DatabaseOperationError(
      "Atomic node delete refused a connected edge, but no current " +
        "restriction could be diagnosed. The connected edge may have " +
        "changed concurrently after the atomic program aborted.",
      { operation: "delete", entity: "node" },
      { cause: error.cause },
    );
  }
}

/**
 * Executes a node hard delete operation (permanent removal).
 *
 * Unlike soft delete, this permanently removes the node and all
 * associated data (uniqueness entries, embeddings) from the database. A
 * composition whole still cascades to its parts first, leaf-first, through
 * their own hard-delete pipeline — the mirror of the soft-delete cascade in
 * {@link executeNodeDelete}.
 */
export async function executeNodeHardDelete<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  id: string,
  backend: GraphBackend | TransactionBackend,
  policy?: NodeDeletePolicy,
): Promise<void> {
  // Gate outside hooks and transaction so an absent node neither fires hooks
  // nor opens an empty transaction (see executeNodeDelete). The cascade
  // re-reads inside the transaction.
  const gate = await backend.getNode(ctx.graphId, kind, id);
  if (!gate) return;

  const opContext = ctx.createOperationContext("delete", "node", kind, id);

  const outcome = await runHookedWritePlan(
    nodeWritePlanContext(ctx),
    opContext,
    nodeWritePlan(
      nodeDeleteConstraintProbe(ctx, kind),
      nodeRequiresIdentityLock(ctx),
    ),
    backend,
    async (
      session,
      target,
      _overlaidSession,
      lock,
    ): Promise<NodeDeleteOutcome> => {
      const identity = ctx.identity;
      const registration = getNodeRegistration(ctx.graph, kind);
      // No in-transaction preflight (unlike soft delete, whose pipeline
      // consumes the pre-image for uniqueness-key cleanup): every hard
      // cascade member is id-keyed and idempotent — the delete-behavior
      // check re-reads edges itself, `hardDeleteNode` deletes by primary
      // key, and embeddings clean up by id — so a node concurrently
      // removed between the gate and the write lock makes each statement
      // a 0-row no-op.

      // Composition parts, leaf-first, BEFORE the whole itself.
      const cascadePlan = await runCompositionCascade(
        ctx,
        kind,
        id,
        target,
        lock,
        "hard",
        policy,
        session,
      );

      // The cascade (edges, node, embeddings) is not individually atomic, so
      // it runs in one write transaction. Embeddings live in strategy-owned
      // per-`(kind, field)` tables, so they are cleaned up here rather than
      // in the backend's graph-agnostic `hardDeleteNode` cascade.
      await session.purgeNode(
        {
          kind,
          id,
          schema: registration.type.schema,
          onDelete: registration.onDelete,
        },
        withCascadeConsumedEdges(policy, cascadePlan.consumedEdgeIds),
      );
      if (identity !== undefined) {
        await identity.detachDeleted(target, { kind, id }, "hard");
      }
      return {
        wrote: true,
        cascadedParts: cascadedPartReferences(cascadePlan),
      };
    },
    // No `didWrite`: a hard delete reports no authoritative mutation verdict
    // (its statements are id-keyed and idempotent), so `onOperationEnd`'s
    // outcome stays `"unknown"` exactly as it always has.
    { operationFacts: nodeDeleteOperationFacts },
  );
  ctx.recordCascadedParts?.(outcome.cascadedParts);
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
  const partOf = options?.partOf;

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
      createInputWithPartOf(kind, validatedProps, partOf),
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

  const kindsToCheck = uniquenessProbeKinds(
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
        createInputWithPartOf(kind, validatedProps, partOf),
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
        createInputWithPartOf(kind, validatedProps, partOf),
        backend,
        { propsPreValidated: true },
      );
      return { node, action: "created" };
    }

    const isSoftDeleted = existingRow.deleted_at !== undefined;

    if (isSoftDeleted || ifExists === "update") {
      const concreteKind = existingUniqueRow.concrete_kind;
      if (!isSoftDeleted && partOf !== undefined) {
        await applyExistingPartOfPostcondition(
          ctx,
          backend,
          concreteKind,
          existingRow.id,
          partOf,
        );
      }
      // Resurrection restores the whole alone (Q2): resolved against the
      // TOMBSTONE's own kind/id, never against `kind` as requested (a
      // subclass scope can resurrect under a sibling/parent kind).
      const compositionWork =
        isSoftDeleted ?
          resolveCompositionCreate(ctx.registry, {
            kind: concreteKind,
            id: existingRow.id,
            ...(partOf === undefined ? {} : { partOf }),
          })
        : undefined;
      const node = await executeNodeUpsertUpdate(
        ctx,
        {
          kind: concreteKind,
          id: existingRow.id as UpdateNodeInput["id"],
          props: validatedProps,
        },
        backend,
        {
          clearDeleted: isSoftDeleted,
          ...(compositionWork === undefined ? {} : { compositionWork }),
        },
      );
      return { node, action: isSoftDeleted ? "resurrected" : "updated" };
    }

    if (partOf !== undefined) {
      await applyExistingPartOfPostcondition(
        ctx,
        backend,
        existingUniqueRow.concrete_kind,
        existingRow.id,
        partOf,
      );
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

  const kindsToCheck = uniquenessProbeKinds(
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

  const kindsToCheck = uniquenessProbeKinds(
    kind,
    constraint.scope,
    ctx.registry,
  );

  const existingByKey =
    uniqueKeys.length > 0 ?
      await batchCheckUniqueAcrossKinds(
        backend,
        ctx.uniqueSidecarBatch,
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
    ctx.batchPointRead,
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
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>,
  graphId: string,
  kind: string,
  ids: readonly string[],
): Promise<Map<string, Node>> {
  const rowsById = await getNodeRowsByIds(
    backend,
    batchPointRead,
    graphId,
    kind,
    ids,
  );
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
  const partOf = options?.partOf;
  const registration = getNodeRegistration(ctx.graph, kind);
  const nodeKind = registration.type;
  const constraint = resolveConstraint(ctx.graph, kind, constraintName);

  // Step 1: Validate all props and compute keys
  const validated = validateAndComputeKeys(nodeKind, kind, constraint, items);
  const uniqueKeys = collectUniqueKeys(validated);

  const kindsToCheck = uniquenessProbeKinds(
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
          ctx.uniqueSidecarBatch,
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
        toCreate.push({
          index,
          input: createInputWithPartOf(kind, validatedProps, partOf),
        });
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
        toCreate.push({
          index,
          input: createInputWithPartOf(kind, validatedProps, partOf),
        });
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
          createInputWithPartOf(kind, validatedProps, partOf),
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
        if (!isSoftDeleted && partOf !== undefined) {
          await applyExistingPartOfPostcondition(
            ctx,
            backend,
            concreteKind,
            existingRow.id,
            partOf,
          );
        }
        // Resurrection restores the whole alone (Q2) — see the single-item
        // path's identical reasoning.
        const compositionWork =
          isSoftDeleted ?
            resolveCompositionCreate(ctx.registry, {
              kind: concreteKind,
              id: existingRow.id,
              ...(partOf === undefined ? {} : { partOf }),
            })
          : undefined;
        const node = await executeNodeUpsertUpdate(
          ctx,
          {
            kind: concreteKind,
            id: existingRow.id as UpdateNodeInput["id"],
            props: validatedProps,
          },
          backend,
          {
            clearDeleted: isSoftDeleted,
            ...(compositionWork === undefined ? {} : { compositionWork }),
          },
        );
        results[index] = {
          node,
          action: isSoftDeleted ? "resurrected" : "updated",
        };
      } else {
        if (partOf !== undefined) {
          await applyExistingPartOfPostcondition(
            ctx,
            backend,
            concreteKind,
            existingRow.id,
            partOf,
          );
        }
        results[index] = { node: rowToNode(existingRow), action: "found" };
      }
    }

    // Step 6: Resolve within-batch duplicates by copying the first occurrence's result.
    //
    // No `partOf` postcondition call belongs here. A duplicate resolves to
    // the SAME node as its source, and the source already had the
    // postcondition discharged: steps 4/5 either wrote the attachment with
    // the row (`"created"`/`"resurrected"`, `resolveCompositionCreate`'s
    // work), or ran `applyExistingPartOfPostcondition` against it
    // (`"found"`/`"updated"`), which returned only once the node provably
    // held the stated attachment. Re-checking the same node once per
    // duplicate would re-read the same rows for the same verdict.
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
