import { beforeEach, describe, expect, it } from "vitest";

import {
  seedPeopleCompaniesForMultiHopTraversals,
  seedPeopleCompaniesForOptionalTraversals,
} from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

export function registerTraversalIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Optional Traversals", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedPeopleCompaniesForOptionalTraversals(store);
    });

    it("includes nodes without matching traversal (LEFT JOIN)", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .optionalTraverse("worksAt", "e")
        .to("Company", "c")
        .select((ctx) => ({ person: ctx.p.name, company: ctx.c?.name }))
        .execute();

      // Should include all 4 people, even those without a company
      expect(results).toHaveLength(4);

      const alice = results.find((result) => result.person === "Alice");
      expect(alice?.company).toBe("Acme Corp");

      const charlie = results.find((result) => result.person === "Charlie");
      expect(charlie?.company).toBeUndefined();

      const diana = results.find((result) => result.person === "Diana");
      expect(diana?.company).toBeUndefined();
    });

    it("filters on optional traversal results", async () => {
      // With optional traversal, filtering on the optional target
      // should work like a WHERE clause on a LEFT JOIN result
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .optionalTraverse("worksAt", "e")
        .to("Company", "c")
        .select((ctx) => ({
          person: ctx.p.name,
          company: ctx.c?.name,
          industry: ctx.c?.industry,
        }))
        .execute();

      // All 4 people are returned (LEFT JOIN semantics)
      expect(results).toHaveLength(4);

      // Alice has Acme Corp (Tech), Bob has Globex (Finance)
      const alice = results.find((result) => result.person === "Alice");
      expect(alice?.company).toBe("Acme Corp");
      expect(alice?.industry).toBe("Tech");

      const bob = results.find((result) => result.person === "Bob");
      expect(bob?.company).toBe("Globex");
      expect(bob?.industry).toBe("Finance");

      // Charlie and Diana have no company
      const charlie = results.find((result) => result.person === "Charlie");
      expect(charlie?.company).toBeUndefined();
    });

    it("combines required and optional traversals", async () => {
      const store = context.getStore();
      // First create some knows relationships
      const people = await store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p)
        .execute();

      const alice = people.find((person) => person.name === "Alice")!;
      const bob = people.find((person) => person.name === "Bob")!;
      const charlie = people.find((person) => person.name === "Charlie")!;

      // Alice knows Bob and Charlie
      await store.edges.knows.create(alice, bob, { since: "2020" });
      await store.edges.knows.create(alice, charlie, { since: "2021" });

      // Query: People Alice knows, with their optional employer
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e1") // Required: must have knows edge
        .to("Person", "friend")
        .optionalTraverse("worksAt", "e2") // Optional: friend may or may not work
        .to("Company", "c")
        .select((ctx) => ({
          friend: ctx.friend.name,
          employer: ctx.c?.name,
        }))
        .execute();

      // Should return Bob (works at Globex) and Charlie (no employer)
      expect(results).toHaveLength(2);

      const bobResult = results.find((result) => result.friend === "Bob");
      expect(bobResult?.employer).toBe("Globex");

      const charlieResult = results.find(
        (result) => result.friend === "Charlie",
      );
      expect(charlieResult?.employer).toBeUndefined();
    });

    it("handles multiple optional traversals", async () => {
      const store = context.getStore();
      // Create additional knows relationships
      const people = await store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p)
        .execute();

      const alice = people.find((person) => person.name === "Alice")!;
      const bob = people.find((person) => person.name === "Bob")!;

      await store.edges.knows.create(alice, bob, { since: "2023" });

      // Optional traverse through knows, then optional traverse to company
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .optionalTraverse("knows", "e1")
        .to("Person", "friend")
        .optionalTraverse("worksAt", "e2")
        .to("Company", "c")
        .select((ctx) => ({
          friend: ctx.friend?.name,
          company: ctx.c?.name,
        }))
        .execute();

      // Alice knows Bob, who works at Globex
      expect(results).toHaveLength(1);
      expect(results[0]?.friend).toBe("Bob");
      expect(results[0]?.company).toBe("Globex");
    });
  });

  describe("Multi-Hop Traversals", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedPeopleCompaniesForMultiHopTraversals(store);
    });

    it("traverses through multiple edges", async () => {
      // Find companies where Alice's friends work
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e1")
        .to("Person", "friend")
        .traverse("worksAt", "e2")
        .to("Company", "c")
        .select((ctx) => ({
          friend: ctx.friend.name,
          company: ctx.c.name,
        }))
        .execute();

      // Alice knows Bob, who works at Globex
      expect(results).toHaveLength(1);
      expect(results[0]?.friend).toBe("Bob");
      expect(results[0]?.company).toBe("Globex");
    });

    it("filters at each hop", async () => {
      const store = context.getStore();
      // Add more relationships
      const diana = await store.nodes.Person.create({ name: "Diana" });
      const people = await store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p)
        .execute();
      const alice = people.find((person) => person.name === "Alice")!;

      await store.edges.knows.create(alice, diana, { since: "2022" });

      // Get friends of Alice who have a name starting with "B"
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e")
        .to("Person", "friend")
        .whereNode("friend", (friend) => friend.name.startsWith("B"))
        .select((ctx) => ctx.friend.name)
        .execute();

      // Only Bob, not Diana
      expect(results).toHaveLength(1);
      expect(results[0]).toBe("Bob");
    });

    it("handles fan-out pattern using from option", async () => {
      // Fan-out pattern: from Alice, traverse to friends, then traverse back
      // from Alice (not from friends) to get Alice's company.
      //
      // Without `from` option (default chaining):
      //   Alice -> knows -> Bob -> worksAt -> Globex (Bob's company)
      //
      // With `from: \"p\"` option (fan-out from start):
      //   Alice -> knows -> Bob
      //   Alice -> worksAt -> Acme Corp (Alice's company, not Bob's)
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e1")
        .to("Person", "friend")
        .traverse("worksAt", "e2", { from: "p" }) // Fan-out: from Alice, not friend
        .to("Company", "c")
        .select((ctx) => ({
          person: ctx.p.name,
          friend: ctx.friend.name,
          company: ctx.c.name, // This is Alice's company, not Bob's
        }))
        .execute();

      // Alice's friend is Bob, but the company is Alice's (Acme Corp, not Globex)
      expect(results).toHaveLength(1);
      expect(results[0]?.person).toBe("Alice");
      expect(results[0]?.friend).toBe("Bob");
      expect(results[0]?.company).toBe("Acme Corp"); // Alice's company (fan-out)
    });

    it("returns correct nodes at each level", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e1")
        .to("Person", "friend")
        .traverse("worksAt", "e2")
        .to("Company", "c")
        .select((ctx) => ({
          starter: ctx.p.name,
          friend: ctx.friend.name,
          company: ctx.c.name,
          industry: ctx.c.industry,
        }))
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        starter: "Alice",
        friend: "Bob",
        company: "Globex",
        industry: "Finance",
      });
    });
  });
}
