/**
 * bulkCreate round-trip batching.
 *
 * A batch create must not degenerate into per-row statements: caller-id
 * existence probes go through one getNodes per kind while generated ids skip
 * that guaranteed-empty read, uniqueness pre-checks through
 * one checkUniqueBatch per (constraint, kind), uniqueness entries through
 * one insertUniqueBatch, fulltext sync through one upsertFulltextBatch per
 * kind, and embedding sync through one upsertEmbeddingBatch per
 * (kind, field). These tests count backend calls through a spying overlay
 * (including inside the write transaction) and pin the batch-vs-per-row
 * split, alongside the behavioral semantics that must not drift:
 * in-batch conflicts, conflicts with existing rows, and create-over-
 * tombstone.
 *
 * The same accounting covers a batch whose items carry `partOf`: the whole
 * rows go through one getNodes per kind (never one getNode per item, and never
 * a read of the part row the batch's own insert just wrote), and the
 * acyclicity relation is walked once for the whole batch rather than once per
 * attaching item.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  partOf,
  searchable,
} from "../src";
import {
  deriveBackend,
  type ExactBackendOverlay,
} from "../src/backend/derive-backend";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";
import { UniquenessError } from "../src/errors";
import * as acyclicityModule from "../src/store/acyclicity";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

const Document = defineNode("Doc", {
  schema: z.object({
    title: searchable(),
    body: searchable(),
    embedding: embedding(4),
  }),
});

/** A reflexive composition pair: the only shape in which a create batch's own items can close a cycle. */
const Folder = defineNode("Folder", { schema: z.object({ name: z.string() }) });
const folderOf = defineEdge("folderOf", { schema: z.object({}) });

function buildCompositionGraph() {
  return defineGraph({
    id: "bulk-batching-composition",
    nodes: { Folder: { type: Folder } },
    edges: {
      folderOf: {
        type: folderOf,
        from: [Folder],
        to: [Folder],
        cardinality: "one",
      },
    },
    // Reflexive, so the orientation must be stated explicitly.
    ontology: [partOf(Folder, Folder, { via: folderOf, partSide: "from" })],
  });
}

function buildGraph() {
  return defineGraph({
    id: "bulk-batching",
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
      Doc: { type: Document },
    },
    edges: {},
  });
}

type CallCounts = Record<string, number>;

const COUNTED_METHODS = [
  "getNode",
  "getNodes",
  "checkUnique",
  "checkUniqueBatch",
  "insertUnique",
  "insertUniqueBatch",
  "upsertFulltext",
  "upsertFulltextBatch",
  "upsertEmbedding",
  "upsertEmbeddingBatch",
] as const;

/**
 * Wraps a backend (and every transaction-scoped backend it hands out) so
 * each counted method increments a shared counter. Batch probes run inside
 * the write transaction, so counting only the outer backend would miss
 * everything.
 */
function withCallCounts(backend: GraphBackend): {
  backend: GraphBackend;
  counts: CallCounts;
} {
  const counts: CallCounts = {};
  for (const name of COUNTED_METHODS) counts[name] = 0;

  function wrapMethods<T extends GraphBackend | TransactionBackend>(
    target: T,
  ): T {
    // Built from a name list rather than written as a literal, so the overlay
    // carries an assertion: `ExactBackendOverlay<T, Partial<T>>` reduces to
    // `Partial<T>` only once `T` is resolved, and the checker cannot verify
    // that against an unresolved type parameter.
    const overrides: Record<string, unknown> = {};
    for (const name of COUNTED_METHODS) {
      const original = (target as Record<string, unknown>)[name];
      if (typeof original !== "function") continue;
      overrides[name] = (...args: unknown[]) => {
        counts[name] = (counts[name] ?? 0) + 1;
        return (original as (...a: unknown[]) => unknown).apply(target, args);
      };
    }
    return deriveBackend<T, Partial<T>>(
      target,
      overrides as ExactBackendOverlay<T, Partial<T>>,
    );
  }

  const counted: GraphBackend = deriveBackend(wrapMethods(backend), {
    transaction: (fn, options) => {
      counts["transaction"] = (counts["transaction"] ?? 0) + 1;
      return backend.transaction((target) => fn(wrapMethods(target)), options);
    },
  });
  return { backend: counted, counts };
}

/**
 * The counted backend and a store on it, with every call the store's own boot
 * made already discounted — so a test's assertions describe only what its own
 * `run` body triggered. Shared by both graphs' helpers below, which differ
 * only in the graph they build (and so in the store type they hand back).
 */
async function withCountedBackend<T>(
  run: (
    backend: GraphBackend,
    counts: CallCounts,
    raw: GraphBackend,
  ) => Promise<T>,
): Promise<T> {
  const { backend: raw } = createLocalSqliteBackend();
  try {
    const { backend, counts } = withCallCounts(raw);
    return await run(backend, counts, raw);
  } finally {
    await raw.close();
  }
}

function resetCounts(counts: CallCounts): void {
  for (const name of COUNTED_METHODS) counts[name] = 0;
  counts["transaction"] = 0;
}

async function withCountedStore<T>(
  run: (
    store: Awaited<
      ReturnType<typeof createStoreWithSchema<ReturnType<typeof buildGraph>>>
    >[0],
    counts: CallCounts,
    raw: GraphBackend,
  ) => Promise<T>,
): Promise<T> {
  return withCountedBackend(async (backend, counts, raw) => {
    const [store] = await createStoreWithSchema(buildGraph(), backend);
    // Boot traffic is not under test — count only what `run` triggers.
    resetCounts(counts);
    return run(store, counts, raw);
  });
}

async function withCountedCompositionStore<T>(
  run: (
    store: Awaited<
      ReturnType<
        typeof createStoreWithSchema<ReturnType<typeof buildCompositionGraph>>
      >
    >[0],
    counts: CallCounts,
    raw: GraphBackend,
  ) => Promise<T>,
): Promise<T> {
  return withCountedBackend(async (backend, counts, raw) => {
    const [store] = await createStoreWithSchema(
      buildCompositionGraph(),
      backend,
    );
    resetCounts(counts);
    return run(store, counts, raw);
  });
}

const BATCH_SIZE = 40;

function personInputs(offset = 0) {
  return Array.from({ length: BATCH_SIZE }, (_, index) => ({
    props: {
      name: `person-${offset + index}`,
      email: `p${offset + index}@example.com`,
    },
  }));
}

describe("bulkCreate probe batching", () => {
  it("skips existence probes for generated ids", async () => {
    await withCountedStore(async (store, counts) => {
      const created = await store.nodes.Person.bulkCreate(personInputs());
      expect(created).toHaveLength(BATCH_SIZE);

      expect(counts["getNodes"]).toBe(0);
      expect(counts["getNode"]).toBe(0);
    });
  });

  it("batches caller-id existence probes once per kind", async () => {
    await withCountedStore(async (store, counts) => {
      const created = await store.nodes.Person.bulkCreate(
        personInputs().map((input, index) => ({
          ...input,
          id: `person-${index}`,
        })),
      );
      expect(created).toHaveLength(BATCH_SIZE);

      expect(counts["getNodes"]).toBe(1);
      expect(counts["getNode"]).toBe(0);
    });
  });

  it("replaces per-row uniqueness pre-checks with one checkUniqueBatch per constraint", async () => {
    await withCountedStore(async (store, counts) => {
      await store.nodes.Person.bulkCreate(personInputs());

      expect(counts["checkUniqueBatch"]).toBe(1);
      expect(counts["checkUnique"]).toBe(0);
    });
  });
});

describe("bulkCreate side-effect batching", () => {
  it("writes uniqueness entries through one insertUniqueBatch", async () => {
    await withCountedStore(async (store, counts) => {
      await store.nodes.Person.bulkCreate(personInputs());

      expect(counts["insertUniqueBatch"]).toBe(1);
      expect(counts["insertUnique"]).toBe(0);
    });
  });

  it("syncs fulltext through one upsertFulltextBatch", async () => {
    await withCountedStore(async (store, counts) => {
      const documents = Array.from({ length: BATCH_SIZE }, (_, index) => ({
        props: {
          title: `doc ${index}`,
          body: `body text ${index}`,
          embedding: [index, 1, 2, 3],
        },
      }));
      await store.nodes.Doc.bulkCreate(documents);

      expect(counts["upsertFulltextBatch"]).toBe(1);
      expect(counts["upsertFulltext"]).toBe(0);
    });
  });

  it("syncs embeddings through one upsertEmbeddingBatch per field", async () => {
    await withCountedStore(async (store, counts, raw) => {
      if (raw.capabilities.vector === undefined) return;
      const documents = Array.from({ length: BATCH_SIZE }, (_, index) => ({
        props: {
          title: `doc ${index}`,
          body: `body text ${index}`,
          embedding: [index, 1, 2, 3],
        },
      }));
      await store.nodes.Doc.bulkCreate(documents);

      expect(counts["upsertEmbeddingBatch"]).toBe(1);
      expect(counts["upsertEmbedding"]).toBe(0);
    });
  });
});

describe("bulkInsert transaction ownership", () => {
  it("lets the write executor own the ordinary transaction boundary", async () => {
    await withCountedStore(async (store, counts) => {
      await store.nodes.Person.bulkInsert(personInputs());

      expect(counts["transaction"]).toBe(1);
    });
  });
});

describe("bulkCreate batching semantics (must not drift)", () => {
  it("creates rows readable by unique constraint and search after batching", async () => {
    await withCountedStore(async (store) => {
      await store.nodes.Person.bulkCreate(personInputs());
      const found = await store.nodes.Person.findByConstraint("person_email", {
        email: "p3@example.com",
        name: "person-3",
      });
      expect(found?.name).toBe("person-3");

      await store.nodes.Doc.bulkCreate([
        {
          props: {
            title: "alpha report",
            body: "quarterly earnings summary",
            embedding: [1, 0, 0, 0],
          },
        },
      ]);
      const hits = await store.search.fulltext("Doc", {
        query: "earnings",
        limit: 5,
      });
      expect(hits).toHaveLength(1);
    });
  });

  it("leaves batched embeddings searchable by vector", async () => {
    await withCountedStore(async (store, _counts, raw) => {
      if (raw.capabilities.vector === undefined) return;
      await store.nodes.Doc.bulkCreate([
        {
          props: {
            title: "alpha report",
            body: "quarterly earnings summary",
            embedding: [1, 0, 0, 0],
          },
        },
      ]);
      const vectorHits = await store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        limit: 1,
      });
      expect(vectorHits).toHaveLength(1);
    });
  });

  it("rejects an in-batch duplicate unique key", async () => {
    await withCountedStore(async (store) => {
      await expect(
        store.nodes.Person.bulkCreate([
          { props: { name: "a", email: "dup@example.com" } },
          { props: { name: "b", email: "dup@example.com" } },
        ]),
      ).rejects.toThrow(UniquenessError);
    });
  });

  it("rejects a duplicate of an existing unique key", async () => {
    await withCountedStore(async (store) => {
      await store.nodes.Person.create({
        name: "existing",
        email: "taken@example.com",
      });
      await expect(
        store.nodes.Person.bulkCreate([
          { props: { name: "x", email: "fresh@example.com" } },
          { props: { name: "y", email: "taken@example.com" } },
        ]),
      ).rejects.toThrow(UniquenessError);
    });
  });

  it("rejects an in-batch duplicate id", async () => {
    await withCountedStore(async (store) => {
      await expect(
        store.nodes.Person.bulkCreate([
          { id: "same-id", props: { name: "a", email: "a@example.com" } },
          { id: "same-id", props: { name: "b", email: "b@example.com" } },
        ]),
      ).rejects.toThrow(/already exists/i);
    });
  });

  it("resurrects a tombstoned id instead of failing at the insert", async () => {
    // Pins current semantics: the existence probe lets tombstoned ids through
    // (only live rows raise NodeAlreadyExistsError) and the batch partitions
    // them into resurrections — properties replaced, validity window reset.
    // Probe batching must not change this.
    await withCountedStore(async (store) => {
      const originalValidFrom = "2020-01-01T00:00:00.000Z";
      const node = await store.nodes.Person.create(
        {
          name: "first",
          email: "gone@example.com",
        },
        { validFrom: originalValidFrom },
      );
      await store.nodes.Person.delete(node.id);

      const [resurrected] = await store.nodes.Person.bulkCreate([
        {
          id: node.id,
          props: { name: "second", email: "back@example.com" },
        },
      ]);

      expect(resurrected).toMatchObject({ id: node.id, name: "second" });
      expect(requireDefined(resurrected).meta.deletedAt).toBeUndefined();
      expect(requireDefined(resurrected).meta.validFrom).not.toBe(
        originalValidFrom,
      );
      expect(requireDefined(resurrected).meta.validTo).toBeUndefined();
    });
  });
});

describe("bulkCreate composition attach batching", () => {
  const ATTACHING_BATCH_SIZE = 8;

  it("reads the whole rows once per kind, and never re-reads the part rows it just wrote", async () => {
    await withCountedCompositionStore(async (store, counts) => {
      const whole = await store.nodes.Folder.create({ name: "whole" });
      resetCounts(counts);

      const parts = await store.nodes.Folder.bulkCreate(
        Array.from({ length: ATTACHING_BATCH_SIZE }, (_, index) => ({
          props: { name: `part-${index}` },
          partOf: { kind: "Folder" as const, id: whole.id },
        })),
      );
      expect(parts).toHaveLength(ATTACHING_BATCH_SIZE);

      // One getNodes for the single distinct whole; zero getNode, which is
      // what rules out both a per-item whole probe and a part-row re-read
      // (the items' own ids are generated, so nothing else reads a node).
      expect(counts["getNodes"]).toBe(1);
      expect(counts["getNode"]).toBe(0);
    });
  });
  // MUTATION CHECK: have `attachBatchCompositionCreateEdges`
  // (src/store/operations/node-operations.ts) prepare each item with
  // `endpoints: { source: "read" }` instead of the primed whole. Both endpoint
  // rows are then read per item and `getNode` counts 16 instead of 0.

  it("walks the acyclicity relation once for the whole batch", async () => {
    await withCountedCompositionStore(async (store) => {
      const whole = await store.nodes.Folder.create({ name: "whole" });
      const probe = vi.spyOn(acyclicityModule, "assertEdgeRelationsAcyclic");
      try {
        await store.nodes.Folder.bulkCreate(
          Array.from({ length: ATTACHING_BATCH_SIZE }, (_, index) => ({
            props: { name: `part-${index}` },
            partOf: { kind: "Folder" as const, id: whole.id },
          })),
        );
        expect(probe).toHaveBeenCalledTimes(1);
        expect(probe.mock.calls[0]?.[1]).toHaveLength(ATTACHING_BATCH_SIZE);
      } finally {
        probe.mockRestore();
      }
    });
  });
  // MUTATION CHECK: restore the per-item probe (prepare with
  // `validateAcyclicity: true` and drop the single
  // `assertPreparedEdgeCreatesAcyclic` call) — the probe is then entered 8
  // times, once per attaching item, each with a single proposed edge.

  it("attaches every item of the batch", async () => {
    await withCountedCompositionStore(async (store) => {
      const whole = await store.nodes.Folder.create({ name: "whole" });
      const parts = await store.nodes.Folder.bulkCreate(
        Array.from({ length: ATTACHING_BATCH_SIZE }, (_, index) => ({
          props: { name: `part-${index}` },
          partOf: { kind: "Folder" as const, id: whole.id },
        })),
      );
      const edges = await store.edges.folderOf.find({});
      expect(edges).toHaveLength(ATTACHING_BATCH_SIZE);
      expect(new Set(edges.map((edge) => edge.fromId))).toEqual(
        new Set(parts.map((part) => part.id)),
      );
      expect(new Set(edges.map((edge) => edge.toId))).toEqual(
        new Set([whole.id]),
      );
    });
  });
});
