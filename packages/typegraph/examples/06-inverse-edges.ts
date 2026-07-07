/**
 * Example 06: Inverse Edges
 *
 * This example demonstrates using inverseOf for bidirectional relationships:
 * - Defining inverse edge pairs
 * - Querying in either direction
 * - Registry lookups for inverse edges
 */
import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  inverseOf,
} from "@nicia-ai/typegraph";
import { z } from "zod";

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

  try {
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

    const seniorDevelopment = await store.nodes.Employee.create({
      name: "Alice Senior",
      title: "Senior Developer",
      department: "Engineering",
    });

    const juniorDevelopment = await store.nodes.Employee.create({
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

    // Create management relationships (only need to create one direction —
    // the reportsTo traversals below derive the other from the ontology!)
    console.log("Creating management chain...");

    await store.edges.manages.create(ceo, vpEng, { since: "2020-01-01" });
    console.log("  Sarah manages Mike");

    await store.edges.manages.create(vpEng, seniorDevelopment, { since: "2021-03-15" });
    console.log("  Mike manages Alice");

    await store.edges.manages.create(seniorDevelopment, juniorDevelopment, { since: "2023-06-01" });
    console.log("  Alice manages Bob");

    // Create team membership
    await store.edges.memberOf.create(seniorDevelopment, platformTeam, { role: "Tech Lead" });
    await store.edges.memberOf.create(juniorDevelopment, platformTeam, { role: "Developer" });
    console.log("\n  Alice and Bob are members of Platform Team");

    // Create mentorship
    await store.edges.mentors.create(seniorDevelopment, juniorDevelopment, { topic: "System Design" });
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
      .whereNode("manager", ({ name }) => name.eq("Alice Senior"))
      .traverse("manages", "e")
      .to("Employee", "report")
      .select((ctx) => ({
        manager: ctx.manager.name,
        report: ctx.report.name,
      }))
      .execute();

    for (const row of aliceManages) {
      console.log(`  ${row.manager} manages ${row.report}`);
    }

    // Reverse: Who does Bob report to?
    // No reportsTo edge was ever created — the inverseOf(manages, reportsTo)
    // ontology lets the traversal follow stored manages edges inversely
    console.log("\nQuery: Who does Bob report to? (traversing 'reportsTo')");
    const bobReportsTo = await store
      .query()
      .from("Employee", "report")
      .whereNode("report", ({ name }) => name.eq("Bob Junior"))
      .traverse("reportsTo", "e")
      .to("Employee", "manager")
      .select((ctx) => ({
        report: ctx.report.name,
        manager: ctx.manager.name,
      }))
      .execute();

    for (const row of bobReportsTo) {
      console.log(`  ${row.report} reports to ${row.manager}`);
    }

    // Full management chain upward from Bob — one bound reportsTo query per level
    console.log("\nBob's management chain (reportsTo traversal per level):");
    type ChainEntry = Readonly<{ id: string; name: string; title: string }>;
    let current: ChainEntry | undefined = juniorDevelopment;
    let level = 0;

    while (current !== undefined) {
      const employee = current;
      const indent = "  ".repeat(level);
      console.log(`${indent}${employee.name} (${employee.title})`);

      // Find this employee's manager via the derived reportsTo edge
      const managers: readonly ChainEntry[] = await store
        .query()
        .from("Employee", "emp")
        .whereNode("emp", ({ id }) => id.eq(employee.id))
        .traverse("reportsTo", "e")
        .to("Employee", "mgr")
        .select((ctx) => ({
          id: ctx.mgr.id,
          name: ctx.mgr.name,
          title: ctx.mgr.title,
        }))
        .execute();

      current = managers[0];
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
  } finally {
    await backend.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
