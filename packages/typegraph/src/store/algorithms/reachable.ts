import { findReachableNodes, findShortestPath } from "./breadth-first";
import {
  type AlgorithmContext,
  assertEdgeKinds,
  DEFAULT_ALGORITHM_MAX_HOPS,
  DEFAULT_NEIGHBOR_DEPTH,
  type InternalTraversalOptions,
  resolveMaxHops,
} from "./context";
import type { ReachableNode } from "./types";

type InternalReachableOptions = InternalTraversalOptions &
  Readonly<{ excludeSource?: boolean }>;

type InternalNeighborsOptions = Omit<InternalTraversalOptions, "maxHops"> &
  Readonly<{ depth?: number }>;

export async function executeReachable(
  ctx: AlgorithmContext,
  sourceId: string,
  options: InternalReachableOptions,
): Promise<readonly ReachableNode[]> {
  assertEdgeKinds(options.edges);
  const maxHops = resolveMaxHops(
    options.maxHops,
    DEFAULT_ALGORITHM_MAX_HOPS,
    "maxHops",
  );

  const reached = await findReachableNodes(ctx, sourceId, maxHops, options);
  return options.excludeSource === true ?
      reached.filter((node) => node.id !== sourceId)
    : reached;
}

export async function executeCanReach(
  ctx: AlgorithmContext,
  sourceId: string,
  targetId: string,
  options: InternalTraversalOptions,
): Promise<boolean> {
  assertEdgeKinds(options.edges);

  const maxHops = resolveMaxHops(
    options.maxHops,
    DEFAULT_ALGORITHM_MAX_HOPS,
    "maxHops",
  );

  return (
    (await findShortestPath(ctx, sourceId, targetId, maxHops, options)) !==
    undefined
  );
}

export async function executeNeighbors(
  ctx: AlgorithmContext,
  sourceId: string,
  options: InternalNeighborsOptions,
): Promise<readonly ReachableNode[]> {
  const depth = resolveMaxHops(options.depth, DEFAULT_NEIGHBOR_DEPTH, "depth");

  return executeReachable(ctx, sourceId, {
    edges: options.edges,
    maxHops: depth,
    direction: options.direction ?? "out",
    cyclePolicy: options.cyclePolicy ?? "prevent",
    ...(options.temporalMode !== undefined && {
      temporalMode: options.temporalMode,
    }),
    ...(options.asOf !== undefined && { asOf: options.asOf }),
    ...(options.recordedAsOf !== undefined && {
      recordedAsOf: options.recordedAsOf,
    }),
    ...(options.workingMemory !== undefined && {
      workingMemory: options.workingMemory,
    }),
    excludeSource: true,
  });
}
