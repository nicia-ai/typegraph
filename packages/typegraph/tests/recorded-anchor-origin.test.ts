import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../src";
import { createSqliteTables } from "../src/backend/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { sql } from "../src/query/sql-fragment";
import { asCompiledStatementSql } from "../src/query/sql-intent";
import { requireDefined } from "../src/utils/presence";

const Item = defineNode("Item", { schema: z.object({ label: z.string() }) });
const graph = defineGraph({
  id: "anchor_namespace",
  nodes: { Item: { type: Item } },
  edges: {},
});

describe("recorded anchor namespace ownership", () => {
  it("distinguishes physical forks that retain the same raw revision-origin row", async () => {
    const sourceHandle = createLocalSqliteBackend({
      tables: createSqliteTables({ recordedClock: "source_recorded_clock" }),
    });
    const forkHandle = createLocalSqliteBackend({
      tables: createSqliteTables({ recordedClock: "fork_recorded_clock" }),
    });
    try {
      const [source] = await createStoreWithSchema(
        graph,
        sourceHandle.backend,
        { history: true },
      );
      const [fork] = await createStoreWithSchema(graph, forkHandle.backend, {
        history: true,
      });
      await source.nodes.Item.create({ label: "source" }, { id: "item" });
      await fork.nodes.Item.create({ label: "fork" }, { id: "item" });
      const origin = await source.revisionOriginNow();
      // Physical copy strategies preserve this row. Revisions overlap after a fork.
      await requireDefined(forkHandle.backend.executeStatement)(
        asCompiledStatementSql(sql`
          UPDATE ${fork.revisionSchema.revisionOriginsTable}
          SET origin = ${origin} WHERE graph_id = ${graph.id}
        `),
      );
      expect(await fork.revisionOriginNow()).toBe(origin);
      const anchor = requireDefined(await source.recordedNow());
      await expect(
        fork.asOfRecorded(anchor).nodes.Item.getById(asNodeId("item")),
      ).rejects.toMatchObject({
        details: { code: "RECORDED_ANCHOR_ORIGIN_MISMATCH" },
      });
      const own = requireDefined(await fork.recordedNow());
      expect(
        await fork.asOfRecorded(own).nodes.Item.getById(asNodeId("item")),
      ).toMatchObject({ label: "fork" });
    } finally {
      await sourceHandle.backend.close();
      await forkHandle.backend.close();
    }
  });
});
