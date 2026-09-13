import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../src";
import { createTestBackend } from "./test-utils";

const Item = defineNode("Item", {
  schema: z.object({ name: z.string() }),
});
const contains = defineEdge("contains", { schema: z.object({}) });
const graph = defineGraph({
  id: "neighbor_reads",
  nodes: { Item: { type: Item } },
  edges: { contains: { type: contains, from: [Item], to: [Item] } },
});

describe("store neighbor reads", () => {
  it("hydrates ordered, limited neighbors in one statement", async () => {
    const statements: string[] = [];
    const store = createStore(graph, createTestBackend(), {
      hooks: {
        onQueryStart: (ctx) => {
          statements.push(ctx.sql);
        },
      },
    });
    const root = await store.nodes.Item.create({ name: "root" });
    const first = await store.nodes.Item.create({ name: "first" });
    const second = await store.nodes.Item.create({ name: "second" });
    await store.edges.contains.create(root, first, {}, { id: "edge-first" });
    const secondEdge = await store.edges.contains.create(
      root,
      second,
      {},
      { id: "edge-second" },
    );
    const neighbors = await store.neighbors(root, {
      edges: ["contains"],
      orderBy: { field: "id", direction: "desc" },
      limit: 1,
    });

    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]?.edge.id).toBe(secondEdge.id);
    expect(neighbors[0]?.node.id).toBe(secondEdge.toId);
    expect(statements).toHaveLength(1);
  });

  it("counts through an edge without hydration", async () => {
    const statements: string[] = [];
    const store = createStore(graph, createTestBackend(), {
      hooks: {
        onQueryStart: (ctx) => {
          statements.push(ctx.sql);
        },
      },
    });
    const root = await store.nodes.Item.create({ name: "root" });
    const first = await store.nodes.Item.create({ name: "first" });
    const second = await store.nodes.Item.create({ name: "second" });
    await store.edges.contains.create(root, first);
    await store.edges.contains.create(root, second);

    await expect(
      store.countNeighbors(root, { edges: ["contains"], direction: "out" }),
    ).resolves.toBe(2);
    expect(statements).toHaveLength(1);
  });

  it("supports incoming and bidirectional reads without duplicating self-loops", async () => {
    const store = createStore(graph, createTestBackend());
    const root = await store.nodes.Item.create({ name: "root" });
    const outgoing = await store.nodes.Item.create({ name: "outgoing" });
    const incoming = await store.nodes.Item.create({ name: "incoming" });
    await store.edges.contains.create(root, outgoing);
    await store.edges.contains.create(incoming, root);
    await store.edges.contains.create(root, root);

    const incomingNeighbors = await store.neighbors(root, {
      edges: ["contains"],
      direction: "in",
    });
    expect(
      incomingNeighbors.map((neighbor) => neighbor.node.id).toSorted(),
    ).toEqual([incoming.id, root.id].toSorted());

    await expect(
      store.countNeighbors(root, { edges: ["contains"], direction: "both" }),
    ).resolves.toBe(3);
  });

  it("refuses invalid neighbor bounds and kinds", async () => {
    const store = createStore(graph, createTestBackend());
    const root = await store.nodes.Item.create({ name: "root" });

    await expect(
      store.neighbors(root, { edges: ["contains"], limit: 0 }),
    ).rejects.toThrow("positive safe integer");
    await expect(
      store.neighbors(root, { edges: ["missing" as never] }),
    ).rejects.toThrow("missing");
  });
});
