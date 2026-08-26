import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { StaleVersionError } from "../src";
import { resolveBundledRootAtomicNodeBatch } from "../src/backend/capabilities/atomic-node-batch";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { defineGraph, defineNode, searchable } from "../src/core";
import { migrateSchema } from "../src/schema";
import { createStoreWithSchema } from "../src/store";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "atomic-node-batch-store",
  nodes: { Person: { type: Person } },
  edges: {},
});

const evolvedGraph = defineGraph({
  id: graph.id,
  nodes: {
    Person: {
      type: defineNode("Person", {
        schema: z.object({ name: z.string(), nickname: z.string().optional() }),
      }),
    },
  },
  edges: {},
});

const UniquePerson = defineNode("UniquePerson", {
  schema: z.object({ name: z.string() }),
});
const SearchDocument = defineNode("SearchDocument", {
  schema: z.object({ title: searchable() }),
});
const fallbackGraph = defineGraph({
  id: "atomic-node-batch-fallbacks",
  nodes: {
    UniquePerson: {
      type: UniquePerson,
      unique: [
        {
          name: "unique_person_name",
          fields: ["name"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    SearchDocument: { type: SearchDocument },
  },
  edges: {},
});

async function createFixture() {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "typegraph-atomic-node-batch-store-"),
  );
  const client = createClient({
    url: `file:${path.join(temporaryDirectory, "graph.db")}`,
  });
  const { backend } = await createLibsqlBackend(client);
  const [store] = await createStoreWithSchema(graph, backend);
  return { backend, client, store, temporaryDirectory };
}

async function createFallbackFixture() {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "typegraph-atomic-node-batch-fallback-"),
  );
  const client = createClient({
    url: `file:${path.join(temporaryDirectory, "graph.db")}`,
  });
  const { backend } = await createLibsqlBackend(client);
  const [store] = await createStoreWithSchema(fallbackGraph, backend);
  return { backend, client, store, temporaryDirectory };
}

async function closeFixture(
  fixture: Readonly<{
    backend: { close: () => Promise<void> };
    client: { close: () => void };
    temporaryDirectory: string;
  }>,
): Promise<void> {
  await fixture.backend.close();
  fixture.client.close();
  rmSync(fixture.temporaryDirectory, { recursive: true, force: true });
}

describe("plain node batch store contract", () => {
  it("keeps the native capability on the exact root only", async () => {
    const fixture = await createFixture();
    try {
      expect(resolveBundledRootAtomicNodeBatch(fixture.backend)).toBeDefined();
      await fixture.backend.transaction((transactionBackend) => {
        expect(
          resolveBundledRootAtomicNodeBatch(transactionBackend),
        ).toBeUndefined();
        return Promise.resolve();
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("uses one native exchange for fresh caller IDs", async () => {
    const fixture = await createFixture();
    try {
      const batch = vi.spyOn(fixture.client, "batch");
      const execute = vi.spyOn(fixture.client, "execute");

      await fixture.store.nodes.Person.bulkInsert([
        { id: "caller-a", props: { name: "Alice" } },
        { id: "caller-b", props: { name: "Bob" } },
      ]);

      expect(batch).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      await expect(fixture.store.nodes.Person.count()).resolves.toBe(2);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("keeps mixed-ID bulkCreate results in input order", async () => {
    const fixture = await createFixture();
    try {
      const created = await fixture.store.nodes.Person.bulkCreate([
        { id: "caller-first", props: { name: "First" } },
        { props: { name: "Generated" } },
        { id: "caller-last", props: { name: "Last" } },
      ]);

      expect(created).toHaveLength(3);
      expect(created.map((node) => node.name)).toEqual([
        "First",
        "Generated",
        "Last",
      ]);
      expect(created[0]?.id).toBe("caller-first");
      expect(created[2]?.id).toBe("caller-last");
    } finally {
      await closeFixture(fixture);
    }
  });

  it("resurrects a tombstone with the requested validity window", async () => {
    const fixture = await createFixture();
    try {
      await fixture.store.nodes.Person.create(
        { name: "Before deletion" },
        { id: "tombstone" },
      );
      await fixture.store.nodes.Person.delete("tombstone" as never);

      const batch = vi.spyOn(fixture.client, "batch");
      const execute = vi.spyOn(fixture.client, "execute");
      await fixture.store.nodes.Person.bulkInsert([
        {
          id: "tombstone",
          props: { name: "After resurrection" },
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2030-01-01T00:00:00.000Z",
        },
      ]);

      expect(batch).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      const resurrected = await fixture.store.nodes.Person.getById(
        "tombstone" as never,
      );
      expect(resurrected?.name).toBe("After resurrection");
      expect(resurrected?.meta.deletedAt).toBeUndefined();
      expect(resurrected?.meta.validFrom).toBe("2020-01-01T00:00:00.000Z");
      expect(resurrected?.meta.validTo).toBe("2030-01-01T00:00:00.000Z");
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rolls back the whole batch on a live duplicate", async () => {
    const fixture = await createFixture();
    try {
      await fixture.store.nodes.Person.create(
        { name: "Existing" },
        { id: "existing" },
      );
      const batch = vi.spyOn(fixture.client, "batch");

      await expect(
        fixture.store.nodes.Person.bulkInsert([
          { id: "new", props: { name: "New" } },
          { id: "existing", props: { name: "Duplicate" } },
        ]),
      ).rejects.toThrow();

      expect(batch).toHaveBeenCalledOnce();
      await expect(fixture.store.nodes.Person.count()).resolves.toBe(1);
      await expect(
        fixture.store.nodes.Person.getById("new" as never),
      ).resolves.toBeUndefined();
      await expect(
        fixture.store.nodes.Person.getById("existing" as never),
      ).resolves.toMatchObject({
        name: "Existing",
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rolls back earlier chunks when a later chunk fails", async () => {
    const fixture = await createFixture();
    try {
      await fixture.store.nodes.Person.create(
        { name: "Existing" },
        { id: "existing" },
      );
      const items = Array.from({ length: 111 }, (_value, index) => ({
        id: `chunk-${index}`,
        props: { name: `Person ${index}` },
      }));
      items[110] = { id: "existing", props: { name: "Duplicate" } };
      const batch = vi.spyOn(fixture.client, "batch");

      await expect(
        fixture.store.nodes.Person.bulkInsert(items),
      ).rejects.toThrow();

      expect(batch).toHaveBeenCalledOnce();
      await expect(fixture.store.nodes.Person.count()).resolves.toBe(1);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rejects duplicate exact inputs before native dispatch", async () => {
    const fixture = await createFixture();
    try {
      const batch = vi.spyOn(fixture.client, "batch");

      await expect(
        fixture.store.nodes.Person.bulkInsert([
          { id: "same", props: { name: "First" } },
          { id: "same", props: { name: "Second" } },
        ]),
      ).rejects.toThrow(/already exists/u);
      expect(batch).not.toHaveBeenCalled();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("refuses a stale schema fence without persisting rows", async () => {
    const fixture = await createFixture();
    try {
      await migrateSchema(fixture.backend, evolvedGraph, 1);

      await expect(
        fixture.store.nodes.Person.bulkCreate([
          { id: "stale", props: { name: "Stale" } },
        ]),
      ).rejects.toThrow(StaleVersionError);
      await expect(fixture.store.nodes.Person.count()).resolves.toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("keeps unique claims on the fallback path", async () => {
    const fixture = await createFallbackFixture();
    try {
      const transaction = vi.spyOn(fixture.backend, "transaction");

      await fixture.store.nodes.UniquePerson.bulkInsert([
        { id: "unique-a", props: { name: "Alice" } },
      ]);

      expect(transaction).toHaveBeenCalledOnce();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("keeps search projections on the fallback path", async () => {
    const fixture = await createFallbackFixture();
    try {
      const transaction = vi.spyOn(fixture.backend, "transaction");

      await fixture.store.nodes.SearchDocument.bulkInsert([
        { id: "search-a", props: { title: "Alice" } },
      ]);

      expect(transaction).toHaveBeenCalledOnce();
    } finally {
      await closeFixture(fixture);
    }
  });
});
