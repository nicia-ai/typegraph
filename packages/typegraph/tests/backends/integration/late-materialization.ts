import { beforeEach, describe, expect, it } from "vitest";

import { createStore } from "../../../src";
import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

/**
 * Late materialization (deferred projection) — see typegraph#281.
 *
 * These cases run `ORDER BY … LIMIT` selective queries whose projection reads
 * columns beyond the sort/identity keys, which routes through the compiler's
 * late-materialization branch (sort+limit a lean candidate set, then re-fetch
 * the deferred columns by identity for the survivors). The transform must be
 * result-identical to the flat plan on every backend, so these assert the exact
 * top-K rows and their deferred-column values.
 *
 * A `traversalExpansion: "none"` store is used so traversal `.select()` queries
 * take the selective path the transform targets (matching how a fulltext/graph
 * consumer configures its store); the transform is otherwise engine-neutral.
 */
export function registerLateMaterializationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Late materialization (deferred projection)", () => {
    let store: IntegrationStore;

    beforeEach(async () => {
      store = createStore(integrationTestGraph, context.getStore().backend, {
        queryDefaults: { traversalExpansion: "none" },
      });

      const root = await store.nodes.Person.create({ name: "Root" });
      const friends = [
        { name: "Frida", age: 40, email: "frida@example.com" },
        { name: "Gus", age: 35, email: "gus@example.com" },
        { name: "Hana", age: 30, email: "hana@example.com" },
        { name: "Ivan", age: 25, email: "ivan@example.com" },
        { name: "June", age: undefined, email: undefined },
      ];
      for (const friend of friends) {
        const node = await store.nodes.Person.create(friend);
        await store.edges.knows.create(root, node, {});
      }
    });

    it("returns the correct top-K by a node sort key with deferred columns", async () => {
      const results = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Root"))
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .to("Person", "friend")
        .whereNode("friend", (friend) => friend.age.gte(30))
        .select((ctx) => ({
          name: ctx.friend.name,
          email: ctx.friend.email,
          age: ctx.friend.age,
        }))
        .orderBy("friend", "age", "desc")
        .limit(2)
        .execute();

      expect(results).toEqual([
        { name: "Frida", email: "frida@example.com", age: 40 },
        { name: "Gus", email: "gus@example.com", age: 35 },
      ]);
    });

    it("applies OFFSET with the pushed-down LIMIT", async () => {
      const results = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Root"))
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .to("Person", "friend")
        .whereNode("friend", (friend) => friend.age.gte(25))
        .select((ctx) => ({ name: ctx.friend.name, age: ctx.friend.age }))
        .orderBy("friend", "age", "desc")
        .limit(2)
        .offset(1)
        .execute();

      expect(results.map((row) => row.name)).toEqual(["Gus", "Hana"]);
    });

    it("honors a predicate on the deferred target node", async () => {
      const results = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Root"))
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .to("Person", "friend")
        .whereNode("friend", (friend) => friend.age.gte(35))
        .select((ctx) => ({ name: ctx.friend.name, email: ctx.friend.email }))
        .orderBy("friend", "age", "desc")
        .limit(10)
        .execute();

      expect(results.map((row) => row.name)).toEqual(["Frida", "Gus"]);
      expect(results[0]?.email).toBe("frida@example.com");
    });

    it("orders ascending with nulls-last semantics", async () => {
      const results = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Root"))
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .to("Person", "friend")
        .select((ctx) => ({ name: ctx.friend.name, age: ctx.friend.age }))
        .orderBy("friend", "age", "asc")
        .limit(3)
        .execute();

      expect(results.map((row) => row.name)).toEqual(["Ivan", "Hana", "Gus"]);
    });

    it("breaks ties with a secondary sort key", async () => {
      // Two friends share an age; the secondary key (name asc) orders them.
      const root = await store.nodes.Person.create({ name: "Root2" });
      for (const friend of [
        { name: "Zed", age: 50 },
        { name: "Amy", age: 50 },
      ]) {
        const node = await store.nodes.Person.create(friend);
        await store.edges.knows.create(root, node, {});
      }

      const results = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Root2"))
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .to("Person", "friend")
        .select((ctx) => ({ name: ctx.friend.name, age: ctx.friend.age }))
        .orderBy("friend", "age", "desc")
        .orderBy("friend", "name", "asc")
        .limit(2)
        .execute();

      expect(results.map((row) => row.name)).toEqual(["Amy", "Zed"]);
    });

    it("late-materializes a start-only query (no traversal)", async () => {
      const results = await store
        .query()
        .from("Person", "person")
        .whereNode("person", (person) => person.age.gte(30))
        .select((ctx) => ({ name: ctx.person.name, email: ctx.person.email }))
        .orderBy("person", "age", "desc")
        .limit(2)
        .execute();

      expect(results).toEqual([
        { name: "Frida", email: "frida@example.com" },
        { name: "Gus", email: "gus@example.com" },
      ]);
    });

    it("returns all rows when LIMIT exceeds the result set", async () => {
      const results = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Root"))
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .to("Person", "friend")
        .select((ctx) => ({ name: ctx.friend.name }))
        .orderBy("friend", "name", "asc")
        .limit(100)
        .execute();

      expect(results.map((row) => row.name)).toEqual([
        "Frida",
        "Gus",
        "Hana",
        "Ivan",
        "June",
      ]);
    });

    it("matches the flat plan for a multi-hop traversal", async () => {
      // root → knows → friend → knows → fof, ordered by the terminal node.
      const fofRoot = await store.nodes.Person.create({ name: "MultiRoot" });
      const mid = await store.nodes.Person.create({ name: "Mid" });
      await store.edges.knows.create(fofRoot, mid, {});
      for (const fof of [
        { name: "Nia", age: 22, email: "nia@example.com" },
        { name: "Omar", age: 44, email: "omar@example.com" },
      ]) {
        const node = await store.nodes.Person.create(fof);
        await store.edges.knows.create(mid, node, {});
      }

      const results = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("MultiRoot"))
        .traverse("knows", "e1", { expand: "none", direction: "out" })
        .to("Person", "mid")
        .traverse("knows", "e2", { expand: "none", direction: "out" })
        .to("Person", "fof")
        .select((ctx) => ({ name: ctx.fof.name, email: ctx.fof.email }))
        .orderBy("fof", "age", "desc")
        .limit(1)
        .execute();

      expect(results).toEqual([{ name: "Omar", email: "omar@example.com" }]);
    });
  });
}
