import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  EndpointNotFoundError,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { createStoreWithSchema } from "../src/store";
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

describe("atomic durable bulk edge convergence", () => {
  it("uses one native batch for mixed create, found, resurrection, and duplicates", async () => {
    await withLibsqlStore(async (store, client) => {
      const from = await store.nodes.Person.create({ name: "Alice" });
      const to = await store.nodes.Company.create({ name: "Acme" });
      const found = await store.edges.worksAt.create(from, to, {
        role: "found",
      });
      const tombstone = await store.edges.worksAt.create(from, to, {
        role: "resurrected",
      });
      await store.edges.worksAt.delete(tombstone.id);

      const execute = vi.spyOn(client, "execute");
      const batch = vi.spyOn(client, "batch");
      const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints([
        { from, to, props: { role: "created" } },
        { from, to, props: { role: "found" } },
        { from, to, props: { role: "resurrected" } },
        { from, to, props: { role: "created" } },
      ]);

      expect(results.map((result) => result.action)).toEqual([
        "created",
        "found",
        "resurrected",
        "found",
      ]);
      expect(requireDefined(results[1]).edge.id).toBe(found.id);
      expect(requireDefined(results[2]).edge.id).toBe(tombstone.id);
      expect(requireDefined(results[3]).edge.id).toBe(
        requireDefined(results[0]).edge.id,
      );
      expect(requireDefined(results[3]).edge.role).toBe("created");
      expect(batch).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
    });
  });

  it("rolls back every member and classifies a missing endpoint", async () => {
    await withLibsqlStore(async (store) => {
      const from = await store.nodes.Person.create({ name: "Alice" });
      const to = await store.nodes.Company.create({ name: "Acme" });

      await expect(
        store.edges.worksAt.bulkGetOrCreateByEndpoints([
          { from, to, props: { role: "valid" } },
          {
            from,
            to: { id: "missing-company", kind: "Company" },
            props: { role: "invalid" },
          },
        ]),
      ).rejects.toBeInstanceOf(EndpointNotFoundError);

      await expect(
        store.edges.worksAt.findByEndpoints(from, to, {
          matchOn: ["role"],
        }),
      ).resolves.toBeUndefined();
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
});
