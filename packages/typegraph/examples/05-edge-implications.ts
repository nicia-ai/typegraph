/**
 * Example 05: Edge Implications
 *
 * This example demonstrates using implies for edge relationships:
 * - Defining that one edge type implies another
 * - Query-time expansion to include implying edges
 * - Building semantic hierarchies of relationships
 */
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineEdge,
  defineNode,
  implies,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Scenario: Social Network with Relationship Hierarchy
// ============================================================

// In a social network, relationships have implicit meanings:
// - "married_to" implies "partners_with" implies "knows"
// - "parent_of" implies "related_to" implies "knows"
// - "best_friends" implies "friends" implies "knows"

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    birthYear: z.number().int().optional(),
  }),
});

// Base relationship - everyone who has any connection "knows" each other
const knows = defineEdge("knows", {
  schema: z.object({
    since: z.string().optional(),
  }),
});

// Friendship levels
const friends = defineEdge("friends", {
  schema: z.object({
    since: z.string().optional(),
  }),
});

const bestFriends = defineEdge("bestFriends", {
  schema: z.object({
    since: z.string().optional(),
  }),
});

// Romantic relationships
const partnersWith = defineEdge("partnersWith", {
  schema: z.object({
    since: z.string().optional(),
  }),
});

const marriedTo = defineEdge("marriedTo", {
  schema: z.object({
    marriageDate: z.string(),
  }),
});

// Family relationships
const relatedTo = defineEdge("relatedTo", {
  schema: z.object({
    relation: z.string().optional(), // "cousin", "aunt", etc.
  }),
});

const parentOf = defineEdge("parentOf", {
  schema: z.object({}),
});

const siblingOf = defineEdge("siblingOf", {
  schema: z.object({}),
});

// ============================================================
// Define Graph with Implications
// ============================================================

const graph = defineGraph({
  id: "social_network",
  nodes: {
    Person: { type: Person },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
    friends: { type: friends, from: [Person], to: [Person] },
    bestFriends: { type: bestFriends, from: [Person], to: [Person] },
    partnersWith: { type: partnersWith, from: [Person], to: [Person] },
    marriedTo: { type: marriedTo, from: [Person], to: [Person] },
    relatedTo: { type: relatedTo, from: [Person], to: [Person] },
    parentOf: { type: parentOf, from: [Person], to: [Person] },
    siblingOf: { type: siblingOf, from: [Person], to: [Person] },
  },
  ontology: [
    // Friendship hierarchy:
    // bestFriends -> friends -> knows
    implies(bestFriends, friends),
    implies(friends, knows),

    // Romantic hierarchy:
    // marriedTo -> partnersWith -> knows
    implies(marriedTo, partnersWith),
    implies(partnersWith, knows),

    // Family hierarchy:
    // parentOf -> relatedTo -> knows
    // siblingOf -> relatedTo -> knows
    implies(parentOf, relatedTo),
    implies(siblingOf, relatedTo),
    implies(relatedTo, knows),
  ],
});

// ============================================================
// Demonstrate Implications
// ============================================================

export async function main() {
  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  console.log("=== Edge Implications Examples ===\n");

  // Create some people
  const alice = await store.nodes.Person.create({ name: "Alice", birthYear: 1990 });
  const bob = await store.nodes.Person.create({ name: "Bob", birthYear: 1988 });
  const charlie = await store.nodes.Person.create({ name: "Charlie", birthYear: 1992 });
  const diana = await store.nodes.Person.create({ name: "Diana", birthYear: 1995 });
  const eve = await store.nodes.Person.create({ name: "Eve", birthYear: 1965 });

  console.log("Created people: Alice, Bob, Charlie, Diana, Eve\n");

  // Create various relationships - pass nodes directly
  console.log("Creating relationships...");

  // Alice and Bob are married
  await store.edges.marriedTo.create(alice, bob, { marriageDate: "2018-06-15" });
  console.log("  Alice marriedTo Bob");

  // Alice and Charlie are best friends
  await store.edges.bestFriends.create(alice, charlie, { since: "2005-09-01" });
  console.log("  Alice bestFriends Charlie");

  // Diana is just a friend
  await store.edges.friends.create(alice, diana, { since: "2020-01-01" });
  console.log("  Alice friends Diana");

  // Eve is Alice's parent
  await store.edges.parentOf.create(eve, alice, {});
  console.log("  Eve parentOf Alice");

  // Show implication hierarchy
  console.log("\n=== Implication Hierarchy ===\n");

  const registry = store.registry;

  console.log("What does 'marriedTo' imply?");
  const marriedImplies = registry.getImpliedEdges("marriedTo");
  console.log(`  marriedTo implies: [${marriedImplies.join(", ")}]`);

  console.log("\nWhat does 'bestFriends' imply?");
  const bestFriendsImplies = registry.getImpliedEdges("bestFriends");
  console.log(`  bestFriends implies: [${bestFriendsImplies.join(", ")}]`);

  console.log("\nWhat does 'parentOf' imply?");
  const parentImplies = registry.getImpliedEdges("parentOf");
  console.log(`  parentOf implies: [${parentImplies.join(", ")}]`);

  console.log("\nWhat edges imply 'knows'? (reverse lookup)");
  const knowsImplyingEdges = registry.getImplyingEdges("knows");
  console.log(`  These edges imply knows: [${knowsImplyingEdges.join(", ")}]`);

  // Query with implications
  console.log("\n=== Query with Edge Implication Expansion ===\n");

  // Query: "Who does Alice know?" using implication expansion
  console.log("Query: Who does Alice know? (includeImplyingEdges: true)");
  console.log("  This will find: knows, friends, bestFriends, marriedTo, etc.\n");

  const aliceKnows = await store
    .query()
    .from("Person", "alice")
    .traverse("knows", "e", { includeImplyingEdges: true })
    .to("Person", "other")
    .select((ctx) => ({
      person: ctx.other.name,
    }))
    .execute();

  console.log("  Alice knows (via any implying relationship):");
  for (const row of aliceKnows) {
    console.log(`    - ${row.person}`);
  }

  // Query without expansion
  console.log("\nQuery: Who does Alice explicitly 'knows'? (no expansion)");

  const aliceExplicitlyKnows = await store
    .query()
    .from("Person", "alice")
    .traverse("knows", "e") // No includeImplyingEdges
    .to("Person", "other")
    .select((ctx) => ({
      person: ctx.other.name,
    }))
    .execute();

  if (aliceExplicitlyKnows.length === 0) {
    console.log("  No explicit 'knows' edges (all relationships are more specific)");
  } else {
    for (const row of aliceExplicitlyKnows) {
      console.log(`    - ${row.person}`);
    }
  }

  // Query friends (including best friends)
  console.log("\nQuery: Who is Alice friends with? (includeImplyingEdges: true)");

  const aliceFriends = await store
    .query()
    .from("Person", "alice")
    .traverse("friends", "e", { includeImplyingEdges: true })
    .to("Person", "friend")
    .select((ctx) => ({
      friend: ctx.friend.name,
    }))
    .execute();

  console.log("  Alice's friends (including best friends):");
  for (const row of aliceFriends) {
    console.log(`    - ${row.friend}`);
  }

  console.log("\n=== Edge implications example complete ===");

  await backend.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
