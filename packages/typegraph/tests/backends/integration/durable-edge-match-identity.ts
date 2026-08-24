import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  EdgeMatchIdentityConflictError,
} from "../../../src";
import { type IntegrationTestContext } from "./test-context";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ label: z.string(), note: z.string().optional() }),
});

function durableIdentityGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person } },
    edges: {
      knows: {
        type: knows,
        from: [Person],
        to: [Person],
        matchIdentity: { name: "knows-label", fields: ["label"] },
      },
    },
  });
}

export function registerDurableEdgeMatchIdentityIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("durable edge match identity", () => {
    it("arbitrates direct duplicate creates in storage", async () => {
      const store = await context.createStore(
        durableIdentityGraph("durable_identity_direct_conflict"),
      );
      const from = await store.nodes.Person.create(
        { name: "From" },
        { id: "from" },
      );
      const to = await store.nodes.Person.create({ name: "To" }, { id: "to" });
      await store.edges.knows.create(
        from,
        to,
        { label: "same" },
        { id: "first" },
      );

      await expect(
        store.edges.knows.create(
          from,
          to,
          { label: "same", note: "different payload" },
          { id: "second" },
        ),
      ).rejects.toBeInstanceOf(EdgeMatchIdentityConflictError);
      await expect(store.edges.knows.find()).resolves.toHaveLength(1);
    });

    it("returns the durable incumbent without creating a duplicate", async () => {
      const store = await context.createStore(
        durableIdentityGraph("durable_identity_convergence"),
      );
      const from = await store.nodes.Person.create(
        { name: "From" },
        { id: "from" },
      );
      const to = await store.nodes.Person.create({ name: "To" }, { id: "to" });
      const incumbent = await store.edges.knows.create(
        from,
        to,
        { label: "same" },
        { id: "incumbent" },
      );

      const result = await store.edges.knows.getOrCreateByEndpoints(
        from,
        to,
        { label: "same", note: "ignored in return mode" },
        { matchOn: ["label"], ifExists: "return" },
      );

      expect(result).toMatchObject({
        action: "found",
        edge: { id: incumbent.id, label: "same" },
      });
      await expect(store.edges.knows.find()).resolves.toHaveLength(1);
    });

    it("resurrects the durable tombstone instead of allocating a new id", async () => {
      const store = await context.createStore(
        durableIdentityGraph("durable_identity_tombstone"),
      );
      const from = await store.nodes.Person.create(
        { name: "From" },
        { id: "from" },
      );
      const to = await store.nodes.Person.create({ name: "To" }, { id: "to" });
      const original = await store.edges.knows.create(
        from,
        to,
        { label: "same" },
        { id: "original" },
      );
      await store.edges.knows.delete(original.id);

      const result = await store.edges.knows.getOrCreateByEndpoints(
        from,
        to,
        { label: "same", note: "resurrected" },
        { matchOn: ["label"], ifExists: "return" },
      );

      expect(result).toMatchObject({
        action: "resurrected",
        edge: { id: original.id, label: "same", note: "resurrected" },
      });
    });
  });
}
