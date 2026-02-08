/**
 * PostgreSQL Backend Integration Tests
 *
 * Tests the PostgreSQL adapter with a real database via Docker.
 * Requires: docker compose up -d
 *
 * Run: pnpm test:postgres
 *
 * These tests are automatically skipped if PostgreSQL is not available.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  subClassOf,
} from "../../../src";
import {
  generatePostgresDDL,
  getPostgresMigrationSQL,
} from "../../../src/backend/drizzle/test-helpers";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { createStore } from "../../../src/store";
import { createAdapterTestSuite } from "../adapter-test-suite";
import { createIntegrationTestSuite } from "../integration-test-suite";

// ============================================================
// Test Configuration
// ============================================================

// Use 127.0.0.1 instead of localhost to avoid IPv6 resolution issues
const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

// ============================================================
// Connection State
// ============================================================

let sharedPool: Pool | undefined;
let sharedDb: NodePgDatabase | undefined;
let isPostgresAvailable = false;

/**
 * Creates a new pool and db instance.
 * Used for tests that need isolated connections.
 */
function createConnection(): { pool: Pool; db: NodePgDatabase } {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const db = drizzle(pool);
  return { pool, db };
}

/**
 * Checks if PostgreSQL is available and sets up the shared connection.
 * Retries connection to handle CI timing issues.
 */
async function initializePostgres(): Promise<boolean> {
  const maxRetries = 5;
  const retryDelayMs = 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const testPool = new Pool({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });

    try {
      await testPool.query("SELECT 1");
      sharedPool = testPool;
      sharedDb = drizzle(sharedPool);
      return true;
    } catch {
      await testPool.end().catch(() => {
        // Ignore cleanup errors
      });

      if (attempt < maxRetries) {
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  return false;
}

/**
 * Creates a clean test database.
 */
async function setupTestDatabase(): Promise<void> {
  if (!sharedPool) return;

  await sharedPool.query(`
    DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
    DROP TABLE IF EXISTS typegraph_edges CASCADE;
    DROP TABLE IF EXISTS typegraph_nodes CASCADE;
    DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
  `);

  await sharedPool.query(getPostgresMigrationSQL());
}

/**
 * Clears all data from TypeGraph tables.
 */
async function clearTestData(): Promise<void> {
  if (!sharedPool) return;

  await sharedPool.query("TRUNCATE typegraph_nodes CASCADE");
  await sharedPool.query("TRUNCATE typegraph_edges CASCADE");
  await sharedPool.query("TRUNCATE typegraph_node_uniques CASCADE");
  await sharedPool.query("TRUNCATE typegraph_schema_versions CASCADE");
}

// ============================================================
// Global Setup/Teardown
// ============================================================

beforeAll(async () => {
  isPostgresAvailable = await initializePostgres();
  if (isPostgresAvailable) {
    await setupTestDatabase();
  }
});

afterAll(async () => {
  if (sharedPool) {
    await sharedPool.end();
  }
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
// Shared Adapter Test Suite
// ============================================================

describe("PostgreSQL Adapter", () => {
  beforeEach(async () => {
    if (!isPostgresAvailable) return;
    await clearTestData();
  });

  it("should be available for testing", () => {
    if (!isPostgresAvailable) {
      console.log("PostgreSQL not available - skipping integration tests");
      return;
    }
    expect(sharedPool).toBeDefined();
    expect(sharedDb).toBeDefined();
  });

  // Run the shared test suite using the shared connection
  describe.runIf(process.env.POSTGRES_URL)("Adapter Test Suite", () => {
    beforeEach(async () => {
      await clearTestData();
    });

    createAdapterTestSuite(
      "PostgreSQL",
      () => {
        // Create a fresh connection for each backend instance
        // This avoids issues with pool.end() being called by close()
        const { db } = createConnection();
        return createPostgresBackend(db);
      },
      { skipRawQueries: false },
    );
  });

  // Run the shared integration test suite for PostgreSQL
  describe.runIf(process.env.POSTGRES_URL)("Integration Test Suite", () => {
    beforeEach(async () => {
      await clearTestData();
    });

    createIntegrationTestSuite("PostgreSQL", () => {
      // Create a fresh connection for each backend instance
      const { pool, db } = createConnection();
      return {
        backend: createPostgresBackend(db),
        cleanup: async () => {
          await pool.end();
        },
      };
    });
  });
});

// ============================================================
// PostgreSQL-Specific Tests
// ============================================================

describe("PostgreSQL Backend - Adapter Specific", () => {
  beforeEach(async () => {
    if (!isPostgresAvailable) return;
    await clearTestData();
  });

  describe("createPostgresBackend()", () => {
    it("creates a backend with correct dialect and capabilities", () => {
      if (!isPostgresAvailable || !sharedDb || !sharedPool) return;
      const backend = createPostgresBackend(sharedDb);

      expect(backend.dialect).toBe("postgres");
      expect(backend.capabilities.cte).toBe(true);
      expect(backend.capabilities.returning).toBe(true);
      expect(backend.capabilities.jsonb).toBe(true);
      expect(backend.capabilities.ginIndexes).toBe(true);
    });
  });

  describe("generatePostgresDDL()", () => {
    it("generates DDL that creates all required tables", () => {
      const ddl = generatePostgresDDL();
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

    it("uses JSONB for props columns", () => {
      const ddl = generatePostgresDDL();
      const sql = ddl.join("\n");

      expect(sql).toContain('"props" JSONB NOT NULL');
      expect(sql).toContain('"schema_doc" JSONB NOT NULL');
    });

    it("uses TIMESTAMPTZ for temporal columns", () => {
      const ddl = generatePostgresDDL();
      const sql = ddl.join("\n");

      expect(sql).toContain('"created_at" TIMESTAMPTZ NOT NULL');
      expect(sql).toContain('"valid_from" TIMESTAMPTZ');
    });

    it("includes necessary indexes", () => {
      const ddl = generatePostgresDDL();
      const sql = ddl.join("\n");

      expect(sql).toContain('"typegraph_nodes_kind_idx"');
      expect(sql).toContain('"typegraph_edges_from_idx"');
      expect(sql).toContain('"typegraph_edges_to_idx"');
    });
  });

  describe("JSONB handling", () => {
    it("stores and retrieves complex JSON props", async () => {
      if (!isPostgresAvailable || !sharedDb || !sharedPool) return;
      const backend = createPostgresBackend(sharedDb);

      const complexProps = {
        name: "Alice",
        nested: { a: 1, b: [2, 3] },
        array: ["x", "y"],
      };

      const inserted = await backend.insertNode({
        graphId: "test_graph",
        kind: "Person",
        id: "person-1",
        props: complexProps,
      });

      const parsed = JSON.parse(inserted.props);
      expect(parsed.name).toBe("Alice");
      expect(parsed.nested.a).toBe(1);
      expect(parsed.nested.b).toEqual([2, 3]);
      expect(parsed.array).toEqual(["x", "y"]);

      const fetched = await backend.getNode("test_graph", "Person", "person-1");
      const fetchedProps = JSON.parse(fetched!.props);
      expect(fetchedProps).toEqual(complexProps);
    });
  });

  describe("Transaction isolation", () => {
    it("supports serializable transactions", async () => {
      if (!isPostgresAvailable || !sharedDb || !sharedPool) return;
      const backend = createPostgresBackend(sharedDb);

      await backend.transaction(
        async (tx) => {
          await tx.insertNode({
            graphId: "test_graph",
            kind: "Person",
            id: "person-1",
            props: { name: "Alice" },
          });
        },
        { isolationLevel: "serializable" },
      );

      const fetched = await backend.getNode("test_graph", "Person", "person-1");
      expect(fetched).toBeDefined();
    });
  });
});

// ============================================================
// Store Integration Tests
// ============================================================

describe("Store with PostgreSQL Backend", () => {
  beforeEach(async () => {
    if (!isPostgresAvailable) return;
    await clearTestData();
  });

  it("creates a store with PostgreSQL backend", () => {
    if (!isPostgresAvailable || !sharedDb || !sharedPool) return;
    const backend = createPostgresBackend(sharedDb);
    const store = createStore(testGraph, backend);

    expect(store.graphId).toBe("test_graph");
    expect(store.registry).toBeDefined();
  });

  it("creates and retrieves nodes through the store", async () => {
    if (!isPostgresAvailable || !sharedDb || !sharedPool) return;
    const backend = createPostgresBackend(sharedDb);
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
    if (!isPostgresAvailable || !sharedDb || !sharedPool) return;
    const backend = createPostgresBackend(sharedDb);
    const store = createStore(testGraph, backend);

    await expect(
      store.nodes.Person.create({ name: "Alice", email: "not-an-email" }),
    ).rejects.toThrow();
  });

  it("creates edges between nodes", async () => {
    if (!isPostgresAvailable || !sharedDb || !sharedPool) return;
    const backend = createPostgresBackend(sharedDb);
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
    if (!isPostgresAvailable || !sharedDb || !sharedPool) return;
    const backend = createPostgresBackend(sharedDb);
    const store = createStore(testGraph, backend);

    const person = await store.nodes.Person.create({ name: "Alice" });
    const company = await store.nodes.Company.create({ name: "Acme Inc" });

    const createdEdge = await store.edges.worksAt.create(
      { kind: "Person", id: person.id },
      { kind: "Company", id: company.id },
      { role: "Engineer" },
    );

    expect(createdEdge).toBeDefined();
  });

  it("rejects edges with invalid endpoint types", async () => {
    if (!isPostgresAvailable || !sharedDb || !sharedPool) return;
    const backend = createPostgresBackend(sharedDb);
    const store = createStore(testGraph, backend);

    const person1 = await store.nodes.Person.create({ name: "Alice" });
    const person2 = await store.nodes.Person.create({ name: "Bob" });

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
    if (!isPostgresAvailable || !sharedDb || !sharedPool) return;
    const backend = createPostgresBackend(sharedDb);
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

    const fetchedPerson = await store.nodes.Person.getById(result.person.id);
    expect(fetchedPerson).toBeDefined();
  });

  it("updates nodes", async () => {
    if (!isPostgresAvailable || !sharedDb || !sharedPool) return;
    const backend = createPostgresBackend(sharedDb);
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
    if (!isPostgresAvailable || !sharedDb || !sharedPool) return;
    const backend = createPostgresBackend(sharedDb);
    const store = createStore(testGraph, backend);

    const person = await store.nodes.Person.create({ name: "Alice" });

    await store.nodes.Person.delete(person.id);

    const fetched = await store.nodes.Person.getById(person.id);
    expect(fetched).toBeUndefined();

    const fetchedWithTombstones = await store.nodes.Person.getById(person.id, {
      temporalMode: "includeTombstones",
    });
    expect(fetchedWithTombstones).toBeDefined();
    expect(fetchedWithTombstones!.meta.deletedAt).toBeDefined();
  });
});

// ============================================================
// Vector Search Integration Tests
// ============================================================

/**
 * Checks if pgvector extension is available
 */
async function isPgvectorAvailable(): Promise<boolean> {
  if (!sharedPool) return false;

  try {
    await sharedPool.query("CREATE EXTENSION IF NOT EXISTS vector");
    return true;
  } catch {
    return false;
  }
}

/**
 * Sets up the embeddings table for vector tests
 */
async function setupEmbeddingsTable(): Promise<void> {
  if (!sharedPool) return;

  await sharedPool.query(`
    CREATE TABLE IF NOT EXISTS typegraph_embeddings (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      node_kind TEXT NOT NULL,
      node_id TEXT NOT NULL,
      field_path TEXT NOT NULL,
      embedding vector(4) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sharedPool.query("TRUNCATE typegraph_embeddings");
}

describe("Vector Search with PostgreSQL", () => {
  let hasPgvector = false;

  beforeAll(async () => {
    if (!isPostgresAvailable) return;
    hasPgvector = await isPgvectorAvailable();
    if (hasPgvector) {
      await setupEmbeddingsTable();
    }
  });

  beforeEach(async () => {
    if (!isPostgresAvailable || !hasPgvector) return;
    await clearTestData();
    await sharedPool?.query("TRUNCATE typegraph_embeddings");
  });

  it("should detect pgvector availability", () => {
    if (!isPostgresAvailable) {
      console.log("PostgreSQL not available - skipping vector tests");
      return;
    }
    if (!hasPgvector) {
      console.log("pgvector extension not available - skipping vector tests");
      return;
    }
    expect(hasPgvector).toBe(true);
  });

  it("should store embeddings in the embeddings table", async () => {
    if (!isPostgresAvailable || !hasPgvector || !sharedPool) return;

    // Insert test embedding directly
    const testEmbedding = [0.1, 0.2, 0.3, 0.4];
    await sharedPool.query(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "emb-1",
        "vector_test_graph",
        "Document",
        "doc-1",
        "/embedding",
        `[${testEmbedding.join(",")}]`,
      ],
    );

    // Verify it was stored
    const result = await sharedPool.query(
      "SELECT * FROM typegraph_embeddings WHERE id = $1",
      ["emb-1"],
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].node_id).toBe("doc-1");
  });

  it("should compute cosine distance correctly", async () => {
    if (!isPostgresAvailable || !hasPgvector || !sharedPool) return;

    // Insert test embeddings
    const embeddings = [
      { id: "doc-1", embedding: [1, 0, 0, 0] }, // Unit vector along x
      { id: "doc-2", embedding: [0, 1, 0, 0] }, // Unit vector along y (orthogonal)
      { id: "doc-3", embedding: [0.9, 0.1, 0, 0] }, // Close to doc-1
    ];

    for (const emb of embeddings) {
      await sharedPool.query(
        `INSERT INTO typegraph_embeddings
         (id, graph_id, node_kind, node_id, field_path, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          `emb-${emb.id}`,
          "vector_test_graph",
          "Document",
          emb.id,
          "/embedding",
          `[${emb.embedding.join(",")}]`,
        ],
      );
    }

    // Query for similar to [1, 0, 0, 0]
    const queryEmbedding = "[1,0,0,0]";
    const result = await sharedPool.query(
      `SELECT node_id, embedding <=> $1::vector AS distance
       FROM typegraph_embeddings
       ORDER BY distance ASC`,
      [queryEmbedding],
    );

    expect(result.rows.length).toBe(3);
    // doc-1 should be first (distance 0 - identical)
    expect(result.rows[0].node_id).toBe("doc-1");
    expect(Number.parseFloat(result.rows[0].distance)).toBeCloseTo(0, 5);
    // doc-3 should be second (close to query)
    expect(result.rows[1].node_id).toBe("doc-3");
    // doc-2 should be last (orthogonal = max distance for cosine)
    expect(result.rows[2].node_id).toBe("doc-2");
  });

  it("should filter by minimum score", async () => {
    if (!isPostgresAvailable || !hasPgvector || !sharedPool) return;

    // Insert test embeddings
    const embeddings = [
      { id: "doc-1", embedding: [1, 0, 0, 0] }, // Identical to query
      { id: "doc-2", embedding: [0.7, 0.7, 0, 0] }, // Somewhat similar
      { id: "doc-3", embedding: [0, 1, 0, 0] }, // Orthogonal
    ];

    for (const emb of embeddings) {
      await sharedPool.query(
        `INSERT INTO typegraph_embeddings
         (id, graph_id, node_kind, node_id, field_path, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          `emb-${emb.id}`,
          "vector_test_graph",
          "Document",
          emb.id,
          "/embedding",
          `[${emb.embedding.join(",")}]`,
        ],
      );
    }

    // Query with minScore filter (distance threshold = 1 - minScore)
    const queryEmbedding = "[1,0,0,0]";
    const minScore = 0.5; // Only results with similarity >= 0.5
    const threshold = 1 - minScore;

    const result = await sharedPool.query(
      `SELECT node_id, 1 - (embedding <=> $1::vector) AS score
       FROM typegraph_embeddings
       WHERE (embedding <=> $1::vector) <= $2
       ORDER BY score DESC`,
      [queryEmbedding, threshold],
    );

    // Should exclude doc-3 (orthogonal = score ~0)
    expect(result.rows.length).toBe(2);
    expect(result.rows.map((r: { node_id: string }) => r.node_id)).toContain(
      "doc-1",
    );
    expect(result.rows.map((r: { node_id: string }) => r.node_id)).toContain(
      "doc-2",
    );
  });

  it("should limit results to k nearest", async () => {
    if (!isPostgresAvailable || !hasPgvector || !sharedPool) return;

    // Insert 10 test embeddings
    for (let index = 0; index < 10; index++) {
      const emb = [Math.cos(index * 0.3), Math.sin(index * 0.3), 0, 0];
      await sharedPool.query(
        `INSERT INTO typegraph_embeddings
         (id, graph_id, node_kind, node_id, field_path, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          `emb-doc-${index}`,
          "vector_test_graph",
          "Document",
          `doc-${index}`,
          "/embedding",
          `[${emb.join(",")}]`,
        ],
      );
    }

    // Query for top 3
    const queryEmbedding = "[1,0,0,0]";
    const result = await sharedPool.query(
      `SELECT node_id, embedding <=> $1::vector AS distance
       FROM typegraph_embeddings
       ORDER BY distance ASC
       LIMIT 3`,
      [queryEmbedding],
    );

    expect(result.rows.length).toBe(3);
  });

  it("should support L2 (Euclidean) distance", async () => {
    if (!isPostgresAvailable || !hasPgvector || !sharedPool) return;

    // Insert test embeddings
    await sharedPool.query(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "emb-1",
        "vector_test_graph",
        "Document",
        "doc-1",
        "/embedding",
        "[1,0,0,0]",
      ],
    );
    await sharedPool.query(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "emb-2",
        "vector_test_graph",
        "Document",
        "doc-2",
        "/embedding",
        "[2,0,0,0]",
      ],
    );

    // Query using L2 distance operator <->
    const result = await sharedPool.query(
      `SELECT node_id, embedding <-> '[1,0,0,0]'::vector AS distance
       FROM typegraph_embeddings
       ORDER BY distance ASC`,
    );

    expect(result.rows.length).toBe(2);
    // doc-1 should be first (distance 0)
    expect(result.rows[0].node_id).toBe("doc-1");
    expect(Number.parseFloat(result.rows[0].distance)).toBeCloseTo(0, 5);
    // doc-2 should have distance 1 (|[1,0,0,0] - [2,0,0,0]| = 1)
    expect(result.rows[1].node_id).toBe("doc-2");
    expect(Number.parseFloat(result.rows[1].distance)).toBeCloseTo(1, 5);
  });

  it("should support inner product distance", async () => {
    if (!isPostgresAvailable || !hasPgvector || !sharedPool) return;

    // Insert test embeddings (normalized for inner product)
    await sharedPool.query(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "emb-1",
        "vector_test_graph",
        "Document",
        "doc-1",
        "/embedding",
        "[1,0,0,0]",
      ],
    );
    await sharedPool.query(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "emb-2",
        "vector_test_graph",
        "Document",
        "doc-2",
        "/embedding",
        "[0,1,0,0]",
      ],
    );

    // Query using inner product operator <#>
    // Note: pgvector returns negative inner product, so lower = more similar
    const result = await sharedPool.query(
      `SELECT node_id, embedding <#> '[1,0,0,0]'::vector AS neg_ip
       FROM typegraph_embeddings
       ORDER BY neg_ip ASC`,
    );

    expect(result.rows.length).toBe(2);
    // doc-1 should be first (inner product = 1, neg_ip = -1)
    expect(result.rows[0].node_id).toBe("doc-1");
    // doc-2 has inner product 0 with query
    expect(result.rows[1].node_id).toBe("doc-2");
  });
});

// ============================================================
// End-to-End Vector Search via Query Builder
// ============================================================

describe("Vector Search End-to-End (Query Builder)", () => {
  let hasPgvector = false;

  // Define a graph with embedding properties for end-to-end testing
  const Document = defineNode("Document", {
    schema: z.object({
      title: z.string(),
      content: z.string(),
      embedding: embedding(4), // 4-dimensional embedding for test
    }),
  });

  const vectorTestGraph = defineGraph({
    id: "vector_e2e_test",
    nodes: {
      Document: { type: Document },
    },
    edges: {},
  });

  beforeAll(async () => {
    if (!isPostgresAvailable) return;
    hasPgvector = await isPgvectorAvailable();
    if (hasPgvector && sharedPool) {
      // Create the full embeddings table matching the schema
      await sharedPool.query(`
        DROP TABLE IF EXISTS typegraph_node_embeddings CASCADE;
        CREATE TABLE IF NOT EXISTS typegraph_node_embeddings (
          graph_id TEXT NOT NULL,
          node_kind TEXT NOT NULL,
          node_id TEXT NOT NULL,
          field_path TEXT NOT NULL,
          embedding vector NOT NULL,
          dimensions INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (graph_id, node_kind, node_id, field_path)
        )
      `);
    }
  });

  beforeEach(async () => {
    if (!isPostgresAvailable || !hasPgvector) return;
    await clearTestData();
    await sharedPool?.query("TRUNCATE typegraph_node_embeddings");
  });

  it("should execute similarTo query via store.query()", async () => {
    if (!isPostgresAvailable || !hasPgvector || !sharedPool || !sharedDb) {
      console.log(
        "Skipping end-to-end vector test - prerequisites not available",
      );
      return;
    }

    const backend = createPostgresBackend(sharedDb);
    const store = createStore(vectorTestGraph, backend);

    // Create documents with embeddings
    const document1 = await store.nodes.Document.create({
      title: "Machine Learning",
      content: "Neural networks and deep learning",
      embedding: [1, 0, 0, 0],
    });

    const document2 = await store.nodes.Document.create({
      title: "Web Development",
      content: "React and TypeScript",
      embedding: [0, 1, 0, 0],
    });

    const document3 = await store.nodes.Document.create({
      title: "AI Fundamentals",
      content: "Artificial intelligence basics",
      embedding: [0.9, 0.1, 0, 0], // Close to doc1
    });

    // Insert embeddings manually since the test backend may not have
    // the full embedding sync wired up
    for (const document of [
      { id: document1.id, embedding: [1, 0, 0, 0] },
      { id: document2.id, embedding: [0, 1, 0, 0] },
      { id: document3.id, embedding: [0.9, 0.1, 0, 0] },
    ]) {
      await sharedPool.query(
        `INSERT INTO typegraph_node_embeddings
         (graph_id, node_kind, node_id, field_path, embedding, dimensions)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (graph_id, node_kind, node_id, field_path)
         DO UPDATE SET embedding = $5, updated_at = NOW()`,
        [
          "vector_e2e_test",
          "Document",
          document.id,
          "/embedding",
          `[${document.embedding.join(",")}]`,
          4,
        ],
      );
    }

    // Query for documents similar to [1, 0, 0, 0] (Machine Learning topic)
    const queryEmbedding = [1, 0, 0, 0];
    const results = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) =>
        d.embedding.similarTo(queryEmbedding, 3, { metric: "cosine" }),
      )
      .select((ctx) => ({
        title: ctx.d.title,
        content: ctx.d.content,
      }))
      .execute();

    // Should return all 3 documents, ordered by similarity
    expect(results.length).toBe(3);

    // First result should be "Machine Learning" (exact match)
    expect(results[0]?.title).toBe("Machine Learning");

    // Second should be "AI Fundamentals" (close to query)
    expect(results[1]?.title).toBe("AI Fundamentals");

    // Third should be "Web Development" (orthogonal to query)
    expect(results[2]?.title).toBe("Web Development");
  });

  it("should filter by minScore", async () => {
    if (!isPostgresAvailable || !hasPgvector || !sharedPool || !sharedDb) {
      return;
    }

    const backend = createPostgresBackend(sharedDb);
    const store = createStore(vectorTestGraph, backend);

    // Create documents
    const document1 = await store.nodes.Document.create({
      title: "Exact Match",
      content: "Identical embedding",
      embedding: [1, 0, 0, 0],
    });

    const document2 = await store.nodes.Document.create({
      title: "Orthogonal",
      content: "Completely different",
      embedding: [0, 1, 0, 0],
    });

    // Insert embeddings
    for (const document of [
      { id: document1.id, embedding: [1, 0, 0, 0] },
      { id: document2.id, embedding: [0, 1, 0, 0] },
    ]) {
      await sharedPool.query(
        `INSERT INTO typegraph_node_embeddings
         (graph_id, node_kind, node_id, field_path, embedding, dimensions)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (graph_id, node_kind, node_id, field_path)
         DO UPDATE SET embedding = $5, updated_at = NOW()`,
        [
          "vector_e2e_test",
          "Document",
          document.id,
          "/embedding",
          `[${document.embedding.join(",")}]`,
          4,
        ],
      );
    }

    // Query with high minScore - should only return exact match
    const queryEmbedding = [1, 0, 0, 0];
    const results = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) =>
        d.embedding.similarTo(queryEmbedding, 10, {
          metric: "cosine",
          minScore: 0.9, // Only very similar results
        }),
      )
      .select((ctx) => ({
        title: ctx.d.title,
      }))
      .execute();

    // Should only return the exact match
    expect(results.length).toBe(1);
    expect(results[0]?.title).toBe("Exact Match");
  });
});
