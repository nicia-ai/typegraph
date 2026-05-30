/**
 * `isMissingTableError` is the single cross-dialect "relation not
 * bootstrapped yet" discriminant for both the schema bootstrap
 * (`loadActiveSchemaWithBootstrap`) and the durable-marker gate (#135).
 *
 * The regression these tests pin: drizzle-orm (≥ the `DrizzleQueryError`
 * era) wraps query-builder failures so the wrapper's `.message` is the
 * failed SQL text and the real driver error lives on `.cause`. On
 * Postgres that real error carries `relation ... does not exist` /
 * SQLSTATE `42P01`. A helper that reads only the outermost `.message`
 * sees only the SQL string and reports a fresh Postgres database as a
 * hard fault — breaking first boot. The helper must walk the cause chain
 * (and key on the locale-independent SQLSTATE) without ever swallowing a
 * genuine system fault as "missing table".
 */
import { describe, expect, it } from "vitest";

import { isMissingTableError } from "../src/utils/sql-errors";

/**
 * Mirrors drizzle-orm's `DrizzleQueryError`: `.message` is the query
 * text, the driver error is attached on `.cause`.
 */
function drizzleQueryError(query: string, cause: Error): Error {
  const wrapper = new Error(`Failed query: ${query}\nparams: `);
  (wrapper as { cause?: unknown }).cause = cause;
  return wrapper;
}

/** Mirrors a node-postgres `DatabaseError`: real message + SQLSTATE code. */
function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("isMissingTableError", () => {
  it("detects the native SQLite missing-table message", () => {
    expect(
      isMissingTableError(new Error("no such table: typegraph_node_fulltext")),
    ).toBe(true);
  });

  it("detects the native Postgres fast-path error (message + code)", () => {
    expect(
      isMissingTableError(
        pgError('relation "typegraph_node_fulltext" does not exist', "42P01"),
      ),
    ).toBe(true);
  });

  it("detects a Postgres error wrapped in DrizzleQueryError via .cause", () => {
    const wrapped = drizzleQueryError(
      'select * from "typegraph_contribution_materializations"',
      pgError(
        'relation "typegraph_contribution_materializations" does not exist',
        "42P01",
      ),
    );
    // The outermost message is only the SQL text — the missing-table
    // signal is reachable solely through the cause chain.
    expect(wrapped.message).not.toContain("does not exist");
    expect(isMissingTableError(wrapped)).toBe(true);
  });

  it("keys on the SQLSTATE even when the message is non-English", () => {
    const wrapped = drizzleQueryError(
      'select * from "typegraph_node_fulltext"',
      // Localized lc_messages: text no longer contains "does not exist".
      pgError("la relación «typegraph_node_fulltext» no existe", "42P01"),
    );
    expect(isMissingTableError(wrapped)).toBe(true);
  });

  it("detects the D1 / Durable Objects SQLITE_ERROR marker", () => {
    expect(isMissingTableError(new Error("SQLITE_ERROR: no such table"))).toBe(
      true,
    );
  });

  it("handles a non-Error value", () => {
    expect(isMissingTableError("no such table: foo")).toBe(true);
    expect(isMissingTableError("connection refused")).toBe(false);
  });

  it("does NOT treat a genuine system fault as a missing table", () => {
    expect(
      isMissingTableError(new Error("connection terminated unexpectedly")),
    ).toBe(false);
    expect(
      isMissingTableError(
        pgError("permission denied for relation foo", "42501"),
      ),
    ).toBe(false);
    // A connection fault wrapped by Drizzle must still surface as a fault.
    expect(
      isMissingTableError(
        drizzleQueryError(
          "select 1",
          pgError(
            "terminating connection due to administrator command",
            "57P01",
          ),
        ),
      ),
    ).toBe(false);
  });

  it("survives a cyclic cause chain without spinning", () => {
    const a = new Error("connection reset");
    const b = new Error("downstream failure");
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    expect(isMissingTableError(a)).toBe(false);
  });
});
