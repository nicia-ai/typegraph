import { sql as drizzleSql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { buildInsertEdgesBatchWithSchemaFence } from "../src/backend/drizzle/operations/edges";
import { tables as postgresTables } from "../src/backend/drizzle/schema/postgres";
import { tables as sqliteTables } from "../src/backend/drizzle/schema/sqlite";

const params = [
  {
    graphId: "graph-1",
    id: "edge-1",
    kind: "worksAt",
    fromKind: "Person",
    fromId: "person-1",
    toKind: "Company",
    toId: "company-1",
    props: { role: "Engineer" },
  },
  {
    graphId: "graph-1",
    id: "edge-2",
    kind: "worksAt",
    fromKind: "Person",
    fromId: "person-2",
    toKind: "Company",
    toId: "company-1",
    props: { role: "Designer" },
  },
] as const;

const schemaFence = { graphId: "graph-1", expectedVersion: 7 } as const;

describe("schema-fenced generated edge batch SQL", () => {
  it("renders one endpoint-guarded multi-row INSERT for PostgreSQL", () => {
    const query = buildInsertEdgesBatchWithSchemaFence(
      postgresTables,
      params,
      "2026-08-24T00:00:00.000Z",
      schemaFence,
      drizzleSql`FOR SHARE`,
    );
    const rendered = new PgDialect().sqlToQuery(query);
    const statement = rendered.sql.toLowerCase();

    expect(statement).toContain('with "schema_fence" as');
    expect(statement).toContain('"input_rows"');
    expect(statement).toContain('insert into "typegraph_edges"');
    expect(statement).toContain('cross join "schema_fence"');
    expect(statement).toContain('"from_node"');
    expect(statement).toContain('"to_node"');
    expect(statement).toContain("deleted_at");
    expect(statement).toContain('returning 1 as "inserted"');
    expect(statement).not.toContain("returning *");
    expect(statement).toContain("for share");
    expect(rendered.params).toContain("graph-1");
    expect(rendered.params).toContain("person-1");
    expect(rendered.params).toContain("company-1");
    expect(rendered.params).toContain('{"role":"Engineer"}');
  });

  it("keeps the same fenced endpoint shape on SQLite without a lock clause", () => {
    const query = buildInsertEdgesBatchWithSchemaFence(
      sqliteTables,
      params,
      "2026-08-24T00:00:00.000Z",
      schemaFence,
      drizzleSql.empty(),
    );
    const rendered = new SQLiteSyncDialect().sqlToQuery(query);
    const statement = rendered.sql.toLowerCase();

    expect(statement).toContain('with "schema_fence" as');
    expect(statement).toContain('"input_rows"');
    expect(statement).toContain('cross join "schema_fence"');
    expect(statement).toContain('"from_node"');
    expect(statement).toContain('"to_node"');
    expect(statement).toContain('returning 1 as "inserted"');
    expect(statement).not.toContain("returning *");
    expect(statement).not.toContain("for share");
    expect(rendered.params).toContain(7);
  });
});
