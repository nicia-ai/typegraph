import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  embedding,
  searchable,
} from "../../src";
import { createDoltliteBackend } from "../../src/backend/doltlite";
import { doltliteVec1Strategy } from "../../src/query/dialect/vector/doltlite-vec1-strategy";
import { type VectorSlot } from "../../src/query/dialect/vector-strategy";
import { renderSqlite, sql } from "../../src/query/sql-fragment";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe("DoltLite exact vec1 vectors", () => {
  it("uses Euclidean distance, not squared distance, and filters before pagination", async () => {
    const { connection, backend } = await createDoltliteBackend();
    cleanups.push(() => backend.close());
    const slot: VectorSlot = {
      graphId: "vectors",
      nodeKind: "Point",
      fieldPath: "position",
      dimensions: 2,
      metric: "l2",
      indexType: "none",
    };
    for (const table of doltliteVec1Strategy.ownedTables(slot))
      for (const ddl of table.createDdl) connection.exec(ddl);
    for (const [id, vector] of [
      ["near", [0, 0]],
      ["far", [3, 4]],
      ["farthest", [6, 8]],
    ] as const) {
      for (const statement of doltliteVec1Strategy.buildUpsert(
        slot,
        {
          graphId: "vectors",
          nodeKind: "Point",
          fieldPath: "position",
          dimensions: 2,
          metric: "l2",
          indexType: "none",
          nodeId: id,
          embedding: vector,
        },
        "2026-01-01T00:00:00.000Z",
      )) {
        const compiled = renderSqlite(statement);
        connection.prepare(compiled.sql).run(...compiled.params);
      }
    }
    const query = renderSqlite(
      doltliteVec1Strategy.buildSearch(
        slot,
        {
          graphId: "vectors",
          nodeKind: "Point",
          fieldPath: "position",
          dimensions: 2,
          metric: "l2",
          indexType: "none",
          queryEmbedding: [0, 0],
          limit: 1,
        },
        sql`SELECT 'far'`,
      ),
    );
    const rows = connection.prepare(query.sql).all(...query.params);
    expect(rows).toEqual([{ node_id: "far", score: 5 }]);
  });

  it("stores embeddings through the typed API and fuses vector/fulltext predicates", async () => {
    const Document = defineNode("Document", {
      schema: z.object({
        title: searchable(),
        position: embedding(2, { indexType: "none" }),
      }),
    });
    const graph = defineGraph({
      id: "doltlite_vector_store",
      nodes: { Document: { type: Document } },
      edges: {},
    });
    const { backend } = await createDoltliteBackend();
    cleanups.push(() => backend.close());
    const [store] = await createStoreWithSchema(graph, backend);
    await store.nodes.Document.create({
      title: "Graph database",
      position: [1, 0],
    });
    await store.nodes.Document.create({
      title: "Graph traversal",
      position: [0, 1],
    });
    const rows = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) => d.position.similarTo([1, 0], 1))
      .select((c) => ({ title: c.d.title }))
      .execute();
    expect(rows).toEqual([{ title: "Graph database" }]);
    const fused = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) =>
        d.$fulltext.matches("graph", 2).and(d.position.similarTo([1, 0], 2)),
      )
      .fuseWith({ k: 60 })
      .select((c) => ({ title: c.d.title }))
      .execute();
    expect(fused).toHaveLength(2);
  });

  it("refuses ANN index declarations instead of silently substituting a scan", async () => {
    const Document = defineNode("Document", {
      schema: z.object({ position: embedding(2) }),
    });
    const graph = defineGraph({
      id: "doltlite_ann_refusal",
      nodes: { Document: { type: Document } },
      edges: {},
    });
    const { backend } = await createDoltliteBackend();
    cleanups.push(() => backend.close());
    await expect(createStoreWithSchema(graph, backend)).rejects.toThrow(
      /index|hnsw|none/i,
    );
    expect(backend.capabilities.vector?.indexTypes).toEqual(["none"]);
  });
});
