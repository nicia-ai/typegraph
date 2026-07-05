/**
 * Row-count parity gate: no cross-engine timing comparison is trustworthy
 * unless every engine that ran a query returned the identical result-set
 * size for every sampled request. Engines run the SAME seeded request
 * sequence (same sampled ids, same order), so per-request row counts are
 * directly comparable index-for-index.
 */
export type EngineRowCounts = Readonly<{
  engine: string;
  /** Row count observed for each sampled request, in request order. */
  rowCounts: readonly number[];
}>;

export type ParityResult = Readonly<{
  comparable: boolean;
  reason?: string;
}>;

const COMPARABLE: ParityResult = { comparable: true };

/**
 * Evaluates parity across every engine that produced row counts for one
 * query. Engines that never ran (doctor-failed, skipped) are simply absent
 * from `perEngine` and do not block comparability of the engines that did.
 */
export function evaluateParity(
  perEngine: readonly EngineRowCounts[],
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

  return COMPARABLE;
}
