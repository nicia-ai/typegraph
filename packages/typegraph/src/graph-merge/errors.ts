import type { TypeGraphErrorOptions } from "./typegraph-internal";
import { TypeGraphError } from "./typegraph-internal";

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
  branch: "GRAPH_MERGE_BRANCH_ERROR",
  similarityUnavailable: "GRAPH_MERGE_SIMILARITY_UNAVAILABLE",
  conflict: "GRAPH_MERGE_CONFLICT",
  identityConflict: "GRAPH_MERGE_IDENTITY_CONFLICT",
  baseVersionMismatch: "GRAPH_MERGE_BASE_VERSION_MISMATCH",
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
  constructor(message: string, options: MergeErrorOptions = {}) {
    super(
      message,
      MERGE_ERROR_CODES.merge,
      toTypeGraphErrorOptions("system", options),
    );
    this.name = "MergeError";
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
