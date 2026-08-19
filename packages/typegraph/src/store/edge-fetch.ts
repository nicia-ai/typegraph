/**
 * Shared edge-row fetching.
 *
 * The edge twin of {@link ./node-fetch}: collection reads (`getByIds`), bulk
 * upsert existence probes, and recorded-time after-image capture all need to
 * fetch many edge rows by id, preferring the backend's batch `getEdges` and
 * falling back to parallel `getEdge` calls. Centralizing the fetch mechanics
 * keeps the copies from drifting; each caller layers its own filtering
 * (temporal mode, kind narrowing) on top.
 */
import { bindExtraIfReachable } from "../backend/capabilities/bind";
import { BATCH_POINT_READ } from "../backend/capabilities/bundle-registry";
import { type BundleVerdictOf } from "../backend/capabilities/resolve";
import {
  type EdgeRow,
  type GraphBackend,
  type TransactionBackend,
} from "../backend/types";
import { getRowsByIds } from "./row-fetch";

/**
 * Fetches edge rows by id into a Map keyed by id. Uses `backend.getEdges`
 * when available, otherwise issues parallel `getEdge` calls for the distinct
 * ids. Missing ids are simply absent from the returned Map. `verdict` is the
 * threaded `batchPointRead` verdict (`"edge batch fetch"` operation) — bound
 * off `backend`, the port the call executes on, never re-resolved here.
 */
export async function getEdgeRowsByIds(
  backend: GraphBackend | TransactionBackend,
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
