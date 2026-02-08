/**
 * Example 06: Inverse Edges
 *
 * This example demonstrates using inverseOf for bidirectional relationships:
 * - Defining inverse edge pairs
 * - Querying in either direction
 * - Registry lookups for inverse edges
 */
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineEdge,
  defineNode,
  inverseOf,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Scenario: Organizational Structure
// ============================================================

// In an organization:
// - A person "manages" their reports
// - A person "reportsTo" their manager
// These are inverses of each other!

const Employee = defineNode("Employee", {
  schema: z.object({
    name: z.string(),
    title: z.string(),
    department: z.string(),
  }),
});

const Team = defineNode("Team", {
  schema: z.object({
    name: z.string(),
    purpose: z.string().optional(),
  }),
});

// Management relationship and its inverse
const manages = defineEdge("manages", {
  schema: z.object({
    since: z.string().optional(),
  }),
});

const reportsTo = defineEdge("reportsTo", {
  schema: z.object({
    since: z.string().optional(),
  }),
});

// Team membership and its inverse
const memberOf = defineEdge("memberOf", {
  schema: z.object({
    role: z.string().optional(),
  }),
});

const hasMember = defineEdge("hasMember", {
  schema: z.object({
    role: z.string().optional(),
  }),
});

// Mentorship (bidirectional awareness)
const mentors = defineEdge("mentors", {
  schema: z.object({
    topic: z.string().optional(),
  }),
});

const mentoredBy = defineEdge("mentoredBy", {
  schema: z.object({
    topic: z.string().optional(),
  }),
});

// ============================================================
// Define Graph with Inverse Relationships
// ============================================================

const graph = defineGraph({
  id: "organization",
  nodes: {
    Employee: { type: Employee },
    Team: { type: Team },
  },
  edges: {
    manages: { type: manages, from: [Employee], to: [Employee] },
    reportsTo: { type: reportsTo, from: [Employee], to: [Employee] },
    memberOf: { type: memberOf, from: [Employee], to: [Team] },
    hasMember: { type: hasMember, from: [Team], to: [Employee] },
    mentors: { type: mentors, from: [Employee], to: [Employee] },
    mentoredBy: { type: mentoredBy, from: [Employee], to: [Employee] },
  },
  ontology: [
    // Define inverse pairs
    inverseOf(manages, reportsTo),
    inverseOf(memberOf, hasMember),
    inverseOf(mentors, mentoredBy),
  ],
});

// ============================================================
// Demonstrate Inverse Edges
// ============================================================

export async function main() {
  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  console.log("=== Inverse Edges Examples ===\n");

  // Create employees
  const ceo = await store.nodes.Employee.create({
    name: "Sarah CEO",
    title: "CEO",
    department: "Executive",
  });

  const vpEng = await store.nodes.Employee.create({
    name: "Mike VP",
    title: "VP Engineering",
    department: "Engineering",
  });

  const seniorDev = await store.nodes.Employee.create({
    name: "Alice Senior",
    title: "Senior Developer",
    department: "Engineering",
  });

  const juniorDev = await store.nodes.Employee.create({
    name: "Bob Junior",
    title: "Junior Developer",
    department: "Engineering",
  });

  // Create a team
  const platformTeam = await store.nodes.Team.create({
    name: "Platform Team",
    purpose: "Build core infrastructure",
  });

  console.log("Created employees: Sarah (CEO), Mike (VP), Alice (Senior), Bob (Junior)");
  console.log("Created team: Platform Team\n");

  // Create management relationships (only need to create one direction!)
  console.log("Creating management chain...");

  await store.edges.manages.create(ceo, vpEng, { since: "2020-01-01" });
  console.log("  Sarah manages Mike");

  await store.edges.manages.create(vpEng, seniorDev, { since: "2021-03-15" });
  console.log("  Mike manages Alice");

  await store.edges.manages.create(seniorDev, juniorDev, { since: "2023-06-01" });
  console.log("  Alice manages Bob");

  // Create team membership
  await store.edges.memberOf.create(seniorDev, platformTeam, { role: "Tech Lead" });
  await store.edges.memberOf.create(juniorDev, platformTeam, { role: "Developer" });
  console.log("\n  Alice and Bob are members of Platform Team");

  // Create mentorship
  await store.edges.mentors.create(seniorDev, juniorDev, { topic: "System Design" });
  console.log("  Alice mentors Bob on System Design");

  // Show inverse relationships in registry
  console.log("\n=== Registry Inverse Lookups ===\n");

  const registry = store.registry;

  const inversePairs = [
    "manages",
    "reportsTo",
    "memberOf",
    "hasMember",
    "mentors",
    "mentoredBy",
  ];

  for (const edgeKind of inversePairs) {
    const inverse = registry.getInverseEdge(edgeKind);
    console.log(`  ${edgeKind} ⟷ ${inverse ?? "(none)"}`);
  }

  // Query from different directions
  console.log("\n=== Querying in Both Directions ===\n");

  // Forward: Who does Alice manage?
  console.log("Query: Who does Alice manage?");
  const aliceManages = await store
    .query()
    .from("Employee", "manager")
    .traverse("manages", "e")
    .to("Employee", "report")
    .select((ctx) => ({
      manager: ctx.manager.name,
      report: ctx.report.name,
    }))
    .execute();

  for (const row of aliceManages) {
    if (row.manager === "Alice Senior") {
      console.log(`  ${row.manager} manages ${row.report}`);
    }
  }

  // Reverse: Who does Bob report to?
  // Since we only created "manages" edges, we query in reverse direction
  console.log("\nQuery: Who does Bob report to? (using 'manages' with direction: 'in')");
  const bobReportsTo = await store
    .query()
    .from("Employee", "report")
    .traverse("manages", "e", { direction: "in" })
    .to("Employee", "manager")
    .select((ctx) => ({
      report: ctx.report.name,
      manager: ctx.manager.name,
    }))
    .execute();

  for (const row of bobReportsTo) {
    if (row.report === "Bob Junior") {
      console.log(`  ${row.report} reports to ${row.manager}`);
    }
  }

  // Full management chain upward from Bob
  console.log("\nBob's management chain (manual traversal):");
  let currentId: string | undefined = juniorDev.id;
  let level = 0;

  while (currentId) {
    const current = await store.nodes.Employee.getById(currentId as typeof juniorDev.id);
    if (!current) break;

    const indent = "  ".repeat(level);
    console.log(`${indent}${current.name} (${current.title})`);

    // Find manager
    const managerEdges = await store
      .query()
      .from("Employee", "emp")
      .traverse("manages", "e", { direction: "in" })
      .to("Employee", "mgr")
      .select((ctx) => ({
        empId: ctx.emp.id,
        mgrId: ctx.mgr.id,
      }))
      .execute();

    const myManager = managerEdges.find((r) => r.empId === currentId);
    currentId = myManager?.mgrId;
    level++;
  }

  // Team membership query
  console.log("\n=== Team Membership ===\n");

  console.log("Query: Who is on the Platform Team?");
  const teamMembers = await store
    .query()
    .from("Team", "team")
    .traverse("memberOf", "m", { direction: "in" })
    .to("Employee", "member")
    .select((ctx) => ({
      team: ctx.team.name,
      member: ctx.member.name,
    }))
    .execute();

  for (const row of teamMembers) {
    console.log(`  ${row.member} on ${row.team}`);
  }

  console.log("\n=== Inverse edges example complete ===");

  await backend.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
