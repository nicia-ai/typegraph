/**
 * Operation hooks on composition moves. `reparent` is a single-entity write
 * and fires one `update` operation naming the part it moved; `bulkReparent`
 * is a batch method and, like every other batch method, fires none — a hook
 * names one entity, and a batch is not one.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type OperationHookContext,
  partOf,
} from "../src";
import { createTestBackend } from "./test-utils";

const RhShow = defineNode("RhShow", { schema: z.object({}) });
const RhClip = defineNode("RhClip", { schema: z.object({}) });
const rhClipOf = defineEdge("rhClipOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition_reparent_hooks",
  nodes: { RhShow: { type: RhShow }, RhClip: { type: RhClip } },
  edges: {
    rhClipOf: {
      type: rhClipOf,
      from: [RhClip],
      to: [RhShow],
      cardinality: "oneActive",
    },
  },
  ontology: [partOf(RhClip, RhShow, { via: rhClipOf })],
});

async function hookedStore() {
  const backend = createTestBackend();
  await createStoreWithSchema(graph, backend);
  const operations: OperationHookContext[] = [];
  const store = createStore(graph, backend, {
    hooks: { onOperationStart: (ctx) => operations.push(ctx) },
  });
  const from = await store.nodes.RhShow.create({});
  const to = await store.nodes.RhShow.create({});
  const first = await store.nodes.RhClip.create(
    {},
    { partOf: { whole: from } },
  );
  const second = await store.nodes.RhClip.create(
    {},
    { partOf: { whole: from } },
  );
  operations.length = 0;
  return { store, operations, to, first, second };
}

describe("operation hooks on composition moves", () => {
  it("reparent fires one update operation naming the part it moves", async () => {
    const { store, operations, to, first } = await hookedStore();

    await store.nodes.RhClip.reparent(first.id, { whole: to });

    expect(
      operations.map(({ operation, entity, kind, id }) => ({
        operation,
        entity,
        kind,
        id,
      })),
    ).toEqual([
      { operation: "update", entity: "node", kind: "RhClip", id: first.id },
    ]);
  });

  it("bulkReparent fires no operation hook, like every other batch method", async () => {
    const { store, operations, to, first, second } = await hookedStore();

    // MUTATION CHECK: run the batch frame through `runHookedWritePlan` with
    // the first item's id (`reparentParts`,
    // src/store/operations/node-operations.ts) — the batch then reports
    // one update of `first` and none of `second`.
    const results = await store.nodes.RhClip.bulkReparent([
      { id: first.id, options: { whole: to } },
      { id: second.id, options: { whole: to } },
    ]);

    expect(results.map((result) => result.moved)).toEqual([true, true]);
    expect(operations).toEqual([]);
  });
});
