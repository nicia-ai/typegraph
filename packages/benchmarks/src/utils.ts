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

export function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

export function safeRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return numerator / denominator;
}
