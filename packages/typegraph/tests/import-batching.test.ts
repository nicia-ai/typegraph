/**
 * importGraph round-trip batching.
 *
 * The import path previously processed every node and edge one row at a
 * time (existence probe, per-constraint uniqueness check, single-row
 * INSERT per node; two endpoint reads and a single-row INSERT per edge)
 * despite slicing by batchSize. It must now batch per slice: existence
 * probes through getNodes/getEdges, uniqueness pre-checks through
 * checkUniqueBatch, node inserts through insertNodesBatch (+ batched side
 * effects), and edge inserts through insertEdgesBatch — while keeping the
 * per-row semantics: conflicts route by onConflict, a uniqueness conflict
 * is a per-row error entry (not an import abort), and reference
 * validation rejects missing or tombstoned endpoints.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  searchable,
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
  type ImportOptions,
  ImportOptionsSchema,
} from "../src/interchange";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

const Note = defineNode("Note", {
  schema: z.object({ body: searchable() }),
});

const knows = defineEdge("knows");

function buildGraph() {
  return defineGraph({
    id: "import-batching",
    nodes: {
      Person: {
        type: Person,
        unique: [
          {
            name: "person_email",
            fields: ["email"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      Note: { type: Note },
    },
    edges: { knows: { type: knows, from: [Person], to: [Person] } },
  });
}

function importOptions(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    onConflict: "skip",
    onUnknownProperty: "error",
    validateReferences: true,
    batchSize: 100,
    refreshStatistics: false,
    ...overrides,
  };
}

function payload(
  nodes: GraphData["nodes"],
  edges: GraphData["edges"] = [],
): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "import-batching test" },
    nodes,
    edges,
  };
}

function personNode(index: number): GraphData["nodes"][number] {
  return {
    kind: "Person",
    id: `p-${index}`,
    properties: { name: `person-${index}`, email: `p${index}@example.com` },
  };
}

function knowsEdge(index: number): GraphData["edges"][number] {
  return {
    kind: "knows",
    id: `k-${index}`,
    from: { kind: "Person", id: `p-${index}` },
    to: { kind: "Person", id: `p-${(index + 1) % 50}` },
    properties: {},
  };
}

type CallCounts = Record<string, number>;

const COUNTED_METHODS = [
  "getNode",
  "getNodes",
  "getEdge",
  "getEdges",
  "checkUnique",
  "checkUniqueBatch",
  "insertNode",
  "insertNodesBatch",
  "insertEdge",
  "insertEdgesBatch",
  "insertUnique",
  "insertUniqueBatch",
  "upsertFulltext",
  "upsertFulltextBatch",
] as const;

function withCallCounts(backend: GraphBackend): {
  backend: GraphBackend;
  counts: CallCounts;
} {
  const counts: CallCounts = {};
  for (const name of COUNTED_METHODS) counts[name] = 0;

  function wrapMethods<T extends GraphBackend | TransactionBackend>(
    target: T,
  ): T {
    const wrapped = { ...target } as Record<string, unknown>;
    for (const name of COUNTED_METHODS) {
      const original = (target as Record<string, unknown>)[name];
      if (typeof original !== "function") continue;
      wrapped[name] = (...args: unknown[]) => {
        counts[name] = (counts[name] ?? 0) + 1;
        return (original as (...a: unknown[]) => unknown).apply(target, args);
      };
    }
    return wrapped as T;
  }

  const outer = wrapMethods(backend);
  const counted: GraphBackend = {
    ...outer,
    transaction: (fn, options) =>
      backend.transaction((target, tx) => fn(wrapMethods(target), tx), options),
  };
  return { backend: counted, counts };
}

async function withCountedStore<T>(
  run: (
    store: Awaited<
      ReturnType<typeof createStoreWithSchema<ReturnType<typeof buildGraph>>>
    >[0],
    counts: CallCounts,
  ) => Promise<T>,
): Promise<T> {
  const { backend: raw } = createLocalSqliteBackend();
  try {
    const { backend, counts } = withCallCounts(raw);
    const [store] = await createStoreWithSchema(buildGraph(), backend);
    for (const name of COUNTED_METHODS) counts[name] = 0;
    return await run(store, counts);
  } finally {
    await raw.close();
  }
}

const NODE_COUNT = 50;

describe("importGraph batching", () => {
  it("defaults batchSize to 1000 (round-trip cost dominates small batches)", () => {
    expect(ImportOptionsSchema.parse({ onConflict: "error" }).batchSize).toBe(
      1000,
    );
  });

  it("imports nodes through batched probes, inserts, and side effects", async () => {
    await withCountedStore(async (store, counts) => {
      const result = await importGraph(
        store,
        payload(
          Array.from({ length: NODE_COUNT }, (_, index) => personNode(index)),
        ),
        importOptions(),
      );

      expect(result.success).toBe(true);
      expect(result.nodes.created).toBe(NODE_COUNT);

      expect(counts.getNode).toBe(0);
      expect(counts.getNodes).toBeLessThanOrEqual(2);
      expect(counts.checkUnique).toBe(0);
      expect(counts.checkUniqueBatch).toBe(1);
      expect(counts.insertNode).toBe(0);
      expect(counts.insertNodesBatch).toBe(1);
      expect(counts.insertUnique).toBe(0);
      expect(counts.insertUniqueBatch).toBe(1);
    });
  });

  it("imports edges through batched endpoint checks and inserts", async () => {
    await withCountedStore(async (store, counts) => {
      const result = await importGraph(
        store,
        payload(
          Array.from({ length: NODE_COUNT }, (_, index) => personNode(index)),
          Array.from({ length: NODE_COUNT }, (_, index) => knowsEdge(index)),
        ),
        importOptions(),
      );

      expect(result.success).toBe(true);
      expect(result.edges.created).toBe(NODE_COUNT);

      expect(counts.getEdge).toBe(0);
      expect(counts.getEdges).toBe(1);
      expect(counts.insertEdge).toBe(0);
      expect(counts.insertEdgesBatch).toBe(1);
    });
  });

  it("syncs searchable imports through the fulltext batch", async () => {
    await withCountedStore(async (store, counts) => {
      const notes = Array.from({ length: 20 }, (_, index) => ({
        kind: "Note",
        id: `n-${index}`,
        properties: { body: `note body ${index}` },
      }));
      const result = await importGraph(store, payload(notes), importOptions());

      expect(result.nodes.created).toBe(20);
      expect(counts.upsertFulltext).toBe(0);
      expect(counts.upsertFulltextBatch).toBe(1);
    });
  });
});

describe("importGraph batching semantics (must not drift)", () => {
  it("routes existing rows by onConflict: skip", async () => {
    await withCountedStore(async (store) => {
      await store.nodes.Person.create({
        name: "existing",
        email: "p1@example.com",
      });
      const nodes = [
        personNode(0),
        { ...personNode(1), id: (await firstPersonId(store))! },
      ];
      const result = await importGraph(store, payload(nodes), importOptions());
      expect(result.nodes.created).toBe(1);
      expect(result.nodes.skipped).toBe(1);
      expect(result.errors).toHaveLength(0);
    });
  });

  it("records a per-row error for a uniqueness conflict and continues", async () => {
    await withCountedStore(async (store) => {
      await store.nodes.Person.create({
        name: "existing",
        email: "taken@example.com",
      });
      const nodes = [
        personNode(0),
        {
          kind: "Person",
          id: "p-conflict",
          properties: { name: "dup", email: "taken@example.com" },
        },
        personNode(1),
      ];
      const result = await importGraph(store, payload(nodes), importOptions());

      expect(result.nodes.created).toBe(2);
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.id).toBe("p-conflict");
      expect(result.errors[0]?.error).toMatch(/person_email/);
    });
  });

  it("records a per-row error for an in-payload duplicate unique key", async () => {
    await withCountedStore(async (store) => {
      const nodes = [
        personNode(0),
        {
          kind: "Person",
          id: "p-dup-key",
          properties: { name: "dup", email: "p0@example.com" },
        },
      ];
      const result = await importGraph(store, payload(nodes), importOptions());

      expect(result.nodes.created).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.id).toBe("p-dup-key");
    });
  });

  it("handles duplicate ids within one payload by conflict routing", async () => {
    await withCountedStore(async (store) => {
      const nodes = [
        personNode(0),
        {
          kind: "Person",
          id: "p-0",
          properties: { name: "second", email: "other@example.com" },
        },
      ];
      const skip = await importGraph(store, payload(nodes), importOptions());
      expect(skip.nodes.created).toBe(1);
      expect(skip.nodes.skipped).toBe(1);
    });
  });

  it("updates existing live rows under onConflict: update", async () => {
    await withCountedStore(async (store) => {
      await importGraph(store, payload([personNode(0)]), importOptions());
      const result = await importGraph(
        store,
        payload([
          {
            kind: "Person",
            id: "p-0",
            properties: { name: "renamed", email: "p0@example.com" },
          },
        ]),
        importOptions({ onConflict: "update" }),
      );
      expect(result.nodes.updated).toBe(1);

      const updated = await store.nodes.Person.getById("p-0" as never);
      expect(updated?.name).toBe("renamed");
    });
  });

  it("rejects edges whose endpoints are missing or tombstoned", async () => {
    await withCountedStore(async (store) => {
      const alive = await store.nodes.Person.create({
        name: "alive",
        email: "alive@example.com",
      });
      const dead = await store.nodes.Person.create({
        name: "dead",
        email: "dead@example.com",
      });
      await store.nodes.Person.delete(dead.id);

      const edges = [
        {
          kind: "knows",
          id: "k-missing",
          from: { kind: "Person", id: alive.id },
          to: { kind: "Person", id: "nope" },
          properties: {},
        },
        {
          kind: "knows",
          id: "k-dead",
          from: { kind: "Person", id: alive.id },
          to: { kind: "Person", id: dead.id },
          properties: {},
        },
      ];
      const result = await importGraph(
        store,
        payload([], edges),
        importOptions(),
      );

      expect(result.edges.created).toBe(0);
      expect(result.errors).toHaveLength(2);
      expect(result.errors.map((entry) => entry.id).toSorted()).toEqual([
        "k-dead",
        "k-missing",
      ]);
    });
  });

  it("skips tombstoned rows under onConflict: update without resurrecting", async () => {
    await withCountedStore(async (store) => {
      const node = await store.nodes.Person.create({
        name: "gone",
        email: "gone@example.com",
      });
      await store.nodes.Person.delete(node.id);

      const result = await importGraph(
        store,
        payload([
          {
            kind: "Person",
            id: node.id,
            properties: { name: "back", email: "back@example.com" },
          },
        ]),
        importOptions({ onConflict: "update" }),
      );
      expect(result.nodes.skipped).toBe(1);
      expect(result.nodes.updated).toBe(0);
    });
  });
});

async function firstPersonId(
  store: Awaited<
    ReturnType<typeof createStoreWithSchema<ReturnType<typeof buildGraph>>>
  >[0],
): Promise<string | undefined> {
  const people = await store.nodes.Person.find({ limit: 1 });
  return people[0]?.id;
}
