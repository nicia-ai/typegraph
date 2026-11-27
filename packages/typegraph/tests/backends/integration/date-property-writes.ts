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

import { asNodeId, defineEdge, defineGraph, defineNode } from "../../../src";
import { defineNodeIndex } from "../../../src/indexes";
import {
  exportGraph,
  type GraphData,
  importGraph,
  type ImportOptions,
  trustedImportGraph,
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

/** An index over the untyped `extra` property, which a probe may state as a `Date`. */
const datedWriteExtraIndex = defineNodeIndex(DatedWriteDocument, {
  name: "dated_write_doc_extra",
  fields: ["extra"],
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
    indexes: [datedWriteExtraIndex],
  });
}

/** The dated graph without its uniqueness constraint, which trusted import refuses. */
function buildNonUniqueDatedGraph(id: string) {
  return defineGraph({
    id,
    nodes: { DatedWriteDoc: { type: DatedWriteDocument } },
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

/** A date the schema also accepts as a string: its stored text reads back as one. */
const UnionDateDocument = defineNode("UnionDateDoc", {
  schema: z.object({
    title: z.string(),
    at: z.union([z.date(), z.string()]),
  }),
});

const DAY_MS = 86_400_000;

/** A date whose OPTIONAL wrapper rewrites it on every parse. */
const ShiftedDateDocument = defineNode("ShiftedDateDoc", {
  schema: z.object({
    title: z.string(),
    at: z
      .date()
      .optional()
      .overwrite((date) =>
        date === undefined ? date : new Date(date.getTime() + DAY_MS),
      ),
  }),
});

const NOON = new Date("2024-01-02T12:00:00.000Z");
const MIDNIGHT = new Date("2024-01-02T00:00:00.000Z");

/** A date its OPTIONAL wrapper normalizes to the start of its UTC day. */
const MidnightDateDocument = defineNode("MidnightDateDoc", {
  schema: z.object({
    title: z.string(),
    at: z
      .date()
      .optional()
      .overwrite((date) =>
        date === undefined ? date : (
          new Date(
            Date.UTC(
              date.getUTCFullYear(),
              date.getUTCMonth(),
              date.getUTCDate(),
            ),
          )
        ),
      ),
  }),
});

function buildEdgeCaseGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      UnionDateDoc: {
        type: UnionDateDocument,
        unique: [
          {
            name: "union_date_doc_at",
            fields: ["at"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      ShiftedDateDoc: { type: ShiftedDateDocument },
      MidnightDateDoc: { type: MidnightDateDocument },
    },
    edges: {},
  });
}

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

/**
 * A `Date` holding `instant` whose own `toJSON` and `toISOString` both answer
 * `claimed`'s text: what a caller's object or a polyfill can do. The store
 * writes and compares the instant a `Date` holds, never what its serializer
 * says.
 */
function disguisedDate(instant: Date, claimed: Date): Date {
  const disguised = new Date(instant);
  const text = claimed.toISOString();
  Object.defineProperty(disguised, "toJSON", { value: () => text });
  Object.defineProperty(disguised, "toISOString", { value: () => text });
  return disguised;
}

/** A `Date` subclass whose serializers answer `claimed`'s text. */
function disguisedSubclassDate(instant: Date, claimed: Date): Date {
  const text = claimed.toISOString();
  class ClaimingDate extends Date {
    override toISOString(): string {
      return text;
    }
    override toJSON(): string {
      return text;
    }
  }
  return new ClaimingDate(instant.getTime());
}

export function registerDatePropertyWriteIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe.each([
    ["an own toJSON and toISOString", disguisedDate],
    ["a subclass", disguisedSubclassDate],
  ] as const)(
    "a Date whose serializer disagrees with its instant (%s)",
    (_label, disguise) => {
      // Holds PUBLISHED, says LATER.
      const disguised = () => disguise(PUBLISHED, LATER);
      const stored = PUBLISHED.toISOString();

      it("every node and edge write stores the instant the Date holds", async () => {
        const store = await context.createStore(sourceGraph);
        const created = await store.nodes.DatedWriteDoc.create({
          title: "create",
          publishedAt: disguised(),
          revisions: [disguised()],
          review: { at: disguised(), by: "editor" },
        });
        expect([
          created.publishedAt,
          created.revisions,
          created.review,
        ]).toEqual([stored, [stored], { at: stored, by: "editor" }]);

        const target = await store.nodes.DatedWriteDoc.create({
          title: "target",
          publishedAt: REVISED,
        });
        const updated = await store.nodes.DatedWriteDoc.update(target.id, {
          reviewedAt: disguised(),
        });
        const upserted = await store.nodes.DatedWriteDoc.upsertById(
          "date_disguised_upsert",
          { title: "upsert", publishedAt: REVIEWED, reviewedAt: disguised() },
        );
        const [bulk] = await store.nodes.DatedWriteDoc.bulkCreate([
          {
            props: {
              title: "bulk",
              publishedAt: new Date("2023-01-01T00:00:00.000Z"),
              reviewedAt: disguised(),
            },
          },
        ]);
        await store.nodes.DatedWriteDoc.bulkUpsertById([
          {
            id: "date_disguised_bulk_upsert",
            props: {
              title: "bulk-upsert",
              publishedAt: LATER,
              reviewedAt: disguised(),
            },
          },
        ]);
        const bulkUpserted = await store.nodes.DatedWriteDoc.getById(
          asNodeId("date_disguised_bulk_upsert"),
        );
        expect([
          updated.reviewedAt,
          upserted.reviewedAt,
          requireDefined(bulk).reviewedAt,
          bulkUpserted?.reviewedAt,
        ]).toEqual([stored, stored, stored, stored]);

        const edge = await store.edges.datedWriteCites.create(created, target, {
          at: disguised(),
        });
        const edgeUpdated = await store.edges.datedWriteCites.update(edge.id, {
          seenAt: disguised(),
        });
        expect([edge.at, edgeUpdated.seenAt]).toEqual([stored, stored]);
      });

      it("a set update stores, and compareAndSet compares, the instant the Date holds", async () => {
        const store = await context.createStore(sourceGraph);
        const document = await store.nodes.DatedWriteDoc.create({
          title: "a",
          publishedAt: LATER,
          reviewedAt: REVIEWED,
        });
        // The row holds LATER; the expectation holds PUBLISHED and says LATER.
        const matched = await store.nodes.DatedWriteDoc.compareAndSet(
          document.id,
          { expected: { publishedAt: disguised() }, patch: { title: "wrong" } },
        );
        expect(matched).toBe(false);
        await store.nodes.DatedWriteDoc.updateWhere({
          where: (node) => node.id.eq(document.id),
          patch: { reviewedAt: disguised() },
        });
        const read = await store.nodes.DatedWriteDoc.getById(document.id);
        expect([read?.title, read?.reviewedAt]).toEqual(["a", stored]);
      });

      it("importGraph and trustedImportGraph store the instant an in-memory document's Date holds", async () => {
        const source = await seedSource(context);
        const exported = await exportGraph(source);
        const document: GraphData = {
          ...exported,
          nodes: exported.nodes.map((node) => ({
            ...node,
            properties: {
              ...node.properties,
              reviewedAt: disguised(),
              revisions: [disguised()],
            },
          })),
          edges: exported.edges.map((edge) => ({
            ...edge,
            properties: { ...edge.properties, seenAt: disguised() },
          })),
        };
        const expectedNodes = exported.nodes.map((node) => ({
          ...node,
          properties: {
            ...node.properties,
            reviewedAt: stored,
            revisions: [stored],
          },
        }));
        const expectedEdges = exported.edges.map((edge) => ({
          ...edge,
          properties: { ...edge.properties, seenAt: stored },
        }));
        for (const onUnknownProperty of ["error", "allow"] as const) {
          const target = await context.createStore(
            buildDatedGraph(`date_disguised_import_${onUnknownProperty}`),
          );
          const result = await importGraph(target, document, {
            onConflict: "error",
            onUnknownProperty,
          });
          expect(result.errors).toEqual([]);
          const restored = await exportGraph(target);
          expect([restored.nodes, restored.edges]).toEqual([
            expectedNodes,
            expectedEdges,
          ]);
        }
      });

      it("trustedImportGraph stores the instant an in-memory document's Date holds", async () => {
        // Trusted import needs empty tables and no uniqueness constraint, so
        // the document is built here rather than exported from a seeded store.
        const trusted = await context.createStore(
          buildNonUniqueDatedGraph("date_disguised_trusted_import"),
        );
        if (trusted.backend.trustedImport === undefined) return;
        const header = await exportGraph(trusted);
        const nodeProperties = { title: "a", publishedAt: REVISED };
        const document: GraphData = {
          ...header,
          nodes: ["a", "b"].map((id) => ({
            kind: "DatedWriteDoc",
            id,
            properties: { ...nodeProperties, revisions: [disguised()] },
          })),
          edges: [
            {
              kind: "datedWriteCites",
              id: "cites",
              from: { kind: "DatedWriteDoc", id: "a" },
              to: { kind: "DatedWriteDoc", id: "b" },
              properties: { at: disguised() },
            },
          ],
        };
        await trustedImportGraph(trusted, document);
        const restored = await exportGraph(trusted);
        expect([
          restored.nodes.map((node) => node.properties["revisions"]),
          restored.edges.map((edge) => edge.properties["at"]),
        ]).toEqual([[[stored], [stored]], [stored]]);
      });

      it("an endpoint match compares the instant the Date holds", async () => {
        const store = await context.createStore(sourceGraph);
        const from = await store.nodes.DatedWriteDoc.create({
          title: "from",
          publishedAt: PUBLISHED,
        });
        const to = await store.nodes.DatedWriteDoc.create({
          title: "to",
          publishedAt: LATER,
        });
        const existing = await store.edges.datedWriteCites.create(from, to, {
          at: PUBLISHED,
        });
        await store.edges.datedWriteCites.create(from, to, { at: LATER });
        const matched =
          await store.edges.datedWriteCites.getOrCreateByEndpoints(
            from,
            to,
            { at: disguised() },
            { matchOn: ["at"] },
          );
        expect([matched.action, matched.edge.id]).toEqual([
          "found",
          existing.id,
        ]);
      });

      it("an index probe looks up the instant the Date holds", async () => {
        const store = await context.createStore(sourceGraph);
        await store.nodes.DatedWriteDoc.create({
          title: "published",
          publishedAt: PUBLISHED,
          extra: PUBLISHED,
        });
        await store.nodes.DatedWriteDoc.create({
          title: "later",
          publishedAt: LATER,
          extra: LATER,
        });
        const [candidates] = await store.nodes.DatedWriteDoc.bulkFindByIndex(
          "dated_write_doc_extra",
          [{ props: { extra: disguised() } }],
        );
        expect((candidates ?? []).map((node) => node.title)).toEqual([
          "published",
        ]);
      });

      it("a predicate compares the instant the Date holds", async () => {
        const store = await context.createStore(sourceGraph);
        await store.nodes.DatedWriteDoc.create({
          title: "published",
          publishedAt: PUBLISHED,
        });
        await store.nodes.DatedWriteDoc.create({
          title: "later",
          publishedAt: LATER,
        });
        const titles = await store
          .query()
          .from("DatedWriteDoc", "d")
          .whereNode("d", (d) => d.publishedAt.eq(disguised()))
          .select((ctx) => ctx.d.title)
          .execute();
        expect(titles).toEqual(["published"]);
      });
    },
  );

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

    it("compareAndSet compares the instant the caller states, not what the schema makes of it", async () => {
      const store = await context.createStore(
        buildEdgeCaseGraph("date_property_expectation_instant"),
      );
      const document = await store.nodes.MidnightDateDoc.create({
        title: "a",
        at: NOON,
      });
      expect(document.at).toBe(MIDNIGHT.toISOString());
      // The row holds midnight. An expectation of noon names a different
      // instant, whatever the schema would make of noon on a write.
      const atNoon = await store.nodes.MidnightDateDoc.compareAndSet(
        document.id,
        { expected: { at: NOON }, patch: { title: "noon" } },
      );
      expect(atNoon).toBe(false);
      const unchanged = await store.nodes.MidnightDateDoc.getById(document.id);
      expect(unchanged?.title).toBe("a");
      const atMidnight = await store.nodes.MidnightDateDoc.compareAndSet(
        document.id,
        { expected: { at: MIDNIGHT }, patch: { title: "midnight" } },
      );
      expect(atMidnight).toBe(true);
      const read = await store.nodes.MidnightDateDoc.getById(document.id);
      expect([read?.title, read?.at]).toEqual([
        "midnight",
        MIDNIGHT.toISOString(),
      ]);
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

  describe("a stored date the schema would not read back as the same Date", () => {
    it("a set update refuses a Date under a union, writing nothing", async () => {
      const store = await context.createStore(
        buildEdgeCaseGraph("date_property_union"),
      );
      const first = await store.nodes.UnionDateDoc.create({
        title: "a",
        at: PUBLISHED,
      });
      const second = await store.nodes.UnionDateDoc.create({
        title: "b",
        at: REVISED,
      });
      // Stored as text, the patched Date would read back as the string branch
      // and claim a key that differs from the first row's Date key, so both
      // rows would hold the same instant under a unique constraint.
      await expect(
        store.nodes.UnionDateDoc.updateWhere({
          where: (node) => node.id.eq(second.id),
          patch: { at: PUBLISHED },
        }),
      ).rejects.toThrow(
        /Set update property "at" holds a Date at at that its schema does not read back as a Date/u,
      );
      await expect(
        store.nodes.UnionDateDoc.compareAndSet(second.id, {
          expected: { at: REVISED },
          patch: { title: "b2" },
        }),
      ).rejects.toThrow(/does not read back as a Date/u);
      const rows = await store.nodes.UnionDateDoc.find();
      expect(rows.map((row) => [row.id, row.title, row.at]).toSorted()).toEqual(
        [
          [first.id, "a", PUBLISHED.toISOString()],
          [second.id, "b", REVISED.toISOString()],
        ].toSorted(),
      );
    });

    it("an update of another property and an import keep a date whose wrapper rewrites it", async () => {
      const source = await context.createStore(
        buildEdgeCaseGraph("date_property_shifted_source"),
      );
      const document = await source.nodes.ShiftedDateDoc.create({
        title: "a",
        at: PUBLISHED,
      });
      const stored = new Date(PUBLISHED.getTime() + DAY_MS).toISOString();
      expect(document.at).toBe(stored);
      const exported = await exportGraph(source);

      // The update re-validates the whole row, but stores the untouched date
      // as it was stored: the wrapper's `.overwrite()` does not shift it
      // again (main shifted it on every update).
      const updated = await source.nodes.ShiftedDateDoc.update(document.id, {
        title: "a2",
      });
      expect({
        title: updated.title,
        at: updated.at as unknown as string,
      }).toEqual({ title: "a2", at: stored });

      // Import writes the document's stored row as stored: the same
      // `.overwrite()` does not shift the exported date. Main refused the
      // row instead (every exported date was refused).
      const target = await context.createStore(
        buildEdgeCaseGraph("date_property_shifted_target"),
      );
      const result = await importGraph(target, exported, {
        onConflict: "error",
        onUnknownProperty: "error",
      });
      const [imported] = await target.nodes.ShiftedDateDoc.find();
      expect({
        errors: result.errors.length,
        at: imported?.at as unknown as string | undefined,
      }).toEqual({ errors: 0, at: stored });
    });
  });
}
