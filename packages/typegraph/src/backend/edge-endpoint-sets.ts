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
import type { FindEdgesByEndpointSetParams } from "./types";

/**
 * Worst-case count of NON-id bound parameters in an endpoint-set read:
 * `graph_id`, `kind`, the endpoint kind, the two `asOf` comparisons, and
 * `limitPerEndpoint`. Every other bind in the statement is an endpoint id, so
 * a chunk of `maxBindParameters - FIND_EDGES_ENDPOINT_FIXED_PARAM_COUNT` ids
 * always fits.
 */
export const FIND_EDGES_ENDPOINT_FIXED_PARAM_COUNT = 6;

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
  const { limitPerEndpoint } = params;
  if (
    limitPerEndpoint !== undefined &&
    (!Number.isInteger(limitPerEndpoint) || limitPerEndpoint <= 0)
  ) {
    throw new ConfigurationError(
      `findEdgesByEndpointSet \`limitPerEndpoint\` must be a positive integer, received ${String(limitPerEndpoint)}.`,
      {
        code: "EDGE_ENDPOINT_SET_INVALID",
        graphId: params.graphId,
        kind: params.kind,
      },
      {
        suggestion:
          "Pass a positive integer to cap each endpoint's rows, or omit it for an unbounded read.",
      },
    );
  }
  return [...new Set(params.endpointIds)];
}
