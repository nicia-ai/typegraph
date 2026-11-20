import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../src";
import { compareStrings } from "../../src/utils/compare";
import { requireDefined } from "../../src/utils/presence";
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
  it("closes an assertion chain of any length into one class, currently and at asOf(now)", async () => {
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
            await store.identity.assertSame(
              requireDefined(nodes[index - 1]),
              requireDefined(nodes[index]),
            );
          }
          const now = new Date().toISOString();
          const seed = requireDefined(nodes[0]);

          // The class content is known independently of the system: a chain of
          // n assertSame calls over n nodes closes into exactly those n members
          // (membersOf includes the queried node itself), in id order.
          const expectedMembers = nodes
            .map((node) => ({ kind: "Person" as const, id: node.id }))
            .toSorted((left, right) => compareStrings(left.id, right.id));
          expect(expectedMembers).toHaveLength(names.length);

          const currentMembers = await store.identity.membersOf(seed);
          expect(currentMembers).toEqual(expectedMembers);
          expect(await store.asOf(now).identity.membersOf(seed)).toEqual(
            expectedMembers,
          );
          // Symmetry: every member reaches the same class from its own side.
          for (const node of nodes) {
            expect(await store.identity.membersOf(node)).toEqual(
              expectedMembers,
            );
          }

          const expectedIds = expectedMembers.map((member) => member.id);
          const current = await store
            .query()
            .from("Person", "person")
            .select((context) => context.person.id)
            .execute();
          expect(
            [...current].toSorted((left, right) => compareStrings(left, right)),
          ).toEqual(expectedIds);
          const historical = await store
            .asOf(now)
            .query()
            .from("Person", "person")
            .select((context) => context.person.id)
            .execute();
          expect(
            [...historical].toSorted((left, right) =>
              compareStrings(left, right),
            ),
          ).toEqual(expectedIds);
        },
      ),
      { numRuns: 25 },
    );
  });
});
