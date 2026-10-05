import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  TypeGraphError,
} from "../../../src";
import { createTestBackend } from "../../test-utils";

const emptySchema = z.object({});
describe("declaration options audit", () => {
  it("edge-cardinality-value-unvalidated: an unknown cardinality or a unique targetCardinality is refused with a typed error, not a TypeError at the first write", async () => {
    const attempts = [
      { cardinality: "bogus" },
      { targetCardinality: "unique" },
    ];
    for (const options of attempts) {
      const N = defineNode("N", { schema: emptySchema });
      const e = defineEdge("e", { schema: emptySchema });
      let refused: unknown;
      let writeError: unknown;
      try {
        const graph = defineGraph({
          id: "cardinality_value_probe",
          nodes: { N: { type: N } },
          edges: { e: { type: e, from: [N], to: [N], ...options } as never },
        });
        const [store] = await createStoreWithSchema(graph, createTestBackend());
        const a = await store.nodes.N.create({});
        const b = await store.nodes.N.create({});
        try {
          await store.edges.e.create(a, b, {});
        } catch (error) {
          writeError = error;
        }
      } catch (error) {
        refused = error;
      }
      expect
        .soft(refused ?? writeError, JSON.stringify(options))
        .toBeInstanceOf(TypeGraphError);
    }
  });

  it("acyclic-non-boolean-ignored: a non-boolean acyclic is refused or enforced, never silently ignored", async () => {
    const N = defineNode("N", { schema: emptySchema });
    const e = defineEdge("e", { schema: emptySchema });
    let refused: unknown;
    let cycleError: unknown;
    try {
      const graph = defineGraph({
        id: "acyclic_value_probe",
        nodes: { N: { type: N } },
        edges: {
          e: { type: e, from: [N], to: [N], acyclic: "yes" } as never,
        },
      });
      const [store] = await createStoreWithSchema(graph, createTestBackend());
      const a = await store.nodes.N.create({});
      const b = await store.nodes.N.create({});
      await store.edges.e.create(a, b, {});
      try {
        await store.edges.e.create(b, a, {});
      } catch (error) {
        cycleError = error;
      }
    } catch (error) {
      refused = error;
    }
    expect(refused ?? cycleError).toBeInstanceOf(TypeGraphError);
  });
});
