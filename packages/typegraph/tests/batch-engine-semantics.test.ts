/**
 * Batch-tier atomicity and eligibility, pinned against real engines through
 * the D1- and Neon-shaped harnesses in `batch-engine-harness.ts`.
 *
 * These are the tests the harness exists for: every prior D1/Neon fixture in
 * this package fabricates its `batch()`/`transaction()` rows by matching
 * substrings of the emitted SQL, so no test has ever exercised what a
 * failing statement inside a real closed batch actually does to the
 * statements that ran before it. Here the transport is real (better-sqlite3
 * for D1, PGlite for Neon HTTP), so a rollback is the engine's own, not an
 * asserted fixture value.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EndpointNotFoundError, StaleVersionError } from "../src";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { migrateSchema } from "../src/schema";
import { createStoreWithSchema } from "../src/store";
import {
  type BatchEngineHarness,
  createD1BatchEngineHarness,
  createNeonHttpBatchEngineHarness,
} from "./batch-engine-harness";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});
const graph = defineGraph({
  id: "batch-engine-semantics",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
  },
});

// A backward-compatible evolution of `graph` (same id, additive optional
// field) — enough for `migrateSchema` to commit a new active version without
// touching anything this suite writes.
const evolvedGraph = defineGraph({
  id: graph.id,
  nodes: {
    Person: {
      type: defineNode("Person", {
        schema: z.object({ name: z.string(), nickname: z.string().optional() }),
      }),
    },
    Company: { type: Company },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
  },
});

type HarnessKind = "d1" | "neon-http";

// Small enough that two edges fill the first chunk and a third starts a
// second one, on both dialects: `floor((30 - schemaFenceParams) / edgeInsertParams)`
// is 2 for both the SQLite and PostgreSQL fenced-edge-insert builders.
const CHUNKING_MAX_BIND_PARAMETERS = 30;

async function createHarness(
  kind: HarnessKind,
  maxBindParameters?: number,
): Promise<BatchEngineHarness> {
  const capabilities =
    maxBindParameters === undefined ? undefined : { maxBindParameters };
  if (kind === "d1") {
    return createD1BatchEngineHarness(
      capabilities === undefined ? {} : { capabilities },
    );
  }
  return createNeonHttpBatchEngineHarness(
    capabilities === undefined ? {} : { capabilities },
  );
}

/**
 * Commits the schema through the harness's interactive handle (schema
 * commits refuse on the batch-shaped backend, by design), then boots a Store
 * on the batch-shaped backend — a pure read-only reconciliation, since the
 * hash already matches what the interactive handle just committed.
 */
async function bootHarnessStore(harness: BatchEngineHarness) {
  await createStoreWithSchema(graph, harness.interactiveBackend);
  const [store] = await createStoreWithSchema(graph, harness.backend);
  return store;
}

describe.each([
  { label: "D1", kind: "d1" as const },
  { label: "Neon HTTP", kind: "neon-http" as const },
])("batch engine semantics ($label)", ({ kind }) => {
  it("declares unitOfWork batch on the harness backend and interactive on its bundled peer", async () => {
    const harness = await createHarness(kind);
    try {
      expect(
        harness.backend.capabilities.execution.interactiveTransactions,
      ).toBe(false);
      expect(harness.backend.capabilities.execution.unitOfWork).toBe("batch");
      expect(
        harness.interactiveBackend.capabilities.execution
          .interactiveTransactions,
      ).toBe(true);
      expect(harness.interactiveBackend.capabilities.execution.unitOfWork).toBe(
        "interactive",
      );
    } finally {
      await harness.close();
    }
  });

  it("leaves no row from an earlier chunk when a later chunk's endpoint is missing", async () => {
    const harness = await createHarness(kind, CHUNKING_MAX_BIND_PARAMETERS);
    try {
      const store = await bootHarnessStore(harness);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      // Two valid edges fill the first chunk; the third — a missing
      // endpoint — starts a second chunk on its own (CHUNKING_MAX_BIND_PARAMETERS
      // makes the chunk size exactly 2 on both dialects). The native SQL
      // turns a missing endpoint into a NOT NULL violation on the edge's
      // primary key, so this statement errors instead of silently returning
      // zero rows — the property the whole batch's atomicity depends on.
      await expect(
        store.edges.worksAt.bulkInsert([
          { from: alice, to: acme, props: { role: "Engineer" } },
          { from: bob, to: acme, props: { role: "Designer" } },
          {
            from: alice,
            to: { kind: "Company", id: "missing-company" },
            props: { role: "Ghost" },
          },
        ]),
      ).rejects.toBeInstanceOf(EndpointNotFoundError);

      // The whole batch() / transaction() call rolled back: the first
      // chunk's two otherwise-valid edges are gone too.
      await expect(store.edges.worksAt.count()).resolves.toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("writes nothing and raises StaleVersionError after its re-diagnosis read", async () => {
    const harness = await createHarness(kind);
    try {
      const store = await bootHarnessStore(harness);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      // Bumps the active schema version through the interactive handle —
      // "another handle" committing concurrently. `store` above still
      // carries the schema version it read at boot, which is now stale.
      await migrateSchema(harness.interactiveBackend, evolvedGraph, 1);

      await expect(
        store.edges.worksAt.bulkInsert([
          { from: alice, to: acme, props: { role: "Engineer" } },
        ]),
      ).rejects.toBeInstanceOf(StaleVersionError);
      await expect(store.edges.worksAt.count()).resolves.toBe(0);
    } finally {
      await harness.close();
    }
  });
});
