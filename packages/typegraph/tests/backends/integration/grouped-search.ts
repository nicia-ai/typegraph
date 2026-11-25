import { describe, expect, it } from "vitest";

import { count, expr, field } from "../../../src";
import type { EmbeddableOneStatementRead } from "../../../src/query/builder/types";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";
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

/**
 * The terminals a search query is read through: `execute()`, the ones that
 * wrap its statement (a relation or a `batchOnce()` item), and for a
 * projection or aggregate its relation.
 */
type TerminalQuery = EmbeddableOneStatementRead<readonly unknown[]> &
  Readonly<{
    execute: () => Promise<readonly unknown[]>;
    first: () => Promise<unknown>;
    executeOn: (
      backend: IntegrationStore["backend"],
    ) => Promise<readonly unknown[]>;
    prepare: () => Readonly<{
      execute: (
        bindings: Readonly<Record<string, never>>,
      ) => Promise<readonly unknown[]>;
    }>;
    count: () => Promise<number>;
    exists: () => Promise<boolean>;
    asRelation?: () => Readonly<{
      execute: () => Promise<readonly unknown[]>;
      first: () => Promise<unknown>;
      count: () => Promise<number>;
    }>;
  }>;

/** `query` with the limit and offset of `range`. */
function ranged<
  Query extends Readonly<{
    limit: (value: number) => Query;
    offset: (value: number) => Query;
  }>,
>(query: Query, range: Readonly<{ limit?: number; offset?: number }>): Query {
  const limited = range.limit === undefined ? query : query.limit(range.limit);
  return range.offset === undefined ? limited : limited.offset(range.offset);
}

async function firstRow<Row>(
  rows: Promise<readonly Row[]>,
): Promise<Row | undefined> {
  const [first] = await rows;
  return first;
}

/** A query's rows, or the name of the error it threw. */
type Settled<Value> = Readonly<{ value: Value }> | Readonly<{ error: string }>;

async function settle<Value>(
  run: () => Promise<Value>,
): Promise<Settled<Value>> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: error instanceof Error ? error.name : String(error) };
  }
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

type RoleCount = Readonly<{ role: string; n: number }>;

function sortedByRole(rows: readonly RoleCount[]): readonly RoleCount[] {
  return rows.toSorted((left, right) => (left.role < right.role ? -1 : 1));
}

/** A PostgreSQL collation that sorts text as a dictionary does. */
const LINGUISTIC_COLLATION = "tg_grouped_search_linguistic";

/**
 * Makes the fulltext table's `node_id` column sort under a linguistic
 * collation this creates (ICU `en-US`, which puts `tie-a` before `tie-B`), so
 * a node-id comparison without an explicit byte-order collation follows it.
 * The collation is the column's own, not the database default, so the case
 * discriminates on every PostgreSQL whatever its default collation. Returns
 * the restore step, or `undefined` when the engine cannot apply such a
 * collation (it takes the DDL but still compares in byte order).
 */
async function linguisticFulltextNodeIds(
  store: IntegrationStore,
): Promise<(() => Promise<void>) | undefined> {
  const { backend } = store;
  const executeDdl = requireDefined(backend.executeDdl);
  const table = requireDefined(backend.tableNames).fulltext;
  await executeDdl(
    `CREATE COLLATION IF NOT EXISTS ${LINGUISTIC_COLLATION} (provider = icu, locale = 'en-US')`,
  );
  const alter = (collation: string) =>
    executeDdl(
      `ALTER TABLE "${table}" ALTER COLUMN node_id TYPE text COLLATE ${collation}`,
    );
  await alter(LINGUISTIC_COLLATION);
  const restore = async () => {
    await alter(`"default"`);
    await executeDdl(`DROP COLLATION IF EXISTS ${LINGUISTIC_COLLATION}`);
  };
  const [probe] = await backend.execute<{ linguistic: unknown }>(
    asCompiledRowsSql(
      sql.raw(
        `SELECT CASE WHEN 'tie-a' COLLATE ${LINGUISTIC_COLLATION} < 'tie-B' COLLATE ${LINGUISTIC_COLLATION} THEN 1 ELSE 0 END AS linguistic`,
      ),
    ),
  );
  if (Number(probe?.linguistic) === 1) return restore;
  await restore();
  return undefined;
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
        expect(
          await searchGroups(store, kind)
            .orderBy("n", "desc")
            .limit(1)
            .execute(),
        ).toEqual([expected[0]]);
      });

      it(`selects ${kind} groups through each aggregate terminal`, async (ctx) => {
        const store = storeWith(context, ctx, capabilitiesOf(kind));
        await seedMixedScores(store);

        // `steady` has more members: a relation that orders by the caller's
        // `n DESC` alone, without the statement's relevance key, selects it
        // first.
        const ordered = () => searchGroups(store, kind).orderBy("n", "desc");
        const correct: readonly CategoryCount[] = [
          { category: "peak", n: 2 },
          { category: "steady", n: 3 },
        ];
        const [batched] = await store.batchOnce(() => [ordered()] as const);
        const [batchedFirst] = await store.batchOnce(
          () => [ordered().limit(1)] as const,
        );
        const observed = {
          "execute()": await ordered().execute(),
          "executeOn()": await ordered().executeOn(store.backend),
          "prepare().execute()": await ordered().prepare().execute({}),
          "batchOnce()": batched,
          "asRelation().execute()": await ordered().asRelation().execute(),
          "limit(1).execute()": await firstRow(ordered().limit(1).execute()),
          "first()": await ordered().first(),
          "limit(1).executeOn()": await firstRow(
            ordered().limit(1).executeOn(store.backend),
          ),
          "limit(1).prepare().execute()": await firstRow(
            ordered().limit(1).prepare().execute({}),
          ),
          "limit(1) batchOnce()": batchedFirst[0],
          "asRelation().first()": await ordered().asRelation().first(),
          "count()": await ordered().count(),
          "limit(1).count()": await ordered().limit(1).count(),
          "exists()": await ordered().exists(),
        };
        expect(observed).toEqual({
          "execute()": correct,
          "executeOn()": correct,
          "prepare().execute()": correct,
          "batchOnce()": correct,
          "asRelation().execute()": correct,
          "limit(1).execute()": correct[0],
          "first()": correct[0],
          "limit(1).executeOn()": correct[0],
          "limit(1).prepare().execute()": correct[0],
          "limit(1) batchOnce()": correct[0],
          "asRelation().first()": correct[0],
          "count()": correct.length,
          "limit(1).count()": 1,
          "exists()": true,
        });
      });

      it(`selects the rows execute() selects through every terminal, for ordered, grouped and limited ${kind} queries`, async (ctx) => {
        const store = storeWith(context, ctx, capabilitiesOf(kind));
        await seedMixedScores(store);

        const aggregateGroups = () => searchGroups(store, kind);
        const projectedGroups = () =>
          searchArticles(store, kind)
            .groupBy((expressions) => [expressions.a.category])
            .aggregate((expressions) => ({
              category: expressions.a.category,
              n: expr.count(expressions.a.id),
            }));
        const projectedTitles = () =>
          searchArticles(store, kind).project((expressions) => ({
            title: expressions.a.title,
          }));
        const selectedTitles = () =>
          searchArticles(store, kind).select((selected) => ({
            title: selected.a.title,
          }));
        type Shape = Readonly<{
          // Every caller ordering below also orders by a value that puts a
          // less relevant row or group first, so a terminal that lost the
          // relevance order selects differently.
          name: string;
          /** The first row `execute()` returns without a range. */
          leading: unknown;
          build: (
            range: Readonly<{ limit?: number; offset?: number }>,
          ) => TerminalQuery;
          relation: boolean;
        }>;
        const peak = { category: "peak", n: 2 };
        const strong = { title: STRONG_TEXT };
        const shapes: readonly Shape[] = [
          {
            name: "aggregate() ordered by its count",
            leading: peak,
            build: (range) =>
              ranged(aggregateGroups().orderBy("n", "desc"), range),
            relation: true,
          },
          {
            name: "aggregate() ordered by its category",
            leading: peak,
            build: (range) =>
              ranged(aggregateGroups().orderBy("category", "desc"), range),
            relation: true,
          },
          {
            name: "aggregate() without orderBy()",
            leading: peak,
            build: (range) => ranged(aggregateGroups(), range),
            relation: true,
          },
          {
            name: "grouped project() ordered by a count",
            leading: peak,
            build: (range) =>
              ranged(
                projectedGroups().orderBy(
                  (expressions) => expr.count(expressions.a.id),
                  "desc",
                ),
                range,
              ),
            relation: true,
          },
          {
            name: "project() ordered by title",
            leading: strong,
            build: (range) =>
              ranged(
                projectedTitles().orderBy((expressions) => expressions.a.title),
                range,
              ),
            relation: true,
          },
          {
            name: "project() without orderBy()",
            leading: strong,
            build: (range) => ranged(projectedTitles(), range),
            relation: true,
          },
          {
            name: "select() ordered by title",
            leading: strong,
            build: (range) =>
              ranged(
                searchArticles(store, kind)
                  .orderBy("a", "title", "asc")
                  .select((selected) => ({ title: selected.a.title })),
                range,
              ),
            relation: false,
          },
          {
            name: "select() without orderBy()",
            leading: strong,
            build: (range) => ranged(selectedTitles(), range),
            relation: false,
          },
        ];
        const ranges: readonly Readonly<{ limit?: number; offset?: number }>[] =
          [{}, { limit: 1 }, { limit: 2, offset: 1 }];

        for (const shape of shapes) {
          const [whole] = await shape.build({}).execute();
          expect(whole, `${shape.name}: execute() leads with`).toEqual(
            shape.leading,
          );
          for (const range of ranges) {
            const query = () => shape.build(range);
            const executed = await query().execute();
            const [batched] = await store.batchOnce(() => [query()] as const);
            const observed: Record<string, unknown> = {
              "first()": await query().first(),
              "executeOn()": await query().executeOn(store.backend),
              "prepare().execute()": await query().prepare().execute({}),
              "batchOnce()": batched,
              "count()": await query().count(),
              "exists()": await query().exists(),
            };
            const expected: Record<string, unknown> = {
              "first()": executed[0],
              "executeOn()": executed,
              "prepare().execute()": executed,
              "batchOnce()": executed,
              "count()": executed.length,
              "exists()": executed.length > 0,
            };
            const relation = query().asRelation?.();
            if (shape.relation) {
              const required = requireDefined(relation);
              observed["asRelation().execute()"] = await required.execute();
              observed["asRelation().first()"] = await required.first();
              observed["asRelation().count()"] = await required.count();
              expected["asRelation().execute()"] = executed;
              expected["asRelation().first()"] = executed[0];
              expected["asRelation().count()"] = executed.length;
            }
            expect(
              observed,
              `${shape.name}, range ${JSON.stringify(range)}`,
            ).toEqual(expected);
          }
        }
      });

      it(`keeps the relevance order of a ${kind} relation through distinct(), paging, appended ordering and set operations`, async (ctx) => {
        const store = storeWith(context, ctx, capabilitiesOf(kind));
        await seedMixedScores(store);

        const titles = () =>
          searchArticles(store, kind)
            .project((expressions) => ({ title: expressions.a.title }))
            .asRelation();
        const byRelevance = [
          { title: STRONG_TEXT },
          { title: MEDIUM_TEXT },
          { title: WEAK_TEXT },
        ];
        const union = await titles().union(titles()).execute();
        // Alphabetically the weak text comes first, so an order that lost
        // relevance leads with it.
        expect({
          distinct: await titles().distinct().execute(),
          distinctFirst: await titles().distinct().first(),
          distinctCount: await titles().distinct().count(),
          page: await titles()
            .distinct()
            .orderBy((columns) => columns.title)
            .page({ limit: 2 }),
          appended: await titles()
            .orderBy((columns) => columns.title, "desc")
            .execute(),
          union: union.length,
        }).toEqual({
          distinct: byRelevance,
          distinctFirst: byRelevance[0],
          distinctCount: 3,
          page: byRelevance.slice(0, 2),
          appended: [
            { title: STRONG_TEXT },
            { title: MEDIUM_TEXT },
            { title: MEDIUM_TEXT },
            { title: MEDIUM_TEXT },
            { title: WEAK_TEXT },
          ],
          union: 3,
        });
      });
    }

    it("breaks equally relevant groups by an ordering appended to the relation", async (ctx) => {
      const store = storeWith(context, ctx, ["fulltext"]);
      await seedCategories(store);

      // Every match ranks equally, so the relation's own `n` ordering decides
      // among the tied groups, as it would appended to the query's ORDER BY.
      const relation = fulltextGroups(store).asRelation();
      expect({
        desc: await relation.orderBy((columns) => columns.n, "desc").execute(),
        asc: await relation.orderBy((columns) => columns.n, "asc").execute(),
      }).toEqual({
        desc: [
          { category: "z", n: 3 },
          { category: "y", n: 2 },
          { category: "x", n: 1 },
        ],
        asc: [
          { category: "x", n: 1 },
          { category: "y", n: 2 },
          { category: "z", n: 3 },
        ],
      });
    });

    it("keeps relevance order through a projected search relation", async (ctx) => {
      const store = storeWith(context, ctx, ["fulltext"]);
      await seedMixedScores(store);

      // The caller's title order only breaks relevance ties; alphabetically
      // the weak text comes first, so a relation that lost the relevance key
      // leads with it.
      const projected = () =>
        searchArticles(store, "fulltext")
          .orderBy("a", "title", "asc")
          .project((expressions) => ({ title: expressions.a.title }));
      const executed = await projected().execute();
      expect(executed[0]).toEqual({ title: STRONG_TEXT });
      expect(executed.at(-1)).toEqual({ title: WEAK_TEXT });

      const [batchedFirst] = await store.batchOnce(
        () => [projected().limit(1)] as const,
      );
      const [batched] = await store.batchOnce(() => [projected()] as const);
      const strong = { title: STRONG_TEXT };
      expect({
        "first()": await projected().first(),
        "limit(1).execute()": await firstRow(projected().limit(1).execute()),
        "limit(1).executeOn()": await firstRow(
          projected().limit(1).executeOn(store.backend),
        ),
        "limit(1).prepare().execute()": await firstRow(
          projected().limit(1).prepare().execute({}),
        ),
        "limit(1) batchOnce()": batchedFirst[0],
        "batchOnce()": batched[0],
        "asRelation().first()": await projected().asRelation().first(),
        "asRelation().execute()": await firstRow(
          projected().asRelation().execute(),
        ),
      }).toEqual({
        "first()": strong,
        "limit(1).execute()": strong,
        "limit(1).executeOn()": strong,
        "limit(1).prepare().execute()": strong,
        "limit(1) batchOnce()": strong,
        "batchOnce()": strong,
        "asRelation().first()": strong,
        "asRelation().execute()": strong,
      });
    });

    it("breaks tied hybrid scores by node id in byte order under a linguistic column collation", async (ctx) => {
      const store = storeWith(context, ctx, ["fulltext", "vector"]);
      // `tie-B` leads the fulltext leg and trails the vector leg; `tie-a` the
      // reverse. Their fused scores are the same sum, so the node-id tiebreak
      // alone orders them: byte order puts "tie-B" first (B < a), a linguistic
      // collation such as en-US puts "tie-a" first.
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

      // On PostgreSQL, sort the compared ids under a linguistic collation so
      // the case fails if the tiebreak loses its byte-order collation.
      // SQLite compares text in byte order (BINARY) by definition.
      const restore =
        store.backend.dialect === "postgres" ?
          await linguisticFulltextNodeIds(store)
        : undefined;
      if (store.backend.dialect === "postgres" && restore === undefined) {
        ctx.skip(
          "this PostgreSQL engine cannot apply an ICU linguistic collation, so byte order and its absence are indistinguishable here",
        );
      }
      try {
        expect({
          matches: await searchArticles(store, "hybrid")
            .select((selected) => ({ id: selected.a.id }))
            .execute(),
          groups: await searchGroups(store, "hybrid").execute(),
        }).toEqual({
          matches: [{ id: "tie-B" }, { id: "tie-a" }],
          groups: [
            { category: "upper", n: 1 },
            { category: "lower", n: 1 },
          ],
        });
      } finally {
        await restore?.();
      }
    });

    it("projects a search relation that distinct() and distinctNodes() accept", async (ctx) => {
      const store = storeWith(context, ctx, ["fulltext"]);
      await seedMixedScores(store);

      const titles = await searchArticles(store, "fulltext")
        .project((expressions) => ({ title: expressions.a.title }))
        .asRelation()
        .distinct()
        .execute();
      expect(titles).toHaveLength(3);
      expect(titles).toEqual(
        expect.arrayContaining([
          { title: STRONG_TEXT },
          { title: MEDIUM_TEXT },
          { title: WEAK_TEXT },
        ]),
      );

      const identities = await searchArticles(store, "fulltext")
        .project((expressions) => ({
          kind: expressions.a.kind,
          id: expressions.a.id,
        }))
        .asRelation()
        .distinctNodes({ kind: "kind", id: "id" })
        .execute();
      expect(identities).toHaveLength(5);
    });

    it("counts every member of a search group on each terminal when the caller orders by a member field", async (ctx) => {
      const store = storeWith(context, ctx, ["fulltext"]);
      await seedMixedScores(store);

      // `peak` has two members with different titles. Ordering a grouped
      // statement by a member field must not make that field a grouping key
      // on any terminal (which would count `peak` as two groups of one).
      const grouped = () =>
        searchArticles(store, "fulltext")
          .orderBy("a", "title", "asc")
          .groupBy("a", "category")
          .aggregate({ category: field("a", "category"), n: count("a") });
      const members: Readonly<Record<string, number>> = { peak: 2, steady: 3 };

      const executed = await settle(() => grouped().execute());
      const first = await settle(() => grouped().first());
      const counted = await settle(() => grouped().count());
      const countsAllMembers = (row: CategoryCount | undefined) =>
        row !== undefined && row.n === members[row.category];
      // PostgreSQL refuses ordering groups by a member field outside the
      // GROUP BY, so there every terminal must refuse alike; elsewhere every
      // terminal must see two groups, each counting all of its members.
      const observed =
        "error" in executed ?
          { first, counted }
        : {
            groups: executed.value.length,
            executeCountsAll: executed.value.every((row) =>
              countsAllMembers(row),
            ),
            firstCountsAll: "value" in first && countsAllMembers(first.value),
            counted,
          };
      const correct =
        "error" in executed ?
          { first: executed, counted: executed }
        : {
            groups: 2,
            executeCountsAll: true,
            firstCountsAll: true,
            counted: { value: 2 },
          };
      expect(observed).toEqual(correct);
    });
  });

  describe("A grouped query ordered by an edge field", () => {
    it("runs through every relation-backed terminal", async () => {
      const store = context.getStore();
      const author = await store.nodes.Person.create({ name: "Author" });
      for (const [name, role] of [
        ["Acme", "advisor"],
        ["Globex", "advisor"],
        ["Initech", "engineer"],
      ] as const) {
        const company = await store.nodes.Company.create({ name });
        await store.edges.worksAt.create(author, company, { role });
      }

      const grouped = () =>
        store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "employment")
          .to("Company", "c")
          .orderBy("employment", "role", "asc")
          .groupBy((expressions) => expressions.employment.role)
          .aggregate({ role: field("employment", "role"), n: count("c") });
      const expected = [
        { role: "advisor", n: 2 },
        { role: "engineer", n: 1 },
      ];
      expect(await grouped().execute()).toEqual(expected);
      expect(sortedByRole(await grouped().prepare().execute({}))).toEqual(
        expected,
      );
      const [batched] = await store.batchOnce(() => [grouped()] as const);
      expect(sortedByRole(batched)).toEqual(expected);
      expect(expected).toContainEqual(await grouped().first());
      expect(await grouped().count()).toBe(2);
    });
  });
}
