import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { sql as drizzleSql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
  type AtomicNodeClaimEntry,
  buildAtomicNodeClaimGatePredicateWithSchemaFence,
} from "../src/backend/drizzle/operations/atomic-node-claims";
import {
  buildAtomicNodeBatchWithSchemaFence,
  buildInsertNodesBatchWithSchemaFence,
} from "../src/backend/drizzle/operations/nodes";
import { tables as postgresTables } from "../src/backend/drizzle/schema/postgres";
import { tables as sqliteTables } from "../src/backend/drizzle/schema/sqlite";
import { CompilerInvariantError } from "../src/errors";

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

function buildAtomicSql(
  entries: Parameters<typeof buildAtomicNodeBatchWithSchemaFence>[1],
) {
  return buildAtomicNodeBatchWithSchemaFence(
    sqliteTables,
    entries,
    "2026-08-25T00:00:00.000Z",
    schemaFence,
    drizzleSql.empty(),
    "count",
  );
}

function atomicNodeClaimGateParameterCount(
  entries: readonly AtomicNodeClaimEntry[],
  entryCount: number,
): number {
  const selected = entries.slice(0, entryCount);
  const gate = buildAtomicNodeClaimGatePredicateWithSchemaFence(
    sqliteTables,
    selected,
    schemaFence,
    drizzleSql.empty(),
  );
  const first = selected[0];
  if (first === undefined) throw new Error("Expected a claimed member");
  const query = buildAtomicNodeBatchWithSchemaFence(
    sqliteTables,
    [...new Set(selected.map((entry) => entry.entry))],
    "2026-08-25T00:00:00.000Z",
    schemaFence,
    drizzleSql.empty(),
    "count",
    gate,
  );
  return new SQLiteSyncDialect().sqlToQuery(query).params.length;
}

describe("schema-fenced atomic node batch SQL", () => {
  it("pins per-statement D1 claim-gate chunk ceilings", () => {
    const disjointEntries = Array.from({ length: 8 }, (_value, index) => {
      const id = `person-${index}`;
      const claim = {
        axis: "disjoint-axis",
        constraintName: "disjoint-constraint",
        key: id,
        placement: "pre-insert",
        verdict: {
          kind: "disjointness",
          conflictingKinds: ["Rival"],
        },
      } as const;
      return {
        memberOrdinal: index,
        claimOrdinal: 0,
        claim,
        entry: {
          idSource: "caller",
          params: {
            graphId: schemaFence.graphId,
            kind: "Person",
            id,
            props: { name: `Person ${index}` },
          },
          claims: [claim],
        },
      } as const satisfies AtomicNodeClaimEntry;
    });
    const uniquenessEntries = Array.from({ length: 15 }, (_value, index) => {
      const id = `unique-person-${index}`;
      const claim = {
        axis: "Person",
        constraintName: "person-name",
        key: `unique-name-${index}`,
        placement: "pre-insert",
        verdict: {
          kind: "uniqueness",
          fields: ["name"],
          probeAxes: ["Person"],
        },
      } as const;
      return {
        memberOrdinal: index,
        claimOrdinal: 0,
        claim,
        entry: {
          idSource: "generated",
          params: {
            graphId: schemaFence.graphId,
            kind: "Person",
            id,
            props: { name: `Unique Person ${index}` },
          },
          claims: [claim],
        },
      } as const satisfies AtomicNodeClaimEntry;
    });

    expect(
      atomicNodeClaimGateParameterCount(disjointEntries, 4),
    ).toBeLessThanOrEqual(100);
    expect(
      atomicNodeClaimGateParameterCount(disjointEntries, 5),
    ).toBeGreaterThan(100);
    expect(
      atomicNodeClaimGateParameterCount(uniquenessEntries, 6),
    ).toBeLessThanOrEqual(100);
    expect(
      atomicNodeClaimGateParameterCount(uniquenessEntries, 7),
    ).toBeGreaterThan(100);
  });

  it("refuses empty and mixed-source statement inputs", () => {
    expect(() => buildAtomicSql([])).toThrow(CompilerInvariantError);
    expect(() =>
      buildAtomicSql([
        { idSource: "generated", params: params[0] },
        { idSource: "caller", params: params[1] },
      ]),
    ).toThrow(CompilerInvariantError);
  });

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

  it("executes the caller UPSERT on SQLite and increments a tombstone version", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE typegraph_nodes (
          graph_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
          props TEXT NOT NULL, version INTEGER NOT NULL, valid_from TEXT,
          valid_to TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          deleted_at TEXT, PRIMARY KEY (graph_id, kind, id)
        );
        CREATE TABLE typegraph_schema_versions (
          graph_id TEXT NOT NULL, version INTEGER NOT NULL,
          schema_hash TEXT NOT NULL, schema_doc TEXT NOT NULL,
          created_at TEXT NOT NULL, is_active INTEGER NOT NULL,
          PRIMARY KEY (graph_id, version)
        );
        INSERT INTO typegraph_schema_versions VALUES
          ('graph-1', 7, 'hash', '{}', '2026-08-24T00:00:00.000Z', 1);
        INSERT INTO typegraph_nodes VALUES
          ('graph-1', 'Person', 'person-1', '{"old":true}', 3,
           '2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
           '2026-08-19T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
           '2026-08-22T00:00:00.000Z');
      `);
      const query = new SQLiteSyncDialect().sqlToQuery(
        buildAtomicNodeBatchWithSchemaFence(
          sqliteTables,
          [
            {
              idSource: "caller",
              params: {
                graphId: "graph-1",
                kind: "Person",
                id: "person-1",
                props: { name: "Alice" },
                validFrom: "2026-08-25T00:00:00.000Z",
              },
            },
          ],
          "2026-08-25T00:00:00.000Z",
          schemaFence,
          drizzleSql.empty(),
          "rows",
        ),
      );
      const rows = database
        .prepare(query.sql)
        .all(...query.params) as readonly Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        version: 4,
        created_at: "2026-08-19T00:00:00.000Z",
      });
      expect(rows[0]?.["deleted_at"]).toBeNull();
      expect(rows[0]?.["props"]).toBe('{"name":"Alice"}');
    } finally {
      database.close();
    }
  });

  it("uses the SQLite NOT NULL refusal as the live caller-ID duplicate sentinel", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE typegraph_nodes (
          graph_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
          props TEXT NOT NULL, version INTEGER NOT NULL, valid_from TEXT,
          valid_to TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          deleted_at TEXT, PRIMARY KEY (graph_id, kind, id)
        );
        CREATE TABLE typegraph_schema_versions (
          graph_id TEXT NOT NULL, version INTEGER NOT NULL,
          schema_hash TEXT NOT NULL, schema_doc TEXT NOT NULL,
          created_at TEXT NOT NULL, is_active INTEGER NOT NULL,
          PRIMARY KEY (graph_id, version)
        );
        INSERT INTO typegraph_schema_versions VALUES
          ('graph-1', 7, 'hash', '{}', '2026-08-24T00:00:00.000Z', 1);
        INSERT INTO typegraph_nodes VALUES
          ('graph-1', 'Person', 'person-1', '{"old":true}', 3,
           '2026-08-20T00:00:00.000Z', NULL, '2026-08-19T00:00:00.000Z',
           '2026-08-21T00:00:00.000Z', NULL);
      `);
      const query = new SQLiteSyncDialect().sqlToQuery(
        buildAtomicNodeBatchWithSchemaFence(
          sqliteTables,
          [
            {
              idSource: "caller",
              params: {
                graphId: "graph-1",
                kind: "Person",
                id: "person-1",
                props: { name: "Duplicate" },
              },
            },
          ],
          "2026-08-25T00:00:00.000Z",
          schemaFence,
          drizzleSql.empty(),
          "count",
        ),
      );

      expect(() => database.prepare(query.sql).all(...query.params)).toThrow(
        "NOT NULL constraint failed: typegraph_nodes.props",
      );
    } finally {
      database.close();
    }
  });

  it("executes the caller UPSERT on PostgreSQL and refuses a live incumbent", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(`
        CREATE TABLE typegraph_nodes (
          graph_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
          props JSONB NOT NULL, version INTEGER NOT NULL, valid_from TIMESTAMPTZ,
          valid_to TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ,
          PRIMARY KEY (graph_id, kind, id)
        );
        CREATE TABLE typegraph_schema_versions (
          graph_id TEXT NOT NULL, version INTEGER NOT NULL,
          schema_hash TEXT NOT NULL, schema_doc JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL, is_active BOOLEAN NOT NULL,
          PRIMARY KEY (graph_id, version)
        );
        INSERT INTO typegraph_schema_versions VALUES
          ('graph-1', 7, 'hash', '{}', '2026-08-24T00:00:00.000Z', TRUE);
        INSERT INTO typegraph_nodes VALUES
          ('graph-1', 'Person', 'person-1', '{"old":true}', 3,
           '2026-08-20T00:00:00.000Z', NULL, '2026-08-19T00:00:00.000Z',
           '2026-08-21T00:00:00.000Z', NULL),
          ('graph-1', 'Person', 'person-2', '{"old":true}', 3,
           '2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
           '2026-08-19T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
           '2026-08-22T00:00:00.000Z');
      `);
      const resurrectionQuery = new PgDialect().sqlToQuery(
        buildAtomicNodeBatchWithSchemaFence(
          postgresTables,
          [
            {
              idSource: "caller",
              params: {
                graphId: "graph-1",
                kind: "Person",
                id: "person-2",
                props: { name: "Resurrected" },
              },
            },
          ],
          "2026-08-25T00:00:00.000Z",
          schemaFence,
          drizzleSql`FOR SHARE`,
          "rows",
        ),
      );
      const resurrection = await client.query<Record<string, unknown>>(
        resurrectionQuery.sql,
        resurrectionQuery.params,
      );
      expect(resurrection.rows).toHaveLength(1);
      expect(resurrection.rows[0]).toMatchObject({
        id: "person-2",
        version: 4,
      });
      expect(resurrection.rows[0]?.["deleted_at"]).toBeNull();

      const query = new PgDialect().sqlToQuery(
        buildAtomicNodeBatchWithSchemaFence(
          postgresTables,
          [
            {
              idSource: "caller",
              params: {
                graphId: "graph-1",
                kind: "Person",
                id: "person-1",
                props: { name: "Alice" },
              },
            },
          ],
          "2026-08-25T00:00:00.000Z",
          schemaFence,
          drizzleSql`FOR SHARE`,
          "count",
        ),
      );
      await expect(client.query(query.sql, query.params)).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
