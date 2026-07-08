/**
 * Example 08: Advanced Ontology and Custom Meta-Edges
 *
 * This example builds a research knowledge graph and demonstrates:
 * - The core meta-edges working together: subClassOf, broader/narrower,
 *   equivalentTo (with an external IRI), disjointWith, partOf, inverseOf,
 *   and implies — each with an observable registry or query effect.
 * - Custom meta-edges (`metaEdge(...)`) registered in `ontology: []`:
 *   what the library does with them (persists, introspects, serializes)
 *   and what it deliberately does not (no built-in inference — the
 *   KindRegistry computes closures only for the core meta-edges, so
 *   custom semantics are interpreted by your application, as shown here).
 * - Ontology relations are TYPE-level (between kinds), never instance-level.
 *   That is why research fields are modeled as node kinds below: a SKOS
 *   statement like "DeepLearning narrower-than ArtificialIntelligence"
 *   must relate kinds, not two rows in a Topic table.
 *
 * Run with:
 *   npx tsx examples/08-custom-ontology.ts
 */
import {
  broader,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  equivalentTo,
  implies,
  inverseOf,
  type MetaEdge,
  metaEdge,
  narrower,
  type NodeType,
  type OntologyRelation,
  partOf,
  relatedTo,
  subClassOf,
} from "@nicia-ai/typegraph";
import { z } from "zod";

import { createExampleBackend } from "./_helpers";

// ============================================================
// Named Constants
// ============================================================

const SCHEMA_ORG_PERSON_IRI = "https://schema.org/Person";
const DEEP_LEARNING_NAME = "Deep Learning";
const ATTENTION_PAPER_TITLE = "Attention Is All You Need";
const SEQ2SEQ_PAPER_TITLE = "Sequence to Sequence Learning with Neural Networks";

// ============================================================
// Part 1: Node and Edge Kinds
// ============================================================

// Research fields as node KINDS, arranged both in an is-a hierarchy
// (every field is a Topic) and a SKOS concept hierarchy (AI ⊃ ML ⊃ DL).
const TOPIC_SCHEMA = z.object({ name: z.string() });

const Topic = defineNode("Topic", { schema: TOPIC_SCHEMA });
const ArtificialIntelligence = defineNode("ArtificialIntelligence", {
  schema: TOPIC_SCHEMA,
});
const MachineLearning = defineNode("MachineLearning", { schema: TOPIC_SCHEMA });
const DeepLearning = defineNode("DeepLearning", { schema: TOPIC_SCHEMA });
const NaturalLanguageProcessing = defineNode("NaturalLanguageProcessing", {
  schema: TOPIC_SCHEMA,
});

// Publications: Paper and Preprint are both kinds of Publication.
const PUBLICATION_SCHEMA = z.object({
  title: z.string(),
  year: z.number().int(),
});

const Publication = defineNode("Publication", { schema: PUBLICATION_SCHEMA });
const Paper = defineNode("Paper", {
  schema: PUBLICATION_SCHEMA.extend({ doi: z.string().optional() }),
});
const Preprint = defineNode("Preprint", {
  schema: PUBLICATION_SCHEMA.extend({ server: z.string().optional() }),
});

const Author = defineNode("Author", {
  schema: z.object({
    name: z.string(),
    orcid: z.string().optional(),
  }),
});

const Institution = defineNode("Institution", {
  schema: z.object({
    name: z.string(),
    country: z.string(),
  }),
});

const Department = defineNode("Department", {
  schema: z.object({ name: z.string() }),
});

// Instance-level relationships. Runtime endpoint validation is
// subclass-aware, so `to: [Publication]` alone would accept Paper and
// Preprint nodes — but the compile-time endpoint types are exact, so we
// also list the concrete kinds to keep direct node-handle creation
// (`create(alice, somePaper)`) type-safe. Same pattern as example 03.
const authorOf = defineEdge("authorOf", {
  schema: z.object({ position: z.number().int().optional() }),
});

const cites = defineEdge("cites", { schema: z.object({}) });
const citedBy = defineEdge("citedBy", { schema: z.object({}) });
const buildsOn = defineEdge("buildsOn", { schema: z.object({}) });
const about = defineEdge("about", { schema: z.object({}) });

const affiliatedWith = defineEdge("affiliatedWith", {
  schema: z.object({ since: z.string().optional() }),
});

const belongsTo = defineEdge("belongsTo", { schema: z.object({}) });

// ============================================================
// Part 2: Custom Meta-Edges
// ============================================================

// A custom meta-edge is a TYPE-level vocabulary term. The library stores
// its relations in the graph definition, exposes them through
// `store.introspect().ontology`, and serializes them with the schema —
// but the built-in KindRegistry computes closures ONLY for the core
// meta-edges. Custom semantics (like the transitive walk below) are
// interpreted by your application.

// Learning prerequisite between topic kinds:
// "you should know the from-kind before studying the to-kind".
const prerequisiteOfMetaEdge = metaEdge("prerequisiteOf", {
  transitive: true, // AI prereq ML, ML prereq DL => AI prereq DL
  inference: "hierarchy",
  description: "Learning prerequisite between research-field kinds",
});

// Replacement between publication kinds:
// "the from-kind is the authoritative successor of the to-kind".
const supersedesMetaEdge = metaEdge("supersedes", {
  inference: "substitution",
  description: "The from-kind is the authoritative successor of the to-kind",
});

// Factory functions in the same style as the core `subClassOf`, `broader`, ...
function prerequisiteOf(
  prerequisite: NodeType,
  dependent: NodeType,
): OntologyRelation {
  return { metaEdge: prerequisiteOfMetaEdge, from: prerequisite, to: dependent };
}

function supersedes(
  newerKind: NodeType,
  olderKind: NodeType,
): OntologyRelation {
  return { metaEdge: supersedesMetaEdge, from: newerKind, to: olderKind };
}

// ============================================================
// Part 3: The Graph and Its Ontology
// ============================================================

const graph = defineGraph({
  id: "research_kg",
  nodes: {
    Topic: { type: Topic },
    ArtificialIntelligence: { type: ArtificialIntelligence },
    MachineLearning: { type: MachineLearning },
    DeepLearning: { type: DeepLearning },
    NaturalLanguageProcessing: { type: NaturalLanguageProcessing },
    Publication: { type: Publication },
    Paper: { type: Paper },
    Preprint: { type: Preprint },
    Author: { type: Author },
    Institution: { type: Institution },
    Department: { type: Department },
  },
  edges: {
    authorOf: {
      type: authorOf,
      from: [Author],
      to: [Publication, Paper, Preprint],
    },
    cites: {
      type: cites,
      from: [Publication, Paper, Preprint],
      to: [Publication, Paper, Preprint],
    },
    citedBy: {
      type: citedBy,
      from: [Publication, Paper, Preprint],
      to: [Publication, Paper, Preprint],
    },
    buildsOn: {
      type: buildsOn,
      from: [Publication, Paper, Preprint],
      to: [Publication, Paper, Preprint],
    },
    about: {
      type: about,
      from: [Publication, Paper, Preprint],
      to: [
        Topic,
        ArtificialIntelligence,
        MachineLearning,
        DeepLearning,
        NaturalLanguageProcessing,
      ],
    },
    affiliatedWith: { type: affiliatedWith, from: [Author], to: [Institution] },
    belongsTo: { type: belongsTo, from: [Department], to: [Institution] },
  },
  ontology: [
    // === Subsumption (is-a) ===
    subClassOf(Paper, Publication),
    subClassOf(Preprint, Publication),
    subClassOf(ArtificialIntelligence, Topic),
    subClassOf(MachineLearning, Topic),
    subClassOf(DeepLearning, Topic),
    subClassOf(NaturalLanguageProcessing, Topic),

    // === SKOS-style concept hierarchy (independent of is-a) ===
    // "Machine Learning is narrower than Artificial Intelligence" — and
    // narrower/broader are inverses, so one statement per pair suffices.
    broader(MachineLearning, ArtificialIntelligence),
    narrower(MachineLearning, DeepLearning),
    relatedTo(NaturalLanguageProcessing, MachineLearning),

    // === Equivalence with an external IRI ===
    equivalentTo(Author, SCHEMA_ORG_PERSON_IRI),

    // === Disjointness constraints ===
    disjointWith(Paper, Author),
    disjointWith(Author, Institution),

    // === Composition (part-of) ===
    // A Department is PART OF an Institution (part-whole), not a kind of
    // Institution — `subClassOf(Department, Institution)` would wrongly
    // claim every Department IS an Institution. Model is-a with
    // subClassOf and part-of with partOf; hasPart is derived as its inverse.
    partOf(Department, Institution),

    // === Edge semantics ===
    inverseOf(cites, citedBy),
    // Both edges are Publication -> Publication, so the implication is
    // endpoint-compatible. The library rejects implications between edges
    // with mismatched endpoints (say, Author->Paper implies Paper->Topic)
    // with a ConfigurationError — wherever the graph is built into a store
    // or committed as a schema version — since `expand: "implying"` would
    // otherwise traverse the mismatched edges.
    implies(buildsOn, cites),

    // === Custom meta-edge relations ===
    prerequisiteOf(ArtificialIntelligence, MachineLearning),
    prerequisiteOf(MachineLearning, DeepLearning),
    supersedes(Paper, Preprint),
  ],
});

// ============================================================
// Part 4: Application-Level Inference over Custom Meta-Edges
// ============================================================

function endpointKindName(endpoint: OntologyRelation["from"]): string {
  return typeof endpoint === "string" ? endpoint : endpoint.kind;
}

/**
 * Answers "does `fromKind` relate to `toKind` via this custom meta-edge?"
 * by reading the graph's own ontology relations. Honors the meta-edge's
 * declared `transitive` property with a breadth-first walk — this is the
 * pattern for giving custom meta-edges real semantics in your application.
 */
function relatesVia(
  ontology: readonly OntologyRelation[],
  customMetaEdge: MetaEdge,
  fromKind: string,
  toKind: string,
): boolean {
  const directPairs = ontology
    .filter((relation) => relation.metaEdge.name === customMetaEdge.name)
    .map(
      (relation) =>
        [endpointKindName(relation.from), endpointKindName(relation.to)] as const,
    );

  if (!customMetaEdge.properties.transitive) {
    return directPairs.some(([from, to]) => from === fromKind && to === toKind);
  }

  const visited = new Set<string>([fromKind]);
  const queue = [fromKind];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const [from, to] of directPairs) {
      if (from !== current || visited.has(to)) continue;
      if (to === toKind) return true;
      visited.add(to);
      queue.push(to);
    }
  }
  return false;
}

// ============================================================
// Part 5: Demonstration
// ============================================================

function assertClaim(claim: string, actual: boolean): void {
  if (!actual) throw new Error(`Claim failed: ${claim}`);
  console.log(`  [ok] ${claim}`);
}

export async function main() {
  const backend = createExampleBackend();
  try {
    const store = createStore(graph, backend);
    const registry = store.registry;

    console.log("=== Advanced Ontology and Custom Meta-Edges ===\n");

    // --- Instance data ---------------------------------------------

    const mit = await store.nodes.Institution.create({
      name: "Massachusetts Institute of Technology",
      country: "USA",
    });
    const csail = await store.nodes.Department.create({ name: "CSAIL" });
    await store.edges.belongsTo.create(csail, mit);

    const alice = await store.nodes.Author.create({
      name: "Dr. Alice Researcher",
      orcid: "0000-0001-2345-6789",
    });
    await store.edges.affiliatedWith.create(alice, mit, {
      since: "2018-09-01",
    });

    const ml = await store.nodes.MachineLearning.create({
      name: "Machine Learning",
    });
    const dl = await store.nodes.DeepLearning.create({
      name: DEEP_LEARNING_NAME,
    });
    const nlp = await store.nodes.NaturalLanguageProcessing.create({
      name: "Natural Language Processing",
    });

    const seq2seq = await store.nodes.Paper.create({
      title: SEQ2SEQ_PAPER_TITLE,
      year: 2014,
    });
    const attentionPreprint = await store.nodes.Preprint.create({
      title: `${ATTENTION_PAPER_TITLE} (preprint)`,
      year: 2017,
      server: "arXiv",
    });
    const attentionPaper = await store.nodes.Paper.create({
      title: ATTENTION_PAPER_TITLE,
      year: 2017,
      doi: "10.5555/3295222.3295349",
    });

    await store.edges.authorOf.create(alice, attentionPaper, { position: 1 });
    await store.edges.authorOf.create(alice, attentionPreprint, {
      position: 1,
    });

    await store.edges.about.create(attentionPaper, dl);
    await store.edges.about.create(attentionPaper, nlp);
    await store.edges.about.create(seq2seq, ml);

    // The published paper only records buildsOn; `implies(buildsOn, cites)`
    // lets queries surface it as a citation. The preprint cites explicitly.
    await store.edges.buildsOn.create(attentionPaper, seq2seq);
    await store.edges.cites.create(attentionPreprint, seq2seq);

    console.log("Created 1 institution, 1 department, 1 author,");
    console.log("3 research-field nodes, and 3 publications.\n");

    // --- Registry: core meta-edge reasoning ------------------------

    console.log("=== Registry: Core Meta-Edge Reasoning ===\n");

    console.log("Subsumption (subClassOf):");
    console.log(
      "  Publication expands to:",
      registry.expandSubClasses("Publication").join(", "),
    );

    console.log("\nSKOS hierarchy (broader/narrower, transitive):");
    console.log(
      "  DeepLearning narrower than ArtificialIntelligence?",
      registry.isNarrowerThan("DeepLearning", "ArtificialIntelligence"),
    );
    const aiOrNarrower = registry.expandNarrower("ArtificialIntelligence");
    console.log(
      "  ArtificialIntelligence and narrower:",
      aiOrNarrower.join(", "),
    );

    console.log("\nEquivalence (external IRI):");
    console.log(
      `  ${SCHEMA_ORG_PERSON_IRI} resolves to:`,
      registry.resolveIri(SCHEMA_ORG_PERSON_IRI),
    );

    console.log("\nDisjointness:");
    console.log(
      "  Paper and Author disjoint?",
      registry.areDisjoint("Paper", "Author"),
    );

    console.log("\nComposition (partOf; hasPart derived as inverse):");
    console.log(
      "  Department part of Institution?",
      registry.isPartOf("Department", "Institution"),
    );
    console.log(
      "  Parts of Institution:",
      registry.getParts("Institution").join(", "),
    );

    console.log("\nEdge semantics:");
    console.log("  Inverse of 'cites':", registry.getInverseEdge("cites"));
    console.log(
      "  'buildsOn' implies:",
      registry.getImpliedEdges("buildsOn").join(", "),
    );

    // --- Queries shaped by the ontology -----------------------------

    console.log("\n=== Queries Shaped by the Ontology ===\n");

    // Subsumption expansion: one query over the whole publication hierarchy.
    console.log("All publications (from 'Publication', includeSubClasses):");
    const publications = await store
      .query()
      .from("Publication", "pub", { includeSubClasses: true })
      .select((ctx) => ({ title: ctx.pub.title, kind: ctx.pub.kind }))
      .execute();
    for (const row of publications) {
      console.log(`  [${row.kind}] "${String(row.title)}"`);
    }

    // Bound topic filter: only papers tagged with the Deep Learning field.
    // `includeSubClasses` widens the target alias to the base kind, so we
    // bind on `kind` (always statically typed) rather than a schema field.
    console.log(`\nPapers about ${DEEP_LEARNING_NAME}:`);
    const dlPapers = await store
      .query()
      .from("Paper", "p")
      .traverse("about", "a")
      .to("Topic", "t", { includeSubClasses: true })
      .whereNode("t", (topic) => topic.kind.eq(DeepLearning.kind))
      .select((ctx) => ({ title: ctx.p.title, topic: ctx.t.name }))
      .execute();
    for (const row of dlPapers) {
      console.log(`  "${row.title}" is about ${String(row.topic)}`);
    }

    // SKOS closure feeding a query: publications about AI or any narrower
    // field, without tagging anything "Artificial Intelligence" directly.
    console.log("\nPublications about AI or any narrower field:");
    const aiPublications = await store
      .query()
      .from("Publication", "pub", { includeSubClasses: true })
      .traverse("about", "a")
      .to("Topic", "t", { includeSubClasses: true })
      .whereNode("t", (topic) => topic.kind.in([...aiOrNarrower]))
      .select((ctx) => ({ title: ctx.pub.title, field: ctx.t.name }))
      .execute();
    for (const row of aiPublications) {
      console.log(`  "${String(row.title)}" (via ${String(row.field)})`);
    }

    // Implication expansion: the published paper has NO explicit cites edge,
    // only buildsOn — `expand: "implying"` surfaces it as a citation.
    console.log(`\nWhat does "${ATTENTION_PAPER_TITLE}" cite?`);
    const explicitCites = await store
      .query()
      .from("Paper", "p")
      .whereNode("p", ({ title }) => title.eq(ATTENTION_PAPER_TITLE))
      .traverse("cites", "c", { expand: "none" })
      .to("Publication", "cited", { includeSubClasses: true })
      .select((ctx) => ({ title: ctx.cited.title }))
      .execute();
    console.log(`  Explicit cites edges: ${explicitCites.length}`);
    const impliedCites = await store
      .query()
      .from("Paper", "p")
      .whereNode("p", ({ title }) => title.eq(ATTENTION_PAPER_TITLE))
      .traverse("cites", "c", { expand: "implying" })
      .to("Publication", "cited", { includeSubClasses: true })
      .select((ctx) => ({ title: ctx.cited.title }))
      .execute();
    for (const row of impliedCites) {
      console.log(`  With expand "implying": cites "${String(row.title)}" (via buildsOn)`);
    }

    // Inverse + implication combined: nothing ever wrote a citedBy edge,
    // yet the inverse of cites (and the buildsOn implication) answers it.
    console.log(`\nWho cites "${SEQ2SEQ_PAPER_TITLE}"?`);
    const citingPublications = await store
      .query()
      .from("Paper", "s")
      .whereNode("s", ({ title }) => title.eq(SEQ2SEQ_PAPER_TITLE))
      .traverse("citedBy", "cb", { expand: "all" })
      .to("Publication", "citing", { includeSubClasses: true })
      .select((ctx) => ({ title: ctx.citing.title }))
      .execute();
    for (const row of citingPublications) {
      console.log(`  Cited by "${String(row.title)}"`);
    }

    // --- Custom meta-edges in practice ------------------------------

    console.log("\n=== Custom Meta-Edges in Practice ===\n");

    console.log("Custom relations visible via store.introspect().ontology:");
    const customRelations = store
      .introspect()
      .ontology.filter(
        (relation) =>
          relation.metaEdge === prerequisiteOfMetaEdge.name ||
          relation.metaEdge === supersedesMetaEdge.name,
      );
    for (const relation of customRelations) {
      console.log(
        `  ${relation.from} --${relation.metaEdge}--> ${relation.to}` +
          ` (origin: ${relation.origin})`,
      );
    }

    console.log("\nMeta-edge properties travel with the definition:");
    console.log(
      `  prerequisiteOf: transitive=${prerequisiteOfMetaEdge.properties.transitive},` +
        ` inference=${prerequisiteOfMetaEdge.properties.inference}`,
    );
    console.log(
      `  supersedes: transitive=${supersedesMetaEdge.properties.transitive},` +
        ` inference=${supersedesMetaEdge.properties.inference}`,
    );

    console.log(
      "\nApplication-level inference (the registry only reasons over core" +
        "\nmeta-edges, so we walk the declared relations ourselves):",
    );
    console.log(
      "  ArtificialIntelligence prerequisiteOf DeepLearning (transitive)?",
      relatesVia(
        graph.ontology,
        prerequisiteOfMetaEdge,
        "ArtificialIntelligence",
        "DeepLearning",
      ),
    );
    console.log(
      "  Paper supersedes Preprint?",
      relatesVia(graph.ontology, supersedesMetaEdge, "Paper", "Preprint"),
    );

    // --- Verified summary -------------------------------------------

    console.log("\n=== Verified Summary ===\n");

    assertClaim(
      "subClassOf: Paper and Preprint are Publications",
      registry.isSubClassOf("Paper", "Publication") &&
        registry.isSubClassOf("Preprint", "Publication"),
    );
    assertClaim(
      "broader/narrower: DeepLearning is (transitively) narrower than ArtificialIntelligence",
      registry.isNarrowerThan("DeepLearning", "ArtificialIntelligence"),
    );
    assertClaim(
      "equivalentTo: schema.org/Person resolves to Author",
      registry.resolveIri(SCHEMA_ORG_PERSON_IRI) === "Author",
    );
    assertClaim(
      "disjointWith: Paper and Author are disjoint",
      registry.areDisjoint("Paper", "Author"),
    );
    assertClaim(
      "partOf: Department is part of Institution (hasPart derived)",
      registry.isPartOf("Department", "Institution") &&
        registry.getParts("Institution").includes("Department"),
    );
    assertClaim(
      "inverseOf: cites <-> citedBy",
      registry.getInverseEdge("cites") === "citedBy" &&
        registry.getInverseEdge("citedBy") === "cites",
    );
    assertClaim(
      "implies: buildsOn implies cites",
      registry.getImpliedEdges("buildsOn").includes("cites"),
    );
    assertClaim(
      "subsumption query returned all 3 publications",
      publications.length === 3,
    );
    assertClaim(
      `topic-bound query returned exactly the ${DEEP_LEARNING_NAME} paper`,
      dlPapers.length === 1 && dlPapers[0]?.title === ATTENTION_PAPER_TITLE,
    );
    assertClaim(
      "SKOS-driven query found both ML- and DL-tagged publications",
      aiPublications.length === 2,
    );
    assertClaim(
      "implication query surfaced the buildsOn edge as a citation",
      explicitCites.length === 0 && impliedCites.length === 1,
    );
    assertClaim(
      "inverse+implying query found both citing publications",
      citingPublications.length === 2,
    );
    assertClaim(
      "custom meta-edge relations are introspectable",
      customRelations.length === 3,
    );
    assertClaim(
      "custom transitive inference: AI is a prerequisite of DL",
      relatesVia(
        graph.ontology,
        prerequisiteOfMetaEdge,
        "ArtificialIntelligence",
        "DeepLearning",
      ),
    );
    assertClaim(
      "custom non-transitive inference: Paper supersedes Preprint",
      relatesVia(graph.ontology, supersedesMetaEdge, "Paper", "Preprint"),
    );

    console.log("\n=== Custom Ontology example complete ===");
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
