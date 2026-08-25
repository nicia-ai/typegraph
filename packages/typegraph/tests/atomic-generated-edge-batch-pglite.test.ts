import { type SQL, sql as drizzleSql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildInsertEdgesBatchReturningWithSchemaFence,
  buildInsertEdgesBatchWithSchemaFence,
} from "../src/backend/drizzle/operations/edges";
import { buildInsertNodesBatchWithSchemaFence } from "../src/backend/drizzle/operations/nodes";
import { tables } from "../src/backend/drizzle/schema/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { createStoreWithSchema } from "../src/store";

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
  id: "atomic-generated-edge-batch-pglite",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: { worksAt: { type: worksAt, from: [Person], to: [Company] } },
});

function compile(query: SQL) {
  return new PgDialect().sqlToQuery(query);
}

describe("schema-fenced edge batches on a real PostgreSQL engine", () => {
  it("executes the Store fallback path against real PostgreSQL", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const from = await store.nodes.Person.create({ name: "Alice" });
      const to = await store.nodes.Company.create({ name: "Acme" });

      const created = await store.edges.worksAt.bulkCreate([
        { id: "edge-2", from, to, props: { role: "Designer" } },
        { id: "edge-1", from, to, props: { role: "Engineer" } },
      ]);
      expect(created.map((edge) => edge.id)).toEqual(["edge-2", "edge-1"]);

      await expect(
        store.edges.worksAt.bulkInsert([
          {
            from,
            to: { kind: "Company", id: "missing-company" },
            props: { role: "Unknown" },
          },
        ]),
      ).rejects.toMatchObject({
        details: { endpoint: "to", nodeId: "missing-company" },
      });
      await expect(store.edges.worksAt.count()).resolves.toBe(2);
    } finally {
      await backend.close();
    }
  });

  it("executes returning, stale-fence, and missing-endpoint statements", async () => {
    const { backend, client } = await createLocalPgliteBackend({
      vector: false,
    });
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const from = await store.nodes.Person.create({ name: "Alice" });
      const to = await store.nodes.Company.create({ name: "Acme" });
      const params = [
        {
          graphId: graph.id,
          id: "edge-2",
          kind: "worksAt",
          fromKind: "Person",
          fromId: from.id,
          toKind: "Company",
          toId: to.id,
          props: { role: "Designer" },
        },
        {
          graphId: graph.id,
          id: "edge-1",
          kind: "worksAt",
          fromKind: "Person",
          fromId: from.id,
          toKind: "Company",
          toId: to.id,
          props: { role: "Engineer" },
        },
      ] as const;
      const timestamp = "2026-08-25T00:00:00.000Z";
      const schemaFence = { graphId: graph.id, expectedVersion: 1 } as const;

      const nodeBatch = compile(
        buildInsertNodesBatchWithSchemaFence(
          tables,
          [
            {
              graphId: graph.id,
              kind: "Person",
              id: "batch-person",
              props: { name: "Batch Person" },
            },
          ],
          timestamp,
          schemaFence,
          drizzleSql`FOR SHARE`,
        ),
      );
      const insertedNodes = await client.query(nodeBatch.sql, nodeBatch.params);
      expect(insertedNodes.rows).toHaveLength(1);

      const returning = compile(
        buildInsertEdgesBatchReturningWithSchemaFence(
          tables,
          params,
          timestamp,
          schemaFence,
          drizzleSql`FOR SHARE`,
        ),
      );
      const inserted = await client.query<Record<string, unknown>>(
        returning.sql,
        returning.params,
      );
      expect(inserted.rows.map((row) => row["id"]).toSorted()).toEqual([
        "edge-1",
        "edge-2",
      ]);

      const stale = compile(
        buildInsertEdgesBatchWithSchemaFence(
          tables,
          [{ ...params[0], id: "stale-edge" }],
          timestamp,
          { graphId: graph.id, expectedVersion: 99 },
          drizzleSql`FOR SHARE`,
        ),
      );
      const staleResult = await client.query(stale.sql, stale.params);
      expect(staleResult.rows).toEqual([]);

      const missing = compile(
        buildInsertEdgesBatchWithSchemaFence(
          tables,
          [
            {
              ...params[0],
              id: "missing-edge",
              toId: "missing-company",
            },
          ],
          timestamp,
          schemaFence,
          drizzleSql`FOR SHARE`,
        ),
      );
      await expect(client.query(missing.sql, missing.params)).rejects.toThrow(
        /not-null constraint|null value/i,
      );
      await expect(store.edges.worksAt.count()).resolves.toBe(2);
    } finally {
      await backend.close();
    }
  });
});
