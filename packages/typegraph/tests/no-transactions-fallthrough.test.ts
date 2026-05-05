/**
 * Pins the contract for backends that report `transactions: false`
 * (e.g. `drizzle-orm/neon-http`, Cloudflare D1).
 *
 * Wraps a real in-memory SQLite backend, flips `capabilities.transactions`
 * off, and makes `backend.transaction(...)` throw — then walks every
 * code path that historically wrapped its work in a transaction and
 * asserts it now completes via the sequential fall-through instead of
 * throwing. If a future change re-introduces an unconditional
 * `backend.transaction(...)` in any of these paths, the corresponding
 * test will fail with the synthetic transaction-disabled error.
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
import { createTestBackend } from "./test-utils";

const TRANSACTIONS_DISABLED_MESSAGE =
  "synthetic backend has transactions disabled";

/**
 * Wraps a real backend so any unconditional `transaction(...)` call
 * throws — every other operation works normally. Mirrors the shape of
 * `drizzle-orm/neon-http`'s session, which throws "No transactions
 * support in neon-http driver" on `db.transaction(...)`.
 */
function disableTransactions(backend: GraphBackend): GraphBackend {
  return {
    ...backend,
    capabilities: { ...backend.capabilities, transactions: false },
    transaction: () => Promise.reject(new Error(TRANSACTIONS_DISABLED_MESSAGE)),
  };
}

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

describe("backends with transactions: false fall through to sequential execution", () => {
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
    expect(backend.capabilities.transactions).toBe(false);
  });

  // Note: schema commits are NOT a fall-through path — they refuse on
  // non-transactional backends. That contract is exercised below with a
  // genuinely-non-transactional backend, since the synthetic disable
  // wrapper used elsewhere in this file only overrides public methods
  // and can't reach into the backend's closure-scoped transaction
  // config.

  it("store.transaction(fn) executes fn against the main backend", async () => {
    const store = createStore(graph, backend);

    const result = await store.transaction(async (tx) => {
      const person = await tx.nodes.Person.create({ name: "Alice" });
      const company = await tx.nodes.Company.create({ name: "Acme" });
      const edge = await tx.edges.worksAt.create(person, company, {
        role: "Engineer",
      });
      return { personId: person.id, companyId: company.id, edgeId: edge.id };
    });

    // Writes are visible after the (non-atomic) callback returns.
    const person = await store.nodes.Person.getById(result.personId);
    expect(person?.name).toBe("Alice");
    const company = await store.nodes.Company.getById(result.companyId);
    expect(company?.name).toBe("Acme");
  });

  it("store.transaction errors propagate without rollback", async () => {
    const store = createStore(graph, backend);
    const persisted = await store.nodes.Person.create({ name: "Persisted" });

    await expect(
      store.transaction(async (tx) => {
        await tx.nodes.Person.create({ name: "AlsoPersisted" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Without transactions, prior writes inside the callback are NOT
    // rolled back. This is the documented contract.
    const allPeople = await store.nodes.Person.find();
    expect(allPeople.map((person) => person.name).toSorted()).toEqual([
      "AlsoPersisted",
      "Persisted",
    ]);
    expect(persisted.id).toBeDefined();
  });

  it("store.batch returns per-query results without throwing", async () => {
    const store = createStore(graph, backend);

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
    // sequentially when the backend reports transactions: false.
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
    const store = createStore(documentGraph, backend);

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

describe("backends with transactions: false refuse schema commits", () => {
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
