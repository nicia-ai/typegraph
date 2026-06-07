/**
 * Example 19: Incremental Graph Merge
 *
 * Ingest into a LIVE graph in waves. Unlike the snapshot `merge()` (example 18),
 * `mergeIncremental()` folds a new source's branch into a `target` that already
 * holds committed entities: it re-discovers an already-committed company (by its
 * unique `domain`) and merges the new spelling ONTO it instead of creating a
 * duplicate, commits the genuinely-new company, handles inherited edits against
 * the fork-point, flags the name disagreement, and persists a queryable
 * provenance trail.
 *
 * Run with:
 *   npx tsx examples/19-incremental-merge.ts
 */
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
  type GraphBackend,
  type Store,
} from "@nicia-ai/typegraph";
import {
  asBranchId,
  branch,
  isOk,
  mergeIncremental,
  openProvenanceStore,
  readProvenance,
  unwrap,
  type MergeIncrementalArgs,
} from "@nicia-ai/typegraph/graph-merge";

import { createExampleBackend } from "./_helpers";

// ============================================================
// A tiny company knowledge base, deduplicated by domain
// ============================================================

const Company = defineNode("Company", {
  schema: z.object({
    name: searchable({ language: "english" }),
    domain: z.string(),
  }),
});

const kbGraph = defineGraph({
  id: "company_kb",
  nodes: {
    Company: {
      type: Company,
      // A shared domain is a DEFINITIONAL identity: the new-vs-base recall uses it
      // to find the already-committed company regardless of name spelling.
      unique: [
        {
          name: "company_domain",
          fields: ["domain"],
          scope: "kind",
          collation: "caseInsensitive",
        },
      ],
    },
  },
  edges: {},
});

type KbGraph = typeof kbGraph;
type KbStore = Store<KbGraph>;

async function makeBackend(): Promise<GraphBackend> {
  return createExampleBackend();
}

const PROVIDER = asBranchId("provider-crunchbase");

async function listCompanies(store: KbStore): Promise<readonly string[]> {
  const companies = await store.nodes.Company.find();
  return companies
    .map((company) => `${company.name} (${company.domain})`)
    .sort((left, right) =>
      left < right ? -1
      : left > right ? 1
      : 0,
    );
}

async function main(): Promise<void> {
  // The LIVE target graph, already holding one canonical company from an earlier
  // ingestion wave. This is the "base that has advanced" mergeIncremental targets.
  const [target] = await createStoreWithSchema(kbGraph, await makeBackend());
  await target.nodes.Company.create(
    { name: "Acme Corp", domain: "acme.com" },
    { id: "acme" },
  );

  // The frozen fork-point a new provider's branch forks from. This example keeps
  // it empty so the provider's company rows are additions, but mergeIncremental()
  // also propagates inherited modifications and deletions relative to this store.
  const [forkPoint] = await createStoreWithSchema(kbGraph, await makeBackend());
  const provider = unwrap(await branch(forkPoint, makeBackend, { id: PROVIDER }));

  // The provider re-reports Acme (same domain, different spelling) and adds a
  // genuinely new company.
  await provider.store.nodes.Company.create(
    { name: "ACME Corporation", domain: "acme.com" },
    { id: "cb-acme" },
  );
  await provider.store.nodes.Company.create(
    { name: "Globex", domain: "globex.io" },
    { id: "cb-globex" },
  );

  console.log("=== Incremental Graph Merge ===\n");
  console.log("Target before:", await listCompanies(target));

  const args: MergeIncrementalArgs<KbGraph> = {
    forkPoint,
    target,
    branches: [provider],
    options: {
      resolve: {
        Company: {
          // `similarity` is required, but the unique `domain` constraint forces the
          // new-vs-base match here regardless of the name-spelling difference.
          similarity: { kind: "fulltext", fields: ["name"] },
          threshold: 0.9,
        },
      },
      onPropertyConflict: "flag",
      onBasePropertyConflict: "flag", // required by mergeIncremental (keep-base)
      branchOrder: [PROVIDER],
      persistProvenance: true,
    },
  };

  const result = await mergeIncremental(args);
  if (!isOk(result)) {
    throw result.error;
  }
  const report = result.data;

  console.log("Target after: ", await listCompanies(target));
  console.log(
    `\nNo duplicate was created: the provider's "ACME Corporation" merged onto the`,
  );
  console.log(`committed "Acme Corp" via the shared domain.\n`);
  console.log(`Merged nodes: ${report.merged.nodes}`);
  console.log(`Entity resolutions: ${report.resolutions.length}`);
  if (report.conflicts.length === 0) {
    console.log("Conflicts: none");
  } else {
    for (const conflict of report.conflicts) {
      const values = conflict.values
        .map((value) => `${value.branchId}=${JSON.stringify(value.value)}`)
        .join(", ");
      console.log(
        `Conflict on ${conflict.kind}.${conflict.property} @ ${conflict.entityId}: ${values}`,
      );
    }
  }
  if (report.provenancePersisted !== undefined) {
    console.log(
      `\nProvenance persisted: ${report.provenancePersisted.count} row(s) in sidecar "${report.provenancePersisted.graphId}"`,
    );
  }

  // Query the DURABLE provenance back later: "what did this provider contribute?"
  const provenanceStore = await openProvenanceStore(
    target.backend,
    target.graphId,
  );
  const contributed = await readProvenance(provenanceStore, {
    branchId: PROVIDER,
  });
  console.log("\nProvenance — canonical entities this provider contributed to:");
  for (const node of contributed) {
    console.log(
      `  - ${node.canonicalKind} "${node.canonicalId}" (from source "${node.sourceId}")`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
