/**
 * Which schema positions a read decodes as a `Date`, for the schema shapes
 * whose typing is not a single declaration: a recursive object, a union of
 * structured branches, the operands of a set operation, and a schema field
 * whose name is also the name of an expression's internal metadata.
 *
 * The rule each case applies is the one every read path shares: a position is
 * decoded only when every typing that can produce its value agrees it is a
 * date, and every other position reads exactly as stored.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../../src";
import { type IntegrationTestContext } from "./test-context";

const ROOT_AT = new Date("2024-01-02T03:04:05.678Z");
const CHILD_TEXT = "2024-02-03T04:05:06.789Z";
const TEXT = "2024-03-04T05:06:07.890Z";
const DIRECT = new Date("2024-04-05T06:07:08.901Z");

/** A getter-recursive object with no date anywhere. */
const PlainTree = z.object({
  label: z.string(),
  get children() {
    return z.array(PlainTree).optional();
  },
});

/**
 * A getter-recursive object holding a date. The root's `at` is a date; the
 * `at` of a child is reached again through the cycle, and a position reached
 * through a cycle reads as stored text.
 */
const DatedTree = z.object({
  label: z.string(),
  at: z.date(),
  get children() {
    return z.array(DatedTree).optional();
  },
});

const PlainTreeNode = defineNode("PlainTreeNode", { schema: PlainTree });
const DatedTreeNode = defineNode("DatedTreeNode", { schema: DatedTree });

/** A union whose branches agree on everything but whether `at` is a date. */
const datedFirst = z.union([
  z.array(z.object({ at: z.date() })),
  z.array(z.object({ at: z.string() })),
]);
const textFirst = z.union([
  z.array(z.object({ at: z.string() })),
  z.array(z.object({ at: z.date() })),
]);
const datedRecordFirst = z.union([
  z.record(z.string(), z.object({ at: z.date() })),
  z.record(z.string(), z.object({ at: z.string() })),
]);
const textRecordFirst = z.union([
  z.record(z.string(), z.object({ at: z.string() })),
  z.record(z.string(), z.object({ at: z.date() })),
]);

const StructuredUnion = defineNode("StructuredUnion", {
  schema: z.object({
    label: z.string(),
    datedFirst,
    textFirst,
    datedRecordFirst,
    textRecordFirst,
    agreed: z.union([
      z.array(z.object({ at: z.date(), note: z.string() })),
      z.array(z.object({ at: z.date() })),
    ]),
  }),
});

/** Two kinds whose `times` share a column type but not a date typing. */
const DirectTimes = defineNode("DirectTimes", {
  schema: z.object({ label: z.string(), times: z.array(z.date()) }),
});
const TransformedTimes = defineNode("TransformedTimes", {
  schema: z.object({
    label: z.string(),
    times: z.array(z.string().transform((text) => new Date(text))),
  }),
});

/** Nested schema fields named after an expression's date metadata. */
const MetadataNamed = defineNode("MetadataNamed", {
  schema: z.object({
    label: z.string(),
    info: z.object({
      readPlan: z.string(),
      dateOrigin: z.string(),
      elementDateOrigins: z.string(),
    }),
  }),
});

const DATED_TREE_GRAPH = defineGraph({
  id: "date_read_positions_tree",
  nodes: { DatedTreeNode: { type: DatedTreeNode } },
  edges: {},
});

const graph = defineGraph({
  id: "date_read_positions",
  nodes: {
    StructuredUnion: { type: StructuredUnion },
    DirectTimes: { type: DirectTimes },
    TransformedTimes: { type: TransformedTimes },
    MetadataNamed: { type: MetadataNamed },
  },
  edges: {},
});

const UNDATED_GRAPH = defineGraph({
  id: "date_read_positions_undated",
  nodes: { PlainTreeNode: { type: PlainTreeNode } },
  edges: {},
});

function byLabel(
  rows: readonly Readonly<{ label: string; times: unknown }>[],
): readonly Readonly<{ label: string; times: unknown }>[] {
  return rows.toSorted((left, right) => left.label.localeCompare(right.label));
}

function propsOf(entity: unknown): Record<string, unknown> {
  const {
    id: _id,
    kind: _kind,
    meta: _meta,
    ...props
  } = entity as Record<string, unknown>;
  return props;
}

export function registerDateReadPositionIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("date read positions of recursive, union, set-operation and metadata-named schemas", () => {
    it("a store over a recursive schema without a date starts, writes and reads", async () => {
      const store = await context.createStore(UNDATED_GRAPH);
      const input = {
        label: "root",
        children: [{ label: "child", children: [{ label: "grandchild" }] }],
      };
      const created = await store.nodes.PlainTreeNode.create(input);
      expect(propsOf(created)).toEqual(input);
      const [projected] = await store
        .query()
        .from("PlainTreeNode", "t")
        .project((fields) => ({ children: fields.t.children }))
        .execute();
      expect(projected).toEqual({ children: input.children });
    });

    it("a recursive schema with a date decodes the root and reads a position reached through the cycle as text", async () => {
      const store = await context.createStore(DATED_TREE_GRAPH);
      const created = await store.nodes.DatedTreeNode.create({
        label: "root",
        at: ROOT_AT,
        children: [{ label: "child", at: new Date(CHILD_TEXT) }],
      });
      const expected = {
        label: "root",
        at: ROOT_AT,
        children: [{ label: "child", at: CHILD_TEXT }],
      };
      expect(propsOf(created)).toEqual(expected);
      expect(
        propsOf(await store.nodes.DatedTreeNode.getById(created.id)),
      ).toEqual(expected);
      const [projected] = await store
        .query()
        .from("DatedTreeNode", "t")
        .project((fields) => ({
          at: fields.t.at,
          children: fields.t.children,
        }))
        .execute();
      expect(projected).toEqual({
        at: ROOT_AT,
        children: expected.children,
      });
    });

    it("a union of structured branches decodes a position only when every branch types it a date, in either branch order", async () => {
      const store = await context.createStore(graph);
      const created = await store.nodes.StructuredUnion.create({
        label: "union",
        datedFirst: [{ at: TEXT }],
        textFirst: [{ at: TEXT }],
        datedRecordFirst: { first: { at: TEXT } },
        textRecordFirst: { first: { at: TEXT } },
        agreed: [{ at: DIRECT }],
      });
      const expected = {
        label: "union",
        datedFirst: [{ at: TEXT }],
        textFirst: [{ at: TEXT }],
        datedRecordFirst: { first: { at: TEXT } },
        textRecordFirst: { first: { at: TEXT } },
        agreed: [{ at: DIRECT }],
      };
      expect(propsOf(created)).toEqual(expected);
      expect(
        propsOf(await store.nodes.StructuredUnion.getById(created.id)),
      ).toEqual(expected);
      const [projected] = await store
        .query()
        .from("StructuredUnion", "u")
        .project((fields) => ({
          datedFirst: fields.u.datedFirst,
          textFirst: fields.u.textFirst,
          agreed: fields.u.agreed,
        }))
        .execute();
      expect(projected).toEqual({
        datedFirst: expected.datedFirst,
        textFirst: expected.textFirst,
        agreed: expected.agreed,
      });
    });

    it("a set operation decodes only the date positions both operands share, in either operand order", async () => {
      const store = await context.createStore(graph);
      await store.nodes.DirectTimes.create({
        label: "direct",
        times: [DIRECT],
      });
      await store.nodes.TransformedTimes.create({
        label: "transformed",
        times: [TEXT],
      });
      const direct = store
        .query()
        .from("DirectTimes", "d")
        .project((fields) => ({
          label: fields.d.label,
          times: fields.d.times,
        }))
        .asRelation();
      const transformed = store
        .query()
        .from("TransformedTimes", "t")
        .project((fields) => ({
          label: fields.t.label,
          times: fields.t.times,
        }))
        .asRelation();
      // One operand types `times` as dates, the other as text a transform
      // reads: the column decodes under neither, so both rows read as stored.
      const expected = [
        { label: "direct", times: [DIRECT.toISOString()] },
        { label: "transformed", times: [TEXT] },
      ];
      expect(byLabel(await direct.unionAll(transformed).execute())).toEqual(
        expected,
      );
      expect(byLabel(await transformed.unionAll(direct).execute())).toEqual(
        expected,
      );
      // Operands that agree keep the decode.
      expect(await direct.unionAll(direct).execute()).toEqual([
        { label: "direct", times: [DIRECT] },
        { label: "direct", times: [DIRECT] },
      ]);
    });

    it("schema fields named after an expression's date metadata are fields", async () => {
      const store = await context.createStore(graph);
      const info = {
        readPlan: "plan text",
        dateOrigin: "origin text",
        elementDateOrigins: "origins text",
      };
      await store.nodes.MetadataNamed.create({ label: "named", info });
      const [projected] = await store
        .query()
        .from("MetadataNamed", "m")
        .project((fields) => ({
          readPlan: fields.m.info.readPlan,
          dateOrigin: fields.m.info.dateOrigin,
          elementDateOrigins: fields.m.info.elementDateOrigins,
        }))
        .execute()
        .catch((error: unknown) => [
          { error: error instanceof Error ? error.message : String(error) },
        ]);
      expect(projected).toEqual(info);
    });
  });
}
