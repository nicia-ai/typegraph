import {
  asNodeId,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { sql } from "../../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../../src/query/sql-intent";
import { requireDefined } from "../../src/utils/presence";
import {
  createPgliteFixturePool,
  type PgliteFixturePool,
} from "./pglite-fixture-pool";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "pool-isolation",
  nodes: { Item: { type: Item } },
  edges: {},
});

describe("PGlite fixture pool", () => {
  let pool: PgliteFixturePool;

  beforeEach(() => {
    pool = createPgliteFixturePool();
  });

  afterEach(async () => {
    await pool.dispose();
  });

  it("keeps live fixtures independent, including overlapping transactions", async () => {
    const [left, right] = await Promise.all([
      pool.makeFixture(),
      pool.makeFixture(),
    ]);
    const [leftStore] = await createStoreWithSchema(graph, left.backend);
    const [rightStore] = await createStoreWithSchema(graph, right.backend);

    // Sharing a PGlite connection would queue the inner write behind the
    // outer transaction and deadlock. Sharing data would collide on this id.
    await leftStore.transaction(async (transaction) => {
      await transaction.nodes.Item.create({ name: "left" }, { id: "same-id" });
      await rightStore.nodes.Item.create({ name: "right" }, { id: "same-id" });
    });
    expect(
      (await leftStore.nodes.Item.getById(asNodeId("same-id")))?.name,
    ).toBe("left");
    expect(
      (await rightStore.nodes.Item.getById(asNodeId("same-id")))?.name,
    ).toBe("right");
    await Promise.all([left.cleanup(), right.cleanup()]);
  });

  it("drops every fixture object and resets session state before reuse", async () => {
    const first = await pool.makeFixture();
    const [firstStore] = await createStoreWithSchema(graph, first.backend);
    await firstStore.nodes.Item.create({ name: "old" }, { id: "same-id" });
    const [schema] = await first.backend.execute<{ name: string }>(
      asCompiledRowsSql(sql`SELECT current_schema() AS name`),
    );
    const oldSchema = requireDefined(schema).name;
    const executeStatement = requireDefined(first.backend.executeStatement);
    // Strategy tables are not part of the core table list. Include extension
    // types and an index so cleanup must remove the whole schema.
    await executeStatement(
      asCompiledStatementSql(
        sql`CREATE TABLE fixture_vectors (embedding vector(3))`,
      ),
    );
    await executeStatement(
      asCompiledStatementSql(
        sql`CREATE INDEX fixture_vector_index ON fixture_vectors USING hnsw (embedding vector_l2_ops)`,
      ),
    );
    await executeStatement(
      asCompiledStatementSql(
        sql`SET default_transaction_isolation = 'serializable'`,
      ),
    );
    await first.cleanup();

    const next = await pool.makeFixture();
    expect(next.backend).not.toBe(first.backend);
    expect(
      await next.backend.execute(
        asCompiledRowsSql(
          sql`SELECT nspname FROM pg_namespace WHERE nspname = ${oldSchema}`,
        ),
      ),
    ).toEqual([]);
    expect(
      await next.backend.execute<{ isolation: string }>(
        asCompiledRowsSql(
          sql`SELECT current_setting('default_transaction_isolation') AS isolation`,
        ),
      ),
    ).toEqual([{ isolation: "read committed" }]);

    const [nextStore] = await createStoreWithSchema(graph, next.backend);
    expect(
      await nextStore.nodes.Item.getById(asNodeId("same-id")),
    ).toBeUndefined();
    await nextStore.nodes.Item.create({ name: "new" }, { id: "same-id" });
    await next.cleanup();
  });
});
