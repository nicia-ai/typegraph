/**
 * The static types of a date property's reads, which the runtime now honors:
 * a position whose schema output is a `Date` is typed `Date` on every read
 * path, a `z.iso.datetime()` is typed `string`, and a mixed union is typed as
 * its union (and reads as stored text).
 */
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  max,
  min,
  searchable,
  type Store,
} from "../src";

const Dated = defineNode("Dated", {
  schema: z.object({
    title: searchable({ language: "english" }),
    plain: z.date(),
    opt: z.date().optional(),
    nested: z.object({ at: z.date() }),
    arr: z.array(z.date()),
    piped: z.string().pipe(z.coerce.date()),
    iso: z.iso.datetime(),
    uniDS: z.union([z.date(), z.string()]),
  }),
});

const datedLink = defineEdge("datedLink", {
  schema: z.object({ at: z.date() }),
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only its type is read
const graph = defineGraph({
  id: "date_read_types",
  nodes: { Dated: { type: Dated } },
  edges: { datedLink: { type: datedLink, from: [Dated], to: [Dated] } },
});

type DatedStore = Store<typeof graph>;

/** The reads whose return types the cases below inspect; never called. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only its type is read
function reads(store: DatedStore) {
  return {
    selected: store
      .query()
      .from("Dated", "d")
      .select((ctx) => ({ plain: ctx.d.plain, iso: ctx.d.iso }))
      .execute(),
    projected: store
      .query()
      .from("Dated", "d")
      .project((fields) => ({ plain: fields.d.plain }))
      .execute(),
    aggregated: store
      .query()
      .from("Dated", "d")
      .aggregate({ earliest: min("d", "plain"), latest: max("d", "plain") })
      .execute(),
    hits: store.search.fulltext("Dated", { query: "x", limit: 1 }),
  };
}

describe("date property read types", () => {
  it("types node and edge props", () => {
    type ReadNode = NonNullable<
      Awaited<ReturnType<DatedStore["nodes"]["Dated"]["getById"]>>
    >;
    expectTypeOf<ReadNode["plain"]>().toEqualTypeOf<Date>();
    expectTypeOf<ReadNode["opt"]>().toEqualTypeOf<Date | undefined>();
    expectTypeOf<ReadNode["nested"]["at"]>().toEqualTypeOf<Date>();
    expectTypeOf<ReadNode["arr"]>().toEqualTypeOf<Date[]>();
    expectTypeOf<ReadNode["piped"]>().toEqualTypeOf<Date>();
    expectTypeOf<ReadNode["iso"]>().toEqualTypeOf<string>();
    expectTypeOf<ReadNode["uniDS"]>().toEqualTypeOf<Date | string>();

    type ReadEdge = NonNullable<
      Awaited<ReturnType<DatedStore["edges"]["datedLink"]["getById"]>>
    >;
    expectTypeOf<ReadEdge["at"]>().toEqualTypeOf<Date>();
  });

  it("types selected fields, projections, aggregates and search hits", () => {
    type Reads = ReturnType<typeof reads>;
    type Selected = Awaited<Reads["selected"]>[number];
    expectTypeOf<Selected["plain"]>().toEqualTypeOf<Date>();
    expectTypeOf<Selected["iso"]>().toEqualTypeOf<string>();
    type Projected = Awaited<Reads["projected"]>[number];
    expectTypeOf<Projected["plain"]>().toEqualTypeOf<Date>();
    type Aggregated = Awaited<Reads["aggregated"]>[number];
    expectTypeOf<Aggregated["earliest"]>().toEqualTypeOf<Date | undefined>();
    type Hit = Awaited<Reads["hits"]>[number];
    expectTypeOf<Hit["node"]["plain"]>().toEqualTypeOf<Date>();
  });
});
