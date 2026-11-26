/**
 * A fulltext or vector predicate in a query that compiles to a recursive
 * statement.
 *
 * Those predicates are top-k candidate sets with a relevance order, which
 * only the standard statement's relevance joins apply. A recursive statement
 * (a variable-length traversal that does not lower to one hop) used to compile
 * them to a constant-true term, so the filter was silently dropped and every
 * reachable node came back. The query is now refused with a typed error on
 * every terminal; a single-hop recursive traversal, which lowers to the
 * standard statement, keeps applying the predicate.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { UnsupportedPredicateError } from "../../../src/errors";
import { type IntegrationStore } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

type Seeded = Readonly<{
  authorId: string;
  climateIds: readonly string[];
}>;

async function seedAuthorWithArticles(
  store: IntegrationStore,
): Promise<Seeded> {
  const author = await store.nodes.Person.create({ name: "Author" });
  const titles = [
    "Climate outlook",
    "Climate report",
    "Museum opening hours",
  ] as const;
  const articles = [];
  for (const [index, title] of titles.entries()) {
    const article = await store.nodes.Article.create({
      title,
      body: "ordinary corpus text",
      category: "recursive-relevance",
      published: true,
      embedding: index === 0 ? [1, 0, 0, 0] : [0, 1, 0, 0],
    });
    await store.edges.authoredBy.create(article, author, {});
    articles.push(article);
  }
  return {
    authorId: author.id,
    climateIds: articles.slice(0, 2).map((article) => article.id),
  };
}

function expectRecursiveRelevanceRefusal(
  error: unknown,
  predicate: "fulltext_match" | "vector_similarity",
  alias: string,
): void {
  expect(error).toBeInstanceOf(UnsupportedPredicateError);
  expect((error as UnsupportedPredicateError).details).toEqual({
    predicate,
    alias,
    reason: "recursive_traversal",
  });
}

function expectRecursiveFusionRefusal(error: unknown): void {
  expect(error).toBeInstanceOf(UnsupportedPredicateError);
  expect((error as UnsupportedPredicateError).details).toEqual({
    option: "fuseWith",
    reason: "recursive_traversal",
  });
}

async function captureRejection(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

export function registerRecursiveRelevancePredicateIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Relevance predicates on recursive traversals", () => {
    let store: IntegrationStore;

    beforeEach(() => {
      store = context.getStore();
    });

    function skipUnlessFulltext(ctx: { skip: () => void }): void {
      if (store.backend.capabilities.fulltext?.supported !== true) ctx.skip();
    }

    function skipUnlessVector(ctx: { skip: () => void }): void {
      if (store.backend.capabilities.vector?.supported !== true) ctx.skip();
    }

    function articlesByAuthor(
      authorId: string,
      recursive: Readonly<{ maxHops: number; depth?: true }>,
    ) {
      return store
        .query()
        .from("Person", "author")
        .whereNode("author", (author) => author.id.eq(authorId))
        .traverse("authoredBy", "e", { direction: "in" })
        .recursive(recursive)
        .to("Article", "article");
    }

    it("refuses $fulltext.matches() on the target of a multi-hop recursive traversal on every terminal", async (ctx) => {
      skipUnlessFulltext(ctx);
      const { authorId } = await seedAuthorWithArticles(store);
      const query = articlesByAuthor(authorId, { maxHops: 3 })
        .whereNode("article", (article) =>
          article.$fulltext.matches("climate", 10),
        )
        .select((select) => ({ id: select.article.id }));

      for (const terminal of [
        () => query.toSQL(),
        () => query.execute(),
        () => query.first(),
        () => query.count(),
        () => query.exists(),
        () => query.prepare().execute(),
      ]) {
        expectRecursiveRelevanceRefusal(
          await captureRejection(terminal),
          "fulltext_match",
          "article",
        );
      }
    });

    it("refuses $fulltext.matches() on the start alias of a multi-hop recursive traversal", async (ctx) => {
      skipUnlessFulltext(ctx);
      await seedAuthorWithArticles(store);
      const query = store
        .query()
        .from("Article", "article")
        .whereNode("article", (article) =>
          article.$fulltext.matches("climate", 10),
        )
        .traverse("authoredBy", "e")
        .recursive({ maxHops: 3 })
        .to("Person", "author")
        .select((select) => ({ id: select.author.id }));

      expectRecursiveRelevanceRefusal(
        await captureRejection(() => query.execute()),
        "fulltext_match",
        "article",
      );
    });

    it("refuses a one-hop recursive traversal that still compiles recursively (depth projected)", async (ctx) => {
      skipUnlessFulltext(ctx);
      const { authorId } = await seedAuthorWithArticles(store);
      const query = articlesByAuthor(authorId, { maxHops: 1, depth: true })
        .whereNode("article", (article) =>
          article.$fulltext.matches("climate", 10),
        )
        .select((select) => ({ id: select.article.id }));

      expectRecursiveRelevanceRefusal(
        await captureRejection(() => query.execute()),
        "fulltext_match",
        "article",
      );
    });

    it("refuses $fulltext.matches() on the recursive stage of a chained query", async (ctx) => {
      skipUnlessFulltext(ctx);
      const { authorId } = await seedAuthorWithArticles(store);
      const reader = await store.nodes.Person.create({ name: "Reader" });
      await store.edges.knows.create(
        reader,
        { kind: "Person", id: authorId },
        {},
      );
      const query = store
        .query()
        .from("Person", "reader")
        .whereNode("reader", (person) => person.id.eq(reader.id))
        .traverse("knows", "k")
        .to("Person", "author")
        .traverse("authoredBy", "e", { direction: "in" })
        .recursive({ maxHops: 1 })
        .to("Article", "article")
        .whereNode("article", (article) =>
          article.$fulltext.matches("climate", 10),
        )
        .select((select) => ({ id: select.article.id }));

      expectRecursiveRelevanceRefusal(
        await captureRejection(() => query.execute()),
        "fulltext_match",
        "article",
      );
    });

    it("keeps applying $fulltext.matches() on a fixed stage chained before a recursive stage", async (ctx) => {
      skipUnlessFulltext(ctx);
      const { authorId, climateIds } = await seedAuthorWithArticles(store);
      const rows = await store
        .query()
        .from("Article", "article")
        .whereNode("article", (article) =>
          article.$fulltext.matches("climate", 10),
        )
        .traverse("authoredBy", "e")
        .to("Person", "author")
        .traverse("knows", "k", { direction: "in" })
        .recursive({ minHops: 0, maxHops: 2 })
        .to("Person", "reader")
        .select((select) => ({
          article: select.article.id,
          reader: select.reader.id,
        }))
        .execute();

      expect(rows.map((row) => row.article).toSorted()).toEqual(
        [...climateIds].toSorted(),
      );
      expect(new Set(rows.map((row) => row.reader))).toEqual(
        new Set([authorId]),
      );
    });

    it("keeps applying $fulltext.matches() on the start alias of an optional first recursive traversal", async (ctx) => {
      skipUnlessFulltext(ctx);
      const { climateIds } = await seedAuthorWithArticles(store);
      const rows = await store
        .query()
        .from("Article", "article")
        .whereNode("article", (article) =>
          article.$fulltext.matches("climate", 10),
        )
        .optionalTraverse("authoredBy", "e")
        .recursive({ maxHops: 2 })
        .to("Person", "author")
        .select((select) => ({ article: select.article.id }))
        .execute();

      expect(rows.map((row) => row.article).toSorted()).toEqual(
        [...climateIds].toSorted(),
      );
    });

    it("refuses similarTo() on the target of a multi-hop recursive traversal", async (ctx) => {
      skipUnlessVector(ctx);
      const { authorId } = await seedAuthorWithArticles(store);
      const query = articlesByAuthor(authorId, { maxHops: 3 })
        .whereNode("article", (article) =>
          article.embedding.similarTo([1, 0, 0, 0], 1),
        )
        .select((select) => ({ id: select.article.id }));

      expectRecursiveRelevanceRefusal(
        await captureRejection(() => query.execute()),
        "vector_similarity",
        "article",
      );
    });

    it("filters a fixed stage chained before a recursive stage to its top-k set and orders rows by orderBy() alone", async (ctx) => {
      skipUnlessVector(ctx);
      const author = await store.nodes.Person.create({ name: "Author" });
      // Created nearest first, so the stored order is the relevance order;
      // the titles sort in the reverse of that order.
      const candidates = [
        ["Zebra notes", [1, 0, 0, 0]],
        ["Apple notes", [0.8, 0.6, 0, 0]],
        ["Mango notes", [0, 0, 0, 1]],
      ] as const;
      for (const [title, vector] of candidates) {
        const article = await store.nodes.Article.create({
          title,
          body: "ordinary corpus text",
          category: "recursive-relevance",
          published: true,
          embedding: [...vector],
        });
        await store.edges.authoredBy.create(article, author, {});
      }
      const query = store
        .query()
        .from("Article", "article")
        .whereNode("article", (article) =>
          article.embedding.similarTo([1, 0, 0, 0], 2),
        )
        .traverse("authoredBy", "e")
        .to("Person", "author")
        .traverse("knows", "k", { direction: "in" })
        .recursive({ minHops: 0, maxHops: 2 })
        .to("Person", "reader")
        .orderBy("article", "title", "asc")
        .select((select) => ({ title: select.article.title }));

      expect(await query.execute()).toEqual([
        { title: "Apple notes" },
        { title: "Zebra notes" },
      ]);
      expect(await query.first()).toEqual({ title: "Apple notes" });
    });

    it("refuses fuseWith() on a chain whose hybrid predicates sit on a fixed stage after a recursive one", async (ctx) => {
      skipUnlessFulltext(ctx);
      skipUnlessVector(ctx);
      const { authorId } = await seedAuthorWithArticles(store);
      const query = store
        .query()
        .from("Person", "reader")
        .traverse("knows", "k")
        .recursive({ minHops: 0, maxHops: 2 })
        .to("Person", "author")
        .whereNode("author", (author) => author.id.eq(authorId))
        .traverse("authoredBy", "e", { direction: "in" })
        .to("Article", "article")
        .whereNode("article", (article) =>
          article.embedding.similarTo([1, 0, 0, 0], 10),
        )
        .whereNode("article", (article) =>
          article.$fulltext.matches("climate", 10),
        )
        .fuseWith({ k: 10, weights: { vector: 2, fulltext: 1 } })
        .select((select) => ({ id: select.article.id }));

      for (const terminal of [() => query.toSQL(), () => query.execute()]) {
        expectRecursiveFusionRefusal(await captureRejection(terminal));
      }
    });

    it("refuses fuseWith() on a chain whose hybrid predicates sit on its fixed first stage", async (ctx) => {
      skipUnlessFulltext(ctx);
      skipUnlessVector(ctx);
      await seedAuthorWithArticles(store);
      const query = store
        .query()
        .from("Article", "article")
        .whereNode("article", (article) =>
          article.embedding.similarTo([1, 0, 0, 0], 10),
        )
        .whereNode("article", (article) =>
          article.$fulltext.matches("climate", 10),
        )
        .traverse("authoredBy", "e")
        .to("Person", "author")
        .traverse("knows", "k", { direction: "in" })
        .recursive({ minHops: 0, maxHops: 2 })
        .to("Person", "reader")
        .fuseWith({ k: 10 })
        .select((select) => ({ id: select.article.id }));

      expectRecursiveFusionRefusal(
        await captureRejection(() => query.execute()),
      );
    });

    it("refuses fuseWith() on a lone recursive traversal", async () => {
      const { authorId } = await seedAuthorWithArticles(store);
      const query = articlesByAuthor(authorId, { maxHops: 3 })
        .fuseWith({ k: 10 })
        .select((select) => ({ id: select.article.id }));

      expectRecursiveFusionRefusal(
        await captureRejection(() => query.execute()),
      );
    });

    it("keeps applying $fulltext.matches() on a recursive traversal that lowers to one hop", async (ctx) => {
      skipUnlessFulltext(ctx);
      const { authorId, climateIds } = await seedAuthorWithArticles(store);
      const rows = await articlesByAuthor(authorId, { maxHops: 1 })
        .whereNode("article", (article) =>
          article.$fulltext.matches("climate", 10),
        )
        .select((select) => ({ id: select.article.id }))
        .execute();

      expect(rows.map((row) => row.id).toSorted()).toEqual(
        [...climateIds].toSorted(),
      );
    });
  });
}
