/**
 * A cursor a query without a search was issued before relevance-ordered
 * cursors keeps resuming: every cursor in `plain-cursor-fixtures.ts` was
 * issued by the release before them (`scripts/capture-plain-cursor-fixtures.ts`)
 * through `paginate()`, `page()` and `store.batchOnce()` on each local lane,
 * for every sortable value type, and must resume at the row it resumed at
 * then, through every terminal that accepts a cursor.
 *
 * The value forms differ by terminal and dialect — SQLite's `batchOnce()`
 * carried a boolean as `0`/`1`, PostgreSQL's carried a date with the session's
 * offset — so each lane resumes every fixture its dialect issued.
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "../../../src";
import { expectObservation } from "../../helpers/known-defect";
import type { IntegrationStore } from "./fixtures";
import { PLAIN_CURSOR_FIXTURES } from "./plain-cursor-fixtures";
import {
  PLAIN_CURSOR_PGLITE_TIME_ZONE,
  PLAIN_CURSOR_SEED,
  PLAIN_CURSOR_SORTS,
  type PlainCursorFixture,
  type PlainCursorSort,
} from "./plain-cursor-seed";
import type { IntegrationTestContext } from "./test-context";

async function seed(store: IntegrationStore): Promise<void> {
  for (const { kind, id, props } of PLAIN_CURSOR_SEED) {
    if (kind === "Product") {
      await store.nodes.Product.create(
        props as Parameters<typeof store.nodes.Product.create>[0],
        { id },
      );
      continue;
    }
    const publishedAt = props["publishedAt"];
    await store.nodes.Document.create(
      {
        title: String(props["title"]),
        ...(typeof publishedAt === "string" ?
          { publishedAt: new Date(publishedAt) }
        : {}),
      },
      { id },
    );
  }
}

function sortedQuery(
  store: IntegrationStore,
  sort: PlainCursorSort,
  selection: "node" | "fields",
) {
  const query = store
    .query()
    .from(sort.kind, "n")
    .orderBy("n", sort.field as never, sort.direction);
  return selection === "node" ?
      query.select((ctx) => ({ id: ctx.n.id, node: ctx.n }))
    : query.select((ctx) => ({ id: ctx.n.id }));
}

type Resumed = Readonly<{
  after: readonly string[];
  before: readonly string[];
}>;

function ids(
  page: Readonly<{ data: readonly Readonly<{ id: string }>[] }>,
): readonly string[] {
  return page.data.map((row) => row.id);
}

async function resume(
  store: IntegrationStore,
  fixture: PlainCursorFixture,
  terminal: "paginate" | "page" | "batchOnce",
  selection: "node" | "fields",
): Promise<Resumed> {
  const query = () => sortedQuery(store, fixture.sort, selection);
  const after = { first: 100, after: fixture.cursor };
  const before = { last: 100, before: fixture.cursor };
  switch (terminal) {
    case "paginate": {
      return {
        after: ids(await query().paginate(after)),
        before: ids(await query().paginate(before)),
      };
    }
    case "page": {
      return {
        after: ids(await query().page(after).execute()),
        before: ids(await query().page(before).execute()),
      };
    }
    case "batchOnce": {
      const [afterPage, beforePage] = await store.batchOnce(
        () => [query().page(after), query().page(before)] as const,
      );
      return { after: ids(afterPage), before: ids(beforePage) };
    }
  }
}

/** The fixture lane a shared-suite lane captured on, if it is one. */
function fixtureLaneOf(
  driver: IntegrationTestContext["driver"],
): PlainCursorFixture["lane"] | undefined {
  switch (driver) {
    case "better-sqlite3": {
      return "sqlite";
    }
    case "libsql": {
      return "libsql";
    }
    case "pglite": {
      return "pglite";
    }
    case "node-postgres":
    case "postgres-js": {
      return undefined;
    }
  }
}

/**
 * The query the capture pages for `sort`, selecting as it does: the whole
 * node, or the id and the sorted field.
 */
function capturedQuery(
  store: IntegrationStore,
  sort: PlainCursorSort,
  selection: "node" | "fields",
) {
  const query = store
    .query()
    .from(sort.kind, "n")
    .orderBy("n", sort.field as never, sort.direction);
  return selection === "node" ?
      query.select((ctx) => ({ node: ctx.n }))
    : query.select((ctx) => ({
        id: ctx.n.id,
        value: (ctx.n as unknown as Record<string, unknown>)[sort.field],
      }));
}

type IssuedPage = Readonly<{
  hasNextPage: boolean;
  hasPrevPage: boolean;
  nextCursor?: string | undefined;
  prevCursor?: string | undefined;
}>;

async function readCapturedPage(
  store: IntegrationStore,
  sort: PlainCursorSort,
  selection: "node" | "fields",
  terminal: "paginate" | "page" | "batchOnce",
  options: Readonly<{
    first?: number;
    last?: number;
    after?: string;
    before?: string;
  }>,
): Promise<IssuedPage> {
  const query = () => capturedQuery(store, sort, selection);
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

/**
 * Every cursor the terminals issue over the seed, walked as the capture walks
 * it (one row a page, forward and backward, through every terminal and
 * selection), as `sort:cursor` keys with their sorted issuers.
 */
async function issuedCursors(
  store: IntegrationStore,
): Promise<Readonly<Record<string, readonly string[]>>> {
  const issued = new Map<string, Set<string>>();
  for (const sort of PLAIN_CURSOR_SORTS) {
    for (const selection of ["node", "fields"] as const) {
      for (const terminal of ["paginate", "page", "batchOnce"] as const) {
        for (const direction of ["forward", "backward"] as const) {
          let cursor: string | undefined;
          for (let guard = 0; guard < 20; guard += 1) {
            const options =
              direction === "forward" ?
                { first: 1, ...(cursor === undefined ? {} : { after: cursor }) }
              : {
                  last: 1,
                  ...(cursor === undefined ? {} : { before: cursor }),
                };
            const page = await readCapturedPage(
              store,
              sort,
              selection,
              terminal,
              options,
            );
            for (const cursorIssued of [page.nextCursor, page.prevCursor]) {
              if (cursorIssued === undefined) continue;
              const key = `${JSON.stringify(sort)}:${cursorIssued}`;
              const issuers = issued.get(key) ?? new Set<string>();
              issuers.add(`${terminal}/${selection}`);
              issued.set(key, issuers);
            }
            const more =
              direction === "forward" ? page.hasNextPage : page.hasPrevPage;
            cursor =
              direction === "forward" ? page.nextCursor : page.prevCursor;
            if (!more || cursor === undefined) break;
          }
        }
      }
    }
  }
  return Object.fromEntries(
    [...issued.entries()].map(([key, issuers]) => [
      key,
      [...issuers].toSorted(),
    ]),
  );
}

export function registerPlainCursorCompatibilityIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Cursors issued for a query without a search before relevance-ordered cursors", () => {
    it("every cursor any terminal issued resumes at the same row through every terminal", async () => {
      const store = context.getStore();
      await seed(store);
      const lanes: readonly PlainCursorFixture["lane"][] =
        store.backend.dialect === "postgres" ?
          ["pglite"]
        : ["sqlite", "libsql"];
      const fixtures = PLAIN_CURSOR_FIXTURES.filter((fixture) =>
        lanes.includes(fixture.lane),
      );
      // Every sort, on each lane of this dialect, has its fixtures.
      const covered = (lane: PlainCursorFixture["lane"]) =>
        new Set(
          fixtures
            .filter((fixture) => fixture.lane === lane)
            .map((fixture) => JSON.stringify(fixture.sort)),
        );
      expect(lanes.map((lane) => covered(lane))).toEqual(
        lanes.map(
          () => new Set(PLAIN_CURSOR_SORTS.map((sort) => JSON.stringify(sort))),
        ),
      );
      for (const fixture of fixtures) {
        for (const terminal of ["paginate", "page", "batchOnce"] as const) {
          for (const selection of ["node", "fields"] as const) {
            const resumed = await resume(store, fixture, terminal, selection);
            expect({
              fixture: fixture.cursor,
              sort: fixture.sort,
              terminal,
              selection,
              ...resumed,
            }).toEqual({
              fixture: fixture.cursor,
              sort: fixture.sort,
              terminal,
              selection,
              after: fixture.after,
              before: fixture.before,
            });
          }
        }
      }
    });

    it("issues every recorded cursor byte for byte, through exactly the terminals and selections that recorded it", async (ctx) => {
      const lane = fixtureLaneOf(context.driver);
      // The server PostgreSQL lanes resume the PGlite fixtures but issue
      // through a pool whose sessions' zone this case cannot hold fixed.
      if (lane === undefined) ctx.skip();
      const store = context.getStore();
      await seed(store);
      const executeRaw = store.backend.executeRaw;
      if (lane === "pglite") {
        if (executeRaw === undefined)
          throw new Error("The PGlite lane must expose raw SQL.");
        await executeRaw(
          `SET TIME ZONE '${PLAIN_CURSOR_PGLITE_TIME_ZONE}'`,
          [],
        );
      }
      try {
        const recorded = Object.fromEntries(
          PLAIN_CURSOR_FIXTURES.filter((fixture) => fixture.lane === lane).map(
            (fixture) => [
              `${JSON.stringify(fixture.sort)}:${fixture.cursor}`,
              fixture.issuedBy.toSorted(),
            ],
          ),
        );
        expect(await issuedCursors(store)).toEqual(recorded);
      } finally {
        if (lane === "pglite") await executeRaw?.("RESET TIME ZONE", []);
      }
    });

    it("resumes a batched timestamp cursor whose offset has seconds (a zone's local mean time) on every PostgreSQL lane", async (ctx) => {
      const store = context.getStore();
      // PostgreSQL issued these cursors; SQLite never renders an offset.
      if (store.backend.dialect !== "postgres") ctx.skip();
      await seedLocalMeanTime(store);
      const query = () => localMeanTimeQuery(store);
      const outcomes = [];
      for (const fixture of LOCAL_MEAN_TIME_FIXTURES) {
        const options =
          fixture.position === "after" ?
            { first: 10, after: fixture.cursor }
          : { last: 10, before: fixture.cursor };
        const [batched] = await store.batchOnce(
          () => [query().page(options)] as const,
        );
        outcomes.push({
          position: fixture.position,
          paginate: ids(await query().paginate(options)),
          page: ids(await query().page(options).execute()),
          batchOnce: ids(batched),
        });
      }
      expect(outcomes).toEqual(
        LOCAL_MEAN_TIME_FIXTURES.map((fixture) => ({
          position: fixture.position,
          paginate: fixture.resumes,
          page: fixture.resumes,
          batchOnce: fixture.resumes,
        })),
      );
    });

    it("walks a timestamp key once through batched pages in a session zone whose offset has seconds", async (ctx) => {
      // One connection whose session zone the case can hold: PGlite's.
      if (context.driver !== "pglite") ctx.skip();
      const store = context.getStore();
      const executeRaw = store.backend.executeRaw;
      if (executeRaw === undefined)
        throw new Error("The PGlite lane must expose raw SQL.");
      await seedLocalMeanTime(store);
      const query = () => localMeanTimeQuery(store);
      await executeRaw("SET TIME ZONE 'Europe/Paris'", []);
      try {
        const executed = ids({ data: await query().execute() });
        const walked = [];
        for (const terminal of ["batchOnce", "paginate"] as const) {
          for (const direction of ["forward", "backward"] as const) {
            walked.push({
              terminal,
              direction,
              ids: await walkLocalMeanTime(store, terminal, direction).then(
                (read) => read,
                (error: unknown) =>
                  error instanceof RangeError ? "RangeError" : error,
              ),
            });
          }
        }
        expectObservation({
          lane: { driver: context.driver },
          observed: { executed, walked },
          correct: {
            executed: ["t1", "t2", "t3"],
            walked: walked.map(({ terminal, direction }) => ({
              terminal,
              direction,
              ids: ["t1", "t2", "t3"],
            })),
          },
          defects: [
            {
              label:
                "known defect fix4-lmt-date (PGlite reads a local-mean-time timestamp as an invalid Date)",
              on: { driver: ["pglite"] },
              today: {
                executed: ["t1", "t2", "t3"],
                walked: walked.map(({ terminal, direction }) => ({
                  terminal,
                  direction,
                  ids:
                    terminal === "paginate" ? "RangeError" : ["t1", "t2", "t3"],
                })),
              },
            },
          ],
        });
      } finally {
        await executeRaw("RESET TIME ZONE", []);
      }
    });
  });
}

/**
 * Cursors the release before relevance-ordered cursors issued through
 * `store.batchOnce()` on PGlite in the session zone `Europe/Paris`, over
 * {@link seedLocalMeanTime} sorted by `publishedAt` ascending, two rows a
 * page: forward (`first: 2`) and backward (`last: 2`). The boundary row is
 * dated 1900-01-01T00:00:00.000Z, before Paris kept standard time, so the
 * session renders it with the zone's local mean time offset, which has
 * seconds: `1900-01-01T00:09:21+00:09:21`.
 */
const LOCAL_MEAN_TIME_FIXTURES = [
  {
    position: "after",
    cursor:
      "eyJ2IjoxLCJkIjoiZiIsInZhbHMiOlsiMTkwMC0wMS0wMVQwMDowOToyMSswMDowOToyMSIsInQyIl0sImNvbHMiOlsibi5wdWJsaXNoZWRBdCIsIm4uaWQiXX0",
    resumes: ["t3"],
  },
  {
    position: "before",
    cursor:
      "eyJ2IjoxLCJkIjoiYiIsInZhbHMiOlsiMTkwMC0wMS0wMVQwMDowOToyMSswMDowOToyMSIsInQyIl0sImNvbHMiOlsibi5wdWJsaXNoZWRBdCIsIm4uaWQiXX0",
    resumes: ["t1"],
  },
] as const;

async function seedLocalMeanTime(store: IntegrationStore): Promise<void> {
  for (const [id, publishedAt] of [
    ["t1", "1899-06-01T00:00:00.000Z"],
    ["t2", "1900-01-01T00:00:00.000Z"],
    ["t3", "1900-06-01T12:00:00.000Z"],
  ] as const) {
    await store.nodes.Document.create(
      { title: id, publishedAt: new Date(publishedAt) },
      { id },
    );
  }
}

function localMeanTimeQuery(store: IntegrationStore) {
  return store
    .query()
    .from("Document", "n")
    .orderBy("n", "publishedAt", "asc")
    .select((ctx) => ({ id: ctx.n.id }));
}

/** Walks {@link localMeanTimeQuery} one row a page, in reading order. */
async function walkLocalMeanTime(
  store: IntegrationStore,
  terminal: "batchOnce" | "paginate",
  direction: "forward" | "backward",
): Promise<readonly string[]> {
  const pages: (readonly string[])[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10; guard += 1) {
    const options =
      direction === "forward" ?
        { first: 1, ...(cursor === undefined ? {} : { after: cursor }) }
      : { last: 1, ...(cursor === undefined ? {} : { before: cursor }) };
    const [page] =
      terminal === "paginate" ?
        [await localMeanTimeQuery(store).paginate(options)]
      : await store.batchOnce(
          () => [localMeanTimeQuery(store).page(options)] as const,
        );
    pages.push(ids(page));
    cursor = direction === "forward" ? page.nextCursor : page.prevCursor;
    const more = direction === "forward" ? page.hasNextPage : page.hasPrevPage;
    if (!more || cursor === undefined) break;
  }
  return direction === "forward" ? pages.flat() : pages.toReversed().flat();
}

/** The JSON a cursor encodes. */
function decodeCursorJson(cursor: string): Record<string, unknown> {
  const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(
    atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
  ) as Record<string, unknown>;
}

function encodeCursorJson(json: unknown): string {
  return btoa(JSON.stringify(json))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

type MetadataSort = "meta.version" | "meta.createdAt" | "publishedAt";

function metadataSortedQuery(store: IntegrationStore, field: MetadataSort) {
  return store
    .query()
    .from("Document", "n")
    .orderBy("n", field as never, "asc")
    .select((ctx) => ({ id: ctx.n.id }));
}

async function readMetadataPage(
  store: IntegrationStore,
  field: MetadataSort,
  terminal: "paginate" | "page" | "batchOnce",
  options: Readonly<{ first: number; after?: string }>,
) {
  const query = () => metadataSortedQuery(store, field);
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

async function walkIds(
  store: IntegrationStore,
  field: MetadataSort,
  terminal: "paginate" | "page" | "batchOnce",
): Promise<readonly string[]> {
  const read: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const options = {
      first: 1,
      ...(cursor === undefined ? {} : { after: cursor }),
    };
    const page = await readMetadataPage(store, field, terminal, options);
    read.push(...page.data.map((row) => row.id));
    cursor = page.nextCursor;
    if (!page.hasNextPage || cursor === undefined) break;
  }
  return read;
}

export function registerCursorFieldContractIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("A cursor's field values are held to the field's operand contract", () => {
    it("refuses a value no terminal issues for a metadata or date key, and resumes every form one does", async () => {
      const store = context.getStore();
      for (const [id, publishedAt] of [
        ["m1", "2024-01-02T03:04:05.678Z"],
        ["m2", "2024-01-02T03:04:05.000Z"],
        ["m3", "1999-12-31T23:59:59.999Z"],
      ] as const) {
        await store.nodes.Document.create(
          { title: id, publishedAt: new Date(publishedAt) },
          { id },
        );
      }
      const fields: readonly MetadataSort[] = [
        "meta.version",
        "meta.createdAt",
        "publishedAt",
      ];
      // Every terminal walks every row once, resuming the value form it
      // issued itself (PostgreSQL's batchOnce() renders a timestamp with the
      // session's offset).
      for (const field of fields) {
        const rows = await metadataSortedQuery(store, field).execute();
        const executed = rows.map((row) => row.id);
        for (const terminal of ["paginate", "page", "batchOnce"] as const) {
          expect({
            field,
            terminal,
            ids: await walkIds(store, field, terminal),
          }).toEqual({ field, terminal, ids: executed });
        }
      }
      // A value of the field's JSON type that breaks its operand contract.
      const forged: readonly (readonly [MetadataSort, unknown])[] = [
        ["meta.version", 1.5],
        ["meta.version", 2 ** 31],
        ["meta.createdAt", "not a timestamp"],
        ["meta.createdAt", "2024-01-02"],
        ["meta.createdAt", "2024-01-02T03:04Z"],
        ["publishedAt", "not a date"],
        ["publishedAt", "2024-13-02T03:04:05.678Z"],
        ["publishedAt", "2024-01-02T03:04:05.678912+00:00"],
      ];
      const outcomes = [];
      for (const [field, value] of forged) {
        const issued = await metadataSortedQuery(store, field).paginate({
          first: 1,
        });
        const json = decodeCursorJson(issued.nextCursor ?? "");
        const vals = json["vals"] as unknown[];
        const cursor = encodeCursorJson({
          ...json,
          vals: [value, ...vals.slice(1)],
        });
        const outcome = await metadataSortedQuery(store, field)
          .paginate({ first: 1, after: cursor })
          .then(
            () => "page",
            (error: unknown) =>
              error instanceof ValidationError ? "ValidationError" : error,
          );
        outcomes.push({ field, value, outcome });
      }
      expect(outcomes).toEqual(
        forged.map(([field, value]) => ({
          field,
          value,
          outcome: "ValidationError",
        })),
      );
    });
  });

  describe("A batched page of a query without a search", () => {
    // A numeric orderBy() key reaches a batched page's cursor through the
    // batch's JSON envelope. The SQLite libSQL ships (3.45.1) renders
    // a REAL there with 15 significant digits, so keys that differ past them
    // share one cursor value and the next page skips the rows between.
    it("carries a numeric orderBy() key exactly, so rows whose keys differ in the last bits are each read once", async () => {
      const store = context.getStore();
      const prices = [0.29999999999999993, 0.3, 0.30000000000000004];
      for (const [index, price] of prices.entries()) {
        await store.nodes.Product.create(
          { name: `n${index}`, price, category: "batched" },
          { id: `b${index}` },
        );
      }
      const query = () =>
        store
          .query()
          .from("Product", "p")
          .whereNode("p", (p) => p.category.eq("batched"))
          .orderBy("p", "price", "desc")
          .select((ctx) => ({ id: ctx.p.id }));
      const rows = await query().execute();
      const executed: readonly string[] = rows.map((row) => String(row.id));
      const read: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 6; guard += 1) {
        const options = {
          first: 1,
          ...(cursor === undefined ? {} : { after: cursor }),
        };
        const [page] = await store.batchOnce(
          () => [query().page(options)] as const,
        );
        read.push(...page.data.map((row) => String(row.id)));
        cursor = page.nextCursor;
        if (!page.hasNextPage || cursor === undefined) break;
      }
      expectObservation({
        lane: { driver: context.driver },
        observed: { executed, read },
        correct: { executed: ["b2", "b1", "b0"], read: ["b2", "b1", "b0"] },
        defects: [
          {
            label: "known defect D17 (batched plain-page numeric key)",
            on: { driver: ["libsql"] },
            today: { executed: ["b2", "b1", "b0"], read: ["b2", "b0"] },
          },
        ],
      });
    });
  });
}
