import { median, percentile } from "../../utils";

/**
 * Coefficient-of-variation threshold above which a latency distribution is
 * flagged noisy rather than trusted at face value. Matches the braiddb
 * benchmark discipline this program adopts (docs/design/benchmark-program-plan.md).
 */
const NOISY_CV_THRESHOLD_PERCENT = 25;

export type LatencyStats = Readonly<{
  count: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
  cvPercent: number;
  /** True when `cvPercent` exceeds the noisy threshold. */
  noisy: boolean;
}>;

const EMPTY_STATS: LatencyStats = {
  count: 0,
  minMs: 0,
  medianMs: 0,
  p95Ms: 0,
  p99Ms: 0,
  maxMs: 0,
  meanMs: 0,
  cvPercent: 0,
  noisy: false,
};

/**
 * p50/p95/p99/max/mean + coefficient of variation over a latency sample set.
 * `samplesMs` need not be pre-sorted.
 */
export function computeLatencyStats(
  samplesMs: readonly number[],
): LatencyStats {
  if (samplesMs.length === 0) {
    return EMPTY_STATS;
  }

  const sorted = samplesMs.toSorted((left, right) => left - right);
  const meanMs = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance =
    sorted.reduce((sum, value) => sum + (value - meanMs) ** 2, 0) /
    sorted.length;
  const cvPercent = meanMs > 0 ? (Math.sqrt(variance) / meanMs) * 100 : 0;

  return {
    count: sorted.length,
    minMs: sorted[0]!,
    medianMs: median(sorted),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1]!,
    meanMs,
    cvPercent,
    noisy: cvPercent > NOISY_CV_THRESHOLD_PERCENT,
  };
}
