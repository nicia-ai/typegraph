/**
 * What a write's verdicts READ, carried into the statement that honors them.
 *
 * Every member of a fence record is the predicate itself, never a flag a
 * caller re-derives one from. That shape already exists in this codebase —
 * `ValidityWindowVerdict.storedLowerBoundFence` hands back the
 * `expectedValidFrom` object rather than a boolean, and its docstring names
 * the over-fencing defect that shape closed — and this module generalizes it
 * per row-work kind.
 *
 * ## Why every key is REQUIRED
 *
 * `{}` is how a fence says "assert nothing", and it is the ONLY way to say it.
 * An optional key would reintroduce the absent state that the verdict shape
 * eliminated: "I forgot to pass the fence" and "this write asserts nothing"
 * would look identical at the call site, and the compiler could not tell them
 * apart either. With the key required, forgetting it is a type error and an
 * unfenced write is a stated decision.
 *
 * ## Why the applier maps are total
 *
 * Each map is `satisfies { [K in keyof F]-?: FenceApplier<F, K> }`, so a fence
 * key without an applier fails compilation. A fence a kind's statement cannot
 * carry is REFUSED by its applier, naming the fence and the kind — applied or
 * refused, never silently dropped.
 */
import {
  assertsStoredLowerBound,
  type ValidityLowerBoundFence,
} from "../../utils/date";
import { type EdgeIdentityExpectation } from "./edge-identity";

/**
 * The row-work shapes a fence can be applied to. Not {@link RowWorkKind}: a
 * node has two statement families with different fence capabilities (the
 * single-row UPDATE carries `expectedValidFrom`; the set UPDATE has no field
 * for it), and the refusal has to name which one refused.
 */
export type WriteFenceKind = "nodeUpdate" | "nodeSetUpdate" | "edgeUpdate";

/**
 * The mutable predicate fields a fence applier may contribute to the write's
 * params. It is a DRAFT, not the params: the applier's whole job is to write
 * the predicate its fence states, and nothing else about the statement is
 * reachable from here.
 */
export interface WriteParamsDraft {
  expectedValidFrom?: string | null;
  kind?: string;
  fromKind?: string;
  fromId?: string;
  toKind?: string;
  toId?: string;
}

/** A fresh, empty draft — the state "this write asserts nothing yet". */
export function createWriteParamsDraft(): WriteParamsDraft {
  return {};
}

/** Applies one fence key's predicate to the draft. */
export type FenceApplier<F, K extends keyof F> = (
  fence: F[K],
  draft: WriteParamsDraft,
) => void;

/** A total applier map for a fence record: one applier per key, no key spare. */
export type FenceApplierMap<F> = { [K in keyof F]-?: FenceApplier<F, K> };

/** The fences a single-row node UPDATE can carry. */
export type NodeUpdateFences = Readonly<{
  validityLowerBound: ValidityLowerBoundFence;
}>;

/**
 * The fences a set-based node UPDATE can carry. Same key as
 * {@link NodeUpdateFences}, DIFFERENT applier: `UpdateNodeSetParams` has no
 * `expectedValidFrom` field, so `{}` is the only value this kind can honor.
 */
export type NodeSetUpdateFences = Readonly<{
  validityLowerBound: ValidityLowerBoundFence;
}>;

/** The fences an edge UPDATE can carry. */
export type EdgeUpdateFences = Readonly<{
  validityLowerBound: ValidityLowerBoundFence;
  /** The identity components the caller asserted; each optional INSIDE. */
  edgeIdentity: EdgeIdentityExpectation;
}>;

/**
 * A fence the row work's statement has no field to carry.
 *
 * INTERNAL, with no allocated public error code, following
 * `EdgeUpdateTargetMoved`: no user-stated option can reach it — it fires only
 * when a write path hands a fence to a statement family that cannot express
 * it — so a public code would document a state users cannot produce. It is
 * exported for the tests that pin the refusal, not for callers to catch.
 */
export class UnsupportedWriteFenceError extends Error {
  readonly fence: string;
  readonly kind: WriteFenceKind;

  constructor(fence: string, kind: WriteFenceKind) {
    super(
      `The ${kind} statement cannot carry the "${fence}" fence, so the write ` +
        `is refused rather than run unfenced. Assert nothing ({}) or use a ` +
        `write shape whose statement carries it.`,
    );
    this.name = "UnsupportedWriteFenceError";
    this.fence = fence;
    this.kind = kind;
  }
}

/**
 * Carries the bound the verdict READ into the statement's own predicate.
 *
 * `assertsStoredLowerBound` owns the emptiness test — the same predicate
 * `node-write-pipeline.ts` consults when it builds the update params — so the
 * seam that validates a fence and the step that carries it cannot disagree
 * about what an empty fence is.
 */
function applyValidityLowerBound(
  fence: ValidityLowerBoundFence,
  draft: WriteParamsDraft,
): void {
  if (!assertsStoredLowerBound(fence)) return;
  draft.expectedValidFrom = fence.expectedValidFrom;
}

export const NODE_UPDATE_FENCE_APPLIERS = {
  validityLowerBound: applyValidityLowerBound,
} as const satisfies FenceApplierMap<NodeUpdateFences>;

/**
 * The refusal branch. It is REACHABLE and TYPE-LEGAL: the record's one key is
 * required and `ValidityLowerBoundFence` legitimately carries
 * `expectedValidFrom`, so a caller can hand a set update a stated bound with
 * no cast and no unknown key. There is nowhere to put it in
 * `UpdateNodeSetParams`, so the write is refused rather than run unfenced.
 *
 * No caller reaches it today — the set-update path is props-only — and the
 * guard is what keeps that true when a future set update grows a window.
 */
export const NODE_SET_UPDATE_FENCE_APPLIERS = {
  validityLowerBound: (fence) => {
    if (!assertsStoredLowerBound(fence)) return;
    throw new UnsupportedWriteFenceError("validityLowerBound", "nodeSetUpdate");
  },
} as const satisfies FenceApplierMap<NodeSetUpdateFences>;

/**
 * Carries every identity component the caller ASSERTED into the statement's
 * `WHERE`, so the row an edge update writes is provably the row that was
 * judged. Kind is always asserted; an endpoint component is asserted only when
 * the caller claimed it, because a component nobody claimed must not become a
 * predicate that refuses legitimate writes.
 */
function applyEdgeIdentity(
  fence: EdgeIdentityExpectation,
  draft: WriteParamsDraft,
): void {
  draft.kind = fence.kind;
  if (fence.fromKind !== undefined) draft.fromKind = fence.fromKind;
  if (fence.fromId !== undefined) draft.fromId = fence.fromId;
  if (fence.toKind !== undefined) draft.toKind = fence.toKind;
  if (fence.toId !== undefined) draft.toId = fence.toId;
}

export const EDGE_UPDATE_FENCE_APPLIERS = {
  validityLowerBound: applyValidityLowerBound,
  edgeIdentity: applyEdgeIdentity,
} as const satisfies FenceApplierMap<EdgeUpdateFences>;

/**
 * Applies EVERY declared fence of a record to the draft.
 *
 * Iterating the applier map — which the type system pins total over the fence
 * record's keys — is what makes "accepted, then ignored" unrepresentable: a
 * key exists on the record only if an applier exists for it, and every applier
 * in the map runs. A per-kind dispatcher that named its keys by hand could
 * silently skip one; this cannot.
 */
export function applyWriteFences<F extends object>(
  appliers: FenceApplierMap<F>,
  fences: F,
  draft: WriteParamsDraft,
): void {
  for (const key of Object.keys(appliers) as (keyof F)[]) {
    // One localized widening: indexing the map with a key UNION yields a union
    // of applier signatures, which TypeScript will not call even though every
    // member accepts the value indexed out of the record with the same key.
    // The map's totality is asserted by its `satisfies` clause, so the pairing
    // is sound; the cast only tells the compiler the keys line up.
    const applier: (fence: F[keyof F], draft: WriteParamsDraft) => void =
      appliers[key];
    applier(fences[key], draft);
  }
}
