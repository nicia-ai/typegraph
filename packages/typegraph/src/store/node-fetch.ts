/**
 * Shared node-row fetching.
 *
 * Both collection reads (`getByIds`) and declared-index lookup hydration need
 * to fetch many node rows by id, preferring the backend's batch `getNodes`
 * and falling back to parallel `getNode` calls. Centralizing the fetch
 * mechanics keeps the two paths from drifting; each caller layers its own
 * filtering (temporal mode vs. live-only) on top.
 */
import {
  type GraphBackend,
  type NodeRow as BackendNodeRow,
  type TransactionBackend,
} from "../backend/types";
import { getRowsByIds } from "./row-fetch";

/**
 * Fetches node rows by id into a Map keyed by id. Uses `backend.getNodes`
 * when available, otherwise issues parallel `getNode` calls for the distinct
 * ids. Missing ids are simply absent from the returned Map.
 */
export async function getNodeRowsByIds(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  kind: string,
  ids: readonly string[],
): Promise<Map<string, BackendNodeRow>> {
  return getRowsByIds(ids, {
    batch:
      backend.getNodes === undefined ?
        undefined
      : (batchIds) => backend.getNodes!(graphId, kind, batchIds),
    one: (id) => backend.getNode(graphId, kind, id),
  });
}
