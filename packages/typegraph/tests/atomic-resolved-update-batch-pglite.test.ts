import { type SQL, sql as drizzleSql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildAtomicEdgeResolvedUpdateBatch } from "../src/backend/drizzle/operations/edges";
import { buildAtomicNodeResolvedUpdateBatch } from "../src/backend/drizzle/operations/nodes";
import { tables } from "../src/backend/drizzle/schema/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { rowPropsToObject } from "../src/backend/types";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { createStoreWithSchema } from "../src/store";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), score: z.number() }),
});
const knows = defineEdge("knows", {
  schema: z.object({ label: z.string() }),
});
const graph = defineGraph({
  id: "atomic-resolved-update-batch-pglite",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

function compile(query: SQL) {
  return new PgDialect().sqlToQuery(query);
}

describe("resolved update sets on a real PostgreSQL engine", () => {
  it("executes guarded node and edge set updates", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    try {
      const [store] = await createStoreWithSchema(graph, local.backend);
      const nodes = await store.nodes.Person.bulkCreate([
        { id: "a", props: { name: "A", score: 1 } },
        { id: "b", props: { name: "B", score: 2 } },
      ]);
      const edges = await store.edges.knows.bulkCreate([
        {
          id: "first",
          from: requireDefined(nodes[0]),
          to: requireDefined(nodes[1]),
          props: { label: "First" },
        },
        {
          id: "second",
          from: requireDefined(nodes[1]),
          to: requireDefined(nodes[0]),
          props: { label: "Second" },
        },
      ]);
      const nodeRows = await requireDefined(local.backend.getNodes)(
        graph.id,
        Person.kind,
        nodes.map((node) => node.id),
      );
      const edgeRows = await requireDefined(local.backend.getEdges)(
        graph.id,
        edges.map((edge) => edge.id),
      );
      const schemaFence = { graphId: graph.id, expectedVersion: 1 } as const;
      const timestamp = "2026-08-27T00:00:00.000Z";

      const nodeUpdate = compile(
        buildAtomicNodeResolvedUpdateBatch(
          tables,
          nodeRows.map((row) => ({
            graphId: row.graph_id,
            kind: row.kind,
            id: row.id,
            props: { ...rowPropsToObject(row.props), score: 10 },
            expectedVersion: row.version,
          })),
          timestamp,
          schemaFence,
          drizzleSql`FOR SHARE`,
        ),
      );
      const edgeUpdate = compile(
        buildAtomicEdgeResolvedUpdateBatch(
          tables,
          edgeRows.map((existing) => ({
            existing,
            props: {
              label: `${String(rowPropsToObject(existing.props)["label"])} updated`,
            },
          })),
          timestamp,
          schemaFence,
          drizzleSql`FOR SHARE`,
        ),
      );
      await local.client.query(nodeUpdate.sql, nodeUpdate.params);
      await local.client.query(edgeUpdate.sql, edgeUpdate.params);

      const updatedNodes = await store.nodes.Person.getByIds(
        nodes.map((node) => node.id),
      );
      const updatedEdges = await store.edges.knows.getByIds(
        edges.map((edge) => edge.id),
      );
      expect(updatedNodes.map((node) => requireDefined(node).score)).toEqual([
        10, 10,
      ]);
      expect(updatedEdges.map((edge) => requireDefined(edge).label)).toEqual([
        "First updated",
        "Second updated",
      ]);
    } finally {
      await local.backend.close();
    }
  });
});
