/**
 * Interchange Tests
 *
 * Tests that graphs can be exported and imported while preserving data integrity.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  StaleVersionError,
} from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import type { GraphBackend } from "../src/backend/types";
import {
  ConfigurationError,
  UniquenessError,
  ValidationError,
} from "../src/errors";
import {
  exportGraph,
  exportGraphStream,
  type GraphData,
  type GraphDataHeader,
  GraphDataSchema,
  type GraphInterchangeChunk,
  importGraph,
  importGraphStream,
  ImportOptionsSchema,
  InterchangeEdgeSchema,
  InterchangeNodeSchema,
} from "../src/interchange";
import { createStore, createStoreWithSchema } from "../src/store";
import { requireDefined } from "../src/utils/presence";
import {
  createGate,
  type Gate,
  raceTimeout,
  TIMEOUT_SENTINEL,
} from "./concurrency-utils";
import {
  createInitializedStore,
  createPlanCaptureBackend,
  createTestBackend,
} from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().optional(),
    age: z.number().int().positive().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    industry: z.string().optional(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startYear: z.number().int().optional(),
  }),
});

const knows = defineEdge("knows", {
  schema: z.object({
    since: z.string().optional(),
  }),
});

const testGraph = defineGraph({
  id: "interchange_test",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
});

type TestStore = ReturnType<typeof createStore<typeof testGraph>>;

// Same shape as testGraph, but with Operational Identity enabled — the target
// for identity interchange tests. `createInitializedStore` boots it because an
// identity-enabled graph needs the async schema-materialization path.
const identityGraph = defineGraph({
  id: "interchange_identity_test",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
  identity: { sameIdAcrossKinds: "fold" },
});

const identitySameBackendTargetGraph = defineGraph({
  id: "identity_same_backend_target",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
  identity: { sameIdAcrossKinds: "fold" },
});

/**
 * Same shape as `testGraph` under a different id: the import target when both
 * stores live on ONE SQLite connection.
 */
const sameHandleTargetGraph = defineGraph({
  id: "interchange_same_handle_target",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
});

const DelimitedPerson = defineNode("Person:x", {
  schema: z.object({ name: z.string() }),
});
const delimitedKnows = defineEdge("delimitedKnows", {
  schema: z.object({}),
});
const delimiterCollisionGraph = defineGraph({
  id: "interchange_delimiter_collision",
  nodes: {
    Person: { type: Person },
    "Person:x": { type: DelimitedPerson },
  },
  edges: {
    delimitedKnows: {
      type: delimitedKnows,
      from: [Person, DelimitedPerson],
      to: [Person, DelimitedPerson],
    },
  },
});

const CANONICAL_TIMESTAMP = "2024-01-01T00:00:00.000Z";

/** A header carrying an identity section, for hand-built stream chunks. */
const identityStreamHeader: GraphDataHeader = {
  formatVersion: "2.0",
  exportedAt: CANONICAL_TIMESTAMP,
  source: { type: "external" },
  identity: { profile: "typegraph-identity-v1", mode: "state" },
};

function sampleIdentityAssertion(): GraphData["identity"] {
  return {
    profile: "typegraph-identity-v1",
    mode: "state",
    assertions: [
      {
        id: "assertion-1",
        relation: "same",
        a: { kind: "Person", id: "person-1" },
        b: { kind: "Person", id: "person-2" },
        validFrom: CANONICAL_TIMESTAMP,
      },
    ],
  };
}

/**
 * Helper to create import options with defaults applied.
 */
function importOptions(
  overrides: Partial<z.input<typeof ImportOptionsSchema>>,
) {
  return ImportOptionsSchema.parse(overrides);
}

async function collectChunks(
  chunks: AsyncIterable<GraphInterchangeChunk>,
): Promise<GraphInterchangeChunk[]> {
  const collected: GraphInterchangeChunk[] = [];
  for await (const chunk of chunks) {
    collected.push(chunk);
  }
  return collected;
}

async function* chunkStream(
  chunks: readonly GraphInterchangeChunk[],
): AsyncIterable<GraphInterchangeChunk> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

/**
 * Makes the snapshot transaction's node reads fail once `deliveredReads` of
 * them have answered, so an export's producer fails MID-STREAM: chunks already
 * handed to the consumer, the read transaction still open, and the snapshot
 * registration still held.
 */
function failNodeReadsAfter(
  backend: GraphBackend,
  deliveredReads: number,
  error: unknown,
): void {
  const runTransaction = backend.transaction;
  const failing: GraphBackend["transaction"] = (run, options) => {
    let reads = 0;
    return runTransaction(
      (target) =>
        run({
          ...target,
          findNodesByKind: async (params) => {
            reads += 1;
            if (reads > deliveredReads) throw error;
            return target.findNodesByKind(params);
          },
        }),
      options,
    );
  };
  vi.spyOn(backend, "transaction").mockImplementation(failing);
}

/**
 * Replays chunks, parking the consumer between two of them: `paused` opens once
 * `pauseBefore` chunks have been delivered and the next is being asked for, and
 * nothing more is delivered until `resume` opens. That is the deterministic
 * mid-import moment — chunks committed, chunks still to come — at which a
 * snapshot export on the same connection must be refused.
 */
async function* pausingChunkStream(
  chunks: readonly GraphInterchangeChunk[],
  pauseBefore: number,
  paused: Gate,
  resume: Gate,
): AsyncIterable<GraphInterchangeChunk> {
  let delivered = 0;
  for (const chunk of chunks) {
    if (delivered === pauseBefore) {
      paused.open();
      await resume.opened;
    }
    delivered++;
    yield chunk;
  }
}

// ============================================================
// Round-Trip Tests
// ============================================================

describe("Interchange Round-Trip", () => {
  let sourceBackend: GraphBackend;
  let sourceStore: TestStore;

  beforeEach(() => {
    sourceBackend = createTestBackend();
    sourceStore = createStore(testGraph, sourceBackend);
  });

  it("exports and imports an empty graph", async () => {
    const exported = await exportGraph(sourceStore);

    expect(exported.nodes).toHaveLength(0);
    expect(exported.edges).toHaveLength(0);
    expect(exported.formatVersion).toBe("2.0");
    expect(exported.source.type).toBe("typegraph-export");

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(true);
    expect(result.nodes.created).toBe(0);
    expect(result.edges.created).toBe(0);
  });

  it("rejects importGraph writes from a stale managed Store", async () => {
    const backend = createTestBackend();
    const [staleStore] = await createStoreWithSchema(testGraph, backend);
    await staleStore.evolve(
      defineGraphExtension({
        nodes: {
          ImportExtra: { properties: { label: { type: "string" } } },
        },
      }),
    );
    const data: GraphData = {
      formatVersion: "1.0",
      exportedAt: new Date().toISOString(),
      source: { type: "external", description: "stale import regression" },
      nodes: [
        { kind: "Person", id: "too-late", properties: { name: "Alice" } },
      ],
      edges: [],
    };

    await expect(
      importGraph(staleStore, data, importOptions({ onConflict: "error" })),
    ).rejects.toThrow(StaleVersionError);
    await expect(staleStore.nodes.Person.count()).resolves.toBe(0);
  });

  it("streams bounded header, node, and edge chunks before importing them", async () => {
    const alice = await sourceStore.nodes.Person.create({ name: "Alice" });
    const bob = await sourceStore.nodes.Person.create({ name: "Bob" });
    const acme = await sourceStore.nodes.Company.create({ name: "Acme" });
    await sourceStore.edges.knows.create(alice, bob, { since: "2020" });
    await sourceStore.edges.worksAt.create(alice, acme, { role: "Engineer" });

    const chunks = await collectChunks(
      exportGraphStream(sourceStore, { batchSize: 1 }),
    );
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "header",
      "nodes",
      "nodes",
      "nodes",
      "edges",
      "edges",
    ]);
    expect(
      chunks
        .filter((chunk) => chunk.type === "nodes")
        .map((chunk) => chunk.nodes),
    ).toEqual([[expect.anything()], [expect.anything()], [expect.anything()]]);
    expect(
      chunks
        .filter((chunk) => chunk.type === "edges")
        .map((chunk) => chunk.edges),
    ).toEqual([[expect.anything()], [expect.anything()]]);

    const targetStore = createStore(testGraph, createTestBackend());
    const result = await importGraphStream(
      targetStore,
      exportGraphStream(sourceStore, { batchSize: 1 }),
      importOptions({ onConflict: "error" }),
    );

    expect(result).toMatchObject({
      success: true,
      nodes: { created: 3, updated: 0, skipped: 0 },
      edges: { created: 2, updated: 0, skipped: 0 },
      errors: [],
    });
    expect(await targetStore.nodes.Person.getById(alice.id)).toMatchObject({
      name: "Alice",
    });
  });

  it("rejects malformed streamed-chunk ordering before it writes later chunks", async () => {
    const [headerChunk] = await collectChunks(exportGraphStream(sourceStore));
    if (headerChunk?.type !== "header") {
      throw new Error("Expected the export stream to start with a header.");
    }
    const header = headerChunk.header;
    const targetStore = createStore(testGraph, createTestBackend());

    await expect(
      importGraphStream(
        targetStore,
        chunkStream([
          { type: "header", header },
          { type: "edges", edges: [] },
          { type: "nodes", nodes: [] },
        ]),
        importOptions({ onConflict: "error" }),
      ),
    ).rejects.toThrow("cannot emit nodes after edges");
  });

  it("rejects streams with missing or duplicate headers before importing rows", async () => {
    const [headerChunk] = await collectChunks(exportGraphStream(sourceStore));
    if (headerChunk?.type !== "header") {
      throw new Error("Expected the export stream to start with a header.");
    }
    const header = headerChunk.header;

    // Every chunk kind carries the same requirement, and each states it from
    // its own branch: a stream that opens with edges or with identity rows is
    // as headerless as one that opens with nodes, and must say so rather than
    // dereference the missing header or report the end-of-stream error instead.
    const headerless: readonly GraphInterchangeChunk[] = [
      { type: "nodes", nodes: [] },
      { type: "edges", edges: [] },
      { type: "identity", assertions: [] },
    ];
    for (const chunk of headerless) {
      await expect(
        importGraphStream(
          createStore(testGraph, createTestBackend()),
          chunkStream([chunk]),
          importOptions({ onConflict: "error" }),
        ),
      ).rejects.toThrow("must start with a header");
    }
    await expect(
      importGraphStream(
        createStore(testGraph, createTestBackend()),
        chunkStream([
          { type: "header", header },
          { type: "header", header },
        ]),
        importOptions({ onConflict: "error" }),
      ),
    ).rejects.toThrow("more than one header");
  });

  it("writes nothing for an empty chunk instead of opening a transaction for it", async () => {
    // An empty chunk is a no-op, not a write: taking a write transaction for
    // one would claim the connection's writer slot for a chunk with nothing in
    // it — exactly the contention the serialized-connection guards exist for.
    const [headerChunk] = await collectChunks(exportGraphStream(sourceStore));
    if (headerChunk?.type !== "header") {
      throw new Error("Expected the export stream to start with a header.");
    }
    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);
    const transaction = vi.spyOn(targetBackend, "transaction");

    const result = await importGraphStream(
      targetStore,
      chunkStream([
        { type: "header", header: headerChunk.header },
        { type: "nodes", nodes: [] },
        { type: "edges", edges: [] },
      ]),
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects streams that end before emitting a header", async () => {
    await expect(
      importGraphStream(
        createStore(testGraph, createTestBackend()),
        chunkStream([]),
        importOptions({ onConflict: "error" }),
      ),
    ).rejects.toThrow("ended before emitting a header");
  });

  it("aborts a streamed import on the first entity error unless best-effort is explicit", async () => {
    const alice = await sourceStore.nodes.Person.create({ name: "Alice" });
    const chunks = await collectChunks(exportGraphStream(sourceStore));
    const header = chunks[0];
    if (header?.type !== "header") throw new Error("Expected stream header.");
    const duplicate = chunks.find((chunk) => chunk.type === "nodes");
    if (duplicate?.type !== "nodes") throw new Error("Expected node chunk.");

    const targetStore = createStore(testGraph, createTestBackend());
    await expect(
      importGraphStream(
        targetStore,
        chunkStream([
          { type: "header", header: header.header },
          duplicate,
          duplicate,
        ]),
        importOptions({ onConflict: "error" }),
      ),
    ).rejects.toThrow("stream aborted after a chunk reported import errors");
    expect(await targetStore.nodes.Person.getById(alice.id)).toBeDefined();
  });

  it.each(["skip", "update"] as const)(
    "aggregates %s conflicts across streamed chunks",
    async (onConflict) => {
      await sourceStore.nodes.Person.create({ name: "Alice" });
      const chunks = await collectChunks(exportGraphStream(sourceStore));
      const [header, nodes] = chunks;
      if (header?.type !== "header" || nodes?.type !== "nodes") {
        throw new Error("Expected a header followed by a node chunk.");
      }

      const result = await importGraphStream(
        createStore(testGraph, createTestBackend()),
        chunkStream([header, nodes, nodes]),
        importOptions({ onConflict }),
      );

      expect(result.success).toBe(true);
      expect(result.nodes.created).toBe(1);
      expect(result.nodes[onConflict === "skip" ? "skipped" : "updated"]).toBe(
        1,
      );
    },
  );

  it("warns without failing when streamed-import statistics refresh fails", async () => {
    // The stream carries a node chunk AND an edge chunk: every per-chunk import
    // passes `refreshStatistics: false`, so the whole stream refreshes ONCE,
    // after the last chunk — a per-chunk refresh would re-analyze (and re-warn)
    // for every chunk of a bulk load.
    const alice = await sourceStore.nodes.Person.create({ name: "Alice" });
    const bob = await sourceStore.nodes.Person.create({ name: "Bob" });
    await sourceStore.edges.knows.create(alice, bob, { since: "2024" });
    const targetStore = createStore(testGraph, createTestBackend());
    const refreshError = new Error("planner unavailable");
    const refreshStatistics = vi
      .spyOn(targetStore, "refreshStatistics")
      .mockRejectedValue(refreshError);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => false);

    try {
      const result = await importGraphStream(
        targetStore,
        exportGraphStream(sourceStore),
        importOptions({ onConflict: "error" }),
      );

      expect(result.success).toBe(true);
      expect(refreshStatistics).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("importGraphStream committed its rows"),
        refreshError,
      );
    } finally {
      refreshStatistics.mockRestore();
      warn.mockRestore();
    }
  });

  it("preserves nodes after round-trip", async () => {
    const alice = await sourceStore.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
      age: 30,
    });
    const bob = await sourceStore.nodes.Person.create({
      name: "Bob",
      age: 25,
    });
    const acme = await sourceStore.nodes.Company.create({
      name: "Acme Corp",
      industry: "Technology",
    });

    const exported = await exportGraph(sourceStore);

    expect(exported.nodes).toHaveLength(3);

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(true);
    expect(result.nodes.created).toBe(3);

    const importedAlice = await targetStore.nodes.Person.getById(alice.id);
    const importedBob = await targetStore.nodes.Person.getById(bob.id);
    const importedAcme = await targetStore.nodes.Company.getById(acme.id);

    expect(importedAlice).toBeDefined();
    expect(importedAlice?.name).toBe("Alice");
    expect(importedAlice?.email).toBe("alice@example.com");
    expect(importedAlice?.age).toBe(30);

    expect(importedBob).toBeDefined();
    expect(importedBob?.name).toBe("Bob");
    expect(importedBob?.age).toBe(25);
    expect(importedBob?.email).toBeUndefined();

    expect(importedAcme).toBeDefined();
    expect(importedAcme?.name).toBe("Acme Corp");
    expect(importedAcme?.industry).toBe("Technology");
  });

  it("preserves edges after round-trip", async () => {
    const alice = await sourceStore.nodes.Person.create({ name: "Alice" });
    const bob = await sourceStore.nodes.Person.create({ name: "Bob" });
    const acme = await sourceStore.nodes.Company.create({ name: "Acme Corp" });

    const aliceWorksAt = await sourceStore.edges.worksAt.create(alice, acme, {
      role: "Engineer",
      startYear: 2020,
    });
    const bobWorksAt = await sourceStore.edges.worksAt.create(bob, acme, {
      role: "Manager",
    });
    const aliceKnowsBob = await sourceStore.edges.knows.create(alice, bob, {
      since: "2019",
    });

    const exported = await exportGraph(sourceStore);

    expect(exported.nodes).toHaveLength(3);
    expect(exported.edges).toHaveLength(3);

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(true);
    expect(result.edges.created).toBe(3);

    const importedAliceWorksAt = await targetStore.edges.worksAt.getById(
      aliceWorksAt.id,
    );
    const importedBobWorksAt = await targetStore.edges.worksAt.getById(
      bobWorksAt.id,
    );
    const importedAliceKnowsBob = await targetStore.edges.knows.getById(
      aliceKnowsBob.id,
    );

    expect(importedAliceWorksAt).toBeDefined();
    expect(importedAliceWorksAt?.role).toBe("Engineer");
    expect(importedAliceWorksAt?.startYear).toBe(2020);
    expect(importedAliceWorksAt?.fromId).toBe(alice.id);
    expect(importedAliceWorksAt?.toId).toBe(acme.id);

    expect(importedBobWorksAt).toBeDefined();
    expect(importedBobWorksAt?.role).toBe("Manager");
    expect(importedBobWorksAt?.startYear).toBeUndefined();

    expect(importedAliceKnowsBob).toBeDefined();
    expect(importedAliceKnowsBob?.since).toBe("2019");
    expect(importedAliceKnowsBob?.fromId).toBe(alice.id);
    expect(importedAliceKnowsBob?.toId).toBe(bob.id);
  });

  it("preserves node IDs exactly", async () => {
    const customId = "my-custom-uuid-12345";
    await sourceStore.nodes.Person.create(
      { name: "Custom ID" },
      { id: customId },
    );

    const exported = await exportGraph(sourceStore);
    const exportedNode = exported.nodes.find((n) => n.id === customId);
    expect(exportedNode).toBeDefined();

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    const imported = await targetStore.nodes.Person.getById(customId as never);
    expect(imported).toBeDefined();
    expect(imported?.id).toBe(customId);
  });
});

// ============================================================
// Export Options Tests
// ============================================================

describe("Export Options", () => {
  let backend: GraphBackend;
  let store: TestStore;

  beforeEach(async () => {
    backend = createTestBackend();
    store = createStore(testGraph, backend);

    await store.nodes.Person.create({ name: "Alice" });
    await store.nodes.Person.create({ name: "Bob" });
    await store.nodes.Company.create({ name: "Acme Corp" });
  });

  it("filters by nodeKinds", async () => {
    const exported = await exportGraph(store, {
      nodeKinds: ["Person"],
    });

    expect(exported.nodes).toHaveLength(2);
    expect(exported.nodes.every((n) => n.kind === "Person")).toBe(true);
  });

  it("filters by edgeKinds", async () => {
    const people = await store.nodes.Person.find();
    const companies = await store.nodes.Company.find();

    const alice = requireDefined(people[0]);
    const bob = requireDefined(people[1]);
    const acme = requireDefined(companies[0]);

    await store.edges.worksAt.create(alice, acme, { role: "Engineer" });
    await store.edges.knows.create(alice, bob, {});

    const exported = await exportGraph(store, {
      edgeKinds: ["worksAt"],
    });

    expect(exported.edges).toHaveLength(1);
    expect(exported.edges[0]?.kind).toBe("worksAt");
  });

  it("includes metadata when includeMeta is true", async () => {
    const exported = await exportGraph(store, {
      includeMeta: true,
    });

    for (const node of exported.nodes) {
      expect(node.meta).toBeDefined();
      expect(node.meta?.version).toBeDefined();
      expect(node.meta?.createdAt).toBeDefined();
    }
  });

  it("excludes metadata by default", async () => {
    const exported = await exportGraph(store);

    for (const node of exported.nodes) {
      expect(node.meta).toBeUndefined();
    }
  });

  it("includes an explicit validFrom when includeTemporal is true", async () => {
    const exported = await exportGraph(store, { includeTemporal: true });

    for (const node of exported.nodes) {
      // Every node here was created via the collection API, so validFrom
      // always defaults to a real creation timestamp (#240) — never null.
      expect(typeof node.validFrom).toBe("string");
    }
  });

  it("omits validFrom entirely by default (includeTemporal: false)", async () => {
    const exported = await exportGraph(store);

    for (const node of exported.nodes) {
      expect(node.validFrom).toBeUndefined();
    }
  });

  it("round-trips a legacy row with no lower bound (valid_from = NULL) as explicit null, not a re-stamped timestamp", async () => {
    // Regression test: a row predating the #240 fix (or written directly
    // via the backend, bypassing the collection API, which can no longer
    // produce NULL) has valid_from = NULL — "valid since forever". A
    // faithful includeTemporal: true export/import must preserve that
    // open-left window, not silently narrow it to the import's own
    // creation timestamp.
    const legacy = await backend.insertNode({
      graphId: store.graphId,
      kind: "Person",
      id: "legacy-null-validfrom",
      props: { name: "Legacy" },
      // eslint-disable-next-line unicorn/no-null -- simulates a pre-#240 row
      validFrom: null,
    });
    expect(legacy.valid_from).toBeUndefined();

    const exported = await exportGraph(store, { includeTemporal: true });
    const legacyExport = exported.nodes.find((n) => n.id === legacy.id);
    expect(legacyExport?.validFrom).toBeNull();

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);
    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );
    expect(result.success).toBe(true);

    const ancientAsOf = "1900-01-01T00:00:00.000Z";
    const importedLegacy = await targetStore.nodes.Person.getById(
      legacy.id as never,
      { temporalMode: "asOf", asOf: ancientAsOf },
    );
    expect(importedLegacy).toBeDefined();
    expect(importedLegacy?.meta.validFrom).toBeUndefined();
  });
});

// ============================================================
// Import Conflict Strategy Tests
// ============================================================

describe("Import Conflict Strategies", () => {
  let sourceBackend: GraphBackend;
  let sourceStore: TestStore;
  let exported: GraphData;

  beforeEach(async () => {
    sourceBackend = createTestBackend();
    sourceStore = createStore(testGraph, sourceBackend);

    await sourceStore.nodes.Person.create(
      { name: "Alice", age: 30 },
      { id: "person-1" },
    );

    exported = await exportGraph(sourceStore);
  });

  it("skips existing nodes with onConflict: skip", async () => {
    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    await targetStore.nodes.Person.create(
      { name: "Original Alice", age: 25 },
      { id: "person-1" },
    );

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "skip" }),
    );

    expect(result.success).toBe(true);
    expect(result.nodes.skipped).toBe(1);
    expect(result.nodes.created).toBe(0);

    const alice = await targetStore.nodes.Person.getById("person-1" as never);
    expect(alice?.name).toBe("Original Alice");
    expect(alice?.age).toBe(25);
  });

  it("updates existing nodes with onConflict: update", async () => {
    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    await targetStore.nodes.Person.create(
      { name: "Original Alice", age: 25 },
      { id: "person-1" },
    );

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "update" }),
    );

    expect(result.success).toBe(true);
    expect(result.nodes.updated).toBe(1);
    expect(result.nodes.created).toBe(0);

    const alice = await targetStore.nodes.Person.getById("person-1" as never);
    expect(alice?.name).toBe("Alice");
    expect(alice?.age).toBe(30);
  });

  it("errors on conflict with onConflict: error", async () => {
    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    await targetStore.nodes.Person.create(
      { name: "Original Alice" },
      { id: "person-1" },
    );

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.entityType).toBe("node");
    expect(result.errors[0]?.id).toBe("person-1");
  });
});

// ============================================================
// Data Integrity Tests
// ============================================================

describe("Data Integrity", () => {
  it("preserves all property types correctly", async () => {
    const sourceBackend = createTestBackend();
    const sourceStore = createStore(testGraph, sourceBackend);

    const person = await sourceStore.nodes.Person.create({
      name: "Test Person",
      email: "test@example.com",
      age: 42,
    });

    const exported = await exportGraph(sourceStore);

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    const imported = await targetStore.nodes.Person.getById(person.id);

    expect(imported).toBeDefined();
    expect(imported?.name).toBe("Test Person");
    expect(imported?.email).toBe("test@example.com");
    expect(imported?.age).toBe(42);
    expect(typeof imported?.age).toBe("number");
  });

  it("handles optional properties correctly", async () => {
    const sourceBackend = createTestBackend();
    const sourceStore = createStore(testGraph, sourceBackend);

    const minimal = await sourceStore.nodes.Person.create({
      name: "Minimal Person",
    });
    const full = await sourceStore.nodes.Person.create({
      name: "Full Person",
      email: "full@example.com",
      age: 35,
    });

    const exported = await exportGraph(sourceStore);

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    const importedMinimal = await targetStore.nodes.Person.getById(minimal.id);
    const importedFull = await targetStore.nodes.Person.getById(full.id);

    expect(importedMinimal?.email).toBeUndefined();
    expect(importedMinimal?.age).toBeUndefined();
    expect(importedFull?.email).toBe("full@example.com");
    expect(importedFull?.age).toBe(35);
  });

  it("maintains referential integrity for edges", async () => {
    const sourceBackend = createTestBackend();
    const sourceStore = createStore(testGraph, sourceBackend);

    const alice = await sourceStore.nodes.Person.create({ name: "Alice" });
    const bob = await sourceStore.nodes.Person.create({ name: "Bob" });
    const edge = await sourceStore.edges.knows.create(alice, bob, {
      since: "2020",
    });

    const exported = await exportGraph(sourceStore);

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error", validateReferences: true }),
    );

    expect(result.success).toBe(true);

    const importedEdge = await targetStore.edges.knows.getById(edge.id);
    const importedAlice = await targetStore.nodes.Person.getById(alice.id);
    const importedBob = await targetStore.nodes.Person.getById(bob.id);

    expect(importedEdge).toBeDefined();
    expect(importedEdge?.since).toBe("2020");
    expect(importedEdge?.fromId).toBe(importedAlice?.id);
    expect(importedEdge?.toId).toBe(importedBob?.id);
  });
});

// ============================================================
// Multiple Round-Trip Tests
// ============================================================

describe("Multiple Round-Trips", () => {
  it("data remains stable through multiple export/import cycles", async () => {
    const backend1 = createTestBackend();
    const store1 = createStore(testGraph, backend1);

    const alice = await store1.nodes.Person.create(
      { name: "Alice", email: "alice@test.com", age: 30 },
      { id: "alice-id" },
    );
    const bob = await store1.nodes.Person.create(
      { name: "Bob", age: 25 },
      { id: "bob-id" },
    );
    const acme = await store1.nodes.Company.create(
      { name: "Acme", industry: "Tech" },
      { id: "acme-id" },
    );

    await store1.edges.worksAt.create(alice, acme, {
      role: "Engineer",
      startYear: 2020,
    });
    await store1.edges.knows.create(alice, bob, { since: "2019" });

    let exported = await exportGraph(store1);

    for (let index = 0; index < 3; index++) {
      const nextBackend = createTestBackend();
      const nextStore = createStore(testGraph, nextBackend);

      const result = await importGraph(
        nextStore,
        exported,
        importOptions({ onConflict: "error" }),
      );

      expect(result.success).toBe(true);
      expect(result.nodes.created).toBe(3);
      expect(result.edges.created).toBe(2);

      exported = await exportGraph(nextStore);
    }

    expect(exported.nodes).toHaveLength(3);
    expect(exported.edges).toHaveLength(2);

    const aliceNode = exported.nodes.find((n) => n.id === "alice-id");
    expect(aliceNode?.properties).toEqual({
      name: "Alice",
      email: "alice@test.com",
      age: 30,
    });

    const bobNode = exported.nodes.find((n) => n.id === "bob-id");
    expect(bobNode?.properties).toEqual({
      name: "Bob",
      age: 25,
    });
  });
});

describe("Canonical validity-window validation", () => {
  it("rejects non-canonical validFrom / validTo on the interchange schemas", () => {
    const nodeBase = {
      kind: "Person",
      id: "p1",
      properties: { name: "Alice" },
    };
    // Missing milliseconds, zoned offset, and date-only all parse under the
    // lenient z.iso.datetime() but are not canonical fixed-width UTC, so they
    // would mis-sort as text against the asOf read coordinate. Import must
    // reject them, matching create/update — not persist a non-canonical row.
    for (const validFrom of [
      "2024-01-15T10:30:00Z",
      "2024-01-15T10:30:00+02:00",
      "2024-01-15",
    ]) {
      expect(
        InterchangeNodeSchema.safeParse({ ...nodeBase, validFrom }).success,
      ).toBe(false);
    }

    expect(
      InterchangeEdgeSchema.safeParse({
        kind: "knows",
        id: "e1",
        from: { kind: "Person", id: "p1" },
        to: { kind: "Person", id: "p2" },
        properties: {},
        // ".1Z" (= .100) sorts AFTER ".101Z" as text — the canonical contract
        // rejects variable-width milliseconds.
        validTo: "2024-01-15T10:30:00.1Z",
      }).success,
    ).toBe(false);
  });

  it("accepts canonical fixed-width UTC validFrom / validTo", () => {
    expect(
      InterchangeNodeSchema.safeParse({
        kind: "Person",
        id: "p1",
        properties: { name: "Alice" },
        validFrom: "2024-01-15T10:30:00.000Z",
        validTo: "2025-01-15T10:30:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects a non-canonical validFrom at the import write seam (schema bypassed)", async () => {
    // importGraph accepts a pre-typed GraphData without re-parsing, so a caller
    // that casts a hand-built object bypasses the schema. The write seam must
    // still reject a non-canonical validFrom — recorded as a per-row error, not
    // persisted as a row the asOf coordinate would later mis-compare.
    const sourceStore = createStore(testGraph, createTestBackend());
    await sourceStore.nodes.Person.create(
      { name: "Alice" },
      { id: "person-1" },
    );
    const exported = await exportGraph(sourceStore);
    const corrupted: GraphData = {
      ...exported,
      nodes: exported.nodes.map((node) =>
        node.id === "person-1" ?
          { ...node, validFrom: "2024-01-15T10:30:00Z" } // missing milliseconds
        : node,
      ),
    };

    const targetStore = createStore(testGraph, createTestBackend());
    const result = await importGraph(
      targetStore,
      corrupted,
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.entityType).toBe("node");
    expect(result.errors[0]?.id).toBe("person-1");
    expect(result.errors[0]?.error).toMatch(/canonical ISO 8601/);
    // The malformed row was not written.
    expect(
      await targetStore.nodes.Person.getById("person-1" as never),
    ).toBeUndefined();
  });
});

// ============================================================
// Import Integrity (uniqueness side-table maintenance)
// ============================================================

const UniquePerson = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string(),
  }),
});

const uniqueGraph = defineGraph({
  id: "interchange_unique_test",
  nodes: {
    Person: {
      type: UniquePerson,
      unique: [
        {
          name: "email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

const TwoUniquePerson = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string(),
    username: z.string(),
  }),
});

// Two independent unique constraints; `email` is declared first so a per-
// constraint update would mutate its sidecar before reaching the conflicting
// `username`.
const twoUniqueGraph = defineGraph({
  id: "interchange_two_unique_test",
  nodes: {
    Person: {
      type: TwoUniquePerson,
      unique: [
        {
          name: "email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
        {
          name: "username",
          fields: ["username"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

describe("Interchange import integrity", () => {
  it("writes uniqueness entries so a later create detects the conflict", async () => {
    const source = createStore(uniqueGraph, createTestBackend());
    await source.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
    });
    const exported = await exportGraph(source);

    const target = createStore(uniqueGraph, createTestBackend());
    const result = await importGraph(
      target,
      exported,
      importOptions({ onConflict: "error" }),
    );
    expect(result.success).toBe(true);
    expect(result.nodes.created).toBe(1);

    // The imported node's uniqueness entry must exist, so creating another
    // Person with the same email is rejected. Before the write-pipeline
    // migration, import skipped the side-table write and this create would
    // have succeeded — a silent duplicate the store believes is impossible.
    await expect(
      target.nodes.Person.create({
        name: "Alice II",
        email: "alice@example.com",
      }),
    ).rejects.toThrow(UniquenessError);
  });

  it("rejects a duplicate unique value within a single import", async () => {
    const source = createStore(uniqueGraph, createTestBackend());
    await source.nodes.Person.create({ name: "A", email: "a@example.com" });
    await source.nodes.Person.create({ name: "B", email: "b@example.com" });
    const exported = await exportGraph(source);

    // Force both exported people to share an email — a duplicate the store's
    // uniqueness constraint forbids. The second import row must fail its
    // uniqueness check (against the first row's just-written entry) rather than
    // import cleanly.
    const duplicated: GraphData = {
      ...exported,
      nodes: exported.nodes.map((node) => ({
        ...node,
        properties: { ...node.properties, email: "same@example.com" },
      })),
    };

    const target = createStore(uniqueGraph, createTestBackend());
    const result = await importGraph(
      target,
      duplicated,
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(false);
    expect(result.nodes.created).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.entityType).toBe("node");
  });

  it("a failed unique update preserves the old key (onConflict: update)", async () => {
    // Source doc: person-a now carries b@example.com — the conflicting update.
    const source = createStore(uniqueGraph, createTestBackend());
    await source.nodes.Person.create(
      { name: "A", email: "b@example.com" },
      { id: "person-a" },
    );
    const document = await exportGraph(source);

    // Target: person-a reserves a@example.com, person-b reserves b@example.com.
    const target = createStore(uniqueGraph, createTestBackend());
    await target.nodes.Person.create(
      { name: "A", email: "a@example.com" },
      { id: "person-a" },
    );
    await target.nodes.Person.create(
      { name: "B", email: "b@example.com" },
      { id: "person-b" },
    );

    const result = await importGraph(
      target,
      document,
      importOptions({ onConflict: "update" }),
    );

    // Updating person-a to b@example.com conflicts with person-b — reported as a
    // per-row error, not applied.
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    // person-a must STILL reserve a@example.com. Before the fix,
    // updateUniquenessEntries deleted the old key before the conflict check and
    // the import swallowed the throw, so this create wrongly succeeded — a
    // silent loss of person-a's uniqueness reservation.
    await expect(
      target.nodes.Person.create({ name: "C", email: "a@example.com" }),
    ).rejects.toThrow(UniquenessError);
  });

  it("preflights all unique constraints before mutating any sidecar (onConflict: update)", async () => {
    // Source doc updates person-a to email c@example.com (free) AND username
    // "buser" (held by person-b) — the first constraint would change cleanly, the
    // second conflicts.
    const source = createStore(twoUniqueGraph, createTestBackend());
    await source.nodes.Person.create(
      { name: "A", email: "c@example.com", username: "buser" },
      { id: "person-a" },
    );
    const document = await exportGraph(source);

    const target = createStore(twoUniqueGraph, createTestBackend());
    await target.nodes.Person.create(
      { name: "A", email: "a@example.com", username: "auser" },
      { id: "person-a" },
    );
    await target.nodes.Person.create(
      { name: "B", email: "b@example.com", username: "buser" },
      { id: "person-b" },
    );

    const result = await importGraph(
      target,
      document,
      importOptions({ onConflict: "update" }),
    );

    // The username conflict is reported per-row; nothing is applied.
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    // The EARLIER (email) constraint must not have been touched. Before the
    // two-phase preflight, updateUniquenessEntries mutated email's sidecar before
    // reaching the conflicting username, so both of these went wrong:
    //   - person-a's old email key was released (this create wrongly succeeded);
    await expect(
      target.nodes.Person.create({
        name: "C",
        email: "a@example.com",
        username: "cuser",
      }),
    ).rejects.toThrow(UniquenessError);
    //   - and c@example.com was wrongly reserved for person-a (this failed).
    const created = await target.nodes.Person.create({
      name: "D",
      email: "c@example.com",
      username: "duser",
    });
    expect(created.email).toBe("c@example.com");
  });

  it("never creates a live edge pointing at a tombstoned batch node", async () => {
    // Target: person-a exists but is soft-deleted.
    const target = createStore(testGraph, createTestBackend());
    await target.nodes.Person.create({ name: "A" }, { id: "person-a" });
    await target.nodes.Person.delete("person-a" as never);

    // Document: person-a (will be tombstone-skipped), person-b (created),
    // and an edge person-a -> person-b.
    const source = createStore(testGraph, createTestBackend());
    const personA = await source.nodes.Person.create(
      { name: "A" },
      { id: "person-a" },
    );
    const personB = await source.nodes.Person.create(
      { name: "B" },
      { id: "person-b" },
    );
    await source.edges.knows.create(personA, personB, {}, { id: "knows-ab" });
    const document = await exportGraph(source);

    const result = await importGraph(
      target,
      document,
      importOptions({ onConflict: "update" }),
    );

    // The tombstone skip must NOT count person-a as an available edge
    // endpoint: the edge is rejected per-row instead of silently violating
    // the endpoint-liveness invariant the collection API enforces.
    expect(result.nodes.skipped).toBe(1);
    expect(result.nodes.created).toBe(1);
    expect(result.edges.created).toBe(0);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ entityType: "edge" });
    await expect(
      target.edges.knows.getById("knows-ab" as never),
    ).resolves.toBeUndefined();
  });

  it("keeps node kind and id tuple boundaries distinct during reference validation", async () => {
    const target = createStore(delimiterCollisionGraph, createTestBackend());
    const document: GraphData = {
      formatVersion: "2.0",
      exportedAt: CANONICAL_TIMESTAMP,
      source: { type: "external" },
      nodes: [
        {
          // The old `${kind}:${id}` key for this row was `Person:x:y`, the
          // same key as the missing edge endpoint (`Person:x`, `y`).
          kind: "Person",
          id: "x:y",
          properties: { name: "Present" },
        },
        {
          kind: "Person",
          id: "destination",
          properties: { name: "Destination" },
        },
      ],
      edges: [
        {
          kind: "delimitedKnows",
          id: "collision-edge",
          from: { kind: "Person:x", id: "y" },
          to: { kind: "Person", id: "destination" },
          properties: {},
        },
      ],
    };

    const result = await importGraph(
      target,
      document,
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(false);
    expect(result.edges.created).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      entityType: "edge",
      id: "collision-edge",
    });
    expect(result.errors[0]?.error).toContain(
      "From node not found: Person:x:y",
    );
  });

  it("rejects edges referencing tombstoned nodes outside the batch", async () => {
    // Target: person-a exists only as a tombstone and is NOT in the import
    // document, so the reference check falls back to the database — which
    // must require a LIVE row.
    const target = createStore(testGraph, createTestBackend());
    await target.nodes.Person.create({ name: "A" }, { id: "person-a" });
    await target.nodes.Person.delete("person-a" as never);

    const source = createStore(testGraph, createTestBackend());
    const personB = await source.nodes.Person.create(
      { name: "B" },
      { id: "person-b" },
    );
    const document = await exportGraph(source);
    const withEdge: GraphData = {
      ...document,
      edges: [
        {
          kind: "knows",
          id: "knows-ab",
          from: { kind: "Person", id: "person-a" },
          to: { kind: "Person", id: personB.id },
          properties: {},
        },
      ],
    };

    const result = await importGraph(
      target,
      withEdge,
      importOptions({ onConflict: "error" }),
    );

    expect(result.edges.created).toBe(0);
    expect(result.success).toBe(false);
    expect(result.errors[0]?.error).toContain("From node not found");
  });

  it("skips tombstoned nodes without touching their sidecars (onConflict: update)", async () => {
    // Source doc: person-a with a new email.
    const source = createStore(uniqueGraph, createTestBackend());
    await source.nodes.Person.create(
      { name: "A", email: "new@example.com" },
      { id: "person-a" },
    );
    const document = await exportGraph(source);

    // Target: person-a existed, then was soft-deleted — the delete removed
    // its uniqueness entry (and any embedding/fulltext rows).
    const target = createStore(uniqueGraph, createTestBackend());
    await target.nodes.Person.create(
      { name: "A", email: "old@example.com" },
      { id: "person-a" },
    );
    await target.nodes.Person.delete("person-a" as never);

    const result = await importGraph(
      target,
      document,
      importOptions({ onConflict: "update" }),
    );

    // Import never resurrects a tombstone: the row is skipped, stays
    // tombstoned, and no uniqueness reservation is made for it — a live
    // create of the same value has to succeed.
    expect(result.success).toBe(true);
    expect(result.nodes.updated).toBe(0);
    expect(result.nodes.skipped).toBe(1);
    await expect(
      target.nodes.Person.getById("person-a" as never),
    ).resolves.toBeUndefined();
    const created = await target.nodes.Person.create({
      name: "C",
      email: "new@example.com",
    });
    expect(created.email).toBe("new@example.com");
  });
});

// ============================================================
// Import Property Fidelity (onUnknownProperty: "allow")
// ============================================================

const TransformDocument = defineNode("Doc", {
  schema: z.object({
    title: z.string().transform((value) => value.trim()),
    status: z.string().default("draft"),
  }),
});

const transformGraph = defineGraph({
  id: "interchange_transform_test",
  nodes: { Doc: { type: TransformDocument } },
  edges: {},
});

describe("Interchange import property fidelity", () => {
  it("preserves properties verbatim under onUnknownProperty: allow", async () => {
    const store = createStore(transformGraph, createTestBackend());
    const data: GraphData = {
      formatVersion: "2.0",
      exportedAt: "2024-01-01T00:00:00.000Z",
      source: { type: "external" },
      nodes: [
        {
          kind: "Doc",
          id: "d1",
          properties: { title: "  hello  ", extra: "keepme" },
        },
      ],
      edges: [],
    };

    const result = await importGraph(
      store,
      data,
      importOptions({ onConflict: "error", onUnknownProperty: "allow" }),
    );
    expect(result.success).toBe(true);
    expect(result.nodes.created).toBe(1);

    // "allow" is the fidelity-preserving strategy: the schema validates the
    // known fields, but the given properties are persisted byte-for-byte —
    // no transform re-application, no default injection — so an
    // export→import round trip cannot mutate stored values (a re-applied
    // non-idempotent transform would corrupt them). Use "strip" for a
    // normalizing import.
    const document = await store.nodes.Doc.getById("d1" as never);
    expect(document?.title).toBe("  hello  ");
    expect((document as unknown as { status?: string }).status).toBeUndefined();
    expect((document as unknown as { extra?: string }).extra).toBe("keepme");
  });
});

// ============================================================
// Read-side format-version compatibility (1.0 accepted, exports write 2.0)
// ============================================================

describe("Interchange format version compatibility", () => {
  it("exports always carry formatVersion 2.0", async () => {
    const store = createStore(testGraph, createTestBackend());
    await store.nodes.Person.create({ name: "Alice" });

    const exported = await exportGraph(store);
    expect(exported.formatVersion).toBe("2.0");

    const [headerChunk] = await collectChunks(exportGraphStream(store));
    if (headerChunk?.type !== "header") {
      throw new Error("Expected the export stream to start with a header.");
    }
    expect(headerChunk.header.formatVersion).toBe("2.0");
  });

  it("accepts a 1.0 document (no identity section) via schema and import", async () => {
    // A pre-existing 1.0 export is structurally a valid 2.0 document; the
    // documented GraphDataSchema.parse path must keep accepting it.
    const document = {
      formatVersion: "1.0",
      exportedAt: CANONICAL_TIMESTAMP,
      source: { type: "external" as const },
      nodes: [{ kind: "Person", id: "p1", properties: { name: "Alice" } }],
      edges: [],
    };

    const parsed = GraphDataSchema.parse(document);
    expect(parsed.formatVersion).toBe("1.0");

    const store = createStore(testGraph, createTestBackend());
    const result = await importGraph(
      store,
      parsed,
      importOptions({ onConflict: "error" }),
    );
    expect(result.success).toBe(true);
    expect(result.nodes.created).toBe(1);
    expect(await store.nodes.Person.getById("p1" as never)).toMatchObject({
      name: "Alice",
    });
  });

  it("accepts a 1.0 document that already carries an identity section (schema-wise)", () => {
    const document = {
      formatVersion: "1.0",
      exportedAt: CANONICAL_TIMESTAMP,
      source: { type: "external" as const },
      nodes: [],
      edges: [],
      identity: sampleIdentityAssertion(),
    };

    expect(GraphDataSchema.safeParse(document).success).toBe(true);
  });
});

// ============================================================
// Identity interchange compatibility, validation, and streaming
// ============================================================

describe("Identity interchange import guards", () => {
  it("rejects an empty identity envelope aimed at an identity-disabled graph before any write", async () => {
    const store = createStore(testGraph, createTestBackend());
    const data: GraphData = {
      formatVersion: "2.0",
      exportedAt: CANONICAL_TIMESTAMP,
      source: { type: "external" },
      nodes: [{ kind: "Person", id: "p1", properties: { name: "Alice" } }],
      edges: [],
      identity: {
        profile: "typegraph-identity-v1",
        mode: "state",
        assertions: [],
      },
    };

    await expect(
      importGraph(store, data, importOptions({ onConflict: "error" })),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: { code: "IDENTITY_IMPORT_REQUIRES_PROFILE" },
    });
    // The guard runs before processNodes, so nothing was written.
    expect(await store.nodes.Person.getById("p1" as never)).toBeUndefined();
  });

  it("rejects a non-empty identity envelope aimed at an identity-disabled graph before any write", async () => {
    const store = createStore(testGraph, createTestBackend());
    const data: GraphData = {
      formatVersion: "2.0",
      exportedAt: CANONICAL_TIMESTAMP,
      source: { type: "external" },
      nodes: [{ kind: "Person", id: "p1", properties: { name: "Alice" } }],
      edges: [],
      identity: sampleIdentityAssertion(),
    };

    await expect(
      importGraph(store, data, importOptions({ onConflict: "error" })),
    ).rejects.toThrow(ConfigurationError);
    expect(await store.nodes.Person.getById("p1" as never)).toBeUndefined();
  });

  it("rejects a streamed identity header aimed at an identity-disabled graph at the header, before nodes", async () => {
    const store = createStore(testGraph, createTestBackend());

    await expect(
      importGraphStream(
        store,
        chunkStream([
          { type: "header", header: identityStreamHeader },
          {
            type: "nodes",
            nodes: [
              { kind: "Person", id: "p1", properties: { name: "Alice" } },
            ],
          },
        ]),
        importOptions({ onConflict: "error" }),
      ),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: { code: "IDENTITY_IMPORT_REQUIRES_PROFILE" },
    });
    expect(await store.nodes.Person.getById("p1" as never)).toBeUndefined();
  });

  it("rejects an identity-bearing header aimed at an identity-disabled graph with no chunk behind it", async () => {
    // The header branch owns this refusal. `importGraph` raises the same error
    // for each chunk it is handed, which hides a missing header check whenever
    // a chunk follows — a header-only stream (or one whose chunks are all
    // empty) is refused only if the header itself is checked.
    const store = createStore(testGraph, createTestBackend());

    await expect(
      importGraphStream(
        store,
        chunkStream([{ type: "header", header: identityStreamHeader }]),
        importOptions({ onConflict: "error" }),
      ),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: { code: "IDENTITY_IMPORT_REQUIRES_PROFILE" },
    });
  });

  it("runtime-validates a streamed identity header even when no assertions follow", async () => {
    const store = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );
    const invalidHeader = {
      ...identityStreamHeader,
      identity: { profile: "not-the-typegraph-profile", mode: "state" },
    } as unknown as GraphDataHeader;

    await expect(
      importGraphStream(
        store,
        chunkStream([
          { type: "header", header: invalidHeader },
          { type: "identity", assertions: [] },
        ]),
        importOptions({ onConflict: "error" }),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an out-of-domain identity relation before any write (schema bypassed)", async () => {
    const store = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );
    // A JS caller casting past the GraphData type can smuggle a bad relation;
    // importGraph must runtime-validate the identity section and reject it
    // rather than pass "banana" straight to SQL.
    const data = {
      formatVersion: "2.0",
      exportedAt: CANONICAL_TIMESTAMP,
      source: { type: "external" },
      nodes: [],
      edges: [],
      identity: {
        profile: "typegraph-identity-v1",
        mode: "state",
        assertions: [
          {
            id: "assertion-1",
            relation: "banana",
            a: { kind: "Person", id: "person-1" },
            b: { kind: "Person", id: "person-2" },
            validFrom: CANONICAL_TIMESTAMP,
          },
        ],
      },
    } as unknown as GraphData;

    await expect(
      importGraph(store, data, importOptions({ onConflict: "error" })),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a non-canonical identity validFrom before any write (schema bypassed)", async () => {
    const store = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );
    const data = {
      formatVersion: "2.0",
      exportedAt: CANONICAL_TIMESTAMP,
      source: { type: "external" },
      nodes: [],
      edges: [],
      identity: {
        profile: "typegraph-identity-v1",
        mode: "state",
        assertions: [
          {
            id: "assertion-1",
            relation: "same",
            a: { kind: "Person", id: "person-1" },
            b: { kind: "Person", id: "person-2" },
            // Missing milliseconds — parses under lenient z.iso.datetime() but
            // is not canonical fixed-width UTC.
            validFrom: "2024-01-15T10:30:00Z",
          },
        ],
      },
    } as unknown as GraphData;

    await expect(
      importGraph(store, data, importOptions({ onConflict: "error" })),
    ).rejects.toThrow(ValidationError);
  });
});

describe("Identity interchange streaming", () => {
  it("refuses a snapshot import into the same SQLite backend before iteration", async () => {
    const backend = createTestBackend();
    const source = await createInitializedStore(identityGraph, backend);
    const target = await createInitializedStore(
      identitySameBackendTargetGraph,
      backend,
    );
    const exported = exportGraphStream(source);

    await expect(
      importGraphStream(
        target,
        exported,
        importOptions({ onConflict: "error" }),
      ),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: { code: "INTERCHANGE_SAME_SQLITE_BACKEND_SNAPSHOT" },
    });
  });

  it("holds one repeatable-read snapshot across the complete export", async () => {
    const backend = createTestBackend();
    const source = await createInitializedStore(identityGraph, backend);
    await source.nodes.Person.create({ name: "Alice" }, { id: "snapshot-a" });
    const transaction = vi.spyOn(backend, "transaction");
    const activeSchemaRead = vi.spyOn(backend, "getActiveSchema");
    const nodeRead = vi.spyOn(backend, "findNodesByKind");
    const edgeRead = vi.spyOn(backend, "findEdgesByKind");
    const rawRead = vi.spyOn(backend, "executeRaw");

    await exportGraph(source);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable_read",
      accessMode: "read_only",
    });
    expect(activeSchemaRead).not.toHaveBeenCalled();
    expect(nodeRead).not.toHaveBeenCalled();
    expect(edgeRead).not.toHaveBeenCalled();
    expect(rawRead).not.toHaveBeenCalled();
  });

  it("omits redundant kind predicates from an unfiltered export", async () => {
    const { backend, captured } = createPlanCaptureBackend();
    const source = await createInitializedStore(identityGraph, backend);

    captured.length = 0;
    await exportGraph(source);

    const identityRead = requireDefined(
      captured.find((statement) =>
        statement.sql.includes("typegraph_identity_assertions"),
      ),
    );
    expect(identityRead.sql).not.toContain("a_kind IN");
    expect(identityRead.sql).not.toContain("b_kind IN");
  });

  it("reads one bounded assertion page before delivering its first identity chunk", async () => {
    const { backend, captured } = createPlanCaptureBackend();
    const source = await createInitializedStore(identityGraph, backend);
    const alice = await source.nodes.Person.create(
      { name: "Alice" },
      { id: "page-alice" },
    );
    const bob = await source.nodes.Person.create(
      { name: "Bob" },
      { id: "page-bob" },
    );
    const carol = await source.nodes.Person.create(
      { name: "Carol" },
      { id: "page-carol" },
    );
    await source.identity.assertSame(alice, bob);
    await source.identity.assertSame(bob, carol);

    captured.length = 0;
    const iterator = exportGraphStream(source, {
      batchSize: 1,
    })[Symbol.asyncIterator]();
    let firstIdentity: GraphInterchangeChunk | undefined;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === "identity") {
        firstIdentity = next.value;
        break;
      }
    }

    expect(firstIdentity).toEqual({
      type: "identity",
      assertions: [expect.objectContaining({ relation: "same" })],
    });
    const identityReads = captured.filter((statement) =>
      statement.sql.includes("typegraph_identity_assertions"),
    );
    expect(identityReads).toHaveLength(1);
    expect(identityReads[0]?.sql).toContain("ORDER BY identity_assertions.id");
    expect(identityReads[0]?.sql).toContain("LIMIT");

    await iterator.return?.();
  });

  it("omits identity assertions whose endpoint kinds are filtered out", async () => {
    const source = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );
    const person = await source.nodes.Person.create(
      { name: "Alice" },
      { id: "filtered-person" },
    );
    const company = await source.nodes.Company.create(
      { name: "Acme" },
      { id: "filtered-company" },
    );
    await source.identity.assertSame(person, company);

    const document = await exportGraph(source, { nodeKinds: ["Person"] });

    expect(document.nodes.map((node) => node.kind)).toEqual(["Person"]);
    expect(document.identity?.assertions).toEqual([]);
    const target = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );
    await expect(
      importGraph(target, document, importOptions({ onConflict: "error" })),
    ).resolves.toMatchObject({ success: true });
  });

  it("omits archival identity assertions whose deleted endpoint is excluded", async () => {
    const source = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );
    const first = await source.nodes.Person.create(
      { name: "First" },
      { id: "archival-live" },
    );
    const deleted = await source.nodes.Person.create(
      { name: "Deleted" },
      { id: "archival-deleted" },
    );
    await source.identity.assertSame(first, deleted);
    await source.nodes.Person.delete(deleted.id);

    const document = await exportGraph(source, { identityMode: "archival" });

    expect(document.nodes.map((node) => node.id)).toEqual([first.id]);
    expect(document.identity?.assertions).toEqual([]);
  });

  it("round-trips header, nodes, edges, and identity through the stream", async () => {
    const source = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );
    const alice = await source.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const bob = await source.nodes.Person.create(
      { name: "Bob" },
      { id: "bob" },
    );
    const acme = await source.nodes.Company.create(
      { name: "Acme" },
      { id: "acme" },
    );
    await source.edges.worksAt.create(alice, acme, { role: "Engineer" });
    await source.identity.assertSame(alice, bob);

    const target = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );
    const result = await importGraphStream(
      target,
      exportGraphStream(source, { includeTemporal: true, batchSize: 1 }),
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(true);
    expect(result.nodes.created).toBe(3);
    expect(result.edges.created).toBe(1);
    expect(result.identity).toEqual({ created: 1, skipped: 0 });

    expect(await target.identity.areSame(alice, bob)).toBe(true);
    expect(await target.identity.membersOf(alice)).toEqual(
      expect.arrayContaining([
        { kind: "Person", id: "alice" },
        { kind: "Person", id: "bob" },
      ]),
    );
  });

  it("refreshes statistics once for a stream whose last chunk is identity", async () => {
    // The identity chunk is the last write of a stream, and like the node and
    // edge chunks it must not refresh statistics itself: the single post-loop
    // refresh covers the whole stream.
    const source = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );
    const alice = await source.nodes.Person.create(
      { name: "Alice" },
      { id: "stats-alice" },
    );
    const bob = await source.nodes.Person.create(
      { name: "Bob" },
      { id: "stats-bob" },
    );
    await source.identity.assertSame(alice, bob);
    const target = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );
    const refreshStatistics = vi.spyOn(target, "refreshStatistics");

    const result = await importGraphStream(
      target,
      exportGraphStream(source, { batchSize: 1 }),
      importOptions({ onConflict: "error" }),
    );

    expect(result.identity).toEqual({ created: 1, skipped: 0 });
    expect(refreshStatistics).toHaveBeenCalledOnce();
  });

  it("writes nothing for an empty identity chunk", async () => {
    const targetBackend = createTestBackend();
    const target = await createInitializedStore(identityGraph, targetBackend);
    const transaction = vi.spyOn(targetBackend, "transaction");

    const result = await importGraphStream(
      target,
      chunkStream([
        { type: "header", header: identityStreamHeader },
        { type: "identity", assertions: [] },
      ]),
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(true);
    expect(result.identity).toEqual({ created: 0, skipped: 0 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("omits the identity chunk entirely from an export with no assertions", async () => {
    // An identity-enabled graph with nothing asserted yet still walks the
    // assertion pages. An empty page must produce NO chunk: an
    // `{ assertions: [] }` chunk would set the stream's identity phase (closing
    // it to further node and edge chunks) for a graph that asserted nothing.
    const source = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );
    await source.nodes.Person.create({ name: "Alice" }, { id: "no-assertion" });

    const chunks = await collectChunks(exportGraphStream(source));

    expect(chunks.map((chunk) => chunk.type)).toEqual(["header", "nodes"]);
  });

  it("rejects nodes emitted after identity assertions", async () => {
    const target = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );

    await expect(
      importGraphStream(
        target,
        chunkStream([
          { type: "header", header: identityStreamHeader },
          { type: "identity", assertions: [] },
          { type: "nodes", nodes: [] },
        ]),
        importOptions({ onConflict: "error" }),
      ),
    ).rejects.toThrow("cannot emit nodes after identity assertions");
  });

  it("rejects edges emitted after identity assertions", async () => {
    const target = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );

    await expect(
      importGraphStream(
        target,
        chunkStream([
          { type: "header", header: identityStreamHeader },
          { type: "identity", assertions: [] },
          { type: "edges", edges: [] },
        ]),
        importOptions({ onConflict: "error" }),
      ),
    ).rejects.toThrow("cannot emit edges after identity assertions");
  });

  it("rejects identity rows that arrive without an identity header", async () => {
    const target = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );
    const plainHeader: GraphDataHeader = {
      formatVersion: "2.0",
      exportedAt: CANONICAL_TIMESTAMP,
      source: { type: "external" },
    };

    await expect(
      importGraphStream(
        target,
        chunkStream([
          { type: "header", header: plainHeader },
          {
            type: "identity",
            assertions: [
              {
                id: "assertion-1",
                relation: "same",
                a: { kind: "Person", id: "person-1" },
                b: { kind: "Person", id: "person-2" },
                validFrom: CANONICAL_TIMESTAMP,
              },
            ],
          },
        ]),
        importOptions({ onConflict: "error" }),
      ),
    ).rejects.toThrow("identity rows without an identity header");
  });

  it("runtime-validates streamed identity assertions (bad relation rejected)", async () => {
    const target = await createInitializedStore(
      identityGraph,
      createTestBackend(),
    );
    const badIdentityChunk = {
      type: "identity",
      assertions: [
        {
          id: "assertion-1",
          relation: "banana",
          a: { kind: "Person", id: "person-1" },
          b: { kind: "Person", id: "person-2" },
          validFrom: CANONICAL_TIMESTAMP,
        },
      ],
    } as unknown as GraphInterchangeChunk;

    await expect(
      importGraphStream(
        target,
        chunkStream([
          { type: "header", header: identityStreamHeader },
          badIdentityChunk,
        ]),
        importOptions({ onConflict: "error" }),
      ),
    ).rejects.toThrow(ValidationError);
  });
});

describe("Serialized-connection snapshot streaming guards", () => {
  /**
   * A guard that regressed into a wedge instead of a refusal makes the export
   * and the import wait on one connection, so a bounded wait reports the
   * regression instead of hanging the suite.
   */
  const GUARD_TIMEOUT_MS = 10_000;
  const openDatabases: Database.Database[] = [];

  afterEach(() => {
    for (const database of openDatabases.splice(0)) database.close();
  });

  /**
   * A bounded wait for the failure paths below. Shorter than the suite's
   * per-test budget on purpose: a producer failure that never reaches the
   * consumer is a deadlock, and this reports it as one instead of as a slow
   * test.
   */
  const PRODUCER_FAILURE_TIMEOUT_MS = 2000;

  function openMigratedDatabase(): Database.Database {
    const database = new Database(":memory:");
    openDatabases.push(database);
    for (const statement of generateSqliteDDL()) database.exec(statement);
    return database;
  }

  it("releases the export's snapshot registration when its producer fails mid-stream", async () => {
    // The producer's rejection handler is the only place a failed export gives
    // the connection back. It owes the consumer two things: the error (nothing
    // else ever settles the chunk the consumer is waiting for) and the released
    // registration (a stream that is over must not refuse the next import).
    const database = openMigratedDatabase();
    const sourceBackend = createSqliteBackend(drizzle(database));
    const targetBackend = createSqliteBackend(drizzle(database));
    const source = createStore(testGraph, sourceBackend);
    const target = createStore(sameHandleTargetGraph, targetBackend);
    await source.nodes.Person.create(
      { name: "Alice" },
      { id: "producer-fail" },
    );
    const chunks = await collectChunks(exportGraphStream(source));
    const producerError = new Error("snapshot read failed mid-stream");
    failNodeReadsAfter(sourceBackend, 1, producerError);

    const delivered: GraphInterchangeChunk[] = [];
    const streaming = (async () => {
      for await (const chunk of exportGraphStream(source)) {
        delivered.push(chunk);
      }
    })();

    await expect(
      raceTimeout(streaming, PRODUCER_FAILURE_TIMEOUT_MS),
    ).rejects.toBe(producerError);
    // Mid-stream: the header and the first node chunk were already consumed
    // when the next read rejected.
    expect(delivered.map((chunk) => chunk.type)).toEqual(["header", "nodes"]);

    const imported = await raceTimeout(
      importGraphStream(
        target,
        chunkStream(chunks),
        importOptions({ onConflict: "error" }),
      ),
      PRODUCER_FAILURE_TIMEOUT_MS,
    );
    if (imported === TIMEOUT_SENTINEL) {
      throw new Error(
        "The import waited on the connection the failed export never released.",
      );
    }
    expect(imported.success).toBe(true);
    expect(await target.nodes.Person.count()).toBe(1);
  });

  it("surfaces a non-Error producer failure as an Error carrying it as the cause", async () => {
    const database = openMigratedDatabase();
    const backend = createSqliteBackend(drizzle(database));
    const source = createStore(testGraph, backend);
    await source.nodes.Person.create({ name: "Alice" }, { id: "non-error" });
    const thrown = "the driver rejected with a string";
    failNodeReadsAfter(backend, 1, thrown);

    const failure = await raceTimeout(
      collectChunks(exportGraphStream(source)).catch((error: unknown) => error),
      PRODUCER_FAILURE_TIMEOUT_MS,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Graph export failed.");
    expect((failure as Error).cause).toBe(thrown);
  });

  it("refuses a snapshot import across two backends over one SQLite handle", async () => {
    // Distinct wrappers, so the object-identity check cannot see them; one
    // better-sqlite3 connection, so the export's transaction and the import's
    // writer lock are the same lock. Before ownership marking, this ran until
    // the driver failed mid-stream with "cannot start a transaction within a
    // transaction" — after chunks had already committed.
    const database = openMigratedDatabase();
    const sourceBackend = createSqliteBackend(drizzle(database));
    const targetBackend = createSqliteBackend(drizzle(database));
    const source = createStore(testGraph, sourceBackend);
    const target = createStore(sameHandleTargetGraph, targetBackend);
    await source.nodes.Person.create({ name: "Alice" }, { id: "same-handle" });
    const beginExport = vi.spyOn(sourceBackend, "transaction");

    await expect(
      importGraphStream(
        target,
        exportGraphStream(source),
        importOptions({ onConflict: "error" }),
      ),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT",
        graphId: sameHandleTargetGraph.id,
      },
    });
    // Refused before the export opened its snapshot, so nothing was read and
    // nothing was written.
    expect(beginExport).not.toHaveBeenCalled();
    expect(await target.nodes.Person.count()).toBe(0);
  });

  it("refuses an export snapshot that opens between import chunks", async () => {
    // The mirror of the refusal above, in the other order. The import's lease is
    // taken in the same synchronous section that finds no export snapshot open,
    // so the export starting second is the side refused — and the import, whose
    // header chunk is already processed, finishes instead of waiting on a read
    // transaction that cannot end until it does.
    const database = openMigratedDatabase();
    const sourceBackend = createSqliteBackend(drizzle(database));
    const targetBackend = createSqliteBackend(drizzle(database));
    const source = createStore(testGraph, sourceBackend);
    const target = createStore(sameHandleTargetGraph, targetBackend);
    await source.nodes.Person.create({ name: "Alice" }, { id: "mid-stream" });
    const chunks = await collectChunks(exportGraphStream(source));
    expect(chunks.length).toBeGreaterThan(1);
    const paused = createGate();
    const resume = createGate();

    const importing = importGraphStream(
      target,
      // Parked after the header: the lease is held, the node chunk is still to
      // come.
      pausingChunkStream(chunks, 1, paused, resume),
      importOptions({ onConflict: "error" }),
    );
    await paused.opened;

    await expect(exportGraph(source)).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "INTERCHANGE_SERIALIZED_IMPORT_IN_PROGRESS",
        graphId: testGraph.id,
      },
    });

    resume.open();
    const settled = await raceTimeout(importing, GUARD_TIMEOUT_MS);
    if (settled === TIMEOUT_SENTINEL) {
      throw new Error(
        `The import did not finish within ${GUARD_TIMEOUT_MS}ms: it is waiting on the connection an export took mid-stream.`,
      );
    }
    expect(settled.success).toBe(true);
    expect(await target.nodes.Person.count()).toBe(1);
  });

  it("allows an export while a non-transactional import holds the connection", async () => {
    // `transactionMode: "none"` exports statement by statement with nothing held
    // open, so it cannot strand an import's next chunk. Refusing it would deny
    // working behavior citing a transaction that does not exist — the same
    // abstention the import-side guard makes.
    const database = openMigratedDatabase();
    const backend = createSqliteBackend(drizzle(database), {
      executionProfile: { transactionMode: "none", isSync: true },
    });
    expect(backend.capabilities.transactions).toBe(false);
    const source = createStore(testGraph, backend);
    const target = createStore(sameHandleTargetGraph, backend);
    await source.nodes.Person.create({ name: "Alice" }, { id: "no-tx-lease" });
    const chunks = await collectChunks(exportGraphStream(source));
    const paused = createGate();
    const resume = createGate();

    const importing = importGraphStream(
      target,
      pausingChunkStream(chunks, 1, paused, resume),
      importOptions({ onConflict: "error" }),
    );
    await paused.opened;

    const exported = await exportGraph(source);
    expect(exported.nodes).toHaveLength(1);

    resume.open();
    const imported = await importing;
    expect(imported.success).toBe(true);
  });

  it("streams between two SQLite connections to one file", async () => {
    // Separate connections are genuinely concurrent under WAL; refusing them
    // would refuse work that succeeds.
    const directory = await mkdtemp(path.join(tmpdir(), "typegraph-stream-"));
    try {
      const file = path.join(directory, "graph.db");
      const sourceDatabase = new Database(file);
      openDatabases.push(sourceDatabase);
      sourceDatabase.pragma("journal_mode = WAL");
      for (const statement of generateSqliteDDL()) {
        sourceDatabase.exec(statement);
      }
      const targetDatabase = new Database(file);
      openDatabases.push(targetDatabase);
      const source = createStore(
        testGraph,
        createSqliteBackend(drizzle(sourceDatabase)),
      );
      const target = createStore(
        sameHandleTargetGraph,
        createSqliteBackend(drizzle(targetDatabase)),
      );
      await source.nodes.Person.create({ name: "Alice" }, { id: "wal-alice" });

      const result = await importGraphStream(
        target,
        exportGraphStream(source),
        importOptions({ onConflict: "error" }),
      );

      expect(result.success).toBe(true);
      expect(await target.nodes.Person.count()).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("streams into the same non-transactional SQLite backend", async () => {
    // `transactionMode: "none"` exports statement by statement with no read
    // transaction held, so the deadlock the refusal describes cannot happen.
    // Refusing here would deny working behavior citing a transaction that does
    // not exist.
    const database = openMigratedDatabase();
    const backend = createSqliteBackend(drizzle(database), {
      executionProfile: { transactionMode: "none", isSync: true },
    });
    expect(backend.capabilities.transactions).toBe(false);
    const source = createStore(testGraph, backend);
    const target = createStore(sameHandleTargetGraph, backend);
    await source.nodes.Person.create({ name: "Alice" }, { id: "no-tx-alice" });

    const result = await importGraphStream(
      target,
      exportGraphStream(source),
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(true);
    expect(await target.nodes.Person.count()).toBe(1);
  });
});
