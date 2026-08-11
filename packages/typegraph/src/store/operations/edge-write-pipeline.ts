/**
 * Composable edge write steps — the edge counterpart of
 * `node-write-pipeline.ts`.
 *
 * An edge mutation is a row write plus the CLAIM its declared cardinality owes.
 * Edges reserve no uniqueness entries, carry no fulltext rows and hold no
 * embeddings, so there are no sync fans to keep in step with the row — but the
 * cardinality claim is a sidecar in every sense that matters: it is written to a
 * different relation, in a fixed position relative to the row (before the write
 * it fences, after the write it cleans up), and a path that applied the row
 * without it would leave the constraint enforced by nothing but a probe. That is
 * why the claim travels ON the work record and is issued HERE rather than by the
 * operations module that decided it: the decision is a pure function of the
 * verdict the caller reached, and the write is a backend member only a step may
 * spell.
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
  type BackendValidityEndMutation,
  type ClaimEdgeCardinalityParams,
  type EdgeRow,
  type GraphBackend,
  type TransactionBackend,
  type UpdateEdgeParams,
} from "../../backend/types";
import { claimEdgeCardinality, purgeEdgeClaims } from "../claims/edge-claims";
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
  clearDeleted?: boolean;
  /**
   * The cardinality claim this update owes, present only when the write
   * RE-ADMITS the row to the population its cardinality constrains — a
   * resurrection, or a reopened `oneActive` window. Built by the caller (a pure
   * function of the verdict it reached) and ISSUED here, at its PRE-INSERT
   * placement: the probe that authorised the write read a population no key
   * fences, so the claim row is what refuses a peer that read the same
   * population, and a claim issued after the row it fences is not a fence.
   */
  claim?: ClaimEdgeCardinalityParams;
}> &
  // The window END is the SAME discriminated pair `UpdateEdgeParams` declares,
  // not a re-spelling with two independent optionals: "state an end" and "clear
  // the end" are mutually exclusive, and reusing the union is what makes the
  // spread below type-check without the step re-asserting the exclusivity.
  BackendValidityEndMutation;

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
export async function applyEdgeUpdate(
  ctx: EdgeWriteContext,
  args: EdgeUpdateWork & WriteParamsDraft,
  backend: Backend,
): Promise<EdgeRow> {
  const { claim, ...rowWork } = args;
  if (claim !== undefined) await claimEdgeCardinality(backend, claim);
  // Every key of the work record and of the fence draft is a field of
  // `UpdateEdgeParams`, and both are built with the same "present only when
  // stated" discipline the call site used to apply field by field, so the
  // spread emits exactly the params the hand-built object emitted.
  const updateParams: UpdateEdgeParams = { graphId: ctx.graphId, ...rowWork };
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

/**
 * One edge hard delete: the row, plus whether this kind holds a cardinality
 * claim to give back.
 *
 * The flag is DATA the caller decides from the kind's declaration, not a
 * capability probe: an unconstrained kind never claimed the axis and must pay no
 * statement for releasing one, which is the same rule its create follows.
 */
export type EdgeHardDeleteWork = EdgeDeleteWork &
  Readonly<{ holdsCardinalityClaim: boolean }>;

/**
 * Permanently removes one edge, asserting the same kind, and releases the claim
 * it held.
 *
 * The release is POST-write housekeeping, not a fence: the claim's liveness
 * predicate already reads a row that is about to be gone, so the axis is
 * takeable either way. Dropping the row keeps the relation from growing by one
 * row per hard-deleted constrained edge.
 */
export async function applyEdgeHardDelete(
  ctx: EdgeWriteContext,
  work: EdgeHardDeleteWork,
  backend: Backend,
): Promise<void> {
  await backend.hardDeleteEdge({
    graphId: ctx.graphId,
    id: work.id,
    kind: work.kind,
  });
  if (work.holdsCardinalityClaim) {
    await purgeEdgeClaims(backend, ctx.graphId, [work.id]);
  }
}
