/**
 * A fulltext, vector or hybrid predicate on the target of an optional
 * traversal.
 *
 * An optional traversal keeps every start row: a start row with no target
 * that passes the traversal's predicates comes back once with the optional
 * side absent. An ordinary predicate on the target already behaved that way.
 * A relevance predicate on the same target joined its candidate relation with
 * an inner join after the optional join, so a start row whose targets all
 * failed the search, or that had no target at all, was dropped.
 *
 * Each case runs the relevance query next to the same query with an ordinary
 * predicate selecting the same targets, so the contract the relevance query
 * is held to is the one the ordinary query already keeps.
 *
 * Two hazards main has on every search are pinned at today's value, not fixed
 * here: a search's keyset cursor does not carry its relevance order, and on
 * SQLite a zero-norm embedding ranks nearest in a cosine top-k. The
 * search-pagination change (PR #1006) owns both.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { count, field, type Predicate } from "../../../src";
import { expectObservation } from "../../helpers/known-defect";
import { type IntegrationStore } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

const NO_ARTICLES = "No articles";
const ALL_MISS = "All miss";
const ONE_MATCH = "One match";

/** The only article any search below matches, by text and by embedding. */
const MATCHING_TITLE = "Climate outlook";
const QUERY_EMBEDDING = [1, 0, 0, 0];

type Row = Readonly<{ person: string; article: string | undefined }>;

/**
 * Three authors: one with no article, one whose two articles both fail every
 * search, and one with a matching and a failing article. A failing article
 * neither contains "climate" nor lies near `QUERY_EMBEDDING`.
 */
async function seedAuthors(store: IntegrationStore): Promise<void> {
  await store.nodes.Person.create({ name: NO_ARTICLES });
  const allMiss = await store.nodes.Person.create({ name: ALL_MISS });
  const oneMatch = await store.nodes.Person.create({ name: ONE_MATCH });

  const articles = [
    [allMiss, "Museum opening hours", [0, 1, 0, 0]],
    [allMiss, "Garden notes", [0, 0, 1, 0]],
    [oneMatch, MATCHING_TITLE, QUERY_EMBEDDING],
    [oneMatch, "Harbour timetable", [0, 0, 0, 1]],
  ] as const;
  for (const [author, title, articleEmbedding] of articles) {
    const article = await store.nodes.Article.create({
      title,
      body: "ordinary corpus text",
      category: "optional-relevance",
      published: true,
      embedding: [...articleEmbedding],
    });
    await store.edges.authoredBy.create(article, author, {});
  }
}

/** The rows every case expects, in the order a relevance query returns them. */
const EXPECTED_ROWS: readonly Row[] = [
  { person: ONE_MATCH, article: MATCHING_TITLE },
  { person: ALL_MISS, article: undefined },
  { person: NO_ARTICLES, article: undefined },
];

function sortRows(rows: readonly Row[]): readonly Row[] {
  return rows.toSorted((left, right) =>
    left.person.localeCompare(right.person),
  );
}

type RelevanceKind = "fulltext" | "vector" | "hybrid";

/** The two search members of the `Article` accessor the cases read. */
type ArticleAccessor = Readonly<{
  $fulltext: Readonly<{ matches: (query: string, k: number) => Predicate }>;
  embedding: Readonly<{
    similarTo: (
      queryEmbedding: readonly number[],
      k: number,
      options?: Readonly<{ minScore?: number }>,
    ) => Predicate;
  }>;
}>;

/**
 * A search no article passes: no article contains "zebra", and every
 * embedding is one axis, at cosine similarity 0.5 from `[1, 1, 1, 1]`.
 */
function missingPredicate(kind: RelevanceKind, article: ArticleAccessor) {
  const fulltext = article.$fulltext.matches("zebra", 10);
  const vector = article.embedding.similarTo([1, 1, 1, 1], 10, {
    minScore: 0.9,
  });
  switch (kind) {
    case "fulltext": {
      return fulltext;
    }
    case "vector": {
      return vector;
    }
    case "hybrid": {
      return fulltext.and(vector);
    }
  }
}

/** The search every case runs; each matches only `MATCHING_TITLE`. */
function relevancePredicate(kind: RelevanceKind, article: ArticleAccessor) {
  switch (kind) {
    case "fulltext": {
      return article.$fulltext.matches("climate", 10);
    }
    case "vector": {
      return article.embedding.similarTo(QUERY_EMBEDDING, 1);
    }
    case "hybrid": {
      return article.$fulltext
        .matches("climate", 10)
        .and(article.embedding.similarTo(QUERY_EMBEDDING, 1));
    }
  }
}

export function registerOptionalTraversalRelevanceIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Relevance predicates on optional traversals", () => {
    let store: IntegrationStore;

    beforeEach(async () => {
      store = context.getStore();
      await seedAuthors(store);
    });

    function skipUnlessSupported(
      kind: RelevanceKind,
      ctx: { skip: () => void },
    ): void {
      const fulltext = store.backend.capabilities.fulltext?.supported === true;
      const vector = store.backend.capabilities.vector?.supported === true;
      const supported =
        kind === "fulltext" ? fulltext
        : kind === "vector" ? vector
        : fulltext && vector;
      if (!supported) ctx.skip();
    }

    function authorsWithOptionalArticle() {
      return store
        .query()
        .from("Person", "p")
        .optionalTraverse("authoredBy", "e", { direction: "in" })
        .to("Article", "article");
    }

    function relevanceQuery(kind: RelevanceKind) {
      return authorsWithOptionalArticle()
        .whereNode("article", (article) => relevancePredicate(kind, article))
        .select((select) => ({
          person: select.p.name,
          article: select.article?.title,
        }));
    }

    function ordinaryQuery() {
      return authorsWithOptionalArticle()
        .whereNode("article", (article) => article.title.eq(MATCHING_TITLE))
        .select((select) => ({
          person: select.p.name,
          article: select.article?.title,
        }));
    }

    it("keeps start rows with an absent side under an ordinary predicate", async () => {
      const rows = await ordinaryQuery().execute();
      expect(sortRows(rows)).toEqual(sortRows(EXPECTED_ROWS));
    });

    it("orders a fused match that scores zero before every start row with an absent side", async (ctx) => {
      skipUnlessSupported("hybrid", ctx);
      // Zero weights score every match 0, the score COALESCE gives a row
      // matched by neither leg. An absent side has no score at all, so the
      // match still precedes it; orderBy() alone would put it last.
      const rows = await authorsWithOptionalArticle()
        .whereNode("article", (article) =>
          relevancePredicate("hybrid", article),
        )
        .fuseWith({ weights: { vector: 0, fulltext: 0 } })
        .orderBy("p", "name")
        .select((select) => ({
          person: select.p.name,
          article: select.article?.title,
        }))
        .execute();

      expect(rows).toEqual([
        { person: ONE_MATCH, article: MATCHING_TITLE },
        { person: ALL_MISS, article: undefined },
        { person: NO_ARTICLES, article: undefined },
      ]);
    });

    it("keeps the start row when a vector predicate on an optional target is ranked with a fulltext predicate on a required alias", async (ctx) => {
      skipUnlessSupported("hybrid", ctx);
      // The fulltext leg reaches "One match" through its climate article.
      // The vector leg ranks "Museum opening hours" first, which "One match"
      // did not write, so its optional side is absent.
      const rows = await store
        .query()
        .from("Article", "source")
        .whereNode("source", (source) =>
          source.$fulltext.matches("climate", 10),
        )
        .traverse("authoredBy", "writtenBy")
        .to("Person", "p")
        .optionalTraverse("authoredBy", "e", { direction: "in" })
        .to("Article", "article")
        .whereNode("article", (article) =>
          article.embedding.similarTo([0, 1, 0, 0], 1),
        )
        .select((select) => ({
          person: select.p.name,
          article: select.article?.title,
        }))
        .execute();

      expect(rows).toEqual([{ person: ONE_MATCH, article: undefined }]);
    });

    it("orders a start row whose two optional searched sides are both absent after every row either leg matched", async (ctx) => {
      skipUnlessSupported("hybrid", ctx);
      // Each search sits on its own optional traversal, joined inside it.
      // "No articles" matched neither leg and scores below both others.
      const rows = await authorsWithOptionalArticle()
        .whereNode("article", (article) =>
          article.$fulltext.matches("climate", 10),
        )
        .optionalTraverse("authoredBy", "other", {
          direction: "in",
          from: "p",
        })
        .to("Article", "otherArticle")
        .whereNode("otherArticle", (article) =>
          article.embedding.similarTo([0, 1, 0, 0], 1),
        )
        .orderBy("p", "name", "desc")
        .select((select) => ({
          person: select.p.name,
          article: select.article?.title,
          other: select.otherArticle?.title,
        }))
        .execute();

      expect(rows).toEqual([
        { person: ONE_MATCH, article: MATCHING_TITLE, other: undefined },
        { person: ALL_MISS, article: undefined, other: "Museum opening hours" },
        { person: NO_ARTICLES, article: undefined, other: undefined },
      ]);
    });

    it("keeps a zero-norm embedding out of the cosine top-k on an optional side (pinned: SQLite ranks it nearest)", async (ctx) => {
      skipUnlessSupported("vector", ctx);
      // A zero vector has no cosine distance. SQLite computes NULL and ranks
      // it nearest, so it takes the top-1 slot from the matching article and
      // then ties every absent side. Main has the same cut, which the
      // search-pagination change (PR #1006) replaces.
      const zero = await store.nodes.Person.create({ name: "Zero vector" });
      const blank = await store.nodes.Article.create({
        title: "Blank",
        body: "ordinary corpus text",
        category: "optional-relevance",
        published: true,
        embedding: [0, 0, 0, 0],
      });
      await store.edges.authoredBy.create(blank, zero, {});

      const rows = await relevanceQuery("vector")
        .orderBy("p", "name")
        .execute();

      expectObservation({
        lane: { dialect: store.backend.dialect },
        observed: rows,
        correct: [
          { person: ONE_MATCH, article: MATCHING_TITLE },
          { person: ALL_MISS, article: undefined },
          { person: NO_ARTICLES, article: undefined },
          { person: "Zero vector", article: undefined },
        ],
        defects: [
          {
            label: "PR #1006",
            on: { dialect: ["sqlite"] },
            today: [
              { person: ALL_MISS, article: undefined },
              { person: NO_ARTICLES, article: undefined },
              { person: ONE_MATCH, article: undefined },
              { person: "Zero vector", article: "Blank" },
            ],
          },
        ],
      });
    });

    for (const kind of ["fulltext", "vector", "hybrid"] as const) {
      describe(`${kind} predicate`, () => {
        it("keeps a start row with no target and one whose targets all fail, once each, with the optional side absent", async (ctx) => {
          skipUnlessSupported(kind, ctx);
          const rows = await relevanceQuery(kind).execute();
          const ordinary = await ordinaryQuery().execute();

          expect(sortRows(rows)).toEqual(sortRows(ordinary));
          expect(sortRows(rows)).toEqual(sortRows(EXPECTED_ROWS));
        });

        it("orders the matched row before every start row with an absent side on every backend", async (ctx) => {
          skipUnlessSupported(kind, ctx);
          const rows = await relevanceQuery(kind).execute();

          expect(rows[0]).toEqual(EXPECTED_ROWS[0]);
          expect(sortRows(rows.slice(1))).toEqual(
            sortRows(EXPECTED_ROWS.slice(1)),
          );
        });

        it("applies limit() after the relevance order, keeping the matched row", async (ctx) => {
          skipUnlessSupported(kind, ctx);
          const rows = await relevanceQuery(kind).limit(1).execute();

          expect(rows).toEqual([EXPECTED_ROWS[0]]);
        });

        it("keeps every start row through limit(), first(), count() and exists() when no target matches", async (ctx) => {
          skipUnlessSupported(kind, ctx);
          const query = authorsWithOptionalArticle()
            .whereNode("article", (article) => missingPredicate(kind, article))
            .orderBy("p", "name")
            .select((select) => ({
              person: select.p.name,
              article: select.article?.title,
            }));

          expect({
            "limit(2)": await query.limit(2).execute(),
            "first()": await query.first(),
            "count()": await query.count(),
            "exists()": await query.exists(),
          }).toEqual({
            "limit(2)": [
              { person: ALL_MISS, article: undefined },
              { person: NO_ARTICLES, article: undefined },
            ],
            "first()": { person: ALL_MISS, article: undefined },
            "count()": 3,
            "exists()": true,
          });
        });

        it("selects the same rows in the same order through every terminal", async (ctx) => {
          skipUnlessSupported(kind, ctx);
          // `orderBy()` breaks the tie between the two absent rows, so the
          // order is total on every terminal.
          const ordered = () =>
            relevanceQuery(kind).orderBy("p", "name", "desc");
          const projected = () =>
            authorsWithOptionalArticle()
              .whereNode("article", (article) =>
                relevancePredicate(kind, article),
              )
              .orderBy("p", "name", "desc")
              .project((fields) => ({
                person: fields.p.name,
                article: fields.article.title,
              }));
          const correct: readonly Row[] = [
            { person: ONE_MATCH, article: MATCHING_TITLE },
            { person: NO_ARTICLES, article: undefined },
            { person: ALL_MISS, article: undefined },
          ];
          const [batched] = await store.batchOnce(() => [ordered()] as const);
          const [batchedFirst] = await store.batchOnce(
            () => [ordered().limit(1)] as const,
          );

          expect({
            "execute()": await ordered().execute(),
            "executeOn()": await ordered().executeOn(store.backend),
            "prepare().execute()": await ordered().prepare().execute({}),
            "batchOnce()": batched,
            "project().asRelation().execute()": await projected()
              .asRelation()
              .execute(),
            "project().execute()": await projected().execute(),
            "first()": await ordered().first(),
            "limit(1) batchOnce()": batchedFirst,
            "project().asRelation().first()": await projected()
              .asRelation()
              .first(),
            "count()": await ordered().count(),
            "exists()": await ordered().exists(),
          }).toEqual({
            "execute()": correct,
            "executeOn()": correct,
            "prepare().execute()": correct,
            "batchOnce()": correct,
            "project().asRelation().execute()": correct,
            "project().execute()": correct,
            "first()": correct[0],
            "limit(1) batchOnce()": [correct[0]],
            "project().asRelation().first()": correct[0],
            "count()": correct.length,
            "exists()": true,
          });
        });

        it("groups start rows with an absent side and orders their groups after every matched group", async (ctx) => {
          skipUnlessSupported(kind, ctx);
          const rows = await authorsWithOptionalArticle()
            .whereNode("article", (article) =>
              relevancePredicate(kind, article),
            )
            .groupBy("p", "name")
            .aggregate({
              person: field("p", "name"),
              articles: count("article"),
            })
            .orderBy("person", "asc")
            .execute();

          expect(rows).toEqual([
            { person: ONE_MATCH, articles: 1 },
            { person: ALL_MISS, articles: 0 },
            { person: NO_ARTICLES, articles: 0 },
          ]);
        });

        it("joins a later optional traversal from the searched target", async (ctx) => {
          skipUnlessSupported(kind, ctx);
          const rows = await authorsWithOptionalArticle()
            .whereNode("article", (article) =>
              relevancePredicate(kind, article),
            )
            .optionalTraverse("authoredBy", "byline")
            .to("Person", "writer")
            .select((select) => ({
              person: select.p.name,
              article: select.article?.title,
              writer: select.writer?.name,
            }))
            .execute();

          expect(
            rows.toSorted((left, right) =>
              left.person.localeCompare(right.person),
            ),
          ).toEqual([
            { person: ALL_MISS, article: undefined, writer: undefined },
            { person: NO_ARTICLES, article: undefined, writer: undefined },
            { person: ONE_MATCH, article: MATCHING_TITLE, writer: ONE_MATCH },
          ]);
        });

        it("pages the rows execute() returns (pinned: a search cursor ignores relevance)", async (ctx) => {
          skipUnlessSupported(kind, ctx);
          const query = relevanceQuery(kind).orderBy("p", "name");
          const executed = await query.execute();

          const paged: string[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < EXPECTED_ROWS.length + 1; page += 1) {
            const result = await query.paginate({
              first: 1,
              ...(cursor === undefined ? {} : { after: cursor }),
            });
            paged.push(...result.data.map((row) => row.person));
            if (!result.hasNextPage) break;
            cursor = result.nextCursor;
          }

          expect(executed.map((row) => row.person)).toEqual([
            ONE_MATCH,
            ALL_MISS,
            NO_ARTICLES,
          ]);
          expectObservation({
            lane: { dialect: store.backend.dialect },
            observed: paged,
            correct: executed.map((row) => row.person),
            defects: [{ label: "PR #1006", on: {}, today: [ONE_MATCH] }],
          });
        });

        it("drops start rows without a qualifying target on a required traversal", async (ctx) => {
          skipUnlessSupported(kind, ctx);
          const rows = await store
            .query()
            .from("Person", "p")
            .traverse("authoredBy", "e", { direction: "in" })
            .to("Article", "article")
            .whereNode("article", (article) =>
              relevancePredicate(kind, article),
            )
            .select((select) => ({
              person: select.p.name,
              article: select.article.title,
            }))
            .execute();

          expect(rows).toEqual([EXPECTED_ROWS[0]]);
        });
      });
    }
  });
}
