import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  searchable,
  TrustedImportError,
} from "../src";
import type { GraphBackend } from "../src/backend/types";
import {
  FORMAT_VERSION,
  type GraphData,
  type GraphInterchangeChunk,
  trustedImportGraph,
  trustedImportGraphStream,
} from "../src/interchange";
import { createTestBackend } from "./test-utils";

const Person = defineNode("TrustedPerson", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("trustedKnows", {
  schema: z.object({ since: z.number() }),
});
const trustedGraph = defineGraph({
  id: "trusted_import_test",
  nodes: { TrustedPerson: { type: Person } },
  edges: {
    trustedKnows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
});

function graphData(
  nodes: GraphData["nodes"],
  edges: GraphData["edges"] = [],
): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "trusted import test" },
    nodes,
    edges,
  };
}

function* chunkStream(
  chunks: readonly GraphInterchangeChunk[],
): Iterable<GraphInterchangeChunk> {
  for (const chunk of chunks) yield chunk;
}

function expectReason(reason: string): unknown {
  const details: unknown = expect.objectContaining({ reason });
  return expect.objectContaining({
    code: "TRUSTED_IMPORT_ERROR",
    details,
  });
}

describe("trusted import", () => {
  it("loads trusted nodes and edges without property validation", async () => {
    const backend = createTestBackend();
    const store = createStore(trustedGraph, backend);
    const result = await trustedImportGraph(
      store,
      graphData(
        [
          { kind: "TrustedPerson", id: "alice", properties: { name: 42 } },
          { kind: "TrustedPerson", id: "bob", properties: { name: "Bob" } },
        ],
        [
          {
            kind: "trustedKnows",
            id: "knows-1",
            from: { kind: "TrustedPerson", id: "alice" },
            to: { kind: "TrustedPerson", id: "bob" },
            properties: { since: 2020 },
          },
        ],
      ),
    );

    expect(result).toEqual({ nodes: 2, edges: 1 });
    expect(
      await store.nodes.TrustedPerson.getById(asNodeId<typeof Person>("alice")),
    ).toMatchObject({ name: 42 });
    expect(
      await store.edges.trustedKnows.getById(asEdgeId<typeof knows>("knows-1")),
    ).toMatchObject({ since: 2020 });

    const indexes = await backend.executeRaw?.<{ index_count: number }>(
      `SELECT COUNT(*) AS index_count
         FROM sqlite_schema
        WHERE type = 'index'
          AND tbl_name IN ('typegraph_nodes', 'typegraph_edges')
          AND sql IS NOT NULL`,
      [],
    );
    expect(indexes?.[0]?.index_count).toBeGreaterThan(0);
  });

  it("rolls back data and index changes when a later chunk fails", async () => {
    const backend = createTestBackend();
    const store = createStore(trustedGraph, backend);
    const data = graphData([
      { kind: "TrustedPerson", id: "alice", properties: { name: "Alice" } },
    ]);
    const { nodes, edges, ...header } = data;

    await expect(
      trustedImportGraphStream(
        store,
        chunkStream([
          { type: "header", header },
          { type: "nodes", nodes },
          { type: "edges", edges },
          { type: "nodes", nodes: [] },
        ]),
      ),
    ).rejects.toEqual(expectReason("invalid_stream"));

    expect(
      await store.nodes.TrustedPerson.getById(asNodeId<typeof Person>("alice")),
    ).toBeUndefined();
  });

  it("refuses an identity chunk instead of dropping identity truth", async () => {
    const backend = createTestBackend();
    const store = createStore(trustedGraph, backend);
    const data = graphData([
      { kind: "TrustedPerson", id: "alice", properties: { name: "Alice" } },
    ]);
    const { nodes, edges, ...header } = data;

    await expect(
      trustedImportGraphStream(
        store,
        chunkStream([
          { type: "header", header },
          { type: "nodes", nodes },
          {
            type: "identity",
            assertions: [
              {
                id: "assertion-1",
                relation: "same",
                a: { kind: "TrustedPerson", id: "alice" },
                b: { kind: "TrustedPerson", id: "alias" },
                validFrom: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
          { type: "edges", edges },
        ]),
      ),
    ).rejects.toEqual(expectReason("invalid_stream"));

    expect(
      await store.nodes.TrustedPerson.getById(asNodeId<typeof Person>("alice")),
    ).toBeUndefined();
  });

  it("rolls back the complete import on a database constraint failure", async () => {
    const store = createStore(trustedGraph, createTestBackend());
    await expect(
      trustedImportGraph(
        store,
        graphData([
          {
            kind: "TrustedPerson",
            id: "duplicate",
            properties: { name: "First" },
          },
          {
            kind: "TrustedPerson",
            id: "duplicate",
            properties: { name: "Second" },
          },
        ]),
      ),
    ).rejects.toThrow();

    expect(
      await store.nodes.TrustedPerson.getById(
        asNodeId<typeof Person>("duplicate"),
      ),
    ).toBeUndefined();
  });

  it("rejects a database containing data for a different graph", async () => {
    const backend = createTestBackend();
    const existingGraph = defineGraph({
      id: "other_graph_in_trusted_import_database",
      nodes: { TrustedPerson: { type: Person } },
      edges: {},
    });
    await createStore(existingGraph, backend).nodes.TrustedPerson.create({
      name: "Existing",
    });
    const store = createStore(trustedGraph, backend);

    await expect(trustedImportGraph(store, graphData([]))).rejects.toEqual(
      expectReason("database_not_empty"),
    );
  });

  it("rejects backends without a native trusted-import path", async () => {
    const backend = createTestBackend();
    const unsupportedBackend: GraphBackend = new Proxy(backend, {
      get(target, property, receiver): unknown {
        if (property === "trustedImport") return undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    const store = createStore(trustedGraph, unsupportedBackend);

    await expect(trustedImportGraph(store, graphData([]))).rejects.toEqual(
      expectReason("backend_unsupported"),
    );
  });

  it.each([
    {
      name: "recorded history",
      reason: "history_unsupported",
      build: () =>
        createStore(trustedGraph, createTestBackend(), { history: true }),
    },
    {
      name: "revision tracking",
      reason: "revision_tracking_unsupported",
      build: () =>
        createStore(trustedGraph, createTestBackend(), {
          revisionTracking: true,
        }),
    },
  ])("rejects $name", async ({ build, reason }) => {
    await expect(trustedImportGraph(build(), graphData([]))).rejects.toEqual(
      expectReason(reason),
    );
  });

  it("rejects uniqueness sidecars", async () => {
    const node = defineNode("UniquePerson", {
      schema: z.object({ email: z.string() }),
    });
    const graph = defineGraph({
      id: "trusted_import_reject_uniqueness",
      nodes: {
        UniquePerson: {
          type: node,
          unique: [
            {
              name: "email_unique",
              fields: ["email"],
              scope: "kind",
              collation: "binary",
            },
          ],
        },
      },
      edges: {},
    });
    const store = createStore(graph, createTestBackend());
    await expect(trustedImportGraph(store, graphData([]))).rejects.toEqual(
      expectReason("uniqueness_unsupported"),
    );
  });

  it.each([
    {
      reason: "fulltext_unsupported",
      graph: defineGraph({
        id: "trusted_import_reject_fulltext",
        nodes: {
          SearchPerson: {
            type: defineNode("SearchPerson", {
              schema: z.object({ bio: searchable() }),
            }),
          },
        },
        edges: {},
      }),
    },
    {
      reason: "vector_unsupported",
      graph: defineGraph({
        id: "trusted_import_reject_vector",
        nodes: {
          VectorPerson: {
            type: defineNode("VectorPerson", {
              schema: z.object({ vector: embedding(3) }),
            }),
          },
        },
        edges: {},
      }),
    },
  ])("rejects $reason sidecars", async ({ graph, reason }) => {
    const store = createStore(graph, createTestBackend());
    await expect(trustedImportGraph(store, graphData([]))).rejects.toEqual(
      expectReason(reason),
    );
  });

  it("uses a specific public error type", async () => {
    const store = createStore(trustedGraph, createTestBackend());
    await store.nodes.TrustedPerson.create({ name: "Existing" });
    await expect(
      trustedImportGraph(store, graphData([])),
    ).rejects.toBeInstanceOf(TrustedImportError);
  });
});
