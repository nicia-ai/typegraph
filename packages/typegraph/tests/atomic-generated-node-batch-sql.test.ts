import { sql as drizzleSql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { buildInsertNodesBatchWithSchemaFence } from "../src/backend/drizzle/operations/nodes";
import { tables as postgresTables } from "../src/backend/drizzle/schema/postgres";
import { tables as sqliteTables } from "../src/backend/drizzle/schema/sqlite";

const params = [
  {
    graphId: "graph-1",
    kind: "Person",
    id: "person-1",
    props: { name: "Alice" },
  },
  {
    graphId: "graph-1",
    kind: "Person",
    id: "person-2",
    props: { name: "Bob" },
  },
] as const;

const schemaFence = { graphId: "graph-1", expectedVersion: 7 } as const;

describe("schema-fenced generated node batch SQL", () => {
  it("renders one CTE-gated multi-row INSERT for PostgreSQL", () => {
    const query = buildInsertNodesBatchWithSchemaFence(
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
    expect(statement).toContain('insert into "typegraph_nodes"');
    expect(statement).toContain('cross join "schema_fence"');
    expect(statement).toContain('returning 1 as "inserted"');
    expect(statement).not.toContain("returning *");
    expect(statement).toContain("for share");
    expect(rendered.params).toContain("graph-1");
    expect(rendered.params).toContain(7);
    expect(rendered.params).toContain('{"name":"Alice"}');
    expect(rendered.params).toContain('{"name":"Bob"}');
  });

  it("uses the same fenced shape on SQLite without a PostgreSQL lock clause", () => {
    const query = buildInsertNodesBatchWithSchemaFence(
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
    expect(statement).toContain('returning 1 as "inserted"');
    expect(statement).not.toContain("returning *");
    expect(statement).not.toContain("for share");
    expect(rendered.params).toContain(7);
  });
});
