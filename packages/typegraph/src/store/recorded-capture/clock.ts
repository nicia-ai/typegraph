import { type SQL, sql } from "drizzle-orm";

import { type GraphBackend } from "../../backend/types";
import { RECORDED_MAX } from "../../core/temporal";
import { ConfigurationError } from "../../errors";
import { type SqlSchema } from "../../query/compiler/schema";
import { asCompiledRowsSql } from "../../query/sql-intent";
import { nowIso } from "../../utils/date";
import { generateId } from "../../utils/id";
import { executeStatement } from "./guards";

type ClockRow = Readonly<{ recorded_at: unknown }>;
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
 * the real commit within the same transaction; chosen so every real wall-clock
 * instant sorts after it on both text and timestamp ordering.
 */
const RECORDED_MIN = "1970-01-01T00:00:00.000Z";
const RECORDED_MAX_TIME = new Date(RECORDED_MAX).getTime();
const RECORDED_CLOCK_ADVISORY_LOCK_NAMESPACE = "typegraph:recorded-clock";
const RECORDED_GRAPH_WRITE_ADVISORY_LOCK_NAMESPACE =
  "typegraph:recorded-graph-write";

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
function graphAdvisoryLockSql(namespace: string, graphId: string): SQL {
  return sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${namespace}),
      hashtext(${graphId})
    )
  `;
}

export function recordedClockAdvisoryLockSql(graphId: string): SQL {
  return graphAdvisoryLockSql(RECORDED_CLOCK_ADVISORY_LOCK_NAMESPACE, graphId);
}

export function recordedGraphWriteAdvisoryLockSql(graphId: string): SQL {
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
 * SQL once the graph's lock is held.
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
  if (target.dialect !== "postgres") return graphWriteLockEvidence();
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

function failInvalidClockTimestamp(value: unknown): never {
  throw new ConfigurationError(
    "Recorded clock row contained an invalid timestamp",
    { value },
  );
}

/**
 * A `YYYY-MM-DD[ T]HH:MM:SS[.fff]` timestamp carrying no timezone designator
 * (no trailing `Z` and no `±HH:MM` offset). `new Date()` would parse such a
 * value in the host's *local* zone, so it must be pinned to UTC explicitly.
 */
const ZONELESS_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const OFFSET_DATETIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)$/i;

function normalizeOffsetDesignator(offset: string): string {
  if (offset.toUpperCase() === "Z") return "Z";
  if (/^[+-]\d{2}$/.test(offset)) return `${offset}:00`;
  if (/^[+-]\d{4}$/.test(offset)) {
    return `${offset.slice(0, 3)}:${offset.slice(3)}`;
  }
  return offset;
}

/**
 * Milliseconds since the epoch for a recorded-clock timestamp string. A
 * zoneless timestamp is interpreted as UTC — not the host's local zone — so
 * `recordedNow()` never drifts by the server's offset (or by a DST transition)
 * on a backend whose driver yields a naive timestamp for the recorded columns.
 * Timezone-aware and date-only strings are parsed as-is (already unambiguous).
 */
function clockTimestampMs(value: string): number {
  if (ZONELESS_DATETIME_PATTERN.test(value)) {
    return Date.parse(`${value.replace(" ", "T")}Z`);
  }
  const offsetMatch = OFFSET_DATETIME_PATTERN.exec(value);
  if (offsetMatch) {
    const [, date, time, offset] = offsetMatch;
    return Date.parse(`${date}T${time}${normalizeOffsetDesignator(offset!)}`);
  }
  return Date.parse(value);
}

/**
 * Canonicalizes a recorded-clock value (a driver `Date` or an ISO string) to a
 * canonical UTC ISO string. Both branches guard against an unrepresentable
 * instant: a `Date` whose `getTime()` is `NaN` would otherwise make
 * `toISOString()` throw a bare `RangeError`, masking the typed
 * {@link ConfigurationError} the string branch already raises for an
 * unparseable value. Exported for focused unit coverage of that guard.
 */
export function toCanonicalIso(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return failInvalidClockTimestamp(value);
    return value.toISOString();
  }
  if (typeof value === "string") {
    const timestamp = clockTimestampMs(value);
    if (Number.isNaN(timestamp)) return failInvalidClockTimestamp(value);
    return new Date(timestamp).toISOString();
  }
  return failInvalidClockTimestamp(value);
}

/**
 * The next monotonic recorded-commit instant (ms since epoch) for a graph: the
 * wall clock, or one millisecond past the previous commit when the wall clock
 * has not advanced. Returned as a number so the caller range-checks it against
 * the open sentinel before formatting — one parse in, one format out.
 */
function nextRecordedCommitTime(previous: string | undefined): number {
  // `nowIso()` (not `Date.now()`) so a mocked wall clock still drives capture;
  // `Date.parse` of its canonical-Z string avoids the extra Date allocation +
  // re-parse of `new Date(nowIso()).getTime()` on this per-commit hot path.
  const wallTime = Date.parse(nowIso());
  return previous === undefined ? wallTime : (
      Math.max(wallTime, Date.parse(previous) + 1)
    );
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
  const rows = await target.execute<ClockRow>(
    asCompiledRowsSql(sql`
      SELECT recorded_at
      FROM ${schema.recordedClockTable}
      WHERE graph_id = ${graphId}
    `),
  );
  const first = rows[0];
  return first === undefined ? undefined : toCanonicalIso(first.recorded_at);
}

/**
 * Reads the durable, random origin assigned to one graph's revision clock.
 * The origin namespaces an otherwise timestamp-only revision anchor, so a
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
  recordedAt: string,
): Promise<void> {
  await executeStatement(
    target,
    sql`
      INSERT INTO ${schema.recordedClockTable} (graph_id, recorded_at)
      VALUES (${graphId}, ${recordedAt})
      ON CONFLICT (graph_id) DO UPDATE SET recorded_at = ${recordedAt}
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
  if (target.dialect === "postgres") {
    await target.execute(
      asCompiledRowsSql(recordedClockAdvisoryLockSql(graphId)),
    );
    return;
  }

  // SQLite family: the seed-UPSERT exists only to take the clock row's write
  // lock before reading when the enclosing transaction did NOT already hold one
  // — an adopted external transaction (withRecordedTransaction) may have begun
  // in deferred mode, where two concurrent commits could otherwise both read
  // the same previous value. The bundled transaction paths open BEGIN IMMEDIATE
  // (ownsWriteLock), so the lock is already held and the seed is a redundant
  // write; skip it there. The seeded floor is overwritten by writeRecordedClock
  // in the same transaction when it does run.
  if (ownsWriteLock) return;
  await executeStatement(
    target,
    sql`
      INSERT INTO ${schema.recordedClockTable} (graph_id, recorded_at)
      VALUES (${graphId}, ${RECORDED_MIN})
      ON CONFLICT (graph_id) DO UPDATE SET recorded_at = recorded_at
    `,
  );
}

export async function allocateRecordedCommit(
  target: RecordedClockBackend,
  schema: SqlSchema,
  graphId: string,
  ownsWriteLock: boolean,
  previousRevision?: string,
): Promise<string> {
  await lockRecordedClock(target, schema, graphId, ownsWriteLock);
  const previous =
    previousRevision ?? (await readRecordedClock(target, schema, graphId));
  const recordedCommitTime = nextRecordedCommitTime(previous);
  if (
    !Number.isFinite(recordedCommitTime) ||
    recordedCommitTime >= RECORDED_MAX_TIME
  ) {
    throw new ConfigurationError(
      `Recorded commit clock reached the open sentinel ${RECORDED_MAX}`,
      { graphId, recordedCommitTime },
      {
        suggestion:
          "Use a graph with a normal recorded-time clock; the open sentinel is reserved for relation intervals.",
      },
    );
  }
  const recordedCommit = new Date(recordedCommitTime).toISOString();
  await writeRecordedClock(target, schema, graphId, recordedCommit);
  return recordedCommit;
}

/**
 * Advances the durable graph revision after a successful live-store write.
 *
 * Revision tracking deliberately reuses the monotonic per-graph clock already
 * owned by recorded-time capture. The write path holds the graph write lock
 * before this runs. Callers additionally state whether their SQLite
 * transaction owns the write lock so `allocateRecordedCommit` can skip its
 * redundant seed-UPSERT only on bundled `BEGIN IMMEDIATE` paths. It preserves
 * monotonicity even when wall-clock milliseconds repeat. History capture calls
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
  return allocateRecordedCommit(
    target,
    schema,
    graphId,
    ownsWriteLock,
    previousRevision,
  );
}
