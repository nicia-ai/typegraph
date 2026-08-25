import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { StaleVersionError } from "../src";
import {
  type AtomicEdgeBatchExecutor,
  markBundledRootAtomicEdgeBatch,
} from "../src/backend/capabilities/atomic-edge-batch";
import { markBundledRootAutocommitEligible } from "../src/backend/capabilities/autocommit-single-statement";
import { deriveBackend } from "../src/backend/derive-backend";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { migrateSchema } from "../src/schema";
import type { Store } from "../src/store";
import { createStoreWithSchema } from "../src/store";
import { resolveAtomicEdgeBatchExecutor } from "../src/store/operations/atomic-edge-batch";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});
const graph = defineGraph({
  id: "atomic-generated-edge-batch",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: { worksAt: { type: worksAt, from: [Person], to: [Company] } },
});
const cardinalityGraph = defineGraph({
  id: "atomic-generated-edge-batch-cardinality",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "one",
    },
  },
});
const matchIdentityGraph = defineGraph({
  id: "atomic-generated-edge-batch-identity",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      matchIdentity: { name: "role", fields: ["role"] },
    },
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
    Company: { type: Company },
  },
  edges: { worksAt: { type: worksAt, from: [Person], to: [Company] } },
});

async function createEndpoints(store: Store<typeof graph>) {
  const from = await store.nodes.Person.create({ name: "Alice" });
  const to = await store.nodes.Company.create({ name: "Acme" });
  return { from, to };
}

async function createChunkedLibsqlBackend(
  client: Parameters<typeof createLibsqlBackend>[0],
) {
  const initialized = await createLibsqlBackend(client);
  await initialized.backend.close();
  return createSqliteBackend(initialized.db, {
    capabilities: { maxBindParameters: 100 },
    executionProfile: { isSync: false, transactionMode: "sql" },
  });
}

describe("generated edge batch store consumer", () => {
  it("selects the atomic executor only for the exact marked root", async () => {
    const backend = { capabilities: { transactions: false } } as GraphBackend;
    const executor = vi.fn(() =>
      Promise.resolve(1),
    ) as unknown as AtomicEdgeBatchExecutor;
    markBundledRootAutocommitEligible(backend);
    markBundledRootAtomicEdgeBatch(backend, executor);

    const input = {
      kind: "worksAt",
      fromKind: "Person",
      fromId: "person-1",
      toKind: "Company",
      toId: "company-1",
      props: { role: "Engineer" },
    } as const;
    expect(
      resolveAtomicEdgeBatchExecutor({
        backend,
        graph,
        inputs: [input],
        schemaVersion: 1,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      }),
    ).toBe(executor);
    expect(
      resolveAtomicEdgeBatchExecutor({
        backend: deriveBackend(backend, {}),
        graph,
        inputs: [input],
        schemaVersion: 1,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      }),
    ).toBeUndefined();

    const { backend: realBackend } = createLocalSqliteBackend();
    try {
      markBundledRootAutocommitEligible(realBackend);
      markBundledRootAtomicEdgeBatch(realBackend, executor);
      await realBackend.transaction(async (transactionBackend) => {
        expect(
          resolveAtomicEdgeBatchExecutor({
            backend: transactionBackend,
            graph,
            inputs: [input],
            schemaVersion: 1,
            historyEnabled: false,
            revisionTrackingEnabled: false,
          }),
        ).toBeUndefined();
        return transactionBackend
          .getNode(graph.id, "Person", "person-1")
          .then(() => void 0);
      });
    } finally {
      await realBackend.close();
    }
  });

  it.each([
    ["cardinality constraints", cardinalityGraph],
    ["durable match identity", matchIdentityGraph],
  ] as const)("falls back for %s", (_label, constrainedGraph) => {
    const backend = { capabilities: { transactions: false } } as GraphBackend;
    const executor = vi.fn(() =>
      Promise.resolve(1),
    ) as unknown as AtomicEdgeBatchExecutor;
    markBundledRootAutocommitEligible(backend);
    markBundledRootAtomicEdgeBatch(backend, executor);

    expect(
      resolveAtomicEdgeBatchExecutor({
        backend,
        graph: constrainedGraph,
        inputs: [
          {
            kind: "worksAt",
            fromKind: "Person",
            fromId: "person-1",
            toKind: "Company",
            toId: "company-1",
            props: { role: "Engineer" },
          },
        ],
        schemaVersion: 1,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      }),
    ).toBeUndefined();
  });

  it("uses one real libSQL exchange for bulkInsert and returns no edge payload", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-edge-batch-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const { backend } = await createLibsqlBackend(client);
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const { from, to } = await createEndpoints(store);
      const batch = vi.spyOn(client, "batch");

      await expect(
        store.edges.worksAt.bulkInsert([
          { from, to, props: { role: "Engineer" } },
          { from, to, props: { role: "Architect" } },
        ]),
      ).resolves.toBeUndefined();

      expect(batch).toHaveBeenCalledOnce();
      await expect(store.edges.worksAt.count()).resolves.toBe(2);
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("assembles bulkCreate rows in input order through one libSQL exchange", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-edge-create-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const { backend } = await createLibsqlBackend(client);
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const batch = vi.spyOn(client, "batch");

      const edges = await store.edges.worksAt.bulkCreate([
        { from: bob, to: acme, props: { role: "Designer" } },
        { from: alice, to: acme, props: { role: "Engineer" } },
      ]);

      expect(batch).toHaveBeenCalledOnce();
      expect(edges.map((edge) => edge.role)).toEqual(["Designer", "Engineer"]);
      expect(edges.map((edge) => edge.fromId)).toEqual([bob.id, alice.id]);
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("assembles bulkCreate rows in input order across native chunks", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-edge-create-chunks-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const backend = await createChunkedLibsqlBackend(client);
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const { from, to } = await createEndpoints(store);
      const batch = vi.spyOn(client, "batch");
      const items = Array.from({ length: 20 }, (_, index) => ({
        id: `ordered-edge-${19 - index}`,
        from,
        to,
        props: { role: `Role ${index}` },
      }));

      const edges = await store.edges.worksAt.bulkCreate(items);

      expect(batch).toHaveBeenCalledOnce();
      expect(batch.mock.calls[0]?.[0].length).toBeGreaterThan(1);
      expect(edges.map((edge) => edge.id)).toEqual(
        items.map((item) => item.id),
      );
      expect(edges.map((edge) => edge.role)).toEqual(
        items.map((item) => item.props.role),
      );
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rolls back bulkCreate rows when a later native chunk fails", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-edge-create-rollback-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const backend = await createChunkedLibsqlBackend(client);
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const { from, to } = await createEndpoints(store);
      const batch = vi.spyOn(client, "batch");
      const items = Array.from({ length: 20 }, (_, index) => ({
        id: index === 19 ? "create-edge-0" : `create-edge-${index}`,
        from,
        to,
        props: { role: `Role ${index}` },
      }));

      await expect(store.edges.worksAt.bulkCreate(items)).rejects.toThrow();

      expect(batch).toHaveBeenCalledOnce();
      expect(batch.mock.calls[0]?.[0].length).toBeGreaterThan(1);
      await expect(store.edges.worksAt.count()).resolves.toBe(0);
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rolls back an earlier libSQL chunk when a later chunk hits a duplicate id", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-edge-rollback-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const backend = await createChunkedLibsqlBackend(client);
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const { from, to } = await createEndpoints(store);
      const batch = vi.spyOn(client, "batch");
      const items = Array.from({ length: 80 }, (_, index) => ({
        id: index === 79 ? "edge-0" : `edge-${index}`,
        from,
        to,
        props: { role: `Role ${index}` },
      }));

      await expect(store.edges.worksAt.bulkInsert(items)).rejects.toThrow();

      expect(batch).toHaveBeenCalledOnce();
      expect(batch.mock.calls[0]?.[0].length).toBeGreaterThan(1);
      await expect(store.edges.worksAt.count()).resolves.toBe(0);
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rolls back an earlier libSQL chunk when a later chunk misses an endpoint", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-edge-endpoint-rollback-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const backend = await createChunkedLibsqlBackend(client);
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const { from, to } = await createEndpoints(store);
      const batch = vi.spyOn(client, "batch");
      const items = Array.from({ length: 80 }, (_, index) => ({
        id: `endpoint-edge-${index}`,
        from,
        to:
          index === 79 ?
            ({ kind: "Company", id: "missing-target" } as const)
          : to,
        props: { role: `Role ${index}` },
      }));

      await expect(store.edges.worksAt.bulkInsert(items)).rejects.toMatchObject(
        {
          details: {
            endpoint: "to",
            nodeId: "missing-target",
          },
        },
      );

      expect(batch).toHaveBeenCalledOnce();
      expect(batch.mock.calls[0]?.[0].length).toBeGreaterThan(1);
      await expect(store.edges.worksAt.count()).resolves.toBe(0);
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("preserves source-before-target missing-endpoint diagnostics", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      await expect(
        store.edges.worksAt.bulkInsert([
          {
            from: { kind: "Person", id: "missing-source" },
            to: { kind: "Company", id: "missing-target" },
            props: { role: "Unknown" },
          },
        ]),
      ).rejects.toMatchObject({
        details: { endpoint: "from", nodeId: "missing-source" },
      });
    } finally {
      await backend.close();
    }
  });

  it("does not replace an unrelated executor failure with endpoint diagnostics", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const driverFailure = new Error("connection closed");
      const executor = vi.fn(() =>
        Promise.reject(driverFailure),
      ) as unknown as AtomicEdgeBatchExecutor;
      markBundledRootAtomicEdgeBatch(backend, executor);

      await expect(
        store.edges.worksAt.bulkInsert([
          {
            from: { kind: "Person", id: "missing-source" },
            to: { kind: "Company", id: "missing-target" },
            props: { role: "Unknown" },
          },
        ]),
      ).rejects.toBe(driverFailure);
    } finally {
      await backend.close();
    }
  });

  it("does not persist a native batch when its schema fence is stale", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const { from, to } = await createEndpoints(store);
      await migrateSchema(backend, evolvedGraph, 1);

      await expect(
        store.edges.worksAt.bulkInsert([
          { from, to, props: { role: "Engineer" } },
        ]),
      ).rejects.toThrow(StaleVersionError);
      await expect(store.edges.worksAt.count()).resolves.toBe(0);
    } finally {
      await backend.close();
    }
  });

  it("rolls back the whole edge batch when a duplicate id fails", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const { from, to } = await createEndpoints(store);

      await expect(
        store.edges.worksAt.bulkInsert([
          { id: "duplicate-edge", from, to, props: { role: "Engineer" } },
          { id: "duplicate-edge", from, to, props: { role: "Manager" } },
        ]),
      ).rejects.toThrow();
      await expect(store.edges.worksAt.count()).resolves.toBe(0);
    } finally {
      await backend.close();
    }
  });

  it("uses the ordinary transaction path inside a transaction-scoped store", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const { from, to } = await createEndpoints(store);
      const transaction = vi.spyOn(backend, "transaction");

      await store.transaction(async (tx) => {
        await tx.edges.worksAt.bulkInsert([
          { from, to, props: { role: "Engineer" } },
        ]);
      });

      expect(transaction).toHaveBeenCalledOnce();
      await expect(store.edges.worksAt.count()).resolves.toBe(1);
    } finally {
      await backend.close();
    }
  });

  it("refuses the native edge program on a derived backend", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const derived = deriveBackend(backend, {});
      const [store] = await createStoreWithSchema(graph, derived);
      const { from, to } = await createEndpoints(store);
      await expect(
        store.edges.worksAt.bulkInsert([
          { from, to, props: { role: "Engineer" } },
        ]),
      ).resolves.toBeUndefined();
      await expect(store.edges.worksAt.count()).resolves.toBe(1);
    } finally {
      await backend.close();
    }
  });
});
