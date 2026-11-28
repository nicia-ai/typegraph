/**
 * Every `Date` the store accepts reads back as a `Date` at the same
 * millisecond, whichever write stored it and whichever read returns it.
 *
 * The store persists a date property as its `toISOString()` text and a read
 * decodes portable timestamp text back to a `Date`
 * (`src/store/stored-date-revival.ts`). The property spans the whole portable
 * range (years 0001 to 9999) through every write that stores a date — the
 * single-row creates and updates that let `JSON.stringify` encode it, and the
 * set updates that encode it explicitly — and every read that returns one.
 * The shared integration suite runs the same paths on every backend.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  defineEdge,
  defineGraph,
  defineNode,
  max,
  min,
} from "../../src";
import { createInitializedStore, createTestBackend } from "../test-utils";
import { propertyRuns } from "./run-budget";

const RoundTripDocument = defineNode("RoundTripDoc", {
  schema: z.object({
    label: z.string(),
    at: z.date(),
    nested: z.object({ at: z.date() }),
    many: z.array(z.date()),
  }),
});

const roundTripLink = defineEdge("roundTripLink", {
  schema: z.object({ at: z.date() }),
});

const graph = defineGraph({
  id: "date_read_roundtrip",
  nodes: { RoundTripDoc: { type: RoundTripDocument } },
  edges: {
    roundTripLink: {
      type: roundTripLink,
      from: [RoundTripDocument],
      to: [RoundTripDocument],
    },
  },
});

const portableDate = fc.date({
  min: new Date("0001-01-01T00:00:00.000Z"),
  max: new Date("9999-12-31T23:59:59.999Z"),
  noInvalidDate: true,
});

/** How a date reaches storage. */
const WRITES = [
  "create",
  "bulkCreate",
  "upsertById",
  "update",
  "updateWhere",
  "compareAndSet",
] as const;

type Write = (typeof WRITES)[number];

function documentAt(label: string, date: Date) {
  return { label, at: date, nested: { at: date }, many: [date, date] };
}

/** `value` is a `Date` at exactly `date`'s millisecond. */
function expectSameInstant(value: unknown, date: Date): void {
  expect(value).toBeInstanceOf(Date);
  expect((value as Date).getTime()).toBe(date.getTime());
}

function expectDocumentAt(node: unknown, date: Date): void {
  const read = node as Readonly<{
    at: unknown;
    nested: Readonly<{ at: unknown }>;
    many: readonly unknown[];
  }>;
  expectSameInstant(read.at, date);
  expectSameInstant(read.nested.at, date);
  expect(read.many).toHaveLength(2);
  for (const element of read.many) expectSameInstant(element, date);
}

describe("a stored Date reads back at the same millisecond", () => {
  it("through every write and every read", async () => {
    await fc.assert(
      fc.asyncProperty(
        portableDate,
        portableDate,
        fc.constantFrom(...WRITES),
        async (date, placeholder, write: Write) => {
          const store = await createInitializedStore(
            graph,
            createTestBackend(),
          );
          const id = asNodeId<typeof RoundTripDocument>("doc");
          const initial = documentAt("doc", placeholder);
          const writes: Record<Write, () => Promise<unknown>> = {
            create: () =>
              store.nodes.RoundTripDoc.create(documentAt("doc", date), { id }),
            bulkCreate: async () => {
              const [created] = await store.nodes.RoundTripDoc.bulkCreate([
                { id, props: documentAt("doc", date) },
              ]);
              return created;
            },
            upsertById: () =>
              store.nodes.RoundTripDoc.upsertById(id, documentAt("doc", date)),
            update: async () => {
              await store.nodes.RoundTripDoc.create(initial, { id });
              return store.nodes.RoundTripDoc.update(id, {
                at: date,
                nested: { at: date },
                many: [date, date],
              });
            },
            updateWhere: async () => {
              await store.nodes.RoundTripDoc.create(initial, { id });
              await store.nodes.RoundTripDoc.updateWhere({
                where: (node) => node.id.eq(id),
                patch: { at: date, nested: { at: date }, many: [date, date] },
              });
            },
            compareAndSet: async () => {
              await store.nodes.RoundTripDoc.create(initial, { id });
              await store.nodes.RoundTripDoc.compareAndSet(id, {
                expected: { at: placeholder },
                patch: { at: date, nested: { at: date }, many: [date, date] },
              });
            },
          };
          const returned = await writes[write]();
          if (returned !== undefined) expectDocumentAt(returned, date);

          const target = await store.nodes.RoundTripDoc.create(
            documentAt("target", date),
          );
          const link = await store.edges.roundTripLink.create(
            { kind: "RoundTripDoc", id },
            target,
            { at: date },
          );
          expectSameInstant(link.at, date);

          expectDocumentAt(await store.nodes.RoundTripDoc.getById(id), date);
          for (const node of await store.nodes.RoundTripDoc.find())
            expectDocumentAt(node, date);
          const rows = await store
            .query()
            .from("RoundTripDoc", "d")
            .traverse("roundTripLink", "e")
            .to("RoundTripDoc", "t")
            .select((ctx) => ({ d: ctx.d, e: ctx.e, t: ctx.t, at: ctx.d.at }))
            .execute();
          expect(rows).toHaveLength(1);
          for (const row of rows) {
            expectDocumentAt(row.d, date);
            expectDocumentAt(row.t, date);
            expectSameInstant(row.e.at, date);
            expectSameInstant(row.at, date);
          }
          const [projected] = await store
            .query()
            .from("RoundTripDoc", "d")
            .whereNode("d", (node) => node.id.eq(id))
            .project((fields) => ({
              at: fields.d.at,
              nested: fields.d.nested,
              many: fields.d.many,
            }))
            .execute();
          expectDocumentAt(projected, date);
          const [aggregated] = await store
            .query()
            .from("RoundTripDoc", "d")
            .aggregate({ earliest: min("d", "at"), latest: max("d", "at") })
            .execute();
          expectSameInstant(aggregated?.earliest, date);
          expectSameInstant(aggregated?.latest, date);
          const subgraph = await store.subgraph(
            { kind: "RoundTripDoc", id },
            { edges: ["roundTripLink"], maxDepth: 1 },
          );
          for (const node of subgraph.nodes) expectDocumentAt(node, date);
          for (const edge of subgraph.edges)
            expectSameInstant((edge as Readonly<{ at: unknown }>).at, date);
          // The stored form a read serializes to is the text the write stored.
          const reread = await store.nodes.RoundTripDoc.getById(id);
          expect(JSON.stringify(reread?.nested)).toBe(
            JSON.stringify({ at: date.toISOString() }),
          );
          await store.close();
        },
      ),
      { numRuns: propertyRuns({ ci: 60, local: 25 }) },
    );
  }, 120_000);
});
