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

  if (metrics.scopedAggregateMs > guardrails.scopedAggregateMsMax) {
    violations.push({
      label: "scoped aggregate latency (ms)",
      actual: metrics.scopedAggregateMs,
      expectedMax: guardrails.scopedAggregateMsMax,
    });
  }

  if (metrics.aggregateEdgesMs > guardrails.aggregateEdgesMsMax) {
    violations.push({
      label: "aggregate edges latency (ms)",
      actual: metrics.aggregateEdgesMs,
      expectedMax: guardrails.aggregateEdgesMsMax,
    });
  }

  if (metrics.indexedFilterMs > guardrails.indexedFilterMsMax) {
    violations.push({
      label: "indexed filter latency (ms)",
      actual: metrics.indexedFilterMs,
      expectedMax: guardrails.indexedFilterMsMax,
    });
  }

  if (metrics.temporalAsOfMs > guardrails.temporalAsOfMsMax) {
    violations.push({
      label: "temporal asOf latency (ms)",
      actual: metrics.temporalAsOfMs,
      expectedMax: guardrails.temporalAsOfMsMax,
    });
  }

  if (metrics.fulltextSearchMs > guardrails.fulltextSearchMsMax) {
    violations.push({
      label: "fulltext search latency (ms)",
      actual: metrics.fulltextSearchMs,
      expectedMax: guardrails.fulltextSearchMsMax,
    });
  }

  if (
    metrics.vectorSearchMs !== undefined &&
    metrics.vectorSearchMs > guardrails.vectorSearchMsMax
  ) {
    violations.push({
      label: "vector search latency (ms)",
      actual: metrics.vectorSearchMs,
      expectedMax: guardrails.vectorSearchMsMax,
    });
  }

  if (
    metrics.hybridSearchMs !== undefined &&
    metrics.hybridSearchMs > guardrails.hybridSearchMsMax
  ) {
    violations.push({
      label: "hybrid search latency (ms)",
      actual: metrics.hybridSearchMs,
      expectedMax: guardrails.hybridSearchMsMax,
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
  const subgraphApplicationToFull = safeRatio(
    metrics.subgraphApplicationProjectionMs,
    metrics.subgraphFullMs,
  );
  const subgraphSqlToFull = safeRatio(
    metrics.subgraphSqlProjectionMs,
    metrics.subgraphFullMs,
  );
  const subgraphSqlToApplication = safeRatio(
    metrics.subgraphSqlProjectionMs,
    metrics.subgraphApplicationProjectionMs,
  );
  const subgraphStressApplicationToFull = safeRatio(
    metrics.subgraphStressApplicationProjectionMs,
    metrics.subgraphStressFullMs,
  );
  const subgraphStressSqlToFull = safeRatio(
    metrics.subgraphStressSqlProjectionMs,
    metrics.subgraphStressFullMs,
  );
  const subgraphStressSqlToApplication = safeRatio(
    metrics.subgraphStressSqlProjectionMs,
    metrics.subgraphStressApplicationProjectionMs,
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
    `subgraph-app-projection/full: ${subgraphApplicationToFull.toFixed(2)}x`,
  );
  console.log(`subgraph-sql/full: ${subgraphSqlToFull.toFixed(2)}x`);
  console.log(
    `subgraph-sql/app-projection: ${subgraphSqlToApplication.toFixed(2)}x`,
  );
  console.log(
    `subgraph-stress-app-projection/full: ${subgraphStressApplicationToFull.toFixed(2)}x`,
  );
  console.log(
    `subgraph-stress-sql/full: ${subgraphStressSqlToFull.toFixed(2)}x`,
  );
  console.log(
    `subgraph-stress-sql/app-projection: ${subgraphStressSqlToApplication.toFixed(2)}x`,
  );
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
