/**
 * Example 20: Bitemporal Time Travel (valid time + recorded time)
 *
 * TypeGraph tracks two independent clocks:
 *
 *   • valid time    — WHEN A FACT IS TRUE in the world (`validFrom` / `validTo`)
 *   • recorded time — WHEN YOU WROTE IT DOWN (`history: true`)
 *
 * Most systems give you one or the other. With both, you can answer the
 * question that trips up every audit and every restatement:
 *
 *     "What did TypeGraph capture as true at this recorded instant?"
 *
 * Scenes:
 *   [1] Recorded time — a correction. "What we reported" vs "what we now know."
 *   [2] Valid time    — effective dating. "What was in effect on date X."
 *   [3] Both at once  — the bitemporal 2x2. The same question, four answers.
 *
 * Run with:
 *   npx tsx examples/20-bitemporal-time-travel.ts
 */
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type RecordedInstant,
} from "@nicia-ai/typegraph";
import { createExampleBackend, requireRecordedNow } from "./_helpers";

// ============================================================
// Schema
// ============================================================

const Invoice = defineNode("Invoice", {
  schema: z.object({ vendor: z.string(), amount: z.number() }),
});

const Promotion = defineNode("Promotion", {
  schema: z.object({ code: z.string() }),
});

const Subscription = defineNode("Subscription", {
  schema: z.object({ plan: z.string() }),
});

const graph = defineGraph({
  id: "bitemporal_demo",
  nodes: {
    Invoice: { type: Invoice },
    Promotion: { type: Promotion },
    Subscription: { type: Subscription },
  },
  edges: {},
});

// Fixed valid-time instants (canonical UTC ISO-8601, as the API requires).
const JAN_1 = "2024-01-01T00:00:00.000Z";
const MAY_1 = "2024-05-01T00:00:00.000Z";
const JUN_1 = "2024-06-01T00:00:00.000Z";
const JUL_1 = "2024-07-01T00:00:00.000Z";
const JUL_15 = "2024-07-15T00:00:00.000Z";
const AUG_1 = "2024-08-01T00:00:00.000Z";
const SEP_1 = "2024-09-01T00:00:00.000Z";

function yesNo(active: boolean): string {
  return active ? "✓ active" : "✗ inactive";
}

export async function main(): Promise<void> {
  // `history: true` turns on built-in recorded-time capture: every committed
  // TypeGraph node/edge write is stamped into the recorded relations that
  // `asOfRecorded` reads.
  const [store] = await createStoreWithSchema(graph, createExampleBackend(), {
    history: true,
  });

  console.log("━".repeat(70));
  console.log(" Bitemporal Time Travel — valid time × recorded time");
  console.log("━".repeat(70));

  // ----------------------------------------------------------
  // [1] Recorded time: a correction
  // ----------------------------------------------------------
  //
  // The recorded axis is value time-travel for TypeGraph-managed writes: it
  // remembers every captured value, so you can reconstruct what TypeGraph
  // recorded at a past instant — even values that were later corrected.

  console.log("\n" + "━".repeat(70));
  console.log(" [1] Recorded time — a correction");
  console.log("━".repeat(70));

  const invoice = await store.nodes.Invoice.create({
    vendor: "Acme",
    amount: 1000,
  });
  const asReported = await requireRecordedNow(store);

  // Three weeks later, finance finds the invoice was actually $1,250.
  await store.nodes.Invoice.update(invoice.id, {
    vendor: "Acme",
    amount: 1250,
  });

  const reportedThen = await store
    .asOfRecorded(asReported)
    .nodes.Invoice.getById(invoice.id);
  const knownNow = await store.nodes.Invoice.getById(invoice.id);

  console.log(`\n  Invoice ${invoice.id} (vendor: Acme)\n`);
  console.log(`    as reported    (asOfRecorded): $${reportedThen?.amount}`);
  console.log(`    as known now   (live read):    $${knownNow?.amount}`);
  console.log(
    "\n  Same invoice, two correct answers — the report you filed and the",
  );
  console.log("  truth you discovered later. No audit table; just two reads.");

  // ----------------------------------------------------------
  // [2] Valid time: effective dating
  // ----------------------------------------------------------
  //
  // The valid axis is a validity *window*: `validFrom` / `validTo` say when a
  // fact is in effect. `asOf(T)` returns only what was effective at T.

  console.log("\n" + "━".repeat(70));
  console.log(" [2] Valid time — effective dating");
  console.log("━".repeat(70));

  // A promotion that runs for July only.
  await store.nodes.Promotion.create(
    { code: "SUMMER24" },
    { validFrom: JUL_1, validTo: AUG_1 },
  );

  console.log('\n  Promotion "SUMMER24" is valid for July only.\n');
  for (const [label, when] of [
    ["Jun 1 (before)", JUN_1],
    ["Jul 15 (during)", JUL_15],
    ["Sep 1 (after)", SEP_1],
  ] as const) {
    const live = await store.asOf(when).nodes.Promotion.find();
    console.log(
      `    asOf ${label.padEnd(16)} → ${live.length > 0 ? "SUMMER24 in effect" : "no promotion"}`,
    );
  }

  // ----------------------------------------------------------
  // [3] Both axes at once: the bitemporal 2x2
  // ----------------------------------------------------------
  //
  // A subscription cancelled "effective Jun 1" — then the cancellation date is
  // corrected to Sep 1. Now "was it active on date X?" has different answers
  // depending on WHEN you valid-time-ask AND WHEN TypeGraph captured the state.

  console.log("\n" + "━".repeat(70));
  console.log(" [3] Both axes — the bitemporal 2×2");
  console.log("━".repeat(70));

  const sub = await store.nodes.Subscription.create(
    { plan: "Pro" },
    { validFrom: JAN_1 },
  );

  // First we record: the customer cancelled effective Jun 1.
  await store.nodes.Subscription.update(
    sub.id,
    { plan: "Pro" },
    { validTo: JUN_1 },
  );
  const beforeFix = await requireRecordedNow(store);

  // Support later finds the real cancellation date was Sep 1, and corrects it.
  await store.nodes.Subscription.update(
    sub.id,
    { plan: "Pro" },
    { validTo: SEP_1 },
  );

  async function activeOn(
    validAt: string,
    recordedAt?: RecordedInstant,
  ): Promise<boolean> {
    const view =
      recordedAt === undefined ?
        store.asOf(validAt)
      : store.asOf(validAt).asOfRecorded(recordedAt);
    return (await view.nodes.Subscription.getById(sub.id)) !== undefined;
  }

  console.log("\n  Subscription cancelled 'effective Jun 1' — later corrected");
  console.log("  to Sep 1. Was it active on a given date?\n");
  console.log(
    "    valid-time ↓ \\ recorded-time →   before correction      now",
  );
  for (const [label, validAt] of [
    ["May 1", MAY_1],
    ["Jul 15", JUL_15],
  ] as const) {
    const before = await activeOn(validAt, beforeFix);
    const now = await activeOn(validAt);
    console.log(
      `    valid ${label.padEnd(26)} ${yesNo(before).padEnd(22)} ${yesNo(now)}`,
    );
  }

  console.log(
    "\n  The Jul-15 / before-correction cell is the one no single-clock store",
  );
  console.log(
    "  can express: on Jul 15 the captured graph state had the subscription",
  );
  console.log(
    "  already cancelled — even though we now know it was still active.",
  );

  console.log("\n" + "━".repeat(70));
  console.log(
    " valid time = when a fact is true · recorded time = when we knew",
  );
  console.log(" Pin either or both; every read time-travels. One SQLite file.");
  console.log("━".repeat(70) + "\n");

  await store.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
