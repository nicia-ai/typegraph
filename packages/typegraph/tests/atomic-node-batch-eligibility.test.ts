import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DatabaseOperationError, StaleVersionError } from "../src";
import {
  type AtomicNodeBatchInput,
  type AtomicNodeDeleteBatchInput,
  markBundledRootAtomicMutationPrograms,
  markBundledRootAtomicNodeBatch,
} from "../src/backend/capabilities/atomic-mutation-program";
import { markBundledRootAutocommitEligible } from "../src/backend/capabilities/autocommit-single-statement";
import { deriveBackend } from "../src/backend/derive-backend";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";
import { defineGraph, defineNode, embedding, searchable } from "../src/core";
import { disjointWith, subClassOf } from "../src/ontology";
import { buildKindRegistry } from "../src/registry";
import { migrateSchema } from "../src/schema";
import { createStoreWithSchema } from "../src/store";
import {
  assertAtomicDeleteSchemaFenceMatched,
  resolveAtomicNodeBatchExecutor,
  resolveAtomicNodeDeleteBatchExecutor,
} from "../src/store/operations/atomic-mutation-program";
import type { CreateNodeInput } from "../src/store/types";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "atomic-node-batch",
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
  id: "atomic-node-batch-unique",
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
const multipleUniqueGraph = defineGraph({
  id: "atomic-node-batch-multiple-unique",
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
        {
          name: "person_name_second",
          fields: ["name"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});
const Child = defineNode("Child", {
  schema: z.object({ name: z.string() }),
});
const subclassUniqueGraph = defineGraph({
  id: "atomic-node-batch-subclass-unique",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "person_name_across_subclasses",
          fields: ["name"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
      ],
    },
    Child: { type: Child },
  },
  edges: {},
  ontology: [subClassOf(Child, Person)],
});
const disjointGraph = defineGraph({
  id: "atomic-node-batch-disjoint",
  nodes: { Person: { type: Person }, Rival: { type: Rival } },
  edges: {},
  ontology: [disjointWith(Person, Rival)],
});
const searchableGraph = defineGraph({
  id: "atomic-node-batch-searchable",
  nodes: { SearchDocument: { type: SearchDocument } },
  edges: {},
});
const embeddingGraph = defineGraph({
  id: "atomic-node-batch-embedding",
  nodes: { VectorDocument: { type: VectorDocument } },
  edges: {},
});
const cascadeDeleteGraph = defineGraph({
  id: "atomic-node-batch-cascade-delete",
  nodes: { Person: { type: Person, onDelete: "cascade" } },
  edges: {},
});
const disconnectDeleteGraph = defineGraph({
  id: "atomic-node-batch-disconnect-delete",
  nodes: { Person: { type: Person, onDelete: "disconnect" } },
  edges: {},
});

const input: CreateNodeInput = {
  kind: "Person",
  props: { name: "Alice" },
};

function rootBackend(interactiveTransactions: boolean): GraphBackend {
  return {
    capabilities: {
      execution: { interactiveTransactions, atomicBatch: "root" },
    },
  } as GraphBackend;
}

function declareAtomicBatchForTest(backend: GraphBackend): void {
  Object.defineProperty(backend, "capabilities", {
    configurable: true,
    enumerable: true,
    value: {
      ...backend.capabilities,
      execution: {
        ...backend.capabilities.execution,
        atomicBatch: "root",
      },
    },
  });
}

function createFakeAtomicNodeBatch(onCall?: () => void) {
  async function execute(
    input: AtomicNodeBatchInput & Readonly<{ resultMode: "count" }>,
  ): Promise<number>;
  async function execute(
    input: AtomicNodeBatchInput & Readonly<{ resultMode: "rows" }>,
  ): Promise<readonly never[]>;
  function execute(
    input: AtomicNodeBatchInput,
  ): Promise<number | readonly never[]> {
    onCall?.();
    return Promise.resolve(
      input.resultMode === "count" ? input.entries.length : [],
    );
  }
  return Object.assign(execute, {
    claimSupport: {
      families: ["disjointness", "uniqueness"] as const,
      maxEntries: 6,
    },
  });
}

function markAtomicRoot(backend: GraphBackend): void {
  declareAtomicBatchForTest(backend);
  markBundledRootAutocommitEligible(backend);
  markBundledRootAtomicNodeBatch(backend, createFakeAtomicNodeBatch());
}

function markAtomicDeleteRoot(backend: GraphBackend): void {
  declareAtomicBatchForTest(backend);
  markBundledRootAutocommitEligible(backend);
  markBundledRootAtomicMutationPrograms(backend, {
    deleteNodes: Object.assign(
      (deleteInput: AtomicNodeDeleteBatchInput) =>
        Promise.resolve({
          affectedCount: deleteInput.ids.length,
          schemaFenceMatched: true,
        }),
      {
        releasedClaimFamilies: ["disjointness", "uniqueness"] as const,
      },
    ),
  });
}

describe("atomic node batch eligibility", () => {
  it("accepts the exact bundled root even when it advertises transactions", () => {
    const backend = rootBackend(true);
    markAtomicRoot(backend);

    expect(
      resolveAtomicNodeBatchExecutor({
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

  it("accepts generated ids for one same-kind unique constraint", () => {
    const backend = rootBackend(false);
    markAtomicRoot(backend);

    expect(
      resolveAtomicNodeBatchExecutor({
        backend,
        graph: uniqueGraph,
        registry: buildKindRegistry(uniqueGraph),
        inputs: [input],
        schemaVersion: 1,
        identityEnabled: false,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      }),
    ).toBeDefined();
  });

  it("accepts caller ids for an advertised disjoint claim family", () => {
    const backend = rootBackend(false);
    markAtomicRoot(backend);

    expect(
      resolveAtomicNodeBatchExecutor({
        backend,
        graph: disjointGraph,
        registry: buildKindRegistry(disjointGraph),
        inputs: [{ ...input, id: "shared-id" }],
        schemaVersion: 1,
        identityEnabled: false,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      }),
    ).toBeDefined();
  });

  it.each([
    ["caller id", [{ ...input, id: "person-1" }]],
    ["mixed ids", [input, { ...input, id: "person-2" }]],
  ] as const)("refuses %s for constrained nodes", (_label, inputs) => {
    const backend = rootBackend(false);
    markAtomicRoot(backend);
    expect(
      resolveAtomicNodeBatchExecutor({
        backend,
        graph: uniqueGraph,
        registry: buildKindRegistry(uniqueGraph),
        inputs,
        schemaVersion: 1,
        identityEnabled: false,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      }),
    ).toBeUndefined();
  });

  it("refuses a schema-less shape", () => {
    const backend = rootBackend(false);
    markAtomicRoot(backend);

    expect(
      resolveAtomicNodeBatchExecutor({
        backend,
        graph,
        registry: buildKindRegistry(graph),
        inputs: [input],
        schemaVersion: undefined,
        identityEnabled: false,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      }),
    ).toBeUndefined();
  });

  it("refuses a prototype-named unknown kind without touching inherited members", () => {
    const backend = rootBackend(true);
    markAtomicRoot(backend);

    expect(
      resolveAtomicNodeBatchExecutor({
        backend,
        graph,
        registry: buildKindRegistry(graph),
        inputs: [{ kind: "toString", props: {} }],
        schemaVersion: 1,
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
  ] as const)("refuses a %s as a whole", (_label, inputs) => {
    const backend = rootBackend(true);
    markAtomicRoot(backend);

    expect(
      resolveAtomicNodeBatchExecutor({
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
        resolveAtomicNodeBatchExecutor({
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
          resolveAtomicNodeBatchExecutor({
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
    [
      "multiple unique constraints",
      multipleUniqueGraph,
      input,
      false,
      false,
      false,
    ],
    [
      "kindWithSubClasses unique constraint",
      subclassUniqueGraph,
      input,
      false,
      false,
      false,
    ],
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
        resolveAtomicNodeBatchExecutor({
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

describe("atomic node delete batch eligibility", () => {
  it("never accepts contradictory stale-fence evidence as success", async () => {
    const backend = {
      getActiveSchema: () => Promise.resolve({ version: 1 }),
    } as unknown as GraphBackend;

    await expect(
      assertAtomicDeleteSchemaFenceMatched(
        false,
        { graphId: "graph-1", schemaVersion: 1 },
        backend,
        "node",
      ),
    ).rejects.toBeInstanceOf(DatabaseOperationError);
  });

  it("accepts an exact bundled root with complete claim cleanup", () => {
    const backend = rootBackend(true);
    markAtomicDeleteRoot(backend);

    expect(
      resolveAtomicNodeDeleteBatchExecutor({
        backend,
        graph,
        registry: buildKindRegistry(graph),
        kind: "Person",
        ids: ["person-1"],
        schemaVersion: 1,
        identityEnabled: false,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      }),
    ).toBeDefined();
  });

  it.each([
    [
      "search projections",
      searchableGraph,
      "SearchDocument",
      false,
      false,
      false,
    ],
    [
      "embedding projections",
      embeddingGraph,
      "VectorDocument",
      false,
      false,
      false,
    ],
    ["Operational Identity", graph, "Person", true, false, false],
    ["history", graph, "Person", false, true, false],
    ["revision tracking", graph, "Person", false, false, true],
    [
      "cascade delete behavior",
      cascadeDeleteGraph,
      "Person",
      false,
      false,
      false,
    ],
    [
      "disconnect delete behavior",
      disconnectDeleteGraph,
      "Person",
      false,
      false,
      false,
    ],
  ] as const)(
    "refuses %s work that owes transactional cleanup",
    (
      _label,
      candidateGraph,
      kind,
      identityEnabled,
      historyEnabled,
      revisionTrackingEnabled,
    ) => {
      const backend = rootBackend(true);
      markAtomicDeleteRoot(backend);

      expect(
        resolveAtomicNodeDeleteBatchExecutor({
          backend,
          graph: candidateGraph,
          registry: buildKindRegistry(candidateGraph),
          kind,
          ids: ["node-1"],
          schemaVersion: 1,
          identityEnabled,
          historyEnabled,
          revisionTrackingEnabled,
        }),
      ).toBeUndefined();
    },
  );

  it("refuses empty, unknown-kind, unmarked, and derived inputs", () => {
    const backend = rootBackend(true);
    markAtomicDeleteRoot(backend);
    const common = {
      graph,
      registry: buildKindRegistry(graph),
      kind: "Person",
      ids: ["person-1"],
      schemaVersion: 1,
      identityEnabled: false,
      historyEnabled: false,
      revisionTrackingEnabled: false,
    } as const;

    expect(
      resolveAtomicNodeDeleteBatchExecutor({ ...common, backend, ids: [] }),
    ).toBeUndefined();
    expect(
      resolveAtomicNodeDeleteBatchExecutor({
        ...common,
        backend,
        kind: "Unknown",
      }),
    ).toBeUndefined();
    expect(
      resolveAtomicNodeDeleteBatchExecutor({
        ...common,
        backend: rootBackend(true),
      }),
    ).toBeUndefined();
    expect(
      resolveAtomicNodeDeleteBatchExecutor({
        ...common,
        backend: deriveBackend(backend, {}),
      }),
    ).toBeUndefined();
  });
});

describe("atomic node batch store consumer", () => {
  it("keeps disjoint claim cleanup on the transactional delete path", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(disjointGraph, backend);
      const sharedId = "released-disjoint-id";
      const person = await store.nodes.Person.create(
        { name: "Person" },
        { id: sharedId },
      );

      await store.nodes.Person.bulkDelete([person.id]);

      await expect(
        store.nodes.Rival.create({ name: "Rival" }, { id: person.id }),
      ).resolves.toMatchObject({ id: sharedId });
    } finally {
      await backend.close();
    }
  });

  it("uses the exact-root native batch without opening an outer transaction", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-node-root-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const { backend } = await createLibsqlBackend(client);
    let calls = 0;
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      markBundledRootAtomicNodeBatch(
        backend,
        createFakeAtomicNodeBatch(() => {
          calls += 1;
        }),
      );

      await store.nodes.Person.bulkInsert([
        { props: { name: "Alice" } },
        { props: { name: "Bob" } },
      ]);
      expect(calls).toBe(1);
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("keeps constrained batches on the ordinary transactional path", async () => {
    const { backend } = createLocalSqliteBackend();
    let nativeCalls = 0;
    try {
      const [store] = await createStoreWithSchema(uniqueGraph, backend);
      declareAtomicBatchForTest(backend);
      markBundledRootAtomicNodeBatch(
        backend,
        createFakeAtomicNodeBatch(() => {
          nativeCalls += 1;
        }),
      );
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
      declareAtomicBatchForTest(backend);
      markBundledRootAtomicNodeBatch(
        backend,
        createFakeAtomicNodeBatch(() => {
          calls += 1;
        }),
      );

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
      const executor = resolveAtomicNodeBatchExecutor({
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
        throw new Error("Expected libSQL atomic node batch capability");
      }
      await migrateSchema(backend, evolvedGraph, 1);

      await expect(
        executor({
          entries: [
            {
              idSource: "generated",
              params: {
                graphId: graph.id,
                kind: "Person",
                id: "person-1",
                props: { name: "Alice" },
              },
            },
          ],
          resultMode: "count",
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
      const executor = resolveAtomicNodeBatchExecutor({
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
        throw new Error("Expected libSQL atomic node batch capability");
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
          entries: params.map((params) => ({
            idSource: "generated" as const,
            params,
          })),
          resultMode: "count",
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
