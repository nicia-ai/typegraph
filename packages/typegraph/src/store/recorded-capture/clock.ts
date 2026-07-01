import { type SQL, sql } from "drizzle-orm";

import {
  type GraphBackend,
  type TransactionBackend,
} from "../../backend/types";
import { RECORDED_MAX } from "../../core/temporal";
import { ConfigurationError } from "../../errors";
import { type SqlSchema } from "../../query/compiler/schema";
import { asCompiledRowsSql } from "../../query/sql-intent";
import { nowIso } from "../../utils/date";
import { executeStatement } from "./guards";

type ClockRow = Readonly<{ recorded_at: unknown }>;

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
export function graphAdvisoryLockSql(namespace: string, graphId: string): SQL {
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

export async function lockRecordedGraphWrite(
  target: Pick<TransactionBackend, "dialect" | "execute">,
  graphId: string,
): Promise<void> {
  if (target.dialect !== "postgres") return;
  await target.execute(
    asCompiledRowsSql(recordedGraphWriteAdvisoryLockSql(graphId)),
  );
}

export async function lockRecordedGraphWrites(
  target: Pick<TransactionBackend, "dialect" | "execute">,
  graphIds: Iterable<string>,
): Promise<void> {
  if (target.dialect !== "postgres") return;
  const uniqueGraphIds = [...new Set(graphIds)].toSorted((left, right) =>
    left.localeCompare(right),
  );
  for (const graphId of uniqueGraphIds) {
    await lockRecordedGraphWrite(target, graphId);
  }
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

async function writeRecordedClock(
  target: TransactionBackend,
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
  target: TransactionBackend,
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
  target: TransactionBackend,
  schema: SqlSchema,
  graphId: string,
  ownsWriteLock: boolean,
): Promise<string> {
  await lockRecordedClock(target, schema, graphId, ownsWriteLock);
  const previous = await readRecordedClock(target, schema, graphId);
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
