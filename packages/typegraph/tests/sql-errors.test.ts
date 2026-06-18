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
function drizzleQueryError(query: string, cause: unknown): Error {
  const wrapper = new Error(`Failed query: ${query}\nparams: `);
  (wrapper as { cause?: unknown }).cause = cause;
  return wrapper;
}

/** Mirrors a node-postgres `DatabaseError`: real message + SQLSTATE code. */
function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function postgresJsLikeError(
  message: string,
  code: string,
): Readonly<{ code: string; message: string }> {
  return { code, message };
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

  it("detects a Postgres missing-relation message when a driver omits SQLSTATE", () => {
    expect(
      isMissingTableError(
        new Error('relation "typegraph_recorded_nodes" does not exist'),
      ),
    ).toBe(true);
    expect(
      isMissingTableError({
        message: 'table "typegraph_recorded_nodes" does not exist',
      }),
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

  it("does NOT classify PostgreSQL undefined-column errors as missing tables", () => {
    expect(
      isMissingTableError(
        pgError('column "recorded_to" does not exist', "42703"),
      ),
    ).toBe(false);
    expect(
      isMissingTableError(
        drizzleQueryError(
          'UPDATE "typegraph_recorded_nodes" SET "recorded_to" = $1',
          pgError('column "recorded_to" does not exist', "42703"),
        ),
      ),
    ).toBe(false);
    expect(
      isMissingTableError(new Error('column "recorded_to" does not exist')),
    ).toBe(false);
  });

  it("does NOT classify a Drizzle wrapper's SQL text as a missing table", () => {
    expect(
      isMissingTableError(
        drizzleQueryError(
          "select 'relation \"typegraph_nodes\" does not exist'",
          new Error("driver failure without missing-relation text"),
        ),
      ),
    ).toBe(false);
  });

  it("detects a postgres-js shaped object wrapped in DrizzleQueryError via .cause", () => {
    const wrapped = drizzleQueryError(
      'DELETE FROM "typegraph_recorded_edges"',
      postgresJsLikeError(
        'relation "typegraph_recorded_edges" does not exist',
        "42P01",
      ),
    );
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
    expect(isMissingTableError(new Error("SQLITE_ERROR"))).toBe(true);
    expect(isMissingTableError({ code: "SQLITE_ERROR" })).toBe(true);
    expect(
      isMissingTableError({ code: "SQLITE_ERROR", message: "no such table" }),
    ).toBe(true);
  });

  it("does NOT classify detailed unrelated SQLITE_ERROR failures as missing tables", () => {
    expect(
      isMissingTableError(new Error("SQLITE_ERROR: too many SQL variables")),
    ).toBe(false);
    expect(
      isMissingTableError({
        code: "SQLITE_ERROR",
        message: "too many SQL variables",
      }),
    ).toBe(false);
  });

  it("handles a non-Error value", () => {
    expect(isMissingTableError("no such table: foo")).toBe(true);
    expect(isMissingTableError("connection refused")).toBe(false);
  });

  it("does NOT treat a genuine system fault as a missing table", () => {
    expect(
      isMissingTableError(new Error("connection terminated unexpectedly")),
    ).toBe(false);
    expect(isMissingTableError(new Error("record does not exist"))).toBe(false);
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

  it("does NOT swallow an unrelated plain-object cause whose message merely contains a pattern", () => {
    // A non-driver object deep in a cause chain whose human message happens to
    // contain a missing-table phrase ("... does not exist") but carries no
    // SQLSTATE must NOT be misclassified as a missing table — only the precise
    // SQLSTATE classifies a plain object; the substring patterns are consulted
    // only for Error instances and raw strings.
    expect(
      isMissingTableError(
        drizzleQueryError('insert into "users" ...', {
          message: "validation failed: referenced user does not exist",
        }),
      ),
    ).toBe(false);
    // Same shape with the SQLite phrase — still not a missing table without a
    // driver-level signal.
    expect(
      isMissingTableError({
        message: "the requested resource has no such table of contents",
      }),
    ).toBe(false);
    // But a plain object that DOES carry the SQLSTATE is still detected, so the
    // postgres-js path is unaffected by the narrowing.
    expect(
      isMissingTableError(
        drizzleQueryError('insert into "users" ...', {
          message: "validation failed: referenced user does not exist",
          code: "42P01",
        }),
      ),
    ).toBe(true);
  });

  it("does NOT substring-match a deep Error reached only through a plain-object cause", () => {
    // Error -> plainObject(no SQLSTATE) -> Error("... does not exist"): the
    // cause walk reaches the deepest Error, but its generic "does not exist" (a
    // column error here, not a missing table) must not be substring-classified.
    // PostgreSQL missing tables are classified by SQLSTATE, not by text.
    const deepColumnError = new Error('column "nope" does not exist');
    expect(
      isMissingTableError(
        drizzleQueryError('select "nope" from "users"', {
          message: "driver wrapper",
          cause: deepColumnError,
        }),
      ),
    ).toBe(false);
    // The same shape but with the missing-table SQLSTATE on the deep Error is
    // still detected — SQLSTATE is honored on every link, however deep.
    const deepTableError = Object.assign(
      new Error('relation "users" does not exist'),
      { code: "42P01" },
    );
    expect(
      isMissingTableError(
        drizzleQueryError('select * from "users"', {
          message: "driver wrapper",
          cause: deepTableError,
        }),
      ),
    ).toBe(true);
  });

  it("survives a cyclic cause chain without spinning", () => {
    const a = new Error("connection reset");
    const b = new Error("downstream failure");
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    expect(isMissingTableError(a)).toBe(false);
  });
});
