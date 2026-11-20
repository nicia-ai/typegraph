import { beforeEach, describe, expect, it } from "vitest";

import { expr } from "../../../src";
import type { IntegrationStore } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

export function registerRecursiveStopExpansionIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Recursive stop expansion", () => {
    let store: IntegrationStore;

    beforeEach(async () => {
      store = context.getStore();
      const root = await store.nodes.Person.create({ name: "Stop root" });
      const boundary = await store.nodes.Person.create({ name: "Boundary" });
      const beyond = await store.nodes.Person.create({
        name: "Beyond boundary",
      });
      const sibling = await store.nodes.Person.create({ name: "Sibling" });
      const siblingLeaf = await store.nodes.Person.create({
        name: "Sibling leaf",
      });
      await store.edges.knows.create(root, boundary, {});
      await store.edges.knows.create(boundary, beyond, {});
      await store.edges.knows.create(root, sibling, {});
      await store.edges.knows.create(sibling, siblingLeaf, {});
    });

    function stoppedNames(emitStopNode?: boolean): Promise<readonly string[]> {
      return store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Stop root"))
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .recursive({ maxHops: 3 })
        .to("Person", "person")
        .stopExpansion(
          "person",
          (person) => person.name.eq("Boundary"),
          emitStopNode === undefined ? undefined : { emitStopNode },
        )
        .select((selection) => selection.person.name)
        .execute();
    }

    it("emits a stopping node by default and does not expand through it", async () => {
      await expect(stoppedNames()).resolves.toEqual(
        expect.arrayContaining(["Boundary", "Sibling", "Sibling leaf"]),
      );
      await expect(stoppedNames()).resolves.not.toContain("Beyond boundary");
    });

    it("can omit the stopping node without stopping unrelated branches", async () => {
      const names = await stoppedNames(false);
      expect(names).toEqual(
        expect.arrayContaining(["Sibling", "Sibling leaf"]),
      );
      expect(names).not.toContain("Boundary");
      expect(names).not.toContain("Beyond boundary");
    });

    it("preserves stop behavior for a one-hop recursive range", async () => {
      const names = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Stop root"))
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Person", "person")
        .stopExpansion("person", (person) => person.name.eq("Boundary"), {
          emitStopNode: false,
        })
        .select((selection) => selection.person.name)
        .execute();

      expect(names).toEqual(["Sibling"]);
    });

    it("applies the stop predicate to a depth-zero seed", async () => {
      const base = store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Stop root"))
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .recursive({ minHops: 0, maxHops: 3 })
        .to("Person", "person");

      const included = await base
        .stopExpansion("person", (person) => person.name.eq("Stop root"))
        .select((selection) => selection.person.name)
        .execute();
      const excluded = await base
        .stopExpansion("person", (person) => person.name.eq("Stop root"), {
          emitStopNode: false,
        })
        .select((selection) => selection.person.name)
        .execute();

      expect(included).toEqual(["Stop root"]);
      expect(excluded).toEqual([]);
    });

    it("continues expansion when the stop predicate evaluates to NULL", async () => {
      const names = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Stop root"))
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .recursive({ minHops: 0, maxHops: 3 })
        .to("Person", "person")
        .stopExpansion("person", (person) => person.age.eq(100))
        .select((selection) => selection.person.name)
        .execute();

      expect(names).toContain("Beyond boundary");
      expect(names).toContain("Sibling leaf");
    });

    it("applies completed-match filters after expansion", async () => {
      const prunedNames = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Stop root"))
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .recursive({ maxHops: 3 })
        .to("Person", "person")
        .whereNode("person", (person) => person.name.eq("Sibling leaf"))
        .select((selection) => selection.person.name)
        .execute();
      const names = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Stop root"))
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .recursive({ maxHops: 3 })
        .to("Person", "person")
        .where((fields) =>
          expr.eq(fields.person.name, expr.literal("Sibling leaf")),
        )
        .select((selection) => selection.person.name)
        .execute();

      expect(prunedNames).toEqual([]);
      expect(names).toEqual(["Sibling leaf"]);
    });

    it("correlates completed recursive filters through the final CTE row", async () => {
      await store.nodes.Person.create({ age: 99, name: "Boundary" });
      const names = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Stop root"))
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .recursive({ maxHops: 3 })
        .to("Person", "person")
        .where((fields) =>
          fields.$exists((subquery, outer) =>
            subquery
              .from("Person", "candidate")
              .where((inner) =>
                expr.and(
                  expr.eq(inner.candidate.name, outer.person.name),
                  expr.eq(inner.candidate.age, expr.literal(99)),
                ),
              )
              .project((inner) => ({ id: inner.candidate.id })),
          ),
        )
        .orderBy("person", "name", "asc")
        .limit(1)
        .select((selection) => selection.person.name)
        .execute();

      expect(names).toEqual(["Boundary"]);
    });

    it("remaps recursive result columns when the recursive query is nested", async () => {
      await store.nodes.Person.create({ age: 99, name: "Boundary" });
      const names = await store
        .query()
        .from("Person", "outerRoot")
        .whereNode("outerRoot", (person) => person.name.eq("Stop root"))
        .where((fields) =>
          fields.$exists((recursiveQuery, outer) =>
            recursiveQuery
              .from("Person", "seed")
              .where((inner) => expr.eq(inner.seed.name, outer.outerRoot.name))
              .traverse("knows", "nestedEdge", {
                expand: "none",
                direction: "out",
              })
              .recursive({ maxHops: 3 })
              .to("Person", "nestedPerson")
              .where((nestedFields) =>
                nestedFields.$exists((candidateQuery, recursiveOuter) =>
                  candidateQuery
                    .from("Person", "candidate")
                    .where((candidate) =>
                      expr.and(
                        expr.eq(
                          candidate.candidate.name,
                          recursiveOuter.nestedPerson.name,
                        ),
                        expr.eq(candidate.candidate.age, expr.literal(99)),
                      ),
                    )
                    .project((candidate) => ({ id: candidate.candidate.id })),
                ),
              )
              .project((nested) => ({ id: nested.nestedPerson.id })),
          ),
        )
        .select((selection) => selection.outerRoot.name)
        .execute();

      expect(names).toEqual(["Stop root"]);
    });

    it("refuses repeated stop definitions instead of overwriting one", () => {
      const query = store
        .query()
        .from("Person", "root")
        .traverse("knows", "edge", { expand: "none", direction: "out" })
        .recursive({ maxHops: 3 })
        .to("Person", "person")
        .stopExpansion("person", (person) => person.name.eq("Boundary"));

      expect(() =>
        query.stopExpansion("person", (person) => person.name.eq("Sibling")),
      ).toThrow(/already defined/);
    });
  });
}
