import { describe, expect, it } from "vitest";

import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

/**
 * An alias with an uppercase letter becomes part of generated SQL names
 * (`cte_Doc`, `Doc_id`). PostgreSQL folds an unquoted name to lower case and
 * keeps a quoted one as written, so every reference must be spelled like the
 * declaration. These cases run the builders that read an alias CTE from a
 * second relation: the relevance subquery of fulltext, vector and hybrid
 * search, and the top-K page of a late-materialized `orderBy()` + `limit()`.
 */
const AXES = {
  climate: [1, 0, 0, 0],
  cuisine: [0, 1, 0, 0],
  energy: [0, 0, 1, 0],
} as const;
const QUERY_VECTOR = [1, 0.5, 0.2, 0];

async function seedArticles(store: IntegrationStore): Promise<void> {
  const articles: readonly (readonly [string, keyof typeof AXES])[] = [
    ["Climate change drivers", "climate"],
    ["Climate cuisine guide", "cuisine"],
    ["Renewable energy outlook", "energy"],
  ];
  for (const [title, axis] of articles) {
    await store.nodes.Article.create({
      title,
      body: title,
      category: axis,
      published: true,
      embedding: [...AXES[axis]],
    });
  }
}

function sortedTitles(rows: readonly { title: string }[]): readonly string[] {
  return rows.map((row) => row.title).toSorted();
}

function requireCapabilities(
  store: IntegrationStore,
  ctx: { skip: () => void },
  capabilities: readonly ("fulltext" | "vector")[],
): void {
  for (const capability of capabilities) {
    if (store.backend.capabilities[capability]?.supported !== true) ctx.skip();
  }
}

export function registerMixedCaseAliasIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Mixed-case aliases", () => {
    it("run a fulltext query rooted at the alias", async (ctx) => {
      const store = context.getStore();
      requireCapabilities(store, ctx, ["fulltext"]);
      await seedArticles(store);

      const rows = await store
        .query()
        .from("Article", "Doc")
        .whereNode("Doc", (document) =>
          document.$fulltext.matches("climate", 10),
        )
        .select((row) => ({ title: row.Doc.title }))
        .execute();
      expect(sortedTitles(rows)).toEqual([
        "Climate change drivers",
        "Climate cuisine guide",
      ]);
    });

    it("run a vector query rooted at the alias", async (ctx) => {
      const store = context.getStore();
      requireCapabilities(store, ctx, ["vector"]);
      await seedArticles(store);

      const rows = await store
        .query()
        .from("Article", "Doc")
        .whereNode("Doc", (document) =>
          document.embedding.similarTo(QUERY_VECTOR, 2),
        )
        .select((row) => ({ title: row.Doc.title }))
        .execute();
      expect(rows).toEqual([
        { title: "Climate change drivers" },
        { title: "Climate cuisine guide" },
      ]);
    });

    it("run a hybrid query rooted at the alias", async (ctx) => {
      const store = context.getStore();
      requireCapabilities(store, ctx, ["fulltext", "vector"]);
      await seedArticles(store);

      const rows = await store
        .query()
        .from("Article", "Doc")
        .whereNode("Doc", (document) =>
          document.$fulltext
            .matches("climate", 10)
            .and(document.embedding.similarTo(QUERY_VECTOR, 10)),
        )
        .select((row) => ({ title: row.Doc.title }))
        .execute();
      expect(sortedTitles(rows)).toEqual([
        "Climate change drivers",
        "Climate cuisine guide",
        "Renewable energy outlook",
      ]);
    });

    it("page a late-materialized traversal through mixed-case aliases", async () => {
      const store = await context.createStore(integrationTestGraph, {
        queryDefaults: { traversalExpansion: "none" },
      });
      const root = await store.nodes.Person.create({ name: "Root" });
      for (const [name, age] of [
        ["Frida", 40],
        ["Gus", 35],
        ["Hana", 30],
      ] as const) {
        const friend = await store.nodes.Person.create({
          name,
          age,
          email: `${name.toLowerCase()}@example.com`,
        });
        await store.edges.knows.create(root, friend, {});
      }

      const rows = await store
        .query()
        .from("Person", "Root")
        .whereNode("Root", (person) => person.name.eq("Root"))
        .traverse("knows", "Edge", { expand: "none", direction: "out" })
        .to("Person", "Friend")
        .select((row) => ({ name: row.Friend.name, email: row.Friend.email }))
        .orderBy("Friend", "age", "desc")
        .limit(2)
        .execute();
      expect(rows).toEqual([
        { name: "Frida", email: "frida@example.com" },
        { name: "Gus", email: "gus@example.com" },
      ]);
    });
  });
}
