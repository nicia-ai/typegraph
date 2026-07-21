import { type GraphBackend } from "../../backend/types";
import {
  createRecordedInstant,
  parseRecordedInstant,
  RECORDED_MAX_REVISION,
} from "../../core/temporal";
import { ConfigurationError } from "../../errors";
import { type SqlSchema } from "../../query/compiler/schema";
import type { SqlDialect } from "../../query/dialect/types";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";
import { nowIso } from "../../utils/date";
import { generateId } from "../../utils/id";
import { executeStatement } from "./guards";

type ClockRow = Readonly<{ recorded_at: unknown; revision: unknown }>;
type RecordedClockParts = Readonly<{ recordedAt: string; revision: number }>;
export type AllocatedRecordedCommit = RecordedClockParts &
  Readonly<{ instant: string }>;
type RevisionOriginRow = Readonly<{ origin: unknown }>;

type RecordedClockBackend = Pick<
  GraphBackend,
  "dialect" | "execute" | "executeStatement"
>;

type RevisionOriginBackend = Pick<
  GraphBackend,
  "dialect" | "ensureRevisionOriginsTable" | "execute" | "executeStatement"
>;

/**
 * Floor sentinel used only to seed-and-lock a graph's clock row before the
 * read/advance/write sequence on SQLite-family backends. Always overwritten by
 * the real commit within the same transaction. Revision zero is reserved for
 * this internal row and is never exposed as a valid recorded instant.
 */
const RECORDED_MIN_REVISION = 0;
const RECORDED_MIN_TIME = "1970-01-01T00:00:00.000Z";
const RECORDED_CLOCK_ADVISORY_LOCK_NAMESPACE = "typegraph:recorded-clock";
const RECORDED_GRAPH_WRITE_ADVISORY_LOCK_NAMESPACE =
  "typegraph:recorded-graph-write";

const USES_RECORDED_GRAPH_ADVISORY_LOCK = {
  postgres: true,
  sqlite: false,
} as const satisfies Record<SqlDialect, boolean>;

/**
 * Builds a `pg_advisory_xact_lock` call scoped to a `(namespace, graphId)` pair.
 * Keep lock namespaces tied to acquire order, not to feature names:
 *
 * - recorded graph writes take `typegraph:recorded-graph-write` before any row
 *   reads/writes that can affect graph state;
 * - recorded-clock allocation takes `typegraph:recorded-clock` late, at flush,
 *   after the live writes have already happened.
 *
 * Sharing one key across those two acquire-order positions creates a circular
 * wait under ordinary concurrent load.
 */
function graphAdvisoryLockSql(namespace: string, graphId: string): SqlFragment {
  return sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${namespace}),
      hashtext(${graphId})
    )
  `;
}

export function recordedClockAdvisoryLockSql(graphId: string): SqlFragment {
  return graphAdvisoryLockSql(RECORDED_CLOCK_ADVISORY_LOCK_NAMESPACE, graphId);
}

export function recordedGraphWriteAdvisoryLockSql(
  graphId: string,
): SqlFragment {
  return graphAdvisoryLockSql(
    RECORDED_GRAPH_WRITE_ADVISORY_LOCK_NAMESPACE,
    graphId,
  );
}

declare const GRAPH_WRITE_LOCK_BRAND: unique symbol;

/**
 * Compile-time evidence that the per-graph write-lock discipline was
 * satisfied BEFORE any row work in the current transaction — either the
 * advisory lock was actually acquired ({@link lockRecordedGraphWrite}, on a
 * capture-enabled Postgres store) or the store provably needs no lock
 * ({@link uncapturedGraphWriteLock}). Functions that perform captured row
 * writes (the node write pipeline) require this token as a parameter, so
 * "sidecar write before lock" is a compile error rather than a lock-order
 * inversion found in review.
 */
export type GraphWriteLock = Readonly<{
  [GRAPH_WRITE_LOCK_BRAND]: true;
}>;

// The brand is compile-time only (a `unique symbol` with no runtime value —
// see the `declare const` above), so the token carries no actual per-call
// data and every acquisition can share this one frozen empty instance.
const GRAPH_WRITE_LOCK_EVIDENCE = Object.freeze({}) as GraphWriteLock;

function graphWriteLockEvidence(): GraphWriteLock {
  return GRAPH_WRITE_LOCK_EVIDENCE;
}

/**
 * Evidence constructor for stores WITHOUT history capture, where no
 * advisory lock exists to acquire. Calling this is an explicit claim that
 * the target store is not capture-enabled — do not use it to skip the lock
 * on a history store.
 */
export function uncapturedGraphWriteLock(): GraphWriteLock {
  return graphWriteLockEvidence();
}

/**
 * Per-transaction memo of graphs whose advisory lock is already held.
 *
 * `pg_advisory_xact_lock` is reentrant and held until the top-level
 * transaction ends, so re-acquiring it on every captured write inside one
 * transaction is pure round-trip churn — a multi-write transaction paid one
 * lock round trip per write. The capture layer registers its per-transaction
 * backend here; every lock path that receives that backend (the capture
 * delegate's own writes, `runInWriteTransaction`, provenance) then skips the
 * `SqlFragment` once the graph's lock is held.
 *
 * Keyed weakly by the backend object: the delegate is created per
 * transaction, so memo lifetime equals lock lifetime. NOT savepoint-aware —
 * a manual `SAVEPOINT` rolled back across the first acquisition releases the
 * lock but not the memo entry. That matches the capture session's touch
 * state (also not savepoint-scoped); manual savepoints inside a recorded
 * transaction are outside the capture contract.
 */
/**
 * Single-flight per graph: the memo stores the IN-FLIGHT acquisition
 * promise, not just completed acquisitions, so concurrent same-transaction
 * writers (`Promise.all` over captured writes) coalesce onto one advisory
 * round trip instead of racing past an empty resolved-set. A rejected
 * acquisition evicts its entry so a retry is not poisoned (in practice a
 * failed statement has aborted the Postgres transaction anyway).
 */
export type RecordedGraphLockMemo = Map<string, Promise<void>>;

export function createRecordedGraphLockMemo(): RecordedGraphLockMemo {
  return new Map();
}

const recordedGraphLockMemos = new WeakMap<object, RecordedGraphLockMemo>();

export function registerRecordedGraphLockMemo(
  backend: object,
  memo: RecordedGraphLockMemo,
): void {
  recordedGraphLockMemos.set(backend, memo);
}

async function acquireRecordedGraphWriteLock(
  target: Pick<GraphBackend, "execute">,
  graphId: string,
): Promise<void> {
  await target.execute(
    asCompiledRowsSql(recordedGraphWriteAdvisoryLockSql(graphId)),
  );
}

export async function lockRecordedGraphWrite(
  target: Pick<GraphBackend, "dialect" | "execute">,
  graphId: string,
  memo?: RecordedGraphLockMemo,
): Promise<GraphWriteLock> {
  if (!USES_RECORDED_GRAPH_ADVISORY_LOCK[target.dialect]) {
    return graphWriteLockEvidence();
  }
  const effectiveMemo = memo ?? recordedGraphLockMemos.get(target);
  if (effectiveMemo === undefined) {
    await acquireRecordedGraphWriteLock(target, graphId);
    return graphWriteLockEvidence();
  }
  let pending = effectiveMemo.get(graphId);
  if (pending === undefined) {
    pending = acquireRecordedGraphWriteLock(target, graphId).catch(
      (error: unknown) => {
        effectiveMemo.delete(graphId);
        throw error;
      },
    );
    effectiveMemo.set(graphId, pending);
  }
  await pending;
  return graphWriteLockEvidence();
}

function failInvalidClock(value: unknown, cause?: unknown): never {
  throw new ConfigurationError(
    "Recorded clock row contained an invalid revision or wall time",
    { value },
    {
      cause,
      suggestion:
        "Run migrateLegacyRecordedTime() before using recorded-time tables created by the timestamp-only preview schema.",
    },
  );
}

function recordedClockRevision(value: unknown): number {
  const revision =
    typeof value === "bigint" ? Number(value)
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value)
    : value;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < RECORDED_MIN_REVISION ||
    revision >= RECORDED_MAX_REVISION
  ) {
    return failInvalidClock(value);
  }
  return revision;
}

function recordedClockWallTime(value: unknown): string {
  const date =
    value instanceof Date ? value
    : typeof value === "string" ? new Date(value)
    : undefined;
  if (date === undefined || Number.isNaN(date.getTime())) {
    return failInvalidClock(value);
  }
  return date.toISOString();
}

function recordedClockParts(row: ClockRow): RecordedClockParts | undefined {
  const revision = recordedClockRevision(row.revision);
  if (revision === RECORDED_MIN_REVISION) return undefined;
  return { revision, recordedAt: recordedClockWallTime(row.recorded_at) };
}

function nextRecordedCommitParts(
  previous: RecordedClockParts | undefined,
): RecordedClockParts {
  const wallTime = nowIso();
  if (previous === undefined) {
    return { revision: 1, recordedAt: wallTime };
  }

  return {
    revision: previous.revision + 1,
    // Keep diagonal replay cumulative across backward clock corrections without
    // manufacturing a new millisecond for same-ms commits. Throughput can make
    // this component repeat, never run ahead of the greatest observed wall time.
    recordedAt: nonDecreasingWallTime(wallTime, previous.recordedAt),
  };
}

function nonDecreasingWallTime(current: string, previous: string): string {
  if (current < previous) return previous;
  return current;
}

/**
 * Reads the recorded-time high-water mark for a graph — the latest committed
 * recorded instant. Exported so {@link Store.recordedNow} can hand callers a
 * deterministic `asOfRecorded` anchor. Accepts any read-capable backend or
 * transaction.
 */
export async function readRecordedClock(
  target: Pick<GraphBackend, "execute">,
  schema: SqlSchema,
  graphId: string,
): Promise<string | undefined> {
  const parts = await readRecordedClockParts(target, schema, graphId);
  return parts === undefined ? undefined : (
      createRecordedInstant(parts.revision, parts.recordedAt)
    );
}

async function readRecordedClockParts(
  target: Pick<GraphBackend, "execute">,
  schema: SqlSchema,
  graphId: string,
): Promise<RecordedClockParts | undefined> {
  const rows = await target.execute<ClockRow>(
    asCompiledRowsSql(sql`
      SELECT revision, recorded_at
      FROM ${schema.recordedClockTable}
      WHERE graph_id = ${graphId}
    `),
  );
  const row = rows[0];
  return row === undefined ? undefined : recordedClockParts(row);
}

/**
 * Reads the durable, random origin assigned to one graph's revision clock.
 * The origin namespaces an otherwise graph-local revision anchor, so a
 * branch cannot mistake another store's coincident clock value for its base.
 */
export async function readRevisionOrigin(
  target: Pick<GraphBackend, "execute">,
  schema: SqlSchema,
  graphId: string,
): Promise<string | undefined> {
  const rows = await target.execute<RevisionOriginRow>(
    asCompiledRowsSql(sql`
      SELECT origin
      FROM ${schema.revisionOriginsTable}
      WHERE graph_id = ${graphId}
    `),
  );
  const first = rows[0];
  if (first === undefined) return undefined;
  if (typeof first.origin !== "string" || first.origin.length === 0) {
    throw new ConfigurationError(
      "Revision origin row contained an invalid origin",
      { graphId, origin: first.origin },
    );
  }
  return first.origin;
}

/**
 * Returns a graph's durable revision-origin nonce, creating it exactly once.
 * The unique graph-id row makes concurrent first readers converge on the
 * winner's origin rather than manufacturing incompatible anchors.
 */
export async function ensureRevisionOrigin(
  target: RevisionOriginBackend,
  schema: SqlSchema,
  graphId: string,
): Promise<string> {
  const ensureTable = target.ensureRevisionOriginsTable;
  if (ensureTable === undefined) {
    throw new ConfigurationError(
      "Revision tracking requires a backend that can bootstrap revision origins.",
      { dialect: target.dialect },
      {
        suggestion:
          "Use a built-in SQLite/PostgreSQL backend, or implement ensureRevisionOriginsTable on the custom backend.",
      },
    );
  }
  await ensureTable();
  const existing = await readRevisionOrigin(target, schema, graphId);
  if (existing !== undefined) return existing;

  await executeStatement(
    target,
    sql`
      INSERT INTO ${schema.revisionOriginsTable} (graph_id, origin)
      VALUES (${graphId}, ${generateId()})
      ON CONFLICT (graph_id) DO NOTHING
    `,
  );
  const origin = await readRevisionOrigin(target, schema, graphId);
  if (origin !== undefined) return origin;
  throw new ConfigurationError(
    "Revision origin was not persisted after initialization.",
    { graphId, dialect: target.dialect },
  );
}

async function writeRecordedClock(
  target: RecordedClockBackend,
  schema: SqlSchema,
  graphId: string,
  parts: RecordedClockParts,
): Promise<void> {
  await executeStatement(
    target,
    sql`
      INSERT INTO ${schema.recordedClockTable} (graph_id, revision, recorded_at)
      VALUES (${graphId}, ${parts.revision}, ${parts.recordedAt})
      ON CONFLICT (graph_id) DO UPDATE
      SET revision = ${parts.revision}, recorded_at = ${parts.recordedAt}
    `,
  );
}

async function lockRecordedClock(
  target: RecordedClockBackend,
  schema: SqlSchema,
  graphId: string,
  ownsWriteLock: boolean,
): Promise<void> {
  // Serialize the read/advance/write sequence per graph. Without this,
  // concurrent transactions can read the same previous clock value and
  // allocate the same recorded instant.
  switch (target.dialect) {
    case "postgres": {
      await target.execute(
        asCompiledRowsSql(recordedClockAdvisoryLockSql(graphId)),
      );
      return;
    }
    case "sqlite": {
      // SQLite: the seed-UPSERT exists only to take the clock row's write lock
      // before reading when the enclosing transaction did NOT already hold one.
      // Bundled transactions open BEGIN IMMEDIATE, so the lock is already held.
      if (ownsWriteLock) return;
      await executeStatement(
        target,
        sql`
          INSERT INTO ${schema.recordedClockTable} (graph_id, revision, recorded_at)
          VALUES (${graphId}, ${RECORDED_MIN_REVISION}, ${RECORDED_MIN_TIME})
          ON CONFLICT (graph_id) DO UPDATE SET revision = revision
        `,
      );
      return;
    }
    default: {
      target.dialect satisfies never;
    }
  }
}

export async function allocateRecordedCommit(
  target: RecordedClockBackend,
  schema: SqlSchema,
  graphId: string,
  ownsWriteLock: boolean,
  previousRevision?: string,
): Promise<AllocatedRecordedCommit> {
  await lockRecordedClock(target, schema, graphId, ownsWriteLock);
  const previous =
    previousRevision === undefined ?
      await readRecordedClockParts(target, schema, graphId)
    : parseRecordedInstant(previousRevision, "previous recorded revision");
  const { revision, recordedAt } = nextRecordedCommitParts(previous);
  if (revision >= RECORDED_MAX_REVISION) {
    throw new ConfigurationError(
      `Recorded commit clock reached the open revision sentinel ${RECORDED_MAX_REVISION}`,
      { graphId, revision },
      {
        suggestion:
          "Start a new graph before exhausting the per-graph recorded revision space.",
      },
    );
  }
  const instant = createRecordedInstant(revision, recordedAt);
  await writeRecordedClock(target, schema, graphId, { revision, recordedAt });
  return { instant, revision, recordedAt };
}

/**
 * Advances the durable graph revision after a successful live-store write.
 *
 * Revision tracking deliberately reuses the monotonic per-graph revision already
 * owned by recorded-time capture. The write path holds the graph write lock
 * before this runs. Callers additionally state whether their SQLite
 * transaction owns the write lock so `allocateRecordedCommit` can skip its
 * redundant seed-UPSERT only on bundled `BEGIN IMMEDIATE` paths. It preserves
 * monotonicity independently of wall-clock behavior. History capture calls
 * `allocateRecordedCommit` during its own flush instead, so a captured write
 * remains one revision rather than being advanced twice.
 */
export async function advanceRevisionClock(
  target: RecordedClockBackend,
  schema: SqlSchema,
  graphId: string,
  ownsWriteLock: boolean,
  previousRevision?: string,
): Promise<string> {
  const commit = await allocateRecordedCommit(
    target,
    schema,
    graphId,
    ownsWriteLock,
    previousRevision,
  );
  return commit.instant;
}
