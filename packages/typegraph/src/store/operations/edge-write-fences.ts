/**
 * The write-side half of an edge's identity fence: what a kind-predicated
 * UPDATE means when it matched nothing, and the internal signal that verdict
 * produces.
 *
 * ## Why this is not in `edge-identity.ts`
 *
 * That module is the pure predicate — it compares an expectation against a row
 * and throws, and it imports nothing but the error types. The diagnosis below
 * is a different job: it READS the backend, classifies a
 * `DatabaseOperationError` raised by a write, and re-derives the predicate's
 * verdict against what it finds. Putting it there would give the identity
 * predicate a backend dependency and a write-error dependency it does not have
 * today, on the module every edge read path already imports.
 *
 * ## Why it is caller-applied, not part of the session
 *
 * The store and interchange import interpret a zero-row edge UPDATE
 * DIFFERENTLY, and both readings are deliberate: the store re-reads and either
 * converges on the row that is actually there or refuses with a typed error,
 * while import records a per-row conflict and continues to the next row. A
 * fused write unit owns the row, its fences and its sidecars — not one recovery
 * policy for every caller. So `session.reviseEdge` issues the write and lets
 * the backend's error propagate, and this wrapper is applied by the caller that
 * wants the store's reading of it.
 */
import { type EdgeRow, type GraphReadBackend } from "../../backend/types";
import { DatabaseOperationError, EdgeNotFoundError } from "../../errors";
import {
  assertEdgeIdentityMatches,
  type EdgeIdentityExpectation,
  edgeIdentityFromRow,
} from "./edge-identity";

/**
 * Internal signal: the edge is still there and still this edge, but the
 * validity bound the update asserted no longer holds.
 *
 * Never returned to a caller. The store's converge-and-retry loop is the only
 * code that catches it, and it does so to re-read and re-judge rather than to
 * report anything.
 */
export class EdgeUpdateTargetMoved extends Error {
  constructor(kind: string, id: string) {
    super(
      `The ${kind} edge "${id}" was replaced between this update's read and ` +
        `its write; re-resolving it. This is internal and is never returned ` +
        `to a caller.`,
    );
    this.name = "EdgeUpdateTargetMoved";
  }
}

function isEdgeUpdateNoRowError(
  error: unknown,
): error is DatabaseOperationError {
  return (
    error instanceof DatabaseOperationError &&
    error.details.operation === "update" &&
    error.details.entity === "edge" &&
    error.details.reason === "no_row_returned"
  );
}

/**
 * Reports a kind-predicated edge UPDATE that matched nothing.
 *
 * With the expected kind in the statement's `WHERE`, "no row returned" is no
 * longer only "the row vanished" — it is also "the id now resolves to a
 * different edge" (or "the row was tombstoned", for a non-resurrecting
 * update). Only this failure path pays the extra read, and it re-derives the
 * SAME verdict the pre-write check would have reached, through the same single
 * owner ({@link assertEdgeIdentityMatches}), so the caller cannot tell which of
 * the two raised it.
 *
 * `assertedValidFrom` is the write's own fence, read through
 * `assertsStoredLowerBound` by the caller that stated it — never re-derived
 * here from the params, which this wrapper deliberately never sees.
 */
export async function withUnmatchedEdgeUpdateRefusal(
  graphId: string,
  target: Pick<GraphReadBackend, "getEdge">,
  id: string,
  expected: EdgeIdentityExpectation,
  assertedValidFrom: boolean,
  write: () => Promise<EdgeRow>,
): Promise<EdgeRow> {
  try {
    return await write();
  } catch (error) {
    if (!isEdgeUpdateNoRowError(error)) throw error;
    const current = await target.getEdge(graphId, id);
    if (current !== undefined) {
      assertEdgeIdentityMatches(
        id,
        expected,
        edgeIdentityFromRow(current),
        "update",
      );
      // Identity still matches, so the predicate that stopped matching was the
      // validity bound this update asserted — the row was replaced by an
      // incarnation whose window the verdict never saw. That is not "no such
      // edge", and reporting it as one would be a lie about a row that is
      // sitting right there; it is a stale target, and the caller above
      // converges on the row that is actually present.
      if (assertedValidFrom && current.deleted_at === undefined) {
        throw new EdgeUpdateTargetMoved(expected.kind, id);
      }
    }
    // The row is gone, or still this edge but tombstoned by a concurrent
    // delete (a non-resurrecting UPDATE carries `deleted_at IS NULL`). Either
    // way the edge this update was for no longer exists to update.
    throw new EdgeNotFoundError(expected.kind, id);
  }
}
