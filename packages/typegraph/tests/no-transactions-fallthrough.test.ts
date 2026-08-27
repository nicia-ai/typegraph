/**
 * Pins the contract for backends that report no interactive transactions
 * (e.g. `drizzle-orm/neon-http`, Cloudflare D1).
 *
 * Wraps a real in-memory SQLite backend, disables `execution.interactiveTransactions`
 * and makes `backend.transaction(...)` throw, then verifies that
 * Store transaction callbacks fail closed before user code runs. Other
 * APIs that intentionally use sequential execution remain covered by
 * their own tests. If a future change accidentally invokes a callback on
 * this backend, the assertions below will catch the contract regression.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  searchable,
} from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { computeSchemaHash, serializeSchema } from "../src/schema/serializer";
import {
  createInitializedStore,
  createRawInitializedStore,
  createTestBackend,
  disableTransactions,
  matchingObject,
} from "./test-utils";

// The message the shared `disableTransactions` helper rejects with; asserted by
// the precondition ("sanity") test below.
const TRANSACTIONS_DISABLED_MESSAGE =
  "synthetic backend has transactions disabled";

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    bio: z.string().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});

const graph = defineGraph({
  id: "no_tx_fallthrough",
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
  },
});

const identityGraph = defineGraph({
  id: "no_tx_identity_refusal",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

describe("backends without interactive transactions fail closed at Store transactions", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = disableTransactions(createTestBackend());
  });

  it("synthetic backend rejects backend.transaction() (sanity)", async () => {
    // If the wrapper ever stops throwing, the rest of this file becomes
    // meaningless — assert the precondition explicitly.
    await expect(
      backend.transaction(() => Promise.resolve("unreachable")),
    ).rejects.toThrow(TRANSACTIONS_DISABLED_MESSAGE);
    expect(backend.capabilities.execution.interactiveTransactions).toBe(false);
  });

  it("schema-managed Store writes fail closed before any write", async () => {
    const store = await createInitializedStore(graph, backend);

    await expect(
      store.nodes.Person.create({ name: "Blocked" }),
    ).rejects.toMatchObject({
      details: { code: "SCHEMA_WRITE_FENCE_UNSUPPORTED", graphId: graph.id },
    });
    await expect(store.nodes.Person.find()).resolves.toEqual([]);
  });

  // Note: schema commits are NOT a fall-through path — they refuse on
  // non-transactional backends. That contract is exercised below with a
  // genuinely-non-transactional backend, since the synthetic disable
  // wrapper used elsewhere in this file only overrides public methods
  // and can't reach into the backend's closure-scoped transaction
  // config.

  it("store.transaction(fn) refuses before invoking the callback", async () => {
    const store = await createRawInitializedStore(graph, backend);
    let invoked = false;

    await expect(
      store.transaction(async (tx) => {
        invoked = true;
        await tx.nodes.Person.create({ name: "must-not-persist" });
        throw new Error("callback must not run");
      }),
    ).rejects.toMatchObject({
      name: "UnsupportedBackendCapabilityError",
      details: {
        graphId: graph.id,
        capability: "transactions",
      },
    });
    expect(invoked).toBe(false);
    await expect(store.nodes.Person.find()).resolves.toEqual([]);
  });

  it("transactionWithReceipt refuses before invoking the callback", async () => {
    const store = await createRawInitializedStore(graph, backend);
    let invoked = false;

    await expect(
      store.transactionWithReceipt(() => {
        invoked = true;
        return Promise.resolve();
      }),
    ).rejects.toMatchObject({
      name: "UnsupportedBackendCapabilityError",
      details: {
        graphId: graph.id,
        capability: "transactions",
      },
    });
    expect(invoked).toBe(false);
  });

  it("store.batch returns per-query results without throwing", async () => {
    const store = await createRawInitializedStore(graph, backend);

    await store.nodes.Person.create({ name: "Alice" });
    await store.nodes.Person.create({ name: "Bob" });
    await store.nodes.Company.create({ name: "Acme" });

    const [people, companies] = await store.batch(
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ({ name: ctx.p.name })),
      store
        .query()
        .from("Company", "c")
        .select((ctx) => ({ name: ctx.c.name })),
    );

    expect(people.map((p) => p.name).toSorted()).toEqual(["Alice", "Bob"]);
    expect(companies.map((c) => c.name)).toEqual(["Acme"]);
  });

  it("store.search.rebuildFulltext completes via sequential page writes", async () => {
    // The fulltext rebuild path used to wrap each page's upserts/deletes
    // in backend.transaction(...). Verify it now runs the writes
    // sequentially when the backend reports no interactive transactions.
    const Document = defineNode("Document", {
      schema: z.object({
        title: searchable({ language: "english" }),
        body: searchable({ language: "english" }),
      }),
    });
    const documentGraph = defineGraph({
      id: "no_tx_fallthrough_docs",
      nodes: { Document: { type: Document } },
      edges: {},
    });
    const store = await createRawInitializedStore(documentGraph, backend);

    await store.nodes.Document.create({
      title: "First",
      body: "alpha beta",
    });
    await store.nodes.Document.create({
      title: "Second",
      body: "gamma delta",
    });

    const result = await store.search.rebuildFulltext();
    expect(result.kinds).toContain("Document");
    expect(result.processed).toBe(2);
    expect(result.upserted).toBe(2);
    expect(result.skipped).toBe(0);
  });
});

describe("backends without interactive transactions refuse schema commits", () => {
  // Genuine non-transactional configuration via the SQLite execution
  // profile, so the closure-scoped transactionMode inside the backend
  // observes "none" — the production code path for D1 / DurableObjects.
  let nonTxBackend: GraphBackend;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    for (const statement of generateSqliteDDL()) {
      sqlite.exec(statement);
    }
    nonTxBackend = createSqliteBackend(db, {
      executionProfile: { transactionMode: "none", isSync: true },
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  it("refuses Operational Identity with the stable driver capability code", () => {
    expect(() => createStore(identityGraph, nonTxBackend)).toThrow(
      expect.objectContaining({
        name: "ConfigurationError",
        details: matchingObject({
          code: "IDENTITY_REQUIRES_ATOMIC_BACKEND",
          execution: { interactiveTransactions: false, atomicBatch: "none" },
        }),
      }),
    );
  });

  it("commitSchemaVersion throws ConfigurationError", async () => {
    const v1 = serializeSchema(graph, 1);
    await expect(
      nonTxBackend.commitSchemaVersion({
        graphId: graph.id,
        expected: { kind: "initial" },
        version: 1,
        schemaHash: await computeSchemaHash(v1),
        schemaDoc: v1,
      }),
    ).rejects.toThrow(ConfigurationError);
  });

  it("setActiveVersion throws ConfigurationError", async () => {
    await expect(
      nonTxBackend.setActiveVersion({
        graphId: graph.id,
        expected: { kind: "active", version: 1 },
        version: 2,
      }),
    ).rejects.toThrow(ConfigurationError);
  });
});
