/**
 * bulkCreate round-trip batching.
 *
 * A batch create must not degenerate into per-row statements: existence
 * probes go through one getNodes per kind, uniqueness pre-checks through
 * one checkUniqueBatch per (constraint, kind), uniqueness entries through
 * one insertUniqueBatch, fulltext sync through one upsertFulltextBatch per
 * kind, and embedding sync through one upsertEmbeddingBatch per
 * (kind, field). These tests count backend calls through a spying overlay
 * (including inside the write transaction) and pin the batch-vs-per-row
 * split, alongside the behavioral semantics that must not drift:
 * in-batch conflicts, conflicts with existing rows, and create-over-
 * tombstone.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  embedding,
  searchable,
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";
import { UniquenessError } from "../src/errors";

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
    raw: GraphBackend,
  ) => Promise<T>,
): Promise<T> {
  const { backend: raw } = createLocalSqliteBackend();
  try {
    const { backend, counts } = withCallCounts(raw);
    const [store] = await createStoreWithSchema(buildGraph(), backend);
    // Boot traffic is not under test — count only what `run` triggers.
    for (const name of COUNTED_METHODS) counts[name] = 0;
    return await run(store, counts, raw);
  } finally {
    await raw.close();
  }
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
  it("replaces per-row existence probes with one getNodes per kind", async () => {
    await withCountedStore(async (store, counts) => {
      const created = await store.nodes.Person.bulkCreate(personInputs());
      expect(created).toHaveLength(BATCH_SIZE);

      expect(counts.getNodes).toBe(1);
      expect(counts.getNode).toBe(0);
    });
  });

  it("replaces per-row uniqueness pre-checks with one checkUniqueBatch per constraint", async () => {
    await withCountedStore(async (store, counts) => {
      await store.nodes.Person.bulkCreate(personInputs());

      expect(counts.checkUniqueBatch).toBe(1);
      expect(counts.checkUnique).toBe(0);
    });
  });
});

describe("bulkCreate side-effect batching", () => {
  it("writes uniqueness entries through one insertUniqueBatch", async () => {
    await withCountedStore(async (store, counts) => {
      await store.nodes.Person.bulkCreate(personInputs());

      expect(counts.insertUniqueBatch).toBe(1);
      expect(counts.insertUnique).toBe(0);
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

      expect(counts.upsertFulltextBatch).toBe(1);
      expect(counts.upsertFulltext).toBe(0);
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

      expect(counts.upsertEmbeddingBatch).toBe(1);
      expect(counts.upsertEmbedding).toBe(0);
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

  it("still rejects create over a tombstoned id at the insert", async () => {
    // Pins current semantics: the existence probe lets tombstoned ids
    // through (only live rows raise NodeAlreadyExistsError) and the INSERT
    // then fails on the primary key — resurrect goes through upsert paths,
    // not create. Probe batching must not change this.
    await withCountedStore(async (store) => {
      const node = await store.nodes.Person.create({
        name: "first",
        email: "gone@example.com",
      });
      await store.nodes.Person.delete(node.id);

      await expect(
        store.nodes.Person.bulkCreate([
          {
            id: node.id,
            props: { name: "second", email: "back@example.com" },
          },
        ]),
      ).rejects.toThrow();
    });
  });
});
