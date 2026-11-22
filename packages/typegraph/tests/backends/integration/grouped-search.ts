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

/**
 * Texts every fulltext engine ranks strong > medium > weak for "climate": the
 * strong text repeats the term most and is shortest, the weak text names it
 * once among many other words. Both BM25 and `ts_rank_cd` agree on this order
 * though they agree on no rank value.
 */
const STRONG_TEXT = "climate climate climate climate";
const MEDIUM_TEXT = "climate climate report";
const WEAK_TEXT =
  "climate and a long digression about shipping lanes, harvest yields, municipal budgets, regional rail timetables and museum opening hours";

/** Cosine distances from {@link SEARCH_VECTOR}: 0 (exact), 0.2 (middle), 1 (far). */
const SEARCH_VECTOR = [1, 0, 0, 0];
const EXACT_VECTOR = [1, 0, 0, 0];
const MIDDLE_VECTOR = [0.8, 0.6, 0, 0];
const FAR_VECTOR = [0, 0, 0, 1];

/**
 * Two groups whose best and worst members disagree. `peak` holds the single
 * best match on every leg (strongest text, exact vector) and the single worst
 * (weakest text, farthest vector); `steady` holds three middling matches. A
 * group ordered by its best member puts `peak` first; one ordered by its
 * worst member, or by any one member, can put `steady` first. `steady` also
 * has more members, so a caller's `orderBy("n", "desc")` that outranked
 * relevance would put it first too.
 */
async function seedMixedScores(store: IntegrationStore): Promise<void> {
  const articles: readonly (readonly [string, string, readonly number[]])[] = [
    ["peak", STRONG_TEXT, EXACT_VECTOR],
    ["peak", WEAK_TEXT, FAR_VECTOR],
    ["steady", MEDIUM_TEXT, MIDDLE_VECTOR],
    ["steady", MEDIUM_TEXT, MIDDLE_VECTOR],
    ["steady", MEDIUM_TEXT, MIDDLE_VECTOR],
  ];
  for (const [category, text, vector] of articles) {
    await store.nodes.Article.create({
      title: text,
      body: text,
      category,
      published: true,
      embedding: [...vector],
    });
  }
}

type CategoryCount = Readonly<{ category: string; n: number }>;

type SearchKind = "fulltext" | "vector" | "hybrid";

async function firstRow<Row>(
  rows: Promise<readonly Row[]>,
): Promise<Row | undefined> {
  const [first] = await rows;
  return first;
}

function capabilitiesOf(kind: SearchKind): readonly ("fulltext" | "vector")[] {
  switch (kind) {
    case "fulltext": {
      return ["fulltext"];
    }
    case "vector": {
      return ["vector"];
    }
    case "hybrid": {
      return ["fulltext", "vector"];
    }
  }
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

/** Articles matching `kind`'s search for "climate" / {@link SEARCH_VECTOR}. */
function searchArticles(store: IntegrationStore, kind: SearchKind) {
  return store
    .query()
    .from("Article", "a")
    .whereNode("a", (a) => {
      switch (kind) {
        case "fulltext": {
          return a.$fulltext.matches("climate", 10);
        }
        case "vector": {
          return a.embedding.similarTo(SEARCH_VECTOR, 10);
        }
        case "hybrid": {
          return a.$fulltext
            .matches("climate", 10)
            .and(a.embedding.similarTo(SEARCH_VECTOR, 10));
        }
      }
    });
}

function searchGroups(store: IntegrationStore, kind: SearchKind) {
  return searchArticles(store, kind)
    .groupBy("a", "category")
    .aggregate({ category: field("a", "category"), n: count("a") });
}

const SEARCH_KINDS: readonly SearchKind[] = ["fulltext", "vector", "hybrid"];

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

    for (const kind of SEARCH_KINDS) {
      it(`orders ${kind} groups by their best member, not their worst`, async (ctx) => {
        const store = storeWith(context, ctx, capabilitiesOf(kind));
        await seedMixedScores(store);

        const expected: readonly CategoryCount[] = [
          { category: "peak", n: 2 },
          { category: "steady", n: 3 },
        ];
        expect(await searchGroups(store, kind).execute()).toEqual(expected);
        // Relevance leads; the caller's aggregate order only breaks its ties.
        expect(
          await searchGroups(store, kind).orderBy("n", "desc").execute(),
        ).toEqual(expected);
        expect(await searchGroups(store, kind).limit(1).execute()).toEqual([
          expected[0],
        ]);
      });

      it(`selects the same ${kind} groups from every aggregate terminal`, async (ctx) => {
        const store = storeWith(context, ctx, capabilitiesOf(kind));
        await seedMixedScores(store);

        // `steady` has more members: an outer `ORDER BY n DESC` that
        // outranked relevance would select it first.
        const ordered = () => searchGroups(store, kind).orderBy("n", "desc");
        const expected: readonly CategoryCount[] = [
          { category: "peak", n: 2 },
          { category: "steady", n: 3 },
        ];
        const [batched] = await store.batchOnce(() => [ordered()] as const);
        const terminals: readonly (readonly [
          string,
          () => Promise<readonly CategoryCount[]>,
        ])[] = [
          ["execute()", () => ordered().execute()],
          ["executeOn()", () => ordered().executeOn(store.backend)],
          ["prepare().execute()", () => ordered().prepare().execute({})],
          ["batchOnce()", () => Promise.resolve(batched)],
          ["asRelation().execute()", () => ordered().asRelation().execute()],
        ];
        for (const [terminal, run] of terminals) {
          expect({ terminal, rows: await run() }).toEqual({
            terminal,
            rows: expected,
          });
        }

        const firstTerminals: readonly (readonly [
          string,
          () => Promise<CategoryCount | undefined>,
        ])[] = [
          ["limit(1).execute()", () => firstRow(ordered().limit(1).execute())],
          ["first()", () => ordered().first()],
          [
            "limit(1).executeOn()",
            () => firstRow(ordered().limit(1).executeOn(store.backend)),
          ],
          [
            "limit(1).prepare().execute()",
            () => firstRow(ordered().limit(1).prepare().execute({})),
          ],
          [
            "limit(1) batchOnce()",
            async () => {
              const [rows] = await store.batchOnce(
                () => [ordered().limit(1)] as const,
              );
              return rows[0];
            },
          ],
          ["asRelation().first()", () => ordered().asRelation().first()],
        ];
        for (const [terminal, run] of firstTerminals) {
          expect({ terminal, row: await run() }).toEqual({
            terminal,
            row: expected[0],
          });
        }

        expect(await ordered().count()).toBe(expected.length);
        expect(await ordered().limit(1).count()).toBe(1);
        expect(await ordered().exists()).toBe(true);
      });
    }

    it("breaks tied hybrid scores by node id in byte order", async (ctx) => {
      const store = storeWith(context, ctx, ["fulltext", "vector"]);
      // `tie-B` leads the fulltext leg and trails the vector leg; `tie-a` the
      // reverse. Their fused scores are the same sum, so the node-id tiebreak
      // alone orders them: byte order puts "tie-B" first (B < a), a linguistic
      // collation such as en_US puts "tie-a" first.
      await store.nodes.Article.create(
        {
          title: STRONG_TEXT,
          body: STRONG_TEXT,
          category: "upper",
          published: true,
          embedding: [...MIDDLE_VECTOR],
        },
        { id: "tie-B" },
      );
      await store.nodes.Article.create(
        {
          title: WEAK_TEXT,
          body: WEAK_TEXT,
          category: "lower",
          published: true,
          embedding: [...EXACT_VECTOR],
        },
        { id: "tie-a" },
      );

      const groups = [
        { category: "upper", n: 1 },
        { category: "lower", n: 1 },
      ];
      expect({
        matches: await searchArticles(store, "hybrid")
          .select((selected) => ({ id: selected.a.id }))
          .execute(),
        groups: await searchGroups(store, "hybrid").execute(),
        relation: await searchGroups(store, "hybrid").asRelation().execute(),
        first: await searchGroups(store, "hybrid").first(),
      }).toEqual({
        matches: [{ id: "tie-B" }, { id: "tie-a" }],
        groups,
        relation: groups,
        first: groups[0],
      });
    });

    it("keeps relevance order through a projected search relation", async (ctx) => {
      const store = storeWith(context, ctx, ["fulltext"]);
      await seedMixedScores(store);

      // The caller's title order only breaks relevance ties; alphabetically
      // the weak text comes first, so a relation that lost the relevance key
      // would lead with it.
      const projected = () =>
        searchArticles(store, "fulltext")
          .orderBy("a", "title", "asc")
          .project((expressions) => ({
            title: expressions.a.title,
          }));
      const executed = await projected().execute();
      expect(executed[0]).toEqual({ title: STRONG_TEXT });
      expect(executed.at(-1)).toEqual({ title: WEAK_TEXT });
      expect(await projected().asRelation().execute()).toEqual(executed);
      expect(await projected().asRelation().first()).toEqual(executed[0]);
    });

    it("keeps the caller's field order through an aggregate relation", async () => {
      const store = context.getStore();
      await seedCategories(store);

      const grouped = () =>
        store
          .query()
          .from("Article", "a")
          .orderBy("a", "category", "desc")
          .groupBy("a", "category")
          .aggregate({ category: field("a", "category"), n: count("a") })
          // The field order leads; this aggregate order only breaks its ties.
          .orderBy("n", "asc");
      const expected = [
        { category: "z", n: 3 },
        { category: "y", n: 2 },
        { category: "x", n: 1 },
        { category: "w", n: 1 },
      ];
      expect(await grouped().execute()).toEqual(expected);
      expect(await grouped().asRelation().execute()).toEqual(expected);
      expect(await grouped().first()).toEqual(expected[0]);
    });
  });
}
