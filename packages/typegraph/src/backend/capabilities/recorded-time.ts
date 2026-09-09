/**
 * The backend's optional engine-native recorded-time capability: an engine
 * that supplies the recorded (system-time) axis itself, rather than through
 * TypeGraph's own capture relations and clock.
 *
 * Declaring this member is what `resolveRecordedTimeOwnership` (sibling
 * `recorded-time-ownership.ts`) reads to derive `"engine-native"` — there is
 * no separate boolean or capability flag to keep in sync with it.
 */
import { ConfigurationError } from "../../errors";
import type { RecordedSourceTable } from "../../query/compiler/schema";
import { type SqlFragment } from "../../query/sql-fragment";
import { type GraphBackend, type TransactionBackend } from "../types";

export type { RecordedSourceTable } from "../../query/compiler/schema";

/**
 * The connection a `source()`/`revisionNow()` read runs on — the same
 * `Pick<TransactionBackend, "execute" | "executeRaw">` shape
 * {@link LineageSession} (`./lineage.ts`) reuses for the identical reason: a
 * root backend and a `transaction()` handle both satisfy it, and
 * `TransactionBackend`'s two members are themselves `Pick<GraphBackend, …>`
 * projections of the same signatures.
 */
export type RecordedTimeSession = Pick<
  TransactionBackend,
  "execute" | "executeRaw"
>;

/**
 * An engine-minted recorded-time revision: an opaque, engine-assigned
 * identifier paired with the ISO-8601 wall time the engine recorded
 * alongside it. Never parsed, ordered, or compared as a number — only ever
 * carried between `revisionNow` and `source`, and (through the engine
 * instant form built from it) compared by `recordedAt`.
 */
export type EngineRecordedRevision = Readonly<{
  /** Opaque engine revision identifier — URL-safe, non-empty, never parsed. */
  revision: string;
  /** ISO-8601 wall time the engine recorded this revision at. */
  recordedAt: string;
}>;

/**
 * The backend's engine-native recorded-time surface. Optional: a backend
 * that omits it is read under TypeGraph's own recorded-relations ownership
 * (see {@link resolveRecordedTimeOwnership} in `./recorded-time-ownership`).
 *
 * `source` names the table expression `table`'s rows are read from AS OF
 * `revision` — the engine's own temporal-table syntax, with the interval
 * already folded in, so it satisfies a recorded read binding's `source`
 * member (`RecordedReadSource`, `src/query/compiler/schema.ts`) with a
 * `predicate` that always returns `undefined`: the engine's `source` already
 * scopes every row to exactly one revision.
 *
 * `revisionNow` reads the engine's current committed revision on `session`
 * — the connection the CALLER's decision is bound to, not one this member
 * opens for itself, exactly as {@link LineageMembers}'s two members require
 * (`./lineage.ts`'s own doc comment states the full rationale: a commit-time
 * caller that already holds an open transaction passes that handle so the
 * read observes the transaction's own snapshot). It is called at most once
 * per transaction — the position TypeGraph's own `flush()` occupies for a
 * capture-owned store — never once per graph.
 */
export type EngineRecordedTimeMembers = Readonly<{
  /**
   * The table expression `table`'s recorded rows read from AS OF `revision`.
   *
   * `table` is never called with `"identityAssertions"` today: a recorded
   * identity read (`Store.identityAtCoordinate` and the query compiler's
   * historical identity traversal) is refused outright under engine-native
   * ownership before any read compiles
   * (`refuseEngineNativeRecordedIdentityRead`), and the recorded read schema
   * this member feeds (`recordedReadSqlSchema`) only ever sources `"nodes"`
   * and `"edges"`. An implementation still must handle the case — the union
   * is shared with the TypeGraph-relation-backed source, which every
   * revision does support — until a later engine-native identity-read seam
   * routes those reads through here instead of refusing them.
   */
  source: (
    this: void,
    table: RecordedSourceTable,
    revision: EngineRecordedRevision,
  ) => SqlFragment;
  /** The engine's current committed recorded-time revision, read on `session`. */
  revisionNow: (
    this: void,
    session: RecordedTimeSession,
  ) => Promise<EngineRecordedRevision>;
}>;

/**
 * THE refusal for a caller that needs the backend's engine-native
 * recorded-time capability and finds it absent, naming the missing member
 * so a caller can add it.
 */
export function requireRecordedTime(
  backend: Pick<GraphBackend, "recordedTime">,
  operation: string,
): EngineRecordedTimeMembers {
  const recordedTime = backend.recordedTime;
  if (recordedTime === undefined) {
    throw new ConfigurationError(
      `${operation} requires the backend's engine-native recordedTime capability, but this backend declares no \`recordedTime\`.`,
      { code: "RECORDED_TIME_UNAVAILABLE", operation },
      {
        suggestion:
          "Implement `recordedTime` on this backend (with a co-declared `lineage`), or use TypeGraph-owned recorded time (`history`/`revisionTracking`) instead.",
      },
    );
  }
  return recordedTime;
}
