import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createAdapterStore,
  defineEdge,
  defineGraph,
  defineNode,
  EndpointNotFoundError,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { createStoreWithSchema, type Store } from "../src/store";
import { resolveAtomicEdgeConvergenceExecutor } from "../src/store/operations/atomic-mutation-program";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});

const durableGraph = defineGraph({
  id: "atomic-edge-convergence",
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

const constrainedGraph = defineGraph({
  id: "atomic-edge-convergence-constrained",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "one",
      matchIdentity: { name: "role", fields: ["role"] },
    },
  },
});

async function withLibsqlStore<T>(
  callback: (
    store: Awaited<
      ReturnType<typeof createStoreWithSchema<typeof durableGraph>>
    >[0],
    client: ReturnType<typeof createClient>,
    backend: Awaited<ReturnType<typeof createLibsqlBackend>>["backend"],
  ) => Promise<T>,
): Promise<T> {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "typegraph-atomic-edge-convergence-"),
  );
  const client = createClient({
    url: `file:${path.join(temporaryDirectory, "graph.db")}`,
  });
  const { backend } = await createLibsqlBackend(client);
  try {
    const [store] = await createStoreWithSchema(durableGraph, backend);
    return await callback(store, client, backend);
  } finally {
    await backend.close();
    client.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function withTransactionlessLibsqlStore<T>(
  callback: (
    store: Store<typeof durableGraph>,
    backend: ReturnType<typeof createSqliteBackend>,
    client: ReturnType<typeof createClient>,
    seedStore: Store<typeof durableGraph>,
  ) => Promise<T>,
): Promise<T> {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "typegraph-atomic-edge-convergence-none-"),
  );
  const client = createClient({
    url: `file:${path.join(temporaryDirectory, "graph.db")}`,
  });
  const { backend: installer, db } = await createLibsqlBackend(client);
  const backend = createSqliteBackend(db, {
    executionProfile: { isSync: false, transactionMode: "none" },
  });
  try {
    const [seedStore] = await createStoreWithSchema(durableGraph, installer);
    return await callback(
      createAdapterStore(durableGraph, backend, {
        reconciled: { graph: durableGraph, version: 1, hash: undefined },
      }),
      backend,
      client,
      seedStore,
    );
  } finally {
    await backend.close();
    await installer.close();
    client.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

describe("atomic durable bulk edge convergence", () => {
  it("uses one native batch for mixed create, found, and duplicate results", async () => {
    await withLibsqlStore(async (store, client) => {
      const from = await store.nodes.Person.create({ name: "Alice" });
      const to = await store.nodes.Company.create({ name: "Acme" });
      const found = await store.edges.worksAt.create(from, to, {
        role: "found",
      });
      const execute = vi.spyOn(client, "execute");
      const batch = vi.spyOn(client, "batch");
      const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints([
        { from, to, props: { role: "created" } },
        { from, to, props: { role: "found" } },
        { from, to, props: { role: "created" } },
      ]);

      expect(results.map((result) => result.action)).toEqual([
        "created",
        "found",
        "found",
      ]);
      expect(requireDefined(results[1]).edge.id).toBe(found.id);
      expect(requireDefined(results[2]).edge.id).toBe(
        requireDefined(results[0]).edge.id,
      );
      expect(requireDefined(results[2]).edge.role).toBe("created");
      expect(batch).toHaveBeenCalledOnce();
      expect(batch.mock.calls[0]?.[0]).toHaveLength(2);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  it("refuses a tombstoned winner atomically on a transactionless root", async () => {
    await withTransactionlessLibsqlStore(
      async (store, backend, client, seedStore) => {
        const from = await seedStore.nodes.Person.create({ name: "Alice" });
        const to = await seedStore.nodes.Company.create({ name: "Acme" });
        const tombstone = await seedStore.edges.worksAt.create(from, to, {
          role: "tombstoned",
        });
        await seedStore.edges.worksAt.delete(tombstone.id);

        const batch = vi.spyOn(client, "batch");
        const attempt = store.edges.worksAt.bulkGetOrCreateByEndpoints([
          { from, to, props: { role: "tombstoned" } },
          {
            from,
            to,
            props: { role: "new" },
          },
        ]);
        await expect(attempt).rejects.toBeInstanceOf(ConfigurationError);
        await expect(attempt).rejects.toMatchObject({
          name: "ConfigurationError",
          details: {
            code: "CONSTRAINT_WRITE_FENCE_UNSUPPORTED",
            constraint: "edgeMatchKeyConvergence",
            graphId: durableGraph.id,
          },
        });
        expect(batch).toHaveBeenCalledOnce();
        expect(batch.mock.calls[0]?.[0]).toHaveLength(2);

        const persistedTombstone = await backend.getEdge(
          durableGraph.id,
          tombstone.id,
        );
        expect(persistedTombstone).toBeDefined();
        expect(persistedTombstone?.deleted_at).not.toBeUndefined();
        await expect(store.edges.worksAt.find()).resolves.toEqual([]);
      },
    );
  });

  it("rolls back every member and classifies a missing endpoint", async () => {
    await withLibsqlStore(async (store) => {
      const from = await store.nodes.Person.create({ name: "Alice" });
      const to = await store.nodes.Company.create({ name: "Acme" });

      const attempt = store.edges.worksAt.bulkGetOrCreateByEndpoints([
        { from, to, props: { role: "valid" } },
        {
          from,
          to: { id: "missing-company", kind: "Company" },
          props: { role: "invalid" },
        },
      ]);
      await expect(attempt).rejects.toBeInstanceOf(EndpointNotFoundError);
      await expect(attempt).rejects.toMatchObject({
        name: "EndpointNotFoundError",
        code: "ENDPOINT_NOT_FOUND",
        details: {
          edgeKind: "worksAt",
          endpoint: "to",
          nodeKind: "Company",
          nodeId: "missing-company",
        },
      });

      await expect(
        store.edges.worksAt.findByEndpoints(from, to, {
          matchOn: ["role"],
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("refuses disabled durable identity before either convergence entry point dispatches", async () => {
    await withLibsqlStore(async (store, client, backend) => {
      const from = await store.nodes.Person.create({ name: "Alice" });
      const to = await store.nodes.Company.create({ name: "Acme" });
      const batch = vi.spyOn(client, "batch");
      const execute = vi.spyOn(client, "execute");
      const incapable = deriveBackend(backend, {
        capabilities: {
          ...backend.capabilities,
          durableEdgeMatchIdentity: false,
        },
      });
      const incapableStore = createAdapterStore(durableGraph, incapable, {
        reconciled: { graph: durableGraph, version: 1, hash: undefined },
      });

      await expect(
        incapableStore.edges.worksAt.getOrCreateByEndpoints(from, to, {
          role: "refused-single",
        }),
      ).rejects.toMatchObject({
        name: "ConfigurationError",
        details: {
          capability: "durableEdgeMatchIdentity",
          edgeKind: "worksAt",
        },
      });
      await expect(
        incapableStore.edges.worksAt.bulkGetOrCreateByEndpoints([
          { from, to, props: { role: "refused" } },
        ]),
      ).rejects.toMatchObject({
        name: "ConfigurationError",
        details: {
          capability: "durableEdgeMatchIdentity",
          edgeKind: "worksAt",
        },
      });
      expect(batch).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });
  });

  it("keeps unsupported convergence shapes on the fallback path", async () => {
    await withLibsqlStore(async (_store, _client, backend) => {
      const common = {
        backend,
        schemaVersion: 1,
        historyEnabled: false,
        revisionTrackingEnabled: false,
        kind: "worksAt",
        inputs: [{}],
        uniqueEntryCount: 1,
        matchOn: ["role"],
        ifExists: "return" as const,
      };

      expect(
        resolveAtomicEdgeConvergenceExecutor({
          ...common,
          graph: defineGraph({
            id: "atomic-edge-convergence-dynamic",
            nodes: durableGraph.nodes,
            edges: {
              worksAt: { type: worksAt, from: [Person], to: [Company] },
            },
          }),
        }),
      ).toBeUndefined();
      expect(
        resolveAtomicEdgeConvergenceExecutor({
          ...common,
          graph: constrainedGraph,
        }),
      ).toBeUndefined();
      expect(
        resolveAtomicEdgeConvergenceExecutor({
          ...common,
          graph: durableGraph,
          ifExists: "update",
          inputs: [{ validTo: "2025-01-01T00:00:00.000Z" }],
        }),
      ).toBeUndefined();
      expect(
        resolveAtomicEdgeConvergenceExecutor({
          ...common,
          graph: durableGraph,
          inputs: [{ validFrom: "2025-01-01T00:00:00.000Z" }],
        }),
      ).toBeUndefined();
      expect(
        resolveAtomicEdgeConvergenceExecutor({
          ...common,
          graph: durableGraph,
          backend: deriveBackend(backend, {}),
        }),
      ).toBeUndefined();

      await backend.transaction((transaction) => {
        expect(
          resolveAtomicEdgeConvergenceExecutor({
            ...common,
            backend: transaction,
            graph: durableGraph,
          }),
        ).toBeUndefined();
        return Promise.resolve();
      });
    });
  });

  it.each([
    ["history", true, false],
    ["revision tracking", false, true],
  ] as const)(
    "refuses durable convergence when %s is enabled",
    async (_label, historyEnabled, revisionTrackingEnabled) => {
      await withLibsqlStore((_store, _client, backend) => {
        expect(
          resolveAtomicEdgeConvergenceExecutor({
            backend,
            graph: durableGraph,
            schemaVersion: 1,
            historyEnabled,
            revisionTrackingEnabled,
            kind: "worksAt",
            matchOn: ["role"],
            inputs: [{}],
            uniqueEntryCount: 1,
            ifExists: "return",
          }),
        ).toBeUndefined();
        return Promise.resolve();
      });
    },
  );
});
