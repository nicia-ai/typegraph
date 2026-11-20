import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { RECORDED_ANCHOR_RETENTION_COLUMN } from "../../../src/backend/recorded-storage";
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

    describe("a fork taken before base-schema version 9 added the recorded clock's retention column", () => {
      const RECORDED_CLOCK_TABLE = "typegraph_recorded_clock";
      const dropRetentionColumn = (pool: Pool) =>
        pool.query(
          `ALTER TABLE ${RECORDED_CLOCK_TABLE} DROP COLUMN IF EXISTS ${RECORDED_ANCHOR_RETENTION_COLUMN}`,
        );
      const addRetentionColumn = (pool: Pool) =>
        pool.query(
          `ALTER TABLE ${RECORDED_CLOCK_TABLE} ADD COLUMN IF NOT EXISTS ${RECORDED_ANCHOR_RETENTION_COLUMN} TEXT`,
        );

      /** Forks with the column absent on both sides, then upgrades both. */
      async function forkBeforeUpgrade(operationKey: string) {
        if (sourcePool === undefined || targetPool === undefined)
          throw new Error("PostgreSQL test pools were not initialized");
        const sourceBackend = createPostgresBackend(drizzle(sourcePool), {
          vector: false,
        });
        const targetBackend = createPostgresBackend(drizzle(targetPool), {
          vector: false,
        });
        const upgradeGraph = defineGraph({
          id: `pre-v9-${operationKey}`,
          nodes: { Item: { type: Item } },
          edges: {},
        });
        const [source] = await createStoreWithSchema(
          upgradeGraph,
          sourceBackend,
          {
            history: true,
          },
        );
        await prepareNamespaceForkTarget(source, targetBackend);
        await source.nodes.Item.create({ name: "kept" });
        await dropRetentionColumn(sourcePool);
        await dropRetentionColumn(targetPool);
        const fork = await forkGraphNamespace(
          source,
          targetBackend,
          operationKey,
        );
        await addRetentionColumn(sourcePool);
        await addRetentionColumn(targetPool);
        return { source, targetBackend, fork };
      }

      it("still verifies on retry and can abort once the column exists", async () => {
        if (sourcePool === undefined || targetPool === undefined)
          throw new Error("PostgreSQL test pools were not initialized");
        try {
          const { source, targetBackend, fork } =
            await forkBeforeUpgrade("pre-v9-abort");
          const retry = await forkGraphNamespace(
            source,
            targetBackend,
            "pre-v9-abort",
          );
          expect(retry.proof).toEqual(fork.proof);
          await retry.abort();
        } finally {
          await addRetentionColumn(sourcePool);
          await addRetentionColumn(targetPool);
        }
      });

      it("still detects a non-NULL retention watermark written on the target", async () => {
        if (sourcePool === undefined || targetPool === undefined)
          throw new Error("PostgreSQL test pools were not initialized");
        try {
          const { source, targetBackend, fork } =
            await forkBeforeUpgrade("pre-v9-tamper");
          await targetPool.query(
            `UPDATE ${RECORDED_CLOCK_TABLE} SET ${RECORDED_ANCHOR_RETENTION_COLUMN} = '{}' WHERE graph_id = $1`,
            [fork.proof.graphId],
          );
          await expect(
            forkGraphNamespace(source, targetBackend, "pre-v9-tamper"),
          ).rejects.toThrow(
            "Namespace fork retry found a changed target namespace",
          );
          await expect(fork.abort()).rejects.toThrow(
            "Namespace fork abort found a changed target namespace",
          );
          await targetPool.query(
            `UPDATE ${RECORDED_CLOCK_TABLE} SET ${RECORDED_ANCHOR_RETENTION_COLUMN} = NULL WHERE graph_id = $1`,
            [fork.proof.graphId],
          );
          await fork.abort();
        } finally {
          await addRetentionColumn(sourcePool);
          await addRetentionColumn(targetPool);
        }
      });
    });
  },
);
