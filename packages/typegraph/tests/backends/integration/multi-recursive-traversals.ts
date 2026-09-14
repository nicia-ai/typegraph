import { beforeEach, describe, expect, it } from "vitest";

import { expr } from "../../../src";
import type { IntegrationTestContext } from "./test-context";

export function registerMultiRecursiveTraversalIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Multiple recursive traversal stages", () => {
    beforeEach(async () => {
      const store = context.getStore();
      const root = await store.nodes.Person.create({ name: "Multi root" });
      const middle = await store.nodes.Person.create({ name: "Multi middle" });
      const leaf = await store.nodes.Person.create({ name: "Multi leaf" });
      const tail = await store.nodes.Person.create({ name: "Multi tail" });
      await store.edges.knows.create(root, middle, {});
      await store.edges.knows.create(middle, leaf, {});
      await store.edges.knows.create(leaf, tail, {});
    });

    it("chains recursive stages from completed source identities", async () => {
      const rows = await context
        .getStore()
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Multi root"))
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 1, depth: "firstDepth" })
        .to("Person", "middle")
        .traverse("knows", "secondEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 2, depth: "secondDepth" })
        .to("Person", "target")
        .orderBy("target", "name", "asc")
        .select((row) => ({
          middle: row.middle.name,
          target: row.target.name,
          firstDepth: row.firstDepth,
          secondDepth: row.secondDepth,
        }))
        .execute();

      expect(rows).toEqual([
        {
          middle: "Multi middle",
          target: "Multi leaf",
          firstDepth: 1,
          secondDepth: 1,
        },
        {
          middle: "Multi middle",
          target: "Multi tail",
          firstDepth: 1,
          secondDepth: 2,
        },
      ]);
    });

    it("retains a prior row when an optional recursive stage has no match", async () => {
      const rows = await context
        .getStore()
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Multi root"))
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ minHops: 3, maxHops: 3 })
        .to("Person", "tail")
        .optionalTraverse("knows", "missingEdge", { expand: "none" })
        .recursive({
          minHops: 1,
          maxHops: 1,
          depth: "missingDepth",
          path: { format: "qualified", alias: "missingPath" },
        })
        .to("Person", "missing")
        .select((row) => ({
          tail: row.tail.name,
          missing: row.missing?.name,
          depth: row.missingDepth,
          path: row.missingPath,
        }))
        .execute();

      expect(rows).toEqual([
        {
          tail: "Multi tail",
          missing: undefined,
          depth: undefined,
          path: undefined,
        },
      ]);
    });

    it("applies stop-expansion independently within a later stage", async () => {
      const rows = await context
        .getStore()
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Multi root"))
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Person", "middle")
        .traverse("knows", "secondEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 2, depth: "secondDepth" })
        .to("Person", "target")
        .stopExpansion("target", (person) => person.name.eq("Multi leaf"))
        .select((row) => ({
          target: row.target.name,
          depth: row.secondDepth,
        }))
        .execute();

      expect(rows).toEqual([{ target: "Multi leaf", depth: 1 }]);
    });

    it("rejoins a shared downstream expansion to every upstream path", async () => {
      const store = context.getStore();
      const root = await store.nodes.Person.create({ name: "Diamond root" });
      const alternate = await store.nodes.Person.create({
        name: "Diamond alternate",
      });
      const middle = await store.nodes.Person.create({
        name: "Diamond middle",
      });
      const leaf = await store.nodes.Person.create({ name: "Diamond leaf" });
      await store.edges.knows.create(root, middle, {});
      await store.edges.knows.create(root, alternate, {});
      await store.edges.knows.create(alternate, middle, {});
      await store.edges.knows.create(middle, leaf, {});

      const rows = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.id.eq(root.id))
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 2 })
        .to("Person", "middle")
        .traverse("knows", "secondEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Person", "leaf")
        .where((fields) =>
          expr.eq(fields.leaf.name, expr.literal("Diamond leaf")),
        )
        .select((row) => row.leaf.name)
        .execute();

      expect(rows).toEqual(["Diamond leaf", "Diamond leaf"]);
    });

    it("can branch a later recursive stage from an earlier alias", async () => {
      const rows = await context
        .getStore()
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Multi root"))
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 2 })
        .to("Person", "descendant")
        .traverse("knows", "branchEdge", {
          expand: "none",
          from: "root",
        })
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Person", "branch")
        .select((row) => ({
          descendant: row.descendant.name,
          branch: row.branch.name,
        }))
        .execute();

      expect(
        rows.toSorted((left, right) =>
          left.descendant.localeCompare(right.descendant),
        ),
      ).toEqual([
        { descendant: "Multi leaf", branch: "Multi middle" },
        { descendant: "Multi middle", branch: "Multi middle" },
      ]);
    });

    it("applies completed filtering and range after the full chain and preserves terminals", async () => {
      const store = context.getStore();
      const query = store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Multi root"))
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Person", "middle")
        .traverse("knows", "secondEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 2 })
        .to("Person", "target")
        .where((fields) =>
          expr.or(
            expr.eq(fields.target.name, expr.literal("Multi leaf")),
            expr.eq(fields.target.name, expr.literal("Multi tail")),
          ),
        )
        .orderBy("target", "name", "desc")
        .limit(1)
        .select((row) => row.target.name);

      expect(await query.execute()).toEqual(["Multi tail"]);
      expect(await query.prepare().execute({})).toEqual(["Multi tail"]);
      expect(await store.batchOnce(() => [query, query])).toEqual([
        ["Multi tail"],
        ["Multi tail"],
      ]);
    });

    it("refuses mixed fixed hops, optional first stages, and selected edge fields", async () => {
      const store = context.getStore();
      const mixed = store
        .query()
        .from("Person", "root")
        .traverse("knows", "recursiveEdge", { expand: "none" })
        .recursive({ maxHops: 1 })
        .to("Person", "middle")
        .traverse("knows", "fixedEdge", { expand: "none" })
        .to("Person", "target")
        .select((row) => row.target.name);
      await expect(mixed.execute()).rejects.toThrow(
        "Mixing fixed-hop and variable-length traversals",
      );

      const optionalFirst = store
        .query()
        .from("Person", "root")
        .optionalTraverse("knows", "firstEdge", { expand: "none" })
        .recursive({ maxHops: 1 })
        .to("Person", "middle")
        .traverse("knows", "secondEdge", { expand: "none" })
        .recursive({ maxHops: 1 })
        .to("Person", "target")
        .select((row) => row.target.name);
      await expect(optionalFirst.execute()).rejects.toThrow(
        "optional first recursive traversal",
      );

      const selectedEdge = store
        .query()
        .from("Person", "root")
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ maxHops: 1 })
        .to("Person", "middle")
        .traverse("knows", "secondEdge", { expand: "none" })
        .recursive({ maxHops: 1 })
        .to("Person", "target")
        .select((row) => row.secondEdge.id);
      await expect(selectedEdge.execute()).rejects.toThrow(
        'does not support edge alias "secondEdge"',
      );
    });

    it("refuses recursive output aliases that collide with materialized columns", async () => {
      const query = context
        .getStore()
        .query()
        .from("Person", "root")
        .traverse("knows", "edge", { expand: "none" })
        .recursive({ maxHops: 1, depth: "root_id" })
        .to("Person", "target")
        .select((row) => row.target.name);

      await expect(query.execute()).rejects.toThrow(
        'Recursive traversal output alias "root_id" collides with another result column',
      );
    });
  });
}
