import { performance } from "node:perf_hooks";

export function nowMs(): number {
  return performance.now();
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1]! + sorted[middle]!) / 2;
  }

  return sorted[middle]!;
}

/**
 * Nearest-rank percentile over the sorted samples. For the default suite
 * size (15 samples) this picks index ceil(0.95 * 15) - 1 = 14, i.e. the
 * slowest sample — a conservative tail estimate suitable for catching
 * occasional slow outliers in CI.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  if (!Number.isFinite(p) || p <= 0 || p > 1) {
    throw new RangeError(`percentile rank must be in (0, 1], got ${p}`);
  }
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[index]!;
}

export function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

const MAX_SAFE_RATIO = 1_000_000;

export function safeRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return MAX_SAFE_RATIO;
  }
  return numerator / denominator;
}
