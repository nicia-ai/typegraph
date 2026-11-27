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
  type GraphDef,
  max,
  min,
  searchable,
} from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

/** A zone with a non-whole-hour offset and no daylight-saving rule. */
const SESSION_ZONE = "Asia/Kathmandu";

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
) {
  if (context.getBackend().dialect !== "postgres") {
    return {
      store: await context.createStore(zonedGraph),
      close: () => Promise.resolve(),
    };
  }
  const handle = await context.createSerializedBackend();
  const executeRaw = requireDefined(handle.backend.executeRaw);
  await executeRaw(`SET TIME ZONE '${SESSION_ZONE}'`, []);
  const [zone] = await executeRaw<{ TimeZone: string }>("SHOW TimeZone", []);
  expect(zone?.TimeZone).toBe(SESSION_ZONE);
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
    it("every collect, projection, aggregate, batch, subgraph and search terminal returns the same Date", async () => {
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
  });
}
