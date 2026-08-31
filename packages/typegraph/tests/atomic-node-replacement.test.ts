import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { StaleVersionError, UniquenessError } from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { atomicNodeReplacementSubmissionMaxEntries } from "../src/backend/drizzle/operation-backend-core";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { defineGraph, defineNode, searchable } from "../src/core";
import { migrateSchema } from "../src/schema";
import { createStoreWithSchema, createVerifiedStore } from "../src/store";

const Document = defineNode("Document", {
  schema: z.object({
    slug: z.string(),
    title: searchable(),
    note: z.string().optional(),
  }),
});
const TransformDocument = defineNode("TransformDocument", {
  schema: z.object({ token: z.string().transform((value) => `${value}!`) }),
});

const graph = defineGraph({
  id: "atomic-node-replacement",
  nodes: {
    Document: {
      type: Document,
      unique: [
        {
          name: "document_slug",
          fields: ["slug"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    TransformDocument: { type: TransformDocument },
  },
  edges: {},
});

const evolvedGraph = defineGraph({
  id: graph.id,
  nodes: {
    Document: {
      type: defineNode("Document", {
        schema: z.object({
          slug: z.string(),
          title: searchable(),
          note: z.string().optional(),
          revision: z.string().optional(),
        }),
      }),
      unique: graph.nodes.Document.unique,
    },
    TransformDocument: { type: TransformDocument },
  },
  edges: {},
});

async function createFixture() {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "typegraph-atomic-node-replacement-"),
  );
  const client = createClient({
    url: `file:${path.join(temporaryDirectory, "graph.db")}`,
  });
  const { backend } = await createLibsqlBackend(client);
  const [store] = await createStoreWithSchema(graph, backend);
  return { backend, client, store, temporaryDirectory };
}

async function closeFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  await fixture.backend.close();
  fixture.client.close();
  rmSync(fixture.temporaryDirectory, { recursive: true, force: true });
}

describe("atomic node replacement", () => {
  it("derives its advertised ceiling from the replacement chunk budget", () => {
    expect(atomicNodeReplacementSubmissionMaxEntries(100)).toBe(311);
    expect(atomicNodeReplacementSubmissionMaxEntries(101)).toBe(311);
    expect(atomicNodeReplacementSubmissionMaxEntries(102)).toBe(311);
  });

  it("creates, replaces, and resurrects complete documents in one exchange", async () => {
    const fixture = await createFixture();
    try {
      const live = await fixture.store.nodes.Document.create(
        { slug: "live", title: "Before", note: "remove me" },
        {
          id: "live",
          validFrom: "2026-01-01T00:00:00.000Z",
          validTo: "2027-01-01T00:00:00.000Z",
        },
      );
      await fixture.store.nodes.Document.create(
        { slug: "deleted", title: "Deleted", note: "old" },
        { id: "deleted", validFrom: "2020-01-01T00:00:00.000Z" },
      );
      await fixture.store.nodes.Document.delete("deleted" as never);
      const batch = vi.spyOn(fixture.client, "batch");
      const execute = vi.spyOn(fixture.client, "execute");

      const rows = await fixture.store.nodes.Document.bulkReplaceById([
        { id: "new", props: { slug: "new", title: "Created" } },
        { id: "live", props: { slug: "live", title: "Replaced" } },
        {
          id: "deleted",
          props: { slug: "deleted", title: "Resurrected" },
        },
      ]);

      expect(batch).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(rows.map((row) => [row.id, row.title, row.note])).toEqual([
        ["new", "Created", undefined],
        ["live", "Replaced", undefined],
        ["deleted", "Resurrected", undefined],
      ]);
      expect(rows[1]?.meta.validFrom).toBe(live.meta.validFrom);
      expect(rows[1]?.meta.validTo).toBe(live.meta.validTo);
      expect(rows[2]?.meta.validFrom).not.toBe("2020-01-01T00:00:00.000Z");
      await expect(
        fixture.store.search.fulltext("Document", {
          query: "Created OR Replaced OR Resurrected",
          mode: "raw",
          limit: 10,
        }),
      ).resolves.toHaveLength(3);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("moves unique claims across replacement members atomically", async () => {
    const fixture = await createFixture();
    try {
      await fixture.store.nodes.Document.bulkInsert([
        { id: "a", props: { slug: "shared", title: "A" } },
        { id: "b", props: { slug: "other", title: "B" } },
      ]);

      await expect(
        fixture.store.nodes.Document.bulkReplaceById([
          { id: "a", props: { slug: "released", title: "A2" } },
          { id: "b", props: { slug: "shared", title: "B2" } },
        ]),
      ).resolves.toMatchObject([
        { id: "a", slug: "released" },
        { id: "b", slug: "shared" },
      ]);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("admits claimed batches by actual statement work beyond 32 members", async () => {
    const fixture = await createFixture();
    try {
      const items = Array.from({ length: 33 }, (_, index) => ({
        id: `claimed-${index}`,
        props: { slug: `slug-${index}`, title: `Title ${index}` },
      }));
      const batch = vi.spyOn(fixture.client, "batch");
      const execute = vi.spyOn(fixture.client, "execute");

      await expect(
        fixture.store.nodes.Document.bulkReplaceById(items),
      ).resolves.toHaveLength(items.length);
      expect(batch).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("preserves replacement semantics on an unregistered derived backend", async () => {
    const fixture = await createFixture();
    try {
      await fixture.store.nodes.Document.create(
        { slug: "portable", title: "Before", note: "remove me" },
        { id: "portable" },
      );
      const [portable] = await createVerifiedStore(
        graph,
        deriveBackend(fixture.backend, {}),
      );
      const batch = vi.spyOn(fixture.client, "batch");

      const [row] = await portable.nodes.Document.bulkReplaceById([
        { id: "portable", props: { slug: "portable", title: "After" } },
      ]);

      expect(row).toMatchObject({
        id: "portable",
        slug: "portable",
        title: "After",
      });
      expect(row?.note).toBeUndefined();
      expect(batch).not.toHaveBeenCalled();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rebuilds the portable partition after a concurrent create", async () => {
    const fixture = await createFixture();
    try {
      const getNodes = fixture.backend.getNodes;
      expect(getNodes).toBeDefined();
      let injected = false;
      const racingBackend = deriveBackend(fixture.backend, {
        getNodes: async (graphId, kind, ids) => {
          const rows = await getNodes?.(graphId, kind, ids);
          if (!injected) {
            injected = true;
            await fixture.store.nodes.Document.create(
              { slug: "raced", title: "Concurrent" },
              { id: "raced" },
            );
          }
          return rows ?? [];
        },
      });
      const [portable] = await createVerifiedStore(graph, racingBackend);

      await expect(
        portable.nodes.Document.bulkReplaceById([
          { id: "raced", props: { slug: "raced", title: "Replacement" } },
        ]),
      ).resolves.toMatchObject([{ id: "raced", title: "Replacement" }]);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("applies schema transforms once on atomic and portable paths", async () => {
    const fixture = await createFixture();
    try {
      const [atomic] =
        await fixture.store.nodes.TransformDocument.bulkReplaceById([
          { id: "atomic", props: { token: "atomic" } },
        ]);
      const [portable] = await createVerifiedStore(
        graph,
        deriveBackend(fixture.backend, {}),
      );
      const rows = await portable.nodes.TransformDocument.bulkReplaceById([
        { id: "atomic", props: { token: "portable-live" } },
        { id: "portable-new", props: { token: "portable-new" } },
      ]);

      expect(atomic?.token).toBe("atomic!");
      expect(rows.map((row) => row.token)).toEqual([
        "portable-live!",
        "portable-new!",
      ]);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rolls every member back when a replacement claim is refused", async () => {
    const fixture = await createFixture();
    try {
      await fixture.store.nodes.Document.bulkInsert([
        { id: "a", props: { slug: "a", title: "Before A" } },
        { id: "b", props: { slug: "b", title: "Before B" } },
      ]);

      await expect(
        fixture.store.nodes.Document.bulkReplaceById([
          { id: "a", props: { slug: "same", title: "After A" } },
          { id: "b", props: { slug: "same", title: "After B" } },
        ]),
      ).rejects.toBeInstanceOf(UniquenessError);
      await expect(
        fixture.store.nodes.Document.getById("a" as never),
      ).resolves.toMatchObject({ slug: "a", title: "Before A" });
      await expect(
        fixture.store.nodes.Document.getById("b" as never),
      ).resolves.toMatchObject({ slug: "b", title: "Before B" });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rolls replacements and sidecars back on a stale schema fence", async () => {
    const fixture = await createFixture();
    try {
      await fixture.store.nodes.Document.create(
        { slug: "stale", title: "Before" },
        { id: "stale" },
      );
      await migrateSchema(fixture.backend, evolvedGraph, 1);

      await expect(
        fixture.store.nodes.Document.bulkReplaceById([
          { id: "stale", props: { slug: "stale", title: "After" } },
        ]),
      ).rejects.toBeInstanceOf(StaleVersionError);
      await expect(
        fixture.store.search.fulltext("Document", {
          query: "After",
          limit: 10,
        }),
      ).resolves.toHaveLength(0);
    } finally {
      await closeFixture(fixture);
    }
  });
});
