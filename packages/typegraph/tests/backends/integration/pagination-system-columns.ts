import { beforeEach, describe, expect, it } from "vitest";

import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationStore } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

const ROW_COUNT = 25;
const PAGE_SIZE = 10;
/** More pages than any correct walk needs, so a cursor that never advances fails instead of looping. */
const MAX_PAGES = Math.ceil(ROW_COUNT / PAGE_SIZE) + 2;

const NODE_SYSTEM_COLUMNS = [
  "id",
  "kind",
  "valid_from",
  "valid_to",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;
const EDGE_SYSTEM_COLUMNS = [
  ...NODE_SYSTEM_COLUMNS,
  "from_id",
  "to_id",
] as const;
const DIRECTIONS = ["asc", "desc"] as const;
const SELECTIONS = ["full", "projection"] as const;

type Direction = (typeof DIRECTIONS)[number];
type Selection = (typeof SELECTIONS)[number];

type PageableQuery = Readonly<{
  execute: () => Promise<readonly unknown[]>;
  paginate: (
    options: Readonly<{
      first?: number;
      after?: string;
      last?: number;
      before?: string;
    }>,
  ) => Promise<
    Readonly<{
      data: readonly unknown[];
      nextCursor: string | undefined;
      prevCursor: string | undefined;
      hasNextPage: boolean;
      hasPrevPage: boolean;
    }>
  >;
  stream: (options: Readonly<{ batchSize: number }>) => AsyncIterable<unknown>;
}>;

function rowId(row: unknown): string {
  return (row as Readonly<{ id: string }>).id;
}

/** Instants one minute apart, all in the past, in creation order. */
function pastInstant(index: number): string {
  return new Date(Date.UTC(2020, 0, 1, 0, index)).toISOString();
}

/** Instants one minute apart, all in the future, in reverse creation order. */
function futureInstant(index: number): string {
  return new Date(Date.UTC(2099, 0, 1, 0, ROW_COUNT - index)).toISOString();
}

/** Every fifth row is left open-ended, so `valid_to` has a NULL partition. */
function validTo(index: number): string | undefined {
  return index % 5 === 0 ? undefined : futureInstant(index);
}

/**
 * Twenty-five people and one `knows` edge to each from a hub. Every system
 * column differs across rows where the store lets it: `valid_from` rises with
 * creation order and `valid_to` falls (with a NULL partition), updates land in
 * a different order from creates, and every third row is soft-deleted so
 * `deleted_at` has values and NULLs.
 */
async function seedSystemColumnRows(store: IntegrationStore) {
  const hub = await store.nodes.Person.create(
    { name: "hub" },
    { validFrom: pastInstant(0) },
  );
  const people = [];
  const edges = [];
  for (let index = 0; index < ROW_COUNT; index++) {
    const end = validTo(index);
    const window = {
      validFrom: pastInstant(index + 1),
      ...(end === undefined ? {} : { validTo: end }),
    };
    const person = await store.nodes.Person.create(
      { name: `p${String(index).padStart(2, "0")}` },
      window,
    );
    people.push(person);
    edges.push(await store.edges.knows.create(hub, person, {}, window));
  }
  for (const index of [7, 3, 19, 0, 24, 11, 15]) {
    await store.nodes.Person.update(requireDefined(people[index]).id, {
      age: index,
    });
    await store.edges.knows.update(requireDefined(edges[index]).id, {
      since: String(index),
    });
  }
  for (let index = 0; index < ROW_COUNT; index += 3) {
    await store.edges.knows.delete(requireDefined(edges[index]).id);
    await store.nodes.Person.delete(requireDefined(people[index]).id);
  }
  return { hub };
}

async function forwardPages(query: PageableQuery): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const page = await query.paginate({
      first: PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    ids.push(...page.data.map((row) => rowId(row)));
    if (!page.hasNextPage) return ids;
    after = page.nextCursor;
  }
  throw new Error(`forward paging did not finish in ${MAX_PAGES} pages`);
}

async function backwardPages(query: PageableQuery): Promise<string[]> {
  const pages: string[][] = [];
  let before: string | undefined;
  for (let count = 0; count < MAX_PAGES; count++) {
    const page = await query.paginate({
      last: PAGE_SIZE,
      ...(before === undefined ? {} : { before }),
    });
    pages.unshift(page.data.map((row) => rowId(row)));
    if (!page.hasPrevPage) return pages.flat();
    before = page.prevCursor;
  }
  throw new Error(`backward paging did not finish in ${MAX_PAGES} pages`);
}

async function streamed(query: PageableQuery): Promise<string[]> {
  const ids: string[] = [];
  for await (const row of query.stream({ batchSize: PAGE_SIZE })) {
    ids.push(rowId(row));
    if (ids.length > ROW_COUNT) break;
  }
  return ids;
}

/**
 * Pages `query` forward, backward and as a stream of three batches, and
 * asserts each walk returns exactly the rows `execute()` returns, in its order.
 */
async function expectEveryWalkMatchesExecute(
  query: PageableQuery,
): Promise<void> {
  const rows = await query.execute();
  const expected = rows.map((row) => rowId(row));
  expect(expected).toHaveLength(ROW_COUNT);
  expect({
    forward: await forwardPages(query),
    backward: await backwardPages(query),
    stream: await streamed(query),
  }).toEqual({ forward: expected, backward: expected, stream: expected });
}

export function registerPaginationSystemColumnIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Cursor pagination ordered by a system column", () => {
    let hubId: string;

    beforeEach(async () => {
      const { hub } = await seedSystemColumnRows(context.getStore());
      hubId = hub.id;
    });

    describe.each(SELECTIONS)("%s select", (selection: Selection) => {
      describe.each(DIRECTIONS)("%s", (direction: Direction) => {
        it.each(NODE_SYSTEM_COLUMNS)(
          "pages a node alias ordered by %s",
          async (column) => {
            const ordered = context
              .getStore()
              .query()
              .from("Person", "person")
              .temporal("includeTombstones")
              .whereNode("person", (person) => person.name.neq("hub"))
              .orderBy("person", column, direction)
              // Rows written in one millisecond tie on a timestamp column; a
              // stated tiebreak makes `execute()` order the oracle.
              .orderBy("person", "id", "asc");
            await expectEveryWalkMatchesExecute(
              selection === "full" ?
                ordered.select((fields) => fields.person)
              : ordered.select((fields) => ({ id: fields.person.id })),
            );
          },
        );

        it.each(EDGE_SYSTEM_COLUMNS)(
          "pages an edge alias ordered by %s",
          async (column) => {
            const ordered = context
              .getStore()
              .query()
              .from("Person", "hub")
              .temporal("includeTombstones")
              .whereNode("hub", (hub) => hub.id.eq(hubId))
              .traverse("knows", "knows")
              .to("Person", "friend")
              .orderBy("knows", column, direction)
              .orderBy("knows", "id", "asc");
            await expectEveryWalkMatchesExecute(
              selection === "full" ?
                ordered.select((fields) => fields.knows)
              : ordered.select((fields) => ({ id: fields.knows.id })),
            );
          },
        );
      });
    });
  });
}
