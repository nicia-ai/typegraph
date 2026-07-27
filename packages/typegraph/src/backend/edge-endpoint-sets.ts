/**
 * Endpoint-set resolution for `findEdgesByKind`.
 *
 * A `findEdgesByKind` read may constrain an endpoint either by a scalar id
 * (`fromId` / `toId`) or by an id SET (`fromIds` / `toIds`). The set form is
 * what turns a page of N sources into one statement, but it only stays correct
 * under a handful of rules — the ids must be deduped before they are split
 * across bind-budget chunks, at most one side may fan out, and a global
 * `limit` / `offset` / `after` cannot survive that split. This module is the
 * single place those rules live, so every backend that honors the set form
 * enforces the same contract.
 */
import { ConfigurationError } from "../errors";
import type { FindEdgesByKindParams } from "./types";

/**
 * Worst-case count of NON-id bound parameters in a `findEdgesByKind`
 * endpoint-set read: `graph_id`, `kind`, the two `asOf` comparisons,
 * `from_kind`, `to_kind`, the opposite endpoint's scalar id, and
 * `limitPerEndpoint`. Every other bind in the statement is an endpoint id, so a
 * chunk of `maxBindParameters - FIND_EDGES_ENDPOINT_FIXED_PARAM_COUNT` ids
 * always fits. (`limit` / `offset` / `after` never appear beside a set.)
 */
export const FIND_EDGES_ENDPOINT_FIXED_PARAM_COUNT = 8;

/** The endpoint column a set predicate fans out over. */
export type EdgeEndpointSide = "from" | "to";

/**
 * A resolved, deduped endpoint id set. Deduplication is a correctness
 * requirement rather than an optimization: a repeated id split across two
 * chunks would return its edges twice.
 */
export type EdgeEndpointSet = Readonly<{
  side: EdgeEndpointSide;
  ids: readonly string[];
}>;

const ENDPOINT_SET_SUGGESTION =
  "Constrain each endpoint either by a scalar id (fromId / toId) or by an id " +
  "set (fromIds / toIds), fan out over at most one side, and bound per-source " +
  "fan-out with limitPerEndpoint instead of limit / offset / after.";

function endpointSetError(
  message: string,
  params: FindEdgesByKindParams,
): ConfigurationError {
  return new ConfigurationError(
    message,
    {
      code: "EDGE_ENDPOINT_SET_INVALID",
      graphId: params.graphId,
      kind: params.kind,
    },
    { suggestion: ENDPOINT_SET_SUGGESTION },
  );
}

/**
 * Validates the endpoint predicates of a `findEdgesByKind` read and returns
 * the id set to fan out over, or `undefined` when the read is a plain scalar /
 * unconstrained lookup.
 *
 * @throws {ConfigurationError} when a scalar id and its id set are both given,
 * when both sides fan out, when a global `limit` / `offset` / `after` is
 * combined with a set, or when `limitPerEndpoint` is given without an id set or
 * is not a positive integer.
 */
export function resolveEdgeEndpointSet(
  params: FindEdgesByKindParams,
): EdgeEndpointSet | undefined {
  if (params.fromIds !== undefined && params.fromId !== undefined) {
    throw endpointSetError(
      "findEdgesByKind received both `fromId` and `fromIds`; they are mutually exclusive.",
      params,
    );
  }
  if (params.toIds !== undefined && params.toId !== undefined) {
    throw endpointSetError(
      "findEdgesByKind received both `toId` and `toIds`; they are mutually exclusive.",
      params,
    );
  }
  if (params.fromIds !== undefined && params.toIds !== undefined) {
    throw endpointSetError(
      "findEdgesByKind received both `fromIds` and `toIds`; only one endpoint may " +
        "fan out over a set, because a two-sided set has no single bind-budget chunk plan.",
      params,
    );
  }

  const side = endpointSetSide(params);

  assertLimitPerEndpoint(params, side);

  if (side === undefined) return undefined;

  // `limit` / `offset` / `after` order and slice the WHOLE result; a set that
  // spans more than one chunk is read by more than one statement, so no chunk
  // can apply them on the caller's behalf. Rejecting unconditionally keeps the
  // contract independent of the id count and of the driver's bind budget.
  if (
    params.limit !== undefined ||
    params.offset !== undefined ||
    params.after !== undefined
  ) {
    throw endpointSetError(
      "findEdgesByKind cannot combine an endpoint id set with `limit`, `offset`, or `after`: " +
        "a large set is read in bind-budget chunks, so a global slice is not well defined.",
      params,
    );
  }

  const ids = side === "from" ? params.fromIds : params.toIds;
  return { side, ids: [...new Set(ids)] };
}

/** The side that fans out, once the mutual-exclusion rules have been checked. */
function endpointSetSide(
  params: FindEdgesByKindParams,
): EdgeEndpointSide | undefined {
  if (params.fromIds !== undefined) return "from";
  if (params.toIds !== undefined) return "to";
  return undefined;
}

function assertLimitPerEndpoint(
  params: FindEdgesByKindParams,
  side: EdgeEndpointSide | undefined,
): void {
  const { limitPerEndpoint } = params;
  if (limitPerEndpoint === undefined) return;

  if (side === undefined) {
    throw endpointSetError(
      "findEdgesByKind received `limitPerEndpoint` without an endpoint id set; " +
        "the cap partitions by `fromIds` / `toIds` and has nothing to partition by.",
      params,
    );
  }
  if (!Number.isInteger(limitPerEndpoint) || limitPerEndpoint <= 0) {
    throw endpointSetError(
      `findEdgesByKind \`limitPerEndpoint\` must be a positive integer, received ${String(limitPerEndpoint)}.`,
      params,
    );
  }
}

/**
 * Replaces a resolved endpoint set with one chunk of it, preserving every
 * other predicate. The single point that knows which param key each side maps
 * to, so the chunk loop cannot bind the wrong column.
 */
export function withEndpointIdChunk(
  params: FindEdgesByKindParams,
  side: EdgeEndpointSide,
  ids: readonly string[],
): FindEdgesByKindParams {
  return side === "from" ?
      { ...params, fromIds: ids }
    : { ...params, toIds: ids };
}
