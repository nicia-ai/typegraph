/**
 * Composable node write steps — the integrity side effects that every node
 * mutation must apply, extracted so there is a single implementation instead of
 * one hand-stitched copy per write path.
 *
 * A node mutation is the core row write plus a fixed set of side effects:
 * uniqueness entries, embedding sync, fulltext sync, and — for deletes —
 * delete-behavior enforcement over connected edges. These steps are shared by
 * the canonical collection operations (create / update / delete) and by
 * provenance retraction, which drives the same close/reopen of a fact node's
 * currency but skips delete-behavior enforcement so every connected edge
 * survives for a later reopen.
 *
 * The steps assume they run inside a write transaction (see
 * {@link runInWriteTransaction}); they perform no transaction management of
 * their own.
 */
import { type z } from "zod";

import { bindExtraIfReachable } from "../../backend/capabilities/bind";
import { UNIQUE_SIDECAR_BATCH } from "../../backend/capabilities/bundle-registry";
import {
  type BundleVerdictOf,
  type ClaimsVerdictThunk,
  missingRequiredExtras,
} from "../../backend/capabilities/resolve";
import {
  type GraphBackend,
  type LiveNodeRow,
  type NodePropertyExpectation,
  type NodeRow,
  rowPropsToObject,
  type TombstonedNodeRow,
  type TransactionBackend,
  type UpdateNodeSetResult,
} from "../../backend/types";
import {
  type DeleteBehavior,
  type JsonValue,
  type UniqueConstraint,
} from "../../core/types";
import {
  ConfigurationError,
  RestrictedDeleteError,
  ValidationError,
} from "../../errors";
import { validateNodeProps } from "../../errors/validation";
import type { CompiledSelectSql } from "../../query/sql-intent";
import { type KindRegistry } from "../../registry/kind-registry";
import { canonicalEqual } from "../../schema/canonical";
import { assertsStoredLowerBound } from "../../utils/date";
import { purgeEdgeClaims } from "../claims/edge-claims";
import {
  alreadyAppliedRowWrite,
  createUniquenessContext,
  deleteUniquenessEntries,
  hardDeleteClaimsByNodeIds,
  type NodeClaimContext,
  planNodeClaimReinsert,
  planNodeClaimUpdate,
  type UniquenessUpdatePlan,
  withNodeClaimTransition,
  withNodeCreateClaimsBatch,
} from "../claims/node-claims";
import { validateResolvedNodeClaims } from "../claims/resolved-node-claims";
import {
  deleteNodeEmbeddings,
  getEmbeddingFields,
  syncEmbeddings,
  syncEmbeddingsBatchForKind,
} from "../embedding-sync";
import {
  deleteNodeFulltext,
  getSearchableFields,
  syncFulltext,
  syncFulltextBatchForKind,
} from "../fulltext-sync";
import { type GraphWriteLock } from "../recorded-capture/clock";

type Backend = GraphBackend | TransactionBackend;

/**
 * The graph-scoped state the node write steps need. `lock` is compile-time
 * evidence that the per-graph write-lock discipline was satisfied BEFORE any
 * row work (see {@link GraphWriteLock}): the pipeline performs no locking of
 * its own, so requiring the token here makes "sidecar write before lock" a
 * type error at the call site instead of a lock-order inversion in review.
 *
 * It is the claim seam's context by definition rather than by coincidence: a
 * write path hands the same value to {@link withNodeCreateClaims} and to the
 * sync fans, so the two halves of one insert cannot be given different graphs,
 * registries, or lock evidence.
 */
export type NodeWriteContext = NodeClaimContext;

/** Builds a {@link NodeWriteContext} — the one constructor every call site shares. */
export function createNodeWriteContext(
  graphId: string,
  registry: KindRegistry,
  lock: GraphWriteLock,
  claimsVerdict: ClaimsVerdictThunk,
  uniqueSidecarBatch: BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH>,
): NodeWriteContext {
  return { graphId, registry, lock, claimsVerdict, uniqueSidecarBatch };
}

/** Whether a delete removes the node (`hard`) or tombstones it (`soft`). */
type NodeDeleteMode = "soft" | "hard";

/**
 * Tunes how a delete treats the node's connected edges.
 *
 * By default delete behavior is enforced: connected edges block a `restrict`
 * node and are removed under `cascade` / `disconnect`. Provenance retraction
 * passes `enforceDeleteBehavior: false` — closing a fact's currency is a
 * belief-status change, not a domain delete, so its edges neither block the
 * close nor get removed; they survive untouched so a later reopen is an exact
 * inverse.
 */
export type NodeDeletePolicy = Readonly<{
  enforceDeleteBehavior: boolean;
}>;

function uniquenessContext(ctx: NodeWriteContext, backend: Backend) {
  return createUniquenessContext(
    ctx.graphId,
    ctx.registry,
    backend,
    ctx.uniqueSidecarBatch,
  );
}

/**
 * The `(graphId, nodeKind, nodeId, backend)` context shared by the embedding and
 * fulltext sync helpers — `EmbeddingSyncContext` and `FulltextSyncContext` are
 * structurally identical, so one builder serves both.
 */
function nodeSyncContext(
  ctx: NodeWriteContext,
  kind: string,
  id: string,
  backend: Backend,
) {
  return { graphId: ctx.graphId, nodeKind: kind, nodeId: id, backend };
}

/**
 * Enforces a node's delete behavior against its connected edges: they block
 * the delete (`restrict`) or are removed alongside the node (`cascade` /
 * `disconnect`). Skipped entirely when the caller's {@link NodeDeletePolicy}
 * disables enforcement.
 */
async function enforceNodeDeleteBehavior(
  ctx: NodeWriteContext,
  args: Readonly<{
    kind: string;
    id: string;
    mode: NodeDeleteMode;
    onDelete: DeleteBehavior | undefined;
  }>,
  backend: Backend,
  policy?: NodeDeletePolicy,
): Promise<void> {
  if (policy?.enforceDeleteBehavior === false) return;
  const behavior = args.onDelete ?? "restrict";
  const connectedEdges = await backend.findEdgesConnectedTo({
    graphId: ctx.graphId,
    nodeKind: args.kind,
    nodeId: args.id,
  });

  if (connectedEdges.length === 0) return;

  switch (behavior) {
    case "restrict": {
      throw new RestrictedDeleteError({
        nodeKind: args.kind,
        nodeId: args.id,
        edgeCount: connectedEdges.length,
        edgeKinds: [...new Set(connectedEdges.map((edge) => edge.kind))],
      });
    }

    case "cascade":
    case "disconnect": {
      // Both behaviors remove connected edges. "cascade" signals intent to
      // remove dependent data; "disconnect" signals intent to sever the
      // relationship. The effect is identical because edges cannot exist
      // without both endpoints. One batched statement per bind-budget
      // chunk instead of one statement per edge; the per-edge loop remains
      // for backends without the batch members.
      const connectedEdgeIds = connectedEdges.map((edge) => edge.id);
      const batchDelete =
        args.mode === "hard" ?
          backend.hardDeleteEdgesBatch
        : backend.deleteEdgesBatch;
      if (batchDelete === undefined) {
        for (const edge of connectedEdges) {
          await (args.mode === "hard" ?
            backend.hardDeleteEdge({ graphId: ctx.graphId, id: edge.id })
          : backend.deleteEdge({ graphId: ctx.graphId, id: edge.id }));
        }
      } else {
        await batchDelete({
          graphId: ctx.graphId,
          ids: connectedEdgeIds,
        });
      }
      // Hard-deleted holders are already takeable through the liveness probe;
      // this is housekeeping so node cascades do not grow edgeClaims forever.
      // Soft-deleted edges retain their rows for resurrection and are not
      // reaped here.
      if (args.mode === "hard") {
        await purgeEdgeClaims(
          backend,
          ctx.claimsVerdict(),
          ctx.graphId,
          connectedEdgeIds,
        );
      }
      break;
    }
  }
}

/** One inserted row, as the post-insert sync fans read it. */
export type NodeInsertSyncItem = Readonly<{
  kind: string;
  id: string;
  schema: z.ZodType;
  props: Record<string, unknown>;
  uniqueConstraints: readonly UniqueConstraint[];
  /** True only when the fused node statement wrote every requested projection. */
  projectionsFused?: boolean;
}>;

/**
 * The sync fans that follow a node insert: embedding and fulltext.
 *
 * The claims this row owes are NOT here. They are issued by
 * {@link withNodeCreateClaims}, on the two sides of the insert their placement
 * names — a claim that is the only fence for its axis has to precede the row it
 * gates, and a function that runs entirely after the insert cannot issue one.
 * The fans have no such constraint: they are derived data, they fence nothing,
 * and they stay where they have always been.
 */
export async function applyNodeInsertSyncFans(
  ctx: NodeWriteContext,
  args: NodeInsertSyncItem,
  backend: Backend,
): Promise<void> {
  const syncContext = nodeSyncContext(ctx, args.kind, args.id, backend);
  if (args.projectionsFused === true) return;
  await Promise.all([
    syncEmbeddings(syncContext, args.schema, args.props),
    syncFulltext(syncContext, args.schema, args.props),
  ]);
}

/**
 * Batched {@link applyNodeInsertSyncFans}: one embedding batch per (kind,
 * field) and one fulltext batch per kind, instead of the per-row statement fan
 * the single-op path issues.
 */
export async function applyNodeInsertSyncFansBatch(
  ctx: NodeWriteContext,
  items: readonly NodeInsertSyncItem[],
  backend: Backend,
): Promise<void> {
  if (items.length === 0) return;

  interface KindGroup {
    schema: z.ZodType;
    rows: { nodeId: string; props: Record<string, unknown> }[];
  }
  const byKind = new Map<string, KindGroup>();
  for (const item of items) {
    const group = byKind.get(item.kind) ?? { schema: item.schema, rows: [] };
    group.rows.push({ nodeId: item.id, props: item.props });
    byKind.set(item.kind, group);
  }

  await Promise.all(
    [...byKind.entries()].flatMap(([kind, group]) => {
      const syncArguments = { graphId: ctx.graphId, nodeKind: kind, backend };
      return [
        syncEmbeddingsBatchForKind(syncArguments, group.schema, group.rows),
        syncFulltextBatchForKind(syncArguments, group.schema, group.rows),
      ];
    }),
  );
}

function parseRowProps(row: NodeRow): Record<string, unknown> {
  return rowPropsToObject(row.props);
}

/**
 * The row a node update targets. A plain update runs live-row side effects
 * (uniqueness diff, embedding/fulltext sync), so it must be handed a
 * {@link LiveNodeRow}; only an explicit `clearDeleted: true` resurrecting
 * upsert may target a possibly-tombstoned row. Encoding the pairing as a
 * union makes "live-row update pipeline on a tombstoned row" a type error.
 */
export type NodeUpdateTarget =
  | Readonly<{ existing: LiveNodeRow; clearDeleted?: false }>
  | Readonly<{ existing: NodeRow; clearDeleted: true }>;

/**
 * Decides a node update's uniqueness transition, writing nothing.
 *
 * Two shapes behind one seam. A live row diffs its old and new keys; a
 * resurrecting update (`clearDeleted` on a tombstoned row) cannot, because the
 * soft delete already removed its entries — the diff would skip an unchanged
 * key and leave the resurrected node holding NO reservation, so a later create
 * could silently duplicate the value. It re-reserves every applying key
 * instead. Both refuse a conflict before returning, and both hand the caller a
 * plan that only {@link withNodeClaimTransition} may carry out.
 */
async function planNodeUpdateUniqueness(
  ctx: NodeWriteContext,
  args: Readonly<{
    existing: NodeRow;
    validatedProps: Record<string, unknown>;
    uniqueConstraints: readonly UniqueConstraint[];
  }>,
  backend: Backend,
): Promise<UniquenessUpdatePlan> {
  const { kind, id } = args.existing;

  if (args.existing.deleted_at !== undefined) {
    return planNodeClaimReinsert(
      uniquenessContext(ctx, backend),
      kind,
      id,
      args.validatedProps,
      args.uniqueConstraints,
    );
  }

  return planNodeClaimUpdate(
    uniquenessContext(ctx, backend),
    kind,
    id,
    parseRowProps(args.existing),
    args.validatedProps,
    args.uniqueConstraints,
  );
}

/**
 * Applies a node update: uniqueness maintenance (diff-based for a live row;
 * check-and-reinsert for a resurrecting update, whose entries the soft delete
 * removed), the core row update, then embedding and fulltext sync. Returns
 * the updated row.
 *
 * ## The row write and its uniqueness transition are ONE unit
 *
 * Both can fail — the row write matches nothing when `expectedValidFrom` or the
 * `deleted_at` fence stopped holding, the uniqueness claim loses a race for a
 * key — and a caller that catches either PER ROW and commits the rest of the
 * transaction (interchange import) must never be left with half of the pair
 * applied. {@link withNodeClaimTransition} owns that sequencing and documents
 * why claim/gate/release is the only order that works; this function just hands
 * it the plan and the write.
 *
 * The embedding and fulltext syncs stay AFTER the gate: they are derived data
 * with no claim to make, so a row write that lands on nothing must not rewrite
 * a fulltext row or re-embed props no row ever received.
 */
export async function applyNodeUpdate(
  ctx: NodeWriteContext,
  args: Readonly<{
    schema: z.ZodType;
    validatedProps: Record<string, unknown>;
    uniqueConstraints: readonly UniqueConstraint[];
    validFrom?: string | null;
    validTo?: string;
    clearValidTo?: true;
    /** See {@link UpdateNodeParams.expectedValidFrom}. */
    expectedValidFrom?: string | null;
  }> &
    NodeUpdateTarget,
  backend: Backend,
): Promise<NodeRow> {
  const { kind, id } = args.existing;

  // Read-only phase: decide the sidecar changes, refuse a conflict, write
  // nothing.
  const plan = await planNodeUpdateUniqueness(
    ctx,
    {
      existing: args.existing,
      validatedProps: args.validatedProps,
      uniqueConstraints: args.uniqueConstraints,
    },
    backend,
  );

  const updateParams: {
    graphId: string;
    kind: string;
    id: string;
    props: Record<string, unknown>;
    validFrom?: string | null;
    expectedValidFrom?: string | null;
    incrementVersion?: boolean;
    clearDeleted?: boolean;
  } = {
    graphId: ctx.graphId,
    kind,
    id,
    props: args.validatedProps,
    incrementVersion: true,
  };
  if (args.validFrom !== undefined) updateParams.validFrom = args.validFrom;
  // `assertsStoredLowerBound` owns "does this fence state anything?" — the same
  // predicate the fence appliers consult, so the step that CARRIES the fence
  // and the seam that VALIDATES it cannot disagree about what an empty fence is.
  if (assertsStoredLowerBound(args)) {
    updateParams.expectedValidFrom = args.expectedValidFrom;
  }
  if (args.clearDeleted) updateParams.clearDeleted = true;

  const row = await withNodeClaimTransition(
    uniquenessContext(ctx, backend),
    kind,
    id,
    plan,
    () =>
      backend.updateNode({
        ...updateParams,
        ...(args.clearValidTo === true ? { clearValidTo: true as const }
        : args.validTo === undefined ? {}
        : { validTo: args.validTo }),
      }),
  );

  await Promise.all([
    syncEmbeddings(
      nodeSyncContext(ctx, kind, id, backend),
      args.schema,
      args.validatedProps,
    ),
    syncFulltext(
      nodeSyncContext(ctx, kind, id, backend),
      args.schema,
      args.validatedProps,
    ),
  ]);

  return row;
}

/**
 * Applies a node soft delete: delete-behavior enforcement, the tombstone
 * write, then removal of uniqueness entries, embeddings, and fulltext.
 * Requires a {@link LiveNodeRow}: deleting an already-tombstoned row would
 * re-run sidecar cleanup against entries the first delete already removed.
 */
export async function applyNodeSoftDelete(
  ctx: NodeWriteContext,
  args: Readonly<{
    existing: LiveNodeRow;
    schema: z.ZodType;
    uniqueConstraints: readonly UniqueConstraint[];
    onDelete: DeleteBehavior | undefined;
  }>,
  backend: Backend,
  policy?: NodeDeletePolicy,
): Promise<void> {
  const { kind, id } = args.existing;
  await enforceNodeDeleteBehavior(
    ctx,
    { kind, id, mode: "soft", onDelete: args.onDelete },
    backend,
    policy,
  );
  await backend.deleteNode({
    graphId: ctx.graphId,
    kind,
    id,
  });
  await deleteUniquenessEntries(
    uniquenessContext(ctx, backend),
    kind,
    id,
    parseRowProps(args.existing),
    args.uniqueConstraints,
  );
  await deleteNodeEmbeddings(
    nodeSyncContext(ctx, kind, id, backend),
    args.schema,
  );
  await deleteNodeFulltext(
    nodeSyncContext(ctx, kind, id, backend),
    args.schema,
  );
}

/**
 * Applies a node hard delete: delete-behavior enforcement, permanent removal,
 * then embedding cleanup. Uniqueness and fulltext rows are removed by the
 * backend's `hardDeleteNode` cascade; embeddings live in strategy-owned
 * per-`(kind, field)` tables the graph-agnostic cascade cannot reach, so they
 * are cleaned here.
 */
export async function applyNodeHardDelete(
  ctx: NodeWriteContext,
  args: Readonly<{
    kind: string;
    id: string;
    schema: z.ZodType;
    onDelete: DeleteBehavior | undefined;
  }>,
  backend: Backend,
): Promise<void> {
  await enforceNodeDeleteBehavior(
    ctx,
    { kind: args.kind, id: args.id, mode: "hard", onDelete: args.onDelete },
    backend,
  );
  await backend.hardDeleteNode({
    graphId: ctx.graphId,
    kind: args.kind,
    id: args.id,
  });
  await deleteNodeEmbeddings(
    nodeSyncContext(ctx, args.kind, args.id, backend),
    args.schema,
  );
}

/**
 * Reopens a soft-deleted node with its stored props (no merge, no
 * re-validation): re-checks and re-inserts uniqueness entries (the delete
 * removed them), clears the tombstone, then re-syncs embeddings and fulltext.
 * Used by provenance to reinstate a fact whose currency is restored. Returns
 * the reopened row.
 *
 * @throws {UniquenessError} when a unique key the node held was taken by
 *   another node while it was tombstoned.
 */
export async function applyNodeResurrect(
  ctx: NodeWriteContext,
  args: Readonly<{
    existing: TombstonedNodeRow;
    schema: z.ZodType;
    uniqueConstraints: readonly UniqueConstraint[];
  }>,
  backend: Backend,
): Promise<NodeRow> {
  const { kind, id } = args.existing;
  const props = parseRowProps(args.existing);
  // One unit, exactly as `applyNodeUpdate`, and for the same reason: the
  // resurrecting UPDATE carries `deleted_at IS NOT NULL`, so a peer that revived
  // this tombstone first makes it match zero rows — and the reservations that
  // revival is entitled to are the peer's, not this caller's.
  // `withNodeClaimTransition` gives them back when the gate refuses.
  const plan = await planNodeClaimReinsert(
    uniquenessContext(ctx, backend),
    kind,
    id,
    props,
    args.uniqueConstraints,
  );
  const row = await withNodeClaimTransition(
    uniquenessContext(ctx, backend),
    kind,
    id,
    plan,
    () =>
      backend.updateNode({
        graphId: ctx.graphId,
        kind,
        id,
        props,
        incrementVersion: true,
        clearDeleted: true,
      }),
  );
  await Promise.all([
    syncEmbeddings(nodeSyncContext(ctx, kind, id, backend), args.schema, props),
    syncFulltext(nodeSyncContext(ctx, kind, id, backend), args.schema, props),
  ]);
  return row;
}

/**
 * The inputs of one set-based node update: the patch the statement applies and
 * the candidate query that selects the rows it applies to.
 *
 * There is no fence field. `UpdateNodeSetParams` has no `expectedValidFrom`,
 * so a validity lower bound cannot be carried here — it is refused by
 * `NODE_SET_UPDATE_FENCE_APPLIERS` before this step is reached, rather than
 * accepted into a record that would quietly drop it.
 */
type NodeSetUpdateCommonWork = Readonly<{
  kind: string;
  schema: z.ZodType<Record<string, unknown>>;
  uniqueConstraints: readonly UniqueConstraint[];
  patch: Readonly<Record<string, JsonValue>>;
  unsetProperties: readonly string[];
  candidateIds: CompiledSelectSql;
  candidateIdColumn: string;
}>;

export type NodeSetUpdateWork = NodeSetUpdateCommonWork &
  (
    | Readonly<{ operation: "updateWhere" }>
    | Readonly<{
        operation: "compareAndSet";
        expected: Readonly<Record<string, NodePropertyExpectation>>;
      }>
  );

/** What a set update reports: how many live rows it rewrote. */
export type NodeSetUpdateResult = Readonly<{ affectedCount: number }>;

/**
 * Applies a set-based node update: one UPDATE over every candidate row, then a
 * full rebuild of the sidecars those after-images oblige.
 *
 * ## Why the capability refusals are HERE and not at the entry point
 *
 * The caller probes the backend it was handed before opening the transaction;
 * these four probe the transaction target, which is a different object — a
 * backend may hand out a transaction handle that implements less than the
 * top-level one. They keep the entry point's error codes, so a caller that
 * refuses before the transaction and one that refuses inside it report the
 * same class.
 *
 * ## Why the order is row -> probe -> drop -> re-claim
 *
 * Unlike every other node write, the uniqueness claim happens AFTER the row
 * write: the statement rewrites whole rows without reading their before-images,
 * so the keys to release are not knowable until the after-images come back.
 * The cross-kind re-check below is what makes that safe — it re-probes every
 * changed key across the constraint's scope and refuses the whole transaction
 * before a single entry is dropped. The per-graph write fence (which a
 * shared-scope constraint forces this write to take) is what keeps a concurrent
 * claim from landing between the probe and the reinsert.
 */
export async function applyNodeSetUpdate(
  ctx: NodeWriteContext,
  args: NodeSetUpdateWork,
  backend: Backend,
): Promise<NodeSetUpdateResult> {
  const { kind, schema, uniqueConstraints } = args;
  const commonParams = {
    graphId: ctx.graphId,
    kind,
    patch: args.patch,
    unsetProperties: args.unsetProperties,
    candidateIds: args.candidateIds,
    candidateIdColumn: args.candidateIdColumn,
  } as const;
  let executeNodeSetUpdate: () => Promise<UpdateNodeSetResult>;
  if (args.operation === "compareAndSet") {
    const compareAndSetNode = backend.compareAndSetNode;
    if (compareAndSetNode === undefined) {
      throw new ConfigurationError(
        "The transaction backend does not support node compare-and-set",
        { code: "COMPARE_AND_SET_UNSUPPORTED", kind },
      );
    }
    executeNodeSetUpdate = () =>
      compareAndSetNode({
        ...commonParams,
        operation: "compareAndSet",
        expected: args.expected,
      });
  } else {
    const updateNodeSet = backend.updateNodeSet;
    if (updateNodeSet === undefined) {
      throw new ConfigurationError(
        "The transaction backend does not support set-based node updates",
        { code: "SET_UPDATE_UNSUPPORTED", kind },
      );
    }
    executeNodeSetUpdate = () =>
      updateNodeSet({ ...commonParams, operation: "updateWhere" });
  }
  if (
    uniqueConstraints.length > 0 &&
    missingRequiredExtras(
      UNIQUE_SIDECAR_BATCH,
      ctx.uniqueSidecarBatch,
      "set-based node update",
    ).length > 0
  ) {
    throw new ConfigurationError(
      "The transaction backend lacks batched uniqueness operations",
      { code: "SET_UPDATE_UNIQUENESS_UNSUPPORTED", kind },
    );
  }
  if (
    // Narrower than "is fulltext available on this backend"
    // (`resolveBackendFulltext`): a backend can have an active fulltext
    // strategy yet still lack the batch primitives a set-based update needs,
    // so this checks the four members the write plan below actually calls,
    // mirroring the batched-uniqueness and batched-vector checks around it.
    getSearchableFields(schema).length > 0 &&
    (backend.upsertFulltext === undefined ||
      backend.deleteFulltext === undefined ||
      backend.upsertFulltextBatch === undefined ||
      backend.deleteFulltextBatch === undefined)
  ) {
    throw new ConfigurationError(
      "The transaction backend lacks batched fulltext operations",
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
      "The transaction backend lacks batched vector operations",
      { code: "SET_UPDATE_VECTOR_UNSUPPORTED", kind },
    );
  }
  const result = await executeNodeSetUpdate();
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

  const claimItems = sidecarItems.map((item) => ({
    kind: item.kind,
    id: item.id,
    props: item.props,
    constraints: item.uniqueConstraints,
  }));
  if (uniqueConstraints.length > 0) {
    // The re-claim below (`withNodeCreateClaimsBatch`) reaches `insertUniqueBatch`
    // only through the shared, fallback-dispositioned `issueClaimsBatched`
    // (`../claims/node-claims.ts`), which silently degrades to per-row inserts
    // when the PORT lacks the member — the right answer for a plain create,
    // but not for this REFUSE operation. Re-checking the port here, before the
    // destructive hard-delete below, closes that gap: the later call binds off
    // the same `backend`/verdict pair checked here, so its internal fallback
    // branch can never fire for this call.
    if (
      bindExtraIfReachable(
        backend,
        ctx.uniqueSidecarBatch.extras.insertUniqueBatch,
        UNIQUE_SIDECAR_BATCH.id,
      ) === undefined
    ) {
      throw new ConfigurationError(
        "The transaction backend lacks batched uniqueness operations",
        { code: "SET_UPDATE_UNIQUENESS_UNSUPPORTED", kind },
      );
    }
    // The RESOLVED-SET verdict, not a row-at-a-time one: the statement rewrote
    // every candidate at once, so a swap or a handoff of one key between two
    // rows it touched is legal in the final state and refused by every
    // intermediate one. One owner of that verdict, shared with the graph merge.
    await validateResolvedNodeClaims(
      createUniquenessContext(
        ctx.graphId,
        ctx.registry,
        backend,
        ctx.uniqueSidecarBatch,
      ),
      claimItems,
      [],
    );
    await hardDeleteClaimsByNodeIds(
      uniquenessContext(ctx, backend),
      kind,
      result.rows.map((row) => row.id),
    );
  }
  // The same claim seam every create-shaped writer uses, with an ALREADY-APPLIED
  // row write as its gate: the rows landed above and the old claims were
  // hard-deleted, so what is left is a re-claim and there is no row write left
  // for a claim to precede. Inverting it would mean reserving keys the update has
  // not written. What covers this site on a backend that cannot fence is stated
  // per kind shape: a kind whose scope spans siblings declares
  // `fencesConstraintProbe` at the entry point and is refused before this body
  // runs; a kind-scoped one is not refused, before or after — its
  // delete-then-rebuild window is unchanged in shape and extent here.
  await withNodeCreateClaimsBatch(
    ctx,
    claimItems,
    backend,
    alreadyAppliedRowWrite,
  );
  await applyNodeInsertSyncFansBatch(ctx, sidecarItems, backend);
  return { affectedCount: result.affectedCount };
}
