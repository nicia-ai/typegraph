import type { GraphDef, GraphIdentityConfig } from "../core/define-graph";
import type { IdentityFacade } from "../identity/types";
import {
  CURRENT_ONLY_READ_NAMES,
  EDGE_TEMPORAL_READ_NAMES,
  IDENTITY_READ_NAMES,
  NODE_TEMPORAL_READ_NAMES,
} from "../store/collection-surface";
import type { TransactionContext } from "../store/types";
import { requireDefined } from "../utils/presence";
import { InvalidMergeOptionsError } from "./errors";
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
      identity: Pick<IdentityFacade<G>, (typeof IDENTITY_READ_NAMES)[number]>;
    }>
  : Readonly<Record<never, never>>);

/** Plan effects inside an uncommitted transaction; excludes callback writes. */
export type MergePlanApplied = Readonly<{ merged: MergedCounts }>;

/**
 * Work composed with merge application in its own protected transaction. Both
 * callbacks may be replayed up to three times on a transaction conflict:
 * await all work, use only the supplied context, perform no external effects.
 * See {@link file://../backend/capabilities/retried-unit.ts runRetriedUnit}
 * for the full replay contract this binds to. Throw/reject to abort;
 * returning a value (including a Result) is refused.
 */
export type MergePlanApplyOptions<G extends GraphDef> = Readonly<{
  /** Runs after the target fence is checked, before plan writes. Reads only. */
  beforeApply?: (reads: MergePlanReadContext<G>) => Promise<void>;
  /** Runs after plan writes, before capture flush and commit. */
  afterApply?: (
    tx: TransactionContext<G>,
    applied: MergePlanApplied,
  ) => Promise<void>;
  /**
   * The digest of the review artifact this plan was approved under
   * (`MergeReviewArtifact.digest.value`), recorded on every identity transition
   * the apply causes. The plan artifact alone does not name its review, so this
   * is the only place the apply can learn it — omitted for a plan applied
   * outside a review workflow.
   */
  reviewDigest?: string;
  /**
   * The candidate write set's `sourceId`, for a plan applied on the ingestion
   * path. Recorded on the identity transitions so an incoming feed's identity
   * effects stay attributable to the feed.
   */
  sourceId?: string;
}>;

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
  callback: keyof MergePlanApplyOptions<GraphDef>,
): void {
  if (result !== undefined) {
    throw new InvalidMergeOptionsError(
      `${callback} must resolve without a return value; throw or reject to abort merge application.`,
      { cause: result, details: { callback } },
    );
  }
}
