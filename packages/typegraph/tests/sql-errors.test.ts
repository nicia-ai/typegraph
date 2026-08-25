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
import { LibsqlError } from "@libsql/client";
import { describe, expect, it } from "vitest";

import { edgeMatchIdentityUniqueIndexName } from "../src/backend/drizzle/ddl";
import {
  edgePrimaryKeyConstraint,
  nodePrimaryKeyConstraint,
} from "../src/backend/drizzle/operations/shared";
import { tables as sqliteTables } from "../src/backend/drizzle/sqlite";
import {
  isDuplicatePrimaryKeyError,
  isDuplicateUniqueIndexError,
  isEdgeMatchIdentityStorageUnavailableError,
  isMissingTableError,
  isNotNullColumnViolation,
  isPostgresConcurrentDdlRaceError,
  isSqliteNotAuthorizedError,
  isSqliteStaleSnapshotError,
} from "../src/utils/sql-errors";

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

describe("isNotNullColumnViolation", () => {
  const edgeId = { table: "typegraph_edges", column: "id" } as const;

  it("matches only the PostgreSQL relation and column that own the sentinel", () => {
    const sentinel = Object.assign(new Error("null value"), {
      code: "23502",
      table: "typegraph_edges",
      column: "id",
    });
    expect(isNotNullColumnViolation(sentinel, edgeId)).toBe(true);
    expect(
      isNotNullColumnViolation(
        Object.assign(new Error("null value"), {
          code: "23502",
          table: "typegraph_nodes",
          column: "id",
        }),
        edgeId,
      ),
    ).toBe(false);
    expect(
      isNotNullColumnViolation(
        Object.assign(new Error("null value"), {
          code: "23502",
          table: "typegraph_edges",
          column: "kind",
        }),
        edgeId,
      ),
    ).toBe(false);
  });

  it("matches wrapped SQLite NOT NULL reports without accepting other failures", () => {
    const sentinel = drizzleQueryError(
      "insert into typegraph_edges",
      Object.assign(
        new Error("NOT NULL constraint failed: typegraph_edges.id"),
        { code: "SQLITE_CONSTRAINT_NOTNULL", rawCode: 1299 },
      ),
    );
    expect(isNotNullColumnViolation(sentinel, edgeId)).toBe(true);
    expect(
      isNotNullColumnViolation(new Error("connection closed"), edgeId),
    ).toBe(false);
  });

  it("matches the code-less cause emitted by the D1 Workers binding", () => {
    const detail = new Error("NOT NULL constraint failed: typegraph_edges.id");
    const d1Error = new Error(`D1_ERROR: ${detail.message}`, { cause: detail });

    expect(isNotNullColumnViolation(d1Error, edgeId)).toBe(true);
    expect(
      isNotNullColumnViolation(
        new Error(
          "D1_ERROR: NOT NULL constraint failed: typegraph_edges.kind",
          {
            cause: new Error(
              "NOT NULL constraint failed: typegraph_edges.kind",
            ),
          },
        ),
        edgeId,
      ),
    ).toBe(false);
  });
});

describe("isPostgresConcurrentDdlRaceError", () => {
  it("detects direct and Drizzle-wrapped SQLSTATE 23505 errors", () => {
    const direct = pgError("duplicate catalog row", "23505");
    expect(isPostgresConcurrentDdlRaceError(direct)).toBe(true);
    expect(
      isPostgresConcurrentDdlRaceError(
        drizzleQueryError(
          "CREATE TABLE IF NOT EXISTS typegraph_kind_removals",
          {
            code: "23505",
            message: "duplicate catalog row",
          },
        ),
      ),
    ).toBe(true);
  });

  it("detects the duplicate-column race an ADD COLUMN IF NOT EXISTS loses", () => {
    // #445: two replicas booting at once run the same additive ALTER; the
    // loser sees 42701, not 23505.
    expect(
      isPostgresConcurrentDdlRaceError(
        pgError('column "claim_token" of relation "m" already exists', "42701"),
      ),
    ).toBe(true);
    expect(
      isPostgresConcurrentDdlRaceError(
        drizzleQueryError(
          'ALTER TABLE "typegraph_index_materializations" ADD COLUMN IF NOT EXISTS "claim_token" text',
          postgresJsLikeError("column already exists", "42701"),
        ),
      ),
    ).toBe(true);
  });

  it("detects the un-coded `tuple concurrently updated` catalog race", () => {
    expect(
      isPostgresConcurrentDdlRaceError(
        pgError("tuple concurrently updated", "XX000"),
      ),
    ).toBe(true);
  });

  it("does not retry an unrelated internal error carrying the same XX000", () => {
    // XX000 is PostgreSQL's catch-all: retrying on the SQLSTATE alone would
    // swallow genuine server faults, so the message must agree.
    expect(
      isPostgresConcurrentDdlRaceError(
        pgError("could not read block 3 in file base/1/2: I/O error", "XX000"),
      ),
    ).toBe(false);
  });

  it("does not classify the race message without its SQLSTATE", () => {
    expect(
      isPostgresConcurrentDdlRaceError(new Error("tuple concurrently updated")),
    ).toBe(false);
  });

  it("does not classify unrelated database failures", () => {
    expect(
      isPostgresConcurrentDdlRaceError(pgError("permission denied", "42501")),
    ).toBe(false);
    expect(
      isPostgresConcurrentDdlRaceError(new Error("SQLITE_CONSTRAINT_UNIQUE")),
    ).toBe(false);
  });
});

describe("isSqliteStaleSnapshotError", () => {
  it("detects the deferred-frame upgrade refusal in both driver spellings", () => {
    // #447: better-sqlite3 reports the symbolic extended code; libSQL over a
    // remote connection reports only the numeric one. The MESSAGE is the same
    // useless "database is locked" in both, which is why neither is matched on.
    expect(
      isSqliteStaleSnapshotError(
        Object.assign(new Error("database is locked"), {
          code: "SQLITE_BUSY_SNAPSHOT",
        }),
      ),
    ).toBe(true);
    expect(
      isSqliteStaleSnapshotError(
        drizzleQueryError("INSERT INTO typegraph_identity_assertions", {
          message: "database is locked",
          rawCode: 517,
        }),
      ),
    ).toBe(true);
  });

  it("does not classify a plain busy timeout or an unrelated lock failure", () => {
    // SQLITE_BUSY says another writer holds the slot right now — a different
    // statement about a different condition, and not attributable to how this
    // transaction was begun.
    expect(
      isSqliteStaleSnapshotError(
        Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
      ),
    ).toBe(false);
    expect(isSqliteStaleSnapshotError(new Error("database is locked"))).toBe(
      false,
    );
    expect(
      isSqliteStaleSnapshotError(pgError("deadlock detected", "40P01")),
    ).toBe(false);
  });
});

describe("isSqliteNotAuthorizedError", () => {
  it("detects native, workerd, and D1 authorization failures", () => {
    expect(
      isSqliteNotAuthorizedError({ code: "SQLITE_AUTH", message: "denied" }),
    ).toBe(true);
    expect(
      isSqliteNotAuthorizedError(
        drizzleQueryError(
          "PRAGMA analysis_limit = 1000",
          new Error("not authorized: SQLITE_AUTH"),
        ),
      ),
    ).toBe(true);
    expect(
      isSqliteNotAuthorizedError(
        new Error("D1_ERROR: not authorized: SQLITE_AUTH"),
      ),
    ).toBe(true);
  });

  it("does not swallow unrelated authorization or SQLite failures", () => {
    expect(
      isSqliteNotAuthorizedError(
        pgError("permission denied for relation foo", "42501"),
      ),
    ).toBe(false);
    expect(
      isSqliteNotAuthorizedError(
        new Error("SQLITE_ERROR: too many SQL variables"),
      ),
    ).toBe(false);
    expect(
      isSqliteNotAuthorizedError(
        new Error("request not authorized by application policy"),
      ),
    ).toBe(false);
  });
});

/**
 * `isDuplicatePrimaryKeyError` decides whether a create lost its id or merely
 * collided on a value (issue #410), so it has to be right about two things at
 * once: every driver's way of REPORTING a duplicate key, and the difference
 * between the relation's PRIMARY KEY and any other unique index on it.
 *
 * These cases carry the driver shapes end-to-end tests cannot reach from this
 * suite — postgres-js's `*_name` field spellings, and a remote libSQL connection
 * that surfaces only the numeric extended result code with no nested
 * `SqliteError` to read a symbolic one from.
 */
/** Mirrors a node-postgres / PGlite `DatabaseError` for a 23505. */
function pgDuplicate(
  constraint: string,
  table: string,
): Error & Readonly<{ code: string }> {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    { code: "23505", constraint, table, schema: "public" },
  );
}

/** Mirrors a postgres-js `PostgresError`: a plain object, `*_name` fields. */
function postgresJsDuplicate(
  constraint: string,
  table: string,
): Readonly<Record<string, string>> {
  return {
    code: "23505",
    message: `duplicate key value violates unique constraint "${constraint}"`,
    constraint_name: constraint,
    table_name: table,
    schema_name: "public",
  };
}

describe("isDuplicatePrimaryKeyError", () => {
  const nodes = nodePrimaryKeyConstraint(sqliteTables.nodes);
  const edges = edgePrimaryKeyConstraint(sqliteTables.edges);

  it("derives both constraint names a PRIMARY KEY can carry", () => {
    // TypeGraph's own DDL emits an unnamed `PRIMARY KEY (...)`, which the server
    // names `<relation>_pkey`; drizzle-kit renders the Drizzle builder's own
    // `<relation>_<column>_..._pk`. Provisioning either way must classify.
    expect(nodes.table).toBe("typegraph_nodes");
    expect([...nodes.constraintNames]).toEqual([
      "typegraph_nodes_pkey",
      "typegraph_nodes_graph_id_kind_id_pk",
    ]);
    expect([...edges.constraintNames]).toEqual([
      "typegraph_edges_pkey",
      "typegraph_edges_graph_id_id_pk",
    ]);
  });

  it("detects a Postgres primary-key duplicate through the Drizzle wrapper", () => {
    for (const name of nodes.constraintNames) {
      expect(
        isDuplicatePrimaryKeyError(
          drizzleQueryError(
            "INSERT INTO typegraph_nodes ...",
            pgDuplicate(name, "typegraph_nodes"),
          ),
          nodes,
        ),
      ).toBe(true);
    }
  });

  it("detects a postgres-js shaped duplicate reached through a plain-object cause", () => {
    expect(
      isDuplicatePrimaryKeyError(
        drizzleQueryError(
          "INSERT INTO typegraph_edges ...",
          postgresJsDuplicate("typegraph_edges_pkey", "typegraph_edges"),
        ),
        edges,
      ),
    ).toBe(true);
  });

  it("does NOT classify a violated unique INDEX on the same relation", () => {
    // Declared uniqueness: same SQLSTATE, same table, the user's index name.
    // Reshaping this into "already exists" would report a value collision as an
    // identity collision.
    expect(
      isDuplicatePrimaryKeyError(
        drizzleQueryError(
          "INSERT INTO typegraph_nodes ...",
          pgDuplicate("person_email_unique_idx", "typegraph_nodes"),
        ),
        nodes,
      ),
    ).toBe(false);
  });

  it("does NOT classify a primary-key duplicate on a DIFFERENT relation", () => {
    expect(
      isDuplicatePrimaryKeyError(
        pgDuplicate("typegraph_node_uniques_pkey", "typegraph_node_uniques"),
        nodes,
      ),
    ).toBe(false);
    // The edges primary key is not the nodes primary key, and vice versa.
    const edgeDuplicate = pgDuplicate(
      "typegraph_edges_pkey",
      "typegraph_edges",
    );
    expect(isDuplicatePrimaryKeyError(edgeDuplicate, nodes)).toBe(false);
    expect(isDuplicatePrimaryKeyError(edgeDuplicate, edges)).toBe(true);
  });

  it("detects SQLite's primary-key extended code, symbolic and numeric", () => {
    // better-sqlite3 (and the SqliteError libSQL nests): symbolic `code`.
    expect(
      isDuplicatePrimaryKeyError(
        drizzleQueryError(
          "INSERT INTO typegraph_nodes ...",
          Object.assign(
            new Error("UNIQUE constraint failed: typegraph_nodes.graph_id"),
            { code: "SQLITE_CONSTRAINT_PRIMARYKEY", rawCode: 1555 },
          ),
        ),
        nodes,
      ),
    ).toBe(true);

    // A remote libSQL HTTP connection surfaces only the generic symbolic code
    // and a code-prefixed message; the SQL-over-HTTP protocol does not carry
    // SQLite's extended result code.
    expect(
      isDuplicatePrimaryKeyError(
        drizzleQueryError(
          "INSERT INTO typegraph_edges ...",
          new LibsqlError(
            "UNIQUE constraint failed: typegraph_edges.graph_id, typegraph_edges.id",
            "SQLITE_CONSTRAINT",
          ),
        ),
        edges,
      ),
    ).toBe(true);
  });

  it("does NOT classify SQLite's non-primary-key unique violation", () => {
    // 2067 is SQLITE_CONSTRAINT_UNIQUE: a unique index, not the primary key.
    expect(
      isDuplicatePrimaryKeyError(
        Object.assign(
          new Error("UNIQUE constraint failed: typegraph_nodes.x"),
          {
            code: "SQLITE_CONSTRAINT_UNIQUE",
            rawCode: 2067,
          },
        ),
        nodes,
      ),
    ).toBe(false);
    expect(
      isDuplicatePrimaryKeyError(
        Object.assign(
          new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed"),
          {
            code: "SQLITE_CONSTRAINT",
            rawCode: 2067,
          },
        ),
        nodes,
      ),
    ).toBe(false);
  });

  it("does not classify unrelated failures", () => {
    expect(
      isDuplicatePrimaryKeyError(
        pgError('relation "typegraph_nodes" does not exist', "42P01"),
        nodes,
      ),
    ).toBe(false);
    expect(
      isDuplicatePrimaryKeyError(new Error("connection reset"), nodes),
    ).toBe(false);
    expect(isDuplicatePrimaryKeyError(undefined, nodes)).toBe(false);
  });
});

describe("isDuplicateUniqueIndexError", () => {
  const identityIndex = {
    table: "typegraph_edges",
    indexName: edgeMatchIdentityUniqueIndexName("typegraph_edges"),
    sqliteColumns: [
      "graph_id",
      "kind",
      "match_identity_name",
      "match_identity_key",
    ],
  } as const;

  it("detects the named PostgreSQL identity arbiter", () => {
    expect(
      isDuplicateUniqueIndexError(
        drizzleQueryError(
          "INSERT INTO typegraph_edges ...",
          pgDuplicate(identityIndex.indexName, identityIndex.table),
        ),
        identityIndex,
      ),
    ).toBe(true);
  });

  it("does not classify a PostgreSQL violation from another relation or index", () => {
    expect(
      isDuplicateUniqueIndexError(
        pgDuplicate(identityIndex.indexName, "other_edges"),
        identityIndex,
      ),
    ).toBe(false);
    expect(
      isDuplicateUniqueIndexError(
        pgDuplicate("other_identity_idx", identityIndex.table),
        identityIndex,
      ),
    ).toBe(false);
  });

  it("detects the SQLite identity arbiter by its ordered columns", () => {
    expect(
      isDuplicateUniqueIndexError(
        Object.assign(
          new Error(
            "UNIQUE constraint failed: typegraph_edges.graph_id, typegraph_edges.kind, typegraph_edges.match_identity_name, typegraph_edges.match_identity_key",
          ),
          { code: "SQLITE_CONSTRAINT_UNIQUE", rawCode: 2067 },
        ),
        identityIndex,
      ),
    ).toBe(true);

    expect(
      isDuplicateUniqueIndexError(
        new LibsqlError(
          "UNIQUE constraint failed: typegraph_edges.graph_id, typegraph_edges.kind, typegraph_edges.match_identity_name, typegraph_edges.match_identity_key",
          "SQLITE_CONSTRAINT",
        ),
        identityIndex,
      ),
    ).toBe(true);
  });

  it("does not classify another SQLite unique index", () => {
    expect(
      isDuplicateUniqueIndexError(
        Object.assign(
          new Error("UNIQUE constraint failed: typegraph_edges.graph_id"),
          { code: "SQLITE_CONSTRAINT_UNIQUE", rawCode: 2067 },
        ),
        identityIndex,
      ),
    ).toBe(false);
  });
});

describe("isEdgeMatchIdentityStorageUnavailableError", () => {
  it("recognizes a missing PostgreSQL conflict arbiter through a wrapper", () => {
    expect(
      isEdgeMatchIdentityStorageUnavailableError(
        drizzleQueryError(
          "INSERT ... ON CONFLICT ...",
          pgError("no unique or exclusion constraint", "42P10"),
        ),
      ),
    ).toBe(true);
  });

  it("recognizes SQLite's missing conflict arbiter", () => {
    expect(
      isEdgeMatchIdentityStorageUnavailableError(
        Object.assign(
          new Error(
            "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint",
          ),
          { code: "SQLITE_ERROR" },
        ),
      ),
    ).toBe(true);
  });

  it("recognizes a cause-less remote libSQL missing conflict arbiter", () => {
    expect(
      isEdgeMatchIdentityStorageUnavailableError(
        new LibsqlError(
          "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint",
          "SQLITE_ERROR",
        ),
      ),
    ).toBe(true);
  });

  it("recognizes PostgreSQL missing durable-identity columns", () => {
    expect(
      isEdgeMatchIdentityStorageUnavailableError(
        Object.assign(new Error('column "match_identity_key" does not exist'), {
          code: "42703",
          column: "match_identity_key",
        }),
      ),
    ).toBe(true);
  });

  it("uses SQLSTATE plus the column token for localized PostgreSQL errors", () => {
    expect(
      isEdgeMatchIdentityStorageUnavailableError(
        Object.assign(new Error("la columna «match_identity_key» no existe"), {
          code: "42703",
        }),
      ),
    ).toBe(true);
  });

  it("does not classify an unrelated PostgreSQL missing column", () => {
    expect(
      isEdgeMatchIdentityStorageUnavailableError(
        Object.assign(new Error('column "props" does not exist'), {
          code: "42703",
          column: "props",
        }),
      ),
    ).toBe(false);
  });

  it("does not classify unrelated SQLite syntax errors", () => {
    expect(
      isEdgeMatchIdentityStorageUnavailableError(
        Object.assign(new Error("near SELECT: syntax error"), {
          code: "SQLITE_ERROR",
        }),
      ),
    ).toBe(false);
  });

  it("recognizes only SQLite's anchored missing-identity-column forms", () => {
    expect(
      isEdgeMatchIdentityStorageUnavailableError(
        Object.assign(new Error("no such column: match_identity_name"), {
          code: "SQLITE_ERROR",
        }),
      ),
    ).toBe(true);
    expect(
      isEdgeMatchIdentityStorageUnavailableError(
        new LibsqlError("no such column: match_identity_key", "SQLITE_ERROR"),
      ),
    ).toBe(true);
    expect(
      isEdgeMatchIdentityStorageUnavailableError(
        Object.assign(
          new Error(
            "UNIQUE constraint failed: typegraph_edges.match_identity_name",
          ),
          { code: "SQLITE_ERROR" },
        ),
      ),
    ).toBe(false);
  });
});
