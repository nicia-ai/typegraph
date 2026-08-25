import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { StaleVersionError } from "../src";
import { markBundledRootAutocommitEligible } from "../src/backend/capabilities/autocommit-single-statement";
import { markBundledRootGeneratedNodeBatch } from "../src/backend/capabilities/generated-node-batch";
import { deriveBackend } from "../src/backend/derive-backend";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";
import { defineGraph, defineNode, embedding, searchable } from "../src/core";
import { disjointWith } from "../src/ontology";
import { buildKindRegistry } from "../src/registry";
import { migrateSchema } from "../src/schema";
import { createStoreWithSchema } from "../src/store";
import { resolveAtomicGeneratedNodeBatchExecutor } from "../src/store/operations/atomic-generated-node-batch";
import type { CreateNodeInput } from "../src/store/types";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "atomic-generated-node-batch",
  nodes: { Person: { type: Person } },
  edges: {},
});
const evolvedGraph = defineGraph({
  id: graph.id,
  nodes: {
    Person: {
      type: defineNode("Person", {
        schema: z.object({ name: z.string(), nickname: z.string().optional() }),
      }),
    },
  },
  edges: {},
});

const SearchDocument = defineNode("SearchDocument", {
  schema: z.object({ title: searchable() }),
});
const VectorDocument = defineNode("VectorDocument", {
  schema: z.object({ vector: embedding(2) }),
});
const Rival = defineNode("Rival", { schema: z.object({ name: z.string() }) });

const uniqueGraph = defineGraph({
  id: "atomic-generated-node-batch-unique",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "person_name",
          fields: ["name"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});
const disjointGraph = defineGraph({
  id: "atomic-generated-node-batch-disjoint",
  nodes: { Person: { type: Person }, Rival: { type: Rival } },
  edges: {},
  ontology: [disjointWith(Person, Rival)],
});
const searchableGraph = defineGraph({
  id: "atomic-generated-node-batch-searchable",
  nodes: { SearchDocument: { type: SearchDocument } },
  edges: {},
});
const embeddingGraph = defineGraph({
  id: "atomic-generated-node-batch-embedding",
  nodes: { VectorDocument: { type: VectorDocument } },
  edges: {},
});

const input: CreateNodeInput = {
  kind: "Person",
  props: { name: "Alice" },
};

function rootBackend(transactions: boolean): GraphBackend {
  return {
    capabilities: { transactions },
  } as GraphBackend;
}

function markAtomicRoot(backend: GraphBackend): void {
  markBundledRootAutocommitEligible(backend);
  markBundledRootGeneratedNodeBatch(backend, ({ params }) =>
    Promise.resolve(params.length),
  );
}

describe("generated node batch eligibility", () => {
  it("accepts the exact bundled root even when it advertises transactions", () => {
    const backend = rootBackend(true);
    markAtomicRoot(backend);

    expect(
      resolveAtomicGeneratedNodeBatchExecutor({
        backend,
        graph,
        registry: buildKindRegistry(graph),
        inputs: [input],
        schemaVersion: 1,
        identityEnabled: false,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      }),
    ).toBeDefined();
  });

  it.each([
    ["caller id", { ...input, id: "person-1" }],
    ["schema-less", input],
  ])("refuses %s shapes", (_label, candidate) => {
    const backend = rootBackend(false);
    markAtomicRoot(backend);

    expect(
      resolveAtomicGeneratedNodeBatchExecutor({
        backend,
        graph,
        registry: buildKindRegistry(graph),
        inputs: [candidate],
        schemaVersion: _label === "schema-less" ? undefined : 1,
        identityEnabled: false,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      }),
    ).toBeUndefined();
  });

  it.each([
    ["empty batch", []],
    ["unknown kind", [{ kind: "Unknown", props: {} }]],
    ["mixed batch", [input, { kind: "Unknown", props: {} }]],
    ["mixed generated and caller IDs", [input, { ...input, id: "person-1" }]],
  ] as const)("refuses a %s as a whole", (_label, inputs) => {
    const backend = rootBackend(true);
    markAtomicRoot(backend);

    expect(
      resolveAtomicGeneratedNodeBatchExecutor({
        backend,
        graph,
        registry: buildKindRegistry(graph),
        inputs,
        schemaVersion: 1,
        identityEnabled: false,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      }),
    ).toBeUndefined();
  });

  it("refuses unmarked and derived backends", () => {
    const unmarked = rootBackend(true);
    markBundledRootAutocommitEligible(unmarked);
    const marked = rootBackend(true);
    markAtomicRoot(marked);

    for (const backend of [unmarked, deriveBackend(marked, {})]) {
      expect(
        resolveAtomicGeneratedNodeBatchExecutor({
          backend,
          graph,
          registry: buildKindRegistry(graph),
          inputs: [input],
          schemaVersion: 1,
          identityEnabled: false,
          historyEnabled: false,
          revisionTrackingEnabled: false,
        }),
      ).toBeUndefined();
    }
  });

  it("refuses a real transaction-scoped backend", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      await backend.transaction((transactionBackend) => {
        expect(
          resolveAtomicGeneratedNodeBatchExecutor({
            backend: transactionBackend,
            graph,
            registry: buildKindRegistry(graph),
            inputs: [input],
            schemaVersion: 1,
            identityEnabled: false,
            historyEnabled: false,
            revisionTrackingEnabled: false,
          }),
        ).toBeUndefined();
        return Promise.resolve();
      });
    } finally {
      await backend.close();
    }
  });

  it.each([
    ["unique constraint", uniqueGraph, input, false, false, false],
    ["disjointness", disjointGraph, input, false, false, false],
    [
      "search projection",
      searchableGraph,
      { kind: "SearchDocument", props: { title: "Alice" } },
      false,
      false,
      false,
    ],
    [
      "embedding projection",
      embeddingGraph,
      { kind: "VectorDocument", props: { vector: [1, 0] } },
      false,
      false,
      false,
    ],
    ["Operational Identity", graph, input, true, false, false],
    ["history", graph, input, false, true, false],
    ["revision tracking", graph, input, false, false, true],
  ] as const)(
    "refuses %s work that needs the interactive write path",
    (
      _label,
      candidateGraph,
      candidateInput,
      identityEnabled,
      historyEnabled,
      revisionTrackingEnabled,
    ) => {
      const backend = rootBackend(true);
      markAtomicRoot(backend);

      expect(
        resolveAtomicGeneratedNodeBatchExecutor({
          backend,
          graph: candidateGraph,
          registry: buildKindRegistry(candidateGraph),
          inputs: [candidateInput],
          schemaVersion: 1,
          identityEnabled,
          historyEnabled,
          revisionTrackingEnabled,
        }),
      ).toBeUndefined();
    },
  );
});

describe("generated node batch store consumer", () => {
  it("uses the exact-root native batch without opening an outer transaction", async () => {
    const { backend } = createLocalSqliteBackend();
    let calls = 0;
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      markBundledRootGeneratedNodeBatch(backend, ({ params }) => {
        calls += 1;
        return Promise.resolve(params.length);
      });

      await store.nodes.Person.bulkInsert([
        { props: { name: "Alice" } },
        { props: { name: "Bob" } },
      ]);
      expect(calls).toBe(1);
    } finally {
      await backend.close();
    }
  });

  it("keeps constrained batches on the ordinary transactional path", async () => {
    const { backend } = createLocalSqliteBackend();
    let nativeCalls = 0;
    try {
      const [store] = await createStoreWithSchema(uniqueGraph, backend);
      markBundledRootGeneratedNodeBatch(backend, ({ params }) => {
        nativeCalls += 1;
        return Promise.resolve(params.length);
      });
      const transaction = vi.spyOn(backend, "transaction");

      await store.nodes.Person.bulkInsert([
        { props: { name: "Alice" } },
        { props: { name: "Bob" } },
      ]);

      expect(nativeCalls).toBe(0);
      expect(transaction).toHaveBeenCalledOnce();
      await expect(store.nodes.Person.count()).resolves.toBe(2);
    } finally {
      await backend.close();
    }
  });

  it("diagnoses a stale native schema fence without persisting rows", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      await migrateSchema(backend, evolvedGraph, 1);
      markBundledRootGeneratedNodeBatch(backend, () => Promise.resolve(0));

      await expect(
        store.nodes.Person.bulkInsert([{ props: { name: "Alice" } }]),
      ).rejects.toThrow(StaleVersionError);
      await expect(store.nodes.Person.count()).resolves.toBe(0);
    } finally {
      await backend.close();
    }
  });

  it("validates every row before dispatching the native operation", async () => {
    const { backend } = createLocalSqliteBackend();
    let calls = 0;
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      markBundledRootGeneratedNodeBatch(backend, ({ params }) => {
        calls += 1;
        return Promise.resolve(params.length);
      });

      await expect(
        store.nodes.Person.bulkInsert([
          { props: { name: 42 } as unknown as { name: string } },
        ]),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      await expect(store.nodes.Person.count()).resolves.toBe(0);
    } finally {
      await backend.close();
    }
  });

  it("persists through one real libSQL batch exchange", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-node-batch-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const { backend } = await createLibsqlBackend(client);
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const batch = vi.spyOn(client, "batch");
      const transaction = vi.spyOn(backend, "transaction");

      await store.nodes.Person.bulkInsert([
        { props: { name: "Alice" } },
        { props: { name: "Bob" } },
      ]);

      expect(batch).toHaveBeenCalledOnce();
      expect(transaction).not.toHaveBeenCalled();
      await expect(store.nodes.Person.count()).resolves.toBe(2);
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("gates a real libSQL batch on the active schema version", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-node-stale-fence-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const { backend } = await createLibsqlBackend(client);
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const executor = resolveAtomicGeneratedNodeBatchExecutor({
        backend,
        graph,
        registry: buildKindRegistry(graph),
        inputs: [input],
        schemaVersion: 1,
        identityEnabled: false,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      });
      if (executor === undefined) {
        throw new Error("Expected libSQL generated node batch capability");
      }
      await migrateSchema(backend, evolvedGraph, 1);

      await expect(
        executor({
          params: [
            {
              graphId: graph.id,
              kind: "Person",
              id: "person-1",
              props: { name: "Alice" },
            },
          ],
          schemaFence: { graphId: graph.id, expectedVersion: 1 },
        }),
      ).resolves.toBe(0);
      await expect(store.nodes.Person.count()).resolves.toBe(0);
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rolls back an earlier libSQL chunk when a later chunk fails", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-node-rollback-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const { backend } = await createLibsqlBackend(client);
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const executor = resolveAtomicGeneratedNodeBatchExecutor({
        backend,
        graph,
        registry: buildKindRegistry(graph),
        inputs: Array.from({ length: 111 }, () => input),
        schemaVersion: 1,
        identityEnabled: false,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      });
      if (executor === undefined) {
        throw new Error("Expected libSQL generated node batch capability");
      }
      const batch = vi.spyOn(client, "batch");
      const transaction = vi.spyOn(backend, "transaction");
      const params = Array.from({ length: 111 }, (_, index) => ({
        graphId: graph.id,
        kind: "Person",
        id: index === 110 ? "person-0" : `person-${index}`,
        props: { name: `Person ${index}` },
      }));

      await expect(
        executor({
          params,
          schemaFence: { graphId: graph.id, expectedVersion: 1 },
        }),
      ).rejects.toThrow();

      expect(batch).toHaveBeenCalledOnce();
      expect(batch.mock.calls[0]?.[0]).toHaveLength(2);
      expect(transaction).not.toHaveBeenCalled();
      await expect(store.nodes.Person.count()).resolves.toBe(0);
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
