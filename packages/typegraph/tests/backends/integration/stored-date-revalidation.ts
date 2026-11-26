/**
 * A write that re-validates a stored row accepts the row's stored dates (#851).
 *
 * The store writes a `z.date()` property's `Date` as its ISO text and reads
 * that text back. Every update merges its patch over the stored props and
 * parses the result through the kind's schema, so an update that never
 * touched the date property handed `z.date()` a string and failed
 * validation; `updateWhere` / `compareAndSet` failed the same way on their
 * after-images, and `validateStore` reported every stored date as a
 * violation. Each case here writes a kind with date properties, runs one
 * write path that leaves them untouched, and asserts that the write succeeds,
 * that the stored text is byte-identical afterwards, and that a read still
 * returns the stored text (reads are unchanged by the fix).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const PUBLISHED = new Date("2024-01-02T03:04:05.678Z");
const REVIEWED = new Date("2024-02-03T04:05:06.789Z");
const REVISED = new Date("2024-03-04T05:06:07.890Z");
const FALLBACK = new Date("1970-01-01T00:00:00.000Z");
const LATER = "2099-01-01T00:00:00.000Z";

const DATED_DOC_TITLE = "dated_doc_title";

const DatedDocument = defineNode("DatedDoc", {
  schema: z.object({
    title: z.string(),
    publishedAt: z.date(),
    reviewedAt: z.date().optional(),
    archivedAt: z.date().nullable().default(FALLBACK),
    // A `.catch()` replaced a refused stored date with its fallback silently.
    checkedAt: z.date().optional().catch(FALLBACK),
    review: z.object({ at: z.date(), by: z.string() }).optional(),
    revisions: z.array(z.date()).optional(),
  }),
});

/** Only a caught date: the refused stored text was replaced, not refused. */
const CaughtDocument = defineNode("CaughtDoc", {
  schema: z.object({
    title: z.string(),
    checkedAt: z.date().optional().catch(FALLBACK),
  }),
});

/** A date whose schema rewrites it on every parse. */
const StampedDocument = defineNode("StampedDoc", {
  schema: z.object({
    title: z.string(),
    stampedAt: z.date().overwrite((date) => new Date(date.getTime() + 1)),
  }),
});

const datedCites = defineEdge("datedCites", {
  schema: z.object({
    note: z.string(),
    at: z.date(),
    seenAt: z.date().optional(),
  }),
});

const datedGraph = defineGraph({
  id: "stored_date_revalidation",
  nodes: {
    CaughtDoc: { type: CaughtDocument },
    StampedDoc: { type: StampedDocument },
    DatedDoc: {
      type: DatedDocument,
      unique: [
        {
          name: DATED_DOC_TITLE,
          fields: ["title"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    datedCites: {
      type: datedCites,
      from: [DatedDocument],
      to: [DatedDocument],
    },
  },
});

/** The stored text of every date property `fullDoc` writes. */
const STORED_DOC_DATES = {
  publishedAt: PUBLISHED.toISOString(),
  reviewedAt: REVIEWED.toISOString(),
  archivedAt: REVISED.toISOString(),
  checkedAt: REVIEWED.toISOString(),
  review: { at: REVIEWED.toISOString(), by: "editor" },
  revisions: [PUBLISHED.toISOString(), REVISED.toISOString()],
} as const;

function fullDocument(title: string) {
  return {
    title,
    publishedAt: PUBLISHED,
    reviewedAt: REVIEWED,
    archivedAt: REVISED,
    checkedAt: REVIEWED,
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
    archivedAt: read["archivedAt"],
    checkedAt: read["checkedAt"],
    review: read["review"],
    revisions: read["revisions"],
  };
}

const STORED_EDGE_DATES = {
  at: PUBLISHED.toISOString(),
  seenAt: REVIEWED.toISOString(),
} as const;

function edgeDates(edge: Readonly<Record<string, unknown>> | undefined) {
  const read = requireDefined(edge);
  return { at: read["at"], seenAt: read["seenAt"] };
}

/** A store holding two dated documents and one dated edge between them. */
async function seed(context: IntegrationTestContext) {
  const store = await context.createStore(datedGraph);
  const document = await store.nodes.DatedDoc.create(fullDocument("a"));
  const other = await store.nodes.DatedDoc.create(fullDocument("b"));
  const edge = await store.edges.datedCites.create(document, other, {
    note: "n",
    at: PUBLISHED,
    seenAt: REVIEWED,
  });
  return { store, doc: document, other, edge };
}

export function registerStoredDateRevalidationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a write that re-validates a stored row keeps its untouched dates (#851)", () => {
    it("node update", async () => {
      const { store, doc } = await seed(context);
      const updated = await store.nodes.DatedDoc.update(doc.id, {
        title: "a2",
      });
      expect(updated.title).toBe("a2");
      expect(documentDates(updated)).toEqual(STORED_DOC_DATES);
      expect(documentDates(await store.nodes.DatedDoc.getById(doc.id))).toEqual(
        STORED_DOC_DATES,
      );
    });

    it("node update keeps a caught date instead of replacing it with the fallback", async () => {
      const store = await context.createStore(datedGraph);
      const document = await store.nodes.CaughtDoc.create({
        title: "a",
        checkedAt: REVIEWED,
      });
      const updated = await store.nodes.CaughtDoc.update(document.id, {
        title: "a2",
      });
      expect(updated.checkedAt).toBe(REVIEWED.toISOString());
    });

    it("node update still refuses a date its schema rewrites on every parse, rather than rewriting it", async () => {
      const store = await context.createStore(datedGraph);
      const document = await store.nodes.StampedDoc.create({
        title: "a",
        stampedAt: PUBLISHED,
      });
      const stored = document.stampedAt;
      await expect(
        store.nodes.StampedDoc.update(document.id, { title: "a2" }),
      ).rejects.toThrow(/expected date, received string/u);
      const read = await store.nodes.StampedDoc.getById(document.id);
      expect(read?.title).toBe("a");
      expect(read?.stampedAt).toBe(stored);
    });

    it("node update inside a transaction", async () => {
      const { store, doc } = await seed(context);
      await store.transaction(async (tx) => {
        await tx.nodes.DatedDoc.update(doc.id, { title: "a2" });
      });
      const read = await store.nodes.DatedDoc.getById(doc.id);
      expect(read?.title).toBe("a2");
      expect(documentDates(read)).toEqual(STORED_DOC_DATES);
    });

    it("node upsertById and bulkUpsertById of an existing node", async () => {
      const { store, doc, other } = await seed(context);
      // The required `publishedAt` is restated; every optional date is left
      // to the stored row.
      const single = await store.nodes.DatedDoc.upsertById(doc.id, {
        title: "a2",
        publishedAt: PUBLISHED,
      });
      expect(single.title).toBe("a2");
      expect(documentDates(single)).toEqual(STORED_DOC_DATES);
      await store.nodes.DatedDoc.bulkUpsertById([
        { id: other.id, props: { title: "b2", publishedAt: PUBLISHED } },
      ]);
      expect(documentDates(await store.nodes.DatedDoc.getById(doc.id))).toEqual(
        STORED_DOC_DATES,
      );
      const bulk = await store.nodes.DatedDoc.getById(other.id);
      expect(bulk?.title).toBe("b2");
      expect(documentDates(bulk)).toEqual(STORED_DOC_DATES);
    });

    it("node upsertById coalescing an unchanged replay", async () => {
      const store = await context.createStore(datedGraph, {
        coalesceUnchangedUpserts: true,
      });
      const document = await store.nodes.DatedDoc.create(fullDocument("a"));
      const replayed = await store.nodes.DatedDoc.upsertById(document.id, {
        title: "a",
        publishedAt: PUBLISHED,
      });
      expect(replayed.meta.version).toBe(document.meta.version);
      expect(documentDates(replayed)).toEqual(STORED_DOC_DATES);
    });

    it("node getOrCreateByConstraint and its bulk form updating a match", async () => {
      const { store, doc, other } = await seed(context);
      // These paths parse the stated props as a create first, so a property
      // with a `.default()` or `.catch()` takes that value when omitted; it
      // is restated here, and the optional dates are left to the stored row.
      const restated = {
        publishedAt: PUBLISHED,
        archivedAt: REVISED,
        checkedAt: REVIEWED,
      };
      const single = await store.nodes.DatedDoc.getOrCreateByConstraint(
        DATED_DOC_TITLE,
        { title: "a", ...restated },
        { ifExists: "update" },
      );
      expect(single.action).toBe("updated");
      const [bulk] = await store.nodes.DatedDoc.bulkGetOrCreateByConstraint(
        DATED_DOC_TITLE,
        [{ props: { title: "b", ...restated } }],
        { ifExists: "update" },
      );
      expect(bulk?.action).toBe("updated");
      expect(documentDates(await store.nodes.DatedDoc.getById(doc.id))).toEqual(
        STORED_DOC_DATES,
      );
      expect(
        documentDates(await store.nodes.DatedDoc.getById(other.id)),
      ).toEqual(STORED_DOC_DATES);
    });

    it("node updateWhere and compareAndSet", async () => {
      const { store, doc, other } = await seed(context);
      const result = await store.nodes.DatedDoc.updateWhere({
        where: (node) => node.title.eq("a"),
        patch: { title: "a2" },
      });
      expect(result.affectedCount).toBe(1);
      const swapped = await store.nodes.DatedDoc.compareAndSet(other.id, {
        expected: { title: "b" },
        patch: { title: "b2" },
      });
      expect(swapped).toBe(true);
      const updated = await store.nodes.DatedDoc.getById(doc.id);
      expect(updated?.title).toBe("a2");
      expect(documentDates(updated)).toEqual(STORED_DOC_DATES);
      const compared = await store.nodes.DatedDoc.getById(other.id);
      expect(compared?.title).toBe("b2");
      expect(documentDates(compared)).toEqual(STORED_DOC_DATES);
    });

    it("edge update, with and without ending its window", async () => {
      const { store, edge } = await seed(context);
      const updated = await store.edges.datedCites.update(edge.id, {
        note: "n2",
      });
      expect(updated.note).toBe("n2");
      expect(edgeDates(updated)).toEqual(STORED_EDGE_DATES);
      const ended = await store.edges.datedCites.update(
        edge.id,
        {},
        { validTo: LATER },
      );
      expect(ended.meta.validTo).toBe(LATER);
      expect(edgeDates(await store.edges.datedCites.getById(edge.id))).toEqual(
        STORED_EDGE_DATES,
      );
    });

    it("edge bulkUpsertById and getOrCreateByEndpoints updating a match", async () => {
      const { store, doc, other, edge } = await seed(context);
      await store.edges.datedCites.bulkUpsertById([
        {
          id: edge.id,
          from: doc,
          to: other,
          props: { note: "n2", at: PUBLISHED },
        },
      ]);
      expect(edgeDates(await store.edges.datedCites.getById(edge.id))).toEqual(
        STORED_EDGE_DATES,
      );
      const single = await store.edges.datedCites.getOrCreateByEndpoints(
        doc,
        other,
        { note: "n3", at: PUBLISHED },
        { ifExists: "update" },
      );
      expect(single.action).toBe("updated");
      const [bulk] = await store.edges.datedCites.bulkGetOrCreateByEndpoints(
        [{ from: doc, to: other, props: { note: "n4", at: PUBLISHED } }],
        { ifExists: "update" },
      );
      expect(bulk?.action).toBe("updated");
      const read = await store.edges.datedCites.getById(edge.id);
      expect(read?.note).toBe("n4");
      expect(edgeDates(read)).toEqual(STORED_EDGE_DATES);
    });

    it("validateStore reports no violation for a stored date", async () => {
      const { store } = await seed(context);
      const nodes = await store.validateStore({
        entity: "node",
        kind: "DatedDoc",
      });
      expect(nodes.scannedCount).toBe(2);
      expect(nodes.violations).toEqual([]);
      const edges = await store.validateStore({
        entity: "edge",
        kind: "datedCites",
      });
      expect(edges.scannedCount).toBe(1);
      expect(edges.violations).toEqual([]);
    });

    it("still refuses a non-date value a caller states for a date property", async () => {
      const { store, doc } = await seed(context);
      await expect(
        store.nodes.DatedDoc.update(doc.id, {
          publishedAt: PUBLISHED.toISOString() as unknown as Date,
        }),
      ).rejects.toThrow(/expected date, received string/u);
    });
  });
}
