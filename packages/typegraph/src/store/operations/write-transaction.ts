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
 *
 * ## Lock order
 *
 * Every managed Store write acquires, in this order and no other:
 *
 * 1. the schema-version fence ({@link lockSchemaVersionForStoreWrite}), which
 *    pins the schema the write compiles against;
 * 2. the per-graph write lock — `typegraph:recorded-graph-write`, taken here
 *    BEFORE any row read or write, so nothing a later step decides can be
 *    invalidated by a concurrent graph write;
 * 3. the per-graph identity lock (`typegraph:identity`), taken by the identity
 *    service inside `fn`;
 * 4. row work;
 * 5. `typegraph:recorded-clock`, taken LAST, at capture flush.
 *
 * The comment on `graphAdvisoryLockSql` in
 * {@link file://../recorded-capture/clock.ts} states the rule this order
 * exists to satisfy: a lock namespace belongs to ONE acquire-order position,
 * and sharing a key across two positions creates a circular wait.
 *
 * Constrained writes (see `fencesConstraintProbe` below) therefore reuse the
 * EXISTING `typegraph:recorded-graph-write` key rather than introducing a
 * sibling namespace. A sibling would be strictly wrong here: it would sit at
 * the same acquire-order position but form a disjoint exclusion set, so a
 * capture-enabled writer holding the recorded key and a constrained writer
 * holding the sibling would not exclude each other — which is precisely the
 * mutual exclusion the constrained write needs.
 */
import {
  type GraphBackend,
  runOptionallyInTransaction,
  type TransactionBackend,
} from "../../backend/types";
import { ConfigurationError } from "../../errors";
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
  schemaVersion: number | undefined;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
  revisionSchema: SqlSchema;
}>;

interface WriteTransactionSession {
  lock: GraphWriteLock | undefined;
  wrote: boolean;
}

const writeTransactionSessions = new WeakMap<object, WriteTransactionSession>();

/**
 * Graphs whose per-graph write lock a still-running {@link runInWriteTransaction}
 * frame already holds on a given target.
 *
 * `pg_advisory_xact_lock` is reentrant and held to the end of the top-level
 * transaction, so re-acquiring it is pure round-trip churn. Operations compose
 * — a bulk `getOrCreateByEndpoints` calls the create batch and the upsert
 * update against ITS transaction target — and each nested call would otherwise
 * pay a lock round trip the enclosing frame already paid.
 *
 * `store.transaction(...)` is covered by {@link WriteTransactionSession}
 * instead; this covers the operation-calls-operation nesting inside a single
 * managed write. Same caveat as the capture layer's memo in
 * `recorded-capture/clock.ts`: NOT savepoint-aware. A manual `SAVEPOINT` rolled
 * back across the outer acquisition releases the lock but not this entry;
 * manual savepoints inside a managed write are outside the contract.
 */
const heldGraphWriteLocks = new WeakMap<object, Set<string>>();

function holdsGraphWriteLock(target: object, graphId: string): boolean {
  return heldGraphWriteLocks.get(target)?.has(graphId) === true;
}

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
 * Acquires and validates the transaction-scoped schema fence for one managed
 * Store write. This intentionally runs for every write: PostgreSQL releases
 * row locks acquired after a savepoint when the caller rolls back to that
 * savepoint, so caching an earlier acquisition could let a later write proceed
 * without a live fence.
 */
export async function lockSchemaVersionForStoreWrite(
  ctx: Pick<WriteTransactionContext, "graphId" | "schemaVersion">,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  const expectedVersion = ctx.schemaVersion;
  if (expectedVersion === undefined) return;

  if ("transaction" in backend && !backend.capabilities.transactions) {
    throw new ConfigurationError(
      "Schema-managed Store writes require a transactional backend so schema " +
        "changes and entity writes can share one fence.",
      {
        code: "SCHEMA_WRITE_FENCE_UNSUPPORTED",
        graphId: ctx.graphId,
      },
    );
  }

  const lockSchemaVersionForWrite = backend.lockSchemaVersionForWrite;
  if (lockSchemaVersionForWrite === undefined) {
    throw new ConfigurationError(
      "This backend cannot fence schema-managed Store writes against a " +
        "concurrent schema change.",
      {
        code: "SCHEMA_WRITE_FENCE_UNSUPPORTED",
        graphId: ctx.graphId,
      },
    );
  }

  await lockSchemaVersionForWrite({
    graphId: ctx.graphId,
    expectedVersion,
  });
}

/**
 * How a write states whether it needs the per-graph write fence.
 *
 * `fencesConstraintProbe` is an assertion about THIS write's body: "it runs a
 * check-then-act whose verdict no database key repeats at write time". The
 * classification lives with the constraints
 * ({@link file://../constraints.ts edgeWriteNeedsConstraintFence} /
 * `nodeWriteNeedsConstraintFence`), never inline at a call site, so a new
 * constraint kind cannot teach half the write paths about itself.
 *
 * Default `false`: an unconstrained write — a plain create of a `many`-edge, a
 * node whose uniques are all backed by the uniques primary key, a delete —
 * takes no lock and pays no round trip for one.
 */
type WriteTransactionOptions<T> = Readonly<{
  didWrite?: (result: T) => boolean;
  fencesConstraintProbe?: boolean;
}>;

/**
 * Runs a graph-entity mutation cascade inside a single top-level transaction.
 *
 * On a transactional backend the cascade shares one transaction so it commits
 * or rolls back atomically. A nested {@link TransactionBackend} (already inside
 * `store.transaction(...)`) omits `.transaction`, so
 * {@link runOptionallyInTransaction} runs `fn` directly against it rather than
 * opening a nested transaction. A raw Store on a non-transactional backend
 * (Cloudflare D1, `drizzle-orm/neon-http`) also runs `fn` directly and cannot
 * offer atomicity. A schema-managed Store fails closed before `fn` because the
 * backend cannot hold the schema-version fence.
 *
 * The per-graph write lock is taken inside the transaction before any row work
 * (see the module's lock order) when EITHER the store captures — history or
 * revision tracking, whose clocks must serialize — OR the caller declared the
 * body a constrained write via `fencesConstraintProbe`. The two reasons share
 * one lock because they need the same exclusion: on a capture-enabled store a
 * constrained write and a captured write must exclude each other, which two
 * keys could not arrange.
 *
 * On a non-transactional backend this takes no lock at all, exactly as it takes
 * no transaction: such a backend cannot hold either, and the write proceeds
 * unfenced rather than failing — matching the atomicity the same backend
 * already cannot offer.
 */
export function runInWriteTransaction<T>(
  ctx: WriteTransactionContext,
  backend: GraphBackend | TransactionBackend,
  fn: (
    target: GraphBackend | TransactionBackend,
    lock: GraphWriteLock,
  ) => Promise<T>,
  options?: WriteTransactionOptions<T>,
): Promise<T> {
  const ownsWriteLock =
    "transaction" in backend && backend.capabilities.transactions;
  const needsGraphWriteLock =
    ctx.historyEnabled ||
    ctx.revisionTrackingEnabled ||
    options?.fencesConstraintProbe === true;
  return runOptionallyInTransaction(backend, async (target) => {
    await lockSchemaVersionForStoreWrite(ctx, target);
    const session =
      needsGraphWriteLock ? writeTransactionSessions.get(target) : undefined;
    // Either constructor yields the same compile-time evidence token; which one
    // ran says why no acquisition was needed. `uncapturedGraphWriteLock` covers
    // both "this store needs no lock" and "an enclosing frame on this target
    // already holds it" — in the second case the lock is genuinely held, which
    // is a stronger claim than the constructor makes, not a weaker one.
    const acquiresLock =
      needsGraphWriteLock &&
      session?.lock === undefined &&
      !holdsGraphWriteLock(target, ctx.graphId);
    const lock =
      acquiresLock ?
        await lockRecordedGraphWrite(target, ctx.graphId)
      : (session?.lock ?? uncapturedGraphWriteLock());
    if (session !== undefined) session.lock = lock;
    const held = heldGraphWriteLocks.get(target) ?? new Set<string>();
    if (acquiresLock) {
      held.add(ctx.graphId);
      heldGraphWriteLocks.set(target, held);
    }
    const result = await (acquiresLock ?
      fn(target, lock).finally(() => held.delete(ctx.graphId))
    : fn(target, lock));
    if (session !== undefined) {
      session.wrote ||= options?.didWrite?.(result) ?? true;
      return result;
    }
    // History capture advances the same clock when it flushes its recorded
    // after-images. Live stores opt into revisions independently, so advance
    // only there and only after every row/sidecar write succeeded.
    if (
      ctx.revisionTrackingEnabled &&
      !ctx.historyEnabled &&
      (options?.didWrite?.(result) ?? true)
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
  options?: WriteTransactionOptions<T>,
): Promise<T> {
  return ctx.withOperationHooks(opContext, () =>
    runInWriteTransaction(ctx, backend, body, options),
  );
}
