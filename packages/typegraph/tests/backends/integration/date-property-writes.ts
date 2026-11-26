/**
 * A `Date` reaches storage the same way through every write, and the stored
 * text comes back in through `importGraph`.
 *
 * The store persists a `z.date()` property's `Date` as its ISO text. The
 * single-row writes hand the parsed props to `JSON.stringify`, which encodes
 * the `Date` implicitly; `updateWhere` / `compareAndSet` hand the backend a
 * JSON patch, so they refused a `Date` in the patch as a non-JSON value
 * (with an error text about annotations), and a `compareAndSet` expectation
 * could not state a `Date` at all. `exportGraph` writes that stored text, and
 * `importGraph` parsed it as create input, so `z.date()` refused every row of
 * a kind with a date property and the round trip lost them.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../../src";
import {
  exportGraph,
  type GraphData,
  importGraph,
  type ImportOptions,
} from "../../../src/interchange";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const PUBLISHED = new Date("2024-01-02T03:04:05.678Z");
const REVIEWED = new Date("2024-02-03T04:05:06.789Z");
const REVISED = new Date("2024-03-04T05:06:07.890Z");
const LATER = new Date("2025-06-01T00:00:00.000Z");

const DATED_DOC_PUBLISHED = "dated_write_doc_published";

const DatedWriteDocument = defineNode("DatedWriteDoc", {
  schema: z.object({
    title: z.string(),
    publishedAt: z.date(),
    reviewedAt: z.date().optional(),
    review: z.object({ at: z.date(), by: z.string() }).optional(),
    revisions: z.array(z.date()).optional(),
    extra: z.any().optional(),
  }),
});

const datedWriteCites = defineEdge("datedWriteCites", {
  schema: z.object({ at: z.date(), seenAt: z.date().optional() }),
});

function buildDatedGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      DatedWriteDoc: {
        type: DatedWriteDocument,
        unique: [
          {
            name: DATED_DOC_PUBLISHED,
            fields: ["publishedAt"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
    },
    edges: {
      datedWriteCites: {
        type: datedWriteCites,
        from: [DatedWriteDocument],
        to: [DatedWriteDocument],
      },
    },
  });
}

const sourceGraph = buildDatedGraph("date_property_writes");

function fullDocument(title: string, publishedAt: Date) {
  return {
    title,
    publishedAt,
    reviewedAt: REVIEWED,
    review: { at: REVIEWED, by: "editor" },
    revisions: [PUBLISHED, REVISED],
  };
}

/** What a read returns for the date properties: the stored ISO text. */
function documentDates(node: Readonly<Record<string, unknown>> | undefined) {
  const read = requireDefined(node);
  return {
    publishedAt: read["publishedAt"],
    reviewedAt: read["reviewedAt"],
    review: read["review"],
    revisions: read["revisions"],
  };
}

/** The stored text a patch of {@link LATER} everywhere writes. */
const STORED_LATER_DATES = {
  publishedAt: LATER.toISOString(),
  reviewedAt: LATER.toISOString(),
  review: { at: LATER.toISOString(), by: "editor" },
  revisions: [LATER.toISOString(), PUBLISHED.toISOString()],
} as const;

const LATER_PATCH = {
  publishedAt: LATER,
  reviewedAt: LATER,
  review: { at: LATER, by: "editor" },
  revisions: [LATER, PUBLISHED],
};

/** A source store holding two dated documents and one dated edge. */
async function seedSource(context: IntegrationTestContext) {
  const source = await context.createStore(sourceGraph);
  const first = await source.nodes.DatedWriteDoc.create(
    fullDocument("a", PUBLISHED),
  );
  const second = await source.nodes.DatedWriteDoc.create({
    title: "b",
    publishedAt: REVISED,
  });
  await source.edges.datedWriteCites.create(first, second, {
    at: PUBLISHED,
    seenAt: REVIEWED,
  });
  return source;
}

/** `document` with an undeclared property on every node. */
function withUnknownProperty(document: GraphData): GraphData {
  return {
    ...document,
    nodes: document.nodes.map((node) => ({
      ...node,
      properties: { ...node.properties, legacyNote: "kept" },
    })),
  };
}

export function registerDatePropertyWriteIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a Date in a set-update patch or compareAndSet expectation", () => {
    it("updateWhere stores a patched Date as the text update() stores", async () => {
      const store = await context.createStore(sourceGraph);
      const viaSet = await store.nodes.DatedWriteDoc.create(
        fullDocument("set", PUBLISHED),
      );
      const viaUpdate = await store.nodes.DatedWriteDoc.create(
        fullDocument("single", REVISED),
      );
      const result = await store.nodes.DatedWriteDoc.updateWhere({
        where: (node) => node.id.eq(viaSet.id),
        patch: LATER_PATCH,
      });
      expect(result.affectedCount).toBe(1);
      // The single-row update is the reference encoding. It cannot share the
      // unique `publishedAt`, so it compares the other three.
      const updated = await store.nodes.DatedWriteDoc.update(viaUpdate.id, {
        reviewedAt: LATER,
        review: { at: LATER, by: "editor" },
        revisions: [LATER, PUBLISHED],
      });
      const setRead = await store.nodes.DatedWriteDoc.getById(viaSet.id);
      expect(documentDates(setRead)).toEqual(STORED_LATER_DATES);
      expect({ ...documentDates(updated), publishedAt: undefined }).toEqual({
        ...STORED_LATER_DATES,
        publishedAt: undefined,
      });
      // The rebuilt claim is keyed by the patched date, as a create keys it.
      await expect(
        store.nodes.DatedWriteDoc.create(fullDocument("dup", LATER)),
      ).rejects.toThrow(/unique/iu);
      await expect(
        store.nodes.DatedWriteDoc.create(fullDocument("free", PUBLISHED)),
      ).resolves.toBeDefined();
    });

    it("compareAndSet stores a patched Date and compares an expected Date", async () => {
      const store = await context.createStore(sourceGraph);
      const document = await store.nodes.DatedWriteDoc.create(
        fullDocument("a", PUBLISHED),
      );
      const patched = await store.nodes.DatedWriteDoc.compareAndSet(
        document.id,
        { expected: { title: "a" }, patch: LATER_PATCH },
      );
      expect(patched).toBe(true);
      expect(
        documentDates(await store.nodes.DatedWriteDoc.getById(document.id)),
      ).toEqual(STORED_LATER_DATES);

      const stale = await store.nodes.DatedWriteDoc.compareAndSet(document.id, {
        expected: { publishedAt: PUBLISHED },
        patch: { title: "stale" },
      });
      expect(stale).toBe(false);
      const guarded = await store.nodes.DatedWriteDoc.compareAndSet(
        document.id,
        {
          expected: { publishedAt: LATER, reviewedAt: LATER },
          patch: { title: "guarded" },
        },
      );
      expect(guarded).toBe(true);
      const read = await store.nodes.DatedWriteDoc.getById(document.id);
      expect(read?.title).toBe("guarded");
      expect(documentDates(read)).toEqual(STORED_LATER_DATES);
    });

    it("still refuses date text a caller states, in the patch and the expectation", async () => {
      const store = await context.createStore(sourceGraph);
      const document = await store.nodes.DatedWriteDoc.create(
        fullDocument("a", PUBLISHED),
      );
      const text = LATER.toISOString() as unknown as Date;
      await expect(
        store.nodes.DatedWriteDoc.updateWhere({
          where: (node) => node.id.eq(document.id),
          patch: { publishedAt: text },
        }),
      ).rejects.toThrow(/expected date, received string/u);
      await expect(
        store.nodes.DatedWriteDoc.compareAndSet(document.id, {
          expected: { publishedAt: text },
          patch: { title: "b" },
        }),
      ).rejects.toThrow(/expected date, received string/u);
    });

    it("refuses a non-JSON patch value without calling it an annotation", async () => {
      const store = await context.createStore(sourceGraph);
      const document = await store.nodes.DatedWriteDoc.create(
        fullDocument("a", PUBLISHED),
      );
      const refusal = store.nodes.DatedWriteDoc.updateWhere({
        where: (node) => node.id.eq(document.id),
        patch: { extra: new Map([["k", 1]]) },
      });
      await expect(refusal).rejects.toThrow(
        /updateWhere patch extra contains a non-JSON value \(Map instance\)/u,
      );
      await expect(refusal).rejects.not.toThrow(/annotation/iu);
    });
  });

  describe("importGraph accepts the stored dates exportGraph writes", () => {
    // `error` parses a document whose properties are all declared; `strip`
    // and `allow` only take their own branch for a document that carries an
    // undeclared one, which `allow` keeps and `strip` drops.
    it.each([
      ["error", "date_property_import_error"],
      ["strip", "date_property_import_strip"],
      ["allow", "date_property_import_allow"],
    ] as const)(
      "round trips every date shape under onUnknownProperty: %s",
      async (onUnknownProperty, targetId) => {
        const source = await seedSource(context);
        const exported = await exportGraph(source);
        const document =
          onUnknownProperty === "error" ? exported : (
            withUnknownProperty(exported)
          );
        const target = await context.createStore(buildDatedGraph(targetId));
        const options: ImportOptions = {
          onConflict: "error",
          onUnknownProperty,
        };
        const result = await importGraph(target, document, options);
        expect(result.errors).toEqual([]);
        expect(result.success).toBe(true);
        expect(result.nodes.created).toBe(2);
        expect(result.edges.created).toBe(1);

        const restored = await exportGraph(target);
        expect(restored.nodes).toEqual(
          onUnknownProperty === "allow" ? document.nodes : exported.nodes,
        );
        expect(restored.edges).toEqual(exported.edges);
        // Imported claims are keyed by the date, as the store's own writes key
        // them: a create of an imported date collides, another date does not.
        await expect(
          target.nodes.DatedWriteDoc.create(fullDocument("dup", PUBLISHED)),
        ).rejects.toThrow(/unique/iu);
        await expect(
          target.nodes.DatedWriteDoc.create(fullDocument("new", LATER)),
        ).resolves.toBeDefined();
      },
    );

    it("still refuses date text that is not the canonical stored form", async () => {
      const source = await seedSource(context);
      const document = await exportGraph(source);
      const target = await context.createStore(
        buildDatedGraph("date_property_import_refusal"),
      );
      const [first, second] = document.nodes;
      const result = await importGraph(
        target,
        {
          ...document,
          nodes: [
            {
              ...requireDefined(first),
              properties: {
                ...requireDefined(first).properties,
                legacyNote: "kept",
                publishedAt: "2024-01-02T03:04:05Z",
              },
            },
            {
              ...requireDefined(second),
              properties: {
                ...requireDefined(second).properties,
                legacyNote: "kept",
                publishedAt: "0000-01-01T00:00:00.000Z",
              },
            },
          ],
          edges: [],
        },
        { onConflict: "error", onUnknownProperty: "allow" },
      );
      expect(result.success).toBe(false);
      expect(result.nodes.created).toBe(0);
      expect(result.errors.map((error) => error.error)).toEqual([
        expect.stringMatching(/publishedAt: .*expected date, received string/u),
        expect.stringMatching(/publishedAt: .*expected date, received string/u),
      ]);
    });
  });
}
