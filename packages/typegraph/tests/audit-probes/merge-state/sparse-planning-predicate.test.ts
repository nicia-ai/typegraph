/**
 * Required test: bounded (sparse) candidate planning reads only the keys a
 * candidate names, so a graph declaring a constraint that spans rows the
 * sparse base never reads must plan against the whole target.
 *
 * MUTATION THAT FAILS THIS FILE: in `canUseSparseCandidatePlanning`
 * (src/graph-merge/sparse-candidate-branch.ts) delete the
 * `acyclicEdgeRelations(...).length === 0` conjunct (fails the acyclic and
 * composition cases) or loosen the cardinality `.every` so that a `"target"`
 * axis passes (fails the target-cardinality case).
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../../src";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import { canUseSparseCandidatePlanning } from "../../../src/graph-merge/sparse-candidate-branch";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const Group = defineNode("Group", { schema: z.object({}) });
const link = defineEdge("link", { schema: z.object({}) });
const holds = defineEdge("holds", { schema: z.object({}) });

const plain = defineGraph({
  id: "sparse_pred_plain",
  nodes: { Item: { type: Item } },
  edges: { link: { type: link, from: [Item], to: [Item] } },
});
const sourceCardinality = defineGraph({
  id: "sparse_pred_source_card",
  nodes: { Item: { type: Item } },
  edges: {
    link: { type: link, from: [Item], to: [Item], cardinality: "one" },
  },
});
const targetCardinality = defineGraph({
  id: "sparse_pred_target_card",
  nodes: { Item: { type: Item } },
  edges: {
    link: {
      type: link,
      from: [Item],
      to: [Item],
      targetCardinality: "one",
    },
  },
});
const acyclic = defineGraph({
  id: "sparse_pred_acyclic",
  nodes: { Item: { type: Item } },
  edges: { link: { type: link, from: [Item], to: [Item], acyclic: true } },
});
const composition = defineGraph({
  id: "sparse_pred_composition",
  nodes: { Item: { type: Item }, Group: { type: Group } },
  edges: {
    holds: {
      type: holds,
      from: [Item],
      to: [Group],
      cardinality: "one",
    },
  },
  ontology: [partOf(Item, Group, { via: holds })],
});

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function open<G extends Parameters<typeof createStoreWithSchema>[0]>(
  graph: G,
) {
  const { backend } = createLocalSqliteBackend();
  disposers.push(() => backend.close());
  const [store] = await createStoreWithSchema(graph, backend, {
    history: true,
  });
  return store;
}

describe("canUseSparseCandidatePlanning", () => {
  it("is true for a history-tracked graph with only source-side cardinality (control)", async () => {
    expect(canUseSparseCandidatePlanning(await open(plain))).toBe(true);
    expect(canUseSparseCandidatePlanning(await open(sourceCardinality))).toBe(
      true,
    );
  });

  it("is false when the graph declares target-side cardinality", async () => {
    expect(canUseSparseCandidatePlanning(await open(targetCardinality))).toBe(
      false,
    );
  });

  it("is false when the graph declares an acyclic edge", async () => {
    expect(canUseSparseCandidatePlanning(await open(acyclic))).toBe(false);
  });

  it("is false when the graph declares composition", async () => {
    expect(canUseSparseCandidatePlanning(await open(composition))).toBe(false);
  });
});
