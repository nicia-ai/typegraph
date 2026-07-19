import { beforeEach, describe, expect, it } from "vitest";

import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

/**
 * Late materialization (deferred projection) — see typegraph#281.
 *
 * These cases run `ORDER BY … LIMIT` selective queries whose projection reads
 * columns beyond the sort/identity keys, which routes through the compiler's
 * late-materialization branch (sort+limit a lean candidate set, then re-fetch
 * the deferred columns by identity for the survivors). The transform must
 * return the same rows as the flat plan on every backend whenever the ORDER BY
 * determines a unique top-K, so these assert the exact top-K rows and their
 * deferred-column values. (When ties span the LIMIT boundary both plans pick
 * an arbitrary tied subset, and the two plan shapes may pick differently —
 * the same non-determinism class the flat plan already has.)
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
      store = await context.createStore(integrationTestGraph, {
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

    it("returns exact single-version rows for a recorded-time read", async () => {
      // A recorded pin swaps the query's node source to the recorded history
      // relation, where (graph_id, kind, id) matches one row per version. The
      // late-mat outer re-join keys on exactly that identity with no temporal
      // predicate, so recorded reads must fall back to the flat plan — this
      // guards against duplicated survivors and stale-version props.
      const history = await context.createHistoryStore(integrationTestGraph);

      const nodes = [];
      for (const person of [
        { name: "Rae", age: 41, email: "rae@v1.example.com" },
        { name: "Sam", age: 36, email: "sam@v1.example.com" },
        { name: "Tia", age: 31, email: "tia@v1.example.com" },
      ]) {
        nodes.push(await history.nodes.Person.create(person));
      }
      const pin = await history.recordedNow();
      if (pin === undefined) throw new Error("recorded clock was not written");

      // A second recorded version per node after the pin: an outer re-join
      // without a temporal predicate would both multiply the survivors and
      // surface these later emails at the pin.
      for (const node of nodes) {
        await history.nodes.Person.update(node.id, {
          email: `${node.name.toLowerCase()}@v2.example.com`,
        });
      }

      const results = await history
        .asOfRecorded(pin)
        .query()
        .from("Person", "person")
        .whereNode("person", (person) => person.age.gte(30))
        .select((ctx) => ({ name: ctx.person.name, email: ctx.person.email }))
        .orderBy("person", "age", "desc")
        .limit(2)
        .execute();

      expect(results).toEqual([
        { name: "Rae", email: "rae@v1.example.com" },
        { name: "Sam", email: "sam@v1.example.com" },
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
