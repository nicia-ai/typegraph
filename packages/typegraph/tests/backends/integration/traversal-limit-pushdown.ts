import { describe, expect, it } from "vitest";

import { count, expr } from "../../../src";
import type { IntegrationStore } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

const COMPANY_COUNT = 10;

/**
 * One article whose author works at {@link COMPANY_COUNT} companies: a
 * start node pinned by id with a two-hop traversal, the shape whose final
 * LIMIT the compiler may push into the traversal CTEs.
 */
async function seedAuthorWithCompanies(
  store: IntegrationStore,
): Promise<string> {
  const article = await store.nodes.Article.create({
    title: "Climate notes",
    body: "Climate notes",
    category: "x",
    published: true,
  });
  const author = await store.nodes.Person.create({ name: "Author" });
  await store.edges.authoredBy.create(article, author);
  for (let index = 0; index < COMPANY_COUNT; index += 1) {
    const company = await store.nodes.Company.create({
      name: `Company ${index}`,
    });
    await store.edges.worksAt.create(author, company, { role: "advisor" });
  }
  return article.id;
}

function storeWith(
  context: IntegrationTestContext,
  ctx: { skip: () => void },
  capabilities: readonly "fulltext"[],
): IntegrationStore {
  const store = context.getStore();
  for (const capability of capabilities) {
    if (store.backend.capabilities[capability]?.supported !== true) ctx.skip();
  }
  return store;
}

export function registerTraversalLimitPushdownIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("A final limit over a pinned multi-hop traversal", () => {
    for (const search of [false, true]) {
      const label = search ? "a fulltext-matched" : "an id-pinned";
      it(`counts every match of ${label} start before limiting the aggregated rows`, async (ctx) => {
        const store = storeWith(context, ctx, search ? ["fulltext"] : []);
        const articleId = await seedAuthorWithCompanies(store);

        const companies = () =>
          store
            .query()
            .from("Article", "a")
            .whereNode("a", (a) =>
              search ?
                a.id.eq(articleId).and(a.$fulltext.matches("climate", 10))
              : a.id.eq(articleId),
            )
            .traverse("authoredBy", "authorship")
            .to("Person", "p")
            .traverse("worksAt", "employment")
            .to("Company", "c");

        const counted = () => companies().aggregate({ n: count("c") });
        expect(await counted().execute()).toEqual([{ n: COMPANY_COUNT }]);
        expect(await counted().limit(1).execute()).toEqual([
          { n: COMPANY_COUNT },
        ]);

        const projected = () =>
          companies().project((expressions) => ({
            n: expr.count(expressions.c.id),
          }));
        expect(await projected().limit(1).execute()).toEqual([
          { n: COMPANY_COUNT },
        ]);
      });
    }

    it("returns the most relevant match, not the first rows a traversal produced", async (ctx) => {
      const store = storeWith(context, ctx, ["fulltext"]);
      const company = await store.nodes.Company.create({ name: "Acme" });
      const author = await store.nodes.Person.create({ name: "Author" });
      await store.edges.worksAt.create(author, company, { role: "writer" });
      // Twenty weak matches written first, then the one strong match: the
      // first rows the traversal produces are all weak.
      const weak =
        "climate and a long digression about shipping lanes, harvest yields and municipal budgets";
      const strong = "climate climate climate climate";
      for (let index = 0; index < 21; index += 1) {
        const text = index === 20 ? strong : weak;
        const article = await store.nodes.Article.create({
          title: text,
          body: text,
          category: `c${index}`,
          published: true,
        });
        await store.edges.authoredBy.create(article, author);
      }

      const articles = () =>
        store
          .query()
          .from("Company", "c")
          .whereNode("c", (c) => c.id.eq(company.id))
          .traverse("worksAt", "employment", { direction: "in" })
          .to("Person", "p")
          .traverse("authoredBy", "authorship", { direction: "in" })
          .to("Article", "a")
          .whereNode("a", (a) => a.$fulltext.matches("climate", 50))
          .select((selected) => ({ title: selected.a.title }));

      const [best] = await articles().execute();
      expect(best).toEqual({ title: strong });
      expect(await articles().limit(1).execute()).toEqual([{ title: strong }]);
    });
  });
}
