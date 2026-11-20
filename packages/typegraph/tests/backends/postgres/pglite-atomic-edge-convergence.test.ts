import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createAdapterStore,
  defineEdge,
  defineGraph,
  defineNode,
  EndpointNotFoundError,
  StaleVersionError,
} from "../../../src";
import { generatePostgresDDL } from "../../../src/backend/drizzle/ddl";
import type { AnyPgDatabase } from "../../../src/backend/drizzle/execution/postgres-execution";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { migrateSchema } from "../../../src/schema";
import { createStoreWithSchema } from "../../../src/store";

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
  id: "pglite-atomic-edge-convergence",
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

const reconciled = { graph, version: 1, hash: undefined } as const;
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
  edges: graph.edges,
});

type PendingQuery = Readonly<{
  sql: string;
  params: readonly unknown[];
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}>;

/**
 * Gives the Postgres execution adapter its HTTP batch shape while executing
 * each submitted query in one real PGlite transaction. This exercises the
 * same `query` + `transaction` contract as Neon HTTP without requiring a
 * network database in the unit suite.
 */
function createAtomicPgliteDatabase(client: PGlite): Readonly<{
  db: AnyPgDatabase;
  transaction: ReturnType<typeof vi.fn>;
}> {
  const pending: PendingQuery[] = [];
  const query = vi.fn(
    (sql: string, params: readonly unknown[] = []) =>
      new Promise<unknown>((resolve, reject) => {
        pending.push({ sql, params, resolve, reject });
      }),
  );
  const transaction = vi.fn(
    async (queries: readonly PromiseLike<readonly unknown[]>[]) => {
      const requests = pending.splice(0);
      if (requests.length !== queries.length) {
        throw new Error(
          `Atomic PGlite adapter queued ${requests.length} queries for ${queries.length} promises.`,
        );
      }
      try {
        const results = await client.transaction(async (transactionClient) => {
          const transactionResults: unknown[] = [];
          for (const request of requests) {
            transactionResults.push(
              await transactionClient.query(request.sql, [...request.params]),
            );
          }
          return transactionResults;
        });
        for (const [index, request] of requests.entries()) {
          request.resolve(results[index]);
        }
        return results;
      } catch (error) {
        for (const request of requests) {
          request.reject(error);
        }
        throw error;
      }
    },
  );
  const neonClient = Object.assign(vi.fn(), { query, transaction });
  const db = Object.assign(drizzlePglite(client), { $client: neonClient });
  return { db, transaction };
}

async function setupClient(): Promise<
  Readonly<{
    client: PGlite;
    backend: ReturnType<typeof createPostgresBackend>;
    seedStore: Awaited<
      ReturnType<typeof createStoreWithSchema<typeof graph>>
    >[0];
  }>
> {
  const client = await PGlite.create();
  await client.exec(generatePostgresDDL().join("\n\n"));
  const backend = createPostgresBackend(drizzlePglite(client), {
    vector: false,
  });
  const [seedStore] = await createStoreWithSchema(graph, backend);
  return { client, backend, seedStore };
}

describe("PostgreSQL atomic edge convergence", () => {
  it("executes mixed create, found, and duplicate rows in one real transaction", async () => {
    const { client, seedStore } = await setupClient();
    try {
      const from = await seedStore.nodes.Person.create({ name: "Alice" });
      const to = await seedStore.nodes.Company.create({ name: "Acme" });
      const found = await seedStore.edges.worksAt.create(from, to, {
        role: "found",
      });
      const { db, transaction } = createAtomicPgliteDatabase(client);
      const backend = createPostgresBackend(db, { vector: false });
      const store = createAdapterStore(graph, backend, { reconciled });

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
      expect(results[1]?.edge.id).toBe(found.id);
      expect(results[2]?.edge.id).toBe(results[0]?.edge.id);
      expect(results[2]?.edge.role).toBe("created");
      expect(transaction).toHaveBeenCalledOnce();
      expect(transaction.mock.calls[0]?.[0]).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("rolls back a tombstone refusal without persisting any batch member", async () => {
    const { client, seedStore } = await setupClient();
    try {
      const from = await seedStore.nodes.Person.create({ name: "Alice" });
      const to = await seedStore.nodes.Company.create({ name: "Acme" });
      const tombstone = await seedStore.edges.worksAt.create(from, to, {
        role: "tombstoned",
      });
      await seedStore.edges.worksAt.delete(tombstone.id);

      const { db, transaction } = createAtomicPgliteDatabase(client);
      const backend = createPostgresBackend(db, { vector: false });
      const store = createAdapterStore(graph, backend, { reconciled });

      await expect(
        store.edges.worksAt.bulkGetOrCreateByEndpoints([
          { from, to, props: { role: "tombstoned" } },
          { from, to, props: { role: "new" } },
        ]),
      ).rejects.toBeInstanceOf(ConfigurationError);
      expect(transaction).toHaveBeenCalledOnce();
      expect(transaction.mock.calls[0]?.[0]).toHaveLength(2);

      const rows = await client.query<{
        id: string;
        role: string;
        deleted_at: string | undefined;
      }>(
        'SELECT "id", "props"->>\'role\' AS "role", "deleted_at" FROM "typegraph_edges" WHERE "graph_id" = $1 ORDER BY "id"',
        [graph.id],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.id).toBe(tombstone.id);
      expect(rows.rows[0]?.role).toBe("tombstoned");
      expect(rows.rows[0]?.deleted_at).not.toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("rolls back valid PostgreSQL convergence members when an endpoint is missing", async () => {
    const { client, seedStore } = await setupClient();
    try {
      const from = await seedStore.nodes.Person.create({ name: "Alice" });
      const to = await seedStore.nodes.Company.create({ name: "Acme" });
      const { db, transaction } = createAtomicPgliteDatabase(client);
      const backend = createPostgresBackend(db, { vector: false });
      const store = createAdapterStore(graph, backend, { reconciled });

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
      expect(transaction).toHaveBeenCalledOnce();
      expect(transaction.mock.calls[0]?.[0]).toHaveLength(2);

      const rows = await client.query<{ id: string }>(
        'SELECT "id" FROM "typegraph_edges" WHERE "graph_id" = $1',
        [graph.id],
      );
      expect(rows.rows).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("diagnoses a stale PostgreSQL schema fence without writing", async () => {
    const {
      client,
      backend: migrationBackend,
      seedStore,
    } = await setupClient();
    try {
      const from = await seedStore.nodes.Person.create({ name: "Alice" });
      const to = await seedStore.nodes.Company.create({ name: "Acme" });
      await migrateSchema(migrationBackend, evolvedGraph, 1);

      const { db, transaction } = createAtomicPgliteDatabase(client);
      const backend = createPostgresBackend(db, { vector: false });
      const store = createAdapterStore(graph, backend, { reconciled });

      await expect(
        store.edges.worksAt.bulkGetOrCreateByEndpoints([
          { from, to, props: { role: "stale" } },
        ]),
      ).rejects.toBeInstanceOf(StaleVersionError);
      expect(transaction).toHaveBeenCalledOnce();
      expect(transaction.mock.calls[0]?.[0]).toHaveLength(2);

      const rows = await client.query<{ id: string }>(
        'SELECT "id" FROM "typegraph_edges" WHERE "graph_id" = $1',
        [graph.id],
      );
      expect(rows.rows).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
