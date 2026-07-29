/**
 * Shared rules for a `findEdgesByEndpointSet` read.
 *
 * Most of what an endpoint-set read has to get right is enforced by the shape
 * of {@link FindEdgesByEndpointSetParams} itself: one `side` means both
 * endpoints can never fan out at once, the absence of a scalar `fromId` /
 * `toId` means a scalar and a set can never disagree, and the absence of
 * `limit` / `offset` / `after` means no caller can ask for a global slice
 * across a read the backend splits into chunks.
 *
 * What is left needs code: the ids must be deduplicated before they are split
 * across bind-budget chunks, and `limitPerEndpoint` must be a usable number.
 * Both live here so every backend honoring the operation enforces them
 * identically.
 */
import { ConfigurationError } from "../errors";
import type {
  FindEdgesByEndpointSetParams,
  FindEdgesByHeterogeneousEndpointSetParams,
} from "./types";

type EdgeEndpointReference =
  FindEdgesByHeterogeneousEndpointSetParams["endpoints"][number];

/**
 * Worst-case count of NON-id bound parameters in an endpoint-set read:
 * `graph_id`, `kind`, the endpoint kind, the two `asOf` comparisons, and
 * `limitPerEndpoint`. Every other bind in the statement is an endpoint id, so
 * a chunk of `maxBindParameters - FIND_EDGES_ENDPOINT_FIXED_PARAM_COUNT` ids
 * always fits.
 */
export const FIND_EDGES_ENDPOINT_FIXED_PARAM_COUNT = 6;

/**
 * Worst-case non-source binds in a heterogeneous endpoint read: `graph_id`,
 * two `asOf` comparisons, and `limitPerEndpoint`. Edge-kind binds are accounted
 * for separately because their count is supplied by the caller.
 */
const FIND_EDGES_HETEROGENEOUS_FIXED_PARAM_COUNT = 4;

function assertLimitPerEndpoint(
  operation: string,
  graphId: string,
  limitPerEndpoint: number | undefined,
  kind?: string,
): void {
  if (
    limitPerEndpoint === undefined ||
    (Number.isInteger(limitPerEndpoint) && limitPerEndpoint > 0)
  ) {
    return;
  }
  throw new ConfigurationError(
    `${operation} \`limitPerEndpoint\` must be a positive integer, received ${String(limitPerEndpoint)}.`,
    {
      code: "EDGE_ENDPOINT_SET_INVALID",
      graphId,
      ...(kind === undefined ? {} : { kind }),
    },
    {
      suggestion:
        "Pass a positive integer to cap each endpoint's rows, or omit it for an unbounded read.",
    },
  );
}

/**
 * Validates an endpoint-set read and returns its deduplicated id list.
 *
 * Deduplication is a correctness requirement rather than a tidiness one: a
 * repeated id split across two chunks would return its edges twice.
 *
 * @throws {ConfigurationError} when `limitPerEndpoint` is not a positive
 *   integer.
 */
export function resolveEdgeEndpointIds(
  params: FindEdgesByEndpointSetParams,
): readonly string[] {
  assertLimitPerEndpoint(
    "findEdgesByEndpointSet",
    params.graphId,
    params.limitPerEndpoint,
    params.kind,
  );
  return [...new Set(params.endpointIds)];
}

function endpointKey(endpoint: EdgeEndpointReference): string {
  return `${endpoint.kind}\0${endpoint.id}`;
}

/**
 * Validates and normalizes a heterogeneous endpoint-set read and computes how
 * many endpoint pairs fit in one statement.
 */
export function resolveHeterogeneousEdgeRead(
  params: FindEdgesByHeterogeneousEndpointSetParams,
  maxBindParameters: number,
): Readonly<{
  edgeKinds: readonly string[];
  endpoints: readonly EdgeEndpointReference[];
  endpointChunkSize: number;
}> {
  assertLimitPerEndpoint(
    "findEdgesByHeterogeneousEndpointSet",
    params.graphId,
    params.limitPerEndpoint,
  );

  const edgeKinds = [...new Set(params.edgeKinds)];
  const endpoints = [
    ...new Map(
      params.endpoints.map((endpoint) => [endpointKey(endpoint), endpoint]),
    ).values(),
  ];
  if (edgeKinds.length === 0 || endpoints.length === 0) {
    return { edgeKinds, endpoints, endpointChunkSize: 1 };
  }

  const endpointBindBudget =
    maxBindParameters -
    FIND_EDGES_HETEROGENEOUS_FIXED_PARAM_COUNT -
    edgeKinds.length;
  const endpointChunkSize = Math.floor(endpointBindBudget / 2);
  if (endpointChunkSize >= 1) {
    return { edgeKinds, endpoints, endpointChunkSize };
  }

  throw new ConfigurationError(
    "findEdgesByHeterogeneousEndpointSet cannot fit one endpoint and the selected edge kinds within the backend bind-parameter budget.",
    {
      code: "EDGE_HETEROGENEOUS_READ_BIND_BUDGET_EXCEEDED",
      graphId: params.graphId,
      edgeKindCount: edgeKinds.length,
      maxBindParameters,
    },
    {
      suggestion:
        "Select fewer edge kinds in one call or use a backend with a larger bind-parameter budget.",
    },
  );
}
