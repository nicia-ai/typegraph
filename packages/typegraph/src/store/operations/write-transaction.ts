/**
 * Shared transaction boundary for graph-entity mutations.
 *
 * A node/edge mutation is a cascade of steps — the core row write plus its
 * integrity side effects (uniqueness, embeddings, fulltext) or its delete
 * behavior (restrict / cascade / disconnect). Those steps are individually
 * atomic but not collectively atomic, so the cascade runs inside one top-level
 * transaction whether or not recorded-time capture is enabled: a mid-cascade
 * failure then rolls back the whole operation instead of leaving a half-applied
 * write (e.g. an inserted node whose uniqueness/embedding/fulltext rows were
 * never written, or a uniqueness conflict that leaves an orphaned node row).
 * Under history capture the per-graph write lock is additionally taken inside
 * that transaction so recorded capture serializes.
 *
 * Both {@link NodeOperationContext} and {@link EdgeOperationContext} route their
 * mutations through this one helper, replacing the byte-identical per-file
 * copies that previously drifted independently.
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
 * Runs a graph-entity mutation cascade inside a single top-level transaction.
 *
 * On a transactional backend the cascade shares one transaction so it commits
 * or rolls back atomically. A nested {@link TransactionBackend} (already inside
 * `store.transaction(...)`) omits `.transaction`, so
 * {@link runOptionallyInTransaction} runs `fn` directly against it rather than
 * opening a nested transaction. Non-transactional backends (Cloudflare D1,
 * `drizzle-orm/neon-http`) also run `fn` directly — they cannot offer
 * atomicity, which is documented on the store's write surface.
 *
 * Under history capture the per-graph write lock is taken inside the
 * transaction before any row work, matching the acquire order the recorded
 * clock lock depends on to avoid a circular wait.
 */
export function runInWriteTransaction<T>(
  ctx: WriteTransactionContext,
  backend: GraphBackend | TransactionBackend,
  fn: (target: GraphBackend | TransactionBackend) => Promise<T>,
): Promise<T> {
  return runOptionallyInTransaction(backend, async (target) => {
    if (ctx.historyEnabled) await lockRecordedGraphWrite(target, ctx.graphId);
    return fn(target);
  });
}
