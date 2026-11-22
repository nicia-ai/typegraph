import { describe, expect, it } from "vitest";

import { count, expr, field } from "../../../src";
import type { IntegrationStore } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

/**
 * Category `x` holds one article, `y` two, `z` three, all with the same
 * matching text, so every match ranks equally on every fulltext engine and
 * the caller's `orderBy()` alone decides the group order. Category `w` does
 * not match the text. Each category's embedding is one axis, so the distance
 * from `QUERY_VECTOR` orders the categories `x`, `y`, `z`, `w` on every
 * vector engine.
 */
const CATEGORY_EMBEDDINGS = {
  x: [1, 0, 0, 0],
  y: [0, 1, 0, 0],
  z: [0, 0, 1, 0],
  w: [0, 0, 0, 1],
} as const;
const QUERY_VECTOR = [1, 0.5, 0.2, 0];

async function seedCategories(store: IntegrationStore): Promise<void> {
  const articles: readonly (readonly [
    keyof typeof CATEGORY_EMBEDDINGS,
    string,
  ])[] = [
    ["x", "Climate notes"],
    ["y", "Climate notes"],
    ["y", "Climate notes"],
    ["z", "Climate notes"],
    ["z", "Climate notes"],
    ["z", "Climate notes"],
    ["w", "Energy outlook"],
  ];
  for (const [category, title] of articles) {
    await store.nodes.Article.create({
      title,
      body: title,
      category,
      published: true,
      embedding: [...CATEGORY_EMBEDDINGS[category]],
    });
  }
}

type CategoryCount = Readonly<{ category: string; n: number }>;

function sortByCategory(
  rows: readonly CategoryCount[],
): readonly CategoryCount[] {
  return rows.toSorted((left, right) =>
    left.category.localeCompare(right.category),
  );
}

function storeWith(
  context: IntegrationTestContext,
  ctx: { skip: () => void },
  capabilities: readonly ("fulltext" | "vector")[],
): IntegrationStore {
  const store = context.getStore();
  for (const capability of capabilities) {
    if (store.backend.capabilities[capability]?.supported !== true) ctx.skip();
  }
  return store;
}

function fulltextGroups(store: IntegrationStore) {
  return store
    .query()
    .from("Article", "a")
    .whereNode("a", (a) => a.$fulltext.matches("climate", 10))
    .groupBy("a", "category")
    .aggregate({ category: field("a", "category"), n: count("a") });
}

export function registerGroupedSearchIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Grouped and aggregated search queries", () => {
    it("groups fulltext matches and orders equally relevant groups by the caller's aggregate order", async (ctx) => {
      const store = storeWith(context, ctx, ["fulltext"]);
      await seedCategories(store);

      expect(
        await fulltextGroups(store).orderBy("n", "desc").execute(),
      ).toEqual([
        { category: "z", n: 3 },
        { category: "y", n: 2 },
        { category: "x", n: 1 },
      ]);
      expect(await fulltextGroups(store).orderBy("n", "asc").execute()).toEqual(
        [
          { category: "x", n: 1 },
          { category: "y", n: 2 },
          { category: "z", n: 3 },
        ],
      );
    });

    it("aggregates fulltext matches without grouping", async (ctx) => {
      const store = storeWith(context, ctx, ["fulltext"]);
      await seedCategories(store);

      const counted = await store
        .query()
        .from("Article", "a")
        .whereNode("a", (a) => a.$fulltext.matches("climate", 10))
        .aggregate({ n: count("a") })
        .execute();
      expect(counted).toEqual([{ n: 6 }]);

      const projected = await store
        .query()
        .from("Article", "a")
        .whereNode("a", (a) => a.$fulltext.matches("climate", 10))
        .project((expressions) => ({ n: expr.count(expressions.a.id) }))
        .execute();
      expect(projected).toEqual([{ n: 6 }]);
    });

    it("orders vector groups by their nearest member and limits the groups", async (ctx) => {
      const store = storeWith(context, ctx, ["vector"]);
      await seedCategories(store);

      const groups = () =>
        store
          .query()
          .from("Article", "a")
          .whereNode("a", (a) => a.embedding.similarTo(QUERY_VECTOR, 10))
          .groupBy("a", "category")
          .aggregate({ category: field("a", "category"), n: count("a") });

      expect(await groups().execute()).toEqual([
        { category: "x", n: 1 },
        { category: "y", n: 2 },
        { category: "z", n: 3 },
        { category: "w", n: 1 },
      ]);
      expect(await groups().limit(2).execute()).toEqual([
        { category: "x", n: 1 },
        { category: "y", n: 2 },
      ]);
    });

    it("groups hybrid matches", async (ctx) => {
      const store = storeWith(context, ctx, ["fulltext", "vector"]);
      await seedCategories(store);

      const rows = await store
        .query()
        .from("Article", "a")
        .whereNode("a", (a) =>
          a.$fulltext
            .matches("climate", 10)
            .and(a.embedding.similarTo(QUERY_VECTOR, 10)),
        )
        .groupBy("a", "category")
        .aggregate({ category: field("a", "category"), n: count("a") })
        .execute();
      expect(sortByCategory(rows)).toEqual([
        { category: "w", n: 1 },
        { category: "x", n: 1 },
        { category: "y", n: 2 },
        { category: "z", n: 3 },
      ]);
    });
  });
}
