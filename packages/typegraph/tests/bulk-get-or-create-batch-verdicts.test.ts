/**
 * What `bulkGetOrCreateByConstraint` reads, and when, around the batch's first
 * write.
 *
 * The cross-backend cases (`tests/backends/integration/composition-attachment.ts`)
 * pin which refusals precede the first write. These two pin what only a
 * dedicated graph or a spy on the backend can: the identity fold a restored
 * row owes is judged before the batch writes, and an already-satisfied batch
 * reads each part's attachment once.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  IdentityContradictionError,
  partOf,
} from "../src";
import type * as CompositionCreate from "../src/store/operations/composition-create";
import { findLiveCompositionAttachment } from "../src/store/operations/composition-create";
import { createTestBackend } from "./test-utils";

// Counts the attachment reads the operations layer issues (calls made from
// inside `composition-create` itself are not routed through the mock).
vi.mock(
  "../src/store/operations/composition-create",
  async (importOriginal) => {
    const actual = await importOriginal<typeof CompositionCreate>();
    return {
      ...actual,
      findLiveCompositionAttachment: vi.fn(
        actual.findLiveCompositionAttachment,
      ),
    };
  },
);

const attachmentReads = vi.mocked(findLiveCompositionAttachment);

const Ghost = defineNode("Ghost", {
  schema: z.object({ slug: z.string(), note: z.string().optional() }),
});
const Spirit = defineNode("Spirit", { schema: z.object({}) });
const Other = defineNode("Other", { schema: z.object({}) });

const identityGraph = defineGraph({
  id: "bulk_get_or_create_identity_verdicts",
  nodes: {
    Ghost: {
      type: Ghost,
      unique: [
        {
          name: "ghost_slug",
          fields: ["slug"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Spirit: { type: Spirit },
    Other: { type: Other },
  },
  edges: {},
  ontology: [disjointWith(Ghost, Spirit)],
  identity: { sameIdAcrossKinds: "fold" },
});

const Shelf = defineNode("Shelf", { schema: z.object({}) });
const Book = defineNode("Book", { schema: z.object({ slug: z.string() }) });
const bookOn = defineEdge("bookOn", { schema: z.object({}) });

const shelfGraph = defineGraph({
  id: "bulk_get_or_create_attachment_reads",
  nodes: {
    Shelf: { type: Shelf },
    Book: {
      type: Book,
      unique: [
        {
          name: "book_slug",
          fields: ["slug"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    bookOn: { type: bookOn, from: [Book], to: [Shelf], cardinality: "one" },
  },
  ontology: [partOf(Book, Shelf, { via: bookOn })],
});

describe("bulkGetOrCreateByConstraint batch verdicts", () => {
  it("refuses a restore whose identity fold would contradict before updating an earlier item", async () => {
    const store = createStore(identityGraph, createTestBackend());
    const live = await store.nodes.Ghost.create({
      slug: "live",
      note: "before",
    });
    const gone = await store.nodes.Ghost.create({ slug: "gone" }, { id: "x" });
    await store.nodes.Ghost.delete(gone.id);
    // "x" now names a live Other whose class holds a Spirit, which is
    // disjoint with Ghost: no read of the NODE rows at id "x" sees a
    // disjoint kind, only the identity fold does.
    const other = await store.nodes.Other.create({}, { id: "x" });
    const spirit = await store.nodes.Spirit.create({}, { id: "y" });
    await store.identity.assertSame(other, spirit);

    // MUTATION CHECK: drop the `ctx.identity?.assertFoldable` read from
    // `assertGetOrCreateBatchApplicable`
    // (src/store/operations/node-operations.ts) — "live" is then updated
    // before the restore's fold refuses, and keeps the new note after the
    // caught refusal.
    let caught: unknown;
    await store.transaction(async (tx) => {
      try {
        await tx.nodes.Ghost.bulkGetOrCreateByConstraint(
          "ghost_slug",
          [
            { props: { slug: "live", note: "changed" } },
            { props: { slug: "gone" } },
          ],
          { ifExists: "update" },
        );
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(IdentityContradictionError);
    const after = await store.nodes.Ghost.getById(live.id);
    expect(after?.note).toBe("before");
    expect(after?.meta.version).toBe(live.meta.version);
    expect(await store.nodes.Ghost.getById(gone.id)).toBeUndefined();
  });

  it("reads each already-attached part's attachment once when the whole batch is satisfied", async () => {
    const store = createStore(shelfGraph, createTestBackend());
    const shelf = await store.nodes.Shelf.create({});
    const slugs = ["a", "b", "c", "d", "e"];
    for (const slug of slugs) {
      await store.nodes.Book.create({ slug }, { partOf: { whole: shelf } });
    }

    attachmentReads.mockClear();
    const results = await store.nodes.Book.bulkGetOrCreateByConstraint(
      "book_slug",
      slugs.map((slug) => ({ props: { slug } })),
      { partOf: { whole: shelf } },
    );

    // MUTATION CHECK: have `partitionExistingGetOrCreateLegs` judge each
    // part's attachment and then write every match through the
    // postcondition (which pre-checks again) — the count doubles.
    expect(results.map((result) => result.action)).toEqual(
      slugs.map(() => "found"),
    );
    expect(attachmentReads).toHaveBeenCalledTimes(slugs.length);
  });
});
