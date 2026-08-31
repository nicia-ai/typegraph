import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ContributionUnavailableError,
  DatabaseOperationError,
  DisjointError,
  RestrictedDeleteError,
  StaleVersionError,
  UniquenessError,
} from "../src";
import {
  resolveBundledRootAtomicMutationPrograms,
  resolveBundledRootAtomicNodeBatch,
  withAtomicMutationProgramDispatchObserver,
} from "../src/backend/capabilities/atomic-mutation-program";
import { tables as sqliteTables } from "../src/backend/drizzle/schema/sqlite";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { computeUniqueKey } from "../src/constraints";
import {
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  searchable,
} from "../src/core";
import { disjointWith, subClassOf } from "../src/ontology";
import { libsqlVectorStrategy } from "../src/query/dialect/vector/libsql-strategy";
import { migrateSchema } from "../src/schema";
import { createStoreWithSchema, createVerifiedStore } from "../src/store";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "atomic-node-batch-store",
  nodes: { Person: { type: Person } },
  edges: {},
});

const Rival = defineNode("Rival", {
  schema: z.object({ name: z.string() }),
});
const disjointGraph = defineGraph({
  id: "atomic-node-batch-disjoint-store",
  nodes: { Person: { type: Person }, Rival: { type: Rival } },
  edges: {},
  ontology: [disjointWith(Person, Rival)],
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
const VectorDocument = defineNode("VectorDocument", {
  schema: z.object({ vector: embedding(2).optional() }),
});
const MultiClaimPerson = defineNode("MultiClaimPerson", {
  schema: z.object({ email: z.string(), handle: z.string() }),
});
const ClaimedDocument = defineNode("ClaimedDocument", {
  schema: z.object({
    slug: z.string(),
    title: searchable(),
    vector: embedding(2).optional(),
  }),
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
    VectorDocument: { type: VectorDocument },
    MultiClaimPerson: {
      type: MultiClaimPerson,
      unique: [
        {
          name: "multi_claim_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
        {
          name: "multi_claim_handle",
          fields: ["handle"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    ClaimedDocument: {
      type: ClaimedDocument,
      unique: [
        {
          name: "claimed_document_slug",
          fields: ["slug"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
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
    VectorDocument: { type: VectorDocument },
    MultiClaimPerson: fallbackGraph.nodes.MultiClaimPerson,
    ClaimedDocument: fallbackGraph.nodes.ClaimedDocument,
  },
  edges: {},
});

const ScopedPerson = defineNode("ScopedPerson", {
  schema: z.object({ email: z.string() }),
});
const ScopedEmployee = defineNode("ScopedEmployee", {
  schema: z.object({ email: z.string() }),
});
const scopedClaimGraph = defineGraph({
  id: "atomic-node-batch-scoped-claims",
  nodes: {
    ScopedPerson: {
      type: ScopedPerson,
      unique: [
        {
          name: "scoped_email",
          fields: ["email"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
      ],
    },
    ScopedEmployee: {
      type: ScopedEmployee,
      unique: [
        {
          name: "scoped_email",
          fields: ["email"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
  ontology: [subClassOf(ScopedEmployee, ScopedPerson)],
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

async function createFallbackFixture(maxBindParameters?: number) {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "typegraph-atomic-node-batch-fallback-"),
  );
  const client = createClient({
    url: `file:${path.join(temporaryDirectory, "graph.db")}`,
  });
  const installed = await createLibsqlBackend(client);
  const backend =
    maxBindParameters === undefined ?
      installed.backend
    : createSqliteBackend(installed.db, {
        capabilities: { maxBindParameters },
        executionProfile: { isSync: false, transactionMode: "sql" },
        vector: libsqlVectorStrategy,
      });
  const { db } = installed;
  const [store] = await createStoreWithSchema(fallbackGraph, backend);
  return { backend, client, db, store, temporaryDirectory };
}

async function createDisjointFixture() {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "typegraph-atomic-node-batch-disjoint-"),
  );
  const client = createClient({
    url: `file:${path.join(temporaryDirectory, "graph.db")}`,
  });
  const { backend } = await createLibsqlBackend(client);
  const [store] = await createStoreWithSchema(disjointGraph, backend);
  return { backend, client, store, temporaryDirectory };
}

async function createScopedClaimFixture() {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "typegraph-atomic-node-batch-scoped-claims-"),
  );
  const client = createClient({
    url: `file:${path.join(temporaryDirectory, "graph.db")}`,
  });
  const { backend } = await createLibsqlBackend(client);
  const [store] = await createStoreWithSchema(scopedClaimGraph, backend);
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

  it("diagnoses an out-of-schema connected edge after native refusal", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-node-delete-legacy-edge-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const { backend } = await createLibsqlBackend(client);
    try {
      const [store] = await createStoreWithSchema(deleteGraph, backend);
      const source = await store.nodes.Person.create({ name: "Source" });
      const connected = await store.nodes.Person.create({ name: "Connected" });
      await backend.insertEdge({
        graphId: deleteGraph.id,
        id: "legacy-edge",
        kind: "legacy-kind",
        fromKind: source.kind,
        fromId: source.id,
        toKind: connected.kind,
        toId: connected.id,
        props: {},
      });
      const batchConnectivity = vi.spyOn(
        backend,
        "findEdgesByHeterogeneousEndpointSet",
      );
      const scalarConnectivity = vi.spyOn(backend, "findEdgesConnectedTo");

      await expect(
        store.nodes.Person.bulkDelete([connected.id]),
      ).rejects.toBeInstanceOf(RestrictedDeleteError);

      expect(batchConnectivity).toHaveBeenCalledTimes(2);
      expect(scalarConnectivity).toHaveBeenCalledOnce();
      await expect(
        store.nodes.Person.getById(connected.id),
      ).resolves.toBeDefined();
    } finally {
      await backend.close();
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

  it("refuses a legacy disjoint row without committing sibling creates", async () => {
    const fixture = await createDisjointFixture();
    try {
      // Model a pre-claim database: the live row exists but no canonical
      // disjoint reservation accompanies it.
      await fixture.backend.insertNode({
        graphId: disjointGraph.id,
        kind: Rival.kind,
        id: "shared-id",
        props: { name: "Legacy rival" },
      });
      const batch = vi.spyOn(fixture.client, "batch");
      const batchNodeRead = vi.spyOn(fixture.backend, "getNodes");
      const scalarNodeRead = vi.spyOn(fixture.backend, "getNode");

      await expect(
        fixture.store.nodes.Person.bulkInsert([
          { id: "sibling", props: { name: "Sibling" } },
          { id: "shared-id", props: { name: "Conflict" } },
        ]),
      ).rejects.toMatchObject({
        name: DisjointError.name,
        details: {
          attemptedKind: Person.kind,
          conflictingKind: Rival.kind,
          nodeId: "shared-id",
        },
      });

      expect(batch).toHaveBeenCalledOnce();
      expect(batchNodeRead).toHaveBeenCalledOnce();
      expect(scalarNodeRead).not.toHaveBeenCalled();
      await expect(fixture.store.nodes.Person.count()).resolves.toBe(0);
      await expect(fixture.store.nodes.Rival.count()).resolves.toBe(1);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("keeps mixed-ID disjoint creates in one atomic submission", async () => {
    const fixture = await createDisjointFixture();
    try {
      const batch = vi.spyOn(fixture.client, "batch");

      const created = await fixture.store.nodes.Person.bulkCreate([
        { id: "caller", props: { name: "Caller" } },
        { props: { name: "Generated" } },
      ]);

      expect(batch).toHaveBeenCalledOnce();
      expect(created.map((node) => node.name)).toEqual(["Caller", "Generated"]);
      expect(created[0]?.id).toBe("caller");
    } finally {
      await closeFixture(fixture);
    }
  });

  it("diagnoses a late disjoint refusal with one set-oriented node read", async () => {
    const fixture = await createDisjointFixture();
    try {
      await fixture.backend.insertNode({
        graphId: disjointGraph.id,
        kind: Rival.kind,
        id: "late-disjoint-64",
        props: { name: "Legacy rival" },
      });
      const batchNodeRead = vi.spyOn(fixture.backend, "getNodes");
      const scalarNodeRead = vi.spyOn(fixture.backend, "getNode");
      const inputs = Array.from({ length: 65 }, (_value, index) => ({
        id: `late-disjoint-${index}`,
        props: { name: `Person ${index}` },
      }));

      await expect(
        fixture.store.nodes.Person.bulkInsert(inputs),
      ).rejects.toMatchObject({
        name: DisjointError.name,
        details: { nodeId: "late-disjoint-64" },
      });

      expect(batchNodeRead).toHaveBeenCalledOnce();
      expect(scalarNodeRead).not.toHaveBeenCalled();
      await expect(fixture.store.nodes.Person.count()).resolves.toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("uses the shared row-liveness verdict during scalar disjoint diagnosis", async () => {
    const fixture = await createDisjointFixture();
    try {
      await fixture.backend.insertNode({
        graphId: disjointGraph.id,
        kind: Rival.kind,
        id: "null-liveness",
        props: { name: "Legacy rival" },
      });
      Object.defineProperty(fixture.backend, "getNodes", {
        configurable: true,
        value: undefined,
      });
      const getNode = fixture.backend.getNode;
      vi.spyOn(fixture.backend, "getNode").mockImplementation(
        async (...args) => {
          const row = await getNode(...args);
          if (row === undefined) return;
          // Deliberately model a third-party backend that violates TypeGraph's
          // timestamp normalization. Scalar and set reads must still classify
          // the same row through the shared liveness predicate.
          // eslint-disable-next-line unicorn/no-null -- null is the malformed transport value under test.
          return { ...row, deleted_at: null } as never;
        },
      );

      const insertion = fixture.store.nodes.Person.bulkInsert([
        { id: "null-liveness", props: { name: "Proposed" } },
      ]);
      const rejection = await insertion.catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(DatabaseOperationError);
      expect(rejection).not.toBeInstanceOf(DisjointError);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("releases disjoint claims inside the native delete program", async () => {
    const fixture = await createDisjointFixture();
    try {
      const person = await fixture.store.nodes.Person.create(
        { name: "Person" },
        { id: "reusable-id" },
      );
      const batch = vi.spyOn(fixture.client, "batch");
      const execute = vi.spyOn(fixture.client, "execute");

      await fixture.store.nodes.Person.bulkDelete([person.id]);

      expect(batch).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      await expect(
        fixture.store.nodes.Rival.create({ name: "Rival" }, { id: person.id }),
      ).resolves.toMatchObject({ id: "reusable-id" });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("releases uniqueness claims inside the native delete program", async () => {
    const fixture = await createFallbackFixture();
    try {
      const original = await fixture.store.nodes.UniquePerson.create({
        name: "Reusable name",
      });
      const batch = vi.spyOn(fixture.client, "batch");
      const execute = vi.spyOn(fixture.client, "execute");

      await fixture.store.nodes.UniquePerson.bulkDelete([original.id]);

      expect(batch).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      await expect(
        fixture.store.nodes.UniquePerson.create({ name: "Reusable name" }),
      ).resolves.toMatchObject({ name: "Reusable name" });
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

  it("folds caller-id unique claims into the atomic batch", async () => {
    const fixture = await createFallbackFixture();
    try {
      const transaction = vi.spyOn(fixture.backend, "transaction");
      const batch = vi.spyOn(fixture.client, "batch");

      await fixture.store.nodes.UniquePerson.bulkInsert([
        { id: "unique-a", props: { name: "Alice" } },
      ]);

      expect(transaction).not.toHaveBeenCalled();
      expect(batch).toHaveBeenCalledOnce();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("acquires multiple claims per member and rolls back sibling rows on refusal", async () => {
    const fixture = await createFallbackFixture();
    try {
      await fixture.store.nodes.MultiClaimPerson.bulkInsert([
        {
          id: "incumbent",
          props: { email: "held@example.com", handle: "held" },
        },
      ]);
      const batch = vi.spyOn(fixture.client, "batch");

      await expect(
        fixture.store.nodes.MultiClaimPerson.bulkInsert([
          {
            id: "sibling",
            props: { email: "sibling@example.com", handle: "sibling" },
          },
          {
            id: "conflict",
            props: { email: "new@example.com", handle: "held" },
          },
        ]),
      ).rejects.toMatchObject({
        name: UniquenessError.name,
        details: { constraintName: "multi_claim_handle" },
      });

      expect(batch).toHaveBeenCalledOnce();
      await expect(fixture.store.nodes.MultiClaimPerson.count()).resolves.toBe(
        1,
      );
      await expect(
        fixture.store.nodes.MultiClaimPerson.getById("sibling" as never),
      ).resolves.toBeUndefined();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("diagnoses a late uniqueness refusal with one set-oriented probe", async () => {
    const fixture = await createFallbackFixture();
    try {
      await fixture.store.nodes.UniquePerson.bulkInsert([
        { id: "late-incumbent", props: { name: "Held" } },
      ]);
      const batchClaimProbe = vi.spyOn(fixture.backend, "checkUniqueBatch");
      const scalarClaimProbe = vi.spyOn(fixture.backend, "checkUnique");
      const inputs = Array.from({ length: 65 }, (_value, index) => ({
        id: `late-member-${index}`,
        props: { name: index === 64 ? "Held" : `Fresh ${index}` },
      }));

      await expect(
        fixture.store.nodes.UniquePerson.bulkInsert(inputs),
      ).rejects.toMatchObject({
        name: UniquenessError.name,
        details: {
          existingId: "late-incumbent",
          newId: "late-member-64",
        },
      });

      expect(batchClaimProbe).toHaveBeenCalledOnce();
      expect(scalarClaimProbe).not.toHaveBeenCalled();
      await expect(fixture.store.nodes.UniquePerson.count()).resolves.toBe(1);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("bounds scalar diagnosis without truncating late inputs", async () => {
    const fixture = await createFallbackFixture();
    try {
      await fixture.store.nodes.UniquePerson.bulkInsert([
        { id: "scalar-incumbent", props: { name: "Held" } },
      ]);
      Object.defineProperty(fixture.backend, "checkUniqueBatch", {
        configurable: true,
        value: undefined,
      });
      const checkUnique = fixture.backend.checkUnique;
      let activeReads = 0;
      let maximumActiveReads = 0;
      const scalarClaimProbe = vi
        .spyOn(fixture.backend, "checkUnique")
        .mockImplementation(async (params) => {
          activeReads += 1;
          maximumActiveReads = Math.max(maximumActiveReads, activeReads);
          try {
            return await checkUnique(params);
          } finally {
            activeReads -= 1;
          }
        });
      const inputs = Array.from({ length: 65 }, (_value, index) => ({
        id: `scalar-member-${index}`,
        props: { name: index === 64 ? "Held" : `Fresh ${index}` },
      }));

      await expect(
        fixture.store.nodes.UniquePerson.bulkInsert(inputs),
      ).rejects.toMatchObject({
        name: UniquenessError.name,
        details: { newId: "scalar-member-64" },
      });

      expect(scalarClaimProbe).toHaveBeenCalledTimes(65);
      expect(maximumActiveReads).toBe(32);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("stops scalar diagnosis after the earliest refusing window", async () => {
    const fixture = await createFallbackFixture();
    try {
      await fixture.store.nodes.UniquePerson.bulkInsert([
        { id: "early-incumbent", props: { name: "Held" } },
      ]);
      Object.defineProperty(fixture.backend, "checkUniqueBatch", {
        configurable: true,
        value: undefined,
      });
      const checkUnique = fixture.backend.checkUnique;
      const scalarClaimProbe = vi
        .spyOn(fixture.backend, "checkUnique")
        .mockImplementation(async (params) => checkUnique(params));
      const inputs = Array.from({ length: 65 }, (_value, index) => ({
        id: `early-member-${index}`,
        props: { name: index === 0 ? "Held" : `Fresh ${index}` },
      }));

      await expect(
        fixture.store.nodes.UniquePerson.bulkInsert(inputs),
      ).rejects.toMatchObject({
        name: UniquenessError.name,
        details: { newId: "early-member-0" },
      });

      expect(scalarClaimProbe).toHaveBeenCalledTimes(32);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("selects claim refusals in input order after batched diagnosis", async () => {
    const fixture = await createFallbackFixture();
    try {
      await fixture.store.nodes.MultiClaimPerson.bulkInsert([
        {
          id: "handle-incumbent",
          props: { email: "free@example.com", handle: "held-handle" },
        },
        {
          id: "email-incumbent",
          props: { email: "held@example.com", handle: "free-handle" },
        },
      ]);

      await expect(
        fixture.store.nodes.MultiClaimPerson.bulkInsert([
          {
            id: "first-refusal",
            props: { email: "first@example.com", handle: "held-handle" },
          },
          {
            id: "second-refusal",
            props: { email: "held@example.com", handle: "second-handle" },
          },
        ]),
      ).rejects.toMatchObject({
        name: UniquenessError.name,
        details: {
          constraintName: "multi_claim_handle",
          newId: "first-refusal",
        },
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rolls back successful claim chunks when a later chunk refuses", async () => {
    const fixture = await createFallbackFixture(100);
    try {
      await fixture.store.nodes.MultiClaimPerson.bulkInsert([
        {
          id: "chunk-incumbent",
          props: {
            email: "incumbent@example.com",
            handle: "held-by-incumbent",
          },
        },
      ]);
      const batch = vi.spyOn(fixture.client, "batch");
      const fresh = Array.from({ length: 4 }, (_value, index) => ({
        id: `chunk-sibling-${index}`,
        props: {
          email: `sibling-${index}@example.com`,
          handle: `sibling-${index}`,
        },
      }));

      await expect(
        fixture.store.nodes.MultiClaimPerson.bulkInsert([
          ...fresh,
          {
            id: "later-chunk-conflict",
            props: {
              email: "conflict@example.com",
              handle: "held-by-incumbent",
            },
          },
        ]),
      ).rejects.toMatchObject({
        name: UniquenessError.name,
        details: { constraintName: "multi_claim_handle" },
      });

      expect(batch).toHaveBeenCalledOnce();
      await expect(fixture.store.nodes.MultiClaimPerson.count()).resolves.toBe(
        1,
      );
      for (const sibling of fresh) {
        await expect(
          fixture.store.nodes.MultiClaimPerson.getById(sibling.id as never),
        ).resolves.toBeUndefined();
      }
    } finally {
      await closeFixture(fixture);
    }
  });

  it("composes unique claims with fulltext and embedding projections", async () => {
    const fixture = await createFallbackFixture();
    try {
      const batch = vi.spyOn(fixture.client, "batch");

      await fixture.store.nodes.ClaimedDocument.bulkInsert([
        {
          id: "claimed-document",
          props: {
            slug: "claimed",
            title: "Atomic composition",
            vector: [1, 0],
          },
        },
      ]);

      expect(batch).toHaveBeenCalledOnce();
      await expect(
        fixture.store.search.fulltext("ClaimedDocument", {
          query: "composition",
          limit: 10,
        }),
      ).resolves.toHaveLength(1);
      await expect(
        fixture.store.search.vector("ClaimedDocument", {
          fieldPath: "vector",
          queryEmbedding: [1, 0],
          limit: 10,
        }),
      ).resolves.toHaveLength(1);

      await expect(
        fixture.store.nodes.ClaimedDocument.bulkInsert([
          {
            id: "refused-document",
            props: {
              slug: "claimed",
              title: "Must not project",
              vector: [0, 1],
            },
          },
        ]),
      ).rejects.toBeInstanceOf(UniquenessError);

      expect(batch).toHaveBeenCalledTimes(2);
      await expect(
        fixture.store.nodes.ClaimedDocument.getById(
          "refused-document" as never,
        ),
      ).resolves.toBeUndefined();
      await expect(
        fixture.store.search.fulltext("ClaimedDocument", {
          query: "Must",
          limit: 10,
        }),
      ).resolves.toHaveLength(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("refuses a legacy cross-scope claim and rolls back sibling rows", async () => {
    const fixture = await createScopedClaimFixture();
    try {
      const key = computeUniqueKey(
        { email: "legacy@example.com" },
        ["email"],
        "binary",
      );
      await fixture.backend.insertNode({
        graphId: scopedClaimGraph.id,
        kind: ScopedPerson.kind,
        id: "legacy-owner",
        props: { email: "legacy@example.com" },
      });
      await fixture.backend.insertUnique({
        graphId: scopedClaimGraph.id,
        nodeKind: ScopedPerson.kind,
        constraintName: "scoped_email",
        key,
        nodeId: "legacy-owner",
        concreteKind: ScopedPerson.kind,
      });
      const batch = vi.spyOn(fixture.client, "batch");

      await expect(
        fixture.store.nodes.ScopedEmployee.bulkInsert([
          {
            id: "sibling",
            props: { email: "sibling@example.com" },
          },
          {
            id: "conflict",
            props: { email: "legacy@example.com" },
          },
        ]),
      ).rejects.toMatchObject({
        name: UniquenessError.name,
        details: {
          constraintName: "scoped_email",
          existingId: "legacy-owner",
        },
      });

      expect(batch).toHaveBeenCalledOnce();
      await expect(fixture.store.nodes.ScopedEmployee.count()).resolves.toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("folds search projections into the atomic batch", async () => {
    const fixture = await createFallbackFixture();
    try {
      const transaction = vi.spyOn(fixture.backend, "transaction");
      const batch = vi.spyOn(fixture.client, "batch");

      await fixture.store.nodes.SearchDocument.bulkInsert([
        { id: "search-a", props: { title: "Alice" } },
      ]);

      expect(transaction).not.toHaveBeenCalled();
      expect(batch).toHaveBeenCalledOnce();
      await expect(
        fixture.store.search.fulltext("SearchDocument", {
          query: "Alice",
          limit: 10,
        }),
      ).resolves.toHaveLength(1);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("resurrects a projected caller id with its incremented postimage version", async () => {
    const fixture = await createFallbackFixture();
    try {
      await fixture.store.nodes.SearchDocument.bulkInsert([
        { id: "projected-tombstone", props: { title: "Before" } },
      ]);
      await fixture.store.nodes.SearchDocument.delete(
        "projected-tombstone" as never,
      );
      const batch = vi.spyOn(fixture.client, "batch");

      await fixture.store.nodes.SearchDocument.bulkInsert([
        { id: "projected-tombstone", props: { title: "After" } },
      ]);

      expect(batch).toHaveBeenCalledOnce();
      await expect(
        fixture.store.nodes.SearchDocument.getById(
          "projected-tombstone" as never,
        ),
      ).resolves.toMatchObject({ title: "After", meta: { version: 2 } });
      await expect(
        fixture.store.search.fulltext("SearchDocument", {
          query: "After",
          limit: 10,
        }),
      ).resolves.toHaveLength(1);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("asserts projected postimages by their complete heterogeneous identity", async () => {
    const fixture = await createFallbackFixture();
    try {
      const executor = resolveBundledRootAtomicNodeBatch(fixture.backend);
      if (executor === undefined) {
        throw new Error("Expected a bundled atomic node batch executor");
      }

      await expect(
        executor({
          entries: [
            {
              idSource: "caller",
              params: {
                graphId: fallbackGraph.id,
                kind: "SearchDocument",
                id: "search-identity",
                props: { title: "Search" },
              },
              projections: [
                {
                  kind: "fulltext",
                  action: "upsert",
                  content: "Search",
                  language: "english",
                },
              ],
            },
            {
              idSource: "caller",
              params: {
                graphId: fallbackGraph.id,
                kind: "LegacySearchDocument",
                id: "legacy-identity",
                props: { title: "Legacy" },
              },
              projections: [
                {
                  kind: "fulltext",
                  action: "upsert",
                  content: "Legacy",
                  language: "english",
                },
              ],
            },
          ],
          resultMode: "count",
          schemaFence: { graphId: fallbackGraph.id, expectedVersion: 1 },
        }),
      ).resolves.toBe(2);

      await expect(
        fixture.backend.getNode(
          fallbackGraph.id,
          "LegacySearchDocument",
          "legacy-identity",
        ),
      ).resolves.toMatchObject({ kind: "LegacySearchDocument" });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("treats a projection assertion primary-key collision as refusal", async () => {
    const fixture = await createFallbackFixture();
    try {
      const executor = resolveBundledRootAtomicNodeBatch(fixture.backend);
      if (executor === undefined) {
        throw new Error("Expected a bundled atomic node batch executor");
      }
      vi.spyOn(fixture.client, "batch").mockRejectedValueOnce(
        Object.assign(new Error("primary key collision"), {
          code: "SQLITE_CONSTRAINT_PRIMARYKEY",
        }),
      );

      await expect(
        executor({
          entries: [
            {
              idSource: "caller",
              params: {
                graphId: fallbackGraph.id,
                kind: "SearchDocument",
                id: "assertion-collision",
                props: { title: "Collision" },
              },
              projections: [
                {
                  kind: "fulltext",
                  action: "upsert",
                  content: "Collision",
                  language: "english",
                },
              ],
            },
          ],
          resultMode: "count",
          schemaFence: { graphId: fallbackGraph.id, expectedVersion: 1 },
        }),
      ).resolves.toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("folds replacement search projections into a resolved update", async () => {
    const fixture = await createFallbackFixture();
    try {
      await fixture.store.nodes.SearchDocument.bulkInsert([
        { id: "search-update", props: { title: "Before" } },
      ]);
      expect(
        resolveBundledRootAtomicMutationPrograms(fixture.backend)?.updateNodes
          ?.projectionSupport,
      ).toEqual({ families: ["embedding", "fulltext"] });
      const transactionlessBackend = createSqliteBackend(fixture.db, {
        executionProfile: { isSync: false, transactionMode: "none" },
        vector: libsqlVectorStrategy,
      });
      const [root] = await createVerifiedStore(
        fallbackGraph,
        transactionlessBackend,
      );
      const batch = vi.spyOn(fixture.client, "batch");
      const variants: string[] = [];

      await withAtomicMutationProgramDispatchObserver(
        transactionlessBackend,
        (variant) => variants.push(variant),
        () =>
          root.nodes.SearchDocument.update("search-update" as never, {
            title: "After",
          }),
      );

      expect(batch).toHaveBeenCalledOnce();
      await expect(
        fixture.store.search.fulltext("SearchDocument", {
          query: "Before",
          limit: 10,
        }),
      ).resolves.toHaveLength(0);
      await expect(
        fixture.store.search.fulltext("SearchDocument", {
          query: "After",
          limit: 10,
        }),
      ).resolves.toHaveLength(1);

      await withAtomicMutationProgramDispatchObserver(
        transactionlessBackend,
        (variant) => variants.push(variant),
        () =>
          root.nodes.SearchDocument.update("search-update" as never, {
            title: "",
          }),
      );

      expect(batch).toHaveBeenCalledTimes(2);
      expect(variants).toEqual(["updateNodes", "updateNodes"]);
      await expect(
        fixture.store.search.fulltext("SearchDocument", {
          query: "After",
          limit: 10,
        }),
      ).resolves.toHaveLength(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("folds embedding creates and replacements into atomic programs", async () => {
    const fixture = await createFallbackFixture();
    try {
      await fixture.store.nodes.VectorDocument.bulkInsert([
        { id: "vector-target", props: { vector: [1, 0] } },
        { id: "vector-anchor", props: { vector: [0, 1] } },
      ]);
      const initial = await fixture.store.search.vector("VectorDocument", {
        fieldPath: "vector",
        queryEmbedding: [1, 0],
        limit: 2,
      });
      expect(initial[0]?.node.id).toBe("vector-target");

      const transactionlessBackend = createSqliteBackend(fixture.db, {
        executionProfile: { isSync: false, transactionMode: "none" },
        vector: libsqlVectorStrategy,
      });
      const [root] = await createVerifiedStore(
        fallbackGraph,
        transactionlessBackend,
      );
      const batch = vi.spyOn(fixture.client, "batch");
      const variants: string[] = [];

      await withAtomicMutationProgramDispatchObserver(
        transactionlessBackend,
        (variant) => variants.push(variant),
        () =>
          root.nodes.VectorDocument.update("vector-target" as never, {
            vector: [-1, 0],
          }),
      );

      expect(batch).toHaveBeenCalledOnce();
      const replaced = await fixture.store.search.vector("VectorDocument", {
        fieldPath: "vector",
        queryEmbedding: [1, 0],
        limit: 2,
      });
      expect(replaced.map((hit) => hit.node.id)).toEqual([
        "vector-anchor",
        "vector-target",
      ]);

      await withAtomicMutationProgramDispatchObserver(
        transactionlessBackend,
        (variant) => variants.push(variant),
        () =>
          root.nodes.VectorDocument.update("vector-target" as never, {
            vector: undefined,
          }),
      );

      expect(batch).toHaveBeenCalledTimes(2);
      expect(variants).toEqual(["updateNodes", "updateNodes"]);
      const afterDelete = await fixture.store.search.vector("VectorDocument", {
        fieldPath: "vector",
        queryEmbedding: [1, 0],
        limit: 2,
      });
      expect(afterDelete.map((hit) => hit.node.id)).toEqual(["vector-anchor"]);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("folds projected creates and updates into one mixed mutation program", async () => {
    const fixture = await createFallbackFixture();
    try {
      await fixture.store.nodes.SearchDocument.bulkInsert([
        { id: "search-existing", props: { title: "Before" } },
      ]);
      const transactionlessBackend = createSqliteBackend(fixture.db, {
        executionProfile: { isSync: false, transactionMode: "none" },
      });
      const [root] = await createVerifiedStore(
        fallbackGraph,
        transactionlessBackend,
      );
      const batch = vi.spyOn(fixture.client, "batch");

      const rows = await root.nodes.SearchDocument.bulkUpsertById([
        { id: "search-new", props: { title: "Created" } },
        { id: "search-existing", props: { title: "Updated" } },
      ]);

      expect(batch).toHaveBeenCalledOnce();
      expect(rows.map((row) => [row.id, row.title])).toEqual([
        ["search-new", "Created"],
        ["search-existing", "Updated"],
      ]);
      await expect(
        fixture.store.search.fulltext("SearchDocument", {
          query: "Created OR Updated",
          limit: 10,
          mode: "raw",
        }),
      ).resolves.toHaveLength(2);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rolls projected sidecars back when the schema fence is stale", async () => {
    const fixture = await createFallbackFixture();
    try {
      await migrateSchema(fixture.backend, evolvedFallbackGraph, 1);

      await expect(
        fixture.store.nodes.SearchDocument.bulkInsert([
          { id: "stale-search", props: { title: "MustNotPersist" } },
        ]),
      ).rejects.toBeInstanceOf(StaleVersionError);
      await expect(
        fixture.store.search.fulltext("SearchDocument", {
          query: "MustNotPersist",
          limit: 10,
        }),
      ).resolves.toHaveLength(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("diagnoses stale projected updates and tombstone creates without primary-key masking", async () => {
    const fixture = await createFallbackFixture();
    try {
      await fixture.store.nodes.SearchDocument.bulkInsert([
        { id: "stale-live", props: { title: "Before" } },
        { id: "stale-tombstone", props: { title: "Deleted" } },
      ]);
      await fixture.store.nodes.SearchDocument.delete(
        "stale-tombstone" as never,
      );
      await migrateSchema(fixture.backend, evolvedFallbackGraph, 1);

      await expect(
        fixture.store.nodes.SearchDocument.update("stale-live" as never, {
          title: "After",
        }),
      ).rejects.toBeInstanceOf(StaleVersionError);
      await expect(
        fixture.store.nodes.SearchDocument.bulkInsert([
          { id: "stale-tombstone", props: { title: "Resurrected" } },
        ]),
      ).rejects.toBeInstanceOf(StaleVersionError);
      await expect(
        fixture.store.search.fulltext("SearchDocument", {
          query: "After OR Resurrected",
          limit: 10,
          mode: "raw",
        }),
      ).resolves.toHaveLength(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("refuses missing projection storage without persisting its node", async () => {
    const fixture = await createFallbackFixture();
    try {
      await fixture.client.execute(
        `DROP TABLE ${sqliteTables.fulltextTableName}`,
      );

      await expect(
        fixture.store.nodes.SearchDocument.bulkInsert([
          { id: "missing-sidecar", props: { title: "Unavailable" } },
        ]),
      ).rejects.toBeInstanceOf(ContributionUnavailableError);
      await expect(fixture.store.nodes.SearchDocument.count()).resolves.toBe(0);
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
      const batchClaimProbe = vi.spyOn(fixture.backend, "checkUniqueBatch");
      const scalarClaimProbe = vi.spyOn(fixture.backend, "checkUnique");

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
      expect(batchClaimProbe).toHaveBeenCalledOnce();
      expect(scalarClaimProbe).not.toHaveBeenCalled();
      // The transport-level sentinel rolls every chunk back first. The two
      // failure-only reads then distinguish a current fence from the exact
      // committed claim holder without letting client-side diagnosis authorize
      // or partially commit the write.
      expect(execute).toHaveBeenCalledTimes(2);
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

  it("reports an honest terminal when committed claim state changed", async () => {
    const fixture = await createFallbackFixture();
    try {
      await fixture.store.nodes.UniquePerson.bulkInsert([
        { id: "moving-incumbent", props: { name: "Moving" } },
      ]);
      vi.spyOn(fixture.backend, "checkUniqueBatch").mockResolvedValue([]);

      const insertion = fixture.store.nodes.UniquePerson.bulkInsert([
        { id: "refused", props: { name: "Moving" } },
      ]);
      await expect(insertion).rejects.toBeInstanceOf(DatabaseOperationError);
      const rejection = await insertion.catch((error: unknown) => error);
      if (!(rejection instanceof DatabaseOperationError)) throw rejection;
      expect(rejection.message).toContain(
        "current schema-fence and claim state do not explain",
      );
      await expect(fixture.store.nodes.UniquePerson.count()).resolves.toBe(1);
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
