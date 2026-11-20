import { describe, expect, it } from "vitest";

import { expr } from "../../../src";
import type { IntegrationStore } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

function fulltextStore(
  context: IntegrationTestContext,
  testContext: { skip: () => void },
): IntegrationStore {
  const store = context.getStore();
  if (store.backend.capabilities.fulltext?.supported !== true)
    testContext.skip();
  return store;
}

export function registerMatchResultRankingIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("match results, ranking, and multiplicity", () => {
    it("keeps outer fields referenced only by a correlated completed-match filter", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ age: 31, name: "Alice" });
      await store.nodes.Person.create({ age: 27, name: "Bob" });

      const rows = await store
        .query()
        .from("Person", "person")
        .where((expression) =>
          expression.$exists((subquery, outer) =>
            subquery
              .from("Person", "candidate")
              .where((inner) => expr.eq(inner.candidate.age, outer.person.age))
              .project((inner) => ({ id: inner.candidate.id })),
          ),
        )
        .orderBy("person", "name")
        .limit(1)
        .select((row) => row.person.name)
        .execute();

      expect(rows).toEqual(["Alice"]);
    });

    it("applies candidate top-k before fanout and completed filtering, then final order and limit", async (testContext) => {
      const store = fulltextStore(context, testContext);
      const rejected = await store.nodes.Person.create({ name: "Rejected" });
      const alpha = await store.nodes.Person.create({ name: "Alpha" });
      const beta = await store.nodes.Person.create({ name: "Beta" });
      const zulu = await store.nodes.Person.create({ name: "Zulu" });
      const lower = await store.nodes.Person.create({ name: "Lower" });

      const highest = await store.nodes.Article.create({
        body: "quasar quasar quasar quasar",
        category: "ranking-stage",
        published: true,
        title: "Highest ranked",
      });
      const second = await store.nodes.Article.create({
        body: "quasar quasar",
        category: "ranking-stage",
        published: true,
        title: "Second ranked",
      });
      const third = await store.nodes.Article.create({
        body: "quasar",
        category: "ranking-stage",
        published: true,
        title: "Third ranked",
      });
      await store.edges.authoredBy.create(highest, rejected, {});
      await store.edges.authoredBy.create(second, alpha, {});
      await store.edges.authoredBy.create(second, beta, {});
      await store.edges.authoredBy.create(second, zulu, {});
      await store.edges.authoredBy.create(third, lower, {});

      const rankedAuthors = store
        .query()
        .from("Article", "article")
        .whereNode("article", (article) =>
          article.$fulltext.matches("quasar", 2),
        )
        .traverse("authoredBy", "authorship")
        .to("Person", "author")
        .where((fields) =>
          expr.neq(fields.author.name, expr.literal("Rejected")),
        )
        .orderBy("author", "name", "desc")
        .limit(3)
        .select((fields) => ({
          article: fields.article.title,
          author: fields.author.name,
        }));
      const rows = await rankedAuthors.execute();

      expect(rows).toEqual([
        { article: "Second ranked", author: "Zulu" },
        { article: "Second ranked", author: "Beta" },
        { article: "Second ranked", author: "Alpha" },
      ]);

      const empty = store
        .query()
        .from("Article", "emptyArticle")
        .whereNode("emptyArticle", (article) => article.title.eq("Missing"))
        .traverse("authoredBy", "emptyAuthorship")
        .to("Person", "emptyAuthor")
        .select((fields) => ({
          article: fields.emptyArticle.title,
          author: fields.emptyAuthor.name,
        }));
      expect(await rankedAuthors.unionAll(empty).execute()).toHaveLength(3);
    });

    it("uses an explicit fragment source alias and counts match rows before entity deduplication", async () => {
      const store = context.getStore();
      const root = await store.nodes.Person.create({ name: "Branch root" });
      const middle = await store.nodes.Person.create({ name: "Middle" });
      const target = await store.nodes.Person.create({ name: "Target" });
      await store.edges.knows.create(root, middle, {});
      await store.edges.knows.create(root, target, {});
      await store.edges.knows.create(middle, target, {});

      const firstMatch = store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.id.eq(root.id))
        .traverse("knows", "firstEdge")
        .to("Person", "middle");
      const branchFromRoot = (builder: typeof firstMatch) =>
        builder
          .traverse("knows", "branchEdge", { from: "root" })
          .to("Person", "branch");
      const matches = firstMatch.pipe(branchFromRoot);

      expect(await matches.count()).toBe(4);
      expect(
        await matches
          .project((fields) => ({ id: fields.branch.id }))
          .asRelation()
          .distinct()
          .count(),
      ).toBe(2);
    });
  });
}
