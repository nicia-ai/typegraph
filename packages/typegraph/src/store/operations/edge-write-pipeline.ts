/**
 * Composable edge write steps — the edge counterpart of
 * `node-write-pipeline.ts`.
 *
 * An edge mutation is a row write and nothing else. Edges reserve no uniqueness
 * entries, carry no fulltext rows and hold no embeddings, so unlike a node
 * mutation there is no derived data these steps have to keep in step with the
 * row. That is precisely why they are extracted anyway: the seam's rule is
 * structural — every call to a banned backend member lives in a step or sidecar
 * module the session composes — and "this family happens to owe no sidecars
 * today" is the kind of fact that stops being true without anyone noticing. The
 * day an edge grows derived data, there is exactly one place it has to be
 * applied, and every write path already runs through it.
 *
 * The insert shapes are NOT here: `insert-dispatch.ts` already owns "which of
 * the four insert members this backend supports", for edges as much as for
 * nodes, and a pass-through step would be a second owner of that decision.
 *
 * The steps assume they run inside a write transaction (see
 * {@link runInWriteTransaction}); they perform no transaction management of
 * their own.
 */
import {
  type EdgeRow,
  type GraphBackend,
  type TransactionBackend,
  type UpdateEdgeParams,
} from "../../backend/types";
import { type GraphWriteLock } from "../recorded-capture/clock";
import { type WriteParamsDraft } from "./write-fences";

type Backend = GraphBackend | TransactionBackend;

/**
 * The graph-scoped state the edge write steps need.
 *
 * `lock` is compile-time evidence that the per-graph write-lock discipline was
 * satisfied BEFORE any row work (see {@link GraphWriteLock}), exactly as
 * {@link NodeWriteContext} requires it: the pipeline performs no locking of its
 * own, so requiring the token here makes "row write before lock" a type error
 * at the call site instead of a lock-order inversion in review. There is no
 * registry, because an edge write resolves no schema and no constraints — the
 * caller validated the props before the transaction opened.
 */
export type EdgeWriteContext = Readonly<{
  graphId: string;
  lock: GraphWriteLock;
}>;

/** Builds an {@link EdgeWriteContext} — the one constructor every call site shares. */
export function createEdgeWriteContext(
  graphId: string,
  lock: GraphWriteLock,
): EdgeWriteContext {
  return { graphId, lock };
}

/**
 * One edge update, minus every predicate the write's verdicts read.
 *
 * The asserted identity components and the asserted validity lower bound are
 * NOT here: they are the write's fences, applied by
 * `EDGE_UPDATE_FENCE_APPLIERS` into the draft this step is handed alongside
 * the work. An update that forgot to carry a bound its verdict consumed
 * therefore cannot be spelled — the fence record's keys are required — while
 * the work stays exactly "what this write intends to change".
 */
export type EdgeUpdateWork = Readonly<{
  id: string;
  props: Record<string, unknown>;
  /** See {@link UpdateEdgeParams.validFrom}: stored on the resurrecting leg. */
  validFrom?: string;
  validTo?: string;
  clearDeleted?: boolean;
}>;

/**
 * Applies an edge update: the fenced UPDATE, and nothing else.
 *
 * Both halves of the statement's `WHERE` arrive as the draft — the identity
 * components the caller ASSERTED and, when its verdict read one, the stored
 * lower bound — so the row this writes is provably the row that was judged.
 * The step does not decide which of them to carry; the appliers did, from the
 * fence record the caller had to state.
 *
 * A zero-row result is NOT interpreted here. The backend's
 * `DatabaseOperationError` propagates unchanged, because the two callers of
 * this step read "matched nothing" differently — the store re-reads and either
 * converges or refuses ({@link withUnmatchedEdgeUpdateRefusal}), interchange
 * import records a per-row conflict and continues — and a fused unit owns row
 * plus fences plus sidecars, not one error policy for every caller.
 */
export function applyEdgeUpdate(
  ctx: EdgeWriteContext,
  args: EdgeUpdateWork & WriteParamsDraft,
  backend: Backend,
): Promise<EdgeRow> {
  // Every key of the work record and of the fence draft is a field of
  // `UpdateEdgeParams`, and both are built with the same "present only when
  // stated" discipline the call site used to apply field by field, so the
  // spread emits exactly the params the hand-built object emitted.
  const updateParams: UpdateEdgeParams = { graphId: ctx.graphId, ...args };
  return backend.updateEdge(updateParams);
}

/**
 * One edge delete, soft or hard.
 *
 * `kind` is the identity this delete ASSERTS the target row already carries
 * (see {@link UpdateEdgeParams.kind}); it rides in the work rather than in a
 * fence record because a delete states nothing else and has no verdict to
 * fence — the statement IS its own recheck.
 */
export type EdgeDeleteWork = Readonly<{
  id: string;
  kind: string;
}>;

/** Tombstones one edge, asserting the kind the caller resolved it under. */
export function applyEdgeSoftDelete(
  ctx: EdgeWriteContext,
  work: EdgeDeleteWork,
  backend: Backend,
): Promise<void> {
  return backend.deleteEdge({
    graphId: ctx.graphId,
    id: work.id,
    kind: work.kind,
  });
}

/** Permanently removes one edge, asserting the same kind. */
export function applyEdgeHardDelete(
  ctx: EdgeWriteContext,
  work: EdgeDeleteWork,
  backend: Backend,
): Promise<void> {
  return backend.hardDeleteEdge({
    graphId: ctx.graphId,
    id: work.id,
    kind: work.kind,
  });
}
