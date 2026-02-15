import {
  type Guardrails,
  type GuardrailViolation,
  type QueryMetrics,
} from "./config";
import { safeRatio } from "./utils";

export function evaluateGuardrails(
  metrics: QueryMetrics,
  guardrails: Guardrails,
): readonly GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];

  const reverseToForward = safeRatio(metrics.reverseMs, metrics.forwardMs);
  if (reverseToForward > guardrails.reverseToForwardRatioMax) {
    violations.push({
      label: "reverse/forward ratio",
      actual: reverseToForward,
      expectedMax: guardrails.reverseToForwardRatioMax,
    });
  }

  if (metrics.inverseTraversalMs > guardrails.inverseTraversalMsMax) {
    violations.push({
      label: "inverse traversal latency (ms)",
      actual: metrics.inverseTraversalMs,
      expectedMax: guardrails.inverseTraversalMsMax,
    });
  }

  const inverseToForward = safeRatio(
    metrics.inverseTraversalMs,
    metrics.forwardMs,
  );
  if (inverseToForward > guardrails.inverseToForwardRatioMax) {
    violations.push({
      label: "inverse/forward ratio",
      actual: inverseToForward,
      expectedMax: guardrails.inverseToForwardRatioMax,
    });
  }

  if (metrics.threeHopMs > guardrails.threeHopMsMax) {
    violations.push({
      label: "3-hop latency (ms)",
      actual: metrics.threeHopMs,
      expectedMax: guardrails.threeHopMsMax,
    });
  }

  const threeHopToTwoHop = safeRatio(metrics.threeHopMs, metrics.twoHopMs);
  if (threeHopToTwoHop > guardrails.threeHopToTwoHopRatioMax) {
    violations.push({
      label: "3-hop/2-hop ratio",
      actual: threeHopToTwoHop,
      expectedMax: guardrails.threeHopToTwoHopRatioMax,
    });
  }

  if (metrics.aggregateMs > guardrails.aggregateMsMax) {
    violations.push({
      label: "aggregate latency (ms)",
      actual: metrics.aggregateMs,
      expectedMax: guardrails.aggregateMsMax,
    });
  }

  if (metrics.aggregateDistinctMs > guardrails.aggregateDistinctMsMax) {
    violations.push({
      label: "aggregate distinct latency (ms)",
      actual: metrics.aggregateDistinctMs,
      expectedMax: guardrails.aggregateDistinctMsMax,
    });
  }

  const aggregateDistinctToAggregate = safeRatio(
    metrics.aggregateDistinctMs,
    metrics.aggregateMs,
  );
  if (
    aggregateDistinctToAggregate >
    guardrails.aggregateDistinctToAggregateRatioMax
  ) {
    violations.push({
      label: "aggregateDistinct/aggregate ratio",
      actual: aggregateDistinctToAggregate,
      expectedMax: guardrails.aggregateDistinctToAggregateRatioMax,
    });
  }

  if (metrics.cachedExecuteMs > guardrails.cachedExecuteMsMax) {
    violations.push({
      label: "cached execute latency (ms)",
      actual: metrics.cachedExecuteMs,
      expectedMax: guardrails.cachedExecuteMsMax,
    });
  }

  if (metrics.preparedExecuteMs > guardrails.preparedExecuteMsMax) {
    violations.push({
      label: "prepared execute latency (ms)",
      actual: metrics.preparedExecuteMs,
      expectedMax: guardrails.preparedExecuteMsMax,
    });
  }

  const preparedToCached = safeRatio(
    metrics.preparedExecuteMs,
    metrics.cachedExecuteMs,
  );
  if (preparedToCached > guardrails.preparedToCachedRatioMax) {
    violations.push({
      label: "prepared/cached ratio",
      actual: preparedToCached,
      expectedMax: guardrails.preparedToCachedRatioMax,
    });
  }

  if (metrics.tenHopMs > guardrails.tenHopMsMax) {
    violations.push({
      label: "10-hop recursive traversal latency (ms)",
      actual: metrics.tenHopMs,
      expectedMax: guardrails.tenHopMsMax,
    });
  }

  if (metrics.recursiveHundredHopMs > guardrails.recursiveHundredHopMsMax) {
    violations.push({
      label: "100-hop recursive traversal latency (ms)",
      actual: metrics.recursiveHundredHopMs,
      expectedMax: guardrails.recursiveHundredHopMsMax,
    });
  }

  const recursiveHundredToTenHop = safeRatio(
    metrics.recursiveHundredHopMs,
    metrics.tenHopMs,
  );
  if (recursiveHundredToTenHop > guardrails.recursiveHundredToTenHopRatioMax) {
    violations.push({
      label: "100-hop-recursive/10-hop-recursive ratio",
      actual: recursiveHundredToTenHop,
      expectedMax: guardrails.recursiveHundredToTenHopRatioMax,
    });
  }

  if (metrics.recursiveThousandHopMs > guardrails.recursiveThousandHopMsMax) {
    violations.push({
      label: "1000-hop recursive traversal latency (ms)",
      actual: metrics.recursiveThousandHopMs,
      expectedMax: guardrails.recursiveThousandHopMsMax,
    });
  }

  const recursiveThousandToHundred = safeRatio(
    metrics.recursiveThousandHopMs,
    metrics.recursiveHundredHopMs,
  );
  if (
    recursiveThousandToHundred > guardrails.recursiveThousandToHundredRatioMax
  ) {
    violations.push({
      label: "1000-hop-recursive/100-hop-recursive ratio",
      actual: recursiveThousandToHundred,
      expectedMax: guardrails.recursiveThousandToHundredRatioMax,
    });
  }

  return violations;
}

export function printSummary(metrics: QueryMetrics): void {
  const reverseToForward = safeRatio(metrics.reverseMs, metrics.forwardMs);
  const inverseToForward = safeRatio(
    metrics.inverseTraversalMs,
    metrics.forwardMs,
  );
  const threeHopToTwoHop = safeRatio(metrics.threeHopMs, metrics.twoHopMs);
  const aggregateDistinctToAggregate = safeRatio(
    metrics.aggregateDistinctMs,
    metrics.aggregateMs,
  );
  const preparedToCached = safeRatio(
    metrics.preparedExecuteMs,
    metrics.cachedExecuteMs,
  );
  const recursiveHundredToTenHop = safeRatio(
    metrics.recursiveHundredHopMs,
    metrics.tenHopMs,
  );
  const recursiveThousandToHundred = safeRatio(
    metrics.recursiveThousandHopMs,
    metrics.recursiveHundredHopMs,
  );
  console.log("\nRatios:");
  console.log(`reverse/forward: ${reverseToForward.toFixed(2)}x`);
  console.log(`inverse/forward: ${inverseToForward.toFixed(2)}x`);
  console.log(`3-hop/2-hop: ${threeHopToTwoHop.toFixed(2)}x`);
  console.log(
    `aggregateDistinct/aggregate: ${aggregateDistinctToAggregate.toFixed(2)}x`,
  );
  console.log(`prepared/cached: ${preparedToCached.toFixed(2)}x`);
  console.log(
    `100-hop-recursive/10-hop-recursive: ${recursiveHundredToTenHop.toFixed(2)}x`,
  );
  console.log(
    `1000-hop-recursive/100-hop-recursive: ${recursiveThousandToHundred.toFixed(2)}x`,
  );
}

export function printGuardrailFailures(
  violations: readonly GuardrailViolation[],
): void {
  console.error("\nPerformance guardrail failures:");

  for (const violation of violations) {
    console.error(
      `- ${violation.label}: ${violation.actual.toFixed(2)} > ${violation.expectedMax.toFixed(2)}`,
    );
  }
}
