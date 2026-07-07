/**
 * Example 21: Replay an agent's decision over the graph it actually saw
 *
 * An AI agent answers a question by reasoning over a knowledge graph — ranking
 * evidence, tracing citations, picking the most authoritative source. Then the
 * graph keeps changing: papers get retracted, new citations arrive, facts get
 * corrected. Weeks later someone asks:
 *
 *     "Why did the agent recommend THAT source?"
 *
 * Re-running the agent on the *current* graph gives a different answer — the
 * evidence moved. With recorded-time capture (`history: true`) you reconstruct
 * the exact graph the agent saw at decision time and run the *same code* over
 * it: the decision reproduces perfectly, and the explanation is the real one.
 *
 * This is point-in-time-correct reasoning for audit, eval, and debugging —
 * with no event log, no snapshots, and no second database.
 *
 * Run with:
 *   npx tsx examples/21-agent-decision-replay.ts
 */
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type RecordedStoreView,
} from "@nicia-ai/typegraph";
import { createExampleBackend, requireRecordedNow } from "./_helpers";

// ============================================================
// Schema: a tiny scientific-evidence knowledge graph
// ============================================================

const Paper = defineNode("Paper", {
  schema: z.object({ title: z.string() }),
});

const Claim = defineNode("Claim", {
  schema: z.object({ text: z.string() }),
});

const cites = defineEdge("cites", { schema: z.object({}) });
const supports = defineEdge("supports", { schema: z.object({}) });

const graph = defineGraph({
  id: "agent_replay",
  nodes: {
    // Retracting a paper cascades its citation / support edges.
    Paper: { type: Paper, onDelete: "cascade" },
    Claim: { type: Claim },
  },
  edges: {
    cites: { type: cites, from: [Paper], to: [Paper] },
    supports: { type: supports, from: [Paper], to: [Claim] },
  },
});

// The reconstructing reads the agent uses. A live `store.view(...)` and a
// recorded `store.asOfRecorded(...)` both satisfy this surface, so the agent
// runs the *identical* code against either coordinate.
type EvidenceView = Pick<
  RecordedStoreView<typeof graph>,
  "query" | "degree" | "nodes"
>;

// ============================================================
// The agent: "recommend the most-cited paper that supports a claim"
// ============================================================

async function recommendSource(
  view: EvidenceView,
  claimId: string,
): Promise<{ id: string; title: string; citations: number } | undefined> {
  // 1. Which papers support this claim? (graph traversal, pinned to the view)
  const supporterIds = await view
    .query()
    .from("Claim", "c")
    .whereNode("c", (c) => c.id.eq(claimId))
    .traverse("supports", "e", { direction: "in" })
    .to("Paper", "p")
    .select((ctx) => ctx.p.id)
    .execute();
  const ids = [...new Set(supporterIds)];

  // 2. Rank each supporter by citation authority (in-degree on `cites`).
  const scored = await Promise.all(
    ids.map(async (id) => ({
      id,
      citations: await view.degree(id, { edges: ["cites"], direction: "in" }),
    })),
  );
  scored.sort((a, b) => b.citations - a.citations);

  const top = scored[0];
  if (top === undefined) return undefined;
  const paper = await view.nodes.Paper.getById(top.id);
  return {
    id: top.id,
    title: paper?.title ?? top.id,
    citations: top.citations,
  };
}

export async function main(): Promise<void> {
  const [store] = await createStoreWithSchema(graph, createExampleBackend(), {
    history: true,
  });

  console.log("━".repeat(70));
  console.log(" Replay an agent's decision over the graph it actually saw");
  console.log("━".repeat(70));

  // ----------------------------------------------------------
  // Build the knowledge graph the agent will reason over
  // ----------------------------------------------------------

  const claim = await store.nodes.Claim.create({
    text: "Scaling model size improves downstream accuracy",
  });

  const kaplan = await store.nodes.Paper.create({
    title: "Kaplan — Scaling Laws",
  });
  const chinchilla = await store.nodes.Paper.create({
    title: "Hoffmann — Compute-Optimal LLMs",
  });
  const ablation = await store.nodes.Paper.create({
    title: "Internal ablation memo",
  });

  // All three support the claim.
  for (const p of [kaplan, chinchilla, ablation]) {
    await store.edges.supports.create(p, claim, {});
  }

  // Citation authority: Kaplan is cited by 3 papers, Chinchilla by 1, memo by 0.
  const citers: Array<Awaited<ReturnType<typeof store.nodes.Paper.create>>> =
    [];
  for (let index = 0; index < 4; index += 1) {
    citers.push(
      await store.nodes.Paper.create({ title: `Follow-up paper ${index + 1}` }),
    );
  }
  await store.edges.cites.create(citers[0]!, kaplan, {});
  await store.edges.cites.create(citers[1]!, kaplan, {});
  await store.edges.cites.create(citers[2]!, kaplan, {});
  await store.edges.cites.create(citers[3]!, chinchilla, {});

  // ----------------------------------------------------------
  // The agent decides — and we note WHEN it decided
  // ----------------------------------------------------------

  // A deterministic recorded anchor for the exact graph the agent reasoned over.
  const decisionTime = await requireRecordedNow(store);

  const original = await recommendSource(
    store.view({ mode: "current" }),
    claim.id,
  );
  console.log("\n  Agent answers: 'best source for the claim?'\n");
  console.log(`    → ${original?.title}  (${original?.citations} citations)`);
  console.log(`    recorded at: ${decisionTime}`);

  // ----------------------------------------------------------
  // The world moves on
  // ----------------------------------------------------------

  console.log("\n" + "─".repeat(70));
  console.log("  …time passes. The evidence graph changes:");
  console.log("    • the Kaplan paper is RETRACTED (removed from the corpus)");
  console.log("    • two new follow-ups now cite the Chinchilla paper");
  console.log("─".repeat(70));

  await store.nodes.Paper.hardDelete(kaplan.id); // retraction cascades its edges
  const late1 = await store.nodes.Paper.create({ title: "Follow-up paper 5" });
  const late2 = await store.nodes.Paper.create({ title: "Follow-up paper 6" });
  await store.edges.cites.create(late1, chinchilla, {});
  await store.edges.cites.create(late2, chinchilla, {});

  // ----------------------------------------------------------
  // The audit: "why did the agent recommend Kaplan?"
  // ----------------------------------------------------------

  console.log("\n" + "━".repeat(70));
  console.log(" The audit asks: why did the agent recommend that source?");
  console.log("━".repeat(70));

  // Same agent code, on the LIVE graph — the evidence has moved, so it can't
  // explain the original decision.
  const liveNow = await recommendSource(
    store.view({ mode: "current" }),
    claim.id,
  );
  console.log("\n  Re-run on the CURRENT graph (the evidence moved):");
  console.log(`    → ${liveNow?.title}  (${liveNow?.citations} citations)`);
  console.log("    ✗ This is a different answer. The live graph no longer");
  console.log("      explains what the agent did — Kaplan isn't even in it.");

  // Same agent code, pinned to the recorded graph as of the decision instant.
  const replay = await recommendSource(
    store.asOfRecorded(decisionTime),
    claim.id,
  );
  console.log("\n  Replay on `store.asOfRecorded(decisionTime)` (same code):");
  console.log(`    → ${replay?.title}  (${replay?.citations} citations)`);
  console.log("    ✓ Reproduced exactly — the retracted paper, its citations,");
  console.log("      and the ranking, reconstructed as the agent saw them.");

  console.log("\n" + "━".repeat(70));
  console.log(
    " Point-in-time-correct reasoning: the same query, pinned to the",
  );
  console.log(
    " instant the agent acted. No event log, no snapshots, one file.",
  );
  console.log("━".repeat(70) + "\n");

  await store.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
