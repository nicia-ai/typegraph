/**
 * Example 16: Runtime Graph Extensions (agent-driven schema induction)
 *
 * This example demonstrates the runtime-extension feature added in
 * #101. The motivating use case: an agent (LLM, scraper, ETL pipeline)
 * proposes a new graph kind at runtime, an operator approves it, and
 * the live database starts ingesting under the new kind — no code
 * change, no restart, full Zod validation, fulltext / embedding /
 * unique-constraint enforcement.
 *
 * The flow demonstrated below:
 *
 * 1. Boot a graph with a single compile-time kind (Document).
 * 2. An "agent" proposes a Paper kind via a runtime extension document.
 * 3. Operator approves; `store.evolve(extension)` atomically commits
 *    the new schema version and returns a new Store carrying the kind.
 * 4. Materialize indexes for the new kind via `materializeIndexes()`
 *    (or use the `eager: true` shortcut on `evolve()`).
 * 5. Ingest data using the dynamic-collection escape hatch
 *    (`store.getNodeCollection("Paper")`) — the type system doesn't
 *    see runtime kinds, so the dynamic accessor is the operator path.
 * 6. Soft-deprecate the legacy Document kind via `deprecateKinds`.
 * 7. Restart parity: a fresh Store reading the same database sees
 *    everything — runtime kind, deprecation flag, materialized indexes.
 */
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  defineRuntimeExtension,
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
  // Use one shared SQLite database for the whole example so that the
  // restart-parity step (Step 7) can verify durability against a fresh
  // store backed by the same db.
  const { backend, db } = createLocalSqliteBackend();

  const [store] = await createStoreWithSchema(baseGraph, backend);
  console.log("\n[1] Booted with compile-time kind: Document");
  console.log("    Active schema version:", await activeVersion(backend));

  // Materialize the compile-time index so it's in place before we
  // start ingesting. Idempotent — safe to call multiple times.
  await store.materializeIndexes();
  console.log("    Materialized 1 compile-time index");

  // ============================================================
  // Step 2: Agent proposes a runtime extension
  // ============================================================

  // The "agent" returns a structured proposal — a TypeGraph-native
  // value, not arbitrary code. Operator can inspect, version-control,
  // and approve before applying.
  const agentProposal = defineRuntimeExtension({
    nodes: {
      Paper: {
        description: "An academic paper inferred from the corpus",
        properties: {
          title: { type: "string", minLength: 1 },
          doi: { type: "string", minLength: 1 },
          year: { type: "number", int: true, min: 1900, max: 2100 },
        },
        unique: [{ name: "paper_doi_unique", fields: ["doi"] }],
      },
    },
  });
  console.log("\n[2] Agent proposed runtime extension: nodes.Paper");

  // ============================================================
  // Step 3: Operator approves; commit atomically
  // ============================================================

  const evolved = await store.evolve(agentProposal);
  console.log("\n[3] evolve() succeeded");
  console.log("    Active schema version:", await activeVersion(backend));
  console.log("    registry.hasNodeType('Paper'):", evolved.registry.hasNodeType("Paper"));

  // ============================================================
  // Step 4: Materialize indexes (or use eager mode)
  // ============================================================

  // Runtime extensions today don't carry indexes (relational indexes
  // come from compile-time `defineGraph({ indexes: [...] })`). Calling
  // materializeIndexes here is a no-op for runtime kinds — included
  // to demonstrate the verb. With eager: true on evolve(), this would
  // run automatically inline.
  const materialization = await evolved.materializeIndexes();
  console.log("\n[4] materializeIndexes() — results:");
  for (const entry of materialization.results) {
    console.log(`    ${entry.indexName}: ${entry.status}`);
  }

  // ============================================================
  // Step 5: Dynamic collection accessor (operator escape hatch)
  // ============================================================

  // The type system does not widen to include runtime kinds — the
  // generic `Store<G>` is fixed at construction. The operator path is
  // `store.getNodeCollection(kindName)`, which returns the same
  // CRUD surface as `store.nodes.X` but typed as
  // `DynamicNodeCollection`.
  const papers = evolved.getNodeCollection("Paper");
  if (papers === undefined) {
    throw new Error("Paper collection not registered — registry/evolve mismatch");
  }

  await papers.create({
    title: "Attention is all you need",
    doi: "10.5555/3295222.3295349",
    year: 2017,
  });
  await papers.create({
    title: "Language models are unsupervised multitask learners",
    doi: "10.5555/3454287.3454804",
    year: 2019,
  });
  console.log("\n[5] Ingested 2 Paper nodes via dynamic collection");

  // Unique-constraint enforcement is live — the runtime kind's `unique`
  // declaration on `doi` is enforced exactly like a compile-time
  // unique constraint.
  const duplicate = await papers
    .create({
      title: "Duplicate doi",
      doi: "10.5555/3295222.3295349", // same as above
      year: 2024,
    })
    .catch((error: unknown) => error);
  console.log("    Duplicate doi rejected:", duplicate instanceof Error);

  // ============================================================
  // Step 6: Soft-deprecate the legacy compile-time kind
  // ============================================================

  const deprecated = await evolved.deprecateKinds(["Document"]);
  console.log("\n[6] Deprecated kinds:", [...deprecated.deprecatedKinds]);
  console.log("    Active schema version:", await activeVersion(backend));

  // Deprecation is a signal, not a gate — reads/writes still work.
  await deprecated.nodes.Document.create({
    title: "Legacy doc",
    body: "Still readable, just flagged",
  });

  // ============================================================
  // Step 7: Restart parity
  // ============================================================

  // A fresh store reading the same database (different process,
  // different deployment, etc.) sees the runtime kind, the persisted
  // deprecation set, and the materialized index status — without
  // re-running evolve / deprecateKinds / materializeIndexes.
  const [restored, validation] = await createStoreWithSchema(baseGraph, backend);
  console.log("\n[7] Restart parity:");
  console.log("    validation.status:", validation.status);
  console.log("    registry.hasNodeType('Paper'):", restored.registry.hasNodeType("Paper"));
  console.log("    deprecatedKinds:", [...restored.deprecatedKinds]);

  const restoredPapers = restored.getNodeCollection("Paper");
  const allPapers = await restoredPapers!.find({});
  console.log(`    Found ${allPapers.length} Paper nodes after restart`);

  await backend.close();
  // Keep `db` referenced so the linter doesn't strip it — it's the
  // shared connection backing both the original and restored stores
  // for the parity demonstration.
  void db;
}

async function activeVersion(backend: ReturnType<typeof createLocalSqliteBackend>["backend"]) {
  const row = await backend.getActiveSchema("research_corpus");
  return row?.version ?? "uninitialized";
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
