/**
 * Example 16: Graph Extensions (agent-driven schema induction)
 *
 * This example demonstrates the graph-extension feature added in #101.
 * The motivating use case: an agent (LLM, scraper, ETL pipeline)
 * proposes new graph kinds AND edges at runtime, an operator approves
 * them, and the live database starts ingesting under the new schema —
 * no code change, no restart, full Zod validation, fulltext / embedding
 * / unique-constraint / cross-kind edge enforcement.
 *
 * The flow demonstrated below:
 *
 * 1. Boot a graph with a single compile-time kind (Document).
 * 2. An "agent" returns a JSON-shaped proposal. We parse it with
 *    `validateGraphExtension(unknown, { strict: true })` (the Result-
 *    style entry intended for LLM output) — the proposal includes new
 *    nodes, an edge between them, a searchable string, and an index.
 * 3. Operator approves; `store.evolve(extension, { eager: {} })`
 *    atomically commits the schema version AND materializes indexes
 *    inline, returning a new Store carrying the kinds.
 * 4. Ingest data (nodes + edges) via the dynamic-collection escape
 *    hatch and run a fulltext search over an extension kind — the
 *    `searchable` brand on the JSON-side flows through to BM25.
 * 5. A follow-up agent proposes a destructive change (TYPE_CHANGE on a
 *    populated kind). `evolve()` rejects with `IncompatibleChangeError`
 *    so a misbehaving agent can't corrupt the database.
 * 6. Soft-deprecate the legacy compile-time kind (Document) — a signal
 *    for codegen / UI tooling, not a gate on reads or writes.
 * 7. Remove an extension kind with `removeKinds(["Author"], { eager: {} })`.
 *    The schema commit drops the kind and any edges that depended on
 *    it; eager mode also runs the data-cleanup phase inline.
 * 8. Restart parity: a fresh Store reading the same database sees
 *    every approved kind, the deprecation flag, and materialized
 *    indexes — without re-running any of the verbs above.
 */
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  GraphExtensionValidationError,
  IncompatibleChangeError,
  validateGraphExtension,
  type GraphExtension,
} from "@nicia-ai/typegraph";
import { defineNodeIndex } from "@nicia-ai/typegraph/indexes";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";

// ============================================================
// Step 1: Boot with a compile-time graph
// ============================================================

const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    body: z.string(),
  }),
});

const documentTitle = defineNodeIndex(Document, { fields: ["title"] });

const baseGraph = defineGraph({
  id: "research_corpus",
  nodes: { Document: { type: Document } },
  edges: {},
  indexes: [documentTitle],
});

async function main() {
  const { backend, db } = createLocalSqliteBackend();

  const [store] = await createStoreWithSchema(baseGraph, backend);
  console.log("\n[1] Booted with compile-time kind: Document");
  console.log("    Active schema version:", await activeVersion(backend));

  // Materialize the compile-time index up front. Idempotent.
  await store.materializeIndexes();
  console.log("    Materialized 1 compile-time index");

  // ============================================================
  // Step 2: Agent returns a JSON proposal — validate as `unknown`
  // ============================================================

  // What an agent (LLM, scraper, ETL) actually hands back is a JSON
  // blob, not a typed value. `validateGraphExtension(unknown, { strict })`
  // is the Result-style entry point: it walks the document, collects
  // every issue, and returns a typed `GraphExtension` on success.
  // Strict mode rejects unknown sibling keys so a field typo
  // (`node` instead of `nodes`) fails loudly instead of silently
  // producing an empty extension.
  const agentJson: unknown = JSON.parse(`{
    "nodes": {
      "Paper": {
        "description": "Academic paper inferred from the corpus",
        "properties": {
          "title": { "type": "string", "minLength": 1, "searchable": {} },
          "abstract": { "type": "string", "searchable": {}, "optional": true },
          "doi": { "type": "string", "minLength": 1 },
          "year": { "type": "number", "int": true, "min": 1900, "max": 2100 }
        },
        "unique": [{ "name": "paper_doi_unique", "fields": ["doi"] }]
      },
      "Author": {
        "description": "Paper author",
        "properties": {
          "name": { "type": "string", "minLength": 1, "searchable": {} },
          "affiliation": { "type": "string", "optional": true }
        }
      }
    },
    "edges": {
      "authoredBy": {
        "description": "Paper -> Author authorship",
        "from": ["Paper"],
        "to": ["Author"],
        "properties": {
          "order": { "type": "number", "int": true, "min": 1 }
        }
      }
    },
    "indexes": [
      {
        "entity": "node",
        "kind": "Paper",
        "name": "paper_by_year",
        "fields": ["year"]
      }
    ]
  }`);

  const result = validateGraphExtension(agentJson, { strict: true });
  if (!result.success) {
    // result.error is a GraphExtensionValidationError carrying every
    // issue — path, message, and a stable code (UNKNOWN_DOCUMENT_KEY,
    // INVALID_PROPERTY_REFINEMENT, etc.) suitable for routing to the
    // agent for repair.
    console.error(
      "[2] Agent proposal rejected by validator:",
      result.error.issues,
    );
    throw result.error;
  }
  const extension: GraphExtension = result.data;
  console.log("\n[2] Agent proposal validated:");
  console.log("    nodes:", Object.keys(extension.nodes ?? {}).join(", "));
  console.log("    edges:", Object.keys(extension.edges ?? {}).join(", "));

  // ============================================================
  // Step 3: Operator approves; commit + materialize atomically
  // ============================================================

  // `eager: {}` turns this into a one-call "schema committed AND
  // indexes materialized" verb. The new Store is ready to ingest by
  // the time `evolve` returns.
  const evolved = await store.evolve(extension, { eager: {} });
  console.log("\n[3] evolve() committed and materialized");
  console.log("    Active schema version:", await activeVersion(backend));
  console.log(
    "    registry.hasNodeType('Paper'):",
    evolved.registry.hasNodeType("Paper"),
  );
  console.log(
    "    registry.hasEdgeType('authoredBy'):",
    evolved.registry.hasEdgeType("authoredBy"),
  );

  // ============================================================
  // Step 4: Ingest nodes + edges; fulltext-search over extension kind
  // ============================================================

  // Dynamic accessors return the same CRUD surface as `store.nodes.X`
  // / `store.edges.X`, just typed as the dynamic variants because
  // extension kinds aren't visible to the type system at compile time.
  const papers = evolved.getNodeCollectionOrThrow("Paper");
  const authors = evolved.getNodeCollectionOrThrow("Author");
  const authoredBy = evolved.getEdgeCollectionOrThrow("authoredBy");

  const attention = await papers.create({
    title: "Attention is all you need",
    abstract: "We propose a new simple network architecture, the Transformer.",
    doi: "10.5555/3295222.3295349",
    year: 2017,
  });
  const gpt2 = await papers.create({
    title: "Language models are unsupervised multitask learners",
    abstract: "Larger language models exhibit emergent zero-shot behaviour.",
    doi: "10.5555/3454287.3454804",
    year: 2019,
  });
  const vaswani = await authors.create({
    name: "Ashish Vaswani",
    affiliation: "Google Brain",
  });
  const radford = await authors.create({
    name: "Alec Radford",
    affiliation: "OpenAI",
  });
  await authoredBy.create(attention, vaswani, { order: 1 });
  await authoredBy.create(gpt2, radford, { order: 1 });
  console.log("\n[4] Ingested 2 Paper, 2 Author, 2 authoredBy edges");

  // The `searchable: {}` brand on Paper.title flows through to the
  // backend's fulltext index — extension kinds get the same first-class
  // BM25 search as compile-time kinds.
  const hits = await evolved.search.fulltext("Paper", {
    query: "transformer architecture",
    limit: 3,
  });
  console.log(
    `    fulltext("Paper", "transformer architecture") -> ${hits.length} hit(s)`,
  );
  for (const hit of hits) {
    // Extension kinds aren't visible to the type system, so the hit's
    // `node` carries the generic `Node` shape — schema properties are
    // present at the top level and accessed with a small cast.
    const node = hit.node as unknown as { title: string };
    console.log(`      score=${hit.score.toFixed(2)}  title="${node.title}"`);
  }

  // Unique-constraint enforcement is live for extension kinds too.
  const duplicate = await papers
    .create({
      title: "Duplicate doi",
      doi: "10.5555/3295222.3295349",
      year: 2024,
    })
    .catch((error: unknown) => error);
  console.log("    Duplicate doi rejected:", duplicate instanceof Error);

  // ============================================================
  // Step 5: A follow-up agent proposes an incompatible change
  // ============================================================

  // The agent (or a less-careful caller) returns a re-proposal that
  // narrows `Paper.year` from a number to a string. Against an empty
  // kind this would be allowed; against the rows we just ingested it's
  // a TYPE_CHANGE, which the classifier rejects unconditionally. The
  // safety gate prevents data corruption — bad proposals don't
  // commit.
  const breakingProposal: GraphExtension = {
    ...extension,
    nodes: {
      ...extension.nodes,
      Paper: {
        ...extension.nodes!.Paper!,
        properties: {
          ...extension.nodes!.Paper!.properties,
          year: { type: "string" },
        },
      },
    },
  };
  const rejection = await evolved
    .evolve(breakingProposal)
    .catch((error: unknown) => error);
  if (rejection instanceof IncompatibleChangeError) {
    console.log("\n[5] Incompatible re-proposal rejected:");
    for (const change of rejection.changes) {
      console.log(
        `    ${change.kind}.${change.field ?? "(kind)"}: ${change.type}` +
          (change.detail ? ` (${change.detail})` : ""),
      );
    }
  } else {
    throw new Error("expected IncompatibleChangeError, got " + String(rejection));
  }

  // ============================================================
  // Step 6: Soft-deprecate the legacy compile-time kind
  // ============================================================

  const deprecated = await evolved.deprecateKinds(["Document"]);
  console.log(
    "\n[6] Deprecated kinds:",
    [...deprecated.introspect().deprecatedKinds],
  );
  // Deprecation is a signal, not a gate — reads/writes still work.
  await deprecated.nodes.Document.create({
    title: "Legacy doc",
    body: "Still readable, just flagged",
  });

  // ============================================================
  // Step 7: Remove an extension kind (cascade + eager cleanup)
  // ============================================================

  // After running the experiment, the operator decides Author should
  // live in a different system. `removeKinds(["Author"], { eager: {} })`
  // commits a new schema version that drops Author AND the authoredBy
  // edge (the edge's only `to` endpoint is gone, so it cascades). With
  // `eager: {}` the data-cleanup phase runs inline — Author rows AND
  // authoredBy edges are deleted before the verb returns.
  const trimmed = await deprecated.removeKinds(["Author"], { eager: {} });
  console.log("\n[7] removeKinds(['Author']) — cascading edge cleanup");
  console.log(
    "    registry.hasNodeType('Author'):",
    trimmed.registry.hasNodeType("Author"),
  );
  console.log(
    "    registry.hasEdgeType('authoredBy'):",
    trimmed.registry.hasEdgeType("authoredBy"),
  );
  console.log("    Active schema version:", await activeVersion(backend));

  // ============================================================
  // Step 8: Restart parity
  // ============================================================

  const [restored, validation] = await createStoreWithSchema(baseGraph, backend);
  console.log("\n[8] Restart parity:");
  console.log("    validation.status:", validation.status);
  console.log(
    "    registry.hasNodeType('Paper'):",
    restored.registry.hasNodeType("Paper"),
  );
  console.log(
    "    registry.hasNodeType('Author') (removed in step 7):",
    restored.registry.hasNodeType("Author"),
  );
  console.log(
    "    deprecatedKinds:",
    [...restored.introspect().deprecatedKinds],
  );

  const restoredPapers = restored.getNodeCollectionOrThrow("Paper");
  const allPapers = await restoredPapers.find({});
  console.log(`    Found ${allPapers.length} Paper nodes after restart`);

  await backend.close();
  // Keep `db` referenced so the linter doesn't strip it — it's the
  // shared connection backing both the original and restored stores
  // for the parity demonstration.
  void db;
}

async function activeVersion(
  backend: ReturnType<typeof createLocalSqliteBackend>["backend"],
) {
  const row = await backend.getActiveSchema("research_corpus");
  return row?.version ?? "uninitialized";
}

main().catch((error: unknown) => {
  if (error instanceof GraphExtensionValidationError) {
    console.error("Validation failed:");
    for (const issue of error.issues) {
      console.error(`  ${issue.path || "(root)"} [${issue.code}]: ${issue.message}`);
    }
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
