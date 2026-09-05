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
 * Bundled PostgreSQL transaction targets may acquire positions 1 and 2 with
 * one optional strong member; its SQL preserves this same order inside the
 * statement. Every other target retains the two portable acquisitions.
 *
 * Constrained writes (see `fencesConstraintProbe` below) therefore reuse the
 * EXISTING `typegraph:recorded-graph-write` key rather than introducing a
 * sibling namespace. A sibling would be strictly wrong here: it would sit at
 * the same acquire-order position but form a disjoint exclusion set, so a
 * capture-enabled writer holding the recorded key and a constrained writer
 * holding the sibling would not exclude each other — which is precisely the
 * mutual exclusion the constrained write needs.
 *
 * ## Fenced or refused
 *
 * A declared constraint's probe and the write it guards commit under one
 * per-graph mutual exclusion ON EVERY BACKEND. Both halves of the fence are
 * transaction-scoped constructs — SQLite's `BEGIN IMMEDIATE`, PostgreSQL's
 * `pg_advisory_xact_lock` — so a backend with no transactions can supply
 * neither. Such a write is REFUSED
 * ({@link constraintFenceRefusal}, `CONSTRAINT_WRITE_FENCE_UNSUPPORTED`)
 * rather than run unfenced: a constraint enforced only when nothing races is
 * the exact failure the fence exists to close, and reporting it as enforced
 * would make the claim above false wherever it matters most. Unconstrained
 * writes assert nothing and keep working on those backends.
 */
import { statementExecutionMembers } from "../../backend/capabilities/bind";
import { type STATEMENT_EXECUTION } from "../../backend/capabilities/bundle-registry";
import { type BundleVerdictOf } from "../../backend/capabilities/resolve";
import {
  isFirstPartyFactory,
  resolveWriteFencePlan,
} from "../../backend/capabilities/write-fence";
import {
  type GraphBackend,
  runOptionallyInTransaction,
  type TransactionBackend,
} from "../../backend/types";
import {
  ConfigurationError,
  StaleVersionError,
  TransactionConflictError,
} from "../../errors";
import { type SqlSchema } from "../../query/compiler/schema";
import { sql } from "../../query/sql-fragment";
import { asCompiledStatementSql } from "../../query/sql-intent";
import {
  isSerializationFailure,
  isSqliteStaleSnapshotError,
} from "../../utils/sql-errors";
import { type ConstraintFenceReason } from "../constraints";
import {
  advanceRevisionClock,
  lockRecordedGraphWrite,
} from "../recorded-capture";
import {
  acquiredGraphWriteLockFromCombinedFence,
  type GraphWriteLock,
  memoizeAcquiredRecordedGraphWriteLock,
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
  /** Resolved once from the root backend; exact targets are bound separately. */
  statementExecution?: BundleVerdictOf<typeof STATEMENT_EXECUTION>;
}>;

interface WriteTransactionSession {
  lock: GraphWriteLock | undefined;
  wrote: boolean;
}

const writeTransactionSessions = new WeakMap<object, WriteTransactionSession>();

/**
 * Schema fences deliberately do not normally memoize: PostgreSQL releases a
 * lock acquired after a savepoint when a caller rolls back to that savepoint.
 * The one safe exception is a TypeGraph-owned Store transaction whose public
 * surface has no native SQL handle. Its first managed write therefore cannot
 * follow a caller-controlled savepoint; once that write acquires the fence,
 * subsequent managed writes can reuse it until the outer transaction ends.
 *
 * The key includes the expected version rather than only the graph id. A
 * transaction target is also the cache owner, never the root backend, so a
 * pooled connection cannot inherit a prior transaction's success.
 */
const leasedSchemaFences = new WeakMap<object, Map<string, Promise<void>>>();

function schemaFenceLeaseKey(graphId: string, expectedVersion: number): string {
  return `${graphId}\u0000${expectedVersion}`;
}

/** Whether this transaction has already acquired the exact schema fence. */
export function hasLeasedSchemaFence(
  ctx: Pick<WriteTransactionContext, "graphId" | "schemaVersion">,
  target: object,
): boolean {
  const expectedVersion = ctx.schemaVersion;
  return (
    expectedVersion !== undefined &&
    leasedSchemaFences
      .get(target)
      ?.has(schemaFenceLeaseKey(ctx.graphId, expectedVersion)) === true
  );
}

/** Records a schema fence acquired inside a successful fused write statement. */
export function memoizeLeasedSchemaFence(
  ctx: Pick<WriteTransactionContext, "graphId" | "schemaVersion">,
  target: object,
): void {
  const expectedVersion = ctx.schemaVersion;
  const leases = leasedSchemaFences.get(target);
  if (expectedVersion === undefined || leases === undefined) return;
  leases.set(
    schemaFenceLeaseKey(ctx.graphId, expectedVersion),
    Promise.resolve(),
  );
}

/**
 * Marks a TypeGraph-owned transaction as eligible for lazy schema-fence
 * leasing. The first managed write acquires the fence; read-only transactions
 * pay nothing and retain their existing visibility/locking behavior.
 *
 * Custom transaction backends deliberately take the callback unchanged: their
 * savepoint/connection lifetime has not been audited by TypeGraph, so their
 * managed writes retain the conservative per-call fence behavior.
 */
export async function withTransactionSchemaFenceLease<T>(
  ctx: Pick<WriteTransactionContext, "graphId" | "schemaVersion">,
  target: TransactionBackend,
  fn: () => Promise<T>,
): Promise<T> {
  const expectedVersion = ctx.schemaVersion;
  if (expectedVersion === undefined || !isFirstPartyFactory(target)) {
    return fn();
  }

  leasedSchemaFences.set(target, new Map());
  try {
    return await fn();
  } finally {
    leasedSchemaFences.delete(target);
  }
}

/** Forces the enclosing managed Store transaction to consume one revision. */
export function forceWriteTransactionRevision(
  target: TransactionBackend,
): boolean {
  const session = writeTransactionSessions.get(target);
  if (session === undefined) return false;
  session.wrote = true;
  return true;
}

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

function adoptedConstraintWriterSlotError(
  ctx: Pick<WriteTransactionContext, "graphId">,
  cause: unknown,
): ConfigurationError {
  return new ConfigurationError(
    "This constrained write could not take the SQLite writer slot: the adopted transaction was begun DEFERRED and another connection committed after its read snapshot was established.",
    {
      code: "CONSTRAINT_TRANSACTION_NOT_WRITE_FENCED",
      graphId: ctx.graphId,
    },
    {
      cause,
      suggestion:
        "Roll back and re-run the transaction with BEGIN IMMEDIATE, or run the writes through store.transaction(), which acquires the writer slot before any decision-driving read.",
    },
  );
}

/**
 * Makes SQLite's engine-serialized fence true for a transaction TypeGraph did
 * not open. A zero-row write takes the writer slot without changing data; it
 * must run before the schema fence, graph lock, or any constraint probe fixes
 * a read snapshot. Caller-adopted backends do not expose transaction-lifetime
 * identity, so this proof deliberately runs at every constrained write rather
 * than caching connection-scoped evidence across unrelated transactions.
 */
async function ensureAdoptedConstraintWriterSlot(
  ctx: WriteTransactionContext,
  target: GraphBackend | TransactionBackend,
  transactionMode: WriteTransactionMode,
  fenceReason: ConstraintFenceReason | undefined,
): Promise<void> {
  if (
    fenceReason === undefined ||
    transactionMode !== "existing" ||
    writeTransactionSessions.has(target) ||
    resolveWriteFencePlan(target).kind !== "engine-serialized"
  ) {
    return;
  }
  const statementExecution = ctx.statementExecution;
  if (statementExecution?.supported !== true) {
    throw new ConfigurationError(
      "This engine-serialized transaction cannot prove that it holds its writer slot before a constrained write.",
      {
        code: "CONSTRAINT_WRITE_FENCE_UNSUPPORTED",
        graphId: ctx.graphId,
        constraint: fenceReason,
      },
      {
        suggestion:
          "Expose transaction-scoped statement execution, or run the constrained write through a backend transaction TypeGraph opens.",
      },
    );
  }
  const { executeStatement } = statementExecutionMembers(
    target,
    statementExecution,
  );
  try {
    await executeStatement(
      asCompiledStatementSql(
        sql`UPDATE ${ctx.revisionSchema.nodesTable} SET graph_id = graph_id WHERE 0`,
      ),
    );
  } catch (error) {
    if (!isSqliteStaleSnapshotError(error)) throw error;
    throw adoptedConstraintWriterSlotError(ctx, error);
  }
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

  const leases = leasedSchemaFences.get(backend);
  const leaseKey = schemaFenceLeaseKey(ctx.graphId, expectedVersion);
  const existingLease = leases?.get(leaseKey);
  if (existingLease !== undefined) return existingLease;

  const acquisition = lockSchemaVersionForStoreWriteUncached(ctx, backend);
  leases?.set(leaseKey, acquisition);
  try {
    await acquisition;
  } catch (error) {
    if (leases?.get(leaseKey) === acquisition) leases.delete(leaseKey);
    throw error;
  }
}

async function lockSchemaVersionForStoreWriteUncached(
  ctx: Pick<WriteTransactionContext, "graphId" | "schemaVersion">,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  const expectedVersion = ctx.schemaVersion;
  if (expectedVersion === undefined) return;

  if (
    "transaction" in backend &&
    !backend.capabilities.execution.interactiveTransactions
  ) {
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
 * Interprets a no-row result from a schema-fenced INSERT without taking a
 * second schema lock. PostgreSQL's first `FOR SHARE` may wake from a
 * concurrent schema flip with no row in its statement snapshot; taking a
 * second locking read can deadlock with the next flip. The ordinary active
 * schema read observes the settled committed version and is sufficient here:
 * the fused INSERT wrote nothing when its predicate failed.
 *
 * A matching version leaves the caller to diagnose its own ordinary no-row
 * cause (such as an occupied `DO NOTHING` key or a missing edge endpoint).
 */
export async function diagnoseFusedSchemaFenceNoRow(
  ctx: Pick<WriteTransactionContext, "graphId" | "schemaVersion">,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  const expectedVersion = ctx.schemaVersion;
  if (expectedVersion === undefined) return;

  const active = await backend.getActiveSchema(ctx.graphId);
  const actualVersion = active?.version ?? 0;
  if (actualVersion !== expectedVersion) {
    throw new StaleVersionError({
      graphId: ctx.graphId,
      expected: expectedVersion,
      actual: actualVersion,
    });
  }
}

/**
 * How a write states whether it needs the per-graph write fence.
 *
 * `fencesConstraintProbe` is an assertion about THIS write's body: "it runs a
 * check-then-act whose verdict no database key repeats at write time", and it
 * names WHICH declared constraint that is. The classification lives with the
 * constraints ({@link file://../constraints.ts edgeWriteNeedsConstraintFence} /
 * `nodeWriteNeedsConstraintFence`), never inline at a call site, so a new
 * constraint kind cannot teach half the write paths about itself.
 *
 * `undefined` — the default — is an unconstrained write: a plain create of a
 * `many`-edge, a node whose uniques are all backed by the uniques primary key,
 * a delete. It takes no lock and pays no round trip for one.
 */
export type WriteTransactionOptions<T> = Readonly<{
  didWrite?: (result: T) => boolean;
  fencesConstraintProbe?: ConstraintFenceReason | undefined;
  /**
   * The row-work callback's first statement carries the schema fence itself.
   * This is a narrowly-scoped first-party insert optimization: callers must
   * take no graph or identity lock before that statement and must perform the
   * ordinary fence diagnostic before handling a zero-row result.
   */
  schemaFenceInFirstWrite?: boolean | undefined;
}>;

/**
 * The transaction boundary the executor selected for one write frame.
 *
 * Callers consume this decision instead of re-deriving it from a decorated
 * target's members or capability flags. Recorded capture and other backend
 * derivations may deliberately replace members while preserving the boundary
 * the executor opened, so the target object is not an honest second source.
 */
export type WriteTransactionMode = "opened" | "existing" | "none";

function resolveWriteTransactionMode(
  backend: GraphBackend | TransactionBackend,
): WriteTransactionMode {
  if (!("transaction" in backend)) return "existing";
  return backend.capabilities.execution.interactiveTransactions ?
      "opened"
    : "none";
}

/** What a caller must change to make each refused constraint class writable. */
const CONSTRAINT_FENCE_ADVICE = {
  edgeCardinality:
    'declare the edge `cardinality: "many"` and enforce the limit in application code',
  edgeMatchKeyConvergence:
    "use `create` with a caller-chosen id, whose uniqueness the edges primary key enforces, instead of `getOrCreateByEndpoints`",
  nodeDisjointness:
    "drop the `disjointWith` axiom and keep ids distinct across those kinds yourself",
  nodeUniquenessClaim:
    "drop the unique constraint — its reservation row and the node row must commit or roll back together",
  nodeUniquenessScope:
    'scope the unique constraint to `"kind"`, which the uniques primary key enforces on its own',
} as const satisfies Record<ConstraintFenceReason, string>;

/**
 * THE refusal for a constrained write on a backend that cannot hold the fence
 * it needs — one body, one code, one advice map, for both consumers.
 *
 * **The capability test is transaction support, on both dialects, because both
 * fences ARE transaction-scoped constructs.** The lock half: SQLite's fence is
 * the `BEGIN IMMEDIATE` that admits one writer, PostgreSQL's is
 * `pg_advisory_xact_lock`, which by definition is released at the end of the
 * transaction that took it — outside one it is acquired and dropped within its
 * own implicit single-statement transaction and excludes nothing. The claim
 * half: a reservation row issued BEFORE the row it gates is undone only by a
 * rollback, so without a transaction a failed write leaves a live claim that
 * blocks its key with no repair path. Either way "this backend can fence" and
 * "this write runs inside a transaction" are the same question, and it is asked
 * exactly the way {@link lockSchemaVersionForStoreWrite} asks its own:
 * `"transaction" in backend` distinguishes a TOP-LEVEL backend (where
 * `transaction` is a required member) from a nested {@link TransactionBackend}
 * (which omits it and is therefore already inside one, hence already fenced).
 *
 * Refused rather than degraded, per the accepted-or-refused rule: the write
 * declared a constraint the store cannot enforce here, and enforcing it "most
 * of the time" is the failure mode that produced #428 and #436 in the first
 * place. A caller who wants the write anyway can have it by not declaring the
 * constraint — which is what {@link CONSTRAINT_FENCE_ADVICE} says, per class.
 *
 * UNCONSTRAINED writes on the same backend are untouched: they assert nothing
 * the engine has to serialize, so they keep working exactly as before.
 *
 * `ctx` is the one field the body reads, so the claim seam (which holds a node
 * write context) and `importGraphData` (which computes its refusal before it
 * has a write transaction context at all) can call it.
 */
export function constraintFenceRefusal(
  ctx: Readonly<{ graphId: string }>,
  backend: GraphBackend | TransactionBackend,
  reason: ConstraintFenceReason,
): ConfigurationError | undefined {
  if (
    !("transaction" in backend) ||
    backend.capabilities.execution.interactiveTransactions
  ) {
    return undefined;
  }

  return new ConfigurationError(
    "This backend cannot fence a constrained write: enforcing a declared " +
      "constraint requires a transaction — to scope the per-graph write lock " +
      "to, and to commit a reservation row together with the row it gates — " +
      "and this backend has no transactions.",
    {
      code: "CONSTRAINT_WRITE_FENCE_UNSUPPORTED",
      graphId: ctx.graphId,
      constraint: reason,
    },
    {
      suggestion:
        `Use a transactional backend, or ${CONSTRAINT_FENCE_ADVICE[reason]}. ` +
        "Unconstrained writes need no fence and keep working on this backend.",
    },
  );
}

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
 * A constrained write on a backend with no transactions FAILS CLOSED, before
 * `fn`, through {@link constraintFenceRefusal} — that backend can hold
 * no fence, and the invariant this module states is that a declared
 * constraint's probe and the write it guards commit under one per-graph mutual
 * exclusion on every backend. Fenced or refused; never quietly neither.
 * Unconstrained writes on the same backend are unaffected.
 */
export function runInWriteTransaction<T>(
  ctx: WriteTransactionContext,
  backend: GraphBackend | TransactionBackend,
  fn: (
    target: GraphBackend | TransactionBackend,
    lock: GraphWriteLock,
    transactionMode: WriteTransactionMode,
  ) => Promise<T>,
  options?: WriteTransactionOptions<T>,
): Promise<T> {
  const transactionMode = resolveWriteTransactionMode(backend);
  const ownsWriteLock = transactionMode === "opened";
  const fenceReason = options?.fencesConstraintProbe;
  // Rejected rather than thrown: this function is promise-returning, and a
  // synchronous throw from it would surface differently at a caller that
  // composes it without `await` than at one that does.
  const refusal =
    fenceReason === undefined ? undefined : (
      constraintFenceRefusal(ctx, backend, fenceReason)
    );
  if (refusal !== undefined) return Promise.reject(refusal);
  const needsGraphWriteLock =
    ctx.historyEnabled ||
    ctx.revisionTrackingEnabled ||
    fenceReason !== undefined;
  return runOptionallyInTransaction(backend, async (target) => {
    await ensureAdoptedConstraintWriterSlot(
      ctx,
      target,
      transactionMode,
      fenceReason,
    );
    const session =
      needsGraphWriteLock ? writeTransactionSessions.get(target) : undefined;
    // Either constructor yields the same compile-time evidence token; which one
    // ran says why no acquisition was needed. `uncapturedGraphWriteLock` covers
    // both "this store needs no lock" and "an enclosing frame on this target
    // already holds it" — in the second case the lock is genuinely held, which
    // is a stronger claim than the constructor makes, not a weaker one.
    //
    // The claim is registered SYNCHRONOUSLY, before any await: two frames on
    // one target that both reached this point would otherwise each read an
    // absent Set, each mint one, and the second `set` would orphan the first —
    // leaving the first frame's `finally` clearing a Set the map no longer
    // holds, and the graph marked held forever. Reading-and-registering with no
    // suspension point in between makes that interleaving unrepresentable.
    const held = heldGraphWriteLocks.get(target) ?? new Set<string>();
    heldGraphWriteLocks.set(target, held);
    const acquiresLock =
      needsGraphWriteLock &&
      session?.lock === undefined &&
      !held.has(ctx.graphId);
    // Marked before the acquisition rather than after it, for the same reason:
    // a sibling frame that starts while this one is still awaiting the lock
    // must see the claim, not race it. Its statements queue behind ours on the
    // one connection either way, so observing an in-flight claim as held is
    // correct. A failed acquisition retracts the claim.
    if (acquiresLock) held.add(ctx.graphId);
    const expectedSchemaVersion = ctx.schemaVersion;
    const combinedSchemaGraphFence =
      (
        !options?.schemaFenceInFirstWrite &&
        expectedSchemaVersion !== undefined &&
        acquiresLock &&
        !("transaction" in target)
      ) ?
        {
          acquire: target.lockSchemaVersionAndGraphWrite,
          params: {
            graphId: ctx.graphId,
            expectedVersion: expectedSchemaVersion,
          },
        }
      : undefined;
    let lock: GraphWriteLock;
    try {
      if (combinedSchemaGraphFence?.acquire === undefined) {
        if (!options?.schemaFenceInFirstWrite) {
          await lockSchemaVersionForStoreWrite(ctx, target);
        }
        lock =
          acquiresLock ?
            await lockRecordedGraphWrite(target, ctx.graphId)
          : (session?.lock ?? uncapturedGraphWriteLock());
      } else {
        // The optional strong member owns the same canonical order as the two
        // portable calls: schema row first, graph advisory lock second. It is
        // one statement only when THIS frame owes both acquisitions; a held
        // graph lock must never suppress the per-write schema fence.
        const isolation = await combinedSchemaGraphFence.acquire(
          combinedSchemaGraphFence.params,
        );
        memoizeAcquiredRecordedGraphWriteLock(target, ctx.graphId, isolation);
        // The combined statement acquired the real advisory lock, so mint
        // graph/port-bound command coordination only after it returns.
        lock = acquiredGraphWriteLockFromCombinedFence(
          target,
          ctx.graphId,
          isolation,
        );
      }
    } catch (error) {
      if (acquiresLock) held.delete(ctx.graphId);
      throw error;
    }
    if (session !== undefined) session.lock = lock;
    const result = await (acquiresLock ?
      fn(target, lock, transactionMode).finally(() => held.delete(ctx.graphId))
    : fn(target, lock, transactionMode));
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
      didWrite?: (result: T) => boolean,
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
    transactionMode: WriteTransactionMode,
  ) => Promise<T>,
  options?: WriteTransactionOptions<T>,
): Promise<T> {
  return ctx.withOperationHooks(
    opContext,
    () => runInWriteTransaction(ctx, backend, body, options),
    options?.didWrite,
  );
}

/**
 * Milliseconds the backoff schedule starts from once it begins growing (from
 * the third attempt on; see {@link retryBackoffDelayMs}). The sole owner of
 * this number — nothing else in the codebase computes a retry delay.
 */
const RETRY_BACKOFF_BASE_MS = 5;

/** Backoff never waits longer than this, no matter how many attempts failed. */
const RETRY_BACKOFF_CAP_MS = 50;

/**
 * Jitter applied symmetrically around the capped exponential delay, as a
 * fraction of it (0.5 means the delay actually used is anywhere from half to
 * one and a half times the capped value).
 */
const RETRY_BACKOFF_JITTER_RATIO = 0.5;

/**
 * Delay, in milliseconds, before running `attemptNumber` after the previous
 * attempt failed with a retryable conflict. Attempt 2 (run immediately after
 * attempt 1 fails) waits zero: a single lost race deserves an immediate
 * re-open, not a pause. From attempt 3 on, the delay grows exponentially from
 * {@link RETRY_BACKOFF_BASE_MS}, capped at {@link RETRY_BACKOFF_CAP_MS} and
 * jittered by {@link RETRY_BACKOFF_JITTER_RATIO} so that several transactions
 * retrying the same conflict do not all wake up and collide again together.
 */
function retryBackoffDelayMs(attemptNumber: number): number {
  if (attemptNumber <= 2) return 0;
  const exponential = RETRY_BACKOFF_BASE_MS * 2 ** (attemptNumber - 2);
  const capped = Math.min(RETRY_BACKOFF_CAP_MS, exponential);
  const jitterMultiplier =
    1 + (Math.random() * 2 - 1) * RETRY_BACKOFF_JITTER_RATIO;
  return capped * jitterMultiplier;
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * One attempt of a unit of work run by {@link runRetriedUnit}: given a fresh
 * `frame`, performs the work and resolves with its result, or throws/rejects
 * to signal that the attempt did not commit.
 */
export type RetriedUnitAttempt<T> = (
  frame: Readonly<{ attempt: number }>,
) => Promise<T>;

/**
 * Runs `attempt` up to `options.attempts` times, re-running it from the top
 * whenever it fails with a transaction conflict
 * ({@link isSerializationFailure}), and raising a
 * {@link TransactionConflictError} — carrying `options.operation`,
 * `options.attempts`, and the last failure as `cause` — if every attempt is
 * exhausted. A failure `isSerializationFailure` does not recognize propagates
 * unchanged on the attempt that raised it; it is never retried.
 *
 * This is the one retry owner in the codebase: every store-owned unit of work
 * that may be replayed on a transaction conflict runs through this function,
 * never a second, parallel retry loop.
 *
 * ## The replay contract
 *
 * `attempt` receives a fresh `frame` on every call and MUST satisfy:
 *
 * - **Await all of its work** before resolving or rejecting. A retried
 *   attempt that left a fire-and-forget side effect in flight from a
 *   previous, failed attempt could observe — or duplicate — work the caller
 *   never sees fail.
 * - **Use only the supplied `frame`, and values created fresh inside this
 *   call.** A failed attempt's transaction rolled back, so anything it left
 *   behind in memory (a counter, a buffer, an id set) is state no committed
 *   database agrees with; reading it on the next attempt would let a rolled
 *   back attempt leak into a committed one.
 * - **Perform no effect external to its own transaction.** The whole attempt
 *   re-runs on retry, so anything it does outside that transaction (a network
 *   call, a write to a different store) runs again too.
 * - **Tolerate being run up to `attempts` times.** The caller is supplying a
 *   callback willing to be invoked that many times, not exactly once.
 */
export async function runRetriedUnit<T>(
  options: Readonly<{ operation: string; attempts: number }>,
  attempt: RetriedUnitAttempt<T>,
): Promise<T> {
  let lastFailure: unknown;
  for (
    let attemptNumber = 1;
    attemptNumber <= options.attempts;
    attemptNumber += 1
  ) {
    await delay(retryBackoffDelayMs(attemptNumber));
    try {
      return await attempt({ attempt: attemptNumber });
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
      lastFailure = error;
    }
  }
  throw new TransactionConflictError(
    { operation: options.operation, attempts: options.attempts },
    { cause: lastFailure },
  );
}
