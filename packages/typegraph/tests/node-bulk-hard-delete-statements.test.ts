/**
 * Node `bulkHardDelete` statement shape for plain nodes.
 *
 * A plain node (no composition parts, no Operational Identity participation)
 * costs no statement of its own: the batch's statements are a fixed sequence
 * whose only dependence on N is how many bind-budget chunks an id list
 * spans. Every id list here fits one chunk of PGlite's budget, so a batch of
 * 10 and a batch of 1,000 must issue the SAME statement sequence — while the
 * per-id loop grows with every id.
 *
 * Statements are recorded with drizzle's logger (`statement-recorder.ts`),
 * which sees every statement the engine runs, including those issued inside a
 * backend member.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  searchable,
} from "../src";
import { MAX_REFERENCE_CHUNK_SIZE } from "../src/identity/sql-target";
import { createRecordedPostgresStore } from "./statement-recorder";

const Item = defineNode("Item", {
  schema: z.object({ email: z.string(), bio: searchable() }),
});
const Hub = defineNode("Hub", { schema: z.object({}) });
const points = defineEdge("points", { schema: z.object({}) });

const graph = defineGraph({
  id: "node_bulk_hard_delete_statements",
  nodes: {
    Item: {
      type: Item,
      onDelete: "cascade",
      unique: [
        {
          name: "item_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Hub: { type: Hub },
  },
  edges: {
    points: { type: points, from: [Item], to: [Hub], cardinality: "one" },
  },
  identity: { sameIdAcrossKinds: "ignore" },
});

/** Chunks of the identity participation probe for `count` ids. */
function identityChunks(count: number): number {
  return Math.ceil(count / MAX_REFERENCE_CHUNK_SIZE);
}

function occurrences(shapes: readonly string[], shape: string): number {
  return shapes.filter((candidate) => candidate === shape).length;
}

/**
 * One statement with its positional parameters and the value lists they
 * expand to collapsed, so two batches of different sizes compare by shape.
 */
function statementShape(query: string): string {
  return query
    .replaceAll(/\$\d+/g, "$")
    .replaceAll(/\$(?:\s*,\s*\$)+/g, "$…")
    .replaceAll(/\s+/g, " ")
    .trim();
}

/**
 * Seeds `count` items, each with a unique key, a fulltext row and a claimed
 * edge to one hub, then records the statements one write over their ids
 * issues.
 */
async function recordDelete(
  count: number,
  write: (
    nodes: Awaited<
      ReturnType<typeof createRecordedPostgresStore<typeof graph>>
    >["store"]["nodes"],
    ids: readonly string[],
  ) => Promise<void>,
): Promise<readonly string[]> {
  const recorded = await createRecordedPostgresStore(graph);
  const [store] = await createStoreWithSchema(graph, recorded.backend);
  const hub = await store.nodes.Hub.create({}, { id: "hub" });
  const ids = Array.from({ length: count }, (_, index) => `item-${index}`);
  await store.nodes.Item.bulkCreate(
    ids.map((id) => ({ props: { email: `${id}@example.com`, bio: id }, id })),
  );
  await store.edges.points.bulkCreate(
    ids.map((id) => ({
      from: { kind: "Item", id } as never,
      to: hub,
      props: {},
    })),
  );
  recorded.reset();
  await write(store.nodes, ids);
  const shapes = recorded.statements.map((statement) =>
    statementShape(statement.query),
  );
  const remaining = await store.nodes.Item.getByIds(ids as never);
  expect(remaining.filter((node) => node !== undefined)).toEqual([]);
  return shapes;
}

describe("node bulkHardDelete statement count", () => {
  it("issues the same statements for 10 and for 1,000 plain nodes, apart from bind-budget chunks, where the per-id loop grows with every id", async () => {
    const bulk = (
      nodes: Parameters<Parameters<typeof recordDelete>[1]>[0],
      ids: readonly string[],
    ) => nodes.Item.bulkHardDelete(ids as never);
    const loop = async (
      nodes: Parameters<Parameters<typeof recordDelete>[1]>[0],
      ids: readonly string[],
    ) => {
      for (const id of ids) await nodes.Item.hardDelete(id as never);
    };
    const ten = await recordDelete(10, bulk);
    const thousand = await recordDelete(1000, bulk);
    const loopTen = await recordDelete(10, loop);
    const loopTwenty = await recordDelete(20, loop);

    // The same statements, in the same order of first appearance.
    expect([...new Set(thousand)]).toEqual([...new Set(ten)]);
    // Every id list fits one chunk of PGlite's budget except the identity
    // probe's, whose chunk is capped at MAX_REFERENCE_CHUNK_SIZE: it alone
    // repeats, once per chunk; every other statement runs as often for 1,000
    // nodes as for 10.
    for (const shape of new Set(ten)) {
      const chunked = shape.includes('"typegraph_identity_');
      const expected =
        chunked ?
          (occurrences(ten, shape) / identityChunks(10)) * identityChunks(1000)
        : occurrences(ten, shape);
      expect({ shape, count: occurrences(thousand, shape) }).toEqual({
        shape,
        count: expected,
      });
    }

    // The baseline the batch replaces, measured by the same recorder: every
    // further id costs the loop its own gate, frame, connected-edge read,
    // edge, claim, uniqueness, fulltext and row statements.
    const loopStatementsPerId = (loopTwenty.length - loopTen.length) / 10;
    expect(loopStatementsPerId).toBeGreaterThanOrEqual(8);
    // The batch costs fewer statements for 10 ids than the loop does, and
    // each further id costs it a small fraction of one statement — the
    // identity probe's extra chunks — where it costs the loop eight or more.
    expect(ten.length).toBeLessThan(loopTen.length);
    const batchStatementsPerId = (thousand.length - ten.length) / 990;
    expect(batchStatementsPerId).toBeLessThan(loopStatementsPerId / 100);
  });
  // MUTATION CHECK: drop `findEdgesConnectedToNodes` (or
  // `hardDeleteNodesBatch`) from the PostgreSQL backend, so the batch takes
  // its per-node fallback, or implement `bulkHardDelete` as the per-id loop —
  // the 1,000-node sequence grows by one statement set per node.
});
