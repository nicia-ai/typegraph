/**
 * PostgreSQL-specific execution coverage for the resolved edge-update
 * postimage assertion. The assertion binds timestamp postimages through the
 * same column-aware conversion seam as the PostgreSQL mutation builders.
 */
import { type SQL, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildAssertAtomicEdgeMutationPostimages,
  buildAtomicEdgeResolvedUpdateBatch,
} from "../../../src/backend/drizzle/operations/edges";
import { createPostgresBackend, tables } from "../../../src/backend/postgres";
import { rowPropsToObject } from "../../../src/backend/types";
import {
  defineEdge,
  defineGraph,
  defineNode,
  searchable,
} from "../../../src/core";
import { StoreNotInitializedError } from "../../../src/errors";
import { createStoreWithSchema } from "../../../src/store";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", {
  schema: z.object({ label: z.string() }),
});
const SearchDocument = defineNode("SearchDocument", {
  schema: z.object({ title: searchable() }),
});
const graph = defineGraph({
  id: "postgres-atomic-resolved-update-batch",
  nodes: { Person: { type: Person }, SearchDocument: { type: SearchDocument } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

const pool = new Pool({ connectionString: TEST_DATABASE_URL });

function compile(query: SQL) {
  return new PgDialect().sqlToQuery(query);
}

afterAll(async () => {
  await pool.end();
});

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL resolved edge-update assertions",
  () => {
    it("accepts timestamp postimages for an update-only edge set", async () => {
      const backend = createPostgresBackend(drizzle(pool), { vector: false });
      const [store] = await createStoreWithSchema(graph, backend);
      const [from, to] = await store.nodes.Person.bulkCreate([
        { id: "from", props: { name: "From" } },
        { id: "to", props: { name: "To" } },
      ]);
      const edge = await store.edges.knows.create(
        requireDefined(from),
        requireDefined(to),
        { label: "Before" },
        { id: "updated-edge" },
      );
      const existing = requireDefined(await backend.getEdge(graph.id, edge.id));
      const timestamp = "2026-08-30T12:00:00.000Z";
      const updates = [
        {
          existing,
          props: { ...rowPropsToObject(existing.props), label: "After" },
        },
      ];
      const schemaFence = { graphId: graph.id, expectedVersion: 1 } as const;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const query of [
          buildAtomicEdgeResolvedUpdateBatch(
            tables,
            updates,
            timestamp,
            schemaFence,
            drizzleSql`FOR SHARE`,
          ),
          buildAssertAtomicEdgeMutationPostimages(
            tables,
            [],
            updates,
            timestamp,
            schemaFence,
          ),
        ]) {
          const compiled = compile(query);
          await client.query(compiled.sql, compiled.params);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      await expect(store.edges.knows.getById(edge.id)).resolves.toMatchObject({
        label: "After",
      });

      const missingPostimage = compile(
        buildAssertAtomicEdgeMutationPostimages(
          tables,
          [],
          [
            {
              existing: requireDefined(
                await backend.getEdge(graph.id, edge.id),
              ),
              props: { label: "Never written" },
            },
          ],
          "2026-08-30T13:00:00.000Z",
          schemaFence,
        ),
      );
      await expect(
        pool.query(missingPostimage.sql, missingPostimage.params),
      ).rejects.toMatchObject({ code: "23502" });
    });

    it("proves projection markers inside the atomic PostgreSQL program", async () => {
      const backend = createPostgresBackend(drizzle(pool), { vector: false });
      const [store] = await createStoreWithSchema(graph, backend);

      await store.nodes.SearchDocument.bulkInsert([
        { id: "projected-pg", props: { title: "Atomic evidence" } },
      ]);
      await expect(
        store.search.fulltext("SearchDocument", {
          query: "Atomic evidence",
          limit: 10,
        }),
      ).resolves.toHaveLength(1);

      await pool.query(
        `DELETE FROM typegraph_contribution_materializations WHERE graph_id = $1`,
        [graph.id],
      );
      await expect(
        store.nodes.SearchDocument.bulkInsert([
          { id: "missing-pg-marker", props: { title: "Must roll back" } },
        ]),
      ).rejects.toBeInstanceOf(StoreNotInitializedError);
      await expect(
        store.nodes.SearchDocument.getById("missing-pg-marker" as never),
      ).resolves.toBeUndefined();
    });
  },
);
