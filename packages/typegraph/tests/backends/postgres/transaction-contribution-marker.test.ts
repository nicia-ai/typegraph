import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);
const Document = defineNode("Document", {
  schema: z.object({ title: searchable({ language: "english" }) }),
});
const graph = defineGraph({
  id: "transaction-contribution-marker",
  nodes: { Document: { type: Document } },
  edges: {},
});

let pool: Pool | undefined;

beforeAll(async () => {
  if (process.env["POSTGRES_URL"] === undefined) return;
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 1000,
  });
  await pool.query(generatePostgresMigrationSQL());
  await createStoreWithSchema(
    graph,
    createPostgresBackend(drizzle(pool), { vector: false }),
  );
});

afterAll(async () => {
  await pool?.end();
});

describe.runIf(process.env["POSTGRES_URL"] !== undefined)(
  "transaction contribution marker reads",
  () => {
    it("resolves cold graph and deployment markers on the pinned session", async () => {
      if (pool === undefined)
        throw new Error("PostgreSQL pool was not initialized");
      const store = createStore(
        graph,
        createPostgresBackend(drizzle(pool), { vector: false }),
      );
      const created = await store.transaction(async (tx) =>
        tx.nodes.Document.create({ title: "transaction marker" }),
      );
      const saved = await store.nodes.Document.getById(created.id);
      expect(saved?.title).toBe("transaction marker");
    });
  },
);
