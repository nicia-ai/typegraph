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
import {
  type EdgeRow,
  type GraphBackend,
  type TransactionBackend,
} from "../backend/types";
import { getRowsByIds } from "./row-fetch";

/**
 * Fetches edge rows by id into a Map keyed by id. Uses `backend.getEdges`
 * when available, otherwise issues parallel `getEdge` calls for the distinct
 * ids. Missing ids are simply absent from the returned Map.
 */
export async function getEdgeRowsByIds(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  ids: readonly string[],
): Promise<Map<string, EdgeRow>> {
  return getRowsByIds(ids, {
    batch:
      backend.getEdges === undefined ?
        undefined
      : (batchIds) => backend.getEdges!(graphId, batchIds),
    one: (id) => backend.getEdge(graphId, id),
  });
}
