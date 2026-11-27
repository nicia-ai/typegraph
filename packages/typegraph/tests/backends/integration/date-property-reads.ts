/**
 * A property whose schema output is a `Date` is read back as a `Date` on every
 * read path.
 *
 * The store persists a `z.date()` property as its ISO text. Reads returned
 * that text everywhere a whole row came back (collection reads, write
 * returns, query rows, traversals, subgraphs, search hits, history reads),
 * while `.project()` and aggregates already decoded a scalar date — with their
 * own `new Date(value)`, which turned non-portable text into an
 * `Invalid Date`. Every read now decodes through one owner
 * (`decodeStoredDate` / `storedReadPlan` in `src/store/stored-date-revival.ts`):
 * portable timestamp text at a position whose schema output is a `Date`
 * becomes that `Date`; every other value — a position typed anything else, or
 * text that is not the canonical stored form — is returned exactly as stored.
 *
 * The stored form itself is unchanged, so `JSON.stringify` of a read, the
 * export document, a keyset cursor and graph-merge wire props keep their
 * bytes; the golden strings below are those bytes.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  defineEdge,
  defineGraph,
  defineNode,
  expr,
  field,
  max,
  min,
  searchable,
  subClassOf,
} from "../../../src";
import {
  isErr,
  type MergeError,
  type Result,
  unwrap,
} from "../../../src/graph-merge";
import { branch } from "../../../src/graph-merge/branch";
import { planMerge } from "../../../src/graph-merge/merge";
import { asBranchId } from "../../../src/graph-merge/types";
import { exportGraph } from "../../../src/interchange";
import { requireDefined } from "../../../src/utils/presence";
import { expectObservation } from "../../helpers/known-defect";
import { type IntegrationTestContext } from "./test-context";

const PLAIN = new Date("2024-01-02T03:04:05.678Z");
const OPT = new Date("2024-02-03T04:05:06.789Z");
const NUL = new Date("2024-03-04T05:06:07.890Z");
const NESTED = new Date("2024-04-05T06:07:08.901Z");
const ARR_FIRST = new Date("2024-05-06T07:08:09.012Z");
const ARR_SECOND = new Date("2024-06-07T08:09:10.123Z");
const RECORDED = new Date("2024-07-08T09:10:11.234Z");
const UNION = new Date("2024-08-09T10:11:12.345Z");
const COERCED = new Date("2024-09-10T11:12:13.456Z");
const PIPED = new Date("2024-10-11T12:13:14.567Z");
const ISO_TEXT = "2024-11-12T13:14:15.678Z";
const TRANSFORMED = new Date("2024-12-13T14:15:16.789Z");
const LINKED = new Date("2025-01-02T03:04:05.006Z");
const LATER = new Date("2025-06-01T00:00:00.000Z");

/**
 * Text no `Date` the store writes produces: not the canonical UTC
 * millisecond form. A read returns it exactly as stored.
 */
const NON_PORTABLE = "2024-01-02T03:04:05Z";

/** A valid `Date` outside PostgreSQL's `timestamptz` range (there is no year 0). */
const YEAR_ZERO = new Date("0000-06-01T00:00:00.000Z");

/**
 * Two structured properties that type their date positions differently: a
 * `coalesce()` of them may yield either, so only a position both type as a
 * date can be decoded.
 */
const Shaped = defineNode("Shaped", {
  schema: z.object({
    title: z.string(),
    opened: z
      .array(
        z.object({ openedAt: z.date(), closedAt: z.string(), both: z.date() }),
      )
      .optional(),
    closed: z
      .array(
        z.object({ openedAt: z.string(), closedAt: z.date(), both: z.date() }),
      )
      .optional(),
    window: z.object({ at: z.date() }).optional(),
  }),
});

const SHAPED_GRAPH = defineGraph({
  id: "date_reads_shaped",
  nodes: { Shaped: { type: Shaped } },
  edges: {},
});

const DatedRead = defineNode("DatedRead", {
  schema: z.object({
    title: searchable({ language: "english" }),
    plain: z.date(),
    opt: z.date().optional(),
    nul: z.date().nullable(),
    nested: z.object({ at: z.date(), by: z.string() }),
    arr: z.array(z.date()),
    uniDS: z.union([z.date(), z.string()]),
    coerced: z.coerce.date(),
    piped: z.string().pipe(z.coerce.date()),
    iso: z.iso.datetime(),
  }),
});

/**
 * A record of dates and a transform, which reads decode (the record) and leave
 * as stored (the transform's number). Kept on their own kind: an update or a
 * branch re-parses stored props through the schema, and the input side revives
 * neither shape (a separate, write-direction gap).
 */
const DatedReadExtra = defineNode("DatedReadExtra", {
  schema: z.object({
    label: z.string(),
    rec: z.record(z.string(), z.date()),
    xform: z.date().transform((date) => date.getTime()),
  }),
});

/**
 * The two shapes a read decodes but the input side does not revive: a record
 * of dates and a transformed date. Each on its own kind, so one write's
 * outcome names one shape.
 */
const RecordDates = defineNode("RecordDates", {
  schema: z.object({
    label: z.string(),
    rec: z.record(z.string(), z.date()),
  }),
});
const TransformedDate = defineNode("TransformedDate", {
  schema: z.object({
    label: z.string(),
    xform: z.date().transform((date) => date.getTime()),
  }),
});

function buildWriteGapGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      RecordDates: { type: RecordDates },
      TransformedDate: { type: TransformedDate },
    },
    edges: {},
  });
}

/**
 * A write's outcome: `"written"`, or the refusal's name and the date its
 * validation (its own, or its cause's) refused.
 */
async function writeOutcome(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
    return "written";
  } catch (error) {
    if (!(error instanceof Error)) return String(error);
    const text =
      error.cause instanceof Error ? error.cause.message : error.message;
    const reason = /expected date, received \w+/u.exec(text)?.[0] ?? text;
    return `${error.name}: ${reason}`;
  }
}

const datedReadLink = defineEdge("datedReadLink", {
  schema: z.object({
    at: z.date(),
    seen: z.object({ times: z.array(z.date()) }).optional(),
  }),
});

/** Two subclasses of one undated kind: one holds a date, one does not. */
const ReadEvent = defineNode("ReadEvent", {
  schema: z.object({ label: z.string() }),
});
const DatedReadEvent = defineNode("DatedReadEvent", {
  schema: z.object({ label: z.string(), at: z.date() }),
});
const PlainReadEvent = defineNode("PlainReadEvent", {
  schema: z.object({ label: z.string(), at: z.string() }),
});

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      DatedRead: { type: DatedRead },
      DatedReadExtra: { type: DatedReadExtra },
      ReadEvent: { type: ReadEvent },
      DatedReadEvent: { type: DatedReadEvent },
      PlainReadEvent: { type: PlainReadEvent },
    },
    edges: {
      datedReadLink: {
        type: datedReadLink,
        from: [DatedRead],
        to: [DatedRead],
      },
    },
    ontology: [
      subClassOf(DatedReadEvent, ReadEvent),
      subClassOf(PlainReadEvent, ReadEvent),
    ],
  });
}

const FULL_INPUT = {
  title: "dated full",
  plain: PLAIN,
  opt: OPT,
  nul: NUL,
  nested: { at: NESTED, by: "editor" },
  arr: [ARR_FIRST, ARR_SECOND],
  uniDS: UNION,
  coerced: COERCED,
  piped: PIPED.toISOString(),
  iso: ISO_TEXT,
};

/** A full row as a read returns it: a `Date` exactly where the output is one. */
const FULL_READ = {
  title: "dated full",
  plain: PLAIN,
  opt: OPT,
  nul: NUL,
  nested: { at: NESTED, by: "editor" },
  arr: [ARR_FIRST, ARR_SECOND],
  // A mixed union, a string schema and a transform still read as stored.
  uniDS: UNION.toISOString(),
  coerced: COERCED,
  piped: PIPED,
  iso: ISO_TEXT,
};

const SPARSE_INPUT = {
  title: "dated sparse",
  plain: LATER,
  // eslint-disable-next-line unicorn/no-null -- a nullable date stored as JSON null
  nul: null,
  nested: { at: LATER, by: "reviewer" },
  arr: [],
  uniDS: "not a date",
  coerced: LATER,
  piped: LATER.toISOString(),
  iso: ISO_TEXT,
};

const SPARSE_READ = {
  title: "dated sparse",
  plain: LATER,
  // eslint-disable-next-line unicorn/no-null -- a nullable date stored as JSON null
  nul: null,
  nested: { at: LATER, by: "reviewer" },
  arr: [],
  uniDS: "not a date",
  coerced: LATER,
  piped: LATER,
  iso: ISO_TEXT,
};

/**
 * `JSON.stringify` of the full row's props: the bytes a read serialized to
 * before reads returned `Date`s, which a `Date` serializes back to.
 */
const FULL_JSON =
  '{"title":"dated full","plain":"2024-01-02T03:04:05.678Z",' +
  '"opt":"2024-02-03T04:05:06.789Z","nul":"2024-03-04T05:06:07.890Z",' +
  '"nested":{"at":"2024-04-05T06:07:08.901Z","by":"editor"},' +
  '"arr":["2024-05-06T07:08:09.012Z","2024-06-07T08:09:10.123Z"],' +
  '"uniDS":"2024-08-09T10:11:12.345Z","coerced":"2024-09-10T11:12:13.456Z",' +
  '"piped":"2024-10-11T12:13:14.567Z","iso":"2024-11-12T13:14:15.678Z"}';

const NODE_STRUCTURAL_KEYS = new Set(["id", "kind", "meta"]);
const EDGE_STRUCTURAL_KEYS = new Set([
  "id",
  "kind",
  "fromKind",
  "fromId",
  "toKind",
  "toId",
  "meta",
]);

function propsOf(
  entity: unknown,
  structural: ReadonlySet<string> = NODE_STRUCTURAL_KEYS,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(requireDefined(entity) as Record<string, unknown>).filter(
      ([key]) => !structural.has(key),
    ),
  );
}

/** Rows ordered by their title, for reads whose order is not stated. */
function byTitle(
  rows: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  return rows.toSorted((left, right) =>
    String(left["title"]).localeCompare(String(right["title"])),
  );
}

/** Every `Date` anywhere in `value` is a valid one. */
function hasNoInvalidDate(value: unknown): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (Array.isArray(value))
    return value.every((item: unknown) => hasNoInvalidDate(item));
  if (typeof value === "object" && value !== null)
    return Object.values(value).every((item) => hasNoInvalidDate(item));
  return true;
}

async function seed(context: IntegrationTestContext, id: string) {
  const store = await context.createStore(buildGraph(id));
  const full = await store.nodes.DatedRead.create(FULL_INPUT, {
    id: "dated-full",
  });
  const sparse = await store.nodes.DatedRead.create(SPARSE_INPUT, {
    id: "dated-sparse",
  });
  const link = await store.edges.datedReadLink.create(
    full,
    sparse,
    { at: LINKED, seen: { times: [LINKED] } },
    { id: "dated-link" },
  );
  return { store, full, sparse, link };
}

const LINK_READ = { at: LINKED, seen: { times: [LINKED] } };

export function registerDatePropertyReadIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a date property reads back as a Date", () => {
    it("collection reads and write returns", async () => {
      const { store, full, sparse } = await seed(context, "date_reads_coll");
      expect(propsOf(full)).toEqual(FULL_READ);
      expect(propsOf(sparse)).toEqual(SPARSE_READ);
      expect("opt" in sparse).toBe(false);
      expect(propsOf(await store.nodes.DatedRead.getById(full.id))).toEqual(
        FULL_READ,
      );
      const [first, second] = await store.nodes.DatedRead.getByIds([
        full.id,
        sparse.id,
      ]);
      expect(propsOf(first)).toEqual(FULL_READ);
      expect(propsOf(second)).toEqual(SPARSE_READ);
      const found = await store.nodes.DatedRead.find();
      expect(byTitle(found.map((node) => propsOf(node)))).toEqual([
        FULL_READ,
        SPARSE_READ,
      ]);

      const updated = await store.nodes.DatedRead.update(full.id, {
        title: "dated full",
      });
      expect(propsOf(updated)).toEqual(FULL_READ);
      const upserted = await store.nodes.DatedRead.upsertById(
        "dated-upserted",
        FULL_INPUT,
      );
      expect(propsOf(upserted)).toEqual(FULL_READ);
      const [bulk] = await store.nodes.DatedRead.bulkCreate([
        { props: FULL_INPUT },
      ]);
      expect(propsOf(bulk)).toEqual(FULL_READ);

      const extra = await store.nodes.DatedReadExtra.create({
        label: "extra",
        rec: { first: RECORDED },
        xform: TRANSFORMED,
      });
      const extraRead = {
        label: "extra",
        rec: { first: RECORDED },
        xform: TRANSFORMED.getTime(),
      };
      expect(propsOf(extra)).toEqual(extraRead);
      expect(
        propsOf(await store.nodes.DatedReadExtra.getById(extra.id)),
      ).toEqual(extraRead);
      const extraFields = await store
        .query()
        .from("DatedReadExtra", "x")
        .select((ctx) => ({ rec: ctx.x.rec, xform: ctx.x.xform }))
        .execute();
      expect(extraFields).toEqual([
        { rec: extraRead.rec, xform: extraRead.xform },
      ]);
    });

    it("edge reads and write returns", async () => {
      const { store, full, link } = await seed(context, "date_reads_edges");
      expect(propsOf(link, EDGE_STRUCTURAL_KEYS)).toEqual(LINK_READ);
      expect(
        propsOf(
          await store.edges.datedReadLink.getById(link.id),
          EDGE_STRUCTURAL_KEYS,
        ),
      ).toEqual(LINK_READ);
      const outgoing = await store.edges.datedReadLink.findFrom(full);
      expect(
        outgoing.map((edge) => propsOf(edge, EDGE_STRUCTURAL_KEYS)),
      ).toEqual([LINK_READ]);
      const neighbors = await store.neighbors(full, {
        edges: ["datedReadLink"],
        direction: "out",
      });
      expect(
        neighbors.map(({ edge, node }) => [
          propsOf(edge, EDGE_STRUCTURAL_KEYS),
          propsOf(node),
        ]),
      ).toEqual([[LINK_READ, SPARSE_READ]]);
    });

    it("query rows: execute, first, paginate, stream and traversals", async () => {
      const { store } = await seed(context, "date_reads_query");
      const query = store
        .query()
        .from("DatedRead", "d")
        .orderBy("d", "title", "asc")
        .select((ctx) => ctx.d);
      const executed = await query.execute();
      expect(executed.map((row) => propsOf(row))).toEqual([
        FULL_READ,
        SPARSE_READ,
      ]);
      expect(propsOf(await query.first())).toEqual(FULL_READ);
      const page = await query.paginate({ first: 1 });
      expect(page.data.map((row) => propsOf(row))).toEqual([FULL_READ]);
      const streamed: Record<string, unknown>[] = [];
      for await (const row of query.stream({ batchSize: 1 }))
        streamed.push(propsOf(row));
      expect(streamed).toEqual([FULL_READ, SPARSE_READ]);

      const traversed = await store
        .query()
        .from("DatedRead", "d")
        .traverse("datedReadLink", "e")
        .to("DatedRead", "t")
        .select((ctx) => ({ d: ctx.d, e: ctx.e, t: ctx.t }))
        .execute();
      expect(
        traversed.map((row) => [
          propsOf(row.d),
          propsOf(row.e, EDGE_STRUCTURAL_KEYS),
          propsOf(row.t),
        ]),
      ).toEqual([[FULL_READ, LINK_READ, SPARSE_READ]]);

      const optional = await store
        .query()
        .from("DatedRead", "d")
        .optionalTraverse("datedReadLink", "e")
        .to("DatedRead", "t")
        .orderBy("d", "title", "asc")
        .select((ctx) => ({ d: ctx.d, t: ctx.t }))
        .execute();
      expect(
        optional.map((row) => [
          propsOf(row.d),
          row.t === undefined ? undefined : propsOf(row.t),
        ]),
      ).toEqual([
        [FULL_READ, SPARSE_READ],
        [SPARSE_READ, undefined],
      ]);
    });

    it("a polymorphic alias decodes each row for its own kind", async () => {
      const store = await context.createStore(buildGraph("date_reads_poly"));
      await store.nodes.DatedReadEvent.create({
        label: "dated",
        at: PLAIN,
      });
      await store.nodes.PlainReadEvent.create({
        label: "plain",
        at: PLAIN.toISOString(),
      });
      const rows = await store
        .query()
        .from("ReadEvent", "event", { expansion: "subclasses" })
        .orderBy("event", "label", "asc")
        .select((ctx) => ctx.event)
        .execute();
      expect(rows.map((row) => [row.kind, propsOf(row)])).toEqual([
        ["DatedReadEvent", { label: "dated", at: PLAIN }],
        ["PlainReadEvent", { label: "plain", at: PLAIN.toISOString() }],
      ]);
    });

    it("selected fields, projections, relations and aggregates", async () => {
      const { store } = await seed(context, "date_reads_fields");
      const selected = await store
        .query()
        .from("DatedRead", "d")
        .orderBy("d", "title", "asc")
        .select((ctx) => ({
          plain: ctx.d.plain,
          opt: ctx.d.opt,
          nested: ctx.d.nested,
          arr: ctx.d.arr,
          uniDS: ctx.d.uniDS,
          iso: ctx.d.iso,
        }))
        .execute();
      expect(selected).toEqual([
        {
          plain: PLAIN,
          opt: OPT,
          nested: FULL_READ.nested,
          arr: FULL_READ.arr,
          uniDS: FULL_READ.uniDS,
          iso: ISO_TEXT,
        },
        {
          plain: LATER,
          opt: undefined,
          nested: SPARSE_READ.nested,
          arr: [],
          uniDS: "not a date",
          iso: ISO_TEXT,
        },
      ]);

      const projected = await store
        .query()
        .from("DatedRead", "d")
        .orderBy("d", "title", "asc")
        .project((fields) => ({
          plain: fields.d.plain,
          piped: fields.d.piped,
          nested: fields.d.nested,
          arr: fields.d.arr,
          uniDS: fields.d.uniDS,
        }))
        .execute();
      expect(projected).toEqual([
        {
          plain: PLAIN,
          piped: PIPED,
          nested: FULL_READ.nested,
          arr: FULL_READ.arr,
          uniDS: FULL_READ.uniDS,
        },
        {
          plain: LATER,
          piped: LATER,
          nested: SPARSE_READ.nested,
          arr: [],
          uniDS: "not a date",
        },
      ]);

      const related = await store
        .query()
        .from("DatedRead", "d")
        .project((fields) => ({
          title: fields.d.title,
          plain: fields.d.plain,
          arr: fields.d.arr,
        }))
        .asRelation()
        .project((columns) => ({
          title: columns.title,
          plain: columns.plain,
          arr: columns.arr,
        }))
        .execute();
      expect(
        related.toSorted((left, right) =>
          left.title.localeCompare(right.title),
        ),
      ).toEqual([
        { title: "dated full", plain: PLAIN, arr: FULL_READ.arr },
        { title: "dated sparse", plain: LATER, arr: [] },
      ]);

      const [aggregated] = await store
        .query()
        .from("DatedRead", "d")
        .aggregate({
          earliest: min("d", "plain"),
          latest: max("d", "plain"),
        })
        .execute();
      expect(aggregated).toEqual({ earliest: PLAIN, latest: LATER });
    });

    it("subgraphs, whole and projected", async () => {
      const { store, full } = await seed(context, "date_reads_subgraph");
      const whole = await store.subgraph(full, {
        edges: ["datedReadLink"],
        maxDepth: 1,
      });
      const nodes = whole.nodes.map((node) => propsOf(node));
      expect(
        nodes.toSorted((left, right) =>
          String(left["title"]).localeCompare(String(right["title"])),
        ),
      ).toEqual([FULL_READ, SPARSE_READ]);
      expect(
        whole.edges.map((edge) => propsOf(edge, EDGE_STRUCTURAL_KEYS)),
      ).toEqual([LINK_READ]);

      const projected = await store.subgraph(full, {
        edges: ["datedReadLink"],
        maxDepth: 1,
        project: {
          nodes: { DatedRead: ["title", "plain", "nested", "arr", "uniDS"] },
          edges: { datedReadLink: ["at", "seen"] },
        },
      });
      expect(
        projected.nodes
          .map((node) => propsOf(node))
          .toSorted((left, right) =>
            String(left["title"]).localeCompare(String(right["title"])),
          ),
      ).toEqual([
        {
          title: "dated full",
          plain: PLAIN,
          nested: FULL_READ.nested,
          arr: FULL_READ.arr,
          uniDS: FULL_READ.uniDS,
        },
        {
          title: "dated sparse",
          plain: LATER,
          nested: SPARSE_READ.nested,
          arr: [],
          uniDS: "not a date",
        },
      ]);
      expect(
        projected.edges.map((edge) => propsOf(edge, EDGE_STRUCTURAL_KEYS)),
      ).toEqual([LINK_READ]);
    });

    it("fulltext search hits, on every page", async () => {
      const { store } = await seed(context, "date_reads_search");
      const firstPage = await store.search.fulltext("DatedRead", {
        query: "dated",
        limit: 1,
      });
      const secondPage = await store.search.fulltext("DatedRead", {
        query: "dated",
        limit: 1,
        offset: 1,
      });
      const hits = [...firstPage, ...secondPage].map((hit) =>
        propsOf(hit.node),
      );
      expect(
        hits.toSorted((left, right) =>
          String(left["title"]).localeCompare(String(right["title"])),
        ),
      ).toEqual([FULL_READ, SPARSE_READ]);
    });

    it("valid-time, recorded-time and transaction reads", async () => {
      const store = await context.createHistoryStore(
        buildGraph("date_reads_history"),
      );
      const full = await store.nodes.DatedRead.create(FULL_INPUT, {
        id: "dated-full",
      });
      const recorded = requireDefined(await store.recordedNow());
      await store.nodes.DatedRead.update(full.id, { plain: LATER });

      const validView = store.asOf(new Date().toISOString());
      expect(propsOf(await validView.nodes.DatedRead.getById(full.id))).toEqual(
        { ...FULL_READ, plain: LATER },
      );
      const recordedView = store.asOfRecorded(recorded);
      expect(
        propsOf(await recordedView.nodes.DatedRead.getById(full.id)),
      ).toEqual(FULL_READ);
      const scanned = await recordedView.nodes.DatedRead.scan();
      expect(scanned.data.map((node) => propsOf(node))).toEqual([FULL_READ]);

      await store.transaction(async (tx) => {
        const created = await tx.nodes.DatedRead.create(SPARSE_INPUT, {
          id: "dated-tx",
        });
        expect(propsOf(created)).toEqual(SPARSE_READ);
        expect(propsOf(await tx.nodes.DatedRead.getById(created.id))).toEqual(
          SPARSE_READ,
        );
        const rows = await tx
          .query()
          .from("DatedRead", "d")
          .whereNode("d", (node) => node.id.eq(created.id))
          .select((ctx) => ctx.d)
          .execute();
        expect(rows.map((row) => propsOf(row))).toEqual([SPARSE_READ]);
      });
    });

    it("graph-merge callbacks receive the node as a read returns it", async () => {
      const graph = buildGraph("date_reads_merge");
      const base = await context.createStore(graph, {
        revisionTracking: true,
      });
      const left = unwrap(
        await branch(base, () => context.createIsolatedBackend(), {
          id: asBranchId("left"),
        }),
      );
      const right = unwrap(
        await branch(base, () => context.createIsolatedBackend(), {
          id: asBranchId("right"),
        }),
      );
      await left.store.nodes.DatedRead.create(FULL_INPUT, { id: "left-doc" });
      await right.store.nodes.DatedRead.create(FULL_INPUT, {
        id: "right-doc",
      });
      const blocked: unknown[] = [];
      const scored: unknown[] = [];
      const planned: Result<unknown, MergeError> = await planMerge(
        base,
        [left, right],
        {
          resolve: {
            DatedRead: {
              block: (node) => {
                blocked.push(node.plain, node.nested.at, node.uniDS);
                return "all";
              },
              similarity: {
                kind: "custom",
                score: (a, b) => {
                  scored.push(a.plain, b.arr[0]);
                  return 1;
                },
              },
              threshold: 0.5,
            },
          },
        },
      );
      if (isErr(planned)) throw planned.error;
      expect(blocked).toEqual([
        PLAIN,
        NESTED,
        UNION.toISOString(),
        PLAIN,
        NESTED,
        UNION.toISOString(),
      ]);
      expect(scored).toEqual([PLAIN, ARR_FIRST]);
    });
  });

  describe("a date property's stored form is unchanged", () => {
    it("JSON.stringify of a read and the export document keep their bytes", async () => {
      const { store, full } = await seed(context, "date_reads_bytes");
      // The backend's own row: the bytes a read serialized to when it returned
      // the stored props as they are (key order is the engine's: PostgreSQL
      // `jsonb` orders keys itself).
      const row = requireDefined(
        await store.backend.getNode(store.graphId, "DatedRead", full.id),
      );
      const storedJson = JSON.stringify(
        typeof row.props === "string" ? JSON.parse(row.props) : row.props,
      );
      expect(JSON.parse(storedJson)).toEqual(JSON.parse(FULL_JSON));
      expect(
        JSON.stringify(propsOf(await store.nodes.DatedRead.getById(full.id))),
      ).toBe(storedJson);
      const exported = await exportGraph(store);
      const exportedFull = requireDefined(
        exported.nodes.find((node) => node.id === full.id),
      );
      expect(JSON.stringify(exportedFull.properties)).toBe(storedJson);
      const exportedLink = requireDefined(exported.edges[0]);
      expect(exportedLink.properties).toEqual({
        at: LINKED.toISOString(),
        seen: { times: [LINKED.toISOString()] },
      });
    });

    it("a keyset cursor over a date keeps its bytes and resumes", async () => {
      const { store } = await seed(context, "date_reads_cursor");
      const query = store
        .query()
        .from("DatedRead", "d")
        .orderBy("d", "plain", "asc")
        .select((ctx) => ctx.d);
      const page = await query.paginate({ first: 1 });
      const cursor = requireDefined(page.nextCursor);
      const payload = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      ) as Readonly<{ vals: unknown }>;
      expect(JSON.stringify(payload.vals)).toBe(
        '["2024-01-02T03:04:05.678Z","dated-full"]',
      );
      const next = await query.paginate({ first: 1, after: cursor });
      expect(next.data.map((row) => propsOf(row))).toEqual([SPARSE_READ]);
    });

    it("graph-merge wire props carry the stored text", async () => {
      const graph = buildGraph("date_reads_merge_wire");
      const base = await context.createStore(graph, {
        revisionTracking: true,
      });
      await base.nodes.DatedRead.create(FULL_INPUT, { id: "committed" });
      const fork = unwrap(
        await branch(base, () => context.createIsolatedBackend(), {
          id: asBranchId("fork"),
        }),
      );
      await fork.store.nodes.DatedRead.update(
        asNodeId<typeof DatedRead>("committed"),
        {
          title: "forked",
        },
      );
      await fork.store.nodes.DatedRead.create(SPARSE_INPUT, { id: "staged" });
      const writes = unwrap(await planMerge(base, [fork], {})).writes
        .nodeUpserts;
      const byId = Object.fromEntries(
        writes.map((write) => [write.id, JSON.stringify(write.setProps)]),
      );
      // Canonical (key-sorted) stored props: every date as its stored text.
      expect(byId).toEqual({
        committed:
          '{"arr":["2024-05-06T07:08:09.012Z","2024-06-07T08:09:10.123Z"],' +
          '"coerced":"2024-09-10T11:12:13.456Z","iso":"2024-11-12T13:14:15.678Z",' +
          '"nested":{"at":"2024-04-05T06:07:08.901Z","by":"editor"},' +
          '"nul":"2024-03-04T05:06:07.890Z","opt":"2024-02-03T04:05:06.789Z",' +
          '"piped":"2024-10-11T12:13:14.567Z","plain":"2024-01-02T03:04:05.678Z",' +
          '"title":"forked","uniDS":"2024-08-09T10:11:12.345Z"}',
        staged:
          '{"arr":[],"coerced":"2025-06-01T00:00:00.000Z",' +
          '"iso":"2024-11-12T13:14:15.678Z",' +
          '"nested":{"at":"2025-06-01T00:00:00.000Z","by":"reviewer"},' +
          '"nul":null,"piped":"2025-06-01T00:00:00.000Z",' +
          '"plain":"2025-06-01T00:00:00.000Z","title":"dated sparse",' +
          '"uniDS":"not a date"}',
      });
    });

    it("pins the write-direction gaps: an update or a branch over a stored record of dates or a transformed date refuses", async () => {
      const recordStore = await context.createStore(
        buildWriteGapGraph("date_reads_record_gap"),
        { revisionTracking: true },
      );
      const transformStore = await context.createStore(
        buildWriteGapGraph("date_reads_transform_gap"),
        { revisionTracking: true },
      );
      const recorded = await recordStore.nodes.RecordDates.create({
        label: "a",
        rec: { first: RECORDED },
      });
      const transformed = await transformStore.nodes.TransformedDate.create({
        label: "a",
        xform: TRANSFORMED,
      });
      // Reads decode the record and return the transform's number.
      expect([recorded.rec, transformed.xform]).toEqual([
        { first: RECORDED },
        TRANSFORMED.getTime(),
      ]);
      const branchOutcome = async (store: typeof recordStore, id: string) =>
        writeOutcome(async () => {
          unwrap(
            await branch(store, () => context.createIsolatedBackend(), {
              id: asBranchId(id),
            }),
          );
        });
      const observed = {
        recordUpdate: await writeOutcome(() =>
          recordStore.nodes.RecordDates.update(recorded.id, { label: "b" }),
        ),
        transformUpdate: await writeOutcome(() =>
          transformStore.nodes.TransformedDate.update(transformed.id, {
            label: "b",
          }),
        ),
        recordBranch: await branchOutcome(recordStore, "record-gap"),
        transformBranch: await branchOutcome(transformStore, "transform-gap"),
      };
      // The input side revives neither shape, so a write that re-parses the
      // stored row refuses it. A write-direction gap, not fixed by reads.
      expectObservation({
        lane: { dialect: recordStore.backend.dialect },
        observed,
        correct: {
          recordUpdate: "written",
          transformUpdate: "written",
          recordBranch: "written",
          transformBranch: "written",
        },
        defects: [
          {
            label: "input-side revival of a record of dates and a transform",
            on: {},
            today: {
              recordUpdate: "ValidationError: expected date, received string",
              transformUpdate:
                "ValidationError: expected date, received number",
              recordBranch: "BranchError: expected date, received string",
              transformBranch: "BranchError: expected date, received number",
            },
          },
        ],
      });
    });

    it("non-portable stored text reads back as stored, never an Invalid Date", async () => {
      const store = await context.createStore(
        buildGraph("date_reads_non_portable"),
      );
      const stored = {
        ...JSON.parse(FULL_JSON),
        title: "legacy",
        plain: NON_PORTABLE,
        nested: { at: "not a date", by: "legacy" },
        arr: [NON_PORTABLE, ARR_SECOND.toISOString()],
      } as Record<string, unknown>;
      await store.backend.insertNode({
        graphId: store.graphId,
        kind: "DatedRead",
        id: "legacy",
        props: stored,
      });
      const expected = {
        ...FULL_READ,
        title: "legacy",
        plain: NON_PORTABLE,
        nested: { at: "not a date", by: "legacy" },
        arr: [NON_PORTABLE, ARR_SECOND],
      };
      expect(
        propsOf(
          await store.nodes.DatedRead.getById(
            asNodeId<typeof DatedRead>("legacy"),
          ),
        ),
      ).toEqual(expected);
      const [row] = await store
        .query()
        .from("DatedRead", "d")
        .select((ctx) => ctx.d)
        .execute();
      expect(propsOf(row)).toEqual(expected);
      const [projected] = await store
        .query()
        .from("DatedRead", "d")
        .project((fields) => ({
          nested: fields.d.nested,
          arr: fields.d.arr,
        }))
        .execute();
      expect(projected).toEqual({
        nested: expected.nested,
        arr: expected.arr,
      });
      // Every terminal that types a scalar date in SQL returns non-portable
      // stored text as stored on SQLite. PostgreSQL extracts the same value
      // with a `timestamptz` cast, so text it can cast comes back as the
      // `Date` the cast reads (a backend parity gap the deferred
      // index/predicate redesign, comparing canonical text, removes). It is
      // never an `Invalid Date` on any backend.
      const documents = () => store.query().from("DatedRead", "d");
      const projection = documents().project((fields) => ({
        plain: fields.d.plain,
        latest: fields.$scalar((subquery) =>
          subquery
            .from("DatedRead", "x")
            .aggregate((inner) => ({ value: expr.max(inner.x.plain) })),
        ),
      }));
      const [scalar] = await projection.execute();
      const [selected] = await documents()
        .select((ctx) => ({ plain: ctx.d.plain }))
        .execute();
      const [aggregated] = await documents()
        .aggregate({ earliest: min("d", "plain") })
        .execute();
      const [grouped] = await documents()
        .groupBy("d", "plain")
        .aggregate({ plain: field("d", "plain") })
        .execute();
      const [collected] = await documents()
        .aggregate((fields) => ({
          earliest: expr.min(fields.d.plain),
          every: expr.collect(fields.d.plain, {
            orderBy: [{ expression: fields.d.title }],
          }),
        }))
        .asRelation()
        .execute();
      const [[batched]] = await store.batchOnce(() => [projection] as const);
      const observed: Readonly<Record<string, unknown>> = {
        project: scalar?.plain,
        scalarSubquery: scalar?.latest,
        select: selected?.plain,
        aggregate: aggregated?.earliest,
        groupBy: grouped?.plain,
        expressionAggregate: collected?.earliest,
        collect: collected?.every,
        batchOnce: batched?.plain,
      };
      expect(hasNoInvalidDate(observed)).toBe(true);
      const cast = new Date(NON_PORTABLE);
      expectObservation({
        lane: { dialect: store.backend.dialect },
        observed,
        correct: {
          project: NON_PORTABLE,
          scalarSubquery: NON_PORTABLE,
          select: NON_PORTABLE,
          aggregate: NON_PORTABLE,
          groupBy: NON_PORTABLE,
          expressionAggregate: NON_PORTABLE,
          collect: [NON_PORTABLE],
          batchOnce: NON_PORTABLE,
        },
        defects: [
          {
            label: "PostgreSQL casts a scalar date to timestamptz",
            on: { dialect: ["postgres"] },
            today: {
              project: cast,
              scalarSubquery: cast,
              select: cast,
              aggregate: cast,
              groupBy: cast,
              expressionAggregate: cast,
              collect: [cast],
              batchOnce: cast,
            },
          },
        ],
      });
    });
  });

  describe("a composed or nested date expression decodes only what it yields", () => {
    it("collects a stated date as the Date stated, outside the engine's timestamp range too", async () => {
      const { store } = await seed(context, "date_reads_stated_collect");
      const [row] = await store
        .query()
        .from("DatedRead", "d")
        .aggregate((fields) => ({
          stated: expr.collect(expr.literal(YEAR_ZERO), {
            orderBy: [{ expression: fields.d.title }],
          }),
          records: expr.collect(
            { at: expr.literal(YEAR_ZERO), plain: fields.d.plain },
            { orderBy: [{ expression: fields.d.title }] },
          ),
        }))
        .asRelation()
        .execute();
      expect(row).toEqual({
        stated: [YEAR_ZERO, YEAR_ZERO],
        records: [
          { at: YEAR_ZERO, plain: PLAIN },
          { at: YEAR_ZERO, plain: LATER },
        ],
      });
    });

    it("a coalesce of structured properties decodes only the date positions every branch shares", async () => {
      const store = await context.createStore(SHAPED_GRAPH);
      await store.nodes.Shaped.create({
        title: "closed only",
        closed: [{ openedAt: ISO_TEXT, closedAt: PLAIN, both: OPT }],
        window: { at: PLAIN },
      });
      const [row] = await store
        .query()
        .from("Shaped", "s")
        .project((fields) => ({
          // The public types refuse a structured operand; an untyped caller (a
          // dynamic query) composes one all the same.
          either: expr.coalesce(
            fields.s.opened as never,
            fields.s.closed as never,
          ),
        }))
        .execute();
      // `closed` is the branch the engine returns; `opened` types its
      // `openedAt` as a date and `closedAt` as text, so only the position both
      // type as a date is decoded and the rest is returned as stored.
      expect(row?.either).toEqual([
        { openedAt: ISO_TEXT, closedAt: PLAIN.toISOString(), both: OPT },
      ]);

      // An object property cannot be composed at all: its field proxy refuses
      // the `arrayElementType` member a composition reads. Pinned as main has it.
      const objectComposition = await (async () => {
        try {
          const rows = await store
            .query()
            .from("Shaped", "s")
            .project((fields) => ({
              // The types refuse an object field operand as well.
              window: expr.coalesce(
                fields.s.window as never,
                fields.s.window as never,
              ),
            }))
            .execute();
          return { rows };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })();
      expectObservation({
        lane: { dialect: store.backend.dialect },
        observed: objectComposition,
        correct: { rows: [{ window: { at: PLAIN } }] },
        defects: [
          {
            label: "object field proxy refuses arrayElementType",
            on: {},
            today: {
              error: 'Unknown expression field "s.window.arrayElementType"',
            },
          },
        ],
      });
    });

    it("$scalar() of a structured property decodes its date positions", async () => {
      const { store } = await seed(context, "date_reads_scalar_structured");
      const [row] = await store
        .query()
        .from("DatedRead", "d")
        .whereNode("d", (d) => d.title.eq(FULL_INPUT.title))
        .project((fields) => ({
          arr: fields.$scalar((subquery) =>
            subquery
              .from("DatedRead", "x")
              .whereNode("x", (x) => x.title.eq(FULL_INPUT.title))
              .project((inner) => ({ arr: inner.x.arr }))
              .limit(1),
          ),
        }))
        .execute();
      expect(row).toEqual({ arr: FULL_READ.arr });
    });
  });
}
