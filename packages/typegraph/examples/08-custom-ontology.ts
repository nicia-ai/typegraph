/**
 * Example 08: Custom Ontology
 *
 * This example demonstrates advanced ontology features:
 * - Using the full set of core meta-edges
 * - Creating custom meta-edges for domain-specific semantics
 * - Combining multiple ontological relationships
 * - Building a rich domain model
 */
import { z } from "zod";

import {
  broader,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  equivalentTo,
  hasPart,
  implies,
  inverseOf,
  metaEdge,
  narrower,
  partOf,
  relatedTo,
  sameAs,
  subClassOf,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Part 1: Using All Core Meta-Edges
// ============================================================

// Domain: A Research Knowledge Graph

// === Node Types ===

const Concept = defineNode("Concept", {
  schema: z.object({
    name: z.string(),
    definition: z.string().optional(),
  }),
});

const Topic = defineNode("Topic", {
  schema: z.object({
    name: z.string(),
    field: z.string(),
  }),
});

const Paper = defineNode("Paper", {
  schema: z.object({
    title: z.string(),
    abstract: z.string().optional(),
    year: z.number().int(),
    doi: z.string().optional(),
  }),
});

const Author = defineNode("Author", {
  schema: z.object({
    name: z.string(),
    affiliation: z.string().optional(),
    orcid: z.string().optional(), // ORCID identifier
  }),
});

const Institution = defineNode("Institution", {
  schema: z.object({
    name: z.string(),
    country: z.string(),
    rorId: z.string().optional(), // ROR identifier
  }),
});

const Department = defineNode("Department", {
  schema: z.object({
    name: z.string(),
  }),
});

const ResearchGroup = defineNode("ResearchGroup", {
  schema: z.object({
    name: z.string(),
    focus: z.string(),
  }),
});

// === Edge Types ===

const authorOf = defineEdge("authorOf", {
  schema: z.object({
    position: z.number().int().optional(), // Author position
  }),
});

const cites = defineEdge("cites", {
  schema: z.object({
    context: z.string().optional(),
  }),
});

const citedBy = defineEdge("citedBy", {
  schema: z.object({
    context: z.string().optional(),
  }),
});

const about = defineEdge("about", {
  schema: z.object({}),
});

const affiliatedWith = defineEdge("affiliatedWith", {
  schema: z.object({
    since: z.string().optional(),
  }),
});

const memberOf = defineEdge("memberOf", {
  schema: z.object({
    role: z.string().optional(),
  }),
});

const locatedIn = defineEdge("locatedIn", {
  schema: z.object({}),
});

// ============================================================
// Part 2: Create Custom Meta-Edges
// ============================================================

// Custom meta-edge for "prerequisite" relationships
// If learning topic A requires knowing topic B first
const prerequisiteOfMetaEdge = metaEdge("prerequisiteOf", {
  transitive: true, // If A prereq B and B prereq C, then A prereq C
  inference: "hierarchy",
  description: "Learning prerequisite (Calculus prerequisiteOf Linear Algebra)",
});

// Custom meta-edge for "supersedes" relationships
// When one thing replaces another (e.g., new API version)
const supersedesMetaEdge = metaEdge("supersedes", {
  transitive: true, // If A supersedes B and B supersedes C, then A supersedes C
  inference: "substitution",
  description: "Replacement relationship (v2 supersedes v1)",
});

// Custom factory function for our meta-edge
function prerequisiteOf(
  prerequisite: typeof Topic,
  dependent: typeof Topic,
) {
  return {
    metaEdge: prerequisiteOfMetaEdge,
    from: prerequisite,
    to: dependent,
  };
}

function supersedes(
  newer: typeof Paper,
  older: typeof Paper,
) {
  return {
    metaEdge: supersedesMetaEdge,
    from: newer,
    to: older,
  };
}

// ============================================================
// Part 3: Define the Graph
// ============================================================

const graph = defineGraph({
  id: "research_kg",
  nodes: {
    Concept: { type: Concept },
    Topic: { type: Topic },
    Paper: { type: Paper },
    Author: { type: Author },
    Institution: { type: Institution },
    Department: { type: Department },
    ResearchGroup: { type: ResearchGroup },
  },
  edges: {
    authorOf: { type: authorOf, from: [Author], to: [Paper] },
    cites: { type: cites, from: [Paper], to: [Paper] },
    citedBy: { type: citedBy, from: [Paper], to: [Paper] },
    about: { type: about, from: [Paper], to: [Topic, Concept] },
    affiliatedWith: { type: affiliatedWith, from: [Author], to: [Institution] },
    memberOf: { type: memberOf, from: [Author], to: [ResearchGroup] },
    locatedIn: { type: locatedIn, from: [Department, ResearchGroup], to: [Institution] },
  },
  ontology: [
    // === Subsumption (Type Hierarchy) ===
    // Topics and Concepts are both types of abstract knowledge
    subClassOf(Topic, Concept),

    // Departments and Research Groups are organizational units
    subClassOf(Department, Institution),

    // === Hierarchical Relationships (SKOS-style) ===
    // Machine Learning is narrower than Artificial Intelligence
    // (we'll create the actual instances in the demo)

    // === Equivalence ===
    // sameAs is for exact identity (usually external IRIs)
    // equivalentTo is for semantic equivalence

    // === Disjoint Constraints ===
    // A Paper cannot be an Author (and vice versa)
    disjointWith(Paper, Author),
    disjointWith(Paper, Institution),
    disjointWith(Author, Institution),

    // === Composition ===
    // Institutions have Departments as parts
    hasPart(Institution, Department),
    partOf(Department, Institution),

    // === Edge Relationships ===
    // cites and citedBy are inverses
    inverseOf(cites, citedBy),

    // authorOf implies the author is related to the paper's topics
    // (if you authored a paper about X, you're related to X)
    implies(authorOf, about),

    // === Association ===
    // Topics can be related to each other
    relatedTo(Topic, Topic),

    // Custom ontology relationships would go here
    // prerequisiteOf(TopicA, TopicB),
    // supersedes(PaperV2, PaperV1),
  ],
});

// ============================================================
// Part 4: Demonstrate the Rich Domain Model
// ============================================================

export async function main() {
  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  console.log("=== Custom Ontology Examples ===\n");

  // Create some institutions
  const mit = await store.nodes.Institution.create({
    name: "Massachusetts Institute of Technology",
    country: "USA",
    rorId: "https://ror.org/042nb2s44",
  });

  const stanford = await store.nodes.Institution.create({
    name: "Stanford University",
    country: "USA",
    rorId: "https://ror.org/00f54p054",
  });

  console.log("Created institutions: MIT, Stanford");

  // Create research groups
  const mlGroup = await store.nodes.ResearchGroup.create({
    name: "Machine Learning Group",
    focus: "Deep Learning and Neural Networks",
  });

  await store.edges.locatedIn.create(
    { kind: "ResearchGroup", id: mlGroup.id },
    { kind: "Institution", id: mit.id },
    {},
  );

  console.log("Created research group at MIT");

  // Create authors
  const alice = await store.nodes.Author.create({
    name: "Dr. Alice Researcher",
    affiliation: "MIT",
    orcid: "0000-0001-2345-6789",
  });

  await store.edges.affiliatedWith.create(
    { kind: "Author", id: alice.id },
    { kind: "Institution", id: mit.id },
    { since: "2018-09-01" },
  );

  await store.edges.memberOf.create(
    { kind: "Author", id: alice.id },
    { kind: "ResearchGroup", id: mlGroup.id },
    { role: "Principal Investigator" },
  );

  console.log("Created author: Dr. Alice Researcher");

  // Create topics with hierarchy
  const ai = await store.nodes.Topic.create({ name: "Artificial Intelligence", field: "Computer Science" });
  const ml = await store.nodes.Topic.create({ name: "Machine Learning", field: "Computer Science" });
  const dl = await store.nodes.Topic.create({ name: "Deep Learning", field: "Computer Science" });
  const nlp = await store.nodes.Topic.create({ name: "Natural Language Processing", field: "Computer Science" });

  console.log("Created topics: AI, ML, Deep Learning, NLP");

  // Create a paper
  const paper = await store.nodes.Paper.create({
    title: "Attention Is All You Need",
    abstract: "The dominant sequence transduction models...",
    year: 2017,
    doi: "10.5555/3295222.3295349",
  });

  await store.edges.authorOf.create(
    { kind: "Author", id: alice.id },
    { kind: "Paper", id: paper.id },
    { position: 1 },
  );

  await store.edges.about.create(
    { kind: "Paper", id: paper.id },
    { kind: "Topic", id: dl.id },
    {},
  );

  await store.edges.about.create(
    { kind: "Paper", id: paper.id },
    { kind: "Topic", id: nlp.id },
    {},
  );

  console.log("Created paper: 'Attention Is All You Need'\n");

  // ============================================================
  // Demonstrate Registry Capabilities
  // ============================================================

  console.log("=== Registry Analysis ===\n");

  const registry = store.registry;

  // Check disjointness
  console.log("Disjoint checks:");
  console.log("  Paper and Author disjoint?", registry.areDisjoint("Paper", "Author"));
  console.log("  Topic and Concept disjoint?", registry.areDisjoint("Topic", "Concept"));

  // Check subsumption
  console.log("\nSubsumption checks:");
  console.log("  Topic subClassOf Concept?", registry.isSubClassOf("Topic", "Concept"));

  // Check edge inverses
  console.log("\nEdge inverses:");
  console.log("  Inverse of 'cites':", registry.getInverseEdge("cites"));
  console.log("  Inverse of 'citedBy':", registry.getInverseEdge("citedBy"));

  // Check edge implications
  console.log("\nEdge implications:");
  console.log("  'authorOf' implies:", registry.getImpliedEdges("authorOf"));

  // ============================================================
  // Query Examples
  // ============================================================

  console.log("\n=== Query Examples ===\n");

  // Find papers by topic (including implied edges)
  console.log("Query: Papers about Deep Learning");
  const dlPapers = await store
    .query()
    .from("Paper", "p")
    .traverse("about", "a")
    .to("Topic", "t")
    .select((ctx) => ({
      title: ctx.p.title,
      topic: ctx.t.name,
    }))
    .execute();

  for (const row of dlPapers) {
    console.log(`  "${row.title}" is about ${row.topic}`);
  }

  // Find author affiliations
  console.log("\nQuery: Author affiliations");
  const affiliations = await store
    .query()
    .from("Author", "a")
    .traverse("affiliatedWith", "aff")
    .to("Institution", "i")
    .select((ctx) => ({
      author: ctx.a.name,
      institution: ctx.i.name,
    }))
    .execute();

  for (const row of affiliations) {
    console.log(`  ${row.author} at ${row.institution}`);
  }

  // ============================================================
  // Summary of Core Meta-Edges
  // ============================================================

  console.log("\n=== Available Core Meta-Edges ===\n");

  const coreMetaEdges = [
    { name: "subClassOf", use: "Type inheritance (Child subClassOf Parent)" },
    { name: "broader", use: "Broader concept (ML broader AI)" },
    { name: "narrower", use: "Narrower concept (AI narrower ML)" },
    { name: "equivalentTo", use: "Semantic equivalence" },
    { name: "sameAs", use: "Identity (usually external IRIs)" },
    { name: "differentFrom", use: "Explicit non-identity" },
    { name: "disjointWith", use: "Mutually exclusive types" },
    { name: "partOf", use: "Composition (Wheel partOf Car)" },
    { name: "hasPart", use: "Inverse of partOf" },
    { name: "relatedTo", use: "General association" },
    { name: "inverseOf", use: "Edge pairs (manages/managedBy)" },
    { name: "implies", use: "Edge entailment (loves implies knows)" },
  ];

  for (const { name, use } of coreMetaEdges) {
    console.log(`  ${name.padEnd(15)} - ${use}`);
  }

  console.log("\n=== Custom Ontology example complete ===");

  await backend.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
