/**
 * Value-level parity gate: no cross-engine timing comparison is
 * trustworthy unless every engine that ran a query returned the identical
 * result — not just the same result-set *size* — for every sampled
 * request. Engines run the SAME seeded request sequence (same sampled ids,
 * same order), so per-request row counts and value digests are directly
 * comparable index-for-index.
 *
 * `rowCounts` alone (the original, pre-digest version of this gate) cannot
 * catch two engines agreeing on *how many* rows a query returns while
 * disagreeing on the actual field values, omitted fields, or row order —
 * exactly the gap a review of this benchmark found: every engine shared an
 * identical semantic bug in IS2, and several engines silently omitted
 * LDBC-required output fields (message content, author names), none of
 * which a row-count-only check could ever detect. `digests` (see
 * `canonicalDigest` in `engines/types.ts`) is compared first and is the
 * stricter, more informative signal; `rowCounts` stays as a coarser,
 * still-useful first check whose mismatch reason is easier to read at a
 * glance ("18 vs 19 rows" vs. an opaque digest diff).
 */
export type EngineQueryOutcomes = Readonly<{
  engine: string;
  /** Row count observed for each sampled request, in request order. */
  rowCounts: readonly number[];
  /** `canonicalDigest()` output observed for each sampled request, in request order. */
  digests: readonly string[];
}>;

export type ParityResult = Readonly<{
  comparable: boolean;
  reason?: string;
}>;

const COMPARABLE: ParityResult = { comparable: true };

/**
 * Evaluates parity across every engine that produced results for one query.
 * Engines that never ran (doctor-failed, skipped) are simply absent from
 * `perEngine` and do not block comparability of the engines that did.
 */
export function evaluateParity(
  perEngine: readonly EngineQueryOutcomes[],
): ParityResult {
  const withData = perEngine.filter((entry) => entry.rowCounts.length > 0);
  if (withData.length < 2) {
    return {
      comparable: false,
      reason: "fewer than two engines produced row counts for this query",
    };
  }

  const requestCount = withData[0]!.rowCounts.length;
  for (const entry of withData) {
    if (entry.rowCounts.length !== requestCount) {
      return {
        comparable: false,
        reason:
          `${entry.engine} sampled ${entry.rowCounts.length} requests, ` +
          `expected ${requestCount} (same request sequence as every other engine)`,
      };
    }
  }

  for (let index = 0; index < requestCount; index += 1) {
    const countsAtIndex = new Set(
      withData.map((entry) => entry.rowCounts[index]),
    );
    if (countsAtIndex.size > 1) {
      const detail = withData
        .map((entry) => `${entry.engine}=${entry.rowCounts[index]}`)
        .join(", ");
      return {
        comparable: false,
        reason: `row-count mismatch at request ${index}: ${detail}`,
      };
    }
  }

  for (let index = 0; index < requestCount; index += 1) {
    const digestsAtIndex = new Set(
      withData.map((entry) => entry.digests[index]),
    );
    if (digestsAtIndex.size > 1) {
      const detail = withData
        .map((entry) => `${entry.engine}=${entry.digests[index]}`)
        .join(" | ");
      return {
        comparable: false,
        reason: `value mismatch at request ${index} (row counts agreed, field values didn't): ${detail}`,
      };
    }
  }

  return COMPARABLE;
}
