/**
 * Every date a terminal hands a caller is the same value on every backend,
 * whatever the PostgreSQL session `TimeZone` is.
 *
 * PostgreSQL renders a `timestamptz` placed inside JSON — a collected element
 * or record field, a column of a `batchOnce()` payload — in the session time
 * zone (`2024-12-31T16:00:00-08:00`), text the strict stored-date leaf leaves
 * undecoded. The compiler emits such dates as canonical UTC text through
 * `DialectAdapter.jsonDateText` instead, so the bytes match SQLite's and decode
 * to the same `Date`.
 *
 * The session zone exists only on PostgreSQL: these cases fail without that
 * member on the PostgreSQL-dialect lanes, and on the SQLite lanes they pin
 * that the same terminals return the same values.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  expr,
  field,
  type GraphDef,
  max,
  min,
  searchable,
} from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import { expectObservation } from "../../helpers/known-defect";
import { type IntegrationTestContext } from "./test-context";

/** A zone with a non-whole-hour offset and no daylight-saving rule. */
const SESSION_ZONE = "Asia/Kathmandu";

/**
 * A zone whose offset before it adopted standard time (1891) is local mean
 * time, to the second: PostgreSQL renders `1880-06-01T00:00:00.001Z` in it as
 * `1880-06-01 00:09:21.001+00:09:21`.
 */
const MEAN_TIME_ZONE = "Europe/Paris";
const MEAN_TIME_INSTANT = new Date("1880-06-01T00:00:00.001Z");
const MEAN_TIME_LATER = new Date("1880-06-02T00:00:00.000Z");

const EARLY = new Date("2024-06-15T12:34:56.789Z");
const LATE = new Date("2025-01-01T00:00:00.000Z");
const STATED = new Date("2026-03-04T05:06:07.089Z");
const LINKED = new Date("2024-02-29T23:59:59.999Z");

const ZonedDocument = defineNode("ZonedDoc", {
  schema: z.object({
    title: searchable({ language: "english" }),
    at: z.date().optional(),
  }),
});

const zonedLink = defineEdge("zonedLink", {
  schema: z.object({ at: z.date() }),
});

const graph = defineGraph({
  id: "date_session_zone",
  nodes: { ZonedDoc: { type: ZonedDocument } },
  edges: {
    zonedLink: { type: zonedLink, from: [ZonedDocument], to: [ZonedDocument] },
  },
});

/**
 * A store over one connection whose PostgreSQL session runs in
 * {@link SESSION_ZONE}. SQLite has no session time zone, so there the lane's
 * own store serves.
 */
async function zonedStore<G extends GraphDef>(
  context: IntegrationTestContext,
  zonedGraph: G,
  sessionZone: string = SESSION_ZONE,
) {
  if (context.getBackend().dialect !== "postgres") {
    return {
      store: await context.createStore(zonedGraph),
      close: () => Promise.resolve(),
    };
  }
  const handle = await context.createSerializedBackend();
  const executeRaw = requireDefined(handle.backend.executeRaw);
  await executeRaw(`SET TIME ZONE '${sessionZone}'`, []);
  const [zone] = await executeRaw<{ TimeZone: string }>("SHOW TimeZone", []);
  expect(zone?.TimeZone).toBe(sessionZone);
  const [store] = await createAdapterStoreWithSchema(
    zonedGraph,
    handle.backend,
  );
  return {
    store,
    close: async () => {
      // One in-process PGlite engine backs every connection of its lane.
      await executeRaw("RESET TIME ZONE", []);
      await handle.close();
    },
  };
}

export function registerDateSessionZoneIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("dates under a non-UTC PostgreSQL session time zone", () => {
    it("every collect, projection, aggregate, group key, prepared, batch, subgraph and search terminal returns the same Date", async () => {
      const { store, close } = await zonedStore(context, graph);
      try {
        const early = await store.nodes.ZonedDoc.create({
          title: "early zoned",
          at: EARLY,
        });
        const late = await store.nodes.ZonedDoc.create({
          title: "late zoned",
          at: LATE,
        });
        await store.nodes.ZonedDoc.create({ title: "undated zoned" });
        await store.edges.zonedLink.create(early, late, { at: LINKED });

        const documents = () => store.query().from("ZonedDoc", "d");
        const collected = documents()
          .aggregate((fields) => ({
            dates: expr.collect(fields.d.at, {
              orderBy: [{ expression: fields.d.title }],
            }),
            latestFirst: expr.collect(fields.d.at, {
              orderBy: [
                {
                  expression: fields.d.at,
                  direction: "desc",
                  nulls: "last",
                },
              ],
            }),
            records: expr.collect(
              {
                at: fields.d.at,
                stated: expr.literal(STATED),
                title: fields.d.title,
              },
              { orderBy: [{ expression: fields.d.title }] },
            ),
          }))
          .asRelation();
        const extremes = documents()
          .aggregate((fields) => ({
            earliest: expr.min(fields.d.at),
            latest: expr.max(fields.d.at),
          }))
          .asRelation();
        const projected = documents()
          .whereNode("d", (d) => d.title.eq("early zoned"))
          .project((ctx) => ({
            at: ctx.d.at,
            stated: expr.literal(STATED),
            latest: ctx.$scalar((subquery) =>
              subquery
                .from("ZonedDoc", "x")
                .aggregate((fields) => ({ value: expr.max(fields.x.at) })),
            ),
          }));
        const selected = documents()
          .whereNode("d", (d) => d.title.eq("early zoned"))
          .select((ctx) => ({ at: ctx.d.at }));
        const traversed = documents()
          .traverse("zonedLink", "e")
          .to("ZonedDoc", "t")
          .select((ctx) => ({ edge: ctx.e.at, target: ctx.t.at }));

        const COLLECTED = [
          {
            dates: [EARLY, LATE, undefined],
            latestFirst: [LATE, EARLY, undefined],
            records: [
              { at: EARLY, stated: STATED, title: "early zoned" },
              { at: LATE, stated: STATED, title: "late zoned" },
              { at: undefined, stated: STATED, title: "undated zoned" },
            ],
          },
        ];
        const EXTREMES = [{ earliest: EARLY, latest: LATE }];
        const PROJECTED = [{ at: EARLY, stated: STATED, latest: LATE }];
        const SELECTED = [{ at: EARLY }];
        const TRAVERSED = [{ edge: LINKED, target: LATE }];

        expect({
          collected: await collected.execute(),
          extremes: await extremes.execute(),
          projected: await projected.execute(),
          selected: await selected.execute(),
          traversed: await traversed.execute(),
        }).toEqual({
          collected: COLLECTED,
          extremes: EXTREMES,
          projected: PROJECTED,
          selected: SELECTED,
          traversed: TRAVERSED,
        });
        // The scalar terminals: a date column the compiler cast to the engine's
        // timestamp type, which a driver that does not parse it (postgres-js)
        // returns as offset-bearing text in the session zone.
        const byInstant = (
          rows: readonly Readonly<{ at?: Date | undefined }>[],
        ) =>
          rows
            .map((row) => row.at)
            .toSorted(
              (left, right) =>
                (left?.getTime() ?? Infinity) - (right?.getTime() ?? Infinity),
            );
        const preparedSelect = documents()
          .whereNode("d", (d) => d.title.eq("early zoned"))
          .select((ctx) => ({ at: ctx.d.at }))
          .prepare();
        const preparedProject = documents()
          .whereNode("d", (d) => d.title.eq("early zoned"))
          .project((ctx) => ({ at: ctx.d.at }))
          .prepare();
        const page = await documents()
          .whereNode("d", (d) => d.title.eq("early zoned"))
          .select((ctx) => ({ at: ctx.d.at }))
          .orderBy("d", "at")
          .paginate({ first: 1 });
        expect({
          legacyExtremes: await documents()
            .aggregate({ earliest: min("d", "at"), latest: max("d", "at") })
            .execute(),
          legacyGroupKeys: byInstant(
            await documents()
              .groupBy("d", "at")
              .aggregate({ at: field("d", "at") })
              .execute(),
          ),
          expressionGroupKeys: byInstant(
            await documents()
              .groupBy((fields) => [fields.d.at])
              .aggregate((fields) => ({
                at: fields.d.at,
                count: expr.count(fields.d.title),
              }))
              .execute(),
          ),
          derivedStage: await extremes
            .project((columns) => ({ latest: columns.latest }))
            .execute(),
          preparedSelect: await preparedSelect.execute({}),
          preparedProject: await preparedProject.execute({}),
          paginated: page.data,
        }).toEqual({
          legacyExtremes: EXTREMES,
          legacyGroupKeys: [EARLY, LATE, undefined],
          expressionGroupKeys: [EARLY, LATE, undefined],
          derivedStage: [{ latest: LATE }],
          preparedSelect: SELECTED,
          preparedProject: SELECTED,
          paginated: SELECTED,
        });
        expect(
          await store.batchOnce(
            () =>
              [
                collected,
                extremes,
                projected,
                selected,
                traversed,
                documents()
                  .aggregate({
                    earliest: min("d", "at"),
                    latest: max("d", "at"),
                  })
                  .asRelation(),
              ] as const,
          ),
        ).toEqual([
          COLLECTED,
          EXTREMES,
          PROJECTED,
          SELECTED,
          TRAVERSED,
          EXTREMES,
        ]);

        const subgraph = await store.subgraph(early, {
          edges: ["zonedLink"],
          maxDepth: 1,
          project: {
            nodes: { ZonedDoc: ["title", "at"] },
            edges: { zonedLink: ["at"] },
          },
        });
        expect({
          nodes: subgraph.nodes
            .map((node) => ({ title: node.title, at: node.at }))
            .toSorted((left, right) => left.title.localeCompare(right.title)),
          edges: subgraph.edges.map((edge) => edge.at),
        }).toEqual({
          nodes: [
            { title: "early zoned", at: EARLY },
            { title: "late zoned", at: LATE },
          ],
          edges: [LINKED],
        });
        const hits = await store.search.fulltext("ZonedDoc", {
          query: "early",
          limit: 5,
        });
        expect(hits.map((hit) => hit.node.at)).toEqual([EARLY]);
      } finally {
        await close();
      }
    });

    it("an instant whose session offset has seconds reads back as its Date on every terminal", async () => {
      const { store, close } = await zonedStore(context, graph, MEAN_TIME_ZONE);
      try {
        await store.nodes.ZonedDoc.create({
          title: "early mean time",
          at: MEAN_TIME_INSTANT,
        });
        await store.nodes.ZonedDoc.create({
          title: "later mean time",
          at: MEAN_TIME_LATER,
        });
        const documents = () => store.query().from("ZonedDoc", "d");
        const projected = documents()
          .whereNode("d", (d) => d.title.eq("early mean time"))
          .project((fields) => ({ at: fields.d.at }));
        const ordered = () =>
          documents()
            .select((ctx) => ({ title: ctx.d.title, at: ctx.d.at }))
            .orderBy("d", "at");
        async function observe(read: () => Promise<unknown>) {
          try {
            return await read();
          } catch (error) {
            return { error: error instanceof Error ? error.message : error };
          }
        }
        const observed = {
          projected: await observe(() => projected.execute()),
          batched: await observe(() =>
            store.batchOnce(() => [projected] as const),
          ),
          extremes: await observe(() =>
            documents()
              .aggregate({ earliest: min("d", "at") })
              .execute(),
          ),
          pages: await observe(async () => {
            const page = await ordered().paginate({ first: 1 });
            const next = await ordered().paginate({
              first: 1,
              after: requireDefined(page.nextCursor),
            });
            return [page.data, next.data];
          }),
        };
        const INVALID = { error: "Invalid time value" };
        expectObservation({
          lane: { driver: context.driver },
          observed,
          correct: {
            projected: [{ at: MEAN_TIME_INSTANT }],
            batched: [[{ at: MEAN_TIME_INSTANT }]],
            extremes: [{ earliest: MEAN_TIME_INSTANT }],
            pages: [
              [{ title: "early mean time", at: MEAN_TIME_INSTANT }],
              [{ title: "later mean time", at: MEAN_TIME_LATER }],
            ],
          },
          defects: [
            {
              // PGlite's own result parser, on the statements the backend
              // runs through the client rather than a Drizzle prepared
              // query, turns such text into an `Invalid Date` before any
              // TypeGraph decoder sees it (`normalizeRow` then throws).
              label: "PGlite parses a seconds offset as an Invalid Date",
              on: { driver: ["pglite"] },
              today: {
                projected: INVALID,
                batched: [[{ at: MEAN_TIME_INSTANT }]],
                extremes: INVALID,
                pages: INVALID,
              },
            },
          ],
        });
      } finally {
        await close();
      }
    });
  });
}
