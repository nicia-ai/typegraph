/**
 * Example 10: PostgreSQL Backend
 *
 * This example demonstrates using TypeGraph with PostgreSQL:
 * - Setting up a PostgreSQL connection
 * - Running migrations
 * - Using PostgreSQL-specific features (JSONB, transactions)
 *
 * Prerequisites:
 * - PostgreSQL server running
 * - Set POSTGRES_URL environment variable or use default
 *
 * Run with:
 *   POSTGRES_URL=postgresql://user:pass@localhost:5432/typegraph_example \
 *   npx tsx examples/10-postgresql.ts
 */
import { z } from "zod";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  createStore,
  defineGraph,
  defineEdge,
  defineNode,
  subClassOf,
} from "@nicia-ai/typegraph";
import {
  createPostgresBackend,
  generatePostgresMigrationSQL,
} from "@nicia-ai/typegraph/postgres";

// ============================================================
// Schema Definition
// ============================================================

const Entity = defineNode("Entity", {
  schema: z.object({
    createdBy: z.string().optional(),
  }),
});

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().email(),
    metadata: z
      .object({
        preferences: z.record(z.string(), z.unknown()).optional(),
        tags: z.array(z.string()).optional(),
      })
      .optional(),
  }),
});

const Organization = defineNode("Organization", {
  schema: z.object({
    name: z.string(),
    settings: z
      .object({
        features: z.array(z.string()).default([]),
        config: z.record(z.string(), z.unknown()).default({}),
      })
      .default({ features: [], config: {} }),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startDate: z.string(),
  }),
});

const graph = defineGraph({
  id: "postgres_example",
  nodes: {
    Entity: { type: Entity },
    Person: { type: Person },
    Organization: { type: Organization },
  },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Organization] },
  },
  ontology: [subClassOf(Person, Entity), subClassOf(Organization, Entity)],
});

// ============================================================
// PostgreSQL Setup and Demo
// ============================================================

export async function main() {
  console.log("=== PostgreSQL Backend Example ===\n");

  // Get connection URL from environment or use default
  const connectionString =
    process.env.POSTGRES_URL ??
    "postgresql://typegraph:typegraph@localhost:5432/typegraph_example";

  console.log("Connecting to PostgreSQL...");
  console.log(`  URL: ${connectionString.replace(/:[^:@]+@/, ":****@")}\n`);

  // Create connection pool
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  try {
    // Test connection
    await pool.query("SELECT 1");
    console.log("Connected successfully!\n");

    // Run TypeGraph migrations
    console.log("Running TypeGraph migrations...");
    const migrationSQL = generatePostgresMigrationSQL();
    for (const statement of migrationSQL.split(";").filter((s) => s.trim())) {
      await pool.query(statement);
    }
    console.log("Migrations complete!\n");

    // Create Drizzle instance and backend
    const db = drizzle(pool);
    const backend = createPostgresBackend(db);

    // Create store
    const store = createStore(graph, backend);

    // ============================================================
    // Create Data with Rich JSON
    // ============================================================

    console.log("=== Creating Data with JSONB ===\n");

    const org = await store.nodes.Organization.create({
      name: "Acme Corp",
      settings: {
        features: ["sso", "audit-logs", "api-access"],
        config: {
          theme: "dark",
          timezone: "America/New_York",
          maxUsers: 100,
        },
      },
    });
    console.log(`Created organization: ${org.name}`);
    console.log(`  Features: ${org.settings.features.join(", ")}`);

    const alice = await store.nodes.Person.create({
      name: "Alice Engineer",
      email: "alice@acme.com",
      metadata: {
        preferences: {
          notifications: true,
          theme: "dark",
        },
        tags: ["developer", "team-lead"],
      },
    });
    console.log(`Created person: ${alice.name}`);

    await store.edges.worksAt.create(alice, org, {
      role: "Senior Engineer",
      startDate: "2023-01-15",
    });
    console.log(`  Works at: ${org.name}\n`);

    // ============================================================
    // Transactions
    // ============================================================

    console.log("=== Using Transactions ===\n");

    await store.transaction(async (tx) => {
      const bob = await tx.nodes.Person.create({
        name: "Bob Developer",
        email: "bob@acme.com",
        metadata: {
          preferences: { notifications: false },
          tags: ["developer"],
        },
      });

      const carol = await tx.nodes.Person.create({
        name: "Carol Manager",
        email: "carol@acme.com",
        metadata: {
          preferences: { notifications: true },
          tags: ["manager"],
        },
      });

      await tx.edges.worksAt.create(bob, org, {
        role: "Developer",
        startDate: "2023-06-01",
      });

      await tx.edges.worksAt.create(carol, org, {
        role: "Engineering Manager",
        startDate: "2022-03-15",
      });

      console.log(`Created ${bob.name} and ${carol.name} in transaction`);
    });
    console.log("Transaction committed!\n");

    // ============================================================
    // Query with JSON Operations
    // ============================================================

    console.log("=== Querying Data ===\n");

    const employees = await store
      .query()
      .from("Organization", "o")
      .traverse("worksAt", "e", { direction: "in" })
      .to("Person", "p")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- traverse edge typing limitation
      .select((ctx: any) => ({
        org: ctx.o.name,
        person: ctx.p.name,
        role: ctx.e.role,
        startDate: ctx.e.startDate,
      }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- traverse edge typing limitation
      .orderBy("e" as any, "startDate", "asc")
      .execute();

    console.log(`${org.name} employees:`);
    for (const emp of employees) {
      console.log(`  - ${emp.person} (${emp.role}) since ${emp.startDate}`);
    }

    // ============================================================
    // PostgreSQL-Specific Features
    // ============================================================

    console.log("\n=== PostgreSQL Features ===\n");

    console.log("JSONB Storage:");
    console.log("  - Nested objects stored as JSONB (not TEXT)");
    console.log("  - Efficient indexing with GIN indexes");
    console.log("  - Native JSON operators in queries\n");

    console.log("Connection Pooling:");
    console.log(`  - Pool size: ${pool.totalCount}`);
    console.log(`  - Idle connections: ${pool.idleCount}`);
    console.log(`  - Waiting clients: ${pool.waitingCount}\n`);

    console.log("Transactions:");
    console.log("  - Full ACID guarantees");
    console.log("  - Automatic rollback on error");
    console.log("  - Nested transaction support (via savepoints)\n");

    // ============================================================
    // Cleanup
    // ============================================================

    console.log("=== Cleanup ===\n");

    // Delete in correct order (edges first due to constraints)
    const allPeople = await store
      .query()
      .from("Person", "p")
      .select((ctx) => ({ id: ctx.p.id }))
      .execute();

    for (const person of allPeople) {
      await store.nodes.Person.delete(person.id as typeof alice.id);
    }
    console.log(`Deleted ${allPeople.length} people`);

    await store.nodes.Organization.delete(org.id);
    console.log("Deleted organization\n");

    console.log("=== PostgreSQL example complete ===");
  } catch (error) {
    if (error instanceof Error && error.message.includes("ECONNREFUSED")) {
      console.error("Could not connect to PostgreSQL.");
      console.error("Make sure PostgreSQL is running and POSTGRES_URL is set correctly.");
      console.error("\nTo run this example:");
      console.error("  1. Start PostgreSQL server");
      console.error("  2. Create database: createdb typegraph_example");
      console.error("  3. Run: POSTGRES_URL=postgresql://user:pass@localhost:5432/typegraph_example npx tsx examples/10-postgresql.ts");
    } else {
      throw error;
    }
  } finally {
    // Close connection pool
    await pool.end();
    console.log("\nConnection pool closed.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
