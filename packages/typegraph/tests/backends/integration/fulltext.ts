/**
 * Fulltext and hybrid-search integration tests.
 *
 * Runs against any backend that declares `capabilities.fulltext.supported`.
 * Skipped cleanly on backends without fulltext support so third-party
 * `GraphBackend` implementations don't need to opt in.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { type IntegrationStore } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

type ArticleProps = Readonly<{
  title: string;
  body: string;
  category: string;
  published: boolean;
}>;

async function seedArticles(
  store: IntegrationStore,
): Promise<Readonly<Record<string, string>>> {
  const [climate, cuisine, energy, draft] = await Promise.all([
    store.nodes.Article.create({
      title: "Climate change drivers",
      body: "Rising global temperatures linked to greenhouse gas emissions.",
      category: "science",
      published: true,
    }),
    store.nodes.Article.create({
      title: "Local cuisine guide",
      body: "Ten restaurants worth visiting in town this weekend.",
      category: "lifestyle",
      published: true,
    }),
    store.nodes.Article.create({
      title: "Renewable energy outlook",
      body: "Solar and wind capacity projected to surpass coal by 2030.",
      category: "science",
      published: true,
    }),
    store.nodes.Article.create({
      title: "Draft: climate research roundup",
      body: "Unfinished notes on recent climate-adjacent studies.",
      category: "science",
      published: false,
    }),
  ]);

  return {
    climate: climate.id,
    cuisine: cuisine.id,
    energy: energy.id,
    draft: draft.id,
  };
}

export function registerFulltextIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Fulltext search", () => {
    let skipReason: string | undefined;

    beforeEach(() => {
      const backend = context.getStore().backend;
      skipReason =
        backend.capabilities.fulltext?.supported === true ?
          undefined
        : `${backend.dialect} backend lacks fulltext support`;
    });

    function skipIfUnsupported(ctx: { skip: () => void }): IntegrationStore {
      if (skipReason !== undefined) {
        ctx.skip();
      }
      return context.getStore();
    }

    // ================================================================
    // Basic search semantics
    // ================================================================

    it("ranks matching documents by relevance", async (ctx) => {
      const store = skipIfUnsupported(ctx);
      const ids = await seedArticles(store);

      const results = await store.search.fulltext("Article", {
        query: "climate temperatures",
        limit: 10,
      });

      const resultIds = results.map((r) => r.node.id);
      expect(resultIds).toContain(ids.climate);
      // Every result is a genuine match — ordered by score DESC with
      // rank = 1-based position.
      expect(results[0]?.rank).toBe(1);
      expect(results[0]?.score).toBeGreaterThan(0);
    });

    it("matches terms that span multiple searchable fields", async (ctx) => {
      const store = skipIfUnsupported(ctx);
      const ids = await seedArticles(store);

      // "climate" is in the title of the first article; "temperatures"
      // is in its body. A single query finds both because fields are
      // concatenated into one indexed document.
      const results = await store.search.fulltext("Article", {
        query: "climate temperatures",
        limit: 10,
      });
      expect(results.map((r) => r.node.id)).toContain(ids.climate);
    });

    it("supports websearch-mode negation", async (ctx) => {
      const store = skipIfUnsupported(ctx);
      const ids = await seedArticles(store);

      const results = await store.search.fulltext("Article", {
        query: "climate -draft",
        mode: "websearch",
        limit: 10,
      });
      const resultIds = results.map((r) => r.node.id);
      expect(resultIds).toContain(ids.climate);
      expect(resultIds).not.toContain(ids.draft);
    });

    it("returns highlighted snippets when includeSnippets is set", async (ctx) => {
      const store = skipIfUnsupported(ctx);
      await seedArticles(store);

      const results = await store.search.fulltext("Article", {
        query: "climate",
        limit: 1,
        includeSnippets: true,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.snippet).toBeDefined();
      expect(results[0]?.snippet?.toLowerCase()).toMatch(/climate/);
    });

    it("rejects non-positive limit", async (ctx) => {
      const store = skipIfUnsupported(ctx);
      await expect(
        store.search.fulltext("Article", { query: "anything", limit: 0 }),
      ).rejects.toThrow(/positive integer/);
    });

    // ================================================================
    // Sync lifecycle
    // ================================================================

    it("indexes on create, re-indexes on update, removes on soft delete", async (ctx) => {
      const store = skipIfUnsupported(ctx);
      const article = await store.nodes.Article.create({
        title: "Original title",
        body: "Original body content.",
        category: "meta",
        published: true,
      });

      // Create → indexed
      let results = await store.search.fulltext("Article", {
        query: "original",
        limit: 10,
      });
      expect(results.map((r) => r.node.id)).toContain(article.id);

      // Update → re-indexed
      await store.nodes.Article.update(article.id, {
        title: "Updated heading",
        body: "Updated body material.",
      });
      results = await store.search.fulltext("Article", {
        query: "original",
        limit: 10,
      });
      expect(results.map((r) => r.node.id)).not.toContain(article.id);
      results = await store.search.fulltext("Article", {
        query: "updated",
        limit: 10,
      });
      expect(results.map((r) => r.node.id)).toContain(article.id);

      // Soft delete → removed
      await store.nodes.Article.delete(article.id);
      results = await store.search.fulltext("Article", {
        query: "updated",
        limit: 10,
      });
      expect(results.map((r) => r.node.id)).not.toContain(article.id);
    });

    it("removes the fulltext row on hard delete cascade", async (ctx) => {
      const store = skipIfUnsupported(ctx);
      const article = await store.nodes.Article.create({
        title: "Ephemeral article",
        body: "To be purged permanently.",
        category: "meta",
        published: true,
      });
      await store.nodes.Article.hardDelete(article.id);

      const results = await store.search.fulltext("Article", {
        query: "ephemeral",
        limit: 10,
      });
      expect(results.map((r) => r.node.id)).not.toContain(article.id);
    });

    it("deletes the fulltext row when all searchable fields become empty", async (ctx) => {
      const store = skipIfUnsupported(ctx);
      const article = await store.nodes.Article.create({
        title: "Clearable title",
        body: "Clearable body.",
        category: "meta",
        published: true,
      });

      await store.nodes.Article.update(article.id, {
        title: "",
        body: "",
      });

      const results = await store.search.fulltext("Article", {
        query: "clearable",
        limit: 10,
      });
      expect(results.map((r) => r.node.id)).not.toContain(article.id);
    });

    // ================================================================
    // Query-builder integration
    // ================================================================

    it(".matches() composes with metadata predicates", async (ctx) => {
      const store = skipIfUnsupported(ctx);
      const ids = await seedArticles(store);

      // "climate" matches both the published `climate` article and the
      // unpublished `draft` — adding `.and(published.eq(true))` filters
      // out the draft.
      const results = await store
        .query()
        .from("Article", "a")
        .whereNode("a", (a) =>
          a.$fulltext.matches("climate", 10).and(a.published.eq(true)),
        )
        .select((c) => c.a as unknown as ArticleProps & { id: string })
        .execute();

      const resultIds = results.map((r) => r.id);
      expect(resultIds).toContain(ids.climate);
      expect(resultIds).not.toContain(ids.draft);
    });

    it(".matches() applies top-k after metadata filters", async (ctx) => {
      const store = skipIfUnsupported(ctx);
      await store.nodes.Article.create({
        title: "Climate climate climate climate climate",
        body: "globally strongest hit but unpublished",
        category: "science",
        published: false,
      });
      const published = await store.nodes.Article.create({
        title: "Climate report",
        body: "the best hit inside the published scope",
        category: "science",
        published: true,
      });

      const results = await store
        .query()
        .from("Article", "a")
        .whereNode("a", (a) =>
          a.$fulltext.matches("climate", 1).and(a.published.eq(true)),
        )
        .select((c) => c.a as unknown as ArticleProps & { id: string })
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe(published.id);
    });

    it(".matches() composes with category filters", async (ctx) => {
      const store = skipIfUnsupported(ctx);
      const ids = await seedArticles(store);

      const results = await store
        .query()
        .from("Article", "a")
        .whereNode("a", (a) =>
          a.$fulltext
            .matches("energy OR climate", 10)
            .and(a.category.eq("science")),
        )
        .select((c) => c.a as unknown as ArticleProps & { id: string })
        .execute();

      const resultIds = results.map((r) => r.id);
      // Both science articles with matching body content appear; the
      // lifestyle cuisine article does not.
      expect(resultIds).toContain(ids.climate);
      expect(resultIds).toContain(ids.energy);
      expect(resultIds).not.toContain(ids.cuisine);
    });

    it(".matches() rejects placement under OR / NOT", async (ctx) => {
      const store = skipIfUnsupported(ctx);
      await seedArticles(store);

      await expect(
        store
          .query()
          .from("Article", "a")
          .whereNode("a", (a) =>
            a.$fulltext.matches("climate", 10).or(a.category.eq("science")),
          )
          .select((c) => ({ id: (c.a as unknown as { id: string }).id }))
          .execute(),
      ).rejects.toThrow(/cannot be nested under OR or NOT/i);
    });

    // ================================================================
    // Rebuild — exercises the backend's batch-upsert path on each dialect.
    // Previously only covered via SQLite in `tests/fulltext-rebuild.test.ts`;
    // running this in the cross-dialect suite also pins the PG
    // `ON CONFLICT DO UPDATE` batch tuple (with `::regconfig` casts) and
    // the per-backend DDL bootstrap.
    // ================================================================

    it("rebuildFulltext repopulates the index after a drop-and-truncate", async (ctx) => {
      const store = skipIfUnsupported(ctx);
      const ids = await seedArticles(store);

      // Wipe the fulltext index without touching the nodes — simulating
      // a `TRUNCATE typegraph_node_fulltext` recovery scenario. Writing
      // raw SQL stays dialect-portable via `backend.execute`.
      for (const id of Object.values(ids)) {
        await store.backend.deleteFulltext?.({
          graphId: store.graphId,
          nodeKind: "Article",
          nodeId: id,
        });
      }

      const emptyHits = await store.search.fulltext("Article", {
        query: "climate",
        limit: 10,
      });
      expect(emptyHits).toHaveLength(0);

      const stats = await store.search.rebuildFulltext("Article");
      expect(stats.kinds).toEqual(["Article"]);
      // Every seeded article has non-empty searchable content.
      expect(stats.upserted).toBe(Object.keys(ids).length);
      expect(stats.skipped).toBe(0);

      const restored = await store.search.fulltext("Article", {
        query: "climate",
        limit: 10,
      });
      expect(restored.map((hit) => hit.node.id)).toContain(ids.climate);
    });
  });
}
