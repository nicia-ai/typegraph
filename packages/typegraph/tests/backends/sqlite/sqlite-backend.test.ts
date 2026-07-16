/**
 * SQLite Backend Integration Tests
 *
 * Tests the SQLite adapter with a real in-memory database.
 * Follows Better Auth's pattern: users provide a configured Drizzle instance
 * and run migrations to create TypeGraph tables.
 */
import { existsSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import {
  type BetterSQLite3Database,
  drizzle as drizzleBetterSqlite3,
} from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asCompiledRowsSql,
  BackendDisposedError,
  defineEdge,
  defineGraph,
  defineNode,
  subClassOf,
} from "../../../src";

const nodeRequire = createRequire(import.meta.url);
import { tables } from "../../../src/backend/drizzle/schema/sqlite";
import {
  createSqliteBackend,
  generateSqliteDDL,
} from "../../../src/backend/sqlite";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import {
  INTERNAL_TEMPORARY_WRITES,
  type UpsertEmbeddingParams,
  type VectorSearchParams,
  type VectorSearchResult,
} from "../../../src/backend/types";
import { sqliteVecStrategy } from "../../../src/query/dialect/vector/sqlite-vec-strategy";
import { asCompiledTemporaryStatementSql } from "../../../src/query/sql-intent";
import { createStore } from "../../../src/store";
import { createTestBackend, createTestDatabase } from "../../test-utils";
import { createAdapterTestSuite } from "../adapter-test-suite";
import { createIntegrationTestSuite } from "../integration-test-suite";

// ============================================================
// Shared Adapter Test Suite
// ============================================================

// Run the shared adapter test suite for SQLite
createAdapterTestSuite("SQLite", () => createTestBackend());

// ============================================================
// Shared Integration Test Suite
// ============================================================

// Run the shared integration test suite for SQLite
createIntegrationTestSuite("SQLite", () => {
  const db = createTestDatabase();
  // SQLite uses in-memory databases, no cleanup needed
  return { backend: createSqliteBackend(db) };
});

// ============================================================
// SQLite-Specific Tests
// ============================================================

describe("SQLite Backend - Adapter Specific", () => {
  let db: BetterSQLite3Database;

  beforeEach(() => {
    db = createTestDatabase();
  });

  describe("createSqliteBackend()", () => {
    it("creates a backend with correct dialect and capabilities", () => {
      const backend = createSqliteBackend(db);

      expect(backend.dialect).toBe("sqlite");
      expect(backend.capabilities.transactions).toBe(true);
      expect(backend.capabilities.graphAnalytics).toEqual({
        supported: true,
        mathFunctions: false,
      });
    });

    it("reuses prepared statements in execute() for repeated SQL shapes", async () => {
      const sqliteClient = (
        db as {
          $client?: {
            prepare?: (sqlText: string) => {
              all: (...params: unknown[]) => unknown[];
            };
          };
        }
      ).$client;
      if (sqliteClient?.prepare === undefined) return;

      const originalPrepare = sqliteClient.prepare;
      let prepareCalls = 0;

      try {
        const backend = createSqliteBackend(db);
        await backend.insertNode({
          graphId: "test_graph",
          kind: "Person",
          id: "person-cache-1",
          props: { name: "Alice" },
        });

        sqliteClient.prepare = (sqlText) => {
          prepareCalls += 1;
          return originalPrepare.call(sqliteClient, sqlText);
        };

        const query = sql`
          SELECT id
          FROM typegraph_nodes
          WHERE graph_id = ${"test_graph"}
            AND kind = ${"Person"}
            AND deleted_at IS NULL
        `;

        await backend.execute<{ id: string }>(asCompiledRowsSql(query));
        await backend.execute<{ id: string }>(asCompiledRowsSql(query));
        await backend.execute<{ id: string }>(asCompiledRowsSql(query));

        expect(prepareCalls).toBe(1);
      } finally {
        sqliteClient.prepare = originalPrepare;
      }
    });
  });

  describe("bootstrapTables() index adoption", () => {
    it("adds newly shipped indexes to an already-initialized database", async () => {
      const { backend, db } = createLocalSqliteBackend();
      try {
        await backend.bootstrapTables!();

        // Simulate a database initialized before the bare-id indexes
        // shipped. Bootstrap never re-runs automatically on an initialized
        // database (createStore is zero-DDL), so a one-time explicit
        // `backend.bootstrapTables()` is the documented adoption path —
        // every statement is CREATE … IF NOT EXISTS.
        db.run(sql`DROP INDEX "typegraph_nodes_id_idx"`);
        db.run(sql`DROP INDEX "typegraph_recorded_nodes_id_idx"`);

        async function indexNames(): Promise<readonly string[]> {
          const rows = await backend.execute<{ name: string }>(
            asCompiledRowsSql(
              sql`SELECT name FROM sqlite_master WHERE type = 'index'`,
            ),
          );
          return rows.map((row) => row.name);
        }
        expect(await indexNames()).not.toContain("typegraph_nodes_id_idx");

        await backend.bootstrapTables!();

        const adopted = await indexNames();
        expect(adopted).toContain("typegraph_nodes_id_idx");
        expect(adopted).toContain("typegraph_recorded_nodes_id_idx");
      } finally {
        await backend.close();
      }
    });
  });

  describe("generateSqliteDDL()", () => {
    it("generates DDL that creates all required tables", () => {
      const ddl = generateSqliteDDL(tables);
      const sql = ddl.join("\n");

      expect(sql).toContain('CREATE TABLE IF NOT EXISTS "typegraph_nodes"');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS "typegraph_edges"');
      expect(sql).toContain(
        'CREATE TABLE IF NOT EXISTS "typegraph_node_uniques"',
      );
      expect(sql).toContain(
        'CREATE TABLE IF NOT EXISTS "typegraph_schema_versions"',
      );
    });

    it("generates DDL with necessary indexes", () => {
      const ddl = generateSqliteDDL(tables);
      const sql = ddl.join("\n");

      expect(sql).toContain("CREATE INDEX IF NOT EXISTS");
      expect(sql).toContain("typegraph_nodes_kind_idx");
      expect(sql).toContain("typegraph_nodes_kind_created_idx");
      // Bare-id node lookup (kind resolved by id) — see typegraph#280.
      expect(sql).toContain('"typegraph_nodes" ("graph_id", "id")');
      expect(sql).toContain('"typegraph_recorded_nodes" ("graph_id", "id")');
      expect(sql).toContain("typegraph_edges_from_idx");
      expect(sql).toContain("typegraph_edges_to_idx");
      expect(sql).toContain("typegraph_edges_kind_created_idx");
      expect(sql).toContain(
        '"typegraph_edges" ("graph_id", "from_kind", "from_id", "kind", "to_kind", "deleted_at", "valid_from", "valid_to", "to_id")',
      );
      expect(sql).toContain(
        '"typegraph_edges" ("graph_id", "to_kind", "to_id", "kind", "from_kind", "deleted_at", "valid_from", "valid_to", "from_id")',
      );
      expect(sql).toContain(
        '"typegraph_nodes" ("graph_id", "kind", "deleted_at", "created_at")',
      );
      expect(sql).toContain(
        '"typegraph_edges" ("graph_id", "kind", "deleted_at", "created_at")',
      );
    });
  });
});

// ============================================================
// Test Schema for Store Integration
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.email().optional(),
    age: z.number().int().positive().optional(),
  }),
});

const Organization = defineNode("Organization", {
  schema: z.object({
    name: z.string(),
    website: z.url().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    website: z.url().optional(),
    ticker: z.string().length(4).optional(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startDate: z.string().optional(),
  }),
});

const knows = defineEdge("knows");

const testGraph = defineGraph({
  id: "test_graph",
  nodes: {
    Person: { type: Person },
    Organization: { type: Organization },
    Company: { type: Company },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Organization, Company],
      cardinality: "many",
    },
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
  ontology: [subClassOf(Company, Organization)],
});

// ============================================================
// Store Integration Tests
// ============================================================

describe("Store with SQLite Backend", () => {
  let db: BetterSQLite3Database;

  beforeEach(() => {
    db = createTestDatabase();
  });

  it("creates a store with SQLite backend", () => {
    const backend = createSqliteBackend(db);
    const store = createStore(testGraph, backend);

    expect(store.graphId).toBe("test_graph");
    expect(store.registry).toBeDefined();
  });

  it("creates and retrieves nodes through the store", async () => {
    const backend = createSqliteBackend(db);
    const store = createStore(testGraph, backend);

    const person = await store.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
    });

    expect(person.kind).toBe("Person");
    expect(person.name).toBe("Alice");
    expect(person.email).toBe("alice@example.com");
    expect(person.id).toBeDefined();

    const fetched = await store.nodes.Person.getById(person.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("Alice");
  });

  it("validates node props against schema", async () => {
    const backend = createSqliteBackend(db);
    const store = createStore(testGraph, backend);

    // Invalid email should fail validation
    await expect(
      store.nodes.Person.create({ name: "Alice", email: "not-an-email" }),
    ).rejects.toThrow();
  });

  it("creates edges between nodes", async () => {
    const backend = createSqliteBackend(db);
    const store = createStore(testGraph, backend);

    const person = await store.nodes.Person.create({ name: "Alice" });
    const company = await store.nodes.Company.create({ name: "Acme Inc" });

    const createdEdge = await store.edges.worksAt.create(
      { kind: "Person", id: person.id },
      { kind: "Company", id: company.id },
      { role: "Engineer" },
    );

    expect(createdEdge.kind).toBe("worksAt");
    expect(createdEdge.fromId).toBe(person.id);
    expect(createdEdge.toId).toBe(company.id);
    expect(createdEdge.role).toBe("Engineer");
  });

  it("validates edge endpoint types using ontology", async () => {
    const backend = createSqliteBackend(db);
    const store = createStore(testGraph, backend);

    const person = await store.nodes.Person.create({ name: "Alice" });

    // Company is a subclass of Organization, so this should work
    const company = await store.nodes.Company.create({ name: "Acme Inc" });

    // worksAt allows Person -> Organization, Company subClassOf Organization
    const createdEdge = await store.edges.worksAt.create(
      { kind: "Person", id: person.id },
      { kind: "Company", id: company.id },
      { role: "Engineer" },
    );

    expect(createdEdge).toBeDefined();
  });

  it("rejects edges with invalid endpoint types", async () => {
    const backend = createSqliteBackend(db);
    const store = createStore(testGraph, backend);

    const person1 = await store.nodes.Person.create({ name: "Alice" });
    const person2 = await store.nodes.Person.create({ name: "Bob" });

    // TypeScript now catches invalid endpoint types at compile time.
    // Use type assertion to bypass for runtime validation testing.
    // worksAt requires target to be Organization or Company, not Person
    await expect(
      store.edges.worksAt.create(
        { kind: "Person", id: person1.id },
        { kind: "Person", id: person2.id } as unknown as {
          kind: "Company";
          id: string;
        },
        { role: "Engineer" },
      ),
    ).rejects.toThrow();
  });

  it("executes transactions atomically", async () => {
    const backend = createSqliteBackend(db);
    const store = createStore(testGraph, backend);

    const result = await store.transaction(async (tx) => {
      const person = await tx.nodes.Person.create({ name: "Alice" });
      const company = await tx.nodes.Company.create({ name: "Acme Inc" });

      const createdEdge = await tx.edges.worksAt.create(
        { kind: "Person", id: person.id },
        { kind: "Company", id: company.id },
        { role: "Engineer" },
      );

      return { person, company, edge: createdEdge };
    });

    expect(result.person.id).toBeDefined();
    expect(result.company.id).toBeDefined();
    expect(result.edge.id).toBeDefined();

    // Verify all exist
    const fetchedPerson = await store.nodes.Person.getById(result.person.id);
    expect(fetchedPerson).toBeDefined();
  });

  it("keeps sync transaction scope isolated from concurrent operations", async () => {
    const backend = createSqliteBackend(db);

    const transactionPromise = backend.transaction(async (txBackend) => {
      await txBackend.insertNode({
        graphId: "test_graph",
        kind: "Person",
        id: "tx-person",
        props: { name: "Tx User" },
      });

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });

      throw new Error("rollback transaction");
    });

    const outsideInsertPromise = (async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });

      await backend.insertNode({
        graphId: "test_graph",
        kind: "Person",
        id: "outside-person",
        props: { name: "Outside User" },
      });
    })();

    await expect(transactionPromise).rejects.toThrow("rollback transaction");
    await outsideInsertPromise;

    const rolledBackNode = await backend.getNode(
      "test_graph",
      "Person",
      "tx-person",
    );
    const outsideNode = await backend.getNode(
      "test_graph",
      "Person",
      "outside-person",
    );

    expect(rolledBackNode).toBeUndefined();
    expect(outsideNode).toBeDefined();
  });

  it("updates nodes", async () => {
    const backend = createSqliteBackend(db);
    const store = createStore(testGraph, backend);

    const person = await store.nodes.Person.create({ name: "Alice" });

    const updated = await store.nodes.Person.update(person.id, {
      name: "Alice Smith",
      age: 30,
    });

    expect(updated.name).toBe("Alice Smith");
    expect(updated.age).toBe(30);
    expect(updated.meta.version).toBe(2);
  });

  it("soft deletes nodes", async () => {
    const backend = createSqliteBackend(db);
    const store = createStore(testGraph, backend);

    const person = await store.nodes.Person.create({ name: "Alice" });

    await store.nodes.Person.delete(person.id);

    // Default temporal mode is "current", so deleted nodes shouldn't be returned
    const fetched = await store.nodes.Person.getById(person.id);
    expect(fetched).toBeUndefined();

    // But with includeTombstones, it should be visible
    const fetchedWithTombstones = await store.nodes.Person.getById(person.id, {
      temporalMode: "includeTombstones",
    });
    expect(fetchedWithTombstones).toBeDefined();
    expect(fetchedWithTombstones!.meta.deletedAt).toBeDefined();
  });
});

// ============================================================
// Transaction Mode Tests
// ============================================================

describe("SQLite Backend - Transaction Modes", () => {
  let db: BetterSQLite3Database;

  beforeEach(() => {
    db = createTestDatabase();
  });

  it("defaults to 'raw' transaction mode for better-sqlite3", () => {
    const backend = createSqliteBackend(db);
    expect(backend.capabilities.transactions).toBe(true);
  });

  it("throws ConfigurationError when transactionMode is 'none'", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { transactionMode: "none" },
    });
    expect(backend.capabilities.transactions).toBe(false);
    expect(backend.capabilities.graphAnalytics?.supported).toBe(false);

    await expect(backend.transaction(() => Promise.resolve())).rejects.toThrow(
      /does not support atomic transactions/,
    );
  });

  it("includes backend label in 'none' mode error", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { transactionMode: "none" },
    });

    await expect(backend.transaction(() => Promise.resolve())).rejects.toThrow(
      /This SQLite backend does not support/,
    );
  });

  it("allows explicit transactionMode 'raw' to override auto-detection", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { transactionMode: "sql" },
    });
    expect(backend.capabilities.transactions).toBe(true);

    const store = createStore(testGraph, backend);
    const person = await store.transaction(async (tx) => {
      return tx.nodes.Person.create({ name: "Bob" });
    });
    expect(person.name).toBe("Bob");
  });

  // Note: transactionMode "drizzle" cannot be tested with better-sqlite3 because
  // its native .transaction() rejects async callbacks. The "drizzle" path is
  // intended for async drivers (libsql, sql.js) and potentially Durable Objects.
  it("attempts Drizzle transaction when transactionMode is 'drizzle'", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { transactionMode: "drizzle" },
    });
    expect(backend.capabilities.transactions).toBe(true);

    // better-sqlite3 rejects async callbacks in db.transaction(), so this
    // verifies the "drizzle" path is reached (not the "sql" BEGIN/COMMIT path).
    await expect(backend.transaction(() => Promise.resolve())).rejects.toThrow(
      /cannot return a promise/i,
    );
  });
});

// ============================================================
// Backend Dispose / Close Tests
// ============================================================

describe("SQLite Backend - close() disposes serialized queue", () => {
  it("advertises bundled better-sqlite3 math functions", async () => {
    const { backend } = createLocalSqliteBackend();
    expect(backend.capabilities.graphAnalytics).toEqual({
      supported: true,
      mathFunctions: true,
    });
    await backend.close();
  });

  it("throws BackendDisposedError for operations after close()", async () => {
    const { backend } = createLocalSqliteBackend();
    const store = createStore(testGraph, backend);

    await store.nodes.Person.create({ name: "Alice" });
    await backend.close();

    await expect(store.nodes.Person.create({ name: "Bob" })).rejects.toThrow(
      BackendDisposedError,
    );
  });

  it("does not produce unhandled rejections for in-flight operations on close()", async () => {
    const { backend } = createLocalSqliteBackend();
    const store = createStore(testGraph, backend);
    await store.nodes.Person.create({ name: "Alice" });

    // Queue operations and abandon the returned promises — simulates a
    // caller that is gone during teardown (e.g. Cloudflare DO reset).
    // If post-dispose errors propagate, Vitest treats the unhandled
    // rejections as test failures.
    void store.nodes.Person.create({ name: "Bob" });
    void store.nodes.Person.create({ name: "Charlie" });

    await backend.close();

    // Flush microtasks so queued tasks execute against the closed backend
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  });

  it("close() is idempotent", async () => {
    const { backend } = createLocalSqliteBackend();

    await backend.close();
    await backend.close();
  });
});

// ============================================================
// TypeGraph SQLite Embedding Persistence (end-to-end)
// ============================================================

describe("SQLite embedding persistence via createSqliteBackend", () => {
  it("persists embeddings and returns results from .similarTo() when sqlite-vec is loaded", async () => {
    // Best-effort: skip if the optional peer dep is not installed.
    const sqlite = new Database(":memory:");
    try {
      const module_ = nodeRequire("sqlite-vec") as {
        load: (db: Database.Database) => void;
      };
      module_.load(sqlite);
    } catch {
      sqlite.close();
      return;
    }

    const { embedding, defineNode, defineGraph, createStoreWithSchema } =
      await import("../../../src");
    const Document = defineNode("Doc", {
      schema: z.object({
        title: z.string(),
        embedding: embedding(4),
      }),
    });
    const graph = defineGraph({
      id: "sqlite_vec_e2e",
      nodes: { Doc: { type: Document } },
      edges: {},
    });

    for (const statement of generateSqliteDDL(tables)) {
      sqlite.exec(statement);
    }
    const db = drizzleBetterSqlite3(sqlite);
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables,
      vector: sqliteVecStrategy,
    });
    expect(backend.upsertEmbedding).toBeDefined();

    // createStoreWithSchema provisions the per-field vector table + marker
    // (privileged), so the embedding write below asserts cleanly.
    const [store] = await createStoreWithSchema(graph, backend);
    await store.nodes.Doc.create({
      title: "Similar",
      embedding: [1, 0, 0, 0],
    });
    await store.nodes.Doc.create({
      title: "Dissimilar",
      embedding: [0, 1, 0, 0],
    });

    // The per-(kind, field) vec0 table should now carry two rows.
    const perFieldTable = sqliteVecStrategy.tableName(
      graph.id,
      "Doc",
      "embedding",
    );
    const count = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM "${perFieldTable}"`)
      .get() as { n: number };
    expect(count.n).toBe(2);

    // `.similarTo()` should rank the identical embedding first.
    const rows = await store
      .query()
      .from("Doc", "d")
      .whereNode("d", (d) =>
        d.embedding.similarTo([1, 0, 0, 0], 10, { metric: "cosine" }),
      )
      .select((ctx) => ({ title: ctx.d.title }))
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.title).toBe("Similar");
    expect(rows[1]!.title).toBe("Dissimilar");

    sqlite.close();
  });

  it("does not expose upsertEmbedding when no vector strategy is configured", () => {
    const sqlite = new Database(":memory:");
    for (const statement of generateSqliteDDL(tables)) {
      sqlite.exec(statement);
    }
    const db = drizzleBetterSqlite3(sqlite);
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables,
    });
    expect(backend.upsertEmbedding).toBeUndefined();
    expect(backend.deleteEmbedding).toBeUndefined();
    expect(backend.vectorSearch).toBeUndefined();
    expect(backend.capabilities.vector).toBeUndefined();
    sqlite.close();
  });

  it("advertises vector capabilities when a vector strategy is configured", () => {
    const sqlite = new Database(":memory:");
    for (const statement of generateSqliteDDL(tables)) {
      sqlite.exec(statement);
    }
    const db = drizzleBetterSqlite3(sqlite);
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables,
      vector: sqliteVecStrategy,
    });
    // Documented public capability check — consumers branch on this to
    // decide whether to take SQLite vector/hybrid paths. The capability is
    // derived from the active strategy (sqlite-vec advertises real KNN).
    expect(backend.capabilities.vector?.supported).toBe(true);
    expect(backend.capabilities.vector?.metrics).toEqual(["cosine", "l2"]);
    expect(backend.capabilities.vector?.indexTypes).toEqual(["hnsw", "none"]);
    expect(backend.capabilities.vector?.maxDimensions).toBeGreaterThan(0);
    sqlite.close();
  });
});

// ============================================================
// SQLite backend.vectorSearch — facade for hybrid retrieval
// ============================================================

describe("SQLite backend.vectorSearch", () => {
  type Harness = Readonly<{
    backend: ReturnType<typeof createSqliteBackend>;
    sqlite: Database.Database;
    graphId: string;
    nodeKind: string;
    fieldPath: string;
    seed: (
      rows: readonly Readonly<{
        nodeId: string;
        embedding: readonly number[];
      }>[],
    ) => Promise<void>;
    // Convenience: pre-narrowed methods so tests don't sprinkle non-null
    // assertions. The harness only exists when sqlite-vec is loaded, which
    // is exactly when these methods exist. The store-resolved slot fields
    // (`dimensions`, `indexType`, and upsert `metric`) are injected by the
    // harness so call sites stay focused on the search/seed semantics; the
    // store populates these in production.
    vectorSearch: (
      params: Omit<VectorSearchParams, "dimensions" | "indexType">,
    ) => Promise<readonly VectorSearchResult[]>;
    upsertEmbedding: (
      params: Omit<UpsertEmbeddingParams, "metric" | "indexType">,
    ) => Promise<void>;
  }>;

  // `undefined` when sqlite-vec is not installed — tests early-return so
  // the suite stays skip-friendly on platforms without the optional dep.
  let harness: Harness | undefined;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    try {
      const module_ = nodeRequire("sqlite-vec") as {
        load: (db: Database.Database) => void;
      };
      module_.load(sqlite);
    } catch {
      sqlite.close();
      harness = undefined;
      return;
    }

    for (const statement of generateSqliteDDL(tables)) {
      sqlite.exec(statement);
    }
    const db = drizzleBetterSqlite3(sqlite);
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables,
      vector: sqliteVecStrategy,
    });

    const graphId = "vector_search_facade";
    const nodeKind = "Doc";
    const fieldPath = "embedding";
    const rawUpsertEmbedding = backend.upsertEmbedding!;
    const rawVectorSearch = backend.vectorSearch!;

    // Inject the store-resolved slot fields the backend now requires.
    // sqlite-vec storage is metric-agnostic and brute-force here, so the
    // defaults (`cosine` / `none` / dimension from the vector length)
    // preserve every existing call site's intended behavior. Each wrapper
    // first provisions the per-field table + durable marker (#135) — the
    // privileged step the store's `createStoreWithSchema` would normally do;
    // these backend-facade tests drive the backend directly, so they stand
    // in for the migrator. Idempotent and cached after the first call.
    function upsertEmbedding(
      params: Omit<UpsertEmbeddingParams, "metric" | "indexType">,
    ): Promise<void> {
      const full = {
        ...params,
        metric: "cosine" as const,
        indexType: "none" as const,
      };
      return (async () => {
        await backend.ensureVectorSlotContribution?.({
          graphId: full.graphId,
          nodeKind: full.nodeKind,
          fieldPath: full.fieldPath,
          dimensions: full.dimensions,
          metric: full.metric,
          indexType: full.indexType,
        });
        await rawUpsertEmbedding(full);
      })();
    }

    function vectorSearch(
      params: Omit<VectorSearchParams, "dimensions" | "indexType">,
    ): Promise<readonly VectorSearchResult[]> {
      const full = {
        ...params,
        dimensions: params.queryEmbedding.length,
        indexType: "none" as const,
      };
      return (async () => {
        // Provision at the DECLARED shape (cosine — matching the upsert
        // wrapper), never at the search's runtime metric: a metric override
        // is a query-time preference over the same physical table, exactly
        // how the store facade behaves (writes/provisioning use the schema-
        // declared metric; searches may override). Ensuring at the query's
        // metric would read as signature drift on sqlite-vec, which bakes
        // the metric into the vtable DDL.
        await backend.ensureVectorSlotContribution?.({
          graphId: full.graphId,
          nodeKind: full.nodeKind,
          fieldPath: full.fieldPath,
          dimensions: full.dimensions,
          metric: "cosine",
          indexType: full.indexType,
        });
        return rawVectorSearch(full);
      })();
    }

    async function seed(
      rows: readonly Readonly<{
        nodeId: string;
        embedding: readonly number[];
      }>[],
    ): Promise<void> {
      for (const row of rows) {
        // vectorSearch computes top-k over LIVE nodes only, so each
        // embedding needs a live node row backing it.
        await backend.insertNode({
          graphId,
          kind: nodeKind,
          id: row.nodeId,
          props: {},
        });
        await upsertEmbedding({
          graphId,
          nodeKind,
          nodeId: row.nodeId,
          fieldPath,
          embedding: row.embedding,
          dimensions: row.embedding.length,
        });
      }
    }

    harness = {
      backend,
      sqlite,
      graphId,
      nodeKind,
      fieldPath,
      seed,
      vectorSearch,
      upsertEmbedding,
    };
  });

  afterEach(() => {
    harness?.sqlite.close();
    harness = undefined;
  });

  it("exposes vectorSearch when sqlite-vec is loaded", () => {
    if (!harness) return;
    expect(harness.backend.vectorSearch).toBeDefined();
  });

  it("ranks identical embeddings first under cosine similarity", async () => {
    if (!harness) return;

    await harness.seed([
      { nodeId: "doc-x", embedding: [1, 0, 0, 0] },
      { nodeId: "doc-y", embedding: [0, 1, 0, 0] },
      { nodeId: "doc-close", embedding: [0.9, 0.1, 0, 0] },
    ]);

    const results = await harness.vectorSearch({
      graphId: harness.graphId,
      nodeKind: harness.nodeKind,
      fieldPath: harness.fieldPath,
      queryEmbedding: [1, 0, 0, 0],
      metric: "cosine",
      limit: 3,
    });

    expect(results).toHaveLength(3);
    expect(results[0]!.nodeId).toBe("doc-x");
    expect(results[0]!.score).toBeCloseTo(1, 5);
    expect(results[1]!.nodeId).toBe("doc-close");
    expect(results[2]!.nodeId).toBe("doc-y");
    expect(results[2]!.score).toBeCloseTo(0, 5);
  });

  it("ranks identical embeddings first under L2 distance (lower score)", async () => {
    if (!harness) return;

    await harness.seed([
      { nodeId: "doc-zero", embedding: [1, 0, 0, 0] },
      { nodeId: "doc-near", embedding: [2, 0, 0, 0] },
      { nodeId: "doc-far", embedding: [10, 0, 0, 0] },
    ]);

    const results = await harness.vectorSearch({
      graphId: harness.graphId,
      nodeKind: harness.nodeKind,
      fieldPath: harness.fieldPath,
      queryEmbedding: [1, 0, 0, 0],
      metric: "l2",
      limit: 3,
    });

    expect(results).toHaveLength(3);
    expect(results[0]!.nodeId).toBe("doc-zero");
    expect(results[0]!.score).toBeCloseTo(0, 5);
    expect(results[1]!.nodeId).toBe("doc-near");
    expect(results[1]!.score).toBeCloseTo(1, 5);
    expect(results[2]!.nodeId).toBe("doc-far");
    expect(results[2]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("rejects inner_product (sqlite-vec has no vec_distance_ip)", async () => {
    if (!harness) return;

    await harness.seed([{ nodeId: "doc-1", embedding: [1, 0, 0, 0] }]);

    await expect(
      harness.vectorSearch({
        graphId: harness.graphId,
        nodeKind: harness.nodeKind,
        fieldPath: harness.fieldPath,
        queryEmbedding: [1, 0, 0, 0],
        metric: "inner_product",
        limit: 5,
      }),
    ).rejects.toThrow(/inner_product/i);
  });

  it("clips to limit when more rows match", async () => {
    if (!harness) return;

    const seed = Array.from({ length: 10 }, (_, index) => ({
      nodeId: `doc-${index}`,
      embedding: [Math.cos(index * 0.3), Math.sin(index * 0.3), 0, 0],
    }));
    await harness.seed(seed);

    const results = await harness.vectorSearch({
      graphId: harness.graphId,
      nodeKind: harness.nodeKind,
      fieldPath: harness.fieldPath,
      queryEmbedding: [1, 0, 0, 0],
      metric: "cosine",
      limit: 3,
    });

    expect(results).toHaveLength(3);
  });

  it("filters out results below cosine minScore", async () => {
    if (!harness) return;

    await harness.seed([
      { nodeId: "doc-identical", embedding: [1, 0, 0, 0] },
      { nodeId: "doc-similar", embedding: [0.9, 0.1, 0, 0] },
      { nodeId: "doc-orthogonal", embedding: [0, 1, 0, 0] },
    ]);

    const results = await harness.vectorSearch({
      graphId: harness.graphId,
      nodeKind: harness.nodeKind,
      fieldPath: harness.fieldPath,
      queryEmbedding: [1, 0, 0, 0],
      metric: "cosine",
      limit: 10,
      minScore: 0.5,
    });

    const ids = results.map((row) => row.nodeId);
    expect(ids).toContain("doc-identical");
    expect(ids).toContain("doc-similar");
    expect(ids).not.toContain("doc-orthogonal");
    for (const row of results) {
      expect(row.score).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("filters out results above L2 minScore (interpreted as max distance)", async () => {
    if (!harness) return;

    await harness.seed([
      { nodeId: "doc-zero", embedding: [1, 0, 0, 0] },
      { nodeId: "doc-near", embedding: [2, 0, 0, 0] },
      { nodeId: "doc-far", embedding: [10, 0, 0, 0] },
    ]);

    const results = await harness.vectorSearch({
      graphId: harness.graphId,
      nodeKind: harness.nodeKind,
      fieldPath: harness.fieldPath,
      queryEmbedding: [1, 0, 0, 0],
      metric: "l2",
      limit: 10,
      minScore: 2,
    });

    const ids = results.map((row) => row.nodeId);
    expect(ids).toContain("doc-zero");
    expect(ids).toContain("doc-near");
    expect(ids).not.toContain("doc-far");
  });

  it("scopes results by graphId", async () => {
    if (!harness) return;

    await harness.seed([{ nodeId: "doc-here", embedding: [1, 0, 0, 0] }]);
    await harness.upsertEmbedding({
      graphId: "other_graph",
      nodeKind: harness.nodeKind,
      nodeId: "doc-elsewhere",
      fieldPath: harness.fieldPath,
      embedding: [1, 0, 0, 0],
      dimensions: 4,
    });

    const results = await harness.vectorSearch({
      graphId: harness.graphId,
      nodeKind: harness.nodeKind,
      fieldPath: harness.fieldPath,
      queryEmbedding: [1, 0, 0, 0],
      metric: "cosine",
      limit: 10,
    });

    expect(results.map((row) => row.nodeId)).toEqual(["doc-here"]);
  });

  it("scopes results by nodeKind", async () => {
    if (!harness) return;

    await harness.seed([{ nodeId: "doc-here", embedding: [1, 0, 0, 0] }]);
    await harness.upsertEmbedding({
      graphId: harness.graphId,
      nodeKind: "OtherKind",
      nodeId: "other-node",
      fieldPath: harness.fieldPath,
      embedding: [1, 0, 0, 0],
      dimensions: 4,
    });

    const results = await harness.vectorSearch({
      graphId: harness.graphId,
      nodeKind: harness.nodeKind,
      fieldPath: harness.fieldPath,
      queryEmbedding: [1, 0, 0, 0],
      metric: "cosine",
      limit: 10,
    });

    expect(results.map((row) => row.nodeId)).toEqual(["doc-here"]);
  });

  it("scopes results by fieldPath", async () => {
    if (!harness) return;

    await harness.seed([{ nodeId: "doc-here", embedding: [1, 0, 0, 0] }]);
    await harness.upsertEmbedding({
      graphId: harness.graphId,
      nodeKind: harness.nodeKind,
      nodeId: "doc-here",
      fieldPath: "secondary",
      embedding: [1, 0, 0, 0],
      dimensions: 4,
    });

    const results = await harness.vectorSearch({
      graphId: harness.graphId,
      nodeKind: harness.nodeKind,
      fieldPath: harness.fieldPath,
      queryEmbedding: [1, 0, 0, 0],
      metric: "cosine",
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.nodeId).toBe("doc-here");
  });

  it("returns an empty array when no rows match", async () => {
    if (!harness) return;

    const results = await harness.vectorSearch({
      graphId: harness.graphId,
      nodeKind: harness.nodeKind,
      fieldPath: harness.fieldPath,
      queryEmbedding: [1, 0, 0, 0],
      metric: "cosine",
      limit: 10,
    });

    expect(results).toEqual([]);
  });

  it("rejects non-finite query embedding values", async () => {
    if (!harness) return;

    await expect(
      harness.vectorSearch({
        graphId: harness.graphId,
        nodeKind: harness.nodeKind,
        fieldPath: harness.fieldPath,
        queryEmbedding: [1, Number.NaN, 0, 0],
        metric: "cosine",
        limit: 5,
      }),
    ).rejects.toThrow(/finite number/);
  });

  it("rejects non-positive limits", async () => {
    if (!harness) return;

    await expect(
      harness.vectorSearch({
        graphId: harness.graphId,
        nodeKind: harness.nodeKind,
        fieldPath: harness.fieldPath,
        queryEmbedding: [1, 0, 0, 0],
        metric: "cosine",
        limit: 0,
      }),
    ).rejects.toThrow(/positive integer/);
  });
});

// ============================================================
// Business transaction locking (better-sqlite3, file-backed)
// ============================================================

function temporaryDbPath(): string {
  return path.join(
    tmpdir(),
    `typegraph-lock-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.db`,
  );
}

function removeDbFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
}

describe("SQLite Backend - business transaction write lock", () => {
  it("takes the reserved write lock at BEGIN (BEGIN IMMEDIATE), before the first write", async () => {
    // Regression for the sync ("sql") business-transaction path: it opened a
    // deferred BEGIN, so the write lock was only acquired on the first write and
    // a read-then-write could fail with "database is locked" against a writer on
    // another connection. It now opens BEGIN IMMEDIATE, like schema writes and
    // the async libsql/Drizzle path, holding the lock for the whole transaction.
    const dbPath = temporaryDbPath();
    const { backend } = createLocalSqliteBackend({ path: dbPath });

    let signalInside!: () => void;
    const inside = new Promise<void>((resolve) => {
      signalInside = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Open a business transaction whose callback does NO write. BEGIN runs before
    // the callback, so once `inside` resolves the reserved write lock is either
    // held (BEGIN IMMEDIATE) or not (deferred BEGIN, no write yet).
    const txDone = backend.transaction(async () => {
      signalInside();
      await barrier;
    });
    await inside;

    let probeTookLock = false;
    try {
      // A second connection tries to take the write lock with a short busy
      // timeout. It must fail: the open transaction already holds it. Under the
      // old deferred BEGIN this would wrongly succeed (no lock held yet).
      const probe = new Database(dbPath);
      try {
        probe.pragma("busy_timeout = 100");
        probe.exec("BEGIN IMMEDIATE");
        probeTookLock = true;
        probe.exec("ROLLBACK");
      } catch {
        // BEGIN IMMEDIATE threw (busy): the open transaction holds the lock, so
        // probeTookLock stays false.
      } finally {
        probe.close();
      }
    } finally {
      release();
      await txDone;
      await backend.close();
      removeDbFiles(dbPath);
    }

    expect(probeTookLock).toBe(false);
  });

  it("leaves the writer slot free for a read-only transaction", async () => {
    const dbPath = temporaryDbPath();
    const { backend } = createLocalSqliteBackend({ path: dbPath });

    let signalInside!: () => void;
    const inside = new Promise<void>((resolve) => {
      signalInside = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const txDone = backend.transaction(
      async (tx) => {
        await tx.execute(asCompiledRowsSql(sql`SELECT 1 AS value`));
        signalInside();
        await barrier;
      },
      { accessMode: "read_only", isolationLevel: "repeatable_read" },
    );
    await inside;

    try {
      const probe = new Database(dbPath);
      try {
        probe.pragma("busy_timeout = 100");
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
      } finally {
        probe.close();
      }
    } finally {
      release();
      await txDone;
      await backend.close();
      removeDbFiles(dbPath);
    }
  });

  it("leaves the writer slot free while writing temporary working state", async () => {
    const dbPath = temporaryDbPath();
    const { backend } = createLocalSqliteBackend({ path: dbPath });

    let signalInside!: () => void;
    const inside = new Promise<void>((resolve) => {
      signalInside = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const txDone = backend.transaction(
      async (tx) => {
        await tx.executeTemporaryStatement!(
          asCompiledTemporaryStatementSql(
            sql`CREATE TEMP TABLE iterative_probe (value INTEGER)`,
          ),
        );
        await tx.executeTemporaryStatement!(
          asCompiledTemporaryStatementSql(
            sql`INSERT INTO iterative_probe (value) VALUES (1)`,
          ),
        );
        signalInside();
        await barrier;
        await tx.executeTemporaryStatement!(
          asCompiledTemporaryStatementSql(sql`DROP TABLE iterative_probe`),
        );
      },
      {
        accessMode: "read_only",
        isolationLevel: "repeatable_read",
        temporaryWrites: INTERNAL_TEMPORARY_WRITES,
      },
    );
    await inside;

    try {
      const probe = new Database(dbPath);
      try {
        probe.pragma("busy_timeout = 100");
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
      } finally {
        probe.close();
      }
    } finally {
      release();
      await txDone;
      await backend.close();
      removeDbFiles(dbPath);
    }
  });
});
