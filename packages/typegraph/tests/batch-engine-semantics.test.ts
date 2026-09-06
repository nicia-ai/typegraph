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

import {
  ConfigurationError,
  EndpointNotFoundError,
  StaleVersionError,
  UniquenessError,
  ValidationError,
} from "../src";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { migrateSchema } from "../src/schema";
import { createStoreWithSchema } from "../src/store";
import {
  type BatchEngineHarness,
  createD1BatchEngineHarness,
  createNeonHttpBatchEngineHarness,
} from "./batch-engine-harness";
import { matchingObject } from "./test-utils";

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

// A node with a claimed unique field, for the constrained-write-inside-the-
// claim-envelope scenario: the claim/reservation row and the node row commit
// or roll back together inside one atomic program.
const ClaimedPerson = defineNode("ClaimedPerson", {
  schema: z.object({ email: z.string() }),
});
const claimGraph = defineGraph({
  id: "batch-engine-semantics-claim",
  nodes: {
    ClaimedPerson: {
      type: ClaimedPerson,
      unique: [
        {
          name: "claimed_person_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

// A graph whose identity is on, purely to exercise the Store-construction
// refusal a batch-tier backend hits before any row is read or written.
const identityGraph = defineGraph({
  id: "batch-engine-semantics-identity",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
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

  it("conflicts on the claim row for a constrained write inside the claim envelope, leaving no row", async () => {
    const harness = await createHarness(kind);
    try {
      await createStoreWithSchema(claimGraph, harness.interactiveBackend);
      const [store] = await createStoreWithSchema(claimGraph, harness.backend);
      // A single `create()` on an own-kind unique constraint takes no lock
      // fence (the uniques primary key is the whole fence) but also does not
      // fuse (`uniqueConstraintCount` must be zero to fuse), so it still
      // needs the portable schema fence a batch engine has no session to
      // hold. `bulkCreate` runs through the claim envelope's atomic program
      // instead, which is what this scenario is about.
      await store.nodes.ClaimedPerson.bulkCreate([
        { props: { email: "alice@example.com" } },
      ]);

      // The second item's claim conflicts with the row the earlier
      // `bulkCreate` already committed, not with the first item of this same
      // batch. The typed uniqueness error surfaces, and `count()` staying at
      // 1 (not 2) proves the first item of THIS batch rolled back with it.
      await expect(
        store.nodes.ClaimedPerson.bulkInsert([
          { props: { email: "bob@example.com" } },
          { props: { email: "alice@example.com" } },
        ]),
      ).rejects.toBeInstanceOf(UniquenessError);
      await expect(store.nodes.ClaimedPerson.count()).resolves.toBe(1);
    } finally {
      await harness.close();
    }
  });

  it("fuses a supplied-id singleton create, fences it, and reports a duplicate id", async () => {
    const harness = await createHarness(kind);
    try {
      const store = await bootHarnessStore(harness);

      const created = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "explicit-person-id" },
      );
      expect(created.id).toBe("explicit-person-id");
      await expect(store.nodes.Person.count()).resolves.toBe(1);

      // Same id again: the fused if-absent statement writes nothing, and the
      // duplicate is reported through the ordinary typed error.
      await expect(
        store.nodes.Person.create(
          { name: "Bob" },
          { id: "explicit-person-id" },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(store.nodes.Person.count()).resolves.toBe(1);

      // A stale schema version: the fenced statement writes nothing and the
      // store re-diagnoses it as StaleVersionError.
      await migrateSchema(harness.interactiveBackend, evolvedGraph, 1);
      await expect(
        store.nodes.Person.create(
          { name: "Cara" },
          { id: "another-explicit-id" },
        ),
      ).rejects.toBeInstanceOf(StaleVersionError);
      await expect(store.nodes.Person.count()).resolves.toBe(1);
    } finally {
      await harness.close();
    }
  });

  it("refuses to resurrect a supplied-id create over a tombstoned row", async () => {
    const harness = await createHarness(kind);
    try {
      const store = await bootHarnessStore(harness);

      const created = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "resurrection-candidate" },
      );
      await store.nodes.Person.bulkDelete([created.id]);

      // The fused if-absent INSERT finds the id occupied by a tombstone.
      // Resurrecting it is a real UPDATE outside the fused statement's
      // atomicity, so the batch engine — with no session to hold a fence
      // across it — refuses instead of writing the row unfenced.
      await expect(
        store.nodes.Person.create(
          { name: "Bob" },
          { id: "resurrection-candidate" },
        ),
      ).rejects.toMatchObject({
        details: matchingObject({ code: "SCHEMA_WRITE_FENCE_UNSUPPORTED" }),
      });
      await expect(store.nodes.Person.count()).resolves.toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("reaches every batch-write refusal reason with a reported reason", async () => {
    const harness = await createHarness(kind);
    try {
      const store = await bootHarnessStore(harness);

      // interactive-callback: store.transaction() needs an open callback
      // session a closed batch program cannot hold.
      await expect(
        store.transaction(() => Promise.resolve(undefined)),
      ).rejects.toMatchObject({
        details: matchingObject({
          batchRefusal: {
            code: "BATCH_WRITE_UNSUPPORTED",
            reason: "interactive-callback",
          },
        }),
      });

      // constraint-needs-probe: a dynamic match-key convergence write needs a
      // read that steers what it writes.
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      await expect(
        store.edges.worksAt.getOrCreateByEndpoints(alice, acme, {
          role: "Engineer",
        }),
      ).rejects.toMatchObject({
        details: matchingObject({
          batchRefusal: {
            code: "BATCH_WRITE_UNSUPPORTED",
            reason: "constraint-needs-probe",
          },
        }),
      });

      // identity: Operational Identity's closure maintenance needs several
      // round trips inside one held transaction.
      await createStoreWithSchema(identityGraph, harness.interactiveBackend);
      await expect(
        createStoreWithSchema(identityGraph, harness.backend),
      ).rejects.toMatchObject({
        details: matchingObject({
          batchRefusal: { code: "BATCH_WRITE_UNSUPPORTED", reason: "identity" },
        }),
      });

      // history: recorded-time capture needs the per-graph write lock and
      // clock held across a whole write cascade.
      await expect(
        createStoreWithSchema(graph, harness.backend, { history: true }),
      ).rejects.toMatchObject({
        details: matchingObject({
          batchRefusal: { code: "BATCH_WRITE_UNSUPPORTED", reason: "history" },
        }),
      });

      // schema-commit: committing a schema version needs one held
      // transaction across its compare-and-swap read and its activating
      // write.
      const schemaCommitRejection = await migrateSchema(
        harness.backend,
        evolvedGraph,
        1,
      ).catch((error: unknown) => error);
      expect(schemaCommitRejection).toBeInstanceOf(ConfigurationError);
      expect(schemaCommitRejection).toMatchObject({
        details: matchingObject({
          batchRefusal: {
            code: "BATCH_WRITE_UNSUPPORTED",
            reason: "schema-commit",
          },
        }),
      });
    } finally {
      await harness.close();
    }
  });
});
