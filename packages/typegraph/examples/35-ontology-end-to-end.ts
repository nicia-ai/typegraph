/**
 * Example 35: An Ontology, End to End
 *
 * A small documentation library: documents, runbooks (a kind of document)
 * and the sections they are made of. Five declarations in the graph replace
 * five pieces of application code:
 *
 * - `subClassOf(Runbook, Document)`: a query over documents returns runbooks
 *   without an opt-in flag
 * - `partOf(Section, Document, { via })`: deleting a document deletes its
 *   sections, with `planDelete` previewing the cascade and `expect` guarding
 *   it against a change made while a person was reading the preview
 * - `acyclic: true`: a dependency that would close a loop is refused, and
 *   the refusal carries the path it would close
 * - `targetCardinality: "one"`: a document is superseded at most once
 * - tightening a rule on a populated graph is checked against the rows
 *   already stored, and refused with the offending rows listed
 *
 * It closes with identity history: two records of the same document, joined
 * and split, and the store's account of how that belief changed.
 *
 * Run with:
 *   npx tsx examples/35-ontology-end-to-end.ts
 */
import { deepStrictEqual } from "node:assert/strict";

import {
  CardinalityError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  MigrationError,
  partOf,
  subClassOf,
} from "@nicia-ai/typegraph";
import {
  EdgeAcyclicityError,
  NodeDeletePlanMismatchError,
} from "@nicia-ai/typegraph/errors";
import { z } from "zod";

import { createExampleBackend } from "./_helpers";

// ============================================================
// Schema
// ============================================================

const Document = defineNode("Document", {
  schema: z.object({ title: z.string() }),
});
const Runbook = defineNode("Runbook", {
  schema: z.object({ title: z.string(), service: z.string() }),
});
const Section = defineNode("Section", {
  schema: z.object({ heading: z.string() }),
});

const sectionOf = defineEdge("sectionOf");
const dependsOn = defineEdge("dependsOn");
const supersedes = defineEdge("supersedes");
const linksTo = defineEdge("linksTo");

const nodes = {
  Document: { type: Document },
  Runbook: { type: Runbook },
  Section: { type: Section },
} as const;

const ontology = [
  // A runbook is a document: everything that accepts a Document accepts one.
  subClassOf(Runbook, Document),
  // A section belongs to a document, and `sectionOf` is the edge that says so.
  partOf(Section, Document, { via: sectionOf }),
] as const;

const graph = defineGraph({
  id: "docs",
  nodes,
  edges: {
    sectionOf: {
      type: sectionOf,
      from: [Section],
      to: [Document],
      cardinality: "one",
    },
    dependsOn: {
      type: dependsOn,
      from: [Document],
      to: [Document],
      acyclic: true,
    },
    supersedes: {
      type: supersedes,
      from: [Document],
      to: [Document],
      targetCardinality: "one",
    },
    linksTo: { type: linksTo, from: [Document], to: [Document] },
  },
  ontology,
  // Two records of one document are joined by an explicit assertion, never
  // by sharing an id.
  identity: { sameIdAcrossKinds: "ignore" },
});

/** The next release of the graph: `linksTo` may no longer form a cycle. */
const graphWithAcyclicLinks = defineGraph({
  id: "docs",
  nodes,
  edges: {
    ...graph.edges,
    linksTo: {
      type: linksTo,
      from: [Document],
      to: [Document],
      acyclic: true,
    },
  },
  ontology,
  identity: { sameIdAcrossKinds: "ignore" },
});

function assertEqual<T>(actual: T, expected: T, label: string): void {
  deepStrictEqual(actual, expected, label);
  console.log(`  OK: ${label}`);
}

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the write to be refused");
}

export async function main(): Promise<void> {
  const backend = createExampleBackend();
  try {
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });

    console.log("=== An Ontology, End to End ===\n");

    const overview = await store.nodes.Document.create(
      { title: "Architecture overview" },
      { id: "doc-architecture" },
    );
    const failover = await store.nodes.Runbook.create(
      { title: "Database failover", service: "postgres" },
      { id: "rb-failover" },
    );
    const cacheFlush = await store.nodes.Runbook.create(
      { title: "Cache flush", service: "redis" },
      { id: "rb-cache-flush" },
    );

    // ============================================================
    // 1. Supertypes include their subtypes
    // ============================================================

    console.log("=== 1. A query over Document returns runbooks ===\n");

    const titles = await store
      .query()
      .from("Document", "d")
      .orderBy("d", "title")
      .select((ctx) => `${ctx.d.kind}: ${ctx.d.title}`)
      .execute();
    console.log(titles);
    assertEqual(
      [...titles],
      [
        "Document: Architecture overview",
        "Runbook: Cache flush",
        "Runbook: Database failover",
      ],
      "the supertype query returns the plain document and both runbooks",
    );

    const documentsOnly = await store
      .query()
      .from("Document", "d", { expansion: "exact" })
      .select((ctx) => `${ctx.d.kind}: ${ctx.d.title}`)
      .execute();
    console.log(documentsOnly);
    assertEqual(
      [...documentsOnly],
      ["Document: Architecture overview"],
      'expansion: "exact" returns only the plain document',
    );

    // ============================================================
    // 2. Parts go with their whole
    // ============================================================

    console.log("\n=== 2. Deleting a runbook deletes its sections ===\n");

    // `sectionOf` targets Document and never mentions Runbook; a runbook
    // holds sections because a runbook is a document.
    const steps = [
      "Detect the failure",
      "Promote the replica",
      "Repoint clients",
    ];
    for (const [index, heading] of steps.entries()) {
      await store.nodes.Section.create(
        { heading },
        { id: `failover-${index + 1}`, partOf: { whole: failover } },
      );
    }

    const plan = await store.nodes.Runbook.planDelete(failover.id);
    if (plan === undefined) throw new Error("Runbook not found");
    for (const part of plan.cascadedParts) {
      console.log(
        `${part.kind} ${part.id} (part of ${part.whole.id} via ${part.viaEdgeKind})`,
      );
    }
    console.log(`${plan.removedEdgeIds.length} edges removed`);
    assertEqual(
      plan.cascadedParts.map((part) => part.id),
      ["failover-1", "failover-2", "failover-3"],
      "planDelete previews the three sections the delete would remove",
    );

    // Someone adds a step while the confirmation dialog is open.
    await store.nodes.Section.create(
      { heading: "Verify replication lag" },
      { id: "failover-4", partOf: { whole: failover } },
    );
    const stalePlan = await refusal(() =>
      store.nodes.Runbook.delete(failover.id, { expect: plan }),
    );
    if (!(stalePlan instanceof NodeDeletePlanMismatchError)) throw stalePlan;
    console.log(`${stalePlan.name}: ${stalePlan.message}`);

    const freshPlan = await store.nodes.Runbook.planDelete(failover.id);
    if (freshPlan === undefined) throw new Error("Runbook not found");
    await store.nodes.Runbook.delete(failover.id, { expect: freshPlan });
    const sectionsLeft = await store.nodes.Section.count();
    console.log(
      `${freshPlan.cascadedParts.length} sections deleted, ${sectionsLeft} left`,
    );
    assertEqual(
      [freshPlan.cascadedParts.length, sectionsLeft],
      [4, 0],
      "planning again and confirming deletes all four sections",
    );

    // ============================================================
    // 3. Relations that can't close a loop
    // ============================================================

    console.log("\n=== 3. A dependency that would close a loop is refused ===\n");

    const incident = await store.nodes.Runbook.create(
      { title: "Incident response", service: "pager" },
      { id: "rb-incident" },
    );
    await store.edges.dependsOn.create(overview, incident, {}, { id: "dep-1" });
    await store.edges.dependsOn.create(
      incident,
      cacheFlush,
      {},
      { id: "dep-2" },
    );
    const cycle = await refusal(() =>
      store.edges.dependsOn.create(cacheFlush, overview, {}, { id: "dep-3" }),
    );
    if (!(cycle instanceof EdgeAcyclicityError)) throw cycle;
    const witness = cycle.details.witness;
    console.log(cycle.message);
    console.log(witness?.nodes.map((node) => node.id).join(" -> "));
    console.log(
      witness?.edges.map((edge) => `${edge.edgeId} (${edge.source})`),
    );
    assertEqual(
      witness?.nodes.map((node) => node.id),
      ["doc-architecture", "rb-incident", "rb-cache-flush"],
      "the refusal carries the path the new edge would close",
    );

    // ============================================================
    // 4. Bounds on both ends
    // ============================================================

    console.log("\n=== 4. A document is superseded at most once ===\n");

    const overviewV2 = await store.nodes.Document.create(
      { title: "Architecture overview (2026)" },
      { id: "doc-architecture-v2" },
    );
    const overviewDraft = await store.nodes.Document.create(
      { title: "Architecture overview (draft)" },
      { id: "doc-architecture-draft" },
    );
    await store.edges.supersedes.create(overviewV2, overview);
    const secondSuccessor = await refusal(() =>
      store.edges.supersedes.create(overviewDraft, overview),
    );
    if (!(secondSuccessor instanceof CardinalityError)) throw secondSuccessor;
    console.log(`${secondSuccessor.name}: ${secondSuccessor.message}`);
    assertEqual(
      secondSuccessor.details.direction,
      "target",
      "the second successor is refused on the target side",
    );

    // ============================================================
    // 5. Tightening a schema checks the data first
    // ============================================================

    console.log("\n=== 5. A new rule is checked against existing rows ===\n");

    await store.edges.linksTo.create(overview, incident, {}, { id: "link-1" });
    const backLink = await store.edges.linksTo.create(
      incident,
      overview,
      {},
      { id: "link-2" },
    );

    const tightening = await refusal(() =>
      createStoreWithSchema(graphWithAcyclicLinks, backend, { history: true }),
    );
    if (
      !(tightening instanceof MigrationError) ||
      tightening.details.reason !== "ontology-tightening-violated"
    ) {
      throw tightening;
    }
    console.log(tightening.details.violations);

    await store.edges.linksTo.delete(backLink.id);
    const [evolved, migration] = await createStoreWithSchema(
      graphWithAcyclicLinks,
      backend,
      { history: true },
    );
    if (migration.status !== "migrated") {
      throw new Error(`expected a migration, got ${migration.status}`);
    }
    const edgeChanges = migration.diff.edges.map((change) => change.details);
    console.log(edgeChanges);
    assertEqual(
      edgeChanges,
      ['Edge "linksTo" declared acyclic: true'],
      "with the back-link removed, the same call migrates",
    );

    // ============================================================
    // 6. Identity history
    // ============================================================

    console.log("\n=== 6. Why are these two records the same document? ===\n");

    const wikiCopy = await evolved.nodes.Document.create(
      { title: "Architecture overview" },
      { id: "wiki-architecture" },
    );
    const joined = await evolved.identity.assertSame(overview, wikiCopy);
    await evolved.identity.retractAssertion(joined.assertion.id);

    const history = await evolved.identity.replay(overview);
    const lines = history.steps.map((step) => {
      const ids = (members: typeof step.before) =>
        members.map((member) => member.id).join(", ");
      return `${step.transition.cause}: [${ids(step.before)}] -> [${ids(step.after)}]`;
    });
    // A split records one transition for each class it leaves behind. Both
    // read the same from this document's side, so the account of its
    // membership keeps one line per distinct change.
    const account = [...new Set(lines)];
    for (const line of account) console.log(line);
    assertEqual(
      account,
      [
        "assert: [doc-architecture] -> [doc-architecture, wiki-architecture]",
        "retract: [doc-architecture, wiki-architecture] -> [doc-architecture]",
      ],
      "replay explains the join and the split, in order",
    );
    assertEqual(
      history.steps.length,
      3,
      "the split is recorded once for each class it left behind",
    );

    console.log("\n=== Ontology example complete ===");
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
