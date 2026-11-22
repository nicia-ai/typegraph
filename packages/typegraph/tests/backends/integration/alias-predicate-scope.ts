import { describe, expect, it } from "vitest";

import { exists, expr, field, inSubquery } from "../../../src";
import { UnsupportedPredicateError } from "../../../src/errors";
import { fieldRef } from "../../../src/query";
import type { IntegrationStore } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

/**
 * Alice (10) knows Bob (20); Alice knows Carol (5); Bob knows Carol. Only
 * Bob's email equals his name.
 * Every cross-alias comparison below has a different answer when the other
 * alias's read is replaced by the target's own column (the target compared
 * with itself), so a silent miscompile cannot pass as a refusal or a match.
 */
async function seedPeople(store: IntegrationStore): Promise<void> {
  const alice = await store.nodes.Person.create({ name: "Alice", age: 10 });
  const bob = await store.nodes.Person.create({
    name: "Bob",
    age: 20,
    email: "Bob",
  });
  const carol = await store.nodes.Person.create({ name: "Carol", age: 5 });
  await store.edges.knows.create(alice, bob, {});
  await store.edges.knows.create(alice, carol, {});
  await store.edges.knows.create(bob, carol, {});
}

function pairs(store: IntegrationStore) {
  return store
    .query()
    .from("Person", "a")
    .traverse("knows", "k")
    .to("Person", "b");
}

type Pair = Readonly<{ a: string; b: string }>;

function sortPairs(rows: readonly Pair[]): readonly Pair[] {
  return rows.toSorted(
    (left, right) =>
      left.a.localeCompare(right.a) || left.b.localeCompare(right.b),
  );
}

async function expectCrossAliasRefusal(
  run: () => Promise<unknown>,
  targetAlias: string,
  readAlias: string,
): Promise<void> {
  const error = await run().then(
    () => {
      throw new Error("expected the query to be refused");
    },
    (error_: unknown) => error_,
  );
  expect(error).toBeInstanceOf(UnsupportedPredicateError);
  expect(error).toMatchObject({
    code: "UNSUPPORTED_PREDICATE",
    details: { targetAlias, readAlias },
    message: `The predicate on alias "${targetAlias}" reads alias "${readAlias}"; a whereNode() or whereEdge() predicate can read only its own alias.`,
  });
}

export function registerAliasPredicateScopeIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Alias predicates read only their own alias", () => {
    it("refuses a traversal target predicate comparing with an earlier alias", async () => {
      const store = context.getStore();
      await seedPeople(store);

      await expectCrossAliasRefusal(
        () =>
          pairs(store)
            .whereNode("b", (b) => b.id.neq(field("a", "id")))
            .select((ctx) => ({ a: ctx.a.name, b: ctx.b.name }))
            .execute(),
        "b",
        "a",
      );
    });

    it("refuses a start-alias predicate comparing with a later alias", async () => {
      const store = context.getStore();
      await seedPeople(store);

      await expectCrossAliasRefusal(
        () =>
          pairs(store)
            .whereNode("a", (a) => a.id.neq(field("b", "id")))
            .select((ctx) => ({ a: ctx.a.name, b: ctx.b.name }))
            .execute(),
        "a",
        "b",
      );
    });

    it("refuses the expression form of a cross-alias node predicate", async () => {
      const store = context.getStore();
      await seedPeople(store);

      await expectCrossAliasRefusal(
        () =>
          pairs(store)
            .whereNode("b", (_b, expressions) =>
              expr.gt(expressions.b.age, expressions.a.age),
            )
            .select((ctx) => ({ a: ctx.a.name, b: ctx.b.name }))
            .execute(),
        "b",
        "a",
      );
    });

    it("refuses an edge predicate comparing with a node alias", async () => {
      const store = context.getStore();
      await seedPeople(store);

      await expectCrossAliasRefusal(
        () =>
          pairs(store)
            .whereEdge("k", (k) => k.toId.eq(field("b", "id")))
            .select((ctx) => ({ a: ctx.a.name, b: ctx.b.name }))
            .execute(),
        "k",
        "b",
      );
    });

    it("refuses a cross-alias predicate on an optional traversal target", async () => {
      const store = context.getStore();
      await seedPeople(store);

      await expectCrossAliasRefusal(
        () =>
          store
            .query()
            .from("Person", "a")
            .optionalTraverse("knows", "k")
            .to("Person", "b")
            .whereNode("b", (b) => b.id.neq(field("a", "id")))
            .select((ctx) => ({ a: ctx.a.name, b: ctx.b?.name }))
            .execute(),
        "b",
        "a",
      );
    });

    it("refuses a legacy subquery whose predicate names an outer alias", async () => {
      const store = context.getStore();
      await seedPeople(store);

      const knowsSomeone = store
        .query()
        .from("Person", "x")
        .traverse("knows", "k")
        .to("Person", "y")
        .whereNode("x", (x) => x.id.eq(fieldRef("p", ["id"])))
        .select((ctx) => ({ id: ctx.x.id }))
        .toAst();

      await expectCrossAliasRefusal(
        () =>
          store
            .query()
            .from("Person", "p")
            .whereNode("p", () => exists(knowsSomeone))
            .select((ctx) => ({ p: ctx.p.name }))
            .execute(),
        "x",
        "p",
      );
      await expectCrossAliasRefusal(
        () =>
          store
            .query()
            .from("Person", "p")
            .whereNode("p", () =>
              inSubquery(
                fieldRef("p", ["id"]),
                store
                  .query()
                  .from("Person", "x")
                  .whereNode("x", (x) => x.id.eq(fieldRef("p", ["id"])))
                  .aggregate({
                    id: fieldRef("x", ["id"], { valueType: "string" }),
                  })
                  .toAst(),
              ),
            )
            .select((ctx) => ({ p: ctx.p.name }))
            .execute(),
        "x",
        "p",
      );
    });

    it("compares aliases in where() over completed matches", async () => {
      const store = context.getStore();
      await seedPeople(store);

      const younger = await pairs(store)
        .where(({ a, b }) => expr.gt(b.age, a.age))
        .select((ctx) => ({ a: ctx.a.name, b: ctx.b.name }))
        .execute();
      expect(younger).toEqual([{ a: "Alice", b: "Bob" }]);

      const older = await pairs(store)
        .where(({ a, b }) => expr.gt(a.age, b.age))
        .select((ctx) => ({ a: ctx.a.name, b: ctx.b.name }))
        .execute();
      expect(sortPairs(older)).toEqual([
        { a: "Alice", b: "Carol" },
        { a: "Bob", b: "Carol" },
      ]);
    });

    it("still compares two fields of the target alias", async () => {
      const store = context.getStore();
      await seedPeople(store);

      const rows = await pairs(store)
        .whereNode("b", (b) => b.name.eq(field("b", "email")))
        .select((ctx) => ({ a: ctx.a.name, b: ctx.b.name }))
        .execute();
      expect(rows).toEqual([{ a: "Alice", b: "Bob" }]);
    });

    it("correlates a subquery predicate through $exists() and its negation", async () => {
      const store = context.getStore();
      await seedPeople(store);

      const rows = await store
        .query()
        .from("Person", "p")
        .where((expressions) =>
          expressions.$exists((subquery, outer) =>
            subquery
              .from("Person", "x")
              .traverse("knows", "k")
              .to("Person", "y")
              .whereNode("x", (_x, inner) => expr.eq(inner.x.id, outer.p.id))
              .project((inner) => ({ id: inner.x.id })),
          ),
        )
        .project((expressions) => ({ p: expressions.p.name }))
        .orderBy((expressions) => expressions.p.name)
        .execute();
      expect(rows).toEqual([{ p: "Alice" }, { p: "Bob" }]);

      const knowsNobody = await store
        .query()
        .from("Person", "p")
        .where((expressions) =>
          expr.not(
            expressions.$exists((subquery, outer) =>
              subquery
                .from("Person", "x")
                .traverse("knows", "k")
                .to("Person", "y")
                .whereNode("x", (_x, inner) => expr.eq(inner.x.id, outer.p.id))
                .project((inner) => ({ id: inner.x.id })),
            ),
          ),
        )
        .project((expressions) => ({ p: expressions.p.name }))
        .execute();
      expect(knowsNobody).toEqual([{ p: "Carol" }]);
    });
  });
}
