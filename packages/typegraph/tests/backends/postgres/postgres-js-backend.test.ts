/**
 * PostgreSQL Backend Integration Tests — postgres-js driver.
 *
 * Mirrors `postgres-backend.test.ts` but wires the backend through
 * `drizzle-orm/postgres-js` + the `postgres` (porsager) driver. We run
 * the full adapter + integration suites against both drivers to prove
 * driver-agnostic behavior end-to-end.
 *
 * Skipped automatically unless `POSTGRES_URL` is set (or the
 * `scripts/test-postgres.sh` harness is used). Targets the same database
 * as `postgres-backend.test.ts`; both files use `CREATE TABLE IF NOT
 * EXISTS` DDL and per-test TRUNCATE, and the harness runs files
 * serially.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { count, defineEdge, defineGraph, defineNode } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { createStore } from "../../../src/store";
import { createAdapterTestSuite } from "../adapter-test-suite";
import { createIntegrationTestSuite } from "../integration-test-suite";

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

let sharedSql: Sql | undefined;
let sharedDb: PostgresJsDatabase | undefined;
let isPostgresAvailable = false;

function requirePostgres(ctx: { skip: () => void }): {
  sql: Sql;
  db: PostgresJsDatabase;
} {
  if (!isPostgresAvailable || !sharedSql || !sharedDb) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return { sql: sharedSql, db: sharedDb };
}

function createConnection(): { sql: Sql; db: PostgresJsDatabase } {
  const sql = postgres(TEST_DATABASE_URL, { max: 4 });
  const db = drizzle(sql);
  return { sql, db };
}

async function initializePostgres(): Promise<boolean> {
  const maxRetries = 5;
  const retryDelayMs = 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const sql = postgres(TEST_DATABASE_URL, {
      max: 4,
      connect_timeout: 5,
      onnotice: () => {
        // Silence NOTICE messages from CREATE IF NOT EXISTS so test
        // output stays readable.
      },
    });

    try {
      await sql`SELECT 1`;
      sharedSql = sql;
      sharedDb = drizzle(sql);
      return true;
    } catch {
      await sql.end().catch(() => {
        // Ignore cleanup errors
      });
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  return false;
}

async function setupTestDatabase(): Promise<void> {
  if (!sharedSql) return;
  // Run the generated migration SQL. It uses CREATE TABLE IF NOT EXISTS
  // and CREATE EXTENSION IF NOT EXISTS, so it's safe to run alongside the
  // node-postgres test file — we don't drop tables here.
  const migrationSql = generatePostgresMigrationSQL();
  await sharedSql.unsafe(migrationSql);
}

async function clearTestData(): Promise<void> {
  if (!sharedSql) return;
  await sharedSql.unsafe(
    `TRUNCATE typegraph_node_fulltext,
              typegraph_node_embeddings,
              typegraph_nodes,
              typegraph_edges,
              typegraph_node_uniques,
              typegraph_schema_versions CASCADE`,
  );
}

beforeAll(async () => {
  // Gated on POSTGRES_URL (same pattern as postgres-backend.test.ts) so
  // `pnpm test:unit` doesn't race with other postgres files when a stray
  // Docker Postgres happens to be reachable.
  if (!process.env.POSTGRES_URL) return;
  isPostgresAvailable = await initializePostgres();
  if (isPostgresAvailable) {
    await setupTestDatabase();
  }
});

afterAll(async () => {
  if (sharedSql) {
    await sharedSql.end();
  }
});

// ============================================================
// Shared Adapter + Integration Test Suites
// ============================================================

describe("PostgreSQL Adapter (postgres-js driver)", () => {
  beforeEach(async () => {
    if (!isPostgresAvailable) return;
    await clearTestData();
  });

  it("is available for testing", (ctx) => {
    requirePostgres(ctx);
    expect(sharedSql).toBeDefined();
    expect(sharedDb).toBeDefined();
  });

  describe.runIf(process.env.POSTGRES_URL)("Adapter Test Suite", () => {
    beforeEach(async () => {
      await clearTestData();
    });

    createAdapterTestSuite(
      "PostgreSQL (postgres-js)",
      () => {
        const { db } = createConnection();
        return createPostgresBackend(db);
      },
      { skipRawQueries: false },
    );
  });

  describe.runIf(process.env.POSTGRES_URL)("Integration Test Suite", () => {
    beforeEach(async () => {
      await clearTestData();
    });

    createIntegrationTestSuite("PostgreSQL (postgres-js)", () => {
      const { sql, db } = createConnection();
      return {
        backend: createPostgresBackend(db),
        cleanup: async () => {
          await sql.end();
        },
      };
    });
  });
});

// ============================================================
// postgres-js-specific coercion sanity tests
//
// These guard the places postgres-js is known to diverge from
// node-postgres: JSONB auto-parsing, numeric-as-string on aggregates,
// pgvector string format, and transaction isolation levels.
// ============================================================

describe("postgres-js driver — coercion sanity", () => {
  beforeEach(async () => {
    if (!isPostgresAvailable) return;
    await clearTestData();
  });

  it("round-trips complex JSONB props identically to node-postgres", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);

    const complexProps = {
      name: "Alice",
      // `null` (not `undefined`) is part of the round-trip we need to
      // verify: postgres-js auto-parses jsonb and must preserve nulls
      // end-to-end through our row-mapper.
      // eslint-disable-next-line unicorn/no-null
      nested: { a: 1, b: [2, 3], deep: { x: "y", n: null } },
      array: ["x", "y"],
      unicode: "日本語",
      zero: 0,
      bool: true,
    };

    const inserted = await backend.insertNode({
      graphId: "postgres_js_test",
      kind: "Person",
      id: "person-1",
      props: complexProps,
    });

    // Backend's row contract stores `props` as a JSON string — drivers must
    // agree on this wire-level representation so downstream JSON.parse is
    // idempotent regardless of whether jsonb came back parsed or as text.
    expect(typeof inserted.props).toBe("string");
    const parsed = JSON.parse(inserted.props);
    expect(parsed).toEqual(complexProps);

    const fetched = await backend.getNode(
      "postgres_js_test",
      "Person",
      "person-1",
    );
    expect(fetched).toBeDefined();
    expect(typeof fetched!.props).toBe("string");
    expect(JSON.parse(fetched!.props)).toEqual(complexProps);
  });

  it("returns aggregate counts as plain numbers (not BigInt)", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);

    for (let index = 0; index < 5; index++) {
      await backend.insertNode({
        graphId: "postgres_js_test",
        kind: "Person",
        id: `person-count-${index}`,
        props: { name: `Person ${index}` },
      });
    }

    const Person = defineNode("Person", {
      schema: z.object({ name: z.string() }),
    });
    const graph = defineGraph({
      id: "postgres_js_test",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const store = createStore(graph, backend);

    const result = await store
      .query()
      .from("Person", "p")
      .aggregate({ total: count("p") })
      .execute();

    expect(result).toHaveLength(1);
    // Postgres' `COUNT(*)` returns a `bigint`. node-postgres coerces to
    // string; postgres-js coerces to native `BigInt` unless Drizzle's
    // transparent-parser override catches OID 20. Assert we get a plain
    // JS number at the store boundary — that's the contract.
    expect(typeof result[0]!.total).toBe("number");
    expect(result[0]!.total).toBe(5);
  });

  it("honors serializable isolation on db.transaction", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);

    await backend.transaction(
      async (tx) => {
        await tx.insertNode({
          graphId: "postgres_js_test",
          kind: "Person",
          id: "tx-1",
          props: { name: "Alice" },
        });
      },
      { isolationLevel: "serializable" },
    );

    const fetched = await backend.getNode("postgres_js_test", "Person", "tx-1");
    expect(fetched).toBeDefined();
    expect(JSON.parse(fetched!.props).name).toBe("Alice");
  });
});

// ============================================================
// Store smoke test — exercises the full CRUD surface once
// through the postgres-js adapter, mirroring a tight subset of
// what the node-postgres file asserts.
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.email().optional(),
    age: z.number().int().positive().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});

const smokeGraph = defineGraph({
  id: "postgres_js_smoke",
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

describe("Store with PostgreSQL (postgres-js driver)", () => {
  beforeEach(async () => {
    if (!isPostgresAvailable) return;
    await clearTestData();
  });

  it("creates, retrieves, updates, and soft-deletes nodes through postgres-js", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(smokeGraph, backend);

    const person = await store.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
    });
    expect(person.name).toBe("Alice");

    const updated = await store.nodes.Person.update(person.id, {
      name: "Alice Smith",
      age: 30,
    });
    expect(updated.name).toBe("Alice Smith");
    expect(updated.age).toBe(30);
    expect(updated.meta.version).toBe(2);

    await store.nodes.Person.delete(person.id);
    const afterDelete = await store.nodes.Person.getById(person.id);
    expect(afterDelete).toBeUndefined();
  });

  it("creates edges across the postgres-js driver", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(smokeGraph, backend);

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const edge = await store.edges.worksAt.create(alice, acme, {
      role: "Engineer",
    });
    expect(edge.fromId).toBe(alice.id);
    expect(edge.toId).toBe(acme.id);
    expect(edge.role).toBe("Engineer");
  });

  it("executes transactions atomically through postgres-js", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(smokeGraph, backend);

    const result = await store.transaction(async (tx) => {
      const alice = await tx.nodes.Person.create({ name: "Alice" });
      const acme = await tx.nodes.Company.create({ name: "Acme" });
      const edge = await tx.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });
      return { alice, acme, edge };
    });

    expect(result.alice.id).toBeDefined();
    expect(result.edge.role).toBe("Engineer");

    const fetched = await store.nodes.Person.getById(result.alice.id);
    expect(fetched).toBeDefined();
  });
});
