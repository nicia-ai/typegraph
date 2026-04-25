/**
 * SQLite Backend Integration Tests
 *
 * Tests the SQLite adapter with a real in-memory database.
 * Follows Better Auth's pattern: users provide a configured Drizzle instance
 * and run migrations to create TypeGraph tables.
 */
import { createRequire } from "node:module";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import {
  type BetterSQLite3Database,
  drizzle as drizzleBetterSqlite3,
} from "drizzle-orm/better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
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
      expect(backend.capabilities.cte).toBe(true);
      expect(backend.capabilities.returning).toBe(true);
      expect(backend.capabilities.jsonb).toBe(false);
      expect(backend.capabilities.ginIndexes).toBe(false);
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

        await backend.execute<{ id: string }>(query);
        await backend.execute<{ id: string }>(query);
        await backend.execute<{ id: string }>(query);

        expect(prepareCalls).toBe(1);
      } finally {
        sqliteClient.prepare = originalPrepare;
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
      expect(sql).toContain("typegraph_edges_from_idx");
      expect(sql).toContain("typegraph_edges_to_idx");
      expect(sql).toContain("typegraph_edges_kind_created_idx");
      expect(sql).toContain(
        '"typegraph_edges" ("graph_id", "from_kind", "from_id", "kind", "to_kind", "deleted_at", "valid_to")',
      );
      expect(sql).toContain(
        '"typegraph_edges" ("graph_id", "to_kind", "to_id", "kind", "from_kind", "deleted_at", "valid_to")',
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
// Vector Search Integration Tests (sqlite-vec)
// ============================================================

/**
 * Attempts to load sqlite-vec extension.
 * Returns true if successful, false otherwise.
 */
function loadSqliteVec(sqlite: Database.Database): boolean {
  try {
    // Try to load sqlite-vec dynamically
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require("sqlite-vec") as {
      load: (db: Database.Database) => void;
    };
    sqliteVec.load(sqlite);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a test database with sqlite-vec loaded.
 */
function createVectorTestDatabase(): Database.Database | undefined {
  const sqlite = new Database(":memory:");

  if (!loadSqliteVec(sqlite)) {
    sqlite.close();
    return undefined;
  }

  return sqlite;
}

describe("Vector Search with SQLite (sqlite-vec)", () => {
  let hasSqliteVec = false;
  let testSqlite: Database.Database | undefined;

  beforeAll(() => {
    const sqlite = createVectorTestDatabase();
    if (sqlite) {
      hasSqliteVec = true;
      testSqlite = sqlite;

      // Create embeddings table
      testSqlite.exec(`
        CREATE TABLE IF NOT EXISTS typegraph_embeddings (
          id TEXT PRIMARY KEY,
          graph_id TEXT NOT NULL,
          node_kind TEXT NOT NULL,
          node_id TEXT NOT NULL,
          field_path TEXT NOT NULL,
          embedding BLOB NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    }
  });

  beforeEach(() => {
    if (!hasSqliteVec || !testSqlite) return;
    testSqlite.exec("DELETE FROM typegraph_embeddings");
  });

  it("should detect sqlite-vec availability", () => {
    if (!hasSqliteVec) {
      console.log("sqlite-vec not available - skipping vector tests");
      return;
    }
    expect(hasSqliteVec).toBe(true);
  });

  it("should store embeddings using vec_f32", () => {
    if (!hasSqliteVec || !testSqlite) return;

    // Insert test embedding using vec_f32
    const embedding = [0.1, 0.2, 0.3, 0.4];
    testSqlite
      .prepare(
        `INSERT INTO typegraph_embeddings
         (id, graph_id, node_kind, node_id, field_path, embedding)
         VALUES (?, ?, ?, ?, ?, vec_f32(?))`,
      )
      .run(
        "emb-1",
        "vector_test_graph",
        "Document",
        "doc-1",
        "/embedding",
        JSON.stringify(embedding),
      );

    // Verify it was stored
    const result = testSqlite
      .prepare("SELECT id, node_id FROM typegraph_embeddings WHERE id = ?")
      .get("emb-1") as { id: string; node_id: string } | undefined;

    expect(result).toBeDefined();
    expect(result?.node_id).toBe("doc-1");
  });

  it("should compute cosine distance correctly", () => {
    if (!hasSqliteVec || !testSqlite) return;

    // Insert test embeddings
    const embeddings = [
      { id: "doc-1", embedding: [1, 0, 0, 0] }, // Unit vector along x
      { id: "doc-2", embedding: [0, 1, 0, 0] }, // Unit vector along y (orthogonal)
      { id: "doc-3", embedding: [0.9, 0.1, 0, 0] }, // Close to doc-1
    ];

    const stmt = testSqlite.prepare(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES (?, ?, ?, ?, ?, vec_f32(?))`,
    );

    for (const emb of embeddings) {
      stmt.run(
        `emb-${emb.id}`,
        "vector_test_graph",
        "Document",
        emb.id,
        "/embedding",
        JSON.stringify(emb.embedding),
      );
    }

    // Query for similar to [1, 0, 0, 0]
    const queryEmbedding = JSON.stringify([1, 0, 0, 0]);
    const results = testSqlite
      .prepare(
        `SELECT node_id, vec_distance_cosine(embedding, vec_f32(?)) AS distance
         FROM typegraph_embeddings
         ORDER BY distance ASC`,
      )
      .all(queryEmbedding) as { node_id: string; distance: number }[];

    expect(results.length).toBe(3);
    // doc-1 should be first (distance 0 - identical)
    expect(results[0]!.node_id).toBe("doc-1");
    expect(results[0]!.distance).toBeCloseTo(0, 5);
    // doc-3 should be second (close to query)
    expect(results[1]!.node_id).toBe("doc-3");
    // doc-2 should be last (orthogonal = max distance for cosine)
    expect(results[2]!.node_id).toBe("doc-2");
  });

  it("should filter by minimum score", () => {
    if (!hasSqliteVec || !testSqlite) return;

    // Insert test embeddings
    const embeddings = [
      { id: "doc-1", embedding: [1, 0, 0, 0] }, // Identical to query
      { id: "doc-2", embedding: [0.7, 0.7, 0, 0] }, // Somewhat similar
      { id: "doc-3", embedding: [0, 1, 0, 0] }, // Orthogonal
    ];

    const stmt = testSqlite.prepare(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES (?, ?, ?, ?, ?, vec_f32(?))`,
    );

    for (const emb of embeddings) {
      stmt.run(
        `emb-${emb.id}`,
        "vector_test_graph",
        "Document",
        emb.id,
        "/embedding",
        JSON.stringify(emb.embedding),
      );
    }

    // Query with minScore filter (distance threshold = 1 - minScore)
    const queryEmbedding = JSON.stringify([1, 0, 0, 0]);
    const minScore = 0.5; // Only results with similarity >= 0.5
    const threshold = 1 - minScore;

    const results = testSqlite
      .prepare(
        `SELECT node_id, 1 - vec_distance_cosine(embedding, vec_f32(?)) AS score
         FROM typegraph_embeddings
         WHERE vec_distance_cosine(embedding, vec_f32(?)) <= ?
         ORDER BY score DESC`,
      )
      .all(queryEmbedding, queryEmbedding, threshold) as {
      node_id: string;
      score: number;
    }[];

    // Should exclude doc-3 (orthogonal = score ~0)
    expect(results.length).toBe(2);
    expect(results.map((r) => r.node_id)).toContain("doc-1");
    expect(results.map((r) => r.node_id)).toContain("doc-2");
  });

  it("should limit results to k nearest", () => {
    if (!hasSqliteVec || !testSqlite) return;

    // Insert 10 test embeddings
    const stmt = testSqlite.prepare(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES (?, ?, ?, ?, ?, vec_f32(?))`,
    );

    for (let index = 0; index < 10; index++) {
      const embedding = [Math.cos(index * 0.3), Math.sin(index * 0.3), 0, 0];
      stmt.run(
        `emb-doc-${index}`,
        "vector_test_graph",
        "Document",
        `doc-${index}`,
        "/embedding",
        JSON.stringify(embedding),
      );
    }

    // Query for top 3
    const queryEmbedding = JSON.stringify([1, 0, 0, 0]);
    const results = testSqlite
      .prepare(
        `SELECT node_id, vec_distance_cosine(embedding, vec_f32(?)) AS distance
         FROM typegraph_embeddings
         ORDER BY distance ASC
         LIMIT 3`,
      )
      .all(queryEmbedding) as { node_id: string; distance: number }[];

    expect(results.length).toBe(3);
  });

  it("should support L2 (Euclidean) distance", () => {
    if (!hasSqliteVec || !testSqlite) return;

    // Insert test embeddings
    const stmt = testSqlite.prepare(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES (?, ?, ?, ?, ?, vec_f32(?))`,
    );

    stmt.run(
      "emb-1",
      "vector_test_graph",
      "Document",
      "doc-1",
      "/embedding",
      JSON.stringify([1, 0, 0, 0]),
    );
    stmt.run(
      "emb-2",
      "vector_test_graph",
      "Document",
      "doc-2",
      "/embedding",
      JSON.stringify([2, 0, 0, 0]),
    );

    // Query using L2 distance
    const queryEmbedding = JSON.stringify([1, 0, 0, 0]);
    const results = testSqlite
      .prepare(
        `SELECT node_id, vec_distance_l2(embedding, vec_f32(?)) AS distance
         FROM typegraph_embeddings
         ORDER BY distance ASC`,
      )
      .all(queryEmbedding) as { node_id: string; distance: number }[];

    expect(results.length).toBe(2);
    // doc-1 should be first (distance 0)
    expect(results[0]!.node_id).toBe("doc-1");
    expect(results[0]!.distance).toBeCloseTo(0, 5);
    // doc-2 should have distance 1 (|[1,0,0,0] - [2,0,0,0]| = 1)
    expect(results[1]!.node_id).toBe("doc-2");
    expect(results[1]!.distance).toBeCloseTo(1, 5);
  });

  it("should not support inner product distance (sqlite-vec limitation)", () => {
    if (!hasSqliteVec || !testSqlite) return;

    // sqlite-vec does not have a vec_distance_ip function
    // This test verifies that attempting to use it throws an error
    // See: https://alexgarcia.xyz/sqlite-vec/api-reference.html
    expect(() => {
      testSqlite!.prepare(
        `SELECT vec_distance_ip(vec_f32('[1,0,0,0]'), vec_f32('[0,1,0,0]'))`,
      );
    }).toThrow(/no such function/);
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

    const { embedding, defineNode, defineGraph } = await import("../../../src");
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
      hasVectorEmbeddings: true,
    });
    expect(backend.upsertEmbedding).toBeDefined();

    const store = createStore(graph, backend);
    await store.nodes.Doc.create({
      title: "Similar",
      embedding: [1, 0, 0, 0],
    });
    await store.nodes.Doc.create({
      title: "Dissimilar",
      embedding: [0, 1, 0, 0],
    });

    // Embeddings table should now carry two rows.
    const count = sqlite
      .prepare("SELECT COUNT(*) AS n FROM typegraph_node_embeddings")
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

  it("does not expose upsertEmbedding when hasVectorEmbeddings is false", () => {
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
    sqlite.close();
  });
});
