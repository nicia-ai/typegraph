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

import type { IntegrationStore } from "./fixtures";
import { PLAIN_CURSOR_FIXTURES } from "./plain-cursor-fixtures";
import {
  PLAIN_CURSOR_SEED,
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
      // A boolean key as 0/1 and as true/false, a date with an offset: the
      // forms the fixtures exist to carry.
      expect(fixtures.length).toBeGreaterThan(100);
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
