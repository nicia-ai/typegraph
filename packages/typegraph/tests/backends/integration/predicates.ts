import { beforeEach, describe, expect, it } from "vitest";

import { param as parameter } from "../../../src";
import { type IntegrationStore } from "./fixtures";
import {
  seedDocumentsForArrayPredicates,
  seedDocumentsForObjectPredicates,
  seedPeopleForComplexPredicates,
  seedPeopleForStringPredicates,
} from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

/**
 * Seeds the three shapes a "nullish-looking" property can take in stored
 * JSON: absent, the JSON null literal, and the JSON *string* "null".
 * isNull must match the first two and NOT the third; isNotNull is the exact
 * complement.
 */
async function seedNullShapeEdges(store: IntegrationStore): Promise<void> {
  const anna = await store.nodes.Person.create({ name: "ShapeAnna" });
  const missing = await store.nodes.Person.create({ name: "ShapeMissing" });
  const jsonNull = await store.nodes.Person.create({ name: "ShapeJsonNull" });
  const stringNull = await store.nodes.Person.create({
    name: "ShapeStringNull",
  });
  const numeric = await store.nodes.Person.create({ name: "ShapeNumeric" });
  await store.edges.knows.create(anna, missing, {});
  // eslint-disable-next-line unicorn/no-null -- the JSON null value is the case under test
  await store.edges.knows.create(anna, jsonNull, { weight: null });
  await store.edges.knows.create(anna, stringNull, { since: "null" });
  await store.edges.knows.create(anna, numeric, { weight: 7 });
}

/**
 * Runs the same membership test as a literal list and as a bound list
 * parameter, and asserts they agree.
 *
 * String is the element type that needs this least — it is the one Postgres
 * does not cast. Number, boolean, and date each ride an element cast that has
 * to mirror the `jsonExtract*` cast the left operand was compiled with, so
 * those are the pairs where a drift shows up as wrong rows rather than as an
 * error.
 */
async function expectAgreement(
  literal: () => Promise<readonly string[]>,
  parameterized: () => Promise<readonly string[]>,
  expected: readonly string[],
): Promise<void> {
  const fromLiteral = await literal();
  const fromParameter = await parameterized();
  expect(fromParameter.toSorted()).toEqual(fromLiteral.toSorted());
  expect(fromLiteral.toSorted()).toEqual(expected);
}

export function registerPredicateIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Complex Predicate Execution", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedPeopleForComplexPredicates(store);
    });

    it("executes OR predicate", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.age.lt(26).or(p.age.gt(34)))
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["Bob", "Charlie"]);
    });

    it("executes AND predicate", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.isActive.eq(true).and(p.age.gte(30)))
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["Alice", "Charlie"]);
    });

    it("executes NOT predicate", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.isActive.eq(true).not())
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toBe("Bob");
    });

    it("executes nested AND/OR predicates", async () => {
      // (isActive AND age > 28) OR email contains 'test'
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) =>
          p.isActive.eq(true).and(p.age.gt(28)).or(p.email.contains("test")),
        )
        .select((ctx) => ctx.p.name)
        .execute();

      // Alice (active, 30), Charlie (active, 35, has test email)
      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["Alice", "Charlie"]);
    });

    it("executes IN predicate", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.in(["Alice", "Charlie", "Eve"]))
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["Alice", "Charlie"]);
    });

    it("executes an IN predicate larger than Durable Objects' bind limit", async () => {
      const store = context.getStore();
      const names = [
        ...Array.from({ length: 150 }, (_, index) => `missing-${index}`),
        "Alice",
        "Charlie",
      ];
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.in(names))
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results.toSorted()).toEqual(["Alice", "Charlie"]);
    });

    it("executes IN predicate with empty array (returns no results)", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.in([]))
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(0);
    });

    it("executes BETWEEN predicate", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.age.between(26, 32))
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["Alice", "Diana"]);
    });

    it("executes isNull predicate", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.email.isNull())
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toBe("Diana");
    });

    it("executes isNotNull predicate", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.email.isNotNull())
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(3);
      expect(results.toSorted()).toEqual(["Alice", "Bob", "Charlie"]);
    });
  });

  describe("List-Valued Parameters", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedPeopleForComplexPredicates(store);
    });

    it("reuses one prepared statement across different list lengths", async () => {
      const store = context.getStore();
      const prepared = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.in(parameter("names")))
        .select((ctx) => ctx.p.name)
        .prepare();

      // The whole point of the packed binding: arity is not part of the SQL
      // text, so the same compiled statement serves every list length.
      const three = await prepared.execute({
        names: ["Alice", "Charlie", "Eve"],
      });
      expect(three.toSorted()).toEqual(["Alice", "Charlie"]);

      const one = await prepared.execute({ names: ["Bob"] });
      expect(one.toSorted()).toEqual(["Bob"]);

      const none = await prepared.execute({ names: [] });
      expect(none).toEqual([]);

      // ...and the third call still agrees with the first, proving nothing
      // from an earlier arity was frozen into the cached template.
      const threeAgain = await prepared.execute({
        names: ["Alice", "Charlie", "Eve"],
      });
      expect(threeAgain.toSorted()).toEqual(["Alice", "Charlie"]);
    });

    it("agrees with the literal in() form for every element type", async () => {
      const store = context.getStore();
      const published = new Date("2024-03-01T00:00:00.000Z");
      await store.nodes.Document.create({
        title: "Dated",
        publishedAt: published,
      });
      await store.nodes.Document.create({
        title: "Other",
        publishedAt: new Date("2024-09-09T00:00:00.000Z"),
      });

      const names = ["Alice", "Diana", "Nobody"];
      await expectAgreement(
        () =>
          store
            .query()
            .from("Person", "p")
            .whereNode("p", (p) => p.name.in(names))
            .select((ctx) => ctx.p.name)
            .execute(),
        () =>
          store
            .query()
            .from("Person", "p")
            .whereNode("p", (p) => p.name.in(parameter("names")))
            .select((ctx) => ctx.p.name)
            .prepare()
            .execute({ names }),
        ["Alice", "Diana"],
      );

      const ages = [25, 35, 99];
      await expectAgreement(
        () =>
          store
            .query()
            .from("Person", "p")
            .whereNode("p", (p) => p.age.in(ages))
            .select((ctx) => ctx.p.name)
            .execute(),
        () =>
          store
            .query()
            .from("Person", "p")
            .whereNode("p", (p) => p.age.in(parameter("ages")))
            .select((ctx) => ctx.p.name)
            .prepare()
            .execute({ ages }),
        ["Bob", "Charlie"],
      );

      const flags = [false];
      await expectAgreement(
        () =>
          store
            .query()
            .from("Person", "p")
            .whereNode("p", (p) => p.isActive.in(flags))
            .select((ctx) => ctx.p.name)
            .execute(),
        () =>
          store
            .query()
            .from("Person", "p")
            .whereNode("p", (p) => p.isActive.in(parameter("flags")))
            .select((ctx) => ctx.p.name)
            .prepare()
            .execute({ flags }),
        ["Bob"],
      );

      const dates = [published];
      await expectAgreement(
        () =>
          store
            .query()
            .from("Document", "d")
            .whereNode("d", (d) => d.publishedAt.in(dates))
            .select((ctx) => ctx.d.title)
            .execute(),
        () =>
          store
            .query()
            .from("Document", "d")
            .whereNode("d", (d) => d.publishedAt.in(parameter("dates")))
            .select((ctx) => ctx.d.title)
            .prepare()
            .execute({ dates }),
        ["Dated"],
      );
    });

    it("binds a notIn list, including the empty list", async () => {
      const store = context.getStore();
      const prepared = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.notIn(parameter("names")))
        .select((ctx) => ctx.p.name)
        .prepare();

      const excluded = await prepared.execute({ names: ["Alice", "Bob"] });
      expect(excluded.toSorted()).toEqual(["Charlie", "Diana"]);

      // Excluding nothing must keep everyone — the mirror of `in([])`.
      const excludeNothing = await prepared.execute({ names: [] });
      expect(excludeNothing.toSorted()).toEqual([
        "Alice",
        "Bob",
        "Charlie",
        "Diana",
      ]);
    });

    it("binds a list far larger than the smallest bind budget", async () => {
      const store = context.getStore();
      // SQLite's conservative ceiling is 999 bound parameters and Durable
      // Objects' is lower still; a packed list costs exactly one regardless.
      const names = [
        ...Array.from({ length: 5000 }, (_, index) => `missing-${index}`),
        "Alice",
        "Charlie",
      ];

      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.in(parameter("names")))
        .select((ctx) => ctx.p.name)
        .prepare()
        .execute({ names });

      expect(results.toSorted()).toEqual(["Alice", "Charlie"]);
    });

    it("binds node ids — the canonical prepared id-set query", async () => {
      const store = context.getStore();
      const everyone = await store
        .query()
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }))
        .execute();
      const wanted = everyone.filter((person) =>
        ["Alice", "Charlie"].includes(person.name),
      );

      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.id.in(parameter("ids")))
        .select((ctx) => ctx.p.name)
        .prepare()
        .execute({ ids: wanted.map((person) => person.id) });

      expect(results.toSorted()).toEqual(["Alice", "Charlie"]);
    });

    it("binds number and boolean lists with the field's declared type", async () => {
      const store = context.getStore();

      const ages = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.age.in(parameter("ages")))
        .select((ctx) => ctx.p.name)
        .prepare()
        .execute({ ages: [25, 35] });
      expect(ages.toSorted()).toEqual(["Bob", "Charlie"]);

      const flags = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.isActive.in(parameter("flags")))
        .select((ctx) => ctx.p.name)
        .prepare()
        .execute({ flags: [false] });
      expect(flags.toSorted()).toEqual(["Bob"]);
    });

    it("composes with a scalar parameter in the same query", async () => {
      const store = context.getStore();
      const prepared = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) =>
          p.name.in(parameter("names")).and(p.age.gt(parameter("minAge"))),
        )
        .select((ctx) => ctx.p.name)
        .prepare();

      expect([...prepared.parameterNames].toSorted()).toEqual([
        "minAge",
        "names",
      ]);

      const older = await prepared.execute({
        minAge: 29,
        names: ["Alice", "Bob", "Charlie"],
      });
      expect(older.toSorted()).toEqual(["Alice", "Charlie"]);

      const younger = await prepared.execute({
        minAge: 20,
        names: ["Bob"],
      });
      expect(younger.toSorted()).toEqual(["Bob"]);
    });

    it("rejects a param() among the elements of a literal list", () => {
      const store = context.getStore();
      expect(() =>
        store
          .query()
          .from("Person", "p")
          .whereNode("p", (p) => p.name.in(["Alice", parameter("other")])),
      ).toThrow(/is not supported as an element of the in\(\) list/);
    });

    it("rejects a non-array binding for a list parameter", async () => {
      const store = context.getStore();
      const prepared = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.in(parameter("names")))
        .select((ctx) => ctx.p.name)
        .prepare();

      await expect(prepared.execute({ names: "Alice" })).rejects.toThrow(
        /must be an array for in\(\)\/notIn\(\)/,
      );
      await expect(
        // eslint-disable-next-line unicorn/no-null -- null bindings are rejected everywhere
        prepared.execute({ names: ["Alice", null] }),
      ).rejects.toThrow(/must not be null/);
    });

    it("rejects one parameter used as both a list and a scalar", () => {
      const store = context.getStore();
      expect(() =>
        store
          .query()
          .from("Person", "p")
          .whereNode("p", (p) =>
            p.name.in(parameter("value")).or(p.name.eq(parameter("value"))),
          )
          .select((ctx) => ctx.p.name)
          .prepare(),
      ).toThrow(/used both as an in\(\)\/notIn\(\) list and as a scalar value/);
    });
  });

  describe("Null predicates across stored value shapes", () => {
    it('isNull matches absent and JSON-null values but not the string "null"', async () => {
      const store = context.getStore();
      await seedNullShapeEdges(store);

      const nullWeights = await store
        .query()
        .from("Person", "p")
        .traverse("knows", "e")
        .whereEdge("e", (edge) => edge.weight.isNull())
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute();
      expect(nullWeights.toSorted()).toEqual([
        "ShapeJsonNull",
        "ShapeMissing",
        "ShapeStringNull",
      ]);

      const nullSince = await store
        .query()
        .from("Person", "p")
        .traverse("knows", "e")
        .whereEdge("e", (edge) => edge.since.isNull())
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute();
      // "ShapeStringNull" stores the string "null" in `since` — a real
      // value, so isNull must not match it.
      expect(nullSince.toSorted()).toEqual([
        "ShapeJsonNull",
        "ShapeMissing",
        "ShapeNumeric",
      ]);
    });

    it("isNotNull is the exact complement across value shapes", async () => {
      const store = context.getStore();
      await seedNullShapeEdges(store);

      const presentWeights = await store
        .query()
        .from("Person", "p")
        .traverse("knows", "e")
        .whereEdge("e", (edge) => edge.weight.isNotNull())
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute();
      expect(presentWeights).toEqual(["ShapeNumeric"]);

      const presentSince = await store
        .query()
        .from("Person", "p")
        .traverse("knows", "e")
        .whereEdge("e", (edge) => edge.since.isNotNull())
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute();
      expect(presentSince).toEqual(["ShapeStringNull"]);
    });

    it('pathIsNull / pathIsNotNull distinguish JSON null from the string "null"', async () => {
      // Regression for the PostgreSQL jsonPathIsNull dialect member, whose
      // former `#>> path = 'null'` text comparison went three-valued on a
      // stored JSON null (silently unmatched) and falsely matched the JSON
      // *string* "null".
      const store = context.getStore();
      await store.nodes.Document.create({
        title: "Reviewer JSON Null",
        // eslint-disable-next-line unicorn/no-null -- the JSON null value is the case under test
        metadata: { reviewer: null },
      });
      await store.nodes.Document.create({
        title: "Reviewer String Null",
        metadata: { reviewer: "null" },
      });
      await store.nodes.Document.create({
        title: "Reviewer Missing",
        metadata: {},
      });
      await store.nodes.Document.create({
        title: "Reviewer Present",
        metadata: { reviewer: "Ada" },
      });

      const nullish = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) => d.metadata.pathIsNull("/reviewer"))
        .select((ctx) => ctx.d.title)
        .execute();
      expect(nullish.toSorted()).toEqual([
        "Reviewer JSON Null",
        "Reviewer Missing",
      ]);

      const present = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) => d.metadata.pathIsNotNull("/reviewer"))
        .select((ctx) => ctx.d.title)
        .execute();
      expect(present.toSorted()).toEqual([
        "Reviewer Present",
        "Reviewer String Null",
      ]);
    });
  });

  describe("String Predicates", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedPeopleForStringPredicates(store);
    });

    it("matches with LIKE pattern (% wildcard)", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.email.like("%@test.%"))
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toEqual(["Bob Smith"]);
    });

    it("matches with LIKE pattern (_ single char wildcard)", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.email.like("___@%"))
        .select((ctx) => ctx.p.name)
        .execute();

      // Should match bob@test.org (3 chars before @) and eve.adams (wait, eve.adams is more than 3)
      // bob = 3 chars ✓
      expect(results).toContain("Bob Smith");
    });

    it("matches with case-insensitive ILIKE", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.email.ilike("%@example.com"))
        .select((ctx) => ctx.p.name)
        .execute();

      // Should match alice@example.com, charlie@Example.COM, and eve.adams@example.com
      expect(results).toHaveLength(3);
      expect(results.toSorted()).toEqual([
        "Alice Johnson",
        "CHARLIE BROWN",
        "Eve Adams",
      ]);
    });

    it("matches with startsWith", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.startsWith("A"))
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toBe("Alice Johnson");
    });

    it("matches with endsWith", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.endsWith("Smith"))
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toBe("Bob Smith");
    });

    it("matches with contains (substring)", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.contains("son"))
        .select((ctx) => ctx.p.name)
        .execute();

      // Alice Johnson contains "son"
      expect(results).toHaveLength(1);
      expect(results[0]).toBe("Alice Johnson");
    });

    it("combines string predicates with OR", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) =>
          p.name.startsWith("A").or(p.name.startsWith("B")),
        )
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["Alice Johnson", "Bob Smith"]);
    });

    it("handles special characters in LIKE patterns", async () => {
      // Add a person with special characters in email
      const store = context.getStore();
      await store.nodes.Person.create({
        name: "Special User",
        email: "user_name@test.com",
      });

      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.email.like("user_%@%"))
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toContain("Special User");
    });

    it("treats %, _, and backslash as literals in contains/startsWith (LIKE escape parity)", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({
        name: "Discount 100% off",
        email: "pct@test.com",
      });
      await store.nodes.Person.create({
        name: "Discount 100X off",
        email: "pctwild@test.com",
      });
      await store.nodes.Person.create({ name: "id_42", email: "us@test.com" });
      await store.nodes.Person.create({
        name: "idX42",
        email: "uswild@test.com",
      });
      await store.nodes.Person.create({
        name: String.raw`path\to\file`,
        email: "bs@test.com",
      });

      // A literal % must not act as a multi-char wildcard. Before the ESCAPE
      // fix this returned nothing on SQLite (no default LIKE escape char).
      const percent = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.contains("100%"))
        .select((ctx) => ctx.p.name)
        .execute();
      expect(percent.toSorted()).toEqual(["Discount 100% off"]);

      // A literal _ must not act as a single-char wildcard.
      const underscore = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.contains("id_"))
        .select((ctx) => ctx.p.name)
        .execute();
      expect(underscore.toSorted()).toEqual(["id_42"]);

      // A literal backslash must match a backslash, not act as an escape char.
      const backslash = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.startsWith(String.raw`path\to`))
        .select((ctx) => ctx.p.name)
        .execute();
      expect(backslash.toSorted()).toEqual([String.raw`path\to\file`]);
    });

    it("honors backslash escapes in raw like/ilike patterns (direct/prepared parity)", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "a_b", email: "und@test.com" });
      await store.nodes.Person.create({ name: "axb", email: "wild@test.com" });

      // Raw `like`: `\_` must be a literal underscore on every backend. Without
      // the ESCAPE clause on SQLite (no default escape char) this matched
      // nothing — diverging from Postgres and from the parameterized path.
      const literal = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.like(String.raw`a\_b`))
        .select((ctx) => ctx.p.name)
        .execute();
      expect(literal.toSorted()).toEqual(["a_b"]);

      // Same pattern through a bound parameter must agree with the literal path.
      const prepared = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.like(parameter("pattern")))
        .select((ctx) => ctx.p.name)
        .prepare();
      const parameterized = await prepared.execute({
        pattern: String.raw`a\_b`,
      });
      expect(parameterized.toSorted()).toEqual(["a_b"]);

      // Case-insensitive `ilike` honors the same escape, case-folded.
      const insensitive = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.ilike(String.raw`A\_B`))
        .select((ctx) => ctx.p.name)
        .execute();
      expect(insensitive.toSorted()).toEqual(["a_b"]);
    });
  });

  describe("Array Predicates", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedDocumentsForArrayPredicates(store);
    });

    it("finds documents where array contains a value", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) => d.tags.contains("typescript"))
        .select((ctx) => ctx.d.title)
        .execute();

      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["Doc 1", "Doc 2"]);
    });

    it("finds documents where array contains all values", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) => d.tags.containsAll(["typescript", "testing"]))
        .select((ctx) => ctx.d.title)
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toBe("Doc 1");
    });

    it("finds documents where array contains any of the values", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) => d.tags.containsAny(["python", "frontend"]))
        .select((ctx) => ctx.d.title)
        .execute();

      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["Doc 2", "Doc 3"]);
    });

    it("finds documents where array is empty or null", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) => d.tags.isEmpty())
        .select((ctx) => ctx.d.title)
        .execute();

      // isEmpty() matches both empty arrays ([]) and null/undefined
      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["Doc 4", "Doc 5"]);
    });

    it("finds documents where array is not empty", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) => d.tags.isNotEmpty())
        .select((ctx) => ctx.d.title)
        .execute();

      expect(results).toHaveLength(3);
      expect(results.toSorted()).toEqual(["Doc 1", "Doc 2", "Doc 3"]);
    });

    it("finds documents by array length", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) => d.tags.lengthGte(3))
        .select((ctx) => ctx.d.title)
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toBe("Doc 1");
    });
  });

  describe("Object/JSON Predicates", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedDocumentsForObjectPredicates(store);
    });

    it("finds documents where object has a key", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) => d.metadata.hasKey("author"))
        .select((ctx) => ctx.d.title)
        .execute();

      expect(results).toHaveLength(3);
      expect(results.toSorted()).toEqual([
        "Archived Doc",
        "Draft Doc",
        "Published Doc",
      ]);
    });

    it("finds documents where nested path equals value", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) => d.metadata.pathEquals("/author", "Alice"))
        .select((ctx) => ctx.d.title)
        .execute();

      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["Archived Doc", "Published Doc"]);
    });

    it("finds documents using chained .get() accessor", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) => d.metadata.get("author").eq("Bob"))
        .select((ctx) => ctx.d.title)
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toBe("Draft Doc");
    });

    it("finds documents with deeply nested path", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) =>
          d.metadata.get("flags").get("published").eq(true),
        )
        .select((ctx) => ctx.d.title)
        .execute();

      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["Archived Doc", "Published Doc"]);
    });

    it("finds documents where nested path is null", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) => d.metadata.pathIsNull("/author"))
        .select((ctx) => ctx.d.title)
        .execute();

      // Doc without metadata should match
      expect(results).toContain("No Metadata Doc");
    });

    it("combines object predicates with other predicates", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) =>
          d.metadata
            .get("author")
            .eq("Alice")
            .and(d.metadata.get("flags").get("archived").eq(false)),
        )
        .select((ctx) => ctx.d.title)
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toBe("Published Doc");
    });
  });
}
