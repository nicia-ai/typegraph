import { requireDefined } from "../utils/presence";
import type { MergePlanCompositionOrphan } from "./plan-schema";
import type { FullPlanningScope } from "./sparse-candidate-branch";
import type { TypeGraphErrorOptions } from "./typegraph-internal";
import { TransactionConflictError, TypeGraphError } from "./typegraph-internal";

/**
 * Error hierarchy for the graph-merge primitive.
 *
 * Every error extends the publicly-exported {@link TypeGraphError}, so consumers
 * can use the same `isTypeGraphError`/category machinery they already use for
 * TypeGraph itself. Each subclass carries a stable machine-readable `code`, a
 * fixed `ErrorCategory`, and a cause chain for debugging.
 */

/**
 * Machine-readable error codes for the merge primitive. Stable identifiers so
 * callers can branch on `error.code` without string-matching messages.
 */
export const MERGE_ERROR_CODES = {
  merge: "GRAPH_MERGE_ERROR",
  invalidOptions: "GRAPH_MERGE_INVALID_OPTIONS",
  branch: "GRAPH_MERGE_BRANCH_ERROR",
  similarityUnavailable: "GRAPH_MERGE_SIMILARITY_UNAVAILABLE",
  conflict: "GRAPH_MERGE_CONFLICT",
  constraintConflict: "GRAPH_MERGE_CONSTRAINT_CONFLICT",
  identityConflict: "GRAPH_MERGE_IDENTITY_CONFLICT",
  identitySeparationConflict: "GRAPH_MERGE_IDENTITY_SEPARATION_CONFLICT",
  acyclicityConflict: "GRAPH_MERGE_ACYCLICITY_CONFLICT",
  baseVersionMismatch: "GRAPH_MERGE_BASE_VERSION_MISMATCH",
  planCapability: "GRAPH_MERGE_PLAN_CAPABILITY",
  planInvalid: "GRAPH_MERGE_PLAN_INVALID",
  planVersionUnsupported: "GRAPH_MERGE_PLAN_VERSION_UNSUPPORTED",
  planDigestMismatch: "GRAPH_MERGE_PLAN_DIGEST_MISMATCH",
  planTargetMismatch: "GRAPH_MERGE_PLAN_TARGET_MISMATCH",
  planSchemaMismatch: "GRAPH_MERGE_PLAN_SCHEMA_MISMATCH",
  planOwnerMismatch: "GRAPH_ALLOCATION_OWNER_MISMATCH",
  planStale: "GRAPH_MERGE_PLAN_STALE",
  planningStale: "GRAPH_MERGE_PLANNING_STALE",
  candidateSource: "GRAPH_MERGE_CANDIDATE_SOURCE",
  evidence: "GRAPH_MERGE_EVIDENCE",
  candidateWriteSet: "GRAPH_MERGE_CANDIDATE_WRITE_SET",
  review: "GRAPH_MERGE_REVIEW",
  operation: "GRAPH_MERGE_OPERATION",
  operationRequest: "GRAPH_MERGE_OPERATION_REQUEST",
  operationConflict: "GRAPH_MERGE_OPERATION_CONFLICT",
  operationUnsupported: "GRAPH_MERGE_OPERATION_UNSUPPORTED",
  operationEvidence: "GRAPH_MERGE_OPERATION_EVIDENCE",
  operationUndelivered: "GRAPH_MERGE_OPERATION_UNDELIVERED",
  compositionOrphan: "GRAPH_MERGE_COMPOSITION_ORPHAN",
  cardinalityConflict: "GRAPH_MERGE_CARDINALITY_CONFLICT",
  restrictedDeleteConflict: "GRAPH_MERGE_RESTRICTED_DELETE_CONFLICT",
} as const;

/**
 * Options shared by every merge error. Mirrors the relevant subset of
 * TypeGraphError's options while making `cause`/`details`/`suggestion`
 * uniformly optional at the merge-error boundary.
 */
export type MergeErrorOptions = Readonly<{
  details?: Record<string, unknown>;
  suggestion?: string;
  cause?: unknown;
}>;

/**
 * Builds a {@link TypeGraphErrorOptions} for a fixed category, threading only
 * the optional fields that are actually present. Omitting undefined keys (rather
 * than assigning `undefined`) keeps the result valid under
 * `exactOptionalPropertyTypes`.
 */
function toTypeGraphErrorOptions(
  category: TypeGraphErrorOptions["category"],
  options: MergeErrorOptions,
): TypeGraphErrorOptions {
  return {
    category,
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.suggestion === undefined ?
      {}
    : { suggestion: options.suggestion }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  };
}

/**
 * Generic failure raised while computing or committing a merge. The catch-all
 * for the orchestrator (comparison-ceiling overruns, commit failures, etc.).
 */
export class MergeError extends TypeGraphError {
  protected static readonly errorCategory: TypeGraphErrorOptions["category"] =
    "system";

  constructor(message: string, options: MergeErrorOptions = {}) {
    const errorClass = new.target;
    super(
      message,
      MERGE_ERROR_CODES.merge,
      toTypeGraphErrorOptions(errorClass.errorCategory, options),
    );
    this.name = "MergeError";
  }
}

/** Raised when caller-supplied merge options are invalid or unsupported. */
export class InvalidMergeOptionsError extends MergeError {
  protected static override readonly errorCategory = "user";
  override readonly code = MERGE_ERROR_CODES.invalidOptions;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "InvalidMergeOptionsError";
  }
}

/** Invalid, unsupported, or unavailable evidence for durable merge review. */
export class MergeReviewError extends MergeError {
  protected static override readonly errorCategory = "user";
  override readonly code = MERGE_ERROR_CODES.review;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "MergeReviewError";
  }
}

/**
 * Failure raised while creating a working-copy branch of a base store
 * (clone/export/import failures, backend construction failures).
 */
export class BranchError extends TypeGraphError {
  constructor(message: string, options: MergeErrorOptions = {}) {
    super(
      message,
      MERGE_ERROR_CODES.branch,
      toTypeGraphErrorOptions("system", options),
    );
    this.name = "BranchError";
  }
}

/**
 * Raised when a `vector`/`hybrid` similarity strategy is requested but no
 * {@link import("./types").Embedder} was configured (`MergeOptions.embedder` is
 * absent). The `vector`/`hybrid` scorers compute cosine over real embeddings in
 * memory, so an embedder is mandatory for them; `fulltext`/`custom` need none.
 */
export class SimilarityUnavailableError extends MergeError {
  override readonly code = MERGE_ERROR_CODES.similarityUnavailable;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, {
      ...options,
      suggestion:
        options.suggestion ??
        "Pass MergeOptions.embedder (a local model), or use a fulltext/custom similarity strategy.",
    });
    this.name = "SimilarityUnavailableError";
  }
}

/**
 * Raised when a conflict cannot be resolved by the configured policy and the
 * caller has opted into hard-failing rather than flagging.
 */
export class MergeConflictError extends MergeError {
  override readonly code = MERGE_ERROR_CODES.conflict;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "MergeConflictError";
  }
}

/** Details copied from the deterministic store constraint that refused commit. */
export type MergeConstraintConflictErrorDetails = Readonly<{
  /** Stable code of the underlying store constraint error. */
  constraintCode: string;
  /** Class name of the underlying store constraint error. */
  constraintErrorName: string;
  /** Constraint-specific fields, also copied onto this details object. */
  constraintDetails: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
}>;

/** Raised when a resolved merge would commit a graph that violates a constraint. */
export class MergeConstraintConflictError extends MergeError {
  protected static override readonly errorCategory = "constraint";
  override readonly code = MERGE_ERROR_CODES.constraintConflict;
  declare readonly category: "constraint";
  declare readonly cause: TypeGraphError;
  declare readonly details: MergeConstraintConflictErrorDetails;

  constructor(cause: TypeGraphError) {
    super(`The resolved merge would violate ${cause.name}: ${cause.message}`, {
      cause,
      details: {
        ...cause.details,
        constraintCode: cause.code,
        constraintErrorName: cause.name,
        constraintDetails: cause.details,
      },
      suggestion:
        cause.suggestion ??
        "Change the branch data or target state so the resolved graph satisfies its constraints, then retry the merge.",
    });
    this.name = "MergeConstraintConflictError";
  }
}

/**
 * Translates a merge commit's transaction-conflict exhaustion into a
 * {@link MergeError} the merge boundary's callers already know how to handle,
 * and deterministic store-constraint refusals into
 * {@link MergeConstraintConflictError}. Identity conflicts have their own
 * established merge error surface; infrastructure and stale-plan failures are
 * not category `constraint`.
 *
 * @internal
 */
export function translateMergeCommitError(error: unknown): unknown {
  if (error instanceof MergeError) return error;
  if (error instanceof TransactionConflictError) {
    return new MergeError(
      `Merge commit aborted by transaction conflicts (serialization failure or deadlock) on ${error.details.attempts} consecutive attempt(s); giving up.`,
      {
        cause: error,
        details: { attempts: error.details.attempts },
        suggestion:
          "Reduce concurrent writes to the merge target, or serialize merges against it.",
      },
    );
  }
  if (!(error instanceof TypeGraphError)) return error;
  if (error.category !== "constraint" || error.code.startsWith("IDENTITY_")) {
    return error;
  }
  return new MergeConstraintConflictError(error);
}

/**
 * Raised at plan time, and again at apply, when two branches conflict over a
 * composition attachment — one branch attaches a part to a whole while
 * another deletes one end of it (`details.branchId` names the attaching
 * branch) — or when the plan would separate a composition part from its
 * whole behind the target's back: a live part of a whole the plan deletes is
 * not itself among the plan's node deletions (the target gained that part
 * AFTER the branch point, or independently of it), or a part the plan
 * deletes is held by the target under a live whole the plan leaves standing
 * (the target moved it there after the branch point). Applying the plan as
 * trusted would leave the part pointing at a whole that no longer exists, or
 * take it from a whole that does.
 *
 * Every planning entry point refuses the SAME finding with this error,
 * computed by the same `planCompositionCascade` /
 * `unattachedRequiredPartOrphansAmong` owners against the target's state at
 * plan time: the plan's revision fence makes it a certain apply refusal, so a
 * plan carrying it could never be applied. Apply re-verifies inside its
 * transaction, under the per-graph write lock, and raises it again for an
 * artifact whose rows no longer agree with the target.
 *
 * `details` is typed as {@link MergePlanCompositionOrphan} — the SAME shape
 * every arm (`merge.ts`) passes straight into this constructor — rather than
 * a second, structurally-identical type.
 *
 * `details.cause` picks the message: `"deleted"` names the whole this plan
 * would delete; `"moved"` names the live whole the target holds a part under
 * that this plan would delete; `"unattached"` has no whole to name at all —
 * the part's composition edge was dropped or collapsed by canonicalization
 * while the part itself survives. With `details.branchId`, the attachment at
 * stake is that branch's, not the target's.
 */
export class MergeCompositionOrphanError extends MergeError {
  protected static override readonly errorCategory = "constraint";
  override readonly code = MERGE_ERROR_CODES.compositionOrphan;
  declare readonly details: MergePlanCompositionOrphan;

  constructor(details: MergePlanCompositionOrphan) {
    super(compositionOrphanMessage(details), { details });
    this.name = "MergeCompositionOrphanError";
  }
}

/** The `MergeCompositionOrphanError` messages, one per `cause` and attaching side. */
function compositionOrphanMessage(details: MergePlanCompositionOrphan): string {
  if (details.branchId !== undefined) {
    return branchAttachmentLossMessage(details, details.branchId);
  }
  if (details.cause === "moved") {
    // `cause: "moved"` always carries `whole` — the only producer,
    // `compositionMovedPartsAmong` (`merge.ts`), sets both together.
    const holder = requireDefined(
      details.whole,
      'MergePlanCompositionOrphan.whole for cause "moved"',
    );
    return (
      `Applying this merge plan would delete part "${details.part.kind}:${details.part.id}", ` +
      `which the target holds under live whole "${holder.kind}:${holder.id}" (via "${details.viaEdgeKind}") ` +
      "that the plan neither deletes nor detaches it from. Stop the branch from deleting the part, " +
      "or detach the part from that whole on the target, before merging."
    );
  }
  if (details.cause === "unattached") {
    return (
      `Applying this merge plan would leave part "${details.part.kind}:${details.part.id}" ` +
      `(via "${details.viaEdgeKind}") with no live whole — this composition pair requires one ` +
      '(`existence: "required"`). Recompute the merge plan against the target\'s current ' +
      "state, or attach the part to a whole in the branch before merging."
    );
  }
  // `cause: "deleted"` always carries `whole` — the only producer,
  // `compositionOrphansAmong` (`merge.ts`), sets both together.
  const whole = requireDefined(
    details.whole,
    'MergePlanCompositionOrphan.whole for cause "deleted"',
  );
  return (
    `Applying this merge plan would delete whole "${whole.kind}:${whole.id}" ` +
    `while its part "${details.part.kind}:${details.part.id}" (via "${details.viaEdgeKind}") ` +
    "is not itself among the plan's node deletions. Recompute the merge plan against the " +
    "target's current state, or delete the orphaned part in the branch before merging."
  );
}

/**
 * The message for a cross-branch finding: `whole` is always set, because the
 * only producer, `lostBranchAttachment` (`merge.ts`), reads it off the
 * attaching edge.
 */
function branchAttachmentLossMessage(
  details: MergePlanCompositionOrphan,
  branchId: string,
): string {
  const whole = requireDefined(
    details.whole,
    "MergePlanCompositionOrphan.whole for a branch attachment",
  );
  const attachment =
    `branch "${branchId}" attaches part "${details.part.kind}:${details.part.id}" ` +
    `to whole "${whole.kind}:${whole.id}" (via "${details.viaEdgeKind}")`;
  const deletedEnd = details.cause === "moved" ? "part" : "whole";
  return (
    `Merging these branches would lose a composition attachment: ${attachment}, ` +
    `but the merge also deletes that ${deletedEnd}. ` +
    "Drop either the deletion or the attachment from its branch before merging."
  );
}

/**
 * The identity dimension of a merge refusal: opposing or retract/reassert
 * truth, or a class-lifted `different` that vetoes a match.
 *
 * ONE class, two codes. Each of those is a distinct machine-readable
 * `MERGE_ERROR_CODES` entry so a caller can branch precisely, but they share
 * this class — and therefore `category: "conflict"` — so every consumer that
 * already handles an identity merge conflict keeps handling all of them, and
 * `GRAPH_MERGE_IDENTITY_CONFLICT` keeps every case it raises today.
 */
export class IdentityMergeConflictError extends MergeError {
  override readonly code: IdentityMergeConflictCode;

  constructor(
    message: string,
    options: MergeErrorOptions &
      Readonly<{ code?: IdentityMergeConflictCode }> = {},
  ) {
    super(message, options);
    this.code = options.code ?? MERGE_ERROR_CODES.identityConflict;
    this.name = "IdentityMergeConflictError";
  }
}

/** The two codes {@link IdentityMergeConflictError} can carry. */
export type IdentityMergeConflictCode =
  | typeof MERGE_ERROR_CODES.identityConflict
  | typeof MERGE_ERROR_CODES.identitySeparationConflict;

/** One edge a plan-time structural conflict names, at its post-plan endpoints. */
export type MergeConflictEdge = Readonly<{
  edgeId: string;
  edgeKind: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
}>;

/** `details` carried by {@link AcyclicityMergeConflictError}. */
export type AcyclicityMergeConflictDetails = Readonly<{
  /** The declared acyclic relation the resolved plan would close a cycle in. */
  relation: string;
  /** Every edge of `relation` the plan-time probe found on the cycle. */
  edges: readonly MergeConflictEdge[];
  [key: string]: unknown;
}>;

/**
 * Raised at plan time when the resolved merge plan's projected
 * edge writes — after canonicalization and repointing, layered onto the
 * target's current live edges — would close a cycle in a declared-acyclic
 * relation. Reviewable, like {@link IdentityMergeConflictError}: the plan is
 * not applied, and the target is untouched. Apply-time re-verification (a
 * cycle that only appears due to a write that lands between planning and
 * commit) remains a refusal, not a conflict — see `EdgeAcyclicityError` via
 * {@link MergeConstraintConflictError}.
 */
export class AcyclicityMergeConflictError extends MergeError {
  override readonly code = MERGE_ERROR_CODES.acyclicityConflict;
  declare readonly details: AcyclicityMergeConflictDetails;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "AcyclicityMergeConflictError";
  }
}

/**
 * `details` carried by {@link CardinalityMergeConflictError}: the store
 * refusal apply would raise, in the {@link MergeConstraintConflictError} shape,
 * plus the two `edges` that collide.
 */
export type CardinalityMergeConflictDetails =
  MergeConstraintConflictErrorDetails &
    Readonly<{ edges: readonly MergeConflictEdge[] }>;

/**
 * Raised at plan time when the resolved plan would leave two live edges
 * holding one reservation the store allows a single holder of: a part's one
 * whole (`cause` is the `CompositionError` `COMPOSITION_WHOLE_OCCUPIED` apply
 * would raise), or a declared `cardinality` / `targetCardinality` slot (`cause`
 * is the `CardinalityError`). Two branches reparenting one part to different
 * wholes, or a branch and the incremental target each adding an incoming edge
 * to a `targetCardinality: "one"` endpoint, are this conflict.
 *
 * Plan time, not apply time, because the plan's revision fence makes the
 * apply's verdict certain: the unchanged target refuses it, and any target
 * write that would resolve it makes the plan stale. `details.edges` names
 * the incumbent first, then the edge that collides with it.
 */
export class CardinalityMergeConflictError extends MergeError {
  protected static override readonly errorCategory = "constraint";
  override readonly code = MERGE_ERROR_CODES.cardinalityConflict;
  declare readonly cause: TypeGraphError;
  declare readonly details: CardinalityMergeConflictDetails;

  constructor(cause: TypeGraphError, edges: readonly MergeConflictEdge[]) {
    super(`The merge plan would violate ${cause.name}: ${cause.message}`, {
      cause,
      details: {
        ...cause.details,
        constraintCode: cause.code,
        constraintErrorName: cause.name,
        constraintDetails: cause.details,
        edges,
      },
      suggestion:
        "Drop one of the conflicting edge writes from its branch (or, for an incremental merge, from the branch that disagrees with the target), then plan the merge again.",
    });
    this.name = "CardinalityMergeConflictError";
  }
}

/**
 * Raised at plan time when the resolved plan deletes an `onDelete: "restrict"`
 * node that still has a connected non-composition edge the plan does not
 * delete — typically an edge the incremental target added after the fork.
 * `cause` is the `RestrictedDeleteError` apply would raise, and `details`
 * carries its `nodeKind`, `nodeId`, `edgeCount` and `edgeKinds` in the
 * {@link MergeConstraintConflictError} shape. Plan time for the same reason as
 * {@link CardinalityMergeConflictError}: no target write can resolve it
 * without making the plan stale.
 */
export class RestrictedDeleteMergeConflictError extends MergeError {
  protected static override readonly errorCategory = "constraint";
  override readonly code = MERGE_ERROR_CODES.restrictedDeleteConflict;
  declare readonly cause: TypeGraphError;
  declare readonly details: MergeConstraintConflictErrorDetails;

  constructor(cause: TypeGraphError) {
    super(`The merge plan would violate ${cause.name}: ${cause.message}`, {
      cause,
      details: {
        ...cause.details,
        constraintCode: cause.code,
        constraintErrorName: cause.name,
        constraintDetails: cause.details,
      },
      suggestion:
        "Delete the blocking edges in the branch before deleting the node, or keep the node, then plan the merge again.",
    });
    this.name = "RestrictedDeleteMergeConflictError";
  }
}

/**
 * Raised by the `merge()` precondition check when a branch's `base@V` token
 * does not match the merge target's current base version (the branch forked
 * from a divergent schema or content fingerprint).
 */
export class BaseVersionMismatchError extends MergeError {
  override readonly code = MERGE_ERROR_CODES.baseVersionMismatch;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, {
      ...options,
      suggestion:
        options.suggestion ??
        "Re-branch from the current target so the branch base matches before merging.",
    });
    this.name = "BaseVersionMismatchError";
  }
}

/** Raised when a target cannot provide the durable plan/apply guarantees. */
export class MergePlanCapabilityError extends MergeError {
  protected static override readonly errorCategory = "user";
  override readonly code = MERGE_ERROR_CODES.planCapability;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "MergePlanCapabilityError";
  }
}

/** Raised when a serialized plan is structurally or semantically malformed. */
export class InvalidMergePlanError extends MergeError {
  protected static override readonly errorCategory = "user";
  override readonly code: string = MERGE_ERROR_CODES.planInvalid;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "InvalidMergePlanError";
  }
}

/** Raised when a plan uses a wire format this library version cannot read. */
export class UnsupportedMergePlanVersionError extends InvalidMergePlanError {
  override readonly code = MERGE_ERROR_CODES.planVersionUnsupported;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "UnsupportedMergePlanVersionError";
  }
}

/** Raised when a plan's canonical content no longer matches its digest. */
export class MergePlanDigestMismatchError extends InvalidMergePlanError {
  override readonly code = MERGE_ERROR_CODES.planDigestMismatch;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "MergePlanDigestMismatchError";
  }
}

/** Raised when a plan names a different target graph. */
export class MergePlanTargetMismatchError extends InvalidMergePlanError {
  override readonly code = MERGE_ERROR_CODES.planTargetMismatch;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "MergePlanTargetMismatchError";
  }
}

/** Raised when a plan was produced for another active schema. */
export class MergePlanSchemaMismatchError extends InvalidMergePlanError {
  override readonly code = MERGE_ERROR_CODES.planSchemaMismatch;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "MergePlanSchemaMismatchError";
  }
}

/** Raised when a plan belongs to an independently-created revision clock. */
export class MergePlanOwnerMismatchError extends InvalidMergePlanError {
  override readonly code = MERGE_ERROR_CODES.planOwnerMismatch;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "MergePlanOwnerMismatchError";
  }
}

/** Raised when the target revision no longer equals the plan's fence. */
export class StaleMergePlanError extends MergeError {
  override readonly code: string = MERGE_ERROR_CODES.planStale;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, {
      ...options,
      suggestion:
        options.suggestion ??
        "Create a new merge plan against the target's current revision, review it, and apply that plan instead.",
    });
    this.name = "StaleMergePlanError";
  }
}

/** Raised when the target moved while a plan was being computed. */
export class MergePlanningStaleError extends StaleMergePlanError {
  override readonly code = MERGE_ERROR_CODES.planningStale;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "MergePlanningStaleError";
  }
}

/** Raised when a built-in candidate source cannot produce attributed output. */
export class CandidateSourceError extends MergeError {
  override readonly code = MERGE_ERROR_CODES.candidateSource;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "CandidateSourceError";
  }
}

/** Raised when a serialized candidate write set cannot be validated or staged. */
export class CandidateWriteSetError extends MergeError {
  protected static override readonly errorCategory = "user";
  override readonly code = MERGE_ERROR_CODES.candidateWriteSet;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "CandidateWriteSetError";
  }
}

/**
 * Raised instead of planning against the whole target when a caller requests
 * `planningScope: "candidate"`. `details.planningScope.reason` names why the
 * target or candidate cannot be planned from the candidate's own rows.
 */
export class CandidatePlanningScopeError extends MergePlanCapabilityError {
  declare readonly details: Readonly<{
    capability: "boundedCandidatePlanning";
    requiredPlanningScope: "full";
    planningScope: FullPlanningScope;
  }>;

  constructor(planningScope: FullPlanningScope) {
    super(
      `This candidate cannot be planned with bounded reads; it needs the whole target (${planningScope.reason}).`,
      {
        details: {
          capability: "boundedCandidatePlanning",
          requiredPlanningScope: "full",
          planningScope,
        },
        suggestion:
          'Pass planningScope: "full" to permit a full copy of the target, or remove the cause named by details.planningScope.reason.',
      },
    );
    this.name = "CandidatePlanningScopeError";
  }
}

/** Raised when match evidence is invalid or contains a non-finite score. */
export class MatchEvidenceError extends MergeError {
  override readonly code = MERGE_ERROR_CODES.evidence;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "MatchEvidenceError";
  }
}

/**
 * Generic operational failure raised while orchestrating a durable
 * operation, such as a strategy transport or host failure.
 */
export class DurableOperationError extends MergeError {
  override readonly code: string = MERGE_ERROR_CODES.operation;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "DurableOperationError";
  }
}

/** Refusal of evidence or mutation authorization from a retired or foreign allocation. */
export class DurableOperationOwnerMismatchError extends DurableOperationError {
  protected static override readonly errorCategory = "user";
  override readonly code = "GRAPH_ALLOCATION_OWNER_MISMATCH";
  constructor(cause: unknown) {
    super(
      "The durable operation belongs to a different or retired allocation.",
      { cause, details: { code: "GRAPH_ALLOCATION_OWNER_MISMATCH" } },
    );
    this.name = "DurableOperationOwnerMismatchError";
  }
}

/** Failure of an ordinary Store operation, with certainty scoped to this transaction attempt, never to the caller key. */
export class StoreOperationError extends DurableOperationError {
  readonly attemptOutcome: "not-committed" | "unknown";
  readonly phase: "preflight" | "callback" | "evidence" | "commit";
  readonly retryable: boolean;
  constructor(
    attemptOutcome: StoreOperationError["attemptOutcome"],
    phase: StoreOperationError["phase"],
    retryable: boolean,
    cause: unknown,
  ) {
    super(
      attemptOutcome === "unknown" ?
        "This attempt's commit outcome is unknown; retry the same persisted request to recover its outcome; a lookup returning absence does not authorize a new request."
      : "This attempt did not commit; an earlier outcome may exist. Any retry must preserve the same key and payload.",
      { cause, details: { attemptOutcome, phase, retryable } },
    );
    this.name = "StoreOperationError";
    this.attemptOutcome = attemptOutcome;
    this.phase = phase;
    this.retryable = retryable;
  }
}

/** Raised when a durable-operation request or descriptor is invalid. */
export class DurableOperationRequestError extends DurableOperationError {
  protected static override readonly errorCategory = "user";
  override readonly code = MERGE_ERROR_CODES.operationRequest;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "DurableOperationRequestError";
  }
}

/**
 * Raised when an idempotency key is reused with a different operation digest.
 * The previously committed operation is returned untouched; the new request is
 * refused before any graph mutation or evidence write.
 */
export class DurableOperationConflictError extends DurableOperationError {
  protected static override readonly errorCategory = "constraint";
  override readonly code = MERGE_ERROR_CODES.operationConflict;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "DurableOperationConflictError";
  }
}

/**
 * Raised when a host cannot provide the atomic mutation-plus-evidence
 * guarantee. It carries the dimensions the host cannot honor. The portable
 * fallback is refusal; TypeGraph never emulates atomicity with best effort or
 * with callbacks that run outside the evidence transaction (see
 * {@link DurableWorkingCopyStrategy.operations}).
 */
export class DurableOperationUnsupportedError extends DurableOperationError {
  protected static override readonly errorCategory = "user";
  override readonly code = MERGE_ERROR_CODES.operationUnsupported;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "DurableOperationUnsupportedError";
  }
}

/** Raised when a host returns malformed or request-inconsistent evidence. */
export class DurableOperationEvidenceError extends DurableOperationError {
  override readonly code = MERGE_ERROR_CODES.operationEvidence;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "DurableOperationEvidenceError";
  }
}

/**
 * Raised when archive/destroy is fenced by undelivered operation evidence.
 *
 * Extends {@link BranchError} so the established `destroyDurableBranch` result
 * type already transports it: a strategy that refuses destruction while
 * undelivered evidence remains preserves that refusal to the caller instead of
 * having it flattened into a generic branch failure.
 */
export class DurableEvidenceUndeliveredError extends BranchError {
  override readonly code = MERGE_ERROR_CODES.operationUndelivered;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "DurableEvidenceUndeliveredError";
  }
}

/**
 * One-line human description of an unknown thrown value, for wrapping into
 * typed error messages.
 *
 * @internal
 */
export function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
