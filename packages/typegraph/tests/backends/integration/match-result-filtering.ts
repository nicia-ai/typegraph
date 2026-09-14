import { describe, expect, it } from "vitest";

import { type DatabaseExpression, expr } from "../../../src";
import type { IntegrationTestContext } from "./test-context";

export function registerMatchResultFilteringIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Completed match filtering", () => {
    it("distinguishes optional node match constraints from completed row filters and absence checks", async () => {
      const store = context.getStore();
      const ada = await store.nodes.Person.create({ name: "Ada", age: 20 });
      const bea = await store.nodes.Person.create({ name: "Bea", age: 30 });
      await store.nodes.Person.create({ name: "Cara", age: 40 });
      await store.edges.knows.create(ada, bea, { since: "2020" });
      const matches = store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.in(["Ada", "Cara"]))
        .optionalTraverse("knows", "edge")
        .to("Person", "friend");
      const constrained = matches.whereNode("friend", (person) =>
        person.age.gte(40),
      );
      expect(
        await constrained
          .project((fields) => ({
            root: fields.root.name,
            friend: fields.friend.name,
          }))
          .orderBy((fields) => fields.root.name)
          .execute(),
      ).toEqual([
        { root: "Ada", friend: undefined },
        { root: "Cara", friend: undefined },
      ]);
      expect(
        await matches
          .where((fields) => expr.gte(fields.friend.age, expr.literal(40)))
          .count(),
      ).toBe(0);
      const retained = matches.where((fields) =>
        expr.or(
          expr.gte(fields.friend.age, expr.literal(40)),
          expr.isNull(fields.friend.id),
        ),
      );
      expect(
        await retained
          .project((fields) => ({ root: fields.root.name }))
          .execute(),
      ).toEqual([{ root: "Cara" }]);
      expect(await retained.exists()).toBe(true);
    });

    it("filters completed optional edge values without changing edge match constraints", async () => {
      const store = context.getStore();
      const ada = await store.nodes.Person.create({ name: "Ada" });
      const bea = await store.nodes.Person.create({ name: "Bea" });
      await store.edges.knows.create(ada, bea, { since: "2020" });
      const matches = store
        .query()
        .from("Person", "root")
        .optionalTraverse("knows", "edge")
        .to("Person", "friend");
      expect(
        await matches
          .whereEdge("edge", (edge) => edge.since.eq("2021"))
          .count(),
      ).toBe(2);
      expect(
        await matches
          .where((fields) => expr.eq(fields.edge.since, expr.literal("2021")))
          .count(),
      ).toBe(0);
      expect(
        await matches
          .where((fields) => expr.eq(fields.edge.since, expr.literal("2020")))
          .project((fields) => ({ root: fields.root.name }))
          .execute(),
      ).toEqual([{ root: "Ada" }]);
    });

    it("accumulates result predicates before grouping and range, and preserves them in batchOnce", async () => {
      const store = context.getStore();
      for (const person of [
        { name: "Ada", age: 10 },
        { name: "Ada", age: 20 },
        { name: "Bea", age: 30 },
      ])
        await store.nodes.Person.create(person);
      const matches = store
        .query()
        .from("Person", "person")
        .where((fields) => expr.gte(fields.person.age, expr.literal(20)))
        .where((fields) => expr.eq(fields.person.name, expr.literal("Ada")));
      const groups = matches
        .groupBy((fields) => [fields.person.name])
        .aggregate((fields) => ({
          name: fields.person.name,
          count: expr.count(),
        }));
      expect(await groups.execute()).toEqual([{ name: "Ada", count: 1 }]);
      expect(await store.batchOnce(() => [groups] as const)).toEqual([
        [{ name: "Ada", count: 1 }],
      ]);
      expect(await matches.count()).toBe(1);
      expect(
        await matches
          .select((row) => row.person.name)
          .orderBy("person", "name")
          .limit(1)
          .execute(),
      ).toEqual(["Ada"]);
    });

    it("binds parameters used only by completed-match filters", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Ada", age: 20 });
      await store.nodes.Person.create({ name: "Bea", age: 30 });
      const prepared = store
        .query()
        .from("Person", "person")
        .where((fields) =>
          expr.gte(fields.person.age, expr.param("minimumAge", "number")),
        )
        .select((row) => row.person.name)
        .orderBy("person", "name")
        .prepare();
      expect(await prepared.execute({ minimumAge: 25 })).toEqual(["Bea"]);
      expect(await prepared.execute({ minimumAge: 35 })).toEqual([]);
    });

    it("refuses aggregates and foreign query scopes in completed-match filters", async () => {
      const store = context.getStore();
      const query = store.query().from("Person", "person");
      await expect(
        query
          .where(() => expr.gt(expr.count(), expr.literal(0)))
          .select((row) => row.person.name)
          .execute(),
      ).rejects.toThrow(/aggregate/i);
      let foreignPredicate: DatabaseExpression<boolean, "person"> | undefined;
      store
        .query()
        .from("Person", "person")
        .where((fields) => {
          foreignPredicate = expr.eq(fields.person.name, expr.literal("Ada"));
          return foreignPredicate;
        });
      if (foreignPredicate === undefined)
        throw new Error("Expected captured predicate");
      const capturedPredicate = foreignPredicate;
      expect(() => query.where(() => capturedPredicate)).toThrow(/scope/i);
    });

    it("filters before late materialization limits, including unprojected predicate columns", async () => {
      const store = context.getStore();
      for (const person of [
        { name: "Ada", age: 10 },
        { name: "Bea", age: 30 },
        { name: "Cara", age: 40 },
      ])
        await store.nodes.Person.create(person);
      const query = store
        .query()
        .from("Person", "person")
        .where((fields) => expr.gte(fields.person.age, expr.literal(30)))
        .select((row) => row.person.name)
        .orderBy("person", "name")
        .limit(1);
      expect(await query.execute()).toEqual(["Bea"]);
      expect(await query.count()).toBe(1);
    });
  });
}
