/**
 * Example 19: Incremental Graph Merge
 *
 * Ingest into a LIVE graph in waves. Unlike the snapshot `merge()` (example 18),
 * `mergeIncremental()` folds a new source's branch into a `target` that already
 * holds committed entities: it re-discovers an already-committed company (by its
 * unique `domain`) and merges the new spelling ONTO it instead of creating a
 * duplicate, commits the genuinely-new company, carries the branch's inherited
 * edit against the fork-point into the merge (flagging it where the live target
 * has advanced past the fork), and persists a queryable provenance trail.
 *
 * Run with:
 *   npx tsx examples/19-incremental-merge.ts
 */
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type GraphBackend,
  searchable,
  type Store,
} from "@nicia-ai/typegraph";
import {
  asBranchId,
  branch,
  isOk,
  mergeIncremental,
  type MergeIncrementalArgs,
  openProvenanceStore,
  readProvenance,
  unwrap,
} from "@nicia-ai/typegraph/graph-merge";
import { z } from "zod";

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

const PROVIDER = asBranchId("provider-crunchbase");

function compareStrings(left: string, right: string): number {
  return (
    left < right ? -1
    : left > right ? 1
    : 0
  );
}

async function listCompanies(store: KbStore): Promise<readonly string[]> {
  const companies = await store.nodes.Company.find();
  return companies
    .map((company) => `${company.name} (${company.domain})`)
    .toSorted((left, right) => compareStrings(left, right));
}

async function main(): Promise<void> {
  // Every backend this example opens — directly or through `branch()`'s factory —
  // is tracked here and closed in the finally below.
  const openedBackends: GraphBackend[] = [];
  function makeBackend(): Promise<GraphBackend> {
    const backend = createExampleBackend();
    openedBackends.push(backend);
    return Promise.resolve(backend);
  }

  try {
    // The LIVE target graph, already holding committed companies from earlier
    // ingestion waves. This is the "base that has advanced" mergeIncremental
    // targets: Initech was renamed ON THE TARGET after the fork-point snapshot
    // below was frozen.
    const [target] = await createStoreWithSchema(kbGraph, await makeBackend());
    await target.nodes.Company.create(
      { name: "Acme Corp", domain: "acme.com" },
      { id: "acme" },
    );
    await target.nodes.Company.create(
      { name: "Initech Software", domain: "initech.com" },
      { id: "initech" },
    );

    // The frozen fork-point the provider's branch forks from. It carries Initech
    // as it looked AT FORK TIME — before the target's rename — so the provider's
    // edit to its inherited copy is a genuine inherited edit against the
    // fork-point that collides with the target's own committed rename.
    const [forkPoint] = await createStoreWithSchema(
      kbGraph,
      await makeBackend(),
    );
    const initechAtFork = await forkPoint.nodes.Company.create(
      { name: "Initech", domain: "initech.com" },
      { id: "initech" },
    );
    const provider = unwrap(
      await branch(forkPoint, makeBackend, { id: PROVIDER }),
    );

    // The provider re-reports Acme (same domain, different spelling), adds a
    // genuinely new company, and RENAMES its inherited fork-point copy of
    // Initech — an inherited edit the live target disagrees with.
    await provider.store.nodes.Company.create(
      { name: "ACME Corporation", domain: "acme.com" },
      { id: "cb-acme" },
    );
    await provider.store.nodes.Company.create(
      { name: "Globex", domain: "globex.io" },
      { id: "cb-globex" },
    );
    await provider.store.nodes.Company.update(initechAtFork.id, {
      name: "Initech Inc",
    });

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
        // Optional — "flag" is already the default (MERGE_OPTION_DEFAULTS), and the
        // ONLY value mergeIncremental() accepts. Spelled out to document the
        // deliberate keep-base policy: committed target values always survive.
        onBasePropertyConflict: "flag",
        branchOrder: [PROVIDER],
        persistProvenance: true,
      },
    };

    const result = await mergeIncremental(args);
    if (!isOk(result)) {
      throw result.error;
    }
    const report = result.data;

    console.log("Target after:", await listCompanies(target));
    console.log(
      `\nNo duplicate was created: the provider's "ACME Corporation" merged onto`,
    );
    console.log(
      `the committed "Acme Corp" via the shared domain, and the provider's rename`,
    );
    console.log(
      `of inherited Initech was flagged against the target's own rename — the`,
    );
    console.log(`committed value survived both disagreements.\n`);
    console.log(`Merged nodes: ${report.merged.nodes}`);
    console.log(`Entity resolutions: ${report.resolutions.length}`);
    if (report.conflicts.length === 0) {
      console.log("Conflicts: none");
    } else {
      // A conflict on a cluster canonical is a NEW entity matched onto a committed
      // row; any other conflicted id is an inherited fork-point row that BOTH the
      // branch and the live target edited. Either way keep-base means the committed
      // value survives (printed as "kept"); the branch's value is the "incoming".
      const clusterCanonicalIds = new Set<string>(
        report.resolutions.map((resolution) => resolution.canonicalId),
      );
      console.log("Conflicts:");
      for (const conflict of report.conflicts) {
        const incoming = conflict.values
          .map((value) => `${value.branchId}=${JSON.stringify(value.value)}`)
          .join(", ");
        const origin =
          clusterCanonicalIds.has(conflict.entityId) ? "new-entity match" : (
            "inherited edit"
          );
        console.log(
          `  - [${origin}] ${conflict.kind}.${conflict.property} @ ${conflict.entityId}: kept ${JSON.stringify(conflict.resolution)}, incoming ${incoming}`,
        );
      }
    }
    if (report.provenancePersisted !== undefined) {
      console.log(
        `\nProvenance persisted: ${report.provenancePersisted.count} row(s) in sidecar "${report.provenancePersisted.graphId}"`,
      );
    }

    // Query the DURABLE provenance back later: "what did this provider
    // contribute?" The sidecar store SHARES the target's backend, so it must not
    // be closed separately — it goes away when the target's backend closes below.
    const provenanceStore = await openProvenanceStore(
      target.backend,
      target.graphId,
    );
    const contributed = await readProvenance(provenanceStore, {
      branchId: PROVIDER,
    });
    const companyNameById = new Map<string, string>();
    for (const company of await target.nodes.Company.find()) {
      companyNameById.set(company.id, company.name);
    }
    console.log(
      "\nProvenance — canonical entities this provider contributed to:",
    );
    for (const node of contributed) {
      const display = companyNameById.get(node.canonicalId) ?? node.canonicalId;
      console.log(
        `  - ${node.canonicalKind} "${display}" (canonical id "${node.canonicalId}", from source "${node.sourceId}")`,
      );
    }
  } finally {
    await Promise.all(openedBackends.map((backend) => backend.close()));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
