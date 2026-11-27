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
import type { IntegrationStore } from "./fixtures";
import { PLAIN_CURSOR_FIXTURES } from "./plain-cursor-fixtures";
import {
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
  });
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
        ["meta.createdAt", "2024-01-02T03:04:05Z"],
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
}
