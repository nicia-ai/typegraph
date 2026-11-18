/**
 * Shared edge-row fetching.
 *
 * The edge twin of {@link ./node-fetch}: collection reads (`getByIds`), bulk
 * upsert existence probes, and recorded-time after-image capture all need to
 * fetch many edge rows by id, preferring the backend's batch `getEdges` and
 * falling back to parallel `getEdge` calls. Centralizing the fetch mechanics
 * keeps the copies from drifting; each caller layers its own filtering
 * (temporal mode, kind narrowing) on top.
 *
 * It also owns the read of the edges at a SET of endpoints
 * ({@link findEdgeRowsByEndpoints}) for callers that may run on a port without
 * the set-oriented member.
 */
import { bindExtraIfReachable } from "../backend/capabilities/bind";
import {
  BATCH_POINT_READ,
  ENDPOINT_SET_READ,
} from "../backend/capabilities/bundle-registry";
import { type BundleVerdictOf } from "../backend/capabilities/resolve";
import {
  type EdgeRow,
  type FindEdgesByEndpointSetParams,
  type GraphBackend,
} from "../backend/types";
import { groupBy } from "../utils/array";
import { getRowsByIds } from "./row-fetch";

/**
 * Fetches edge rows by id into a Map keyed by id. Uses `backend.getEdges`
 * when available, otherwise issues parallel `getEdge` calls for the distinct
 * ids. Missing ids are simply absent from the returned Map. `verdict` is the
 * threaded `batchPointRead` verdict (`"edge batch fetch"` operation) — bound
 * off `backend`, the port the call executes on, never re-resolved here.
 */
export async function getEdgeRowsByIds(
  backend: Readonly<Pick<GraphBackend, "getEdge" | "getEdges">>,
  verdict: BundleVerdictOf<typeof BATCH_POINT_READ>,
  graphId: string,
  ids: readonly string[],
): Promise<Map<string, EdgeRow>> {
  const bound = bindExtraIfReachable(
    backend,
    verdict.extras.getEdges,
    BATCH_POINT_READ.id,
  );
  return getRowsByIds(ids, {
    batch:
      bound === undefined ? undefined : (
        (batchIds) => bound.getEdges(graphId, batchIds)
      ),
    one: (id) => backend.getEdge(graphId, id),
  });
}

/**
 * Buckets endpoint refs into one id list per kind, preserving input order.
 * Repeated ids are left in place — the backend dedupes an endpoint set before
 * splitting it into bind-budget chunks, which is the only place duplicates
 * could do harm.
 */
export function groupEndpointIdsByKind(
  references: readonly Readonly<{ kind: string; id: string }>[],
): Map<string, string[]> {
  const referencesByKind = groupBy(references, (ref) => ref.kind);
  return new Map(
    [...referencesByKind].map(([endpointKind, group]) => [
      endpointKind,
      group.map((ref) => ref.id),
    ]),
  );
}

/**
 * The read surface {@link findEdgeRowsByEndpoints} needs: the endpoint-filtered
 * kind read every backend has, plus the set-oriented member when the port
 * carries it.
 */
export type EndpointEdgeReader = Readonly<
  Pick<GraphBackend, "findEdgesByKind"> &
    Partial<Pick<GraphBackend, "findEdgesByEndpointSet">>
>;

/**
 * One edge kind read at a set of endpoints: {@link FindEdgesByEndpointSetParams}
 * with the single endpoint kind widened to references of any kind.
 */
export type FindEdgeRowsByEndpointsParams = Omit<
  FindEdgesByEndpointSetParams,
  "endpointKind" | "endpointIds" | "limitPerEndpoint"
> &
  Readonly<{ endpoints: readonly Readonly<{ kind: string; id: string }>[] }>;

/**
 * Reads the edges of one kind at a set of endpoints, set-oriented where the
 * port the read runs on reaches `findEdgesByEndpointSet` and through one
 * endpoint-filtered `findEdgesByKind` per endpoint where it does not.
 *
 * The fallback is this function's whole reason to exist beside the collection
 * API's `bulkFindFrom` / `bulkFindTo`, which refuse a port without the member:
 * a caller of those asked for set-oriented statements, while a caller of this
 * needs the rows on every backend and takes the set read as an optimization.
 * The rows are the same either way; their order is not specified. `verdict` is
 * the threaded `endpointSetRead` verdict, bound off `backend` and never
 * re-resolved here.
 */
export async function findEdgeRowsByEndpoints(
  backend: EndpointEdgeReader,
  verdict: BundleVerdictOf<typeof ENDPOINT_SET_READ>,
  params: FindEdgeRowsByEndpointsParams,
): Promise<readonly EdgeRow[]> {
  const { endpoints, ...read } = params;
  const bound = bindExtraIfReachable(
    backend,
    verdict.extras.findEdgesByEndpointSet,
    ENDPOINT_SET_READ.id,
  );
  const rows: EdgeRow[] = [];
  for (const [endpointKind, endpointIds] of groupEndpointIdsByKind(endpoints)) {
    if (bound !== undefined) {
      rows.push(
        ...(await bound.findEdgesByEndpointSet({
          ...read,
          endpointKind,
          endpointIds,
        })),
      );
      continue;
    }
    for (const endpointId of new Set(endpointIds)) {
      rows.push(
        ...(await backend.findEdgesByKind({
          graphId: read.graphId,
          kind: read.kind,
          ...(read.side === "from" ?
            { fromKind: endpointKind, fromId: endpointId }
          : { toKind: endpointKind, toId: endpointId }),
          ...(read.excludeDeleted === undefined ?
            {}
          : { excludeDeleted: read.excludeDeleted }),
          ...(read.temporalMode === undefined ?
            {}
          : { temporalMode: read.temporalMode }),
          ...(read.asOf === undefined ? {} : { asOf: read.asOf }),
        })),
      );
    }
  }
  return rows;
}
