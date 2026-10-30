/**
 * The store's one owner of the node-row lock pairing that keeps a live edge
 * from naming a deleted endpoint (see {@link NodeRowLock}).
 *
 * Every store edge write that inserts or revives a live edge reads its
 * endpoints' liveness here with the `"edgeEndpoint"` lock, and every store
 * node delete reads its row(s) here with the `"delete"` lock before it reads
 * their connected edges. Fused write statements that check endpoint liveness
 * in SQL take the same endpoint lock inside the statement instead.
 *
 * A backend without `lockNodes` gets unlocked `getNode` reads: the invariant
 * then rests on the engine serializing writers, as SQLite does.
 */
import {
  type GraphBackend,
  type NodeRow,
  type NodeRowLock,
} from "../../backend/types";

type NodeRowLockBackend = Pick<GraphBackend, "getNode" | "lockNodes">;

/**
 * Reads one kind's rows by id — live and tombstoned alike — locked for `lock`
 * until the surrounding transaction ends.
 */
export async function lockNodeRows(
  backend: NodeRowLockBackend,
  graphId: string,
  kind: string,
  ids: readonly string[],
  lock: NodeRowLock,
): Promise<readonly NodeRow[]> {
  if (ids.length === 0) return [];
  const lockNodes = backend.lockNodes;
  if (lockNodes !== undefined) return lockNodes(graphId, kind, ids, lock);
  const rows = await Promise.all(
    [...new Set(ids)].map((id) => backend.getNode(graphId, kind, id)),
  );
  return rows.filter((row): row is NodeRow => row !== undefined);
}

/** {@link lockNodeRows} for one id. */
export async function lockNodeRow(
  backend: NodeRowLockBackend,
  graphId: string,
  kind: string,
  id: string,
  lock: NodeRowLock,
): Promise<NodeRow | undefined> {
  const rows = await lockNodeRows(backend, graphId, kind, [id], lock);
  return rows.find((row) => row.id === id);
}

/** {@link lockNodeRows}, keyed by id. */
export async function lockNodeRowsById(
  backend: NodeRowLockBackend,
  graphId: string,
  kind: string,
  ids: readonly string[],
  lock: NodeRowLock,
): Promise<ReadonlyMap<string, NodeRow>> {
  const rows = await lockNodeRows(backend, graphId, kind, ids, lock);
  return new Map(rows.map((row) => [row.id, row]));
}
