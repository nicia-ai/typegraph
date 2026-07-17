import { beforeEach, describe, expect, it } from "vitest";

import { param as parameter } from "../../../src";
import {
  seedDocumentsForArrayPredicates,
  seedDocumentsForObjectPredicates,
  seedPeopleForComplexPredicates,
  seedPeopleForStringPredicates,
} from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

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
