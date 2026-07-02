/**
 * Example 23: Provenance retraction over derived facts
 *
 * A knowledge graph often stores facts that are not direct observations. They
 * are derived from sources through explicit justification nodes:
 *
 *     Source(s) -> Justification -> Fact
 *
 * If one source is later found bad, the graph should stop believing facts that
 * only depended on that source, while keeping facts with alternate support.
 *
 * `@nicia-ai/typegraph/provenance` does that over normal TypeGraph nodes and
 * edges, with `history: true` preserving what the graph believed before and
 * after the retraction.
 *
 * Run with:
 *   npx tsx examples/23-provenance-retraction.ts
 */
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type Node,
} from "@nicia-ai/typegraph";
import {
  createRetractionCapability,
  type ProvenanceFactRef,
  type RetractionCapability,
  type RetractionReport,
} from "@nicia-ai/typegraph/provenance";

import { createExampleBackend, requireRecordedNow } from "./_helpers";

// ============================================================
// Schema: multiple source kinds, fact kinds, and AND justifications
// ============================================================

const ScannerSource = defineNode("ScannerSource", {
  schema: z.object({
    title: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const VendorSource = defineNode("VendorSource", {
  schema: z.object({
    title: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const Vulnerability = defineNode("Vulnerability", {
  schema: z.object({ cve: z.string(), packageName: z.string() }),
});

const DeployDecision = defineNode("DeployDecision", {
  schema: z.object({ action: z.string() }),
});

const Justification = defineNode("Justification", {
  schema: z.object({ text: z.string() }),
});

const premiseOf = defineEdge("premiseOf", { schema: z.object({}) });
const derives = defineEdge("derives", { schema: z.object({}) });

const graph = defineGraph({
  id: "provenance_retraction_example",
  nodes: {
    ScannerSource: { type: ScannerSource },
    VendorSource: { type: VendorSource },
    Vulnerability: { type: Vulnerability },
    DeployDecision: { type: DeployDecision },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: {
      type: premiseOf,
      from: [ScannerSource, VendorSource, Vulnerability],
      to: [Justification],
    },
    derives: {
      type: derives,
      from: [Justification],
      to: [Vulnerability, DeployDecision],
    },
  },
});

const retractionConfig = {
  source: { kinds: ["ScannerSource", "VendorSource"] },
  justification: { kind: "Justification" },
  fact: { kinds: ["Vulnerability", "DeployDecision"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

type ExampleStore = Awaited<ReturnType<typeof createExampleStore>>;
type ScannerSourceRef = Node<typeof ScannerSource>;
type VendorSourceRef = Node<typeof VendorSource>;
type VulnerabilityRef = Node<typeof Vulnerability>;
type DeployDecisionRef = Node<typeof DeployDecision>;
type JustificationRef = Node<typeof Justification>;
type SourceRef = ScannerSourceRef | VendorSourceRef;
type PremiseRef = SourceRef | VulnerabilityRef;
type FactRef = VulnerabilityRef | DeployDecisionRef;
type SourceKind = "ScannerSource" | "VendorSource";
type FactKind = "Vulnerability" | "DeployDecision";
type JustificationKind = "Justification";

async function createExampleStore() {
  const [store] = await createStoreWithSchema(graph, createExampleBackend(), {
    history: true,
  });
  return store;
}

async function createScannerSource(
  store: ExampleStore,
  id: string,
  title: string,
): Promise<ScannerSourceRef> {
  return store.nodes.ScannerSource.create({ title, retracted: false }, { id });
}

async function createVendorSource(
  store: ExampleStore,
  id: string,
  title: string,
): Promise<VendorSourceRef> {
  return store.nodes.VendorSource.create({ title, retracted: false }, { id });
}

async function createVulnerability(
  store: ExampleStore,
  id: string,
  cve: string,
  packageName: string,
): Promise<VulnerabilityRef> {
  return store.nodes.Vulnerability.create({ cve, packageName }, { id });
}

async function createDeployDecision(
  store: ExampleStore,
  id: string,
  action: string,
): Promise<DeployDecisionRef> {
  return store.nodes.DeployDecision.create({ action }, { id });
}

async function createJustification(
  store: ExampleStore,
  id: string,
  text: string,
  premises: readonly PremiseRef[],
  fact: FactRef,
): Promise<JustificationRef> {
  const justification = await store.nodes.Justification.create(
    { text },
    { id },
  );
  for (const [index, premise] of premises.entries()) {
    await store.edges.premiseOf.create(
      premise,
      justification,
      {},
      {
        id: `${id}-premise-${index + 1}`,
      },
    );
  }
  await store.edges.derives.create(
    justification,
    fact,
    {},
    {
      id: `${id}-derives-${fact.id}`,
    },
  );
  return justification;
}

type ExampleReport = RetractionReport<
  typeof graph,
  FactKind,
  JustificationKind
>;
type ExampleRetractionCapability = RetractionCapability<
  typeof graph,
  SourceKind,
  FactKind,
  JustificationKind
>;

function formatFactRefs(
  facts: readonly ProvenanceFactRef<typeof graph, FactKind>[],
): string {
  if (facts.length === 0) return "(none)";
  return facts
    .map((fact) => fact.id)
    .toSorted((left, right) => left.localeCompare(right))
    .join(", ");
}

function formatSurvivedVia(entries: ExampleReport["survivedVia"]): string {
  if (entries.length === 0) return "(none)";
  return entries
    .map((entry) => {
      const via = entry.via.map((justification) => justification.id);
      return `${entry.fact.id} via ${via.join(" + ")}`;
    })
    .toSorted((left, right) => left.localeCompare(right))
    .join("; ");
}

function formatDecisionAction(decision: DeployDecisionRef | undefined): string {
  return decision === undefined ? "not current" : decision.action;
}

function formatReport(report: ExampleReport): string {
  const died = formatFactRefs(report.died);
  const survived = formatSurvivedVia(report.survivedVia);
  const unaffected = formatFactRefs(report.unaffected);
  return [
    `    died:        ${died}`,
    `    survived:    ${survived}`,
    `    unaffected:  ${unaffected}`,
  ].join("\n");
}

async function printHolding(
  label: string,
  provenance: ExampleRetractionCapability,
): Promise<void> {
  console.log(`${label}: ${formatFactRefs(await provenance.holding())}`);
}

export async function main(): Promise<void> {
  const store = await createExampleStore();

  console.log("=".repeat(72));
  console.log(" Provenance retraction over derived facts");
  console.log("=".repeat(72));

  const scanner = await createScannerSource(
    store,
    "scanner-source",
    "Unverified scanner finding",
  );
  const vendor = await createVendorSource(
    store,
    "vendor-source",
    "Vendor security advisory",
  );

  const vulnerable = await createVulnerability(
    store,
    "vulnerability-libvector",
    "CVE-2026-1234",
    "libvector",
  );
  const blockDeploy = await createDeployDecision(
    store,
    "decision-block-deploy",
    "Block the production deploy",
  );

  await createJustification(
    store,
    "justification-scanner-finding",
    "The scanner reported CVE-2026-1234 in libvector",
    [scanner],
    vulnerable,
  );
  await createJustification(
    store,
    "justification-vendor-advisory",
    "The vendor advisory confirms CVE-2026-1234 in libvector",
    [vendor],
    vulnerable,
  );
  await createJustification(
    store,
    "justification-block-deploy",
    "The deploy should stop whenever libvector is believed vulnerable",
    [vulnerable],
    blockDeploy,
  );

  const provenance = createRetractionCapability(store, retractionConfig);

  console.log("\nInitial derived beliefs:");
  await printHolding("  holding()", provenance);

  console.log("\nRetract the unverified scanner source.");
  const scannerReport = await provenance.retract(scanner);
  console.log(formatReport(scannerReport));
  await printHolding("  holding()", provenance);
  console.log(
    "  The vulnerability and deploy-block facts survive through the vendor advisory.",
  );

  const beforeVendorRetraction = await requireRecordedNow(store);

  console.log("\nRetract the vendor advisory too.");
  const vendorReport = await provenance.retract(vendor);
  console.log(formatReport(vendorReport));
  await printHolding("  holding()", provenance);

  const afterVendorRetraction = await requireRecordedNow(store);
  const before = await store
    .asOfRecorded(beforeVendorRetraction)
    .nodes.DeployDecision.getById(blockDeploy.id);
  const after = await store
    .asOfRecorded(afterVendorRetraction)
    .nodes.DeployDecision.getById(blockDeploy.id);

  console.log("\nRecorded-time replay of the deploy-block fact:");
  console.log(`  before vendor retraction: ${formatDecisionAction(before)}`);
  console.log(`  after vendor retraction:  ${formatDecisionAction(after)}`);

  console.log("\nUn-retract the scanner source.");
  const restoreReport = await provenance.unRetract(scanner);
  console.log(formatReport(restoreReport));
  await printHolding("  holding()", provenance);

  console.log("\n" + "=".repeat(72));
  console.log(
    " Retraction changes belief currency; recorded time keeps the audit trail.",
  );
  console.log("=".repeat(72) + "\n");

  await store.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
