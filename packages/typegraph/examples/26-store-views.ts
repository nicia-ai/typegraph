/**
 * Example 26: Store Views — read lenses over one graph
 *
 * The same graph answers different questions for different callers:
 *
 *   • the APP shows what is live right now            → current mode
 *   • the AUDIT screen shows soft-deleted rows too    → includeTombstones
 *   • the HISTORY panel shows assignments that ended  → includeEnded
 *   • the REPORT job needs one consistent instant     → store.snapshot()
 *   • the REVIEW tool asks "who held this in April?"  → store.asOf(T)
 *
 * A `StoreView` (from `store.view({ mode, asOf })`, `store.asOf(T)`, or
 * `store.snapshot()`) pins one temporal coordinate and routes every read
 * through it — collections, `query()`, `subgraph()`, graph algorithms,
 * and edge endpoint reads. It is read-only by construction: writes stay
 * on the live `Store`.
 *
 * Examples 20–23 cover the bitemporal pins themselves (asOf ×
 * asOfRecorded). This example owns the LENS surface: the view modes,
 * the snapshot idiom, pinned edge reads, introspection, and the
 * read-only refusal contract. Valid-time lenses need no `history: true`.
 *
 * Scenes:
 *   [1] current vs includeTombstones — the app vs the moderation screen
 *   [2] includeEnded — assignments that ended are history, not garbage
 *   [3] asOf lens — pinned edge reads answer "who held this in April?"
 *   [4] snapshot() — a report job reads many collections at one instant
 *   [5] read-only by construction — the exact refusal errors
 *
 * Run with:
 *   npx tsx examples/26-store-views.ts
 */
import {
  ConfigurationError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { z } from "zod";

import { createExampleBackend } from "./_helpers";

// ============================================================
// Schema — a small content workspace
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Document = defineNode("Document", {
  schema: z.object({ title: z.string() }),
});

const assignedTo = defineEdge("assignedTo", {
  schema: z.object({ role: z.string() }),
});

const graph = defineGraph({
  id: "store_views_example",
  nodes: {
    Person: { type: Person },
    Document: { type: Document },
  },
  edges: {
    assignedTo: { type: assignedTo, from: [Document], to: [Person] },
  },
});

// ============================================================
// Time helpers
// ============================================================

/**
 * Canonical fixed-width UTC ISO-8601 (what every temporal API requires),
 * anchored relative to "now" so the example works whenever it is run.
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Valid-time comparisons are inclusive on `validFrom` (`validFrom <= asOf`),
 * so a write landing in the same millisecond as a snapshot would still be
 * visible to it. A few milliseconds of separation keeps the "snapshot first,
 * write after" ordering unambiguous.
 */
function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const WORKSPACE_FOUNDED = daysAgo(180);
const MAYA_TOOK_THE_FAQ = daysAgo(120);
const APRIL_REVIEW_INSTANT = daysAgo(90);
const MAYA_HANDED_OFF = daysAgo(30);

function banner(title: string): void {
  console.log("\n" + "━".repeat(70));
  console.log(` ${title}`);
  console.log("━".repeat(70));
}

function printRefusal(label: string, error: unknown): void {
  if (!(error instanceof ConfigurationError)) throw error;
  console.log(`  ${label}`);
  console.log(`    name:         ${error.name}`);
  console.log(`    details.code: ${String(error.details.code)}`);
  console.log(`    message:      ${error.message.split(". ")[0]}.`);
}

export async function main(): Promise<void> {
  const backend = createExampleBackend();
  const [store] = await createStoreWithSchema(graph, backend);

  try {
    console.log("━".repeat(70));
    console.log(" Store Views — one graph, many read lenses");
    console.log("━".repeat(70));

    // Seed: two people, three documents, two assignments. Validity starts
    // are explicit: a create WITHOUT `validFrom` stores NULL, which reads
    // as "valid since forever" and would show up at every asOf pin. Give
    // rows real activation instants when you plan to time-travel.
    const maya = await store.nodes.Person.create({ name: "Maya" });
    const rafael = await store.nodes.Person.create({ name: "Rafael" });
    const personName = new Map<string, string>([
      [maya.id, "Maya"],
      [rafael.id, "Rafael"],
    ]);

    const faq = await store.nodes.Document.create(
      { title: "Launch FAQ" },
      { validFrom: WORKSPACE_FOUNDED },
    );
    const pricing = await store.nodes.Document.create(
      { title: "Pricing Page" },
      { validFrom: WORKSPACE_FOUNDED },
    );
    const onboarding = await store.nodes.Document.create(
      { title: "Old Onboarding Guide" },
      { validFrom: WORKSPACE_FOUNDED },
    );

    const faqMaya = await store.edges.assignedTo.create(
      faq,
      maya,
      { role: "editor" },
      { validFrom: MAYA_TOOK_THE_FAQ },
    );
    const pricingRafael = await store.edges.assignedTo.create(
      pricing,
      rafael,
      { role: "reviewer" },
      { validFrom: MAYA_TOOK_THE_FAQ },
    );

    // ----------------------------------------------------------
    // [1] current vs includeTombstones — app vs moderation screen
    // ----------------------------------------------------------

    banner(" [1] current vs includeTombstones — what did we soft-delete?");

    await store.nodes.Document.delete(onboarding.id); // soft delete

    const liveDocuments = await store.nodes.Document.find();
    const liveTitles = liveDocuments
      .map((document) => document.title)
      .toSorted((a, b) => a.localeCompare(b));
    console.log(`\n  App (live store, current mode): ${liveTitles.join(", ")}`);

    // A `current` view is the same lens the live store reads through.
    const appView = store.view({ mode: "current" });
    console.log(
      `  view({ mode: "current" }) agrees:  ${await appView.nodes.Document.count()} documents ` +
        `(live: ${await store.nodes.Document.count()})`,
    );

    const moderation = store.view({ mode: "includeTombstones" });
    const moderationDocuments = await moderation.nodes.Document.find();
    const everything = moderationDocuments
      .map((document) => document.title)
      .toSorted((a, b) => a.localeCompare(b));
    const ghost = await moderation.nodes.Document.getById(onboarding.id);
    console.log(`\n  Moderation (includeTombstones): ${everything.join(", ")}`);
    console.log(
      `  Tombstone: "${ghost?.title}" deletedAt=${String(ghost?.meta.deletedAt)}`,
    );

    // ----------------------------------------------------------
    // [2] includeEnded — ended assignments are history, not garbage
    // ----------------------------------------------------------
    //
    // "Ended" is valid-time vocabulary: the edge's validity window has a
    // `validTo` that has passed. Maya hands the FAQ to Rafael — we END her
    // assignment (update with validTo) rather than delete it.

    banner(" [2] includeEnded — assignments that ended");

    await store.edges.assignedTo.update(
      faqMaya.id,
      { role: "editor" },
      { validTo: MAYA_HANDED_OFF },
    );
    await store.edges.assignedTo.create(
      faq,
      rafael,
      { role: "editor" },
      { validFrom: MAYA_HANDED_OFF },
    );

    const faqNow = await store.edges.assignedTo.findFrom(faq);
    console.log(
      `\n  Live store — "Launch FAQ" assignees now: ` +
        faqNow.map((edge) => personName.get(edge.toId)).join(", "),
    );

    const historyPanel = store.view({ mode: "includeEnded" });
    const faqEver = await historyPanel.edges.assignedTo.findFrom(faq);
    console.log(`  includeEnded — every assignment the FAQ ever had:`);
    for (const edge of faqEver) {
      const window = `${edge.meta.validFrom?.slice(0, 10) ?? "always"} → ${edge.meta.validTo?.slice(0, 10) ?? "open"}`;
      console.log(
        `    ${personName.get(edge.toId)?.padEnd(7)} (${edge.role})  valid ${window}`,
      );
    }
    console.log(
      "\n  includeEnded keeps ended validity windows but still hides",
    );
    console.log("  soft-deletes — only includeTombstones shows those.");

    // ----------------------------------------------------------
    // [3] asOf lens — pinned edge reads
    // ----------------------------------------------------------

    banner(' [3] asOf lens — "who held the Launch FAQ in April?"');

    const aprilReview = store.asOf(APRIL_REVIEW_INSTANT);

    // Views are introspectable: the pinned coordinate is on the view.
    console.log(`\n  Lens coordinates (mode / asOf):`);
    console.log(`    appView:     ${appView.mode} / ${String(appView.asOf)}`);
    console.log(
      `    moderation:  ${moderation.mode} / ${String(moderation.asOf)}`,
    );
    console.log(`    aprilReview: ${aprilReview.mode} / ${aprilReview.asOf}`);

    const faqThen = await aprilReview.edges.assignedTo.findFrom(faq);
    console.log(
      `\n  findFrom(faq) at the pin:  ` +
        faqThen
          .map((edge) => `${personName.get(edge.toId)} (${edge.role})`)
          .join(", "),
    );

    const mayaThen = await aprilReview.edges.assignedTo.findByEndpoints(
      faq,
      maya,
    );
    const mayaNow = await store.edges.assignedTo.findByEndpoints(faq, maya);
    console.log(
      `  findByEndpoints(faq, maya): pinned=${mayaThen === undefined ? "not found" : "found"}, ` +
        `live=${mayaNow === undefined ? "not found" : "found"}`,
    );
    const toMayaThen = await aprilReview.edges.assignedTo.findTo(maya);
    console.log(`  findTo(maya) at the pin:    ${toMayaThen.length} edge(s)`);

    // Honest caveat: soft-deletes are hidden on every mode except
    // includeTombstones — even at a past pin where the row was alive.
    console.log(
      `\n  Documents at the pin: ${await aprilReview.nodes.Document.count()} ` +
        `— the soft-deleted guide stays hidden even in the past.`,
    );

    // ----------------------------------------------------------
    // [4] snapshot() — the report job's consistent instant
    // ----------------------------------------------------------
    //
    // `store.snapshot()` pins ONE instant at construction (sugar for
    // store.asOf(now)). Every read on it observes that same instant, so a
    // job reading many collections cannot tear across concurrent writes.

    banner(" [4] snapshot() — frozen instant while the live store moves on");

    await pause(5);
    const report = store.snapshot();
    await pause(5);
    console.log(`\n  Snapshot pinned: mode=${report.mode} asOf=${report.asOf}`);

    // The workspace keeps changing AFTER the snapshot was taken. The new
    // document gets an explicit validFrom of "now" — omitting it would
    // store NULL ("valid since forever") and leak into the snapshot.
    await store.nodes.Document.create(
      { title: "Q3 Roadmap" },
      { validFrom: new Date().toISOString() },
    );
    await store.edges.assignedTo.update(
      pricingRafael.id,
      { role: "reviewer" },
      { validTo: new Date().toISOString() }, // ended just now
    );

    const reportDocuments = await report.nodes.Document.find();
    const reportTitles = reportDocuments
      .map((document) => document.title)
      .toSorted((a, b) => a.localeCompare(b));
    console.log(`\n  ${"".padEnd(24)}snapshot view        live store`);
    console.log(
      `  documents:              ${String(reportTitles.length).padEnd(21)}` +
        `${await store.nodes.Document.count()}`,
    );
    console.log(
      `  open assignments:       ${String(await report.edges.assignedTo.count()).padEnd(21)}` +
        `${await store.edges.assignedTo.count()}`,
    );
    console.log(`\n  Snapshot document list: ${reportTitles.join(", ")}`);
    console.log('  The post-snapshot "Q3 Roadmap" and the just-ended pricing');
    console.log(
      "  assignment moved the live numbers; the report's did not budge.",
    );

    // ----------------------------------------------------------
    // [5] Read-only by construction
    // ----------------------------------------------------------
    //
    // The view's TypeScript surface omits writes entirely (calling
    // `report.nodes.Document.create` is a compile error). The runtime
    // enforces the same contract for untyped callers: reaching a write
    // through a cast gets a typed refusal, not a silent no-op.

    banner(" [5] Read-only by construction — the refusal contract");
    console.log();

    const untypedWriter = report.nodes.Document as unknown as Readonly<{
      create: (props: unknown) => Promise<unknown>;
    }>;
    try {
      await untypedWriter.create({ title: "Backdated Doc" });
    } catch (error) {
      printRefusal("Write through a view:", error);
    }

    // Search is refused on any non-current pin: the fulltext / vector
    // index reflects current state only, so a pinned search would lie.
    try {
      await aprilReview.search.fulltext("Document", {
        query: "roadmap",
        limit: 5,
      });
    } catch (error) {
      console.log();
      printRefusal("Search on a temporal pin:", error);
    }

    banner(" Summary");
    console.log(`
  store.view({ mode: "current" })            the app's lens (≡ live reads)
  store.view({ mode: "includeTombstones" })  moderation / audit lens
  store.view({ mode: "includeEnded" })       history lens (ended validity)
  store.asOf(T)                              the graph as valid at T
  store.snapshot()                           one consistent instant, many reads

  Every lens is read-only by construction, introspectable via
  view.mode / view.asOf, and pins collections, query(), subgraph(),
  graph algorithms, and edge endpoint reads all at once.`);
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
