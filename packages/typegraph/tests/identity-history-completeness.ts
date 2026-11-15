import {
  type GraphDef,
  type IdentityHistoryCompleteness,
  type IdentityHistoryIncompleteReason,
  type IdentityTransition,
  type RecordedInstant,
  type RestoredRecordedInstant,
} from "../src";

type HistoryPage = Readonly<{ completeness: IdentityHistoryCompleteness }>;

/** The `reason` entry of a page's completeness, or `undefined` when that reason does not hold. */
export function completenessReason<
  R extends IdentityHistoryIncompleteReason["reason"],
>(
  page: HistoryPage,
  reason: R,
): Extract<IdentityHistoryIncompleteReason, { reason: R }> | undefined {
  if (page.completeness.status === "complete") return undefined;
  return page.completeness.reasons.find(
    (entry): entry is Extract<IdentityHistoryIncompleteReason, { reason: R }> =>
      entry.reason === reason,
  );
}

/** The retention cut a page reports, or `undefined` when its range is untouched by pruning. */
export function truncatedBeforeOf(
  page: HistoryPage,
): RecordedInstant | undefined {
  return completenessReason(page, "retention-truncated")?.before;
}

/**
 * The recorded instant of a transition this graph recorded itself. A
 * restored transition's `recorded` is the source graph's instant, which no
 * transition-log window, cursor or prune on this graph accepts, so a test
 * that means to address this graph's own history narrows through this.
 */
export function nativeRecorded(
  transition: IdentityTransition<GraphDef> | undefined,
): RecordedInstant {
  if (transition === undefined)
    throw new Error("Expected a transition, got none.");
  if (transition.restored !== undefined)
    throw new Error(
      `Transition ${transition.transitionId} is restored; its recorded instant belongs to the source graph.`,
    );
  return transition.recorded;
}

/** The restored-retention cut a page reports, or `undefined` when no restored cut reaches its range. */
export function restoredTruncatedBeforeOf(
  page: HistoryPage,
): RestoredRecordedInstant | undefined {
  return completenessReason(page, "restored-retention-truncated")?.before;
}
