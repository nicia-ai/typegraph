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
  baseVersionMismatch: "GRAPH_MERGE_BASE_VERSION_MISMATCH",
  planCapability: "GRAPH_MERGE_PLAN_CAPABILITY",
  planInvalid: "GRAPH_MERGE_PLAN_INVALID",
  planVersionUnsupported: "GRAPH_MERGE_PLAN_VERSION_UNSUPPORTED",
  planDigestMismatch: "GRAPH_MERGE_PLAN_DIGEST_MISMATCH",
  planTargetMismatch: "GRAPH_MERGE_PLAN_TARGET_MISMATCH",
  planSchemaMismatch: "GRAPH_MERGE_PLAN_SCHEMA_MISMATCH",
  planOriginMismatch: "GRAPH_MERGE_PLAN_ORIGIN_MISMATCH",
  planStale: "GRAPH_MERGE_PLAN_STALE",
  planningStale: "GRAPH_MERGE_PLANNING_STALE",
  candidateSource: "GRAPH_MERGE_CANDIDATE_SOURCE",
  evidence: "GRAPH_MERGE_EVIDENCE",
  candidateWriteSet: "GRAPH_MERGE_CANDIDATE_WRITE_SET",
  review: "GRAPH_MERGE_REVIEW",
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

/** Raised when identity branches contain opposing or retract/reassert truth. */
export class IdentityMergeConflictError extends MergeError {
  override readonly code = MERGE_ERROR_CODES.identityConflict;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "IdentityMergeConflictError";
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
export class MergePlanOriginMismatchError extends InvalidMergePlanError {
  override readonly code = MERGE_ERROR_CODES.planOriginMismatch;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "MergePlanOriginMismatchError";
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

/** Raised when match evidence is invalid or contains a non-finite score. */
export class MatchEvidenceError extends MergeError {
  override readonly code = MERGE_ERROR_CODES.evidence;

  constructor(message: string, options: MergeErrorOptions = {}) {
    super(message, options);
    this.name = "MatchEvidenceError";
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
