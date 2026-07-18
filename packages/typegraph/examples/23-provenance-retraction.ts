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
 * Scenes:
 *   [1] Derive facts from sources through justifications
 *   [2] Retract one source — facts survive via alternate support
 *   [3] Retract the other source — facts lose all support and die
 *   [4] Un-retract — belief currency returns
 *   [5] Recorded time keeps the audit trail, even across the un-retract
 *
 * Run with:
 *   npx tsx examples/23-provenance-retraction.ts
 */
import {
  createAdapterStoreWithSchema,
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
import { z } from "zod";

import { createExampleBackend, requireRecordedNow } from "./_helpers";

// ============================================================
// Schema: multiple source kinds, fact kinds, and AND justifications
// ============================================================

const ScannerSource = defineNode("ScannerSource", {
  schema: z.object({
    title: z.string(),
    // `retracted` is a hard contract of the retraction capability:
    // createRetractionCapability requires every source kind's schema to
    // declare a boolean field with this name (default "retracted",
    // overridable via `source.retractedField`) and flips it inside
    // retract()/unRetract(). It is not unused — do not remove it.
    retracted: z.boolean().default(false),
  }),
});

const VendorSource = defineNode("VendorSource", {
  schema: z.object({
    title: z.string(),
    // Required by the retraction capability — see ScannerSource above.
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

type SourceKind = "ScannerSource" | "VendorSource";
type FactKind = "Vulnerability" | "DeployDecision";
type Premise =
  | Node<typeof ScannerSource>
  | Node<typeof VendorSource>
  | Node<typeof Vulnerability>;
type Fact = Node<typeof Vulnerability> | Node<typeof DeployDecision>;

type ExampleReport = RetractionReport<typeof graph, FactKind, "Justification">;
type ExampleProvenance = RetractionCapability<
  typeof graph,
  SourceKind,
  FactKind,
  "Justification"
>;

function formatFactReferences(
  facts: readonly ProvenanceFactRef<typeof graph, FactKind>[],
): string {
  if (facts.length === 0) return "(none)";
  return facts
    .map((fact) => fact.id)
    .toSorted((left, right) => left.localeCompare(right))
    .join(", ");
}

function formatReport(report: ExampleReport): string {
  const survived =
    report.survivedVia.length === 0 ?
      "(none)"
    : report.survivedVia
        .map((entry) => {
          const via = entry.via.map((justification) => justification.id);
          return `${entry.fact.id} via ${via.join(" + ")}`;
        })
        .toSorted((left, right) => left.localeCompare(right))
        .join("; ");
  return [
    `    died:        ${formatFactReferences(report.died)}`,
    `    survived:    ${survived}`,
    `    unaffected:  ${formatFactReferences(report.unaffected)}`,
  ].join("\n");
}

function formatDecisionAction(
  decision: Node<typeof DeployDecision> | undefined,
): string {
  return decision === undefined ? "not current" : decision.action;
}

async function printHolding(
  label: string,
  provenance: ExampleProvenance,
): Promise<void> {
  console.log(`${label}: ${formatFactReferences(await provenance.holding())}`);
}

export async function main(): Promise<void> {
  const backend = createExampleBackend();
  try {
    const [store] = await createAdapterStoreWithSchema(graph, backend, {
      history: true,
    });

    console.log("━".repeat(70));
    console.log(" Provenance retraction over derived facts");
    console.log("━".repeat(70));

    // ----------------------------------------------------------
    // [1] Derive facts from sources through justifications
    // ----------------------------------------------------------

    console.log("\n" + "━".repeat(70));
    console.log(" [1] Derive facts from sources through justifications");
    console.log("━".repeat(70));

    async function createSource(
      kind: SourceKind,
      id: string,
      title: string,
    ): Promise<Node<typeof ScannerSource> | Node<typeof VendorSource>> {
      return store.nodes[kind].create({ title, retracted: false }, { id });
    }

    async function createJustification(
      id: string,
      text: string,
      premises: readonly Premise[],
      fact: Fact,
    ): Promise<void> {
      const justification = await store.nodes.Justification.create(
        { text },
        { id },
      );
      for (const [index, premise] of premises.entries()) {
        await store.edges.premiseOf.create(premise, justification, {}, {
          id: `${id}-premise-${index + 1}`,
        });
      }
      await store.edges.derives.create(justification, fact, {}, {
        id: `${id}-derives-${fact.id}`,
      });
    }

    const scanner = await createSource(
      "ScannerSource",
      "scanner-source",
      "Unverified scanner finding",
    );
    const vendor = await createSource(
      "VendorSource",
      "vendor-source",
      "Vendor security advisory",
    );

    const vulnerable = await store.nodes.Vulnerability.create(
      { cve: "CVE-2026-1234", packageName: "libvector" },
      { id: "vulnerability-libvector" },
    );
    const blockDeploy = await store.nodes.DeployDecision.create(
      { action: "Block the production deploy" },
      { id: "decision-block-deploy" },
    );

    await createJustification(
      "justification-scanner-finding",
      "The scanner reported CVE-2026-1234 in libvector",
      [scanner],
      vulnerable,
    );
    await createJustification(
      "justification-vendor-advisory",
      "The vendor advisory confirms CVE-2026-1234 in libvector",
      [vendor],
      vulnerable,
    );
    await createJustification(
      "justification-block-deploy",
      "The deploy should stop whenever libvector is believed vulnerable",
      [vulnerable],
      blockDeploy,
    );

    const provenance = createRetractionCapability(store, retractionConfig);

    console.log("\nInitial derived beliefs:");
    await printHolding("  holding()", provenance);

    // ----------------------------------------------------------
    // [2] Retract one source — facts survive via alternate support
    // ----------------------------------------------------------

    console.log("\n" + "━".repeat(70));
    console.log(" [2] Retract the scanner — alternate support survives");
    console.log("━".repeat(70));

    console.log("\nRetract the unverified scanner source.");
    const scannerReport = await provenance.retract(scanner);
    console.log(formatReport(scannerReport));
    await printHolding("  holding()", provenance);
    console.log(
      "  The vulnerability and deploy-block facts survive through the vendor advisory.",
    );

    // Pin the recorded clock while the facts are still believed.
    const beforeVendorRetraction = await requireRecordedNow(store);

    // ----------------------------------------------------------
    // [3] Retract the other source — facts lose all support
    // ----------------------------------------------------------

    console.log("\n" + "━".repeat(70));
    console.log(" [3] Retract the vendor advisory too — the facts die");
    console.log("━".repeat(70));

    console.log("\nRetract the vendor advisory.");
    const vendorReport = await provenance.retract(vendor);
    console.log(formatReport(vendorReport));
    await printHolding("  holding()", provenance);

    // Pin the recorded clock inside the interval where the facts are dead.
    const afterVendorRetraction = await requireRecordedNow(store);

    // ----------------------------------------------------------
    // [4] Un-retract — belief currency returns
    // ----------------------------------------------------------

    console.log("\n" + "━".repeat(70));
    console.log(" [4] Un-retract the scanner — belief currency returns");
    console.log("━".repeat(70));

    console.log("\nUn-retract the scanner source.");
    const restoreReport = await provenance.unRetract(scanner);
    console.log(formatReport(restoreReport));
    await printHolding("  holding()", provenance);

    // ----------------------------------------------------------
    // [5] Recorded time keeps the audit trail
    // ----------------------------------------------------------

    console.log("\n" + "━".repeat(70));
    console.log(" [5] Recorded time keeps the audit trail");
    console.log("━".repeat(70));

    const liveDecision = await store.nodes.DeployDecision.getById(
      blockDeploy.id,
    );
    const decisionBeforeVendorRetraction = await store
      .asOfRecorded(beforeVendorRetraction)
      .nodes.DeployDecision.getById(blockDeploy.id);
    const decisionAfterVendorRetraction = await store
      .asOfRecorded(afterVendorRetraction)
      .nodes.DeployDecision.getById(blockDeploy.id);

    console.log("\nThe deploy-block fact, read at three moments:");
    console.log(
      `  live (after the un-retract):      ${formatDecisionAction(liveDecision)}`,
    );
    console.log(
      `  pinned before vendor retraction:  ${formatDecisionAction(decisionBeforeVendorRetraction)}`,
    );
    console.log(
      `  pinned after vendor retraction:   ${formatDecisionAction(decisionAfterVendorRetraction)}`,
    );
    console.log(
      "\n  The un-retract restored the fact's currency, but the recorded pin",
    );
    console.log(
      "  taken while it was dead still reads as not current — the dead",
    );
    console.log("  interval stays replayable; history is never rewritten.");

    console.log("\n" + "━".repeat(70));
    console.log(
      " Retraction changes belief currency; recorded time keeps the audit trail.",
    );
    console.log("━".repeat(70) + "\n");
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
