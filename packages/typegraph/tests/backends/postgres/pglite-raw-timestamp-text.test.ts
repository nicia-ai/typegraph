/**
 * A driver that hands back an engine timestamp as PostgreSQL's text, rather
 * than parsing it, still reads back the instant when the session time zone
 * renders that text with an offset to the second.
 *
 * PostgreSQL renders a `timestamptz` before a zone adopted standard time in
 * the zone's local mean time: `1880-06-01T00:00:00.001Z` under
 * `Europe/Paris` is `1880-06-01 00:09:21.001+00:09:21`. A driver that does
 * not parse timestamps (postgres-js does not) leaves that text to the engine
 * decode leaf, whose one canonicalizer (`canonicalizeDatabaseTimestamp`) must
 * read the seconds. PGlite configured to return timestamp text is that driver,
 * in process.
 */
import { PGlite, types } from "@electric-sql/pglite";
import { vector as pgvectorExtension } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  min,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";

const MEAN_TIME_INSTANT = new Date("1880-06-01T00:00:00.001Z");
const MEAN_TIME_LATER = new Date("1880-06-02T00:00:00.000Z");

const MeanTime = defineNode("MeanTime", {
  schema: z.object({ title: z.string(), at: z.date() }),
});

const graph = defineGraph({
  id: "pglite_raw_timestamp_text",
  nodes: { MeanTime: { type: MeanTime } },
  edges: {},
});

/** Returns every timestamp as the text PostgreSQL rendered. */
const RAW_TIMESTAMPS = {
  [types.TIMESTAMPTZ]: (value: string) => value,
  [types.TIMESTAMP]: (value: string) => value,
};

describe("engine timestamp text with a seconds offset, on a driver that does not parse it", () => {
  let client: PGlite | undefined;

  beforeEach(async () => {
    client = new PGlite({
      extensions: { vector: pgvectorExtension },
      parsers: RAW_TIMESTAMPS,
    });
    await client.exec(generatePostgresMigrationSQL());
    await client.exec("SET TIME ZONE 'Europe/Paris'");
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("renders the offset to the second", async () => {
    const result = await requireDefined(client).query<{ at: string }>(
      `SELECT CAST('${MEAN_TIME_INSTANT.toISOString()}' AS timestamptz) AS at`,
    );
    expect(result.rows[0]?.at).toBe("1880-06-01 00:09:21.001+00:09:21");
  });

  it("reads back the instant on every scalar terminal", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createPostgresBackend(drizzle(requireDefined(client))),
    );
    await store.nodes.MeanTime.create({
      title: "early",
      at: MEAN_TIME_INSTANT,
    });
    await store.nodes.MeanTime.create({ title: "later", at: MEAN_TIME_LATER });
    const documents = () => store.query().from("MeanTime", "d");
    const projected = documents()
      .whereNode("d", (d) => d.title.eq("early"))
      .project((fields) => ({ at: fields.d.at }));
    const ordered = () =>
      documents()
        .select((ctx) => ({ title: ctx.d.title, at: ctx.d.at }))
        .orderBy("d", "at");
    const page = await ordered().paginate({ first: 1 });
    const next = await ordered().paginate({
      first: 1,
      after: requireDefined(page.nextCursor),
    });
    expect({
      projected: await projected.execute(),
      batched: await store.batchOnce(() => [projected] as const),
      extremes: await documents()
        .aggregate({ earliest: min("d", "at") })
        .execute(),
      pages: [page.data, next.data],
    }).toEqual({
      projected: [{ at: MEAN_TIME_INSTANT }],
      batched: [[{ at: MEAN_TIME_INSTANT }]],
      extremes: [{ earliest: MEAN_TIME_INSTANT }],
      pages: [
        [{ title: "early", at: MEAN_TIME_INSTANT }],
        [{ title: "later", at: MEAN_TIME_LATER }],
      ],
    });
  });
});
