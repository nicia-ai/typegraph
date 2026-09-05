/** PostgreSQL's fused schema-row + graph advisory write fence (#533). */
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresOperationStrategy } from "../src/backend/drizzle/operations/strategy";
import { postgresFenceSql } from "../src/backend/drizzle/postgres-fence-sql";
import { tables as postgresTables } from "../src/backend/drizzle/schema/postgres";
import { createPostgresBackend } from "../src/backend/postgres";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { tsvectorStrategy } from "../src/query/dialect/fulltext-strategy";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.number() }),
});

const leaseGraph = defineGraph({
  id: "schema_fence_lease",
  nodes: { Person: { type: Person } },
  edges: {
    knows: { type: knows, from: [Person], to: [Person], cardinality: "many" },
  },
});

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
          postgresFenceSql,
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

  it.each(["node conflict", "missing edge endpoint"] as const)(
    "does not lease an unproven fused fence after a %s",
    async (zeroRowCause) => {
      const statements: string[] = [];
      const client = await PGlite.create();
      try {
        await client.exec(generatePostgresDDL().join("\n\n"));
        const backend = createPostgresBackend(
          drizzlePglite(client, {
            logger: {
              logQuery(query: string): void {
                statements.push(query);
              },
            },
          }),
          { vector: false },
        );
        const [store] = await createStoreWithSchema(leaseGraph, backend);
        await store.nodes.Person.create(
          { name: "Existing" },
          { id: "existing" },
        );
        const from = await store.nodes.Person.create({ name: "From" });
        const to = await store.nodes.Person.create({ name: "To" });
        statements.splice(0);

        const created = await store.transaction(async (transaction) => {
          const rejectedWrite =
            zeroRowCause === "node conflict" ?
              transaction.nodes.Person.create(
                { name: "Duplicate" },
                { id: "existing" },
              )
            : transaction.edges.knows.create(
                { kind: "Person", id: "missing" },
                { kind: "Person", id: to.id },
                { since: 2026 },
              );
          await expect(rejectedWrite).rejects.toThrow();

          return transaction.edges.knows.create(
            { kind: "Person", id: from.id },
            { kind: "Person", id: to.id },
            { since: 2026 },
          );
        });
        expect(created.since).toBe(2026);

        // The zero-row fused statement cannot prove its locking subquery ran.
        // Before any fallback read or later write relies on the transaction
        // lease, a portable locking read must acquire and validate it.
        expect(
          statements.filter((statement) => /for share/iu.test(statement)),
        ).toHaveLength(2);
      } finally {
        await client.close();
      }
    },
  );

  it("retries a zero-row root autocommit edge inside a transaction", async () => {
    const statements: string[] = [];
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      const backend = createPostgresBackend(
        drizzlePglite(client, {
          logger: {
            logQuery(query: string): void {
              statements.push(query);
            },
          },
        }),
        { vector: false },
      );
      const [store] = await createStoreWithSchema(leaseGraph, backend);
      const to = await store.nodes.Person.create({ name: "To" });
      statements.splice(0);

      await expect(
        store.edges.knows.create(
          { kind: "Person", id: "missing" },
          { kind: "Person", id: to.id },
          { since: 2026 },
        ),
      ).rejects.toMatchObject({ code: "ENDPOINT_NOT_FOUND" });

      // The root fused attempt is followed by a transaction-scoped fenced
      // recovery before ordered endpoint diagnostics.
      expect(
        statements.filter((statement) => /for share/iu.test(statement)),
      ).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});
