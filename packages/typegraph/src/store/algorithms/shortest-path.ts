import { findShortestPath } from "./breadth-first";
import {
  type AlgorithmContext,
  assertEdgeKinds,
  DEFAULT_ALGORITHM_MAX_HOPS,
  type InternalTraversalOptions,
  resolveMaxHops,
} from "./context";
import type { ShortestPathResult } from "./types";

export async function executeShortestPath(
  ctx: AlgorithmContext,
  sourceId: string,
  targetId: string,
  options: InternalTraversalOptions,
): Promise<ShortestPathResult | undefined> {
  assertEdgeKinds(options.edges);
  const maxHops = resolveMaxHops(
    options.maxHops,
    DEFAULT_ALGORITHM_MAX_HOPS,
    "maxHops",
  );
  return findShortestPath(ctx, sourceId, targetId, maxHops, options);
}
