import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../../src";
import { defineGraphExtension } from "../../../src/graph-extension";
import { createStoreWithSchema } from "../../../src/store/store";
import { createTestBackend } from "../../test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const Animal = defineNode("Animal", { schema: z.object({ name: z.string() }) });
const likes = defineEdge("likes", { schema: z.object({}) });

const graph = defineGraph({
  id: "audit_removal_chain",
  nodes: { Person: { type: Person }, Animal: { type: Animal } },
  edges: { likes: { type: likes, from: [Person], to: [Animal] } },
});

describe("audit: removing a mid-chain kind", () => {
  it("removal-surviving-subclass-edge", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Mammal: { properties: { name: { type: "string" } } },
          Dog: { properties: { name: { type: "string" } } },
        },
        ontology: [
          { metaEdge: "subClassOf", from: "Mammal", to: "Animal" },
          { metaEdge: "subClassOf", from: "Dog", to: "Mammal" },
        ],
      }),
    );
    const person = await evolved.nodes.Person.create({ name: "p" });
    const dog = await evolved.getNodeCollectionOrThrow("Dog").create({ name: "d" });
    await evolved.edges.likes.create(person, dog as never, {});
    expect(await evolved.verifyConstraintFences()).toEqual([]);

    // Removing Mammal drops Dog -> Mammal and Mammal -> Animal, so Dog is no
    // longer admitted by likes(Person -> Animal) while the edge survives.
    // Correct behavior: either refuse, or the audit stays clean.
    let refused = false;
    try {
      await evolved.removeKinds(["Mammal"]);
    } catch {
      refused = true;
    }
    if (!refused) {
      expect(await evolved.verifyConstraintFences()).toEqual([]);
    }
  });
});
