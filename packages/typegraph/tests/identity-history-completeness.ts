import {
  type IdentityHistoryCompleteness,
  type IdentityHistoryIncompleteReason,
  type RecordedInstant,
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
