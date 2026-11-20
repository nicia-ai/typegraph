/**
 * Node `bulkHardDelete` planning work for plain nodes is linear in the batch.
 *
 * Each plain node is judged against the edges the earlier deletes remove. A
 * planner that hands each verdict a fresh copy of that accumulated set does
 * O(N²) work for N nodes with an edge each, while every statement count stays
 * flat — so this pins the work itself, as a count: the `Set.prototype.add`
 * calls the whole call makes (a copied set is rebuilt one `add` at a time).
 * Four times the nodes must cost about four times the adds, not sixteen.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { createInitializedStore } from "./test-utils";

const Item = defineNode("Item", { schema: z.object({}) });
const Hub = defineNode("Hub", { schema: z.object({}) });
const points = defineEdge("points", { schema: z.object({}) });

const graph = defineGraph({
  id: "node_bulk_hard_delete_planning",
  nodes: { Item: { type: Item, onDelete: "cascade" }, Hub: { type: Hub } },
  edges: { points: { type: points, from: [Item], to: [Hub] } },
});

const openBackends: GraphBackend[] = [];

afterEach(async () => {
  await Promise.all(openBackends.splice(0).map((backend) => backend.close()));
});

/**
 * Seeds `count` items, each with one edge to a shared hub, and counts the
 * `Set.prototype.add` calls one `bulkHardDelete` of all of them makes.
 */
async function countSetAddsForBatch(count: number): Promise<number> {
  const { backend } = createLocalSqliteBackend();
  openBackends.push(backend);
  const store = await createInitializedStore(graph, backend);
  const hub = await store.nodes.Hub.create({}, { id: "hub" });
  const ids = Array.from({ length: count }, (_, index) => `item-${index}`);
  await store.nodes.Item.bulkCreate(ids.map((id) => ({ props: {}, id })));
  await store.edges.points.bulkCreate(
    ids.map((id) => ({
      from: { kind: "Item", id } as never,
      to: hub,
      props: {},
    })),
  );

  const adds = vi.spyOn(Set.prototype, "add");
  try {
    await store.nodes.Item.bulkHardDelete(ids as never);
    return adds.mock.calls.length;
  } finally {
    adds.mockRestore();
  }
}

describe("node bulkHardDelete planning", () => {
  it("does work linear in the number of plain nodes with edges", async () => {
    const small = await countSetAddsForBatch(250);
    const large = await countSetAddsForBatch(1000);

    // Linear work: about 4×. Copying the accumulated removed-edge set per
    // node: about 16×.
    expect(large / small).toBeLessThan(6);
  });
  // MUTATION CHECK: pass `withCascadeConsumedEdges(undefined,
  // effects.removedEdgeIds)` to each plain node's verdict in
  // `planNodeHardDeleteBatch` again — the ratio approaches 16.
});
