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
import {
  batchRefusalDetails,
  batchRefusalSuffix,
  resolveBatchWriteVerdict,
} from "../../backend/capabilities/batch-write-verdict";
import { statementExecutionMembers } from "../../backend/capabilities/bind";
import { type STATEMENT_EXECUTION } from "../../backend/capabilities/bundle-registry";
import { type BundleVerdictOf } from "../../backend/capabilities/resolve";
import {
  isOptimisticRetryTier,
  OPTIMISTIC_RETRY_ATTEMPTS,
  runRetriedUnit,
} from "../../backend/capabilities/retried-unit";
import {
  isFirstPartyFactory,
  resolveWriteFencePlan,
} from "../../backend/capabilities/write-fence";
import { engineSerializedWriterSlotStatement } from "../../backend/sqlite-writer-slot";
import { type GraphBackend } from "../../backend/types";
import {
  CompilerInvariantError,
  ConfigurationError,
  StaleVersionError,
  UnsupportedBackendCapabilityError,
} from "../../errors";
import { type SqlSchema } from "../../query/compiler/schema";
import { sql } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";
import {
  isPostgresFailedTransactionError,
  isSqliteStaleSnapshotError,
} from "../../utils/sql-errors";
import { CONSTRAINT_FENCE_DECIDES_UNDER_LOCK_ONLY } from "../claims/backing";
import { type ConstraintFenceReason } from "../constraints";
import {
  enterOperation,
  openRootTransaction,
  type OperationBackend,
  type OperationEntry,
  operationEntryBackend,
  operationEntrySession,
  type StatementBackend,
  type TransactionSession,
} from "../operation-scope";
import {
  advanceRevisionClock,
  lockRecordedGraphDecision,
  lockRecordedGraphWrite,
  recordedGraphLockMemoOf,
  recordedTransactionControlTarget,
  runRecordedTransactionSavepoint,
} from "../recorded-capture";
import {
  acquiredGraphWriteLockFromCombinedFence,
  acquiringGraphWriteFence,
  type GraphWriteLock,
  memoizeAcquiredRecordedGraphWriteLock,
  uncapturedGraphWriteLock,
} from "../recorded-capture/clock";
import { registerSavepointState } from "../savepoint-state";
import {
  type OperationHookContext,
  type OperationOutcomeFacts,
} from "../types";
import {
  type ManagedWriteState,
  managedWriteState,
  type WriteTransactionFenceEvidence,
  type WriteTransactionSession,
} from "./managed-write-state";

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

/**
 * A failed PostgreSQL statement may doom the managed transaction even if
 * caught: marks the write session of the session `operation` belongs to.
 */
export function markWriteTransactionAborted(
  operation: OperationEntry,
  error: unknown,
): void {
  const session = managedWriteState(operation)?.writeSession;
  if (session !== undefined && session.aborted === undefined)
    session.aborted = { error };
}

/*
 * Schema fences deliberately do not normally memoize: PostgreSQL releases a
 * lock acquired after a savepoint when a caller rolls back to that savepoint.
 * The one safe exception is a TypeGraph-owned Store transaction whose session
 * is `"reusable"` ({@link WriteTransactionFenceEvidence}): its callback holds
 * no raw SQL handle, so its first managed write cannot follow a
 * caller-controlled savepoint, and once that write acquires the fence,
 * subsequent managed writes can reuse it until the outer transaction ends.
 *
 * The leases are the transaction session's (`ManagedWriteState`), read
 * through the operation a write holds, so every operation of the session
 * shares them and no other session over the same transaction does. The key
 * includes the expected version rather than only the graph id, and the root
 * backend has no session, so a pooled connection cannot inherit a prior
 * transaction's success.
 */

function schemaFenceLeaseKey(graphId: string, expectedVersion: number): string {
  return `${graphId}\u0000${expectedVersion}`;
}

/** The schema-fence leases of the session `entry` belongs to, if it holds any. */
function schemaFenceLeases(
  entry: OperationEntry,
): Map<string, Promise<void>> | undefined {
  return managedWriteState(entry)?.schemaFenceLeases;
}

/** Whether this transaction session has already acquired the exact schema fence. */
export function hasLeasedSchemaFence(
  ctx: Pick<WriteTransactionContext, "graphId" | "schemaVersion">,
  entry: OperationEntry,
): boolean {
  const expectedVersion = ctx.schemaVersion;
  return (
    expectedVersion !== undefined &&
    schemaFenceLeases(entry)?.has(
      schemaFenceLeaseKey(ctx.graphId, expectedVersion),
    ) === true
  );
}

/** Records a schema fence acquired inside a successful fused write statement. */
export function memoizeLeasedSchemaFence(
  ctx: Pick<WriteTransactionContext, "graphId" | "schemaVersion">,
  entry: OperationEntry,
): void {
  const expectedVersion = ctx.schemaVersion;
  const leases = schemaFenceLeases(entry);
  if (expectedVersion === undefined || leases === undefined) return;
  leases.set(
    schemaFenceLeaseKey(ctx.graphId, expectedVersion),
    Promise.resolve(),
  );
}

/**
 * Marks a `"reusable"` TypeGraph-owned transaction session as eligible for
 * lazy schema-fence leasing. The first managed write acquires the fence;
 * read-only transactions pay nothing and retain their existing
 * visibility/locking behavior.
 *
 * Custom transaction backends deliberately take the callback unchanged: their
 * savepoint/connection lifetime has not been audited by TypeGraph, so their
 * managed writes retain the conservative per-call fence behavior.
 */
async function withTransactionSchemaFenceLease<T>(
  ctx: Pick<WriteTransactionContext, "graphId" | "schemaVersion">,
  target: OperationBackend,
  state: ManagedWriteState,
  fn: () => Promise<T>,
): Promise<T> {
  const expectedVersion = ctx.schemaVersion;
  if (expectedVersion === undefined || !isFirstPartyFactory(target)) {
    return fn();
  }

  const leases = new Map<string, Promise<void>>();
  state.schemaFenceLeases = leases;
  const unregister = registerSavepointState(target, () => {
    const before = new Map(leases);
    return () => {
      leases.clear();
      for (const [key, lease] of before) leases.set(key, lease);
    };
  });
  try {
    return await fn();
  } finally {
    unregister();
    state.schemaFenceLeases = undefined;
  }
}

/**
 * Leases a schema fence acquired before a caller-owned history callback.
 *
 * The adopted history path acquires its fence before invoking user code, so a
 * savepoint created by that callback cannot predate the lock. That is the one
 * adopted-transaction shape where reusing the lock is savepoint-safe. The
 * lease is the adopted session's: every operation of that session (the
 * capture, witness and execution-lifetime surface its operations hand out,
 * and the raw transaction its opener's operations hold) reads it, and it is
 * removed when the callback and its capture flush finish.
 *
 * This deliberately does not require the first-party factory mark: adopted
 * transaction backends are marked caller-owned even when their root backend
 * came from a bundled factory. The safety proof here is the pre-callback
 * acquisition and the bounded history scope, not backend provenance.
 */
export async function withPreAcquiredTransactionSchemaFenceLease<T>(
  ctx: Pick<WriteTransactionContext, "graphId" | "schemaVersion">,
  session: TransactionSession,
  fn: () => Promise<T>,
): Promise<T> {
  const expectedVersion = ctx.schemaVersion;
  if (expectedVersion === undefined) return fn();

  const state = session.managedWrite;
  const leases = new Map<string, Promise<void>>([
    [schemaFenceLeaseKey(ctx.graphId, expectedVersion), Promise.resolve()],
  ]);
  const previous = state.schemaFenceLeases;
  state.schemaFenceLeases = leases;
  try {
    return await fn();
  } finally {
    if (state.schemaFenceLeases === leases) state.schemaFenceLeases = previous;
  }
}

/** The write session of the session `operation` belongs to, if one runs. */
function writeSessionOf(
  operation: OperationEntry,
): WriteTransactionSession | undefined {
  return managedWriteState(operation)?.writeSession;
}

/** A managed revision is allocated only when its outer callback completes. */
export function hasPendingWriteTransactionRevision(
  operation: OperationEntry,
): boolean {
  return writeSessionOf(operation)?.wrote === true;
}

/** Takes the engine writer slot without changing graph data. */
export async function ensureEngineSerializedWriterSlot(
  entry: OperationEntry,
  schema: SqlSchema,
  statementExecution: Extract<
    BundleVerdictOf<typeof STATEMENT_EXECUTION>,
    { supported: true }
  >,
): Promise<void> {
  const { executeStatement } = statementExecutionMembers(
    recordedTransactionControlTarget(entry),
    statementExecution,
  );
  await executeStatement(
    engineSerializedWriterSlotStatement(schema.nodesTable),
  );
}

/** Forces the enclosing managed Store transaction to consume one revision. */
export function forceWriteTransactionRevision(
  operation: OperationEntry,
): boolean {
  const session = writeSessionOf(operation);
  if (session === undefined) return false;
  session.wrote = true;
  return true;
}

/*
 * Graphs whose per-graph write lock a still-running {@link runInWriteTransaction}
 * frame already holds — or is still acquiring — on a transaction session
 * (`TransactionSession.heldGraphWriteLocks`, carried by the operation each
 * frame runs under), each with the acquisition's own evidence token.
 *
 * `pg_advisory_xact_lock` is reentrant and held to the end of the top-level
 * transaction, so re-acquiring it is pure round-trip churn. Operations compose
 * — a bulk `getOrCreateByEndpoints` calls the create batch and the upsert
 * update against ITS transaction target — and each nested call would otherwise
 * pay a lock round trip the enclosing frame already paid.
 *
 * The entry is the acquisition PROMISE, not a bare marker: a nested or sibling
 * frame that skips the round trip awaits it and works under the very token
 * the acquiring frame minted. That token carries the isolation the lock
 * statement observed on this session, so a decision that must see commits
 * made while the session waited for the fence is judged identically in every
 * frame of the transaction. Handing such a frame an evidence-free token
 * instead would read as "this engine serializes writers" and skip the check.
 *
 * `store.transaction(...)` is covered by {@link WriteTransactionSession}
 * instead; this covers the operation-calls-operation nesting inside a single
 * managed write and sibling frames started before the first acquisition
 * returns. Same caveat as the capture layer's memo in
 * `recorded-capture/clock.ts`: NOT savepoint-aware. A manual `SAVEPOINT` rolled
 * back across the outer acquisition releases the lock but not this entry;
 * manual savepoints inside a managed write are outside the contract.
 *
 * A frame with no transaction (`"none"`) has no session and takes no graph
 * lock: history, revision tracking and every constrained write refuse a
 * backend without transactions before a frame starts.
 */

function noop(): void {
  // Marks a rejection as observed; the acquiring frame reports the error.
}

type GraphWriteLockAcquisition = Readonly<{
  promise: Promise<GraphWriteLock>;
  resolve: (lock: GraphWriteLock) => void;
  reject: (error: unknown) => void;
}>;

/**
 * An acquisition other frames can await before it has started. A failed one
 * is observed here so that it is not an unhandled rejection when no sibling
 * frame happens to be waiting; the acquiring frame rethrows the error itself.
 */
function pendingGraphWriteLockAcquisition(): GraphWriteLockAcquisition {
  let settle: Omit<GraphWriteLockAcquisition, "promise"> | undefined;
  const promise = new Promise<GraphWriteLock>((resolve, reject) => {
    settle = { resolve, reject };
  });
  promise.catch(noop);
  if (settle === undefined) {
    throw new CompilerInvariantError(
      "A promise executor did not run synchronously.",
    );
  }
  return { promise, ...settle };
}

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
  frame: OperationEntry,
  transactionMode: WriteTransactionMode,
  fenceReason: ConstraintFenceReason | undefined,
): Promise<void> {
  const target = operationEntryBackend(frame);
  if (
    fenceReason === undefined ||
    transactionMode !== "existing" ||
    writeSessionOf(frame) !== undefined ||
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
  try {
    await ensureEngineSerializedWriterSlot(
      frame,
      ctx.revisionSchema,
      statementExecution,
    );
  } catch (error) {
    if (!isSqliteStaleSnapshotError(error)) throw error;
    throw adoptedConstraintWriterSlotError(ctx, error);
  }
}

/**
 * Binds nested typed mutations to one caller-owned transaction commit so a
 * multi-operation `store.transaction(...)` advances its durable revision once,
 * and owns every reuse of fence evidence across those mutations:
 * `fenceEvidence` decides both whether the session remembers the per-graph
 * write fence and whether it leases the schema fence.
 *
 * `session` is the transaction session the attempt opened: the write session
 * and the schema-fence leases are its own (`ManagedWriteState`), so every
 * operation entered from it reads them. `target` is what its operations hand
 * the mutations, which the savepoint checkpoint is registered on and whose
 * provenance decides whether the schema fence may be leased. `opener` is the
 * operation of the transaction's opener that this function's own statements
 * (the recovery probe, the revision advance) go through.
 */
export async function withWriteTransactionSession<T>(
  transactionSession: TransactionSession,
  target: OperationBackend,
  opener: OperationBackend,
  ctx: WriteTransactionContext,
  fenceEvidence: WriteTransactionFenceEvidence,
  fn: () => Promise<T>,
): Promise<T> {
  const state = transactionSession.managedWrite;
  const session: WriteTransactionSession = {
    fenceEvidence,
    lock: undefined,
    wrote: false,
  };
  state.writeSession = session;
  const unregister = registerSavepointState(target, () => {
    const { wrote, lock, aborted } = session;
    return () => {
      session.wrote = wrote;
      session.lock = lock;
      if (aborted === undefined) delete session.aborted;
      else session.aborted = aborted;
    };
  });
  try {
    const result = await (fenceEvidence === "reusable" ?
      withTransactionSchemaFenceLease(ctx, target, state, fn)
    : fn());
    if (session.aborted !== undefined) {
      // A caller with tx.sql may have rolled back a native savepoint after
      // catching the error. Check the pinned session itself: 25P02 means the
      // transaction is still doomed, while a successful read proves recovery.
      try {
        await opener.execute(asCompiledRowsSql(sql`SELECT 1`));
      } catch (probeError) {
        if (!isPostgresFailedTransactionError(probeError)) throw probeError;
        throw session.aborted.error;
      }
    }
    if (session.wrote && ctx.revisionTrackingEnabled && !ctx.historyEnabled) {
      await advanceRevisionClock(opener, ctx.revisionSchema, ctx.graphId, true);
    }
    return result;
  } finally {
    unregister();
    state.writeSession = undefined;
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
  entry: OperationEntry,
): Promise<void> {
  const expectedVersion = ctx.schemaVersion;
  if (expectedVersion === undefined) return;

  const backend = operationEntryBackend(entry);
  const leases = schemaFenceLeases(entry);
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
  backend: StatementBackend,
): Promise<void> {
  const expectedVersion = ctx.schemaVersion;
  if (expectedVersion === undefined) return;

  if (resolveWriteTransactionMode(backend) === "none") {
    // Reached from every call site above through many different fuse
    // failures (an ineligible kind, a derived backend an execution-boundary
    // proof does not cover, a provenance mismatch at the actual write
    // receiver) — this gate's own inputs (graph id, schema version) name
    // none of them. It states the plain limitation with no guessed cause;
    // a caller that HAS proven a specific `BatchWriteRefusalReason` (a
    // declared constraint, `store.transaction`, identity, history, a schema
    // commit) reports it through that reason's own enforcing gate instead of
    // this one.
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
  backend: StatementBackend,
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

const FRAME_WRITES_SAVEPOINT = "typegraph_frame_writes";

/**
 * Runs the writes of one managed write frame so that a failure among them
 * leaves the transaction they land in exactly as the frame found it.
 *
 * A frame the store opened (`"opened"`) rolls its own transaction back on a
 * throw, so its writes are a unit already. A frame inside the caller's
 * transaction (`"existing"`) is not: a caller that catches the failure and
 * commits would otherwise keep the statements that ran before it, while the
 * session's revision flag — set only when a frame completes — reports that
 * nothing was written. Such a frame's writes therefore run behind a
 * TypeGraph-owned savepoint ({@link runRecordedTransactionSavepoint}), whose
 * rollback also restores every piece of transaction state registered with
 * `savepoint-state.ts`: capture, receipts, and this module's session.
 *
 * A target with no statement execution has no savepoint to take, and its
 * writes run unguarded: a caught failure keeps what landed before it, as every
 * other write on such a target does. No revision clock can disagree with
 * them there — history and revision tracking both refuse a backend without
 * statement execution at construction. A frame with no transaction
 * (`"none"`) applies statement by statement.
 *
 * Call it AFTER every refusal the frame can reach: reads and judgments belong
 * before it, so a refusal costs no savepoint, and the locks the frame took
 * predate the savepoint and survive its rollback.
 */
export async function runFrameWritesAsUnit<T>(
  ctx: Pick<WriteTransactionContext, "statementExecution">,
  frame: OperationEntry,
  target: Readonly<Pick<OperationBackend, "executeStatement">>,
  transactionMode: WriteTransactionMode,
  writes: () => Promise<T>,
): Promise<T> {
  if (transactionMode !== "existing") return writes();
  const statementExecution = ctx.statementExecution;
  if (statementExecution?.supported !== true) return writes();
  return runRecordedTransactionSavepoint(
    frame,
    target,
    statementExecution,
    FRAME_WRITES_SAVEPOINT,
    async () => ({ action: "release", value: await writes() }),
  );
}

/**
 * THE decision of which boundary a write on a backend runs at: a transaction
 * handle is already inside one (`"existing"`), a root with interactive
 * transactions opens one (`"opened"`, carrying the root that opens it), and
 * any other root has none (`"none"`). {@link resolveWriteTransactionMode}
 * reads its mode and {@link runInWriteEntryTransaction} opens from it, so the
 * boundary a write is judged at and the boundary it runs at are one value.
 */
type WriteTransactionBoundary =
  | Readonly<{ mode: "opened"; root: GraphBackend }>
  | Readonly<{ mode: "existing" }>
  | Readonly<{ mode: "none" }>;

const EXISTING_TRANSACTION_BOUNDARY: WriteTransactionBoundary = {
  mode: "existing",
};
const NO_TRANSACTION_BOUNDARY: WriteTransactionBoundary = { mode: "none" };

/** The one owner of the {@link WriteTransactionBoundary} decision. */
function resolveWriteTransactionBoundary(
  backend: StatementBackend,
): WriteTransactionBoundary {
  if (!("transaction" in backend)) return EXISTING_TRANSACTION_BOUNDARY;
  return backend.capabilities.execution.interactiveTransactions ?
      { mode: "opened", root: backend }
    : NO_TRANSACTION_BOUNDARY;
}

/** The mode of {@link resolveWriteTransactionBoundary}'s decision. */
export function resolveWriteTransactionMode(
  backend: StatementBackend,
): WriteTransactionMode {
  return resolveWriteTransactionBoundary(backend).mode;
}

/** How {@link runInWriteEntryTransaction} runs. */
type WriteEntryTransactionOptions = Readonly<{
  /** Options for the transaction it opens, when it opens one. */
  transaction?: Parameters<GraphBackend["transaction"]>[1];
  /**
   * The boundary the caller already resolved for the entry's backend, so the
   * write runs at the boundary it was judged at; resolved here when absent.
   */
  boundary?: WriteTransactionBoundary;
}>;

/**
 * Runs `fn` in the transaction `entry` is in, opening one when `entry` is a
 * root that can: the place a write opens its own transaction, and so the
 * place its session is opened. `fn` receives the entry its work runs under —
 * the first operation of the new session, `entry` itself when it already
 * belongs to a session, or the root when there is no transaction to open. It
 * opens exactly when the {@link WriteTransactionBoundary} reads `"opened"`.
 *
 * `async`, so every failure — a boundary probe, or a backend whose
 * `transaction()` throws while setting up — rejects the returned promise
 * rather than escaping synchronously.
 */
export async function runInWriteEntryTransaction<T>(
  entry: OperationEntry,
  fn: (frame: OperationEntry) => Promise<T>,
  options?: WriteEntryTransactionOptions,
): Promise<T> {
  const boundary =
    options?.boundary ??
    resolveWriteTransactionBoundary(operationEntryBackend(entry));
  if (boundary.mode !== "opened") return fn(entry);
  return openRootTransaction(
    boundary.root,
    (session) => fn(enterOperation(session)),
    options?.transaction,
  );
}

/**
 * The one refusal for an operation that needs write access inside
 * `store.transaction(fn, { accessMode: "read_only" })`. Callers raise it
 * before the operation issues any statement, so the engine never reports its
 * own read-only error and the caller's transaction stays usable.
 */
export function refuseReadOnlyTransactionWrite(
  operation: string,
  graphId: string,
  suggestion: string,
): never {
  throw new UnsupportedBackendCapabilityError(
    operation,
    "write transaction access",
    { graphId, accessMode: "read_only" },
    suggestion,
  );
}

/**
 * Whether a write about to run through `backend` must be wrapped in
 * {@link runRetriedUnit}: the tier requires it
 * ({@link isOptimisticRetryTier}) AND this write opens its own transaction
 * ({@link resolveWriteTransactionMode} reads `"opened"`). A nested unit
 * running inside an existing transaction (`"existing"`) cannot restart a
 * transaction it does not own or replay reads made before it, so its
 * conflict propagates unchanged to the outermost owner instead; a
 * backend with no transactions at all (`"none"`) has nothing to retry as a
 * unit either.
 *
 * The one predicate every store-owned-unit routing site below consults —
 * `write-executor.ts`'s three plan runners, `runIdentityMutation`, and
 * `rebuildIdentityClosureWithSchemaFence` — so the gate cannot drift between
 * them.
 */
export function requiresOptimisticRetryUnit(
  backend: StatementBackend,
): boolean {
  return (
    isOptimisticRetryTier(backend) &&
    resolveWriteTransactionMode(backend) === "opened"
  );
}

/**
 * Re-exported beside {@link constraintFenceRefusal} — the two live together
 * conceptually even though {@link resolveBatchWriteVerdict}'s implementation
 * sits in a leaf module (`backend/capabilities/batch-write-verdict.ts`) so
 * that `recorded-capture/guards.ts`, which this module itself imports
 * through the `recorded-capture` barrel, can import it without a cycle.
 * `BatchWriteRefusalReason` / `BatchWriteVerdict` are not re-exported here:
 * every current caller consumes them structurally through
 * `resolveBatchWriteVerdict`'s return type, with no call site importing
 * either type by name.
 */
export {
  batchRefusalDetails,
  batchRefusalSuffix,
  resolveBatchWriteVerdict,
} from "../../backend/capabilities/batch-write-verdict";

/** What a caller must change to make each refused constraint class writable. */
const CONSTRAINT_FENCE_ADVICE = {
  edgeAcyclicity:
    "drop `acyclic: true` from the edge and detect cycles in application code",
  edgeCardinality:
    'declare the edge `cardinality: "many"` and enforce the limit in application code',
  edgeComposition:
    "drop the `partOf`/`hasPart` declaration realized by this edge kind and enforce the single-whole rule in application code",
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
  backend: StatementBackend,
  reason: ConstraintFenceReason,
): ConfigurationError | undefined {
  if (resolveWriteTransactionMode(backend) !== "none") return undefined;

  const verdict = resolveBatchWriteVerdict(backend, {
    needs: "constraint-needs-probe",
  });

  return new ConfigurationError(
    "This backend cannot fence a constrained write: enforcing a declared " +
      "constraint requires a transaction — to scope the per-graph write lock " +
      "to, and to commit a reservation row together with the row it gates — " +
      "and this backend has no transactions." +
      batchRefusalSuffix(verdict),
    {
      code: "CONSTRAINT_WRITE_FENCE_UNSUPPORTED",
      graphId: ctx.graphId,
      constraint: reason,
      ...batchRefusalDetails(verdict),
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
 *
 * Under the `"optimistic-retry"` tier ({@link requiresOptimisticRetryUnit}),
 * the WHOLE attempt below — opening the transaction, taking every lock, and
 * calling `fn` — runs through {@link runRetriedUnit}: `backend`'s `row`-
 * mechanism write fence lets two acquirers of one fence row both proceed, so
 * the loser's COMMIT fails and correctness comes from replaying the entire
 * unit, never from waiting. This is the ONE place that routes every store-
 * owned unit built on this function — both `write-executor.ts` plan
 * runners, `runIdentityMutation`, and `rebuildIdentityClosureWithSchemaFence`
 * — through the retry owner, so none of those callers re-spells the gate or
 * the wrapping. A nested unit (`transactionMode === "existing"`) never
 * retries here regardless of the tier: it cannot restart a transaction it
 * does not own, so its conflict propagates to the outermost owner. Under
 * `"interactive"` a unit takes one attempt unless it is one this store owns
 * AND its graph-write fence can refuse a stale snapshot
 * ({@link ownsSnapshotFencedUnit}); that unit is replayed through the same
 * owner, with the same budget.
 */
export function runInWriteTransaction<T>(
  ctx: WriteTransactionContext,
  entry: OperationEntry,
  fn: WriteFrame<T>,
  options?: WriteTransactionOptions<T>,
): Promise<T> {
  const backend = operationEntryBackend(entry);
  const boundary = resolveWriteTransactionBoundary(backend);
  const fenceReason = options?.fencesConstraintProbe;
  // Rejected rather than thrown: this function is promise-returning, and a
  // synchronous throw from it would surface differently at a caller that
  // composes it without `await` than at one that does.
  const refusal =
    fenceReason === undefined ? undefined : (
      constraintFenceRefusal(ctx, backend, fenceReason)
    );
  if (refusal !== undefined) return Promise.reject(refusal);

  return runMaybeRetried(
    backend,
    "runInWriteTransaction",
    () =>
      requiresOptimisticRetryUnit(backend) ||
      ownsSnapshotFencedUnit(backend, fenceReason),
    () => runInWriteTransactionAttempt(ctx, entry, fn, options, boundary),
  );
}

/**
 * The body of one managed write frame: the target its statements go through,
 * the graph write lock it works under, the boundary it runs at, and the entry
 * it runs under — the operation (or root) a write the frame composes is
 * handed, so that write joins this frame's session instead of opening its own.
 */
export type WriteFrame<T> = (
  target: StatementBackend,
  lock: GraphWriteLock,
  transactionMode: WriteTransactionMode,
  frame: OperationEntry,
) => Promise<T>;

/**
 * Whether every ordinary write of this store takes the per-graph write fence:
 * the store captures (TypeGraph-owned history or revision tracking, whose
 * clocks must serialize). THE one owner of that decision, shared by the write
 * pipeline ({@link writeNeedsGraphWriteFence}) and by every caller whose
 * guarantee rests on writers serializing behind the fence
 * (`tx.assertUnchangedSince()`).
 */
export function storeWritersTakeGraphWriteFence(
  ctx: Pick<
    WriteTransactionContext,
    "historyEnabled" | "revisionTrackingEnabled"
  >,
): boolean {
  return ctx.historyEnabled || ctx.revisionTrackingEnabled;
}

/**
 * Whether this store needs the per-graph write fence for a write: every write
 * of this store takes it ({@link storeWritersTakeGraphWriteFence}), or the
 * write declared a constraint only the fence protects.
 */
function writeNeedsGraphWriteFence(
  ctx: WriteTransactionContext,
  fenceReason: ConstraintFenceReason | undefined,
): boolean {
  return storeWritersTakeGraphWriteFence(ctx) || fenceReason !== undefined;
}

/**
 * Whether a write names a constraint whose verdict only the per-graph write
 * fence protects ({@link CONSTRAINT_FENCE_DECIDES_UNDER_LOCK_ONLY}): its
 * frame takes the fence in its deciding form, which advances the graph's
 * fence row. A frame that names any other reason, or none, leaves the row
 * alone; if it reaches such a decision after all, the decision site advances
 * the row itself (`fenceLockOnlyDecision`).
 */
function writeDecidesUnderLockOnly(
  fenceReason: ConstraintFenceReason | undefined,
): boolean {
  return (
    fenceReason !== undefined &&
    CONSTRAINT_FENCE_DECIDES_UNDER_LOCK_ONLY[fenceReason]
  );
}

/**
 * Whether a transaction the store opens on `backend` takes its per-graph
 * write fence as a keyed acquisition (`lock` or `row`) — the one whose
 * deciding form advances the graph's fence row, and therefore fails a session
 * whose snapshot predates another decider's commit. A nested unit
 * (`"existing"`) is the caller's transaction, and a serialized engine takes
 * no keyed acquisition; neither answers `true`.
 *
 * THE one decision of "can the fence refuse a transaction the store opened
 * for a stale snapshot", shared by every store-owned transaction that replays
 * on it: {@link runInWriteTransaction} and
 * {@link runOwnedMutationSetTransaction}.
 */
function opensKeyedFenceTransaction(backend: StatementBackend): boolean {
  if (resolveWriteTransactionMode(backend) !== "opened") return false;
  const plan = resolveWriteFencePlan(backend);
  return plan.kind === "lock" || plan.kind === "row";
}

/**
 * Whether this write is a unit the store OWNS whose graph-write fence can
 * refuse it for a stale snapshot: it names a constraint — so it can reach a
 * decision that advances the fence row, in its own frame or at the decision
 * site — in a transaction the store opened itself, on a keyed fence
 * ({@link opensKeyedFenceTransaction}). Such a unit is replayed whole by
 * {@link runRetriedUnit}, exactly as an `"optimistic-retry"` unit is: the
 * replay opens a new transaction and with it a snapshot that includes the
 * winner.
 *
 * An unconstrained write decides nothing under the fence, never advances the
 * fence row and so is never refused there: it takes one attempt, as it always
 * has. A nested unit is the caller's transaction: it cannot be restarted from
 * here, so the refusal propagates to whoever owns it.
 */
function ownsSnapshotFencedUnit(
  backend: StatementBackend,
  fenceReason: ConstraintFenceReason | undefined,
): boolean {
  return fenceReason !== undefined && opensKeyedFenceTransaction(backend);
}

/**
 * The transaction a collection opens around a resolved mutation set — a bulk
 * upsert's or bulk replace's prefetch and the writes it elects, or a bulk
 * get-or-create's legs, on one target.
 *
 * The writes inside are nested units of {@link runInWriteTransaction}: each
 * runs in THIS transaction and cannot restart it, so a stale-snapshot refusal
 * of a lock-only decision one of them makes under the per-graph write fence
 * would otherwise surface from a transaction the caller never opened. The store owns it, so the store replays it — the whole
 * callback, prefetch included, through the same {@link runRetriedUnit} owner
 * and budget as every other store-owned unit. A caller's own transaction, a
 * serialized engine and a backend without transactions run `fn` once, as
 * {@link runOptionallyInTransaction} always has.
 */
export function runOwnedMutationSetTransaction<T>(
  entry: OperationEntry,
  fn: (frame: OperationEntry) => Promise<T>,
): Promise<T> {
  const backend = operationEntryBackend(entry);
  return runMaybeRetried(
    backend,
    "runOwnedMutationSetTransaction",
    () => opensKeyedFenceTransaction(backend),
    () => runInWriteEntryTransaction(entry, fn),
  );
}

/**
 * Runs a store-owned unit's `attempt` once, or replays it whole through
 * {@link runRetriedUnit} when `replays` says the unit is one the store
 * retries. The decision is taken before the first attempt and, like a
 * refusal, surfaces as a rejection rather than a synchronous throw: a caller
 * that composes a promise-returning unit without `await` must see every
 * failure the same way.
 */
function runMaybeRetried<T>(
  backend: StatementBackend,
  operation: string,
  replays: () => boolean,
  attempt: () => Promise<T>,
): Promise<T> {
  let replayed: boolean;
  try {
    replayed = replays();
  } catch (error) {
    return Promise.reject(asRejection(error));
  }
  if (!replayed) return attempt();
  return runRetriedUnit(
    { operation, attempts: OPTIMISTIC_RETRY_ATTEMPTS, target: backend },
    attempt,
  );
}

/** A thrown value, as the `Error` a promise-returning function rejects with. */
function asRejection(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * One attempt of {@link runInWriteTransaction}: everything that function did
 * as one body before the `"optimistic-retry"` tier existed, unchanged.
 * Called once directly under `"interactive"`, or once per attempt
 * {@link runRetriedUnit} makes under `"optimistic-retry"` — every value
 * below (`held`, `combinedSchemaGraphFence`, `lock`) is built fresh on each
 * call, so a rolled-back attempt leaves nothing for the next one to read.
 */
function runInWriteTransactionAttempt<T>(
  ctx: WriteTransactionContext,
  entry: OperationEntry,
  fn: WriteFrame<T>,
  options: WriteTransactionOptions<T> | undefined,
  boundary: WriteTransactionBoundary,
): Promise<T> {
  const transactionMode = boundary.mode;
  const ownsWriteLock = transactionMode === "opened";
  const fenceReason = options?.fencesConstraintProbe;
  const needsGraphWriteLock = writeNeedsGraphWriteFence(ctx, fenceReason);
  const decidesUnderLockOnly = writeDecidesUnderLockOnly(fenceReason);
  return runInWriteEntryTransaction(
    entry,
    async (frame: OperationEntry): Promise<T> => {
      const target = operationEntryBackend(frame);
      await ensureAdoptedConstraintWriterSlot(
        ctx,
        frame,
        transactionMode,
        fenceReason,
      );
      // The write session of this frame's own transaction session: the
      // `store.transaction` attempt's, when the frame runs in one.
      const session = needsGraphWriteLock ? writeSessionOf(frame) : undefined;
      // A frame that does not acquire works under the token of whichever frame
      // did: the transaction session's, or the acquisition an enclosing or
      // sibling frame on this frame's session registered. `uncapturedGraphWriteLock` is
      // left for the one case with nothing to hold — this store needs no lock.
      //
      // The claim is registered SYNCHRONOUSLY, before any await: two frames on
      // one target that both reached this point would otherwise each read an
      // absent Set, each mint one, and the second `set` would orphan the first —
      // leaving the first frame's `finally` clearing a Set the map no longer
      // holds, and the graph marked held forever. Reading-and-registering with no
      // suspension point in between makes that interleaving unrepresentable.
      const held = operationEntrySession(frame)?.heldGraphWriteLocks;
      const heldLock = needsGraphWriteLock ? held?.get(ctx.graphId) : undefined;
      const acquiresLock =
        needsGraphWriteLock &&
        session?.lock === undefined &&
        heldLock === undefined;
      // Registered before the acquisition rather than after it, for the same
      // reason: a sibling frame that starts while this one is still awaiting the
      // lock must see the claim, not race it. Its statements queue behind ours on
      // the one connection either way, and it awaits this acquisition for its
      // token. A failed acquisition retracts the claim.
      const acquisition =
        acquiresLock ? pendingGraphWriteLockAcquisition() : undefined;
      if (acquisition !== undefined)
        held?.set(ctx.graphId, acquisition.promise);
      const expectedSchemaVersion = ctx.schemaVersion;
      const combinedSchemaGraphFence =
        (
          !options?.schemaFenceInFirstWrite &&
          expectedSchemaVersion !== undefined &&
          acquiresLock &&
          !("transaction" in target) &&
          !hasLeasedSchemaFence(ctx, frame)
        ) ?
          {
            acquire: target.lockSchemaVersionAndGraphWrite,
            params: {
              graphId: ctx.graphId,
              expectedVersion: expectedSchemaVersion,
              fenceRow: decidesUnderLockOnly ? "advance" : "leave",
            } as const,
          }
        : undefined;
      let lock: GraphWriteLock;
      try {
        if (combinedSchemaGraphFence?.acquire === undefined) {
          if (!options?.schemaFenceInFirstWrite) {
            await lockSchemaVersionForStoreWrite(ctx, frame);
          }
          if (!acquiresLock) {
            const heldEvidence =
              session?.lock ?? (await heldLock) ?? uncapturedGraphWriteLock();
            // A frame that decides under evidence of the exclusion alone — a
            // session or sibling that took the fence for a write that decided
            // nothing — advances the fence row behind the lock it works under.
            lock =
              decidesUnderLockOnly ?
                await lockRecordedGraphDecision(
                  target,
                  ctx.graphId,
                  heldEvidence,
                  recordedGraphLockMemoOf(frame),
                )
              : heldEvidence;
          } else if (decidesUnderLockOnly) {
            lock = await lockRecordedGraphDecision(
              target,
              ctx.graphId,
              undefined,
              recordedGraphLockMemoOf(frame),
            );
          } else {
            lock = await lockRecordedGraphWrite(
              target,
              ctx.graphId,
              recordedGraphLockMemoOf(frame),
            );
          }
        } else {
          // The optional strong member owns the same canonical order as the two
          // portable calls: schema row first, graph advisory lock second. It is
          // one statement only when THIS frame owes both acquisitions; a held
          // graph lock must never suppress the per-write schema fence.
          const acquireCombinedFence = combinedSchemaGraphFence.acquire;
          const fenceParams = combinedSchemaGraphFence.params;
          const fenceAcquisition = await acquiringGraphWriteFence(target, () =>
            acquireCombinedFence(fenceParams),
          );
          memoizeAcquiredRecordedGraphWriteLock(
            target.commands,
            recordedGraphLockMemoOf(frame),
            ctx.graphId,
            fenceAcquisition,
          );
          // The combined statement acquired the real advisory lock, so mint
          // graph/port-bound command coordination only after it returns.
          lock = acquiredGraphWriteLockFromCombinedFence(
            target,
            ctx.graphId,
            fenceAcquisition,
            recordedGraphLockMemoOf(frame),
          );
        }
      } catch (error) {
        if (acquisition !== undefined) {
          held?.delete(ctx.graphId);
          acquisition.reject(error);
        }
        throw error;
      }
      acquisition?.resolve(lock);
      if (session?.fenceEvidence === "reusable") session.lock = lock;
      const result = await (acquiresLock ?
        fn(target, lock, transactionMode, frame).finally(() =>
          held?.delete(ctx.graphId),
        )
      : fn(target, lock, transactionMode, frame));
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
    },
    { boundary },
  );
}

/**
 * Takes a managed write's fences on a transaction the caller already holds,
 * and writes nothing: the schema-version fence, then the per-graph write lock,
 * exactly as the frame of a real write takes them. It IS such a frame, with an
 * empty body that reports `didWrite: false` — so the acquisition order, the
 * schema-fence lease, the session's remembered lock and the combined
 * schema-and-graph statement all have the one owner they have for a write,
 * and the frame allocates no revision.
 *
 * For a caller whose own reads must be serialized against graph writes before
 * its first write, or with no write at all. The frame takes the graph lock
 * only where this store's writes need it, and hands back evidence of no keyed
 * fence otherwise — a serialized engine, or a store whose history the engine
 * owns. The caller's reads need the exclusion either way, so in that case the
 * lock is taken here, behind the schema fence the frame has just taken; on a
 * serialized engine that is no statement.
 */
export function acquireManagedWriteFences(
  ctx: WriteTransactionContext,
  entry: OperationEntry,
): Promise<void> {
  return runInWriteTransaction(
    ctx,
    entry,
    async (target, lock, _transactionMode, frame) => {
      if (lock.coordination !== undefined) return;
      await lockRecordedGraphWrite(
        target,
        ctx.graphId,
        recordedGraphLockMemoOf(frame),
      );
    },
    { didWrite: () => false },
  );
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
      operationFacts?: (result: T) => OperationOutcomeFacts | undefined,
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
  entry: OperationEntry,
  body: WriteFrame<T>,
  options?: WriteTransactionOptions<T>,
  operationFacts?: (result: T) => OperationOutcomeFacts | undefined,
): Promise<T> {
  return ctx.withOperationHooks(
    opContext,
    () => runInWriteTransaction(ctx, entry, body, options),
    options?.didWrite,
    operationFacts,
  );
}
