import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import {
  edgeMatchIdentityPairCheckName,
  edgeMatchIdentityUniqueIndexName,
} from "../src/backend/drizzle/ddl";
import {
  createPostgresTables,
  generatePostgresDDL,
} from "../src/backend/postgres";
import { createPostgresBackend } from "../src/backend/postgres";
import { createSqliteTables, generateSqliteDDL } from "../src/backend/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { sql as portableSql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { initializeSchema } from "../src/schema/manager";

describe("durable edge-match identity DDL", () => {
  it("declares the nullable pair check and unique arbiter for custom names", () => {
    const tableName = "app_edges";
    const ddl = [
      generateSqliteDDL(createSqliteTables({ edges: tableName })).join("\n"),
      generatePostgresDDL(createPostgresTables({ edges: tableName })).join(
        "\n",
      ),
    ];

    for (const script of ddl) {
      expect(script).toContain('"match_identity_name"');
      expect(script).toContain('"match_identity_key"');
      expect(script).toContain(
        `CONSTRAINT "${edgeMatchIdentityPairCheckName(tableName)}" CHECK`,
      );
      expect(script).toContain(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${edgeMatchIdentityUniqueIndexName(tableName)}" ON "${tableName}" ("graph_id", "kind", "match_identity_name", "match_identity_key");`,
      );
    }
  });

  it("adopts an old custom-named SQLite edge table idempotently", async () => {
    const tableName = "app_edges";
    const { backend, db } = createLocalSqliteBackend({
      tables: createSqliteTables({ edges: tableName }),
    });
    try {
      db.run(sql.raw(`DROP TABLE "${tableName}"`));
      db.run(
        sql.raw(
          `CREATE TABLE "${tableName}" ("graph_id" TEXT NOT NULL, "id" TEXT NOT NULL, "kind" TEXT NOT NULL, "from_kind" TEXT NOT NULL, "from_id" TEXT NOT NULL, "to_kind" TEXT NOT NULL, "to_id" TEXT NOT NULL, "props" TEXT NOT NULL, "valid_from" TEXT, "valid_to" TEXT, "created_at" TEXT NOT NULL, "updated_at" TEXT NOT NULL, "deleted_at" TEXT, PRIMARY KEY ("graph_id", "id"))`,
        ),
      );

      await backend.ensureEdgeMatchIdentityStorage?.();
      await backend.ensureEdgeMatchIdentityStorage?.();

      const columns = await backend.execute<{ name: string }>(
        asCompiledRowsSql(
          portableSql`PRAGMA table_info(${portableSql.identifier(tableName)})`,
        ),
      );
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["match_identity_name", "match_identity_key"]),
      );

      const insert = (id: string, name: string, key: string | undefined) =>
        db.run(
          sql.raw(
            `INSERT INTO "${tableName}" ("graph_id", "id", "kind", "from_kind", "from_id", "to_kind", "to_id", "props", "match_identity_name", "match_identity_key", "created_at", "updated_at") VALUES ('g', '${id}', 'knows', 'Person', 'a', 'Person', 'b', '{}', ${name === "NULL" ? "NULL" : `'${name}'`}, ${key === undefined ? "NULL" : `'${key}'`}, '2026-01-01', '2026-01-01')`,
          ),
        );
      insert("e1", "identity", "same");
      expect(() => insert("e2", "identity", "same")).toThrow();
      expect(() => insert("e3", "identity", undefined)).toThrow();
      expect(() => insert("e4", "NULL", "different")).toThrow();
    } finally {
      await backend.close();
    }
  });

  it("adds the pair check when a legacy SQLite table has only the key column", async () => {
    const tableName = "key_only_edges";
    const { backend, db } = createLocalSqliteBackend({
      tables: createSqliteTables({ edges: tableName }),
    });
    try {
      db.run(sql.raw(`DROP TABLE "${tableName}"`));
      db.run(
        sql.raw(
          `CREATE TABLE "${tableName}" ("graph_id" TEXT NOT NULL, "id" TEXT NOT NULL, "kind" TEXT NOT NULL, "from_kind" TEXT NOT NULL, "from_id" TEXT NOT NULL, "to_kind" TEXT NOT NULL, "to_id" TEXT NOT NULL, "props" TEXT NOT NULL, "match_identity_key" TEXT, "created_at" TEXT NOT NULL, "updated_at" TEXT NOT NULL, PRIMARY KEY ("graph_id", "id"))`,
        ),
      );

      await backend.ensureEdgeMatchIdentityStorage?.();

      expect(() =>
        db.run(
          sql.raw(
            `INSERT INTO "${tableName}" ("graph_id", "id", "kind", "from_kind", "from_id", "to_kind", "to_id", "props", "match_identity_name", "created_at", "updated_at") VALUES ('g', 'e1', 'knows', 'Person', 'a', 'Person', 'b', '{}', 'identity', '2026-01-01', '2026-01-01')`,
          ),
        ),
      ).toThrow();
    } finally {
      await backend.close();
    }
  });

  it("adopts a quoted mixed-case PostgreSQL edge table", async () => {
    const tableName = "App_Edges";
    const tables = createPostgresTables({ edges: tableName });
    const client = await PGlite.create();
    await client.exec(generatePostgresDDL(tables).join("\n\n"));
    await client.exec(`DROP TABLE "${tableName}"`);
    await client.exec(
      `CREATE TABLE "${tableName}" (graph_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, from_kind TEXT NOT NULL, from_id TEXT NOT NULL, to_kind TEXT NOT NULL, to_id TEXT NOT NULL, props JSONB NOT NULL, valid_from TIMESTAMPTZ, valid_to TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ, PRIMARY KEY (graph_id, id))`,
    );
    const backend = createPostgresBackend(drizzlePglite(client), {
      tables,
      vector: false,
    });
    try {
      await backend.ensureEdgeMatchIdentityStorage?.();
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [tableName],
      );
      expect(columns.rows.map((column) => column.column_name)).toEqual(
        expect.arrayContaining(["match_identity_name", "match_identity_key"]),
      );
    } finally {
      await client.close();
    }
  });

  it("adopts a complete pre-match-identity PostgreSQL schema when reopening a legacy graph", async () => {
    const edgeTableName = "typegraph_edges";
    const baseSchemaVersionsTableName = "typegraph_base_schema_versions";
    const graphTemplatesTableName = "typegraph_graph_templates";
    const tables = createPostgresTables({ edges: edgeTableName });
    const client = await PGlite.create();
    await client.exec(generatePostgresDDL(tables).join("\n\n"));

    const backend = createPostgresBackend(drizzlePglite(client), {
      tables,
      vector: false,
    });

    const Person = defineNode("Person", {
      schema: z.object({ name: z.string() }),
    });
    const knows = defineEdge("knows", {
      schema: z.object({ label: z.string() }),
    });
    const graph = defineGraph({
      id: "preprovisioned_match_identity",
      nodes: { Person: { type: Person } },
      edges: {
        knows: {
          type: knows,
          from: [Person],
          to: [Person],
        },
      },
    });

    try {
      await initializeSchema(backend, graph);
      // Rewind the physical installation after publishing the active schema:
      // a 0.51 deployment has a current graph document but its base relations
      // predate the template table and nullable match-identity columns.
      await client.exec(
        [
          `DROP TABLE "${graphTemplatesTableName}"`,
          `DROP INDEX "${edgeMatchIdentityUniqueIndexName(edgeTableName)}"`,
          `ALTER TABLE "${edgeTableName}" DROP CONSTRAINT "${edgeMatchIdentityPairCheckName(edgeTableName)}"`,
          `ALTER TABLE "${edgeTableName}" DROP COLUMN "match_identity_key"`,
          `ALTER TABLE "${edgeTableName}" DROP COLUMN "match_identity_name"`,
          `DROP TABLE "${baseSchemaVersionsTableName}"`,
        ].join(";\n"),
      );

      const [store, result] = await createStoreWithSchema(graph, backend);
      expect(result.status).toBe("unchanged");

      const from = await store.nodes.Person.create({ name: "From" });
      const to = await store.nodes.Person.create({ name: "To" });
      await expect(
        store.edges.knows.create(from, to, { label: "first" }),
      ).resolves.toMatchObject({ label: "first" });
    } finally {
      await backend.close();
    }
  });

  it("propagates PostgreSQL catalog-probe failures regardless of message text", async () => {
    const client = await PGlite.create();
    await client.exec(generatePostgresDDL().join("\n\n"));
    const probeError = new Error(
      "permission failure from a driver missing a SQL compiler compatibility layer",
    );
    const query = client.query.bind(client);
    const querySpy = vi.spyOn(client, "query").mockImplementation((...args) => {
      if (typeof args[0] === "string" && args[0].includes("to_regclass")) {
        throw probeError;
      }
      return query(...args);
    });
    const backend = createPostgresBackend(drizzlePglite(client), {
      vector: false,
    });
    try {
      await expect(backend.ensureEdgeMatchIdentityStorage?.()).rejects.toBe(
        probeError,
      );
    } finally {
      querySpy.mockRestore();
      await client.close();
    }
  });
});
