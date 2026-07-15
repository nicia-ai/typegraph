import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../src";
import { createInitializedStore, createTestBackend } from "../test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "identity_property",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

describe("Operational Identity properties", () => {
  it("keeps current identity and ordinary queries equal to asOf(now)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
          minLength: 1,
          maxLength: 8,
        }),
        async (names) => {
          const store = await createInitializedStore(
            graph,
            createTestBackend(),
          );
          const nodes = [];
          for (const [index, name] of names.entries()) {
            nodes.push(
              await store.nodes.Person.create(
                { name: name },
                { id: `person-${index}` },
              ),
            );
          }
          for (let index = 1; index < nodes.length; index += 1) {
            await store.identity.assertSame(nodes[index - 1]!, nodes[index]!);
          }
          const now = new Date().toISOString();
          const seed = nodes[0]!;

          expect(await store.asOf(now).identity.membersOf(seed)).toEqual(
            await store.identity.membersOf(seed),
          );
          const current = await store
            .query()
            .from("Person", "person")
            .select((context) => context.person.id)
            .execute();
          const historical = await store
            .asOf(now)
            .query()
            .from("Person", "person")
            .select((context) => context.person.id)
            .execute();
          expect(historical).toEqual(current);
        },
      ),
      { numRuns: 25 },
    );
  });
});
