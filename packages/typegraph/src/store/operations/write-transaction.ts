/**
 * Shared transaction boundary for graph-entity mutations.
 *
 * A node/edge mutation is a cascade of steps — the core row write plus its
 * integrity side effects (uniqueness, embeddings, fulltext) or its delete
 * behavior (restrict / cascade / disconnect). Under recorded-time capture the
 * cascade runs inside one top-level transaction so it commits atomically and
 * collapses into a single recorded commit instant, and the per-graph write lock
 * is taken inside that transaction so capture serializes.
 *
 * Both {@link NodeOperationContext} and {@link EdgeOperationContext} route their
 * mutations through this one helper, replacing the byte-identical
 * per-file copies that previously drifted independently.
 *
 * Note: without history capture the cascade is *not* wrapped here — the steps
 * run directly against the backend, matching the pre-existing behavior. Making
 * that boundary unconditional (so a mid-cascade failure can never orphan a node
 * on a plain store) is a deliberate follow-up: on the async libsql driver the
 * SQLite backend's serialized-write queue is absent, so opening a transaction
 * per mutation collides with `SQLITE_BUSY`. Closing the atomicity gap therefore
 * has to land together with that backend serialization fix, not here.
 */
import {
  type GraphBackend,
  runOptionallyInTransaction,
  type TransactionBackend,
} from "../../backend/types";
import { lockRecordedGraphWrite } from "../recorded-capture";

/**
 * The slice of an operation context {@link runInWriteTransaction} needs: the
 * graph id (for the capture lock) and whether recorded-time capture is on.
 * Both {@link NodeOperationContext} and {@link EdgeOperationContext} satisfy it.
 */
export type WriteTransactionContext = Readonly<{
  graphId: string;
  historyEnabled: boolean;
}>;

/**
 * Runs a graph-entity mutation cascade under the store's transaction boundary.
 *
 * With recorded-time capture enabled the cascade runs inside one transaction
 * (opened by {@link runOptionallyInTransaction} when the backend is
 * transactional; a nested {@link TransactionBackend} omits `.transaction`, so it
 * runs directly rather than nesting), and the per-graph write lock is taken
 * before any row work — matching the acquire order the recorded clock lock
 * depends on to avoid a circular wait. Without capture the cascade runs
 * directly against the backend.
 */
export function runInWriteTransaction<T>(
  ctx: WriteTransactionContext,
  backend: GraphBackend | TransactionBackend,
  fn: (target: GraphBackend | TransactionBackend) => Promise<T>,
): Promise<T> {
  if (!ctx.historyEnabled) return fn(backend);
  return runOptionallyInTransaction(backend, async (target) => {
    await lockRecordedGraphWrite(target, ctx.graphId);
    return fn(target);
  });
}
