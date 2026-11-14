import { errorChain } from "../utils/sql-errors";

/** Physical retention metadata column shared by schema adoption and allocation-log SQL. */
export const RECORDED_ANCHOR_RETENTION_COLUMN = "anchor_retention";

/** Maximum queued wait for the additive recorded-clock migration. */
export const RECORDED_ANCHOR_ADOPTION_WAIT_BUDGET_MS = 1000;

/** Machine-readable provenance attached only to the retention ALTER's lock failure. */
export const RECORDED_ANCHOR_ADOPTION_TIMEOUT_HINT =
  "typegraph:recorded-anchor-retention-adoption";

/** Read the effective budget supplied by the database session that acquired the lock. */
export function recordedAnchorAdoptionTimeoutBudget(
  error: unknown,
): number | undefined {
  for (const link of errorChain(error)) {
    if (typeof link !== "object" || link === null) continue;
    if (
      Reflect.get(link, "code") !== "55P03" ||
      Reflect.get(link, "hint") !== RECORDED_ANCHOR_ADOPTION_TIMEOUT_HINT
    )
      continue;
    const detail: unknown = Reflect.get(link, "detail");
    if (typeof detail !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(detail);
      if (typeof parsed !== "object" || parsed === null) continue;
      const budget: unknown = Reflect.get(parsed, "waitBudgetMs");
      if (
        typeof budget === "number" &&
        Number.isFinite(budget) &&
        budget > 0 &&
        budget <= RECORDED_ANCHOR_ADOPTION_WAIT_BUDGET_MS
      )
        return budget;
    } catch {
      // An unrelated or malformed driver detail must keep its original error.
    }
  }
  return undefined;
}
