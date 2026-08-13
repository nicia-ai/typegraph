/**
 * T2/T2b golden capture (F17) — the zero-behavior-change proof for §4.1's
 * planned severance of `claimOwnerMatchesSql` (currently
 * `src/store/claims/axis.ts`) and §4.1b's planned move of the three removal
 * builders. Captured HERE, in B1, before either edit exists, so the
 * snapshot's provenance predates every future edit mechanically rather than
 * by a claim in a commit message.
 *
 * Every builder is exercised at its CURRENT address, through the same
 * fixed fixture, and rendered two ways: the three `insertUnique` builders
 * compile a real Drizzle `SQL` (rendered with `SQLiteSyncDialect` /
 * `PgDialect`, the precedent `tests/search-candidates-planning.test.ts`
 * sets), and the three removal builders already return a `SqlFragment`
 * (rendered with `renderSqlite` / `renderPostgres`). A future batch that
 * moves either family to the new vocabulary must reproduce these ten
 * snapshots byte-for-byte with no source edit to this file.
 */
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
  buildHardDeleteEdgeClaimsByEdgeKind,
  buildHardDeleteEdgeClaimsByNodeKind,
} from "../src/backend/drizzle/operations/edge-claims";
import {
  buildHardDeleteUniquesByConcreteKind,
  buildInsertUnique,
  buildInsertUniqueBatch,
} from "../src/backend/drizzle/operations/uniques";
import { tables as postgresTables } from "../src/backend/drizzle/schema/postgres";
import { tables as sqliteTables } from "../src/backend/drizzle/schema/sqlite";
import { renderPostgres, renderSqlite } from "../src/query/sql-fragment";

const sqliteDialect = new SQLiteSyncDialect();
const pgDialect = new PgDialect();

function sqliteRendering(
  query: SQL,
): Readonly<{ sql: string; params: readonly unknown[] }> {
  const rendered = sqliteDialect.sqlToQuery(query);
  return { sql: rendered.sql, params: rendered.params };
}

function postgresRendering(
  query: SQL,
): Readonly<{ sql: string; params: readonly unknown[] }> {
  const rendered = pgDialect.sqlToQuery(query);
  return { sql: rendered.sql, params: rendered.params };
}

const FIRST_PARAMS = {
  graphId: "graph-1",
  nodeKind: "Person",
  constraintName: "email_unique",
  key: "alice@example.com",
  nodeId: "node-1",
  concreteKind: "Employee",
};

const SECOND_PARAMS = {
  graphId: "graph-1",
  nodeKind: "Person",
  constraintName: "email_unique",
  key: "bob@example.com",
  nodeId: "node-2",
  concreteKind: "Contractor",
};

describe("T2 — insertUnique builders (§4.1's zero-change proof)", () => {
  it("single-row, SQLite", () => {
    const query = buildInsertUnique(sqliteTables, "sqlite", FIRST_PARAMS);
    expect(sqliteRendering(query)).toMatchSnapshot(
      "insertUnique single-row sqlite",
    );
  });

  it("single-row, PostgreSQL", () => {
    const query = buildInsertUnique(postgresTables, "postgres", FIRST_PARAMS);
    expect(postgresRendering(query)).toMatchSnapshot(
      "insertUnique single-row postgres",
    );
  });

  it("batch, SQLite", () => {
    const query = buildInsertUniqueBatch(sqliteTables, "sqlite", [
      FIRST_PARAMS,
      SECOND_PARAMS,
    ]);
    expect(sqliteRendering(query)).toMatchSnapshot("insertUnique batch sqlite");
  });

  it("batch, PostgreSQL", () => {
    const query = buildInsertUniqueBatch(postgresTables, "postgres", [
      FIRST_PARAMS,
      SECOND_PARAMS,
    ]);
    expect(postgresRendering(query)).toMatchSnapshot(
      "insertUnique batch postgres",
    );
  });
});

describe("T2b — removal builders (§4.1b's zero-change proof)", () => {
  const uniquesTableName = "typegraph_node_uniques";
  const edgeClaimsTableName = "typegraph_edge_claims";
  const edgesTableName = "typegraph_edges";

  it("buildHardDeleteUniquesByConcreteKind, SQLite", () => {
    const fragment = buildHardDeleteUniquesByConcreteKind(uniquesTableName, {
      graphId: "graph-1",
      concreteKind: "Employee",
    });
    expect(renderSqlite(fragment)).toMatchSnapshot(
      "buildHardDeleteUniquesByConcreteKind sqlite",
    );
  });

  it("buildHardDeleteUniquesByConcreteKind, PostgreSQL", () => {
    const fragment = buildHardDeleteUniquesByConcreteKind(uniquesTableName, {
      graphId: "graph-1",
      concreteKind: "Employee",
    });
    expect(renderPostgres(fragment)).toMatchSnapshot(
      "buildHardDeleteUniquesByConcreteKind postgres",
    );
  });

  it("buildHardDeleteEdgeClaimsByEdgeKind, SQLite", () => {
    const fragment = buildHardDeleteEdgeClaimsByEdgeKind(edgeClaimsTableName, {
      graphId: "graph-1",
      edgeKind: "knows",
    });
    expect(renderSqlite(fragment)).toMatchSnapshot(
      "buildHardDeleteEdgeClaimsByEdgeKind sqlite",
    );
  });

  it("buildHardDeleteEdgeClaimsByEdgeKind, PostgreSQL", () => {
    const fragment = buildHardDeleteEdgeClaimsByEdgeKind(edgeClaimsTableName, {
      graphId: "graph-1",
      edgeKind: "knows",
    });
    expect(renderPostgres(fragment)).toMatchSnapshot(
      "buildHardDeleteEdgeClaimsByEdgeKind postgres",
    );
  });

  it("buildHardDeleteEdgeClaimsByNodeKind, SQLite", () => {
    const fragment = buildHardDeleteEdgeClaimsByNodeKind(
      edgeClaimsTableName,
      edgesTableName,
      {
        graphId: "graph-1",
        nodeKind: "Person",
      },
    );
    expect(renderSqlite(fragment)).toMatchSnapshot(
      "buildHardDeleteEdgeClaimsByNodeKind sqlite",
    );
  });

  it("buildHardDeleteEdgeClaimsByNodeKind, PostgreSQL", () => {
    const fragment = buildHardDeleteEdgeClaimsByNodeKind(
      edgeClaimsTableName,
      edgesTableName,
      {
        graphId: "graph-1",
        nodeKind: "Person",
      },
    );
    expect(renderPostgres(fragment)).toMatchSnapshot(
      "buildHardDeleteEdgeClaimsByNodeKind postgres",
    );
  });
});
