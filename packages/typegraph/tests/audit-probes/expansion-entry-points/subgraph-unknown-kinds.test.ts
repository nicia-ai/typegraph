import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, TypeGraphError } from "../../../src";
import { createStoreWithSchema } from "../../../src/store/store";
import { createTestBackend } from "../../test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows", { schema: z.object({}) });
const graph = defineGraph({
  id: "audit_subgraph_unknown_kinds",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

async function refusalOf(attempt: () => Promise<unknown>): Promise<unknown> {
  try {
    await attempt();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("expansion-entry-points", () => {
  // bulkFindEdgesFrom/To and the neighbor reads refuse an unregistered kind with
  // KindNotFoundError. subgraph() states kinds in `edges` and `includeKinds`
  // and neither is checked at runtime: an unknown edge kind traverses nothing
  // and an unknown node kind filters every node out, both answered as an
  // ordinary (incomplete or empty) subgraph.
  it("subgraph-unknown-kinds-accepted", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend());
    const alice = await store.nodes.Person.create({ name: "alice" });
    const bob = await store.nodes.Person.create({ name: "bob" });
    await store.edges.knows.create(alice, bob, {});

    const unknownEdge = await refusalOf(() =>
      store.subgraph(alice.id, { edges: ["knowz"] } as never),
    );
    expect.soft(unknownEdge, "edges").toBeInstanceOf(TypeGraphError);

    const unknownNode = await refusalOf(() =>
      store.subgraph(alice.id, {
        edges: ["knows"],
        includeKinds: ["Persn"],
      } as never),
    );
    expect.soft(unknownNode, "includeKinds").toBeInstanceOf(TypeGraphError);
  });
});
