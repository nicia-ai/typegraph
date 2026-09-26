import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import {
  forkGraphNamespace,
  prepareNamespaceForkTarget,
} from "../../../src/graph-merge/namespace-fork";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const SOURCE_URL = await provisionPostgresTestDatabase(import.meta.url);
const TARGET_URL = await provisionPostgresTestDatabase(
  new URL("namespace-fork-target.test.ts", import.meta.url).href,
);

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "server-postgres-namespace-fork",
  nodes: { Item: { type: Item } },
  edges: {},
});

let sourcePool: Pool | undefined;
let targetPool: Pool | undefined;

beforeAll(async () => {
  if (process.env["POSTGRES_URL"] === undefined) return;
  sourcePool = new Pool({ connectionString: SOURCE_URL });
  targetPool = new Pool({ connectionString: TARGET_URL });
  await sourcePool.query(generatePostgresMigrationSQL());
  await targetPool.query(generatePostgresMigrationSQL());
});

afterAll(async () => {
  await sourcePool?.end();
  await targetPool?.end();
});

describe.runIf(process.env["POSTGRES_URL"] !== undefined)(
  "forkGraphNamespace on server PostgreSQL",
  () => {
    it("copies a history snapshot across independent databases and can abort", async () => {
      if (sourcePool === undefined || targetPool === undefined)
        throw new Error("PostgreSQL test pools were not initialized");
      const sourceBackend = createPostgresBackend(drizzle(sourcePool), {
        vector: false,
      });
      const targetBackend = createPostgresBackend(drizzle(targetPool), {
        vector: false,
      });
      const [source] = await createStoreWithSchema(graph, sourceBackend, {
        history: true,
      });
      await prepareNamespaceForkTarget(source, targetBackend);
      const item = await source.nodes.Item.create({ name: "old" });
      const before = await source.recordedNow();
      if (before === undefined) throw new Error("recorded instant missing");
      await source.nodes.Item.update(item.id, { name: "new" });

      const fork = await forkGraphNamespace(
        source,
        targetBackend,
        "server-fork",
      );
      const current = await fork.store.nodes.Item.getById(item.id);
      const historical = await fork.store
        .asOfRecorded(before)
        .nodes.Item.getById(item.id);
      expect(current?.name).toBe("new");
      expect(historical?.name).toBe("old");
      await fork.abort();
      expect(await fork.store.nodes.Item.getById(item.id)).toBeUndefined();
    });
  },
);
