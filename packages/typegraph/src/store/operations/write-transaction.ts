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
import { type SqlSchema } from "../../query/compiler/schema";
import {
  advanceRevisionClock,
  lockRecordedGraphWrite,
} from "../recorded-capture";
import {
  type GraphWriteLock,
  uncapturedGraphWriteLock,
} from "../recorded-capture/clock";
import { type OperationHookContext } from "../types";

/**
 * The slice of an operation context {@link runInWriteTransaction} needs: the
 * graph id (for the capture lock) and whether recorded-time capture is on.
 * Both {@link NodeOperationContext} and {@link EdgeOperationContext} satisfy it.
 */
export type WriteTransactionContext = Readonly<{
  graphId: string;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
  revisionSchema: SqlSchema;
}>;

interface WriteTransactionSession {
  readonly ctx: WriteTransactionContext;
  lock: GraphWriteLock | undefined;
  wrote: boolean;
}

const writeTransactionSessions = new WeakMap<object, WriteTransactionSession>();

/**
 * Binds nested typed mutations to one caller-owned transaction commit so a
 * multi-operation `store.transaction(...)` advances its durable revision once.
 */
export async function withWriteTransactionSession<T>(
  target: TransactionBackend,
  ctx: WriteTransactionContext,
  fn: () => Promise<T>,
): Promise<T> {
  const session: WriteTransactionSession = {
    ctx,
    lock: undefined,
    wrote: false,
  };
  writeTransactionSessions.set(target, session);
  try {
    const result = await fn();
    if (session.wrote && ctx.revisionTrackingEnabled && !ctx.historyEnabled) {
      await advanceRevisionClock(target, ctx.revisionSchema, ctx.graphId, true);
    }
    return result;
  } finally {
    writeTransactionSessions.delete(target);
  }
}

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
  fn: (
    target: GraphBackend | TransactionBackend,
    lock: GraphWriteLock,
  ) => Promise<T>,
  options?: Readonly<{
    /**
     * Gate consulted AFTER `fn` resolves (autocommit path only): return false to
     * skip advancing the durable revision clock. Defaults to advancing
     * unconditionally. Identity mutations use this so a successful no-op
     * (retracting an unknown id, an idempotent reassert) does not tick the clock.
     */
    shouldAdvanceRevision?: () => boolean;
  }>,
): Promise<T> {
  const ownsWriteLock =
    "transaction" in backend && backend.capabilities.transactions;
  return runOptionallyInTransaction(backend, async (target) => {
    const session =
      ctx.historyEnabled || ctx.revisionTrackingEnabled ?
        writeTransactionSessions.get(target)
      : undefined;
    const lock =
      session?.lock ??
      (ctx.historyEnabled || ctx.revisionTrackingEnabled ?
        await lockRecordedGraphWrite(target, ctx.graphId)
      : uncapturedGraphWriteLock());
    if (session !== undefined) session.lock = lock;
    const result = await fn(target, lock);
    if (session !== undefined) {
      session.wrote = true;
      return result;
    }
    // History capture advances the same clock when it flushes its recorded
    // after-images. Live stores opt into revisions independently, so advance
    // only there and only after every row/sidecar write succeeded.
    if (
      ctx.revisionTrackingEnabled &&
      !ctx.historyEnabled &&
      (options?.shouldAdvanceRevision?.() ?? true)
    ) {
      await advanceRevisionClock(
        target,
        ctx.revisionSchema,
        ctx.graphId,
        ownsWriteLock,
      );
    }
    return result;
  });
}

/**
 * The slice of an operation context {@link runHookedWriteOperation} needs:
 * the {@link WriteTransactionContext} plus the hook wrapper. Both
 * `NodeOperationContext` and `EdgeOperationContext` satisfy it.
 */
export type HookedWriteOperationContext = WriteTransactionContext &
  Readonly<{
    withOperationHooks: <T>(
      ctx: OperationHookContext,
      fn: () => Promise<T>,
    ) => Promise<T>;
  }>;

/**
 * The one sanctioned composition for a hooked, non-batch write operation:
 * operation hooks WRAP the write transaction, so `onOperationEnd` observes a
 * durably committed result and a failed COMMIT surfaces through `onError` —
 * a hook that fired inside the transaction would report success for a write
 * the rollback then discards. Every hooked node/edge mutation routes through
 * this helper; composing `withOperationHooks` and `runInWriteTransaction` by
 * hand invites exactly the inverted nesting this exists to prevent.
 * (Batch operations skip hooks deliberately and call
 * {@link runInWriteTransaction} directly.)
 */
export function runHookedWriteOperation<T>(
  ctx: HookedWriteOperationContext,
  opContext: OperationHookContext,
  backend: GraphBackend | TransactionBackend,
  body: (
    target: GraphBackend | TransactionBackend,
    lock: GraphWriteLock,
  ) => Promise<T>,
): Promise<T> {
  return ctx.withOperationHooks(opContext, () =>
    runInWriteTransaction(ctx, backend, body),
  );
}
