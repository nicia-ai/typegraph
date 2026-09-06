/**
 * `isSerializationFailure` is the single cross-codebase discriminant for "this
 * transaction did not commit and the documented protocol is to re-run it from
 * the top" — a PostgreSQL serialization failure (40001) or deadlock (40P01).
 * Graph-merge's commit retry consults this one predicate; these tests were
 * previously `isRetryableTxConflict`'s (graph-merge-local) and pin the same
 * behavior under its new, shared home.
 */
import { describe, expect, it } from "vitest";

import { isSerializationFailure } from "../src/utils/sql-errors";

/** A pg-driver-shaped error: `code` carries the SQLSTATE. */
function pgError(code: string, message = "tx failed"): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

describe("isSerializationFailure", () => {
  it("detects a serialization failure (40001) by SQLSTATE", () => {
    expect(isSerializationFailure(pgError("40001"))).toBe(true);
  });

  it("detects a deadlock (40P01) by SQLSTATE", () => {
    expect(isSerializationFailure(pgError("40P01"))).toBe(true);
  });

  it("detects a conflict buried in a wrapped cause chain", () => {
    const wrapped = new Error("Merge failed", {
      cause: new Error("drizzle tx", { cause: pgError("40001") }),
    });
    expect(isSerializationFailure(wrapped)).toBe(true);
  });

  it("detects the fixed Postgres message when the SQLSTATE was lost", () => {
    expect(
      isSerializationFailure(
        new Error(
          "could not serialize access due to read/write dependencies among transactions",
        ),
      ),
    ).toBe(true);
    expect(isSerializationFailure(new Error("deadlock detected"))).toBe(true);
  });

  it("rejects non-conflict SQLSTATEs and plain errors", () => {
    expect(isSerializationFailure(pgError("23505"))).toBe(false);
    expect(isSerializationFailure(new Error("cardinality violation"))).toBe(
      false,
    );
    // eslint-disable-next-line unicorn/no-null -- an unknown-typed caller can pass null; the predicate must not throw on it.
    expect(isSerializationFailure(null)).toBe(false);
    expect(isSerializationFailure("40001")).toBe(false);
  });

  it("terminates on a cyclic cause chain", () => {
    const first = new Error("a");
    const second = new Error("b", { cause: first });
    (first as Error & { cause: unknown }).cause = second;
    expect(isSerializationFailure(first)).toBe(false);
  });

  it("does not fall back to the message pattern when a link carries a different code", () => {
    // The message alone would match the deadlock pattern, but 23505 is a
    // real, unrelated classification (unique violation) and must win: a
    // link that carries its own code is never message-matched, regardless
    // of what any other link in the chain carries.
    expect(isSerializationFailure(pgError("23505", "deadlock detected"))).toBe(
      false,
    );
  });

  it("still checks an inner, uncoded link's message when the outer link carries an unrelated code", () => {
    // The outer wrapper (a typed application error, say) carries its own
    // stable `code` — unrelated to SQLSTATE — but that must not suppress
    // the message check on the inner, uncoded driver error that actually
    // carries the evidence.
    const outer = new Error("merge commit failed", {
      cause: new Error("deadlock detected"),
    }) as Error & { code: string };
    outer.code = "GRAPH_MERGE_ERROR";
    expect(isSerializationFailure(outer)).toBe(true);
  });

  it("checks the outer link's own message even when an inner link carries an unrelated code", () => {
    // Symmetric to the previous case: an inner cause carries some other
    // string code (a network error, say), but the outer link is itself
    // uncoded and its own message is the fixed PostgreSQL text.
    const inner = new Error("connection reset") as Error & { code: string };
    inner.code = "ECONNRESET";
    const outer = new Error(
      "could not serialize access due to read/write dependencies among transactions",
      { cause: inner },
    );
    expect(isSerializationFailure(outer)).toBe(true);
  });

  it("suppresses the message fallback chain-wide when any link carries a non-conflict SQLSTATE", () => {
    // A query wrapper whose message quotes a parameter literal such as
    // "deadlock detected" sits above the driver's own unique violation. The
    // engine already classified the failure (23505); the wrapper's text is
    // not evidence, and retrying would turn a unique violation into a
    // conflict.
    const wrapper = new Error(
      "Failed query: insert into notes (body) values ('deadlock detected')",
      {
        cause: pgError(
          "23505",
          "duplicate key value violates unique constraint",
        ),
      },
    );
    expect(isSerializationFailure(wrapper)).toBe(false);
  });

  it("does not let a non-SQLSTATE code suppress the fallback", () => {
    // ECONNRESET and GRAPH_MERGE_ERROR are not engine verdicts, so they
    // neither corroborate nor suppress; only a five-character SQLSTATE does.
    const outer = new Error("merge commit failed", {
      cause: new Error("deadlock detected"),
    }) as Error & { code: string };
    outer.code = "GRAPH_MERGE_ERROR";
    expect(isSerializationFailure(outer)).toBe(true);
  });

  it("does not treat a bare string as message evidence", () => {
    // A bare string can never carry a `code` of its own, so the SQLSTATE
    // pass can never corroborate it; treating it as message evidence would
    // recognize a class of input the SQLSTATE-first design never covers.
    expect(isSerializationFailure("deadlock detected")).toBe(false);
  });
});
