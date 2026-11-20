import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, param as parameter } from "../../../src";
import { ConfigurationError } from "../../../src/errors";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

const Word = defineNode("PredicateWord", {
  schema: z.object({ text: z.string(), tags: z.array(z.string()) }),
});
const wordGraph = defineGraph({
  id: "string_predicate_parity",
  nodes: { PredicateWord: { type: Word } },
  edges: {},
});

/**
 * Words chosen so case, the LIKE wildcards, the LIKE escape character and
 * SQLite GLOB's own metacharacters (`*`, `?`, `[`) each separate one match
 * from its neighbours.
 */
const WORDS = [
  "abc",
  "ABC",
  "Abc",
  "abbc",
  "a_c",
  "a%c",
  "a*c",
  "a?c",
  "a[c",
  "a]c",
  String.raw`a\c`,
  "é",
  "É",
] as const;

async function seedWords(
  store: InspectableStore<typeof wordGraph>,
): Promise<void> {
  for (const text of WORDS) {
    await store.nodes.PredicateWord.create({ text, tags: ["x"] });
  }
}

type WordStore = InspectableStore<typeof wordGraph>;

async function likeMatches(
  store: WordStore,
  pattern: string,
): Promise<{ literal: string[]; parameter: string[] }> {
  const literal = await store
    .query()
    .from("PredicateWord", "w")
    .whereNode("w", (word) => word.text.like(pattern))
    .select((ctx) => ctx.w.text)
    .execute();
  const bound = await store
    .query()
    .from("PredicateWord", "w")
    .whereNode("w", (word) => word.text.like(parameter("pattern")))
    .select((ctx) => ctx.w.text)
    .prepare()
    .execute({ pattern });
  return { literal: literal.toSorted(), parameter: bound.toSorted() };
}

export function registerStringPredicateParityTests(
  context: IntegrationTestContext,
): void {
  describe("String predicate case and wildcard parity", () => {
    it.each([
      ["A%", ["ABC", "Abc"]],
      [
        "a%",
        [
          "a%c",
          "a*c",
          "a?c",
          "a[c",
          String.raw`a\c`,
          "a]c",
          "a_c",
          "abbc",
          "abc",
        ],
      ],
      [
        "a_c",
        ["a%c", "a*c", "a?c", "a[c", String.raw`a\c`, "a]c", "a_c", "abc"],
      ],
      ["a*c", ["a*c"]],
      ["a?c", ["a?c"]],
      ["a[c", ["a[c"]],
      ["a]c", ["a]c"]],
      [String.raw`a\%c`, ["a%c"]],
      [String.raw`a\_c`, ["a_c"]],
      [String.raw`a\\c`, [String.raw`a\c`]],
      [String.raw`a\*c`, ["a*c"]],
      ["%[%", ["a[c"]],
      [String.raw`a\\%`, [String.raw`a\c`]],
    ] as const)(
      "like(%j) is case-sensitive and matches GLOB metacharacters literally",
      async (pattern, expected) => {
        const store = await context.createStore(wordGraph);
        await seedWords(store);
        const sorted = [...expected].toSorted();
        expect(await likeMatches(store, pattern)).toEqual({
          literal: sorted,
          parameter: sorted,
        });
      },
    );

    it.each(["like", "ilike"] as const)(
      "refuses a literal %s pattern ending with an unpaired escape",
      (operator) => {
        const query = context.getStore().query().from("Person", "p");
        let refusal: unknown;
        try {
          query.whereNode("p", (person) => person.name[operator]("abc\\"));
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toBeInstanceOf(ConfigurationError);
        expect((refusal as ConfigurationError).details).toMatchObject({
          code: "LIKE_PATTERN_TRAILING_ESCAPE",
          operator,
        });
        // A doubled escape is a literal backslash, not a trailing escape.
        expect(() =>
          query.whereNode("p", (person) =>
            person.name[operator](String.raw`abc\\`),
          ),
        ).not.toThrow();
      },
    );

    it.each(["like", "ilike"] as const)(
      "matches nothing for a bound %s pattern ending with an unpaired escape",
      async (operator) => {
        const store = await context.createStore(wordGraph);
        await seedWords(store);
        const rows = await store
          .query()
          .from("PredicateWord", "w")
          .whereNode("w", (word) => word.text[operator](parameter("pattern")))
          .select((ctx) => ctx.w.text)
          .prepare()
          .execute({ pattern: "a\\" });
        expect(rows).toEqual([]);
      },
    );

    it("keeps contains, startsWith, endsWith and ilike case-insensitive for ASCII", async () => {
      const store = await context.createStore(wordGraph);
      await seedWords(store);
      const texts = async (
        predicate: "ilike" | "contains" | "startsWith" | "endsWith",
        value: string,
      ) => {
        const rows = await store
          .query()
          .from("PredicateWord", "w")
          .whereNode("w", (word) => word.text[predicate](value))
          .select((ctx) => ctx.w.text)
          .execute();
        return rows.toSorted();
      };
      expect({
        ilike: await texts("ilike", "abc"),
        contains: await texts("contains", "BC"),
        startsWith: await texts("startsWith", "AB"),
        endsWith: await texts("endsWith", "BC"),
      }).toEqual({
        ilike: ["ABC", "Abc", "abc"],
        contains: ["ABC", "Abc", "abbc", "abc"],
        startsWith: ["ABC", "Abc", "abbc", "abc"],
        endsWith: ["ABC", "Abc", "abbc", "abc"],
      });
    });

    // Case folding beyond ASCII is the engine's: SQLite's built-in LOWER()
    // folds A-Z only (unless the ICU extension is loaded), and PostgreSQL folds
    // per the database's LC_CTYPE, so no single answer holds on PostgreSQL.
    // The SQLite answer is fixed, and documented, so it is pinned here.
    it("folds only ASCII case in ilike on SQLite", async (ctx) => {
      const store = await context.createStore(wordGraph);
      if (store.backend.dialect !== "sqlite") ctx.skip();
      await seedWords(store);
      const rows = await store
        .query()
        .from("PredicateWord", "w")
        .whereNode("w", (word) => word.text.ilike("é"))
        .select((ctx) => ctx.w.text)
        .execute();
      expect(rows).toEqual(["é"]);
    });

    it("offers array length only through the length* predicates", async () => {
      const store = await context.createStore(wordGraph);
      await seedWords(store);
      const query = store.query().from("PredicateWord", "w");
      const rows = await query
        .whereNode("w", (word) => word.tags.lengthGte(1))
        .select((ctx) => ctx.w.text)
        .execute();
      expect(rows).toHaveLength(WORDS.length);
      // `length` was typed but never built, so it threw at runtime.
      /* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- calls the removed accessor the way old code did */
      const callRemovedLength = () =>
        query.whereNode("w", (word) =>
          // @ts-expect-error ArrayFieldAccessor has no `length` accessor.
          word.tags.length.gt(0),
        );
      /* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
      expect(callRemovedLength).toThrow(TypeError);
    });
  });
}
