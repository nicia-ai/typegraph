import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  StaleVersionError,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { sql } from "../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../src/query/sql-intent";
import { migrateSchema } from "../src/schema";
import { requireDefined } from "../src/utils/presence";
import { provisionPostgresTestDatabase } from "./postgres-test-database";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const Organization = defineNode("Organization", {
  schema: z.object({ name: z.string() }),
});
let pool: Pool | undefined;

beforeAll(async () => {
  if (process.env["POSTGRES_URL"] === undefined) return;
  const connectionString = await provisionPostgresTestDatabase(import.meta.url);
  pool = new Pool({ connectionString });
  await pool.query(generatePostgresMigrationSQL());
});

afterAll(async () => {
  await pool?.end();
});

describe.each(["sqlite", "postgres"] as const)(
  "identity maintenance schema race (%s)",
  (dialect) => {
    it
      .skipIf(
        dialect === "postgres" && process.env["POSTGRES_URL"] === undefined,
      )
      .each(["existing", "missing"] as const)(
      "does not rebuild a newer identity schema from a stale registry (%s separation relation)",
      async (relation) => {
        const backend =
          dialect === "sqlite" ?
            createLocalSqliteBackend().backend
          : createPostgresBackend(drizzle(requireDefined(pool)));
        const foldGraph = defineGraph({
          id: `maintenance_schema_race_${relation}`,
          nodes: {
            Person: { type: Person },
            Organization: { type: Organization },
          },
          edges: {},
          identity: { sameIdAcrossKinds: "fold" },
        });
        const ignoreGraph = defineGraph({
          id: foldGraph.id,
          nodes: foldGraph.nodes,
          edges: {},
          identity: { sameIdAcrossKinds: "ignore" },
        });
        try {
          const [seeded] = await createStoreWithSchema(foldGraph, backend);
          const person = await seeded.nodes.Person.create(
            { name: "Alice" },
            { id: "shared" },
          );
          await seeded.nodes.Organization.create(
            { name: "Example" },
            { id: "shared" },
          );
          const other = await seeded.nodes.Person.create(
            { name: "Bob" },
            { id: "other" },
          );
          await seeded.identity.assertDifferent(person, other);
          await requireDefined(backend.executeStatement)(
            asCompiledStatementSql(
              relation === "existing" ?
                sql`DELETE FROM typegraph_identity_separation`
              : sql`DROP TABLE typegraph_identity_separation`,
            ),
          );
          let interleaved = false;
          async function migrateBeforeRebuild(): Promise<void> {
            if (interleaved) return;
            interleaved = true;
            await migrateSchema(backend, ignoreGraph, 1);
          }
          const racing = deriveBackend(backend, {
            transaction: async (fn, options) => {
              await migrateBeforeRebuild();
              return backend.transaction(fn, options);
            },
            schemaWriteTransaction: async (graphId, fn) => {
              await migrateBeforeRebuild();
              return requireDefined(backend.schemaWriteTransaction)(
                graphId,
                fn,
              );
            },
          });
          await expect(
            createStoreWithSchema(foldGraph, racing),
          ).rejects.toThrow(StaleVersionError);
          expect(interleaved).toBe(true);
          const rows = await backend.execute(
            asCompiledRowsSql(
              sql`SELECT member_kind FROM typegraph_identity_closure WHERE graph_id = ${foldGraph.id}`,
            ),
          );
          expect(rows).toEqual([]);
        } finally {
          await backend.close();
        }
      },
    );
  },
);
