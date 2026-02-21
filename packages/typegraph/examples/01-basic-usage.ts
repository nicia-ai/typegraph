/**
 * Example 01: Basic Usage
 *
 * This example demonstrates the fundamental concepts of TypeGraph:
 * - Defining node and edge kinds with Zod schemas
 * - Creating a graph definition
 * - Creating nodes and edges
 * - Using upsert/get-or-create collection APIs
 * - Simple queries
 */
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineEdge,
  defineNode,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Step 1: Define Node Types
// ============================================================

// Each node type has a name and a Zod schema for its properties
const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().email(),
    age: z.number().int().positive().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    industry: z.string(),
    founded: z.number().int().optional(),
  }),
});

// ============================================================
// Step 2: Define Edge Types
// ============================================================

// Edges connect nodes and can also have properties
const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startDate: z.string().optional(),
  }),
});

const knows = defineEdge("knows", {
  schema: z.object({
    since: z.string().optional(),
  }),
});

// ============================================================
// Step 3: Define the Graph
// ============================================================

// The graph definition combines nodes, edges, and ontology
const graph = defineGraph({
  id: "basic_example",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "person_email",
          fields: ["email"],
          scope: "kind",
          collation: "caseInsensitive",
        },
      ],
    },
    Company: { type: Company },
  },
  edges: {
    // Specify which node types each edge can connect
    worksAt: { type: worksAt, from: [Person], to: [Company] },
    knows: { type: knows, from: [Person], to: [Person] },
  },
  ontology: [], // No ontology relations for this basic example
});

// ============================================================
// Step 4: Create Store and Use It
// ============================================================

export async function main() {
  // Create an in-memory SQLite backend (supports full query API)
  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  // Create some nodes using the collection API
  const alice = await store.nodes.Person.create({
    name: "Alice",
    email: "alice@example.com",
    age: 30,
  });
  console.log("Created Alice:", alice.id);

  const bob = await store.nodes.Person.create({
    name: "Bob",
    email: "bob@example.com",
  });
  console.log("Created Bob:", bob.id);

  const acme = await store.nodes.Company.upsertById("company:acme", {
    name: "Acme Corp",
    industry: "Technology",
    founded: 2010,
  });
  console.log("Upserted Acme Corp by ID:", acme.id);

  // Get or create by a uniqueness constraint (person_email)
  const aliceByConstraint = await store.nodes.Person.getOrCreateByConstraint(
    "person_email",
    {
      name: "Alice",
      email: "alice@example.com",
      age: 31,
    },
    { ifExists: "update" },
  );
  console.log(
    "getOrCreateByConstraint for Alice:",
    aliceByConstraint.action,
    aliceByConstraint.node.id,
  );

  // Create edges by passing nodes directly
  await store.edges.worksAt.create(aliceByConstraint.node, acme, {
    role: "Engineer",
    startDate: "2023-01-15",
  });
  console.log("Created edge: Alice worksAt Acme");

  const knowsResult = await store.edges.knows.getOrCreateByEndpoints(
    aliceByConstraint.node,
    bob,
    { since: "2022-06-01" },
    { ifExists: "return" },
  );
  console.log("getOrCreateByEndpoints (knows):", knowsResult.action, knowsResult.edge.id);

  // Retrieve nodes by ID
  const retrievedAlice = await store.nodes.Person.getById(aliceByConstraint.node.id);
  console.log(
    "\nRetrieved Alice:",
    retrievedAlice && { name: retrievedAlice.name, email: retrievedAlice.email },
  );

  // Query using the fluent API - including edge properties
  const results = await store
    .query()
    .from("Person", "p")
    .traverse("worksAt", "e")
    .to("Company", "c")
    .select((ctx) => ({
      personName: ctx.p.name,
      companyName: ctx.c.name,
      role: ctx.e.role,           // Access edge property
      startDate: ctx.e.startDate, // Access optional edge property
    }))
    .execute();

  console.log("\nQuery results (who works where):");
  for (const row of results) {
    console.log(`  ${row.personName} works at ${row.companyName} as ${row.role}`);
  }

  // Clean up
  await backend.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
