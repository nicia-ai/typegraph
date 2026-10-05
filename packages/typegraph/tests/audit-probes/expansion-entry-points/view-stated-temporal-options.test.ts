import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, TypeGraphError } from "../../../src";
import { createStoreWithSchema } from "../../../src/store/store";
import { createTestBackend } from "../../test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows", { schema: z.object({}) });
const graph = defineGraph({
  id: "audit_view_stated_temporal_options",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("expansion-entry-points", () => {
  // A view's coordinate is sealed: view.query().temporal(...) refuses with
  // STORE_VIEW_SEALED_QUERY. The view's subgraph() and algorithm reads instead
  // spread the pinned coordinate OVER the caller's options, so a stated
  // temporalMode/asOf (type-omitted, but accepted at runtime) is dropped
  // without a word and the read answers at the pin.
  it("view-subgraph-drops-stated-temporal-options", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend());
    const alice = await store.nodes.Person.create({ name: "alice" });
    const bob = await store.nodes.Person.create({ name: "bob" });
    await pause();
    const beforeEdge = new Date().toISOString();
    await pause();
    await store.edges.knows.create(alice, bob, {});
    await pause();
    const afterEdge = new Date().toISOString();

    const pinnedBefore = store.asOf(beforeEdge);
    const statedOtherInstant = {
      edges: ["knows"],
      temporalMode: "asOf",
      asOf: afterEdge,
    } as never;

    let namesRead: readonly string[] | undefined;
    let refusal: unknown;
    try {
      const result = (await pinnedBefore.subgraph(
        alice.id,
        statedOtherInstant,
      )) as unknown as Readonly<{
        nodes: ReadonlyMap<string, Readonly<{ name?: string }>>;
      }>;
      namesRead = [...result.nodes.values()].map((node) => String(node.name));
    } catch (error) {
      refusal = error;
    }

    // Applied (the stated instant sees bob) or refused with a typed error;
    // never silently answered at the pin.
    if (refusal !== undefined) {
      expect(refusal).toBeInstanceOf(TypeGraphError);
    } else {
      expect(namesRead?.toSorted()).toEqual(["alice", "bob"]);
    }
  });
});
