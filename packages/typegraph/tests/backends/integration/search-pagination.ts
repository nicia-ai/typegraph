/**
 * Cursor pagination of full-text, vector and hybrid queries: `paginate()`,
 * `page()` (alone and in `store.batchOnce()`) and `stream()` visit every row
 * `execute()` selects exactly once, in `execute()`'s order, forward and
 * backward, with and without the caller's `orderBy()`.
 *
 * A search orders by relevance first, so the keyset leads with the relevance
 * keys, compares them exactly as the database returned them, and positions
 * the completed match rather than the candidates the search ranks.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStore,
  defineGraph,
  defineNode,
  embedding,
  searchable,
  subClassOf,
  ValidationError,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import {
  CompilerInvariantError,
  UnsupportedBackendCapabilityError,
} from "../../../src/errors";
import type { PaginatedResult } from "../../../src/query/builder/types";
import {
  SEARCH_CURSOR_MISMATCH,
  searchCursorFingerprint,
} from "../../../src/query/cursor";
import { getDialect } from "../../../src/query/dialect";
import { parseExactDoubleText } from "../../../src/query/dialect/exact-double-text";
import { sql } from "../../../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  type CompiledRowsSql,
} from "../../../src/query/sql-intent";
import type { Store } from "../../../src/store/store";
import { propertyRuns } from "../../property/run-budget";
import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

/** A store the search helpers read through: the lane's, or one over a derived backend. */
type SearchStore = Store<typeof integrationTestGraph>;

/**
 * Two searchable, embedded kinds, one a subclass of the other, for a search
 * whose alias spans both. The subclass's kind sorts first.
 */
const SearchMedia = defineNode("SpMedia", {
  schema: z.object({
    title: searchable({ language: "english" }),
    embedding: embedding(4),
  }),
});
const SearchClip = defineNode("SpClip", {
  schema: z.object({
    title: searchable({ language: "english" }),
    embedding: embedding(4),
  }),
});
/**
 * A searchable kind with a numeric field an `orderBy()` can break relevance
 * ties with.
 */
const SearchScored = defineNode("SpScored", {
  schema: z.object({
    title: searchable({ language: "english" }),
    embedding: embedding(4),
    weight: z.number(),
  }),
});
const scoredSearchGraph = defineGraph({
  id: "search_pagination_scored",
  nodes: { SpScored: { type: SearchScored } },
  edges: {},
});

/**
 * Doubles 15 significant digits render alike: a key that reached a cursor
 * through such text puts two rows at one position.
 */
const NEARLY_EQUAL_WEIGHTS = [0.29999999999999993, 0.3, 0.30000000000000004];

const polymorphicSearchGraph = defineGraph({
  id: "search_pagination_polymorphic",
  nodes: { SpMedia: { type: SearchMedia }, SpClip: { type: SearchClip } },
  edges: {},
  ontology: [subClassOf(SearchClip, SearchMedia)],
});

type SearchKind = "fulltext" | "vector" | "hybrid";
const SEARCH_KINDS: readonly SearchKind[] = ["fulltext", "vector", "hybrid"];

const QUERY_VECTOR = [1, 0, 0, 0];

/** A unit vector at `angle` radians from {@link QUERY_VECTOR}. */
function embeddingAt(angle: number): number[] {
  return [Math.cos(angle), Math.sin(angle), 0, 0];
}

/**
 * Five articles, most relevant first on every leg: the text repeats "climate"
 * less often and grows longer, the embedding turns further from
 * {@link QUERY_VECTOR}. `category` runs the other way, so an `orderBy()` on it
 * disagrees with relevance everywhere.
 */
const RANKED_ARTICLES = [
  ["r1", "climate climate climate climate climate", "e", 0],
  ["r2", "climate climate climate climate report", "d", 0.3],
  ["r3", "climate climate climate and a longer report text", "c", 0.6],
  [
    "r4",
    "climate climate and an even longer report text about stuff",
    "b",
    0.9,
  ],
  [
    "r5",
    "climate and a very long digression about shipping lanes harvest yields budgets",
    "a",
    1.2,
  ],
] as const;

async function seedRanked(store: IntegrationStore): Promise<void> {
  for (const [id, title, category, angle] of RANKED_ARTICLES) {
    await store.nodes.Article.create(
      {
        title,
        body: "notes",
        category,
        published: true,
        embedding: embeddingAt(angle),
      },
      { id },
    );
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
  kind: SearchKind,
): IntegrationStore {
  const store = context.getStore();
  for (const capability of capabilitiesOf(kind)) {
    if (store.backend.capabilities[capability]?.supported !== true) ctx.skip();
  }
  return store;
}

type SearchOptions = Readonly<{
  kind: SearchKind;
  k?: number;
  text?: string;
  approximate?: boolean;
  category?: string;
}>;

function searchArticles(store: SearchStore, options: SearchOptions) {
  const k = options.k ?? 10;
  const text = options.text ?? "climate";
  const vectorOptions =
    options.approximate === true ? { approximate: true } : {};
  const query = store
    .query()
    .from("Article", "a")
    .whereNode("a", (a) => {
      switch (options.kind) {
        case "fulltext": {
          return a.$fulltext.matches(text, k);
        }
        case "vector": {
          return a.embedding.similarTo(QUERY_VECTOR, k, vectorOptions);
        }
        case "hybrid": {
          return a.$fulltext
            .matches(text, k)
            .and(a.embedding.similarTo(QUERY_VECTOR, k, vectorOptions));
        }
      }
    });
  const { category } = options;
  return category === undefined ? query : (
      query.whereNode("a", (a) => a.category.eq(category))
    );
}

type Ordering = "relevance" | "category asc" | "category desc";
const ORDERINGS: readonly Ordering[] = [
  "relevance",
  "category asc",
  "category desc",
];

function orderedSearch(
  store: SearchStore,
  options: SearchOptions,
  ordering: Ordering,
) {
  const query = searchArticles(store, options);
  const ordered =
    ordering === "relevance" ? query
    : ordering === "category asc" ? query.orderBy("a", "category", "asc")
    : query.orderBy("a", "category", "desc");
  return ordered.select((ctx) => ({ id: ctx.a.id }));
}

type SearchQuery = ReturnType<typeof orderedSearch>;
type Row = Readonly<{ id: string }>;
type Terminal = "paginate" | "page" | "batchOnce" | "stream";
const TERMINALS: readonly Terminal[] = [
  "paginate",
  "page",
  "batchOnce",
  "stream",
];

type PageOptions = Readonly<{
  first?: number;
  last?: number;
  after?: string;
  before?: string;
}>;

async function readPage(
  store: SearchStore,
  query: () => SearchQuery,
  terminal: Exclude<Terminal, "stream">,
  options: PageOptions,
): Promise<PaginatedResult<Row>> {
  switch (terminal) {
    case "paginate": {
      return query().paginate(options);
    }
    case "page": {
      return query().page(options).execute();
    }
    case "batchOnce": {
      const [page] = await store.batchOnce(
        () => [query().page(options)] as const,
      );
      return page;
    }
  }
}

/** The guard on every walk: a broken cursor must fail, not loop. */
const MAX_PAGES = 50;

/**
 * Walks `query` to its end through `terminal`, `pageSize` rows a page,
 * forward (`first`/`after`) or backward (`last`/`before`, the pages then
 * reassembled in reading order), and returns the ids in the order read.
 */
async function walk(
  store: SearchStore,
  query: () => SearchQuery,
  terminal: Terminal,
  direction: "forward" | "backward",
  pageSize: number,
): Promise<readonly string[]> {
  if (terminal === "stream") {
    const streamed: string[] = [];
    for await (const row of query().stream({ batchSize: pageSize })) {
      streamed.push(row.id);
      if (streamed.length > MAX_PAGES * pageSize) break;
    }
    return streamed;
  }
  const pages: (readonly string[])[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < MAX_PAGES; guard += 1) {
    const options: PageOptions =
      direction === "forward" ?
        { first: pageSize, ...(cursor === undefined ? {} : { after: cursor }) }
      : { last: pageSize, ...(cursor === undefined ? {} : { before: cursor }) };
    const page = await readPage(store, query, terminal, options);
    pages.push(page.data.map((row) => row.id));
    const more = direction === "forward" ? page.hasNextPage : page.hasPrevPage;
    cursor = direction === "forward" ? page.nextCursor : page.prevCursor;
    if (!more || cursor === undefined) break;
  }
  return direction === "forward" ? pages.flat() : pages.toReversed().flat();
}

/**
 * On PostgreSQL, gives the node-id columns the search cuts read (the
 * full-text table's and the vector strategy's table for `Article.embedding`)
 * the ICU `unicode` collation, which orders `a` before `B`, and returns
 * the restore; `undefined` on SQLite, whose text is byte-ordered by
 * definition, or where the engine has no such collation.
 */
async function linguisticSearchNodeIds(
  store: IntegrationStore,
): Promise<(() => Promise<void>) | undefined> {
  const { backend } = store;
  if (backend.dialect !== "postgres") return undefined;
  const executeDdl = backend.executeDdl;
  const fulltextTable = backend.tableNames?.fulltext;
  const vectorTable = backend.vectorStrategy?.tableName(
    integrationTestGraph.id,
    "Article",
    "embedding",
  );
  if (executeDdl === undefined || fulltextTable === undefined) return undefined;
  const [probe] = await backend.execute<{ linguistic: unknown }>(
    asCompiledRowsSql(
      sql.raw(
        `SELECT CASE WHEN 'a' COLLATE "unicode" < 'B' COLLATE "unicode" THEN 1 ELSE 0 END AS linguistic`,
      ),
    ),
  );
  if (Number(probe?.linguistic) !== 1) return undefined;
  const tables = [
    fulltextTable,
    ...(vectorTable === undefined ? [] : [vectorTable]),
  ];
  const alter = async (collation: string) => {
    for (const table of tables)
      await executeDdl(
        `ALTER TABLE "${table}" ALTER COLUMN node_id TYPE text COLLATE ${collation}`,
      );
  };
  await alter(`"unicode"`);
  return () => alter(`"default"`);
}

/**
 * The text a cursor carries for a double relevance key of the value
 * `double`, rendered by the dialect's own `relevanceCursorKey` in SQL.
 */
async function renderedRelevanceKey(
  store: IntegrationStore,
  double: number,
): Promise<string> {
  const { relevanceCursorKey } = getDialect(store.backend.dialect);
  const source = "vector_distance" as const;
  const [row] = await store.backend.execute<{ key_text: unknown }>(
    asCompiledRowsSql(
      sql`SELECT ${relevanceCursorKey.select(relevanceCursorKey.value(sql`${double}`, source), source)} AS key_text`,
    ),
  );
  const text = row?.key_text;
  if (typeof text !== "string")
    throw new Error(`The dialect rendered no key text for ${double}`);
  return text;
}

/** A refusal as a test compares it: the class name of an invariant refusal. */
function invariantRefusal(error: unknown): unknown {
  return error instanceof CompilerInvariantError ?
      "CompilerInvariantError"
    : error;
}

async function executedIds(query: SearchQuery): Promise<readonly string[]> {
  const rows = await query.execute();
  return rows.map((row) => row.id);
}

/** The JSON a cursor encodes. */
function decodeCursorJson(cursor: string): Record<string, unknown> {
  const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(
    atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
  ) as Record<string, unknown>;
}

/**
 * Encodes cursor JSON as the library does: a UTF-16 code unit above U+00FF
 * as its JSON escape (a lone surrogate is one already), then base64.
 */
function encodeCursorJson(json: unknown): string {
  const escaped = JSON.stringify(json).replaceAll(
    /[\u0100-\uFFFF]/g,
    (unit) =>
      String.raw`\u${(unit.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
  return btoa(escaped)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function expectApproximatePagingRefusal(
  query: () => SearchQuery,
  reason: string,
): Promise<void> {
  const reads: readonly (() => Promise<unknown>)[] = [
    () => query().paginate({ first: 2 }),
    () => query().page({ last: 2 }).execute(),
    () => query().stream({ batchSize: 2 })[Symbol.asyncIterator]().next(),
  ];
  for (const read of reads) {
    const error = await Promise.resolve()
      .then(read)
      .then(
        () => "resolved without a refusal",
        (error_: unknown) => error_,
      );
    expect(error).toBeInstanceOf(UnsupportedBackendCapabilityError);
    expect((error as UnsupportedBackendCapabilityError).details).toEqual(
      expect.objectContaining({
        capability: "vector.repeatableApproximateSearch",
        reason,
      }),
    );
  }
}

/**
 * The ids `read` pages, or {@link SEARCH_CURSOR_MISMATCH} when it refuses the
 * cursor with that code; any other failure is thrown.
 */
async function readOrRefusal(
  read: () => Promise<PaginatedResult<Row>>,
): Promise<readonly string[] | typeof SEARCH_CURSOR_MISMATCH> {
  try {
    const page = await read();
    return page.data.map((row) => row.id);
  } catch (error) {
    if (
      error instanceof ValidationError &&
      error.details.issues.some(
        (issue) =>
          (issue as Readonly<{ code?: string }>).code ===
          SEARCH_CURSOR_MISMATCH,
      )
    )
      return SEARCH_CURSOR_MISMATCH;
    throw error;
  }
}

async function expectSearchCursorRefusal(
  read: () => Promise<unknown>,
): Promise<void> {
  const error = await Promise.resolve()
    .then(read)
    .then(
      () => "resolved without a refusal",
      (error_: unknown) => error_,
    );
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).details.issues).toEqual([
    expect.objectContaining({ path: "cursor", code: SEARCH_CURSOR_MISMATCH }),
  ]);
}

export function registerSearchPaginationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Cursor pagination of a full-text, vector or hybrid query", () => {
    for (const kind of SEARCH_KINDS) {
      for (const ordering of ORDERINGS) {
        it(`${kind}, ordered by ${ordering}: every terminal and direction reads execute()'s rows once, in order`, async (ctx) => {
          const store = storeWith(context, ctx, kind);
          await seedRanked(store);
          const query = () => orderedSearch(store, { kind }, ordering);
          const executed = await executedIds(query());
          expect(executed).toHaveLength(RANKED_ARTICLES.length);

          const walks: Record<string, readonly string[]> = {};
          for (const terminal of TERMINALS) {
            for (const direction of ["forward", "backward"] as const) {
              if (terminal === "stream" && direction === "backward") continue;
              walks[`${terminal} ${direction}`] = await walk(
                store,
                query,
                terminal,
                direction,
                2,
              );
            }
          }
          expect(walks).toEqual(
            Object.fromEntries(
              Object.keys(walks).map((name) => [name, executed]),
            ),
          );
        });
      }
    }

    for (const kind of SEARCH_KINDS) {
      it(`${kind}: rows tied on every relevance key come in row-identity order on execute() and every page`, async (ctx) => {
        const store = storeWith(context, ctx, kind);
        // Identical text and embedding: every relevance key ties. The ids are
        // created out of order so insertion order cannot pass for id order.
        for (const id of ["t3", "t1", "t5", "t2", "t4"]) {
          await store.nodes.Article.create(
            {
              title: "climate report",
              body: "notes",
              category: "same",
              published: true,
              embedding: embeddingAt(0.4),
            },
            { id },
          );
        }
        const query = () => orderedSearch(store, { kind }, "relevance");
        const executed = await executedIds(query());
        expect(executed).toEqual(["t1", "t2", "t3", "t4", "t5"]);
        for (const pageSize of [1, 2, 3]) {
          expect({
            pageSize,
            forward: await walk(store, query, "paginate", "forward", pageSize),
            backward: await walk(
              store,
              query,
              "paginate",
              "backward",
              pageSize,
            ),
            batched: await walk(store, query, "batchOnce", "forward", pageSize),
          }).toEqual({
            pageSize,
            forward: executed,
            backward: executed,
            batched: executed,
          });
        }
      });
    }

    for (const kind of SEARCH_KINDS) {
      it(`${kind}: rows tied on every relevance key whose ids read as numbers or infinities page once each`, async (ctx) => {
        const store = storeWith(context, ctx, kind);
        // Text a number parser (or SQLite's literal reader) takes for a
        // number or an infinity. The hybrid node-id tiebreak is text and
        // must be compared as text, not as the numeric relevance keys are.
        const ids = ["Inf", "-Inf", "NaN", "9e999", "0", "1e3"];
        for (const id of ids) {
          await store.nodes.Article.create(
            {
              title: "climate report",
              body: "notes",
              category: "same",
              published: true,
              embedding: embeddingAt(0.4),
            },
            { id },
          );
        }
        const query = () => orderedSearch(store, { kind }, "relevance");
        const executed = await executedIds(query());
        expect(executed.toSorted()).toEqual(ids.toSorted());
        for (const pageSize of [1, 2]) {
          expect({
            pageSize,
            forward: await walk(store, query, "paginate", "forward", pageSize),
            backward: await walk(
              store,
              query,
              "paginate",
              "backward",
              pageSize,
            ),
            batched: await walk(store, query, "batchOnce", "forward", pageSize),
            streamed: await walk(store, query, "stream", "forward", pageSize),
          }).toEqual({
            pageSize,
            forward: executed,
            backward: executed,
            batched: executed,
            streamed: executed,
          });
        }
      });
    }

    for (const kind of SEARCH_KINDS) {
      it(`${kind}: a page boundary between near-tied scores compares the key exactly as the database returned it`, async (ctx) => {
        const store = storeWith(context, ctx, kind);
        // Angles a few float32 steps apart give distances that differ only
        // in their last digits, and pairs of each give exact ties. A key that
        // lost any bits on its way through the cursor (a decimal shortened
        // to 15 digits, a float parsed and printed again) moves the boundary:
        // the boundary row comes back, or its tied neighbour is skipped.
        const angles = [0.7, 0.7, 0.7000001, 0.7000002, 0.7000002, 0.7];
        // The full-text ranks are near-tied the same way: "climate" and
        // "report" sit 300, 301 or 302 words apart, which moves both a BM25
        // rank (document length) and `ts_rank_cd` (cover length) by a
        // fraction of a percent, and repeats each spacing.
        const spacings = [300, 300, 301, 302, 302, 300];
        for (const [index, angle] of angles.entries()) {
          await store.nodes.Article.create(
            {
              title: `climate ${"pad ".repeat(spacings[index] ?? 0)}report`,
              body: "notes",
              category: "near",
              published: true,
              embedding: embeddingAt(angle),
            },
            { id: `n${index}` },
          );
        }
        const query = () =>
          orderedSearch(store, { kind, text: "climate report" }, "relevance");
        const executed = await executedIds(query());
        expect(executed).toHaveLength(angles.length);
        // Three distinct ranks, each tie broken by id: the ranks differ.
        expect({ kind, executed }).toEqual({
          kind,
          executed:
            kind === "fulltext" ?
              ["n0", "n1", "n5", "n2", "n3", "n4"]
            : executed,
        });
        expect({
          forward: await walk(store, query, "paginate", "forward", 1),
          backward: await walk(store, query, "paginate", "backward", 1),
          page: await walk(store, query, "page", "forward", 1),
          batched: await walk(store, query, "batchOnce", "backward", 1),
          stream: await walk(store, query, "stream", "forward", 1),
        }).toEqual({
          forward: executed,
          backward: executed,
          page: executed,
          batched: executed,
          stream: executed,
        });
      });
    }

    for (const kind of SEARCH_KINDS) {
      it(`${kind}: pages read the candidates execute() selects within k and never page past them`, async (ctx) => {
        const store = storeWith(context, ctx, kind);
        await seedRanked(store);
        // k = 3 keeps the three most relevant of five matches. A page whose
        // cursor filtered the candidates before the top k was taken would
        // rank the remaining two in and return them.
        const query = () =>
          orderedSearch(store, { kind, k: 3 }, "category asc");
        const executed = await executedIds(query());
        expect(executed.toSorted()).toEqual(["r1", "r2", "r3"]);
        expect({
          forward: await walk(store, query, "paginate", "forward", 1),
          backward: await walk(store, query, "paginate", "backward", 2),
          batched: await walk(store, query, "batchOnce", "forward", 2),
          stream: await walk(store, query, "stream", "forward", 2),
        }).toEqual({
          forward: executed,
          backward: executed,
          batched: executed,
          stream: executed,
        });
      });
    }

    for (const kind of SEARCH_KINDS) {
      it(`${kind}: a query selecting whole nodes pages them the same way`, async (ctx) => {
        const store = storeWith(context, ctx, kind);
        await seedRanked(store);
        // Selecting the node defeats the selective-field read, so the page
        // runs through the full-row statement and its cursor path.
        const query = () =>
          searchArticles(store, { kind })
            .orderBy("a", "category", "asc")
            .select((row) => row.a);
        const nodes = await query().execute();
        const executed = nodes.map((node) => node.id);
        const read = async (direction: "forward" | "backward") => {
          const pages: (readonly string[])[] = [];
          let cursor: string | undefined;
          for (let guard = 0; guard < MAX_PAGES; guard += 1) {
            const page = await query().paginate(
              direction === "forward" ?
                { first: 2, ...(cursor === undefined ? {} : { after: cursor }) }
              : {
                  last: 2,
                  ...(cursor === undefined ? {} : { before: cursor }),
                },
            );
            pages.push(page.data.map((node) => node.id));
            const more =
              direction === "forward" ? page.hasNextPage : page.hasPrevPage;
            cursor =
              direction === "forward" ? page.nextCursor : page.prevCursor;
            if (!more || cursor === undefined) break;
          }
          return direction === "forward" ?
              pages.flat()
            : pages.toReversed().flat();
        };
        expect({
          forward: await read("forward"),
          backward: await read("backward"),
        }).toEqual({ forward: executed, backward: executed });
      });
    }

    it("an approximate vector search pages exactly the candidates its execute() returns, under-filled or not, or is refused where the engine cannot repeat it", async (ctx) => {
      const store = storeWith(context, ctx, "vector");
      await seedRanked(store);
      for (let index = 0; index < 12; index += 1) {
        await store.nodes.Article.create({
          title: "filler",
          body: "notes",
          category: "filler",
          published: true,
          embedding: embeddingAt(0.05 * index),
        });
      }
      // The category filter leaves 5 of 17 rows. An engine whose filtered
      // approximate search does not guarantee a full page
      // (`filteredApproximateSearch.guaranteesFullPage`) may return fewer
      // than k; pagination reads whatever execute() selects, never more.
      const query = () =>
        searchArticles(store, {
          kind: "vector",
          k: 4,
          approximate: true,
          category: "c",
        })
          .orderBy("a", "category", "asc")
          .select((row) => ({ id: row.a.id }));
      const repeatability =
        store.backend.capabilities.vector?.repeatableApproximateSearch;
      if (repeatability?.repeatable === false) {
        // An engine whose approximate search changes from run to run cannot
        // page it: each page would rank another candidate set.
        await expectApproximatePagingRefusal(query, repeatability.reason);
        return;
      }
      const executed = await executedIds(query());
      expect(executed.length).toBeLessThanOrEqual(4);
      const guaranteesFullPage =
        store.backend.capabilities.vector?.filteredApproximateSearch
          .guaranteesFullPage === true;
      // A full-page engine returns the one row the filter leaves.
      expect(executed).toEqual(guaranteesFullPage ? ["r3"] : executed);
      expect({
        forward: await walk(store, query, "paginate", "forward", 1),
        backward: await walk(store, query, "paginate", "backward", 1),
      }).toEqual({ forward: executed, backward: executed });

      const wide = () =>
        searchArticles(store, { kind: "vector", k: 4, approximate: true })
          .orderBy("a", "category", "desc")
          .select((row) => ({ id: row.a.id }));
      const wideExecuted = await executedIds(wide());
      expect(wideExecuted.length).toBeLessThanOrEqual(4);
      expect({
        forward: await walk(store, wide, "paginate", "forward", 3),
        backward: await walk(store, wide, "paginate", "backward", 3),
      }).toEqual({ forward: wideExecuted, backward: wideExecuted });
    });

    it("a fulltext search on a traversal's start alias pages each match row once", async (ctx) => {
      const store = storeWith(context, ctx, "fulltext");
      await seedRanked(store);
      // Two parallel edges from each article to one author: the two rows of an
      // article tie on relevance and on the author's name, so only the edge id
      // the row identity appends tells them apart, and a page of three splits
      // a pair.
      const alice = await store.nodes.Person.create({ name: "Alice" });
      for (const [id] of RANKED_ARTICLES) {
        for (let parallel = 0; parallel < 2; parallel += 1) {
          await store.edges.authoredBy.create(
            { kind: "Article", id },
            { kind: "Person", id: alice.id },
            {},
          );
        }
      }
      const query = () =>
        store
          .query()
          .from("Article", "a")
          .whereNode("a", (a) => a.$fulltext.matches("climate", 10))
          .traverse("authoredBy", "w")
          .to("Person", "p")
          .orderBy("p", "name", "desc")
          .select((row) => ({ id: `${row.a.id}:${row.w.id}` }));
      const rows = await query().execute();
      const executed = rows.map((row) => row.id);
      expect(executed).toHaveLength(RANKED_ARTICLES.length * 2);
      const pages: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < MAX_PAGES; guard += 1) {
        const page = await query().paginate({
          first: 3,
          ...(cursor === undefined ? {} : { after: cursor }),
        });
        pages.push(...page.data.map((row) => row.id));
        if (!page.hasNextPage || page.nextCursor === undefined) break;
        cursor = page.nextCursor;
      }
      expect(pages).toEqual(executed);
    });

    it("pages a search and a plain query whose ids and sort values are outside Latin-1", async (ctx) => {
      const store = storeWith(context, ctx, "fulltext");
      for (const [index, id] of ["東京", "😀-doc", "é-doc", "大阪"].entries()) {
        await store.nodes.Article.create(
          {
            title: "climate report",
            body: "notes",
            category: `${id}-${index}`,
            published: true,
            embedding: embeddingAt(0.1 * index),
          },
          { id },
        );
      }
      const supported = SEARCH_KINDS.filter((kind) =>
        capabilitiesOf(kind).every(
          (capability) =>
            store.backend.capabilities[capability]?.supported === true,
        ),
      );
      for (const kind of supported) {
        const query = () => orderedSearch(store, { kind }, "relevance");
        expect({
          kind,
          forward: await walk(store, query, "paginate", "forward", 1),
          backward: await walk(store, query, "batchOnce", "backward", 1),
        }).toEqual({
          kind,
          forward: await executedIds(query()),
          backward: await executedIds(query()),
        });
      }
      const plain = () =>
        store
          .query()
          .from("Article", "a")
          .orderBy("a", "category", "asc")
          .select((row) => ({ id: row.a.id }));
      const plainRows = await plain().execute();
      const first = await plain().paginate({ first: 2 });
      const second = await plain().paginate({
        first: 2,
        after: requireCursor(first.nextCursor),
      });
      expect([...first.data, ...second.data]).toEqual(plainRows);
    });

    it("refuses a cursor whose text its database cannot hold (a NUL on PostgreSQL, a lone surrogate anywhere) before it reaches the database, and pages a NUL where the text can hold it", async () => {
      const store = context.getStore();
      await seedRanked(store);
      const kinds = SEARCH_KINDS.filter((kind) =>
        capabilitiesOf(kind).every(
          (capability) =>
            store.backend.capabilities[capability]?.supported === true,
        ),
      );
      const { textAdmitsNul } = getDialect(store.backend.dialect).capabilities;
      const issued: (readonly [string, () => SearchQuery])[] = [
        [
          "plain",
          () =>
            store
              .query()
              .from("Article", "a")
              .orderBy("a", "category", "asc")
              .select((row) => ({ id: row.a.id })),
        ],
        ...kinds.map(
          (kind) =>
            [
              kind,
              () => orderedSearch(store, { kind }, "category asc"),
            ] as const,
        ),
      ];
      for (const [name, query] of issued) {
        const first = await query().paginate({ first: 2 });
        const json = decodeCursorJson(requireCursor(first.nextCursor));
        const vals = json["vals"] as readonly unknown[];
        // Every text key (the category, the hybrid node-id tiebreak, the
        // row's id) in turn carries a NUL, then a lone surrogate, which no
        // database stores or returns.
        const forgeries = [...vals.entries()].flatMap(
          (entry) =>
            [
              [entry, "nul"],
              [entry, "lone surrogate"],
            ] as const,
        );
        for (const [[index, value], forgedText] of forgeries) {
          const column = (json["cols"] as readonly string[])[index];
          if (
            typeof value !== "string" ||
            (String(column).startsWith("@relevance.") &&
              column !== "@relevance.hybrid_node_id")
          )
            continue;
          const forged = encodeCursorJson({
            ...json,
            vals: vals.map((entry, position) =>
              position === index ?
                `${value}${forgedText === "nul" ? "\u0000" : "\uD800"}x`
              : entry,
            ),
          });
          const outcomes = [
            await Promise.resolve()
              .then(() => query().paginate({ first: 2, after: forged }))
              .then(
                () => "page",
                (error: unknown) => error,
              ),
            await Promise.resolve()
              .then(() => query().page({ last: 2, before: forged }).execute())
              .then(
                () => "page",
                (error: unknown) => error,
              ),
          ].map((outcome) =>
            outcome === "page" ? "page"
            : (
              outcome instanceof ValidationError &&
              outcome.details.issues.every((issue) => issue.path === "cursor")
            ) ?
              "refused"
            : outcome,
          );
          expect({ name, column, forgedText, outcomes }).toEqual({
            name,
            column,
            forgedText,
            outcomes:
              forgedText === "nul" && textAdmitsNul ?
                ["page", "page"]
              : ["refused", "refused"],
          });
        }
      }
    });

    it("refuses to page a search whose rows are groups, with GROUPED_SEARCH_PAGINATION_UNSUPPORTED", async (ctx) => {
      const store = storeWith(context, ctx, "fulltext");
      await seedRanked(store);
      const grouped = () =>
        store
          .query()
          .from("Article", "a")
          .whereNode("a", (a) => a.$fulltext.matches("climate", 10))
          .groupByNode("a")
          .select((row) => ({ id: row.a.id }));
      const refusals: readonly (() => Promise<unknown>)[] = [
        () => grouped().paginate({ first: 2 }),
        () => grouped().page({ first: 2 }).execute(),
        () => grouped().stream({ batchSize: 2 })[Symbol.asyncIterator]().next(),
      ];
      for (const read of refusals) {
        const error = await Promise.resolve()
          .then(read)
          .then(
            () => "resolved without a refusal",
            (error_: unknown) => error_,
          );
        expect(error).toBeInstanceOf(ConfigurationError);
        expect((error as ConfigurationError).details).toEqual(
          expect.objectContaining({
            code: "GROUPED_SEARCH_PAGINATION_UNSUPPORTED",
          }),
        );
      }
    });

    it("refuses a cursor that does not position the search, with SEARCH_CURSOR_MISMATCH", async (ctx) => {
      const store = storeWith(context, ctx, "fulltext");
      await seedRanked(store);
      const query = () =>
        orderedSearch(store, { kind: "fulltext" }, "category asc");
      const first = await query().paginate({ first: 2 });
      const cursor = requireCursor(first.nextCursor);

      // A cursor this library issued for the same query before search
      // cursors carried their relevance keys: the caller's key and the
      // id, nothing else.
      const legacy = encodeCursorJson({
        v: 1,
        d: "f",
        vals: ["d", "r2"],
        cols: ["a.category", "a.id"],
      });
      await expectSearchCursorRefusal(() =>
        query().paginate({ after: legacy }),
      );
      await expectSearchCursorRefusal(() =>
        query().page({ after: legacy }).execute(),
      );

      // Another search's cursor, and a search's cursor on a query without one.
      await expectSearchCursorRefusal(() =>
        orderedSearch(
          store,
          { kind: "fulltext", text: "report" },
          "category asc",
        ).paginate({ after: cursor }),
      );
      await expectSearchCursorRefusal(() =>
        orderedSearch(
          store,
          { kind: "fulltext", k: 4 },
          "category asc",
        ).paginate({ after: cursor }),
      );
      await expectSearchCursorRefusal(() =>
        store
          .query()
          .from("Article", "a")
          .orderBy("a", "category", "asc")
          .select((row) => ({ id: row.a.id }))
          .paginate({ after: cursor }),
      );

      // A relevance key that is not a value this backend issued: the key is
      // carried as the text the database rendered, never as a number.
      const json = decodeCursorJson(cursor);
      const vals = json["vals"] as unknown[];
      expect(typeof vals[0]).toBe("string");
      for (const forged of [0.5, "not a score", ""]) {
        const tampered = encodeCursorJson({
          ...json,
          vals: [forged, ...vals.slice(1)],
        });
        await expectSearchCursorRefusal(() =>
          query().paginate({ after: tampered }),
        );
      }

      // The same search scored by another dialect's engine.
      const foreign = encodeCursorJson({
        ...json,
        s: searchCursorFingerprint(
          query().toAst(),
          store.backend.dialect === "postgres" ? "sqlite" : "postgres",
        ),
      });
      await expectSearchCursorRefusal(() =>
        query().paginate({ after: foreign }),
      );

      // The cursor itself keeps working.
      const second = await query().paginate({ first: 10, after: cursor });
      expect([...first.data, ...second.data].map((row) => row.id)).toEqual(
        await executedIds(query()),
      );
    });

    it("keeps a query without a search on the cursor it always issued, byte for byte", async () => {
      const store = context.getStore();
      for (const [id, , category] of RANKED_ARTICLES) {
        await store.nodes.Article.create(
          { title: "plain", body: "notes", category, published: true },
          { id },
        );
      }
      const query = () =>
        store
          .query()
          .from("Article", "a")
          .orderBy("a", "category", "asc")
          .select((row) => ({ id: row.a.id }));
      const first = await query().paginate({ first: 2 });
      // Issued by the release before relevance-ordered cursors:
      // {"v":1,"d":"f","vals":["b","r4"],"cols":["a.category","a.id"]}.
      const golden =
        "eyJ2IjoxLCJkIjoiZiIsInZhbHMiOlsiYiIsInI0Il0sImNvbHMiOlsiYS5jYXRlZ29yeSIsImEuaWQiXX0";
      expect(first.data.map((row) => row.id)).toEqual(["r5", "r4"]);
      expect(first.nextCursor).toBe(golden);
      const second = await query().paginate({ first: 2, after: golden });
      expect(second.data.map((row) => row.id)).toEqual(["r3", "r2"]);
      const [batched] = await store.batchOnce(
        () => [query().page({ first: 2 })] as const,
      );
      expect(batched.nextCursor).toBe(golden);
    });

    // A hybrid score is fused from per-leg ranks, which never tie, so only
    // the full-text and vector legs leave an orderBy() key to decide.
    for (const kind of ["fulltext", "vector"] as const) {
      it(`${kind}: a batched page carries a numeric orderBy() key exactly, so rows tied on relevance whose keys differ in the last bits are each read once`, async (ctx) => {
        storeWith(context, ctx, kind);
        const store = await context.createStore(scoredSearchGraph);
        // Tied on every relevance key; only the weight orders them, and the
        // weights differ past 15 significant digits.
        for (const [index, weight] of NEARLY_EQUAL_WEIGHTS.entries()) {
          await store.nodes.SpScored.create(
            { title: "climate report", embedding: embeddingAt(0.4), weight },
            { id: `w${index}` },
          );
        }
        const query = () =>
          store
            .query()
            .from("SpScored", "s")
            .whereNode("s", (s) => {
              switch (kind) {
                case "fulltext": {
                  return s.$fulltext.matches("climate", 10);
                }
                case "vector": {
                  return s.embedding.similarTo(QUERY_VECTOR, 10);
                }
              }
            })
            .orderBy("s", "weight", "desc")
            .select((row) => ({ id: row.s.id }));
        const rows = await query().execute();
        const executed = rows.map((row) => row.id);
        expect(executed).toEqual(["w2", "w1", "w0"]);
        const read: string[] = [];
        const cursors: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 6; guard += 1) {
          const options = {
            first: 1,
            ...(cursor === undefined ? {} : { after: cursor }),
          };
          const [batched] = await store.batchOnce(
            () => [query().page(options)] as const,
          );
          const page = await query().paginate(options);
          read.push(...batched.data.map((row) => row.id));
          // The batched page issues the cursor paginate() issues.
          cursors.push(String(batched.nextCursor === page.nextCursor));
          cursor = batched.nextCursor;
          if (!batched.hasNextPage || cursor === undefined) break;
        }
        expect({ read, cursors }).toEqual({
          read: executed,
          cursors: executed.map(() => "true"),
        });
      });
    }

    it("a vector search whose k cut falls inside a tie returns the same rows on every execution, and its pages read exactly them", async (ctx) => {
      const store = storeWith(context, ctx, "vector");
      // 26 identical embeddings and k = 5: which five make the cut is decided
      // by the tiebreak inside the engine's top-k, or by the engine itself.
      const ids = Array.from({ length: 26 }, (_unused, index) =>
        String.fromCodePoint(97 + index),
      );
      for (const id of ids) {
        await store.nodes.Article.create(
          {
            title: "climate",
            body: "notes",
            category: "tied",
            published: true,
            embedding: embeddingAt(0.4),
          },
          { id },
        );
      }
      const repeatability =
        store.backend.capabilities.vector?.repeatableApproximateSearch;
      for (const approximate of [false, true]) {
        const query = () =>
          searchArticles(store, { kind: "vector", k: 5, approximate }).select(
            (row) => ({ id: row.a.id }),
          );
        if (approximate && repeatability?.repeatable === false) {
          await expectApproximatePagingRefusal(query, repeatability.reason);
          continue;
        }
        const executions = new Set<string>();
        for (let run = 0; run < 20; run += 1) {
          const rows = await executedIds(query());
          executions.add(rows.join(","));
        }
        expect({ approximate, executions: [...executions] }).toEqual({
          approximate,
          executions: [expect.any(String)],
        });
        const executed = await executedIds(query());
        expect(executed).toHaveLength(5);
        // The exact cut is total: tied distances fall back to the node id.
        expect({ approximate, executed }).toEqual({
          approximate,
          executed: approximate ? executed : ["a", "b", "c", "d", "e"],
        });
        expect({
          approximate,
          forward: await walk(store, query, "paginate", "forward", 1),
          backward: await walk(store, query, "paginate", "backward", 1),
          batched: await walk(store, query, "batchOnce", "forward", 2),
          stream: await walk(store, query, "stream", "forward", 1),
        }).toEqual({
          approximate,
          forward: executed,
          backward: executed,
          batched: executed,
          stream: executed,
        });
      }
    });

    for (const kind of SEARCH_KINDS) {
      it(`${kind}: a k cut inside a tie keeps the candidate whose id sorts first in byte order, as store.search does`, async (ctx) => {
        const store = storeWith(context, ctx, kind);
        // Tied on every leg. Byte order puts "B" (0x42) before "a" (0x61);
        // a linguistic collation puts "a" first. Created "a" first, so an
        // order that fell back to storage would keep "a" too.
        for (const id of ["a", "B"]) {
          await store.nodes.Article.create(
            {
              title: "climate",
              body: "notes",
              category: "binary",
              published: true,
              embedding: embeddingAt(0.3),
            },
            { id },
          );
        }
        // On PostgreSQL the tied ids are compared under a linguistic
        // collation, so the case fails if a cut loses its byte order.
        const restore = await linguisticSearchNodeIds(store);
        try {
          const query = () =>
            searchArticles(store, { kind, k: 1 }).select((row) => ({
              id: row.a.id,
            }));
          const facade =
            kind === "fulltext" ?
              await store.search.fulltext("Article", {
                query: "climate",
                limit: 1,
              })
            : kind === "vector" ?
              await store.search.vector("Article", {
                fieldPath: "embedding",
                queryEmbedding: QUERY_VECTOR,
                limit: 1,
              })
            : await store.search.hybrid("Article", {
                limit: 1,
                vector: {
                  fieldPath: "embedding",
                  queryEmbedding: QUERY_VECTOR,
                },
                fulltext: { query: "climate" },
              });
          expect({
            kind,
            facade: facade.map((hit) => hit.node.id),
            executed: await executedIds(query()),
            paged: await walk(store, query, "paginate", "forward", 1),
            batched: await walk(store, query, "batchOnce", "forward", 1),
          }).toEqual({
            kind,
            facade: ["B"],
            executed: ["B"],
            paged: ["B"],
            batched: ["B"],
          });
        } finally {
          await restore?.();
        }
      });

      it(`${kind}: a k cut inside a tie between two kinds' nodes with one id takes them in kind order, on execute() and every page`, async (ctx) => {
        storeWith(context, ctx, kind);
        const store = await context.createStore(polymorphicSearchGraph);
        // One id in both kinds, tied on every leg: only the kind decides
        // which of the two the k = 1 cut keeps.
        for (const create of [
          () =>
            store.nodes.SpMedia.create(
              { title: "climate", embedding: embeddingAt(0.3) },
              { id: "x" },
            ),
          () =>
            store.nodes.SpClip.create(
              { title: "climate", embedding: embeddingAt(0.3) },
              { id: "x" },
            ),
          () =>
            store.nodes.SpMedia.create(
              { title: "climate climate", embedding: embeddingAt(0) },
              { id: "w" },
            ),
        ]) {
          await create();
        }
        const search = (k: number) =>
          store
            .query()
            .from("SpMedia", "m", { expansion: "subclasses" })
            .whereNode("m", (m) => {
              switch (kind) {
                case "fulltext": {
                  return m.$fulltext.matches("climate", k);
                }
                case "vector": {
                  return m.embedding.similarTo(QUERY_VECTOR, k);
                }
                case "hybrid": {
                  return m.$fulltext
                    .matches("climate", k)
                    .and(m.embedding.similarTo(QUERY_VECTOR, k));
                }
              }
            })
            .select((row) => ({ id: `${row.m.kind}:${row.m.id}` }));
        // The walk helpers are typed for the shared graph; they only read the
        // terminals and `batchOnce`, which every store and query here has.
        const pager = store as unknown as SearchStore;
        const query = (k: number) => () => search(k) as unknown as SearchQuery;
        const executions = new Set<string>();
        for (let run = 0; run < 10; run += 1) {
          const executed = await executedIds(query(2)());
          executions.add(executed.join(","));
        }
        expect({ kind, executions: [...executions] }).toEqual({
          kind,
          executions: ["SpMedia:w,SpClip:x"],
        });
        for (const k of [2, 3]) {
          const executed = await executedIds(query(k)());
          expect({
            kind,
            k,
            forward: await walk(pager, query(k), "paginate", "forward", 1),
            backward: await walk(pager, query(k), "page", "backward", 1),
            batched: await walk(pager, query(k), "batchOnce", "forward", 1),
            stream: await walk(pager, query(k), "stream", "forward", 1),
          }).toEqual({
            kind,
            k,
            forward: executed,
            backward: executed,
            batched: executed,
            stream: executed,
          });
        }
      });
    }

    it("refuses a page that does not advance past its cursor instead of returning it, so stream() ends", async () => {
      const laneStore = context.getStore();
      const laneBackend = laneStore.backend;
      await seedRanked(laneStore);
      // A backend that, once armed, answers every statement with the rows
      // of the last statement it ran: the page after a cursor then reads the
      // cursor's own row again, the condition a key that does not round-trip
      // produces.
      let lastRows: readonly unknown[] = [];
      let replaying = false;
      const store = createStore(
        integrationTestGraph,
        deriveBackend(laneBackend, {
          execute: async <T>(query: CompiledRowsSql): Promise<readonly T[]> => {
            if (!replaying) lastRows = await laneBackend.execute<T>(query);
            return lastRows as readonly T[];
          },
        }),
      );
      const kinds = SEARCH_KINDS.filter((kind) =>
        capabilitiesOf(kind).every(
          (capability) =>
            laneBackend.capabilities[capability]?.supported === true,
        ),
      );
      const queries = [
        ...kinds.map(
          (kind) =>
            [kind, () => orderedSearch(store, { kind }, "relevance")] as const,
        ),
        [
          "plain",
          () =>
            store
              .query()
              .from("Article", "a")
              .orderBy("a", "category", "desc")
              .select((row) => ({ id: row.a.id })),
        ] as const,
      ];
      const outcomes = [];
      for (const [kind, query] of queries) {
        for (const direction of ["forward", "backward"] as const) {
          replaying = false;
          const first = await query().paginate(
            direction === "forward" ? { first: 1 } : { last: 1 },
          );
          const cursor =
            direction === "forward" ? first.nextCursor : first.prevCursor;
          replaying = true;
          const options =
            direction === "forward" ?
              { first: 1, after: requireCursor(cursor) }
            : { last: 1, before: requireCursor(cursor) };
          outcomes.push({
            kind,
            direction,
            paginate: await query()
              .paginate(options)
              .then(() => "page", invariantRefusal),
            page: await query()
              .page(options)
              .execute()
              .then(() => "page", invariantRefusal),
          });
        }
        const streamed: string[] = [];
        let streamOutcome: unknown = "ended";
        replaying = false;
        try {
          for await (const row of query().stream({ batchSize: 1 })) {
            streamed.push(row.id);
            // The first batch has been read; every later one replays it.
            replaying = true;
            if (streamed.length > MAX_PAGES) break;
          }
        } catch (error) {
          streamOutcome = invariantRefusal(error);
        }
        outcomes.push({ kind, stream: streamOutcome, streamed });
      }
      expect(outcomes).toEqual(
        queries.flatMap(([kind]) => [
          {
            kind,
            direction: "forward",
            paginate: "CompilerInvariantError",
            page: "CompilerInvariantError",
          },
          {
            kind,
            direction: "backward",
            paginate: "CompilerInvariantError",
            page: "CompilerInvariantError",
          },
          { kind, stream: "CompilerInvariantError", streamed: ["r1"] },
        ]),
      );
    });

    it("pages a search through a custom strategy whose engine form is exact, approximate or not, even when it declares no approximate repeatability", async (ctx) => {
      const laneStore = storeWith(context, ctx, "vector");
      const laneBackend = laneStore.backend;
      const strategy = laneBackend.vectorStrategy;
      if (strategy === undefined) {
        ctx.skip();
        return;
      }
      await seedRanked(laneStore);
      // A strategy whose buildSearch is exact (searchIsExact) serves both
      // the exact and the approximate search through its engine form, so
      // neither retrieves approximately; it declares nothing about
      // approximate repeatability, which then reads as not repeatable.
      const {
        repeatableApproximateSearch: _undeclared,
        ...undeclaredCapabilities
      } = strategy.capabilities;
      const store = createStore(
        integrationTestGraph,
        deriveBackend(laneBackend, {
          vectorStrategy: {
            ...strategy,
            searchIsExact: true,
            capabilities: undeclaredCapabilities,
          },
        }),
      );
      for (const approximate of [false, true]) {
        const query = () =>
          searchArticles(store, { kind: "vector", approximate }).select(
            (row) => ({ id: row.a.id }),
          );
        const executed = await executedIds(query());
        expect({ approximate, executed }).toEqual({
          approximate,
          executed: ["r1", "r2", "r3", "r4", "r5"],
        });
        expect({
          approximate,
          forward: await walk(store, query, "paginate", "forward", 2),
          backward: await walk(store, query, "page", "backward", 2),
          batched: await walk(store, query, "batchOnce", "forward", 2),
          stream: await walk(store, query, "stream", "forward", 2),
        }).toEqual({
          approximate,
          forward: executed,
          backward: executed,
          batched: executed,
          stream: executed,
        });
      }
    });

    for (const kind of ["vector", "hybrid"] as const) {
      for (const ordering of ORDERINGS) {
        it(`${kind}, ordered by ${ordering}: a zero embedding, whose cosine distance is undefined, never matches the vector search, and pages read exactly execute()'s rows`, async (ctx) => {
          const store = storeWith(context, ctx, kind);
          await seedRanked(store);
          for (const id of ["z1", "z2", "z3"]) {
            await store.nodes.Article.create(
              {
                title: "climate notes",
                body: "notes",
                category: "m",
                published: true,
                embedding: [0, 0, 0, 0],
              },
              { id },
            );
          }
          // A zero embedding on a row the full-text leg does not match: only
          // the vector leg could bring it into either search.
          await store.nodes.Article.create(
            {
              title: "shipping lanes",
              body: "notes",
              category: "m",
              published: true,
              embedding: [0, 0, 0, 0],
            },
            { id: "z4" },
          );
          const query = () => orderedSearch(store, { kind }, ordering);
          const executed = await executedIds(query());
          // SQLite computes the distance as NULL and sorted it first,
          // PostgreSQL as NaN and sorted it last: neither is a neighbor. A
          // hybrid search still finds z1-z3 through its full-text leg, and
          // never z4, which only the vector leg could match.
          expect(executed.toSorted()).toEqual(
            kind === "vector" ?
              ["r1", "r2", "r3", "r4", "r5"]
            : ["r1", "r2", "r3", "r4", "r5", "z1", "z2", "z3"],
          );
          expect({
            forward: await walk(store, query, "paginate", "forward", 1),
            backward: await walk(store, query, "paginate", "backward", 1),
            page: await walk(store, query, "page", "backward", 2),
            batched: await walk(store, query, "batchOnce", "forward", 1),
            stream: await walk(store, query, "stream", "forward", 1),
          }).toEqual({
            forward: executed,
            backward: executed,
            page: executed,
            batched: executed,
            stream: executed,
          });
        });
      }
    }

    it("positions a cursor whose relevance key is NULL after every row with a value, on every key", async (ctx) => {
      const store = context.getStore();
      const kinds = SEARCH_KINDS.filter((kind) =>
        capabilitiesOf(kind).every(
          (capability) =>
            store.backend.capabilities[capability]?.supported === true,
        ),
      );
      if (kinds.length === 0) ctx.skip();
      await seedRanked(store);
      for (const kind of kinds) {
        const query = () => orderedSearch(store, { kind }, "category asc");
        const executed = await executedIds(query());
        const first = await query().paginate({ first: 2 });
        const json = decodeCursorJson(requireCursor(first.nextCursor));
        const cols = json["cols"] as readonly string[];
        const vals = json["vals"] as readonly unknown[];
        // NULL in every numeric relevance key: the least relevant place,
        // after every row (relevance NULLs sort last on every dialect).
        const atNull = encodeCursorJson({
          ...json,
          vals: vals.map((value, index) =>
            (
              cols[index] === "@relevance.hybrid_node_id" ||
              !String(cols[index]).startsWith("@relevance.")
            ) ?
              value
              // eslint-disable-next-line unicorn/no-null -- the JSON a cursor carries a NULL key as
            : null,
          ),
        });
        const after = await query().paginate({ first: 10, after: atNull });
        const before = await query().paginate({ last: 2, before: atNull });
        expect({
          kind,
          after: after.data.map((row) => row.id),
          before: before.data.map((row) => row.id),
        }).toEqual({ kind, after: [], before: executed.slice(-2) });
      }
    });

    it("a query embedding or fusion option mutated after the query is built changes neither its rows nor its cursor", async (ctx) => {
      const store = storeWith(context, ctx, "hybrid");
      await seedRanked(store);
      const embedding = [...QUERY_VECTOR];
      const fusion = { k: 60, weights: { vector: 1, fulltext: 1 } };
      const built = store
        .query()
        .from("Article", "a")
        .whereNode("a", (a) =>
          a.$fulltext
            .matches("climate", 10)
            .and(a.embedding.similarTo(embedding, 10)),
        )
        .fuseWith(fusion)
        .select((row) => ({ id: row.a.id }));
      const vectorOnly = store
        .query()
        .from("Article", "a")
        .whereNode("a", (a) => a.embedding.similarTo(embedding, 10))
        .select((row) => ({ id: row.a.id }));
      const executed = await executedIds(built);
      const vectorExecuted = await executedIds(vectorOnly);
      const first = await built.paginate({ first: 2 });
      const vectorFirst = await vectorOnly.paginate({ first: 2 });

      // Point the caller's arrays and options at the least relevant row.
      embedding.splice(0, embedding.length, ...embeddingAt(1.2));
      fusion.weights.vector = 50;
      fusion.k = 1;

      const rest = await built.paginate({
        first: 10,
        after: requireCursor(first.nextCursor),
      });
      const vectorRest = await vectorOnly.paginate({
        first: 10,
        after: requireCursor(vectorFirst.nextCursor),
      });
      expect({
        hybrid: [...first.data, ...rest.data].map((row) => row.id),
        hybridExecute: await executedIds(built),
        vector: [...vectorFirst.data, ...vectorRest.data].map((row) => row.id),
        vectorExecute: await executedIds(vectorOnly),
      }).toEqual({
        hybrid: executed,
        hybridExecute: executed,
        vector: vectorExecuted,
        vectorExecute: vectorExecuted,
      });
    });

    it("pages a hybrid search whose fused score is past the largest double exactly as execute() orders it", async (ctx) => {
      const store = storeWith(context, ctx, "hybrid");
      await seedRanked(store);
      // Valid fusion options whose fused score, weight / (k + rank) summed
      // over both legs, exceeds the largest double: PostgreSQL computes it as
      // NUMERIC, SQLite as REAL, where it is an infinity.
      const query = () =>
        searchArticles(store, { kind: "hybrid" })
          .fuseWith({
            k: 0.5,
            weights: { vector: Number.MAX_VALUE, fulltext: Number.MAX_VALUE },
          })
          .select((row) => ({ id: row.a.id }));
      const executed = await executedIds(query());
      expect(executed.toSorted()).toEqual(["r1", "r2", "r3", "r4", "r5"]);
      expect({
        forward: await walk(store, query, "paginate", "forward", 1),
        backward: await walk(store, query, "page", "backward", 2),
        batched: await walk(store, query, "batchOnce", "forward", 2),
        stream: await walk(store, query, "stream", "forward", 1),
      }).toEqual({
        forward: executed,
        backward: executed,
        batched: executed,
        stream: executed,
      });
    });

    it("pages a hybrid search whose fused scores are large finite doubles exactly as execute() orders it, one row a page", async (ctx) => {
      const store = storeWith(context, ctx, "hybrid");
      // Every order of the vector leg against the full-text leg, so the
      // fused scores take every sum of two ordinals' shares, ties included.
      const titles = [
        "climate climate climate",
        "climate climate report",
        "climate and a longer report",
      ];
      const angleOrders = [
        [0, 0.3, 0.6],
        [0, 0.6, 0.3],
        [0.3, 0, 0.6],
        [0.3, 0.6, 0],
        [0.6, 0, 0.3],
        [0.6, 0.3, 0],
      ];
      // Fused scores near 1e126: weight / (1 + ordinal) summed over the legs.
      const weight = 2.1720897273118987e126;
      const outcomes = [];
      for (const [order, angles] of angleOrders.entries()) {
        const category = `large${order}`;
        for (const [index, title] of titles.entries()) {
          await store.nodes.Article.create(
            {
              title,
              body: "notes",
              category,
              published: true,
              embedding: embeddingAt(angles[index] ?? 0),
            },
            { id: `h${order}${index}` },
          );
        }
        const query = () =>
          searchArticles(store, { kind: "hybrid", category })
            .fuseWith({ k: 1, weights: { vector: weight, fulltext: weight } })
            .select((row) => ({ id: row.a.id }));
        const executed = await executedIds(query());
        outcomes.push({
          order,
          sorted: executed.toSorted(),
          forward: await walk(store, query, "paginate", "forward", 1),
          backward: await walk(store, query, "page", "backward", 1),
          batched: await walk(store, query, "batchOnce", "forward", 1),
          stream: await walk(store, query, "stream", "forward", 1),
          executed,
        });
      }
      expect(outcomes).toEqual(
        outcomes.map(({ order, executed }) => ({
          order,
          sorted: [`h${order}0`, `h${order}1`, `h${order}2`],
          forward: executed,
          backward: executed,
          batched: executed,
          stream: executed,
          executed,
        })),
      );
    });

    it("pages a vector search whose distance is infinite exactly as execute() orders it", async (ctx) => {
      const store = storeWith(context, ctx, "vector");
      await seedRanked(store);
      // Finite single-precision components whose squared L2 distance from
      // the query overflows: the engine returns an infinite distance.
      for (const [id, sign] of [
        ["i1", 1],
        ["i2", -1],
      ] as const) {
        await store.nodes.Article.create(
          {
            title: "climate",
            body: "notes",
            category: "inf",
            published: true,
            embedding: [sign * 3e38, sign * 3e38, sign * 3e38, sign * 3e38],
          },
          { id },
        );
      }
      const query = () =>
        store
          .query()
          .from("Article", "a")
          .whereNode("a", (a) =>
            a.embedding.similarTo(QUERY_VECTOR, 10, { metric: "l2" }),
          )
          .select((row) => ({ id: row.a.id }));
      const executed = await executedIds(query());
      expect(executed.toSorted()).toEqual([
        "i1",
        "i2",
        "r1",
        "r2",
        "r3",
        "r4",
        "r5",
      ]);
      expect({
        forward: await walk(store, query, "paginate", "forward", 1),
        backward: await walk(store, query, "page", "backward", 1),
        batched: await walk(store, query, "batchOnce", "forward", 2),
        stream: await walk(store, query, "stream", "forward", 1),
      }).toEqual({
        forward: executed,
        backward: executed,
        batched: executed,
        stream: executed,
      });
    });

    it("refuses a relevance key outside what its database can represent before it reaches the database", async (ctx) => {
      const store = context.getStore();
      const kinds = SEARCH_KINDS.filter((kind) =>
        capabilitiesOf(kind).every(
          (capability) =>
            store.backend.capabilities[capability]?.supported === true,
        ),
      );
      if (kinds.length === 0) ctx.skip();
      await seedRanked(store);
      for (const kind of kinds) {
        const query = () => orderedSearch(store, { kind }, "relevance");
        const first = await query().paginate({ first: 2 });
        const json = decodeCursorJson(requireCursor(first.nextCursor));
        const vals = json["vals"] as unknown[];
        const forge = (value: string) =>
          encodeCursorJson({ ...json, vals: [value, ...vals.slice(1)] });
        // A key is compared in the type its source computes: a double for a
        // rank or distance on every engine and for SQLite's fused score, a
        // NUMERIC for PostgreSQL's fused score.
        const keyIsNumeric =
          kind === "hybrid" && store.backend.dialect === "postgres";
        // Out of range for a NUMERIC (and so for a double): more integer or
        // fraction digits than it holds, and their negatives.
        const outsideEveryKey = [
          "1e200000",
          "-1e200000",
          "1e-20000",
          "-1e-20000",
        ];
        for (const forged of outsideEveryKey) {
          await expectSearchCursorRefusal(() =>
            query().paginate({ first: 2, after: forge(forged) }),
          );
          await expectSearchCursorRefusal(() =>
            query()
              .page({ last: 2, before: forge(forged) })
              .execute(),
          );
        }
        // Out of range for a double (and so for every narrower type):
        // overflow, underflow to zero, and their negatives. Refused where
        // the key is a double; where it is a NUMERIC, positions above every
        // fused score (the score sorts descending, so every row follows it)
        // and below every one.
        const outsideDouble = ["1e9999", "-1e9999", "1e-400", "-1e-400"];
        const executed = await executedIds(query());
        const outcomes = [];
        for (const forged of outsideDouble) {
          outcomes.push(
            await readOrRefusal(() =>
              query().paginate({ first: 2, after: forge(forged) }),
            ),
            await readOrRefusal(() =>
              query()
                .page({ last: 2, before: forge(forged) })
                .execute(),
            ),
          );
        }
        expect({ kind, outcomes }).toEqual({
          kind,
          outcomes:
            keyIsNumeric ?
              [
                executed.slice(0, 2),
                [],
                [],
                executed.slice(-2),
                [],
                executed.slice(-2),
                [],
                executed.slice(-2),
              ]
            : outsideDouble.flatMap(() => [
                SEARCH_CURSOR_MISMATCH,
                SEARCH_CURSOR_MISMATCH,
              ]),
        });
        // A double that a NUMERIC cannot hold as written: a NUMERIC keeps
        // every written fraction digit (less the exponent), trailing zeros
        // and a zero's included, and holds at most 16383 of them. Refused
        // where the key is a NUMERIC; a valid position (0 or 1) where it is
        // a PostgreSQL double. SQLite carries a key only as its exact binary
        // text, so it refuses every decimal text as text it never renders.
        const outsideNumericScale = [
          "0e-20000",
          `0.${"0".repeat(20_000)}`,
          `1.${"0".repeat(16_384)}`,
          `1.5${"0".repeat(16_383)}e-1`,
        ];
        const scaleOutcomes = [];
        for (const forged of outsideNumericScale) {
          scaleOutcomes.push(
            await readOrRefusal(() =>
              query().paginate({ first: 2, after: forge(forged) }),
            ).then((outcome) =>
              outcome === SEARCH_CURSOR_MISMATCH ? outcome : "page",
            ),
          );
        }
        expect({ kind, scaleOutcomes }).toEqual({
          kind,
          scaleOutcomes: outsideNumericScale.map(() =>
            keyIsNumeric || store.backend.dialect === "sqlite" ?
              SEARCH_CURSOR_MISMATCH
            : "page",
          ),
        });
        // Representable as a double but not as PostgreSQL's `real` (the type
        // `ts_rank_cd` returns): a valid position past every row, carried as
        // the dialect renders the key.
        const large = encodeCursorJson({
          ...json,
          vals: [await renderedRelevanceKey(store, 1e39), ...vals.slice(1)],
        });
        const page = await query().paginate({ first: 2, after: large });
        // Past every distance, so no vector row follows it; a rank or fused
        // score sorts descending, so every row follows it.
        expect({ kind, rows: kind === "vector" ? page.data : [] }).toEqual({
          kind,
          rows: [],
        });
      }
    });

    it("pages a valid cursor or refuses it with a ValidationError, never a database error, for arbitrary and mutated cursors", async (ctx) => {
      const store = context.getStore();
      const kinds = SEARCH_KINDS.filter((kind) =>
        capabilitiesOf(kind).every(
          (capability) =>
            store.backend.capabilities[capability]?.supported === true,
        ),
      );
      if (kinds.length === 0) ctx.skip();
      await seedRanked(store);
      const issued = new Map<SearchKind, Record<string, unknown>>();
      for (const kind of kinds) {
        const first = await orderedSearch(
          store,
          { kind },
          "category asc",
        ).paginate({ first: 2 });
        issued.set(kind, decodeCursorJson(requireCursor(first.nextCursor)));
      }
      // Control characters (NUL among them) and lone surrogates, which a
      // database's text may not hold or a driver re-encodes.
      const awkwardText = fc.string({
        unit: fc
          .oneof(
            fc.integer({ min: 0, max: 0x1f }),
            fc.integer({ min: 0xd8_00, max: 0xdf_ff }),
            fc.integer({ min: 0x20, max: 0x7e }),
          )
          .map((code) => String.fromCodePoint(code)),
        maxLength: 6,
      });
      const scalar = fc.oneof(
        fc.string(),
        awkwardText,
        fc.double(),
        fc.integer(),
        fc.boolean(),
        // eslint-disable-next-line unicorn/no-null -- a JSON null in the cursor
        fc.constant(null),
        fc.constantFrom(
          "1e9999",
          "-1e9999",
          "1e-400",
          "1e39",
          "NaN",
          "Infinity",
          "-Infinity",
          "0x10",
          " 0.5",
          "0.5 ",
          "",
          "-0",
          `0.${"3".repeat(2000)}`,
          "9".repeat(400),
          // Ids and other text a number parser or SQLite's literal reader
          // takes for a number or an infinity, for every text-typed
          // position (a hybrid node-id key, a text field key).
          "Inf",
          "-Inf",
          "9e999",
          "0",
          "1e3",
        ),
      );
      const value = fc.oneof(
        scalar,
        fc.array(scalar, { maxLength: 2 }),
        fc.dictionary(fc.string(), scalar, { maxKeys: 2 }),
      );
      const cursorArbitrary = fc.oneof(
        fc.string().map((text) => ({ kind: "text", cursor: text }) as const),
        fc
          .record({
            kind: fc.constantFrom(...kinds),
            index: fc.nat(),
            value,
            field: fc.constantFrom("vals", "cols", "s", "d", "v"),
          })
          .map(({ kind, index, value: replacement, field }) => {
            const json = issued.get(kind) ?? {};
            const original = json[field];
            const mutated =
              Array.isArray(original) ?
                original.map((entry: unknown, position) =>
                  position === index % original.length ? replacement : entry,
                )
              : replacement;
            return {
              kind: "mutated",
              search: kind,
              cursor: encodeCursorJson({ ...json, [field]: mutated }),
            } as const;
          }),
      );
      await fc.assert(
        fc.asyncProperty(
          cursorArbitrary,
          fc.constantFrom<"after" | "before">("after", "before"),
          async (forged, position) => {
            const kind = forged.kind === "text" ? kinds[0] : forged.search;
            const query = orderedSearch(
              store,
              { kind: kind ?? "fulltext" },
              "category asc",
            );
            const outcome = await query
              .paginate(
                position === "after" ?
                  { first: 2, after: forged.cursor }
                : { last: 2, before: forged.cursor },
              )
              .then(
                () => "page",
                (error: unknown) => error,
              );
            expect(
              outcome === "page" || outcome instanceof ValidationError ?
                "page or ValidationError"
              : outcome,
            ).toBe("page or ValidationError");
          },
        ),
        { numRuns: propertyRuns({ ci: 200, local: 150 }) },
      );
    });

    it("carries every finite double as a relevance key and as a batched numeric key back exactly", async () => {
      const { backend } = context.getStore();
      const dialect = getDialect(backend.dialect);
      const { value, select, bind, operand } = dialect.relevanceCursorKey;
      const source = "vector_distance" as const;
      async function readRow(
        fragment: ReturnType<typeof sql>,
      ): Promise<Record<string, unknown>> {
        const [row] = await backend.execute<Record<string, unknown>>(
          asCompiledRowsSql(fragment),
        );
        return row ?? {};
      }
      // A key is carried exactly when the cursor's comparison finds the
      // double the statement computed equal to the value the cursor binds,
      // and when a batch envelope's key reads back as that double.
      async function carried(double: number) {
        const key = value(sql`${double}`, source);
        const rendered = await readRow(
          sql`WITH r AS (SELECT ${dialect.batchExactNumber(key)} AS k, 1 AS o) SELECT ${select(key, source)} AS key_text, ${dialect.orderedRowsJsonArray("r", ["k"], "o")} AS batch`,
        );
        const text = rendered["key_text"];
        const bound = typeof text === "string" ? bind(text, source) : undefined;
        const comparison =
          bound === undefined ? undefined : (
            await readRow(
              sql`SELECT CASE WHEN ${value(sql`${double}`, source)} = ${operand(bound)} THEN 'equal' ELSE 'unequal' END AS outcome`,
            )
          );
        const compared = comparison?.["outcome"];
        const envelope = rendered["batch"];
        const [batchRow] = (
          typeof envelope === "string" ?
            JSON.parse(envelope)
          : envelope) as readonly Readonly<{ k: unknown }>[];
        const batched = batchRow?.k;
        const batchedDouble =
          typeof batched === "string" ? parseExactDoubleText(batched) : batched;
        return {
          compared,
          batched: batchedDouble === double ? "equal" : batched,
        };
      }
      const boundaries = [
        Number.MIN_VALUE,
        -Number.MIN_VALUE,
        3 * Number.MIN_VALUE,
        2 ** -1022 - Number.MIN_VALUE,
        2 ** -1022,
        2 ** -1024,
        2 ** -768,
        2 ** -256,
        1 - 2 ** -53,
        1,
        2 ** 32 - 2 ** -20,
        2 ** 32,
        2 ** 256,
        2 ** 768,
        Number.MAX_VALUE,
        -Number.MAX_VALUE,
        0.1,
        0.30000000000000004,
        2.1720897273118987e126 / 3,
        0,
      ];
      const expected = { compared: "equal", batched: "equal" };
      for (const double of boundaries)
        expect({ double, ...(await carried(double)) }).toEqual({
          double,
          ...expected,
        });
      await fc.assert(
        fc.asyncProperty(
          fc.double({ noNaN: true, noDefaultInfinity: true }),
          async (double) => {
            expect({ double, ...(await carried(double)) }).toEqual({
              double,
              ...expected,
            });
          },
        ),
        { numRuns: propertyRuns({ ci: 300, local: 200 }) },
      );
    });

    it("concatenated pages equal execute() for random corpora with duplicate scores", async (ctx) => {
      const store = context.getStore();
      const capabilities = store.backend.capabilities;
      const kinds = SEARCH_KINDS.filter((kind) =>
        capabilitiesOf(kind).every(
          (capability) => capabilities[capability]?.supported === true,
        ),
      );
      if (kinds.length === 0) ctx.skip();
      let run = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            // Few distinct texts and angles: scores repeat on every leg.
            articles: fc.array(
              fc.record({
                title: fc.constantFrom(
                  "climate",
                  "climate climate",
                  "climate report",
                  "solar climate notes",
                ),
                // "zero": a zero embedding, whose cosine distance is undefined.
                angle: fc.constantFrom<number | "zero">(
                  0,
                  0.2,
                  0.2,
                  0.5,
                  "zero",
                ),
                body: fc.constantFrom("alpha", "beta"),
              }),
              { minLength: 1, maxLength: 9 },
            ),
            kind: fc.constantFrom(...kinds),
            k: fc.integer({ min: 1, max: 10 }),
            ordering: fc.constantFrom<"relevance" | "body asc" | "body desc">(
              "relevance",
              "body asc",
              "body desc",
            ),
            terminal: fc.constantFrom<Terminal>(
              "paginate",
              "page",
              "batchOnce",
              "stream",
            ),
            direction: fc.constantFrom<"forward" | "backward">(
              "forward",
              "backward",
            ),
            pageSize: fc.integer({ min: 1, max: 4 }),
          }),
          async (plan) => {
            run += 1;
            // Each run's rows carry their own category, which the query
            // filters on, so runs never see each other's rows.
            const category = `run${run}`;
            for (const article of plan.articles) {
              await store.nodes.Article.create({
                title: article.title,
                body: article.body,
                category,
                published: true,
                embedding:
                  article.angle === "zero" ?
                    [0, 0, 0, 0]
                  : embeddingAt(article.angle),
              });
            }
            const query = () => {
              const search = searchArticles(store, {
                kind: plan.kind,
                k: plan.k,
                category,
              });
              const ordered =
                plan.ordering === "relevance" ? search
                : plan.ordering === "body asc" ?
                  search.orderBy("a", "body", "asc")
                : search.orderBy("a", "body", "desc");
              return ordered.select((row) => ({ id: row.a.id }));
            };
            const executed = await executedIds(query());
            const direction =
              plan.terminal === "stream" ? "forward" : plan.direction;
            expect(
              await walk(store, query, plan.terminal, direction, plan.pageSize),
            ).toEqual(executed);
          },
        ),
        { numRuns: propertyRuns({ ci: 25, local: 15 }) },
      );
    });
  });
}

function requireCursor(cursor: string | undefined): string {
  if (cursor === undefined) throw new Error("expected a cursor");
  return cursor;
}
