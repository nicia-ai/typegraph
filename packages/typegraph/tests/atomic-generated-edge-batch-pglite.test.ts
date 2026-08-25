import { type SQL, sql as drizzleSql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type AtomicEdgeBatchCountInput,
  type AtomicEdgeBatchRowsInput,
  markBundledRootAtomicEdgeBatch,
  resolveBundledRootAtomicEdgeBatch,
} from "../src/backend/capabilities/atomic-edge-batch";
import {
  buildInsertEdgesBatchReturningWithSchemaFence,
  buildInsertEdgesBatchWithSchemaFence,
} from "../src/backend/drizzle/operations/edges";
import { buildInsertNodesBatchWithSchemaFence } from "../src/backend/drizzle/operations/nodes";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { tables } from "../src/backend/drizzle/schema/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import type { EdgeRow } from "../src/backend/types";
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
  it("executes the Store bulk APIs through the native PostgreSQL program", async () => {
    const { backend: managedBackend, db } = await createLocalPgliteBackend({
      vector: false,
    });
    try {
      // The managed-close wrapper deliberately does not inherit exact-root
      // capabilities. Build the Store over the marked Postgres root and retain
      // the wrapper only as the owner of the PGlite client's lifecycle.
      const backend = createPostgresBackend(db, { vector: false });
      const nativeExecutor = resolveBundledRootAtomicEdgeBatch(backend);
      if (nativeExecutor === undefined) {
        throw new Error("Expected the bundled Postgres edge batch executor");
      }
      const observedResultModes: ("count" | "rows")[] = [];
      function observedNativeExecutor(
        input: AtomicEdgeBatchCountInput,
      ): Promise<number>;
      function observedNativeExecutor(
        input: AtomicEdgeBatchRowsInput,
      ): Promise<readonly EdgeRow[]>;
      async function observedNativeExecutor(
        input: AtomicEdgeBatchCountInput | AtomicEdgeBatchRowsInput,
      ): Promise<number | readonly EdgeRow[]> {
        observedResultModes.push(input.resultMode);
        if (input.resultMode === "rows") return nativeExecutor(input);
        return nativeExecutor(input);
      }
      markBundledRootAtomicEdgeBatch(backend, observedNativeExecutor);

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
      expect(observedResultModes).toEqual(["rows", "count"]);
      await expect(store.edges.worksAt.count()).resolves.toBe(2);
    } finally {
      await managedBackend.close();
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
