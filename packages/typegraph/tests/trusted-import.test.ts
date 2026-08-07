import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  embedding,
  searchable,
  StaleVersionError,
  TrustedImportError,
} from "../src";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import type { GraphBackend, TrustedImportOptions } from "../src/backend/types";
import {
  exportGraph,
  exportGraphStream,
  FORMAT_VERSION,
  type GraphData,
  type GraphInterchangeChunk,
  trustedImportGraph,
  trustedImportGraphStream,
} from "../src/interchange";
import { requireDefined } from "../src/utils/presence";
import { createGate, type Gate } from "./concurrency-utils";
import { createTestBackend, createTestDatabase } from "./test-utils";

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

const identityTrustedGraph = defineGraph({
  id: "trusted_import_identity_test",
  nodes: { TrustedPerson: { type: Person } },
  edges: {
    trustedKnows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
  identity: { sameIdAcrossKinds: "fold" },
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

/**
 * A second graph on the SAME connection: the export side of the
 * serialized-connection guard tests, kept apart from the trusted import's own
 * graph id so each refusal names the store it actually refused.
 */
const bystanderGraph = defineGraph({
  id: "trusted_import_bystander",
  nodes: { TrustedPerson: { type: Person } },
  edges: {},
});

/**
 * A trusted chunk stream that parks after its header — the deterministic moment
 * at which the trusted import's single write transaction is open and its lease
 * on the connection is held, with a chunk still to come.
 *
 * Deliberately NOT an `exportGraphStream`, so it carries no source-backend mark:
 * only the lease can refuse anything here, which is what makes this a test of
 * the lease rather than of the pre-flight.
 */
async function* pausingTrustedChunks(
  paused: Gate,
  resume: Gate,
): AsyncIterable<GraphInterchangeChunk> {
  const { nodes, edges, ...header } = graphData([]);
  yield { type: "header", header };
  paused.open();
  await resume.opened;
  yield {
    type: "nodes",
    nodes: [
      { kind: "TrustedPerson", id: "paused-alice", properties: { name: "A" } },
    ],
  };
}

function expectReason(reason: string): unknown {
  const details: unknown = expect.objectContaining({ reason });
  return expect.objectContaining({
    code: "TRUSTED_IMPORT_ERROR",
    details,
  });
}

describe("trusted import", () => {
  it("forwards the managed schema identity through both import entrypoints", async () => {
    const backend = createTestBackend();
    const trustedImport = requireDefined(backend.trustedImport);
    const observedOptions: (TrustedImportOptions | undefined)[] = [];
    const observedBackend: GraphBackend = {
      ...backend,
      async trustedImport(fn, options) {
        observedOptions.push(options);
        return trustedImport(fn, options);
      },
    };
    const [store] = await createStoreWithSchema(trustedGraph, observedBackend);
    const empty = graphData([]);
    const { nodes, edges, ...header } = empty;

    await trustedImportGraph(store, empty);
    await trustedImportGraphStream(
      store,
      chunkStream([
        { type: "header", header },
        { type: "nodes", nodes },
        { type: "edges", edges },
      ]),
    );

    expect(observedOptions).toEqual([
      {
        schemaWrite: {
          graphId: trustedGraph.id,
          expectedVersion: 1,
        },
      },
      {
        schemaWrite: {
          graphId: trustedGraph.id,
          expectedVersion: 1,
        },
      },
    ]);
  });

  it("uses the managed schema identity to reject both stale import entrypoints", async () => {
    const backend = createTestBackend();
    const [staleStore] = await createStoreWithSchema(trustedGraph, backend);
    await staleStore.evolve(
      defineGraphExtension({
        nodes: {
          TrustedImportExtra: {
            properties: { label: { type: "string" } },
          },
        },
      }),
    );
    const empty = graphData([]);
    const { nodes, edges, ...header } = empty;

    await expect(trustedImportGraph(staleStore, empty)).rejects.toThrow(
      StaleVersionError,
    );
    await expect(
      trustedImportGraphStream(
        staleStore,
        chunkStream([
          { type: "header", header },
          { type: "nodes", nodes },
          { type: "edges", edges },
        ]),
      ),
    ).rejects.toThrow(StaleVersionError);
  });

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

  it("refuses a node whose validity window is inverted", async () => {
    // The trusted path skips schema validation for throughput, but a window of
    // negative width is a stream SHAPE fault: the row would be observable at no
    // `asOf` coordinate at all, and no later write repairs it (issue #398).
    const store = createStore(trustedGraph, createTestBackend());

    await expect(
      trustedImportGraph(
        store,
        graphData([
          {
            kind: "TrustedPerson",
            id: "alice",
            properties: { name: "Alice" },
            validFrom: "2026-01-01T00:00:00.000Z",
            validTo: "2021-01-01T00:00:00.000Z",
          },
        ]),
      ),
    ).rejects.toEqual(expectReason("invalid_stream"));

    expect(
      await store.nodes.TrustedPerson.getById(asNodeId<typeof Person>("alice")),
    ).toBeUndefined();
  });

  it("refuses an edge whose validity window is inverted", async () => {
    const store = createStore(trustedGraph, createTestBackend());

    await expect(
      trustedImportGraph(
        store,
        graphData(
          [
            {
              kind: "TrustedPerson",
              id: "alice",
              properties: { name: "Alice" },
            },
            { kind: "TrustedPerson", id: "bob", properties: { name: "Bob" } },
          ],
          [
            {
              kind: "trustedKnows",
              id: "edge-1",
              from: { kind: "TrustedPerson", id: "alice" },
              to: { kind: "TrustedPerson", id: "bob" },
              properties: { since: 2020 },
              validFrom: "2026-01-01T00:00:00.000Z",
              validTo: "2021-01-01T00:00:00.000Z",
            },
          ],
        ),
      ),
    ).rejects.toEqual(expectReason("invalid_stream"));

    expect(
      await store.edges.trustedKnows.getById(asEdgeId<typeof knows>("edge-1")),
    ).toBeUndefined();
    // The WHOLE stream is refused, not just the offending chunk: the nodes
    // streamed before the bad edge roll back with it, since the session runs
    // inside one transaction.
    expect(
      await store.nodes.TrustedPerson.getById(asNodeId<typeof Person>("alice")),
    ).toBeUndefined();
  });

  it.each([
    { name: "a missing millisecond field", validFrom: "2021-01-01T00:00:00Z" },
    {
      name: "a variable-width millisecond field",
      validFrom: "2021-01-01T00:00:00.1Z",
    },
    { name: "a non-UTC offset", validFrom: "2021-01-01T00:00:00.000+01:00" },
    { name: "a date-only value", validFrom: "2021-01-01" },
  ])("refuses a node whose validFrom states $name", async ({ validFrom }) => {
    // Trusted import never re-parses its stream, so this format check is the
    // only thing holding its timestamps to the shape everything downstream
    // assumes (issue #414). All four shapes pass `z.iso.datetime()`-style
    // leniency yet sort wrongly as TEXT against an `asOf` coordinate.
    const store = createStore(trustedGraph, createTestBackend());

    await expect(
      trustedImportGraph(
        store,
        graphData([
          {
            kind: "TrustedPerson",
            id: "alice",
            properties: { name: "Alice" },
            validFrom,
          },
        ]),
      ),
    ).rejects.toEqual(expectReason("invalid_stream"));

    expect(
      await store.nodes.TrustedPerson.getById(asNodeId<typeof Person>("alice")),
    ).toBeUndefined();
  });

  it.each([
    { field: "validFrom" as const, value: "2021-01-01" },
    { field: "validTo" as const, value: "2021-01-01T00:00:00Z" },
  ])(
    "names the offending $field, row, and value in the refusal",
    async ({ field, value }) => {
      // Each window field must report ITS OWN value, so a refusal points at the
      // timestamp to convert rather than at the row's other endpoint.
      const store = createStore(trustedGraph, createTestBackend());

      await expect(
        trustedImportGraph(
          store,
          graphData([
            {
              kind: "TrustedPerson",
              id: "alice",
              properties: { name: "Alice" },
              ...(field === "validFrom" ?
                { validFrom: value }
              : { validTo: value }),
            },
          ]),
        ),
      ).rejects.toThrow(
        `Non-canonical ${field} in trusted import: TrustedPerson "alice" states "${value}"`,
      );
    },
  );

  it("refuses a non-canonical edge window and rolls back the nodes already streamed", async () => {
    const store = createStore(trustedGraph, createTestBackend());

    await expect(
      trustedImportGraph(
        store,
        graphData(
          [
            {
              kind: "TrustedPerson",
              id: "alice",
              properties: { name: "Alice" },
            },
            { kind: "TrustedPerson", id: "bob", properties: { name: "Bob" } },
          ],
          [
            {
              kind: "trustedKnows",
              id: "edge-1",
              from: { kind: "TrustedPerson", id: "alice" },
              to: { kind: "TrustedPerson", id: "bob" },
              properties: { since: 2020 },
              validFrom: "2020-06-01T12:00:00.000Z",
              validTo: "2021-01-01T00:00:00Z",
            },
          ],
        ),
      ),
    ).rejects.toEqual(expectReason("invalid_stream"));

    // The WHOLE stream is refused: the nodes chunk that already committed
    // inside the session's transaction rolls back with the bad edge.
    expect(
      await store.edges.trustedKnows.getById(asEdgeId<typeof knows>("edge-1")),
    ).toBeUndefined();
    expect(
      await store.nodes.TrustedPerson.getById(asNodeId<typeof Person>("alice")),
    ).toBeUndefined();
    expect(
      await store.nodes.TrustedPerson.getById(asNodeId<typeof Person>("bob")),
    ).toBeUndefined();
  });

  it("accepts an absent and an explicitly open-left window", async () => {
    // `null` validFrom is a confirmed open-left window, not a timestamp, so the
    // canonical-format check must let it through untouched.
    const store = createStore(trustedGraph, createTestBackend());

    const result = await trustedImportGraph(
      store,
      graphData([
        { kind: "TrustedPerson", id: "absent", properties: { name: "Absent" } },
        {
          kind: "TrustedPerson",
          id: "open-left",
          properties: { name: "Open" },
          // eslint-disable-next-line unicorn/no-null -- the interchange format states an open-left window as null
          validFrom: null,
          validTo: "2021-01-01T00:00:00.000Z",
        },
      ]),
    );

    expect(result.nodes).toBe(2);
  });

  it("accepts a zero-width and a born-ended window", async () => {
    // Both round-trip the store's own output: a same-instant retraction emits
    // zero width, and a row created with only a `validTo` carries a stamped
    // lower bound it never asserted.
    const store = createStore(trustedGraph, createTestBackend());

    const result = await trustedImportGraph(
      store,
      graphData([
        {
          kind: "TrustedPerson",
          id: "zero-width",
          properties: { name: "Zero" },
          validFrom: "2021-01-01T00:00:00.000Z",
          validTo: "2021-01-01T00:00:00.000Z",
        },
        {
          kind: "TrustedPerson",
          id: "born-ended",
          properties: { name: "Ended" },
          validTo: "2021-01-01T00:00:00.000Z",
        },
      ]),
    );

    expect(result.nodes).toBe(2);
  });

  it("refuses identity-enabled targets even when the input has no assertions", async () => {
    const store = createStore(identityTrustedGraph, createTestBackend());

    await expect(trustedImportGraph(store, graphData([]))).rejects.toEqual(
      expectReason("identity_unsupported"),
    );
  });

  it("refuses in-memory identity data before inserting its nodes", async () => {
    const store = createStore(trustedGraph, createTestBackend());
    const data: GraphData = {
      ...graphData([
        { kind: "TrustedPerson", id: "alice", properties: { name: "Alice" } },
      ]),
      identity: {
        profile: "typegraph-identity-v1",
        mode: "state",
        assertions: [],
      },
    };

    await expect(trustedImportGraph(store, data)).rejects.toEqual(
      expectReason("invalid_stream"),
    );
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

describe("trusted import on a serialized connection", () => {
  // A trusted import holds ONE write transaction open for the whole stream, so
  // it is a long-lived import holder exactly like `importGraphStream` — but it
  // used to carry no guard at all: streaming an export from the same connection
  // into it reached the driver as a nested BEGIN, and an export opening while it
  // ran did the same in the other direction.

  it("refuses a snapshot export streamed into it from the same connection", async () => {
    const db = createTestDatabase();
    const sourceBackend = createSqliteBackend(db);
    const targetBackend = createSqliteBackend(db);
    const source = createStore(bystanderGraph, sourceBackend);
    const target = createStore(trustedGraph, targetBackend);
    await source.nodes.TrustedPerson.create({ name: "Alice" }, { id: "alice" });

    await expect(
      trustedImportGraphStream(target, exportGraphStream(source)),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT",
        graphId: trustedGraph.id,
        requested: "import-stream",
        heldBy: "export-snapshot",
      },
    });
    // Refused before the trusted session opened, so nothing was written.
    expect(await target.nodes.TrustedPerson.count()).toBe(0);
  });

  it("refuses an export snapshot that opens while it holds the connection", async () => {
    const db = createTestDatabase();
    const importBackend = createSqliteBackend(db);
    const exportBackend = createSqliteBackend(db);
    const target = createStore(trustedGraph, importBackend);
    // Left empty on purpose: trusted import requires globally empty node and
    // edge tables, so the export side can only be a store with no rows yet.
    const bystander = createStore(bystanderGraph, exportBackend);
    const paused = createGate();
    const resume = createGate();

    const importing = trustedImportGraphStream(
      target,
      pausingTrustedChunks(paused, resume),
    );
    await paused.opened;

    await expect(exportGraph(bystander)).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "INTERCHANGE_SERIALIZED_IMPORT_IN_PROGRESS",
        graphId: bystanderGraph.id,
        requested: "export-snapshot",
        heldBy: "import-stream",
      },
    });

    resume.open();
    expect(await importing).toEqual({ nodes: 1, edges: 0 });
    expect(await target.nodes.TrustedPerson.count()).toBe(1);

    // The lease is scoped to the running import: the export it refused
    // succeeds once the trusted session commits.
    const exported = await exportGraph(bystander);
    expect(exported.nodes).toEqual([]);
  });
});
