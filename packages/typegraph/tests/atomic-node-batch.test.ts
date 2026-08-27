import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  RestrictedDeleteError,
  StaleVersionError,
  UniquenessError,
} from "../src";
import { resolveBundledRootAtomicNodeBatch } from "../src/backend/capabilities/atomic-mutation-program";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { computeUniqueKey } from "../src/constraints";
import { defineEdge, defineGraph, defineNode, searchable } from "../src/core";
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

const knows = defineEdge("knows", { schema: z.object({}) });
const deleteGraph = defineGraph({
  id: "atomic-node-delete-multi-chunk",
  nodes: { Person: { type: Person } },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
  },
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
const evolvedFallbackGraph = defineGraph({
  id: fallbackGraph.id,
  nodes: {
    UniquePerson: {
      type: defineNode("UniquePerson", {
        schema: z.object({ name: z.string(), nickname: z.string().optional() }),
      }),
      unique: fallbackGraph.nodes.UniquePerson.unique,
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
  it("keeps missing and already-deleted node ids as successful no-ops", async () => {
    const fixture = await createFixture();
    try {
      const node = await fixture.store.nodes.Person.create({ name: "Deleted" });
      await fixture.store.nodes.Person.delete(node.id);

      await expect(
        fixture.store.nodes.Person.bulkDelete([
          node.id,
          "missing-node-id" as typeof node.id,
        ]),
      ).resolves.toBeUndefined();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rolls back earlier delete chunks when a later restriction refuses", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-node-delete-chunks-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const installed = await createLibsqlBackend(client);
    const backend = createSqliteBackend(installed.db, {
      capabilities: { maxBindParameters: 7 },
      executionProfile: { isSync: false, transactionMode: "sql" },
    });
    try {
      const [store] = await createStoreWithSchema(deleteGraph, backend);
      const batchConnectivity = vi.spyOn(
        backend,
        "findEdgesByHeterogeneousEndpointSet",
      );
      const scalarConnectivity = vi.spyOn(backend, "findEdgesConnectedTo");
      const source = await store.nodes.Person.create({ name: "Source" });
      const first = await store.nodes.Person.create({ name: "First" });
      const second = await store.nodes.Person.create({ name: "Second" });
      const connected = await store.nodes.Person.create({ name: "Connected" });
      await store.edges.knows.create(source, connected, {});

      await expect(
        store.nodes.Person.bulkDelete([first.id, second.id, connected.id]),
      ).rejects.toBeInstanceOf(RestrictedDeleteError);

      expect(batchConnectivity).toHaveBeenCalledTimes(2);
      expect(scalarConnectivity).not.toHaveBeenCalled();

      for (const id of [first.id, second.id, connected.id]) {
        await expect(store.nodes.Person.getById(id)).resolves.toBeDefined();
      }
    } finally {
      await installed.backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

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

  it("refuses a stale schema fence without deleting nodes", async () => {
    const fixture = await createFixture();
    try {
      const node = await fixture.store.nodes.Person.create(
        { name: "Keep" },
        { id: "stale-delete" },
      );
      await migrateSchema(fixture.backend, evolvedGraph, 1);

      await expect(
        fixture.store.nodes.Person.bulkDelete([node.id]),
      ).rejects.toBeInstanceOf(StaleVersionError);
      await expect(
        fixture.store.nodes.Person.getById(node.id),
      ).resolves.toBeDefined();
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

describe("constrained node batch store contract", () => {
  it("uses one native exchange for generated unique bulkInsert", async () => {
    const fixture = await createFallbackFixture();
    try {
      const batch = vi.spyOn(fixture.client, "batch");
      const execute = vi.spyOn(fixture.client, "execute");

      await fixture.store.nodes.UniquePerson.bulkInsert([
        { props: { name: "Alice" } },
        { props: { name: "Bob" } },
      ]);

      expect(batch).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      await expect(fixture.store.nodes.UniquePerson.count()).resolves.toBe(2);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("uses one native exchange for generated unique bulkCreate in input order", async () => {
    const fixture = await createFallbackFixture();
    try {
      const batch = vi.spyOn(fixture.client, "batch");
      const execute = vi.spyOn(fixture.client, "execute");

      const created = await fixture.store.nodes.UniquePerson.bulkCreate([
        { props: { name: "First" } },
        { props: { name: "Second" } },
      ]);

      expect(batch).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(created.map((node) => node.name)).toEqual(["First", "Second"]);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("reports an external uniqueness conflict without nodes or leaked claims", async () => {
    const fixture = await createFallbackFixture();
    try {
      const alice = await fixture.store.nodes.UniquePerson.create({
        name: "Alice",
      });
      const batch = vi.spyOn(fixture.client, "batch");
      const execute = vi.spyOn(fixture.client, "execute");

      const insertion = fixture.store.nodes.UniquePerson.bulkInsert([
        { props: { name: "Alice" } },
        { props: { name: "Bob" } },
      ]);
      await expect(insertion).rejects.toBeInstanceOf(UniquenessError);
      const rejection = await insertion.catch((error: unknown) => error);
      if (!(rejection instanceof UniquenessError)) {
        throw rejection;
      }
      expect(rejection.details).toMatchObject({
        constraintName: "unique_person_name",
        existingId: alice.id,
        fields: ["name"],
      });
      expect(typeof rejection.details.newId).toBe("string");
      expect(batch).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      await expect(fixture.store.nodes.UniquePerson.count()).resolves.toBe(1);
      const claim = await fixture.backend.checkUnique({
        graphId: fallbackGraph.id,
        nodeKind: "UniquePerson",
        constraintName: "unique_person_name",
        key: computeUniqueKey({ name: "Bob" }, ["name"], "binary"),
      });
      expect(claim).toBeUndefined();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rejects an in-batch duplicate claim before dispatch", async () => {
    const fixture = await createFallbackFixture();
    try {
      const batch = vi.spyOn(fixture.client, "batch");
      const execute = vi.spyOn(fixture.client, "execute");
      const insertion = fixture.store.nodes.UniquePerson.bulkInsert([
        { props: { name: "Duplicate" } },
        { props: { name: "Duplicate" } },
      ]);

      await expect(insertion).rejects.toBeInstanceOf(UniquenessError);
      const rejection = await insertion.catch((error: unknown) => error);
      if (!(rejection instanceof UniquenessError)) throw rejection;
      expect(rejection.details).toMatchObject({
        constraintName: "unique_person_name",
        fields: ["name"],
      });
      expect(rejection.details.existingId).not.toBe(rejection.details.newId);
      expect(batch).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      await expect(fixture.store.nodes.UniquePerson.count()).resolves.toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("takes over a tombstoned unique claim for a new generated node", async () => {
    const fixture = await createFallbackFixture();
    try {
      const old = await fixture.store.nodes.UniquePerson.create(
        { name: "Old" },
        { id: "tombstone" },
      );
      await fixture.store.nodes.UniquePerson.delete(old.id);
      const batch = vi.spyOn(fixture.client, "batch");
      const execute = vi.spyOn(fixture.client, "execute");

      const [replacement] = await fixture.store.nodes.UniquePerson.bulkCreate([
        { props: { name: "Old" } },
      ]);

      expect(batch).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(replacement).toMatchObject({ name: "Old" });
      if (replacement === undefined) {
        throw new Error("Expected the constrained batch to return one node.");
      }
      await expect(
        fixture.store.nodes.UniquePerson.getById(replacement.id),
      ).resolves.toMatchObject({ name: "Old" });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("does not mutate a constrained batch behind a stale schema fence", async () => {
    const fixture = await createFallbackFixture();
    try {
      await migrateSchema(fixture.backend, evolvedFallbackGraph, 1);
      await expect(
        fixture.store.nodes.UniquePerson.bulkInsert([
          { props: { name: "Stale" } },
        ]),
      ).rejects.toThrow(StaleVersionError);
      await expect(fixture.store.nodes.UniquePerson.count()).resolves.toBe(0);
      const claim = await fixture.backend.checkUnique({
        graphId: fallbackGraph.id,
        nodeKind: "UniquePerson",
        constraintName: "unique_person_name",
        key: computeUniqueKey({ name: "Stale" }, ["name"], "binary"),
      });
      expect(claim).toBeUndefined();
    } finally {
      await closeFixture(fixture);
    }
  });
});
