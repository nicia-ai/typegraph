/** PostgreSQL's fused schema-row + graph advisory write fence (#533). */
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";

import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresOperationStrategy } from "../src/backend/drizzle/operations/strategy";
import { tables as postgresTables } from "../src/backend/drizzle/schema/postgres";
import { createPostgresBackend } from "../src/backend/postgres";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { tsvectorStrategy } from "../src/query/dialect/fulltext-strategy";
import { requireDefined } from "../src/utils/presence";

async function seedActiveSchema(
  client: PGlite,
  graphId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO "typegraph_schema_versions"
      ("graph_id", "version", "schema_hash", "schema_doc", "created_at", "is_active")
     VALUES ($1, 1, 'hash', '{}', NOW(), TRUE)`,
    [graphId],
  );
}

describe("schema + graph write fence", () => {
  it("is PostgreSQL transaction-only and acquires both locks in one ordered statement", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      await seedActiveSchema(client, "fused-lock");
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });

      expect(backend.lockSchemaVersionAndGraphWrite).toBeUndefined();
      await backend.transaction(async (tx) => {
        await requireDefined(tx.lockSchemaVersionAndGraphWrite)({
          expectedVersion: 1,
          graphId: "fused-lock",
        });
      });

      const strategy = createPostgresOperationStrategy(
        postgresTables,
        tsvectorStrategy,
      );
      const compiled = new PgDialect().sqlToQuery(
        requireDefined(strategy.buildLockSchemaVersionAndGraphWrite)(
          { expectedVersion: 1, graphId: "fused-lock" },
          "typegraph:recorded-graph-write",
        ),
      );
      const statement = compiled.sql.toLowerCase();
      expect(statement).toContain('"schema_fence" as materialized');
      expect(statement).toContain("for share");
      expect(statement).toContain('"graph_write_lock" as materialized');
      expect(statement).toContain("pg_advisory_xact_lock");
      expect(compiled.params).toContain("typegraph:recorded-graph-write");
      expect(statement.indexOf('"schema_fence" as materialized')).toBeLessThan(
        statement.indexOf('"graph_write_lock" as materialized'),
      );
      expect(statement).toContain('from "schema_fence"');
    } finally {
      await client.close();
    }
  });

  it("diagnoses a zero-row stale fence without acquiring the later lock", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      await seedActiveSchema(client, "stale-lock");
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });

      await expect(
        backend.transaction(async (tx) =>
          requireDefined(tx.lockSchemaVersionAndGraphWrite)({
            expectedVersion: 2,
            graphId: "stale-lock",
          }),
        ),
      ).rejects.toMatchObject({
        details: { actual: 1, expected: 2, graphId: "stale-lock" },
      });
    } finally {
      await client.close();
    }
  });

  it("rejects a zero-row fence even when the settled version equals expected", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });

      await expect(
        backend.transaction(async (tx) =>
          requireDefined(tx.lockSchemaVersionAndGraphWrite)({
            expectedVersion: 0,
            graphId: "rolled-back-lock",
          }),
        ),
      ).rejects.toMatchObject({
        details: { actual: 0, expected: 0, graphId: "rolled-back-lock" },
      });
    } finally {
      await client.close();
    }
  });

  it("is absent from bundled SQLite transactions", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      await backend.transaction((tx) => {
        expect(tx.lockSchemaVersionAndGraphWrite).toBeUndefined();
        return Promise.resolve();
      });
    } finally {
      await backend.close();
    }
  });
});
