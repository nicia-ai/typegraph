import type { GraphDef, GraphIdentityConfig } from "../core/define-graph";
import type { IdentityReadFacade } from "../identity/types";
import {
  CURRENT_ONLY_READ_NAMES,
  EDGE_TEMPORAL_READ_NAMES,
  IDENTITY_READ_NAMES,
  NODE_TEMPORAL_READ_NAMES,
} from "../store/collection-surface";
import type { TransactionContext } from "../store/types";
import { requireDefined } from "../utils/presence";
import { InvalidMergeOptionsError } from "./errors";
import type { MergePlanArtifactV2 } from "./plan-schema";
import type { MergeReviewRevalidation } from "./review-schema";
import type { MergedCounts } from "./types";

const NODE_READ_NAMES = [
  ...NODE_TEMPORAL_READ_NAMES,
  ...CURRENT_ONLY_READ_NAMES,
] as const;

/** Transaction-bound reads available before applying a fenced merge plan. */
export type MergePlanReadContext<G extends GraphDef> = Readonly<{
  nodes: Readonly<{
    [K in keyof TransactionContext<G>["nodes"]]: Pick<
      TransactionContext<G>["nodes"][K],
      (typeof NODE_READ_NAMES)[number]
    >;
  }>;
  edges: Readonly<{
    [K in keyof TransactionContext<G>["edges"]]: Pick<
      TransactionContext<G>["edges"][K],
      (typeof EDGE_TEMPORAL_READ_NAMES)[number]
    >;
  }>;
}> &
  (G["identity"] extends GraphIdentityConfig ?
    Readonly<{
      identity: IdentityReadFacade<G>;
    }>
  : Readonly<Record<never, never>>);

/** Plan effects inside an uncommitted transaction; excludes callback writes. */
export type MergePlanApplied = Readonly<{ merged: MergedCounts }>;

/**
 * A review revalidation that found the reviewed plan still applicable: the
 * `compatible` arm of {@link MergeReviewRevalidation}, carrying the review's
 * digest together with the fresh execution plan it was revalidated into.
 */
export type CompatibleMergeReview = Extract<
  MergeReviewRevalidation,
  Readonly<{ status: "compatible" }>
>;

/**
 * The provenance an apply records on every identity transition it causes. Both
 * apply paths accept it — `applyMergePlan` among its options, and
 * `applyMergePlanInTransaction` as its own — so a plan records the same
 * decision whichever path applied it.
 */
export type MergePlanDecisionOptions = Readonly<{
  /**
   * The compatible revalidation this plan was approved under
   * (`revalidateCandidateWriteSetReview`). Its `reviewDigest` is recorded on
   * every identity transition the apply causes, and it must name the plan
   * being applied: the apply refuses a revalidation whose fresh `plan` is a
   * different plan than the one it is handed. Omitted for a plan applied
   * outside a review workflow.
   */
  review?: CompatibleMergeReview;
  /**
   * The candidate write set's `sourceId`, for a plan applied on the ingestion
   * path. Recorded on the identity transitions so an incoming feed's identity
   * effects stay attributable to the feed.
   */
  sourceId?: string;
}>;

/**
 * Work composed with merge application in its own protected transaction. Both
 * callbacks may be replayed up to three times on a transaction conflict:
 * await all work, use only the supplied context, perform no external effects.
 * See {@link file://../backend/capabilities/retried-unit.ts runRetriedUnit}
 * for the full replay contract this binds to. Throw/reject to abort;
 * returning a value (including a Result) is refused.
 */
export type MergePlanApplyOptions<G extends GraphDef> =
  MergePlanDecisionOptions &
    Readonly<{
      /** Runs after the target fence is checked, before plan writes. Reads only. */
      beforeApply?: (reads: MergePlanReadContext<G>) => Promise<void>;
      /** Runs after plan writes, before capture flush and commit. */
      afterApply?: (
        tx: TransactionContext<G>,
        applied: MergePlanApplied,
      ) => Promise<void>;
    }>;

/** Every key {@link MergePlanDecisionOptions} declares. */
export const MERGE_PLAN_DECISION_OPTION_KEYS: ReadonlySet<string> = new Set(
  Object.keys({
    review: true,
    sourceId: true,
  } satisfies Readonly<Record<keyof MergePlanDecisionOptions, true>>),
);

/** Every key {@link MergePlanApplyOptions} declares. */
export const MERGE_PLAN_APPLY_OPTION_KEYS: ReadonlySet<string> = new Set(
  Object.keys({
    review: true,
    sourceId: true,
    beforeApply: true,
    afterApply: true,
  } satisfies Readonly<Record<keyof MergePlanApplyOptions<GraphDef>, true>>),
);

/**
 * Refuses an apply option the entry point does not declare. The apply reads
 * each option by name, so a misspelled `review` would otherwise be dropped and
 * the apply would record no review at all.
 */
export function assertOnlyDeclaredApplyOptions(
  options: object,
  declared: ReadonlySet<string>,
): void {
  const unknownOption = Object.keys(options).find((key) => !declared.has(key));
  if (unknownOption === undefined) return;
  throw new InvalidMergeOptionsError(
    `Unknown merge plan apply option "${unknownOption}".`,
    { details: { option: unknownOption } },
  );
}

/**
 * The review digest an apply may record for `artifact`: the digest of a
 * compatible revalidation whose fresh plan IS `artifact`, or `undefined` when
 * no review was supplied. A revalidation that is not `compatible`, or that
 * revalidated a different plan, is refused rather than recorded — the digest
 * is evidence about one plan, never a free-standing label.
 */
export function reviewDigestForPlan(
  artifact: MergePlanArtifactV2,
  review: CompatibleMergeReview | undefined,
): string | undefined {
  if (review === undefined) return undefined;
  if ((review as Readonly<{ status: unknown }>).status !== "compatible") {
    throw new InvalidMergeOptionsError(
      "options.review must be a compatible review revalidation; a changed or incompatible review requires a new review and approval.",
      {
        details: {
          option: "review",
          reason: "not-compatible",
          status: (review as Readonly<{ status: unknown }>).status,
        },
      },
    );
  }
  if (review.plan.digest.value !== artifact.digest.value) {
    throw new InvalidMergeOptionsError(
      "options.review revalidated a different merge plan than the one being applied.",
      {
        details: {
          option: "review",
          reason: "plan-mismatch",
          reviewedPlanDigest: review.plan.digest,
          appliedPlanDigest: artifact.digest,
        },
        suggestion:
          "Apply the fresh plan the revalidation returned (`review.plan`).",
      },
    );
  }
  return review.reviewDigest.value;
}

function pickReadMethods<T, K extends keyof T>(
  source: T,
  names: readonly K[],
): Pick<T, K> {
  return Object.fromEntries(names.map((name) => [name, source[name]])) as Pick<
    T,
    K
  >;
}

/**
 * Project actual read-only objects. Enumerate registered kinds: transaction
 * collection proxies instantiate lazily and do not enumerate their own keys.
 */
export function mergePlanReadContext<G extends GraphDef>(
  tx: TransactionContext<G>,
  graph: G,
): MergePlanReadContext<G> {
  return {
    nodes: Object.fromEntries(
      Object.keys(graph.nodes).map((kind) => [
        kind,
        pickReadMethods(requireDefined(tx.nodes[kind]), NODE_READ_NAMES),
      ]),
    ),
    edges: Object.fromEntries(
      Object.keys(graph.edges).map((kind) => [
        kind,
        pickReadMethods(
          requireDefined(tx.edges[kind]),
          EDGE_TEMPORAL_READ_NAMES,
        ),
      ]),
    ),
    ...("identity" in tx ?
      {
        identity: pickReadMethods(tx.identity, IDENTITY_READ_NAMES),
      }
    : {}),
  } as MergePlanReadContext<G>;
}

/** JavaScript callers must not accidentally commit by returning an Err. */
export function assertMergeCallbackResult(
  result: unknown,
  callback: "beforeApply" | "afterApply",
): void {
  if (result !== undefined) {
    throw new InvalidMergeOptionsError(
      `${callback} must resolve without a return value; throw or reject to abort merge application.`,
      { cause: result, details: { callback } },
    );
  }
}
