/**
 * Example 29: Identity History
 *
 * Three back-office systems each hold their own record of the same person:
 * a CRM contact, an ERP contact, and a support-desk contact. Operational
 * identity (`store.identity`) lets an application assert that two records
 * denote the same real-world entity, retract that assertion when it turns
 * out to be wrong, and — on a store opened with `history: true` — replay
 * every step of how that belief changed over time.
 *
 * This example demonstrates:
 * - paginated `transitionsOf`, reading a lineage a page at a time via
 *   `nextFrom`
 * - paginated `replay`, pairing each transition with the class membership
 *   immediately before and after it
 * - retention: `pruneIdentityTransitions` deletes transitions before a
 *   recorded instant, and pruning again at the same point is a no-op
 * - the `restored` marker an archival import stamps on a transplanted
 *   transition, produced with a real export/import round trip
 *
 * Run with:
 *   npx tsx examples/29-identity-history.ts
 */
import { deepStrictEqual } from "node:assert/strict";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  type IdentityTransition,
  pruneIdentityTransitions,
} from "@nicia-ai/typegraph";
import { exportGraph, importGraph } from "@nicia-ai/typegraph/interchange";
import { z } from "zod";

import { requireDefined } from "../src/utils/presence";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Schema: one person, three systems of record, no edges needed —
// identity lives entirely in the assertion ledger.
// ============================================================

const CrmContact = defineNode("CrmContact", {
  schema: z.object({ name: z.string() }),
});
const ErpContact = defineNode("ErpContact", {
  schema: z.object({ name: z.string() }),
});
const SupportContact = defineNode("SupportContact", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "identity_history_example",
  nodes: {
    CrmContact: { type: CrmContact },
    ErpContact: { type: ErpContact },
    SupportContact: { type: SupportContact },
  },
  edges: {},
  // Different kinds, so a shared id would never implicitly fold two
  // records — every join in this example comes from an explicit assertSame.
  identity: { sameIdAcrossKinds: "ignore" },
});

function assertEqual<T>(actual: T, expected: T, label: string): void {
  // `deepStrictEqual` compares Sets and Maps by membership; a JSON round
  // trip would serialize every Set as `{}` and pass vacuously.
  deepStrictEqual(actual, expected, label);
  console.log(`  OK: ${label}`);
}

function assertTrue(condition: boolean, label: string): void {
  if (!condition) throw new Error(`${label}: expected true, got false`);
  console.log(`  OK: ${label}`);
}

/**
 * The labeling function §4 asks for: an audit view uses `restored?.at`
 * (never a revision comparison) to tell a transplanted explanation from one
 * this graph recorded itself. See "Archival transitions and the retention
 * watermark" in the identity guide.
 */
function labelTransition(transition: IdentityTransition<typeof graph>): string {
  return transition.restored === undefined ?
      "recorded here"
    : `restored at ${transition.restored.at}`;
}

export async function main(): Promise<void> {
  const backend = createExampleBackend();
  try {
    const [store] = await createAdapterStoreWithSchema(graph, backend, {
      history: true,
    });

    console.log("=== Identity History ===\n");

    // ============================================================
    // Build the lineage: join, split, rejoin
    // ============================================================

    console.log("=== 0. Three systems record one person ===\n");

    const crm = await store.nodes.CrmContact.create(
      { name: "Jordan Casey" },
      { id: "crm-1001" },
    );
    const erp = await store.nodes.ErpContact.create(
      { name: "Jordan Casey" },
      { id: "erp-77" },
    );
    const support = await store.nodes.SupportContact.create(
      { name: "Jordan Casey" },
      { id: "sup-42" },
    );
    console.log(
      `  CrmContact/${crm.id}, ErpContact/${erp.id}, SupportContact/${support.id}`,
    );

    const crmErpAssertion = await store.identity.assertSame(crm, erp);
    console.log(`  assertSame(crm, erp): ${crmErpAssertion.action}`);
    await store.identity.assertSame(erp, support);
    console.log("  assertSame(erp, support): transitively joins all three");

    const retracted = await store.identity.retractAssertion(
      crmErpAssertion.assertion.id,
    );
    console.log(
      `  retractAssertion(crm<->erp): ended at ${retracted?.validTo} — crm splits off`,
    );

    await store.identity.assertSame(crm, erp);
    console.log("  assertSame(crm, erp) again: rejoins all three\n");

    const finalMembers = await store.identity.membersOf(crm);
    assertEqual(
      new Set(finalMembers.map((member) => member.id)),
      new Set([crm.id, erp.id, support.id]),
      "all three records are joined after the final re-assert",
    );

    // ============================================================
    // 1. Paginated transitionsOf
    // ============================================================

    console.log("\n=== 1. transitionsOf, paged with limit=2 ===\n");

    const allTransitions: IdentityTransition<typeof graph>[] = [];
    let transitionsCursor: string | undefined;
    let pageCount = 0;
    do {
      const page = await store.identity.transitionsOf(crm, {
        limit: 2,
        ...(transitionsCursor === undefined ?
          {}
        : { fromRecorded: transitionsCursor }),
      });
      pageCount += 1;
      console.log(
        `  page ${pageCount}: ${page.transitions.length} transition(s)`,
      );
      for (const transition of page.transitions) {
        console.log(`    ${transition.cause} @ ${transition.recorded}`);
      }
      allTransitions.push(...page.transitions);
      transitionsCursor = page.nextFrom;
    } while (transitionsCursor !== undefined);

    assertTrue(pageCount > 1, "the lineage needed more than one page");
    // The retraction splits one class into two, and each resulting class's
    // own new canonical gets its own transition row — both touch crm's
    // lineage, so the split shows up as two `retract` transitions, not one.
    assertEqual(allTransitions.length, 5, "five transitions total");
    assertEqual(
      allTransitions.map((transition) => transition.cause),
      ["assert", "assert", "retract", "retract", "assert"],
      "the causes, oldest first, match the writes above",
    );

    // ============================================================
    // 2. Paginated replay
    // ============================================================

    console.log("\n=== 2. replay, paged with limit=2 ===\n");

    const allSteps: Awaited<
      ReturnType<typeof store.identity.replay>
    >["steps"][number][] = [];
    let replayCursor: string | undefined;
    let replayPageCount = 0;
    do {
      const page = await store.identity.replay(crm, {
        limit: 2,
        ...(replayCursor === undefined ? {} : { fromRecorded: replayCursor }),
      });
      replayPageCount += 1;
      console.log(`  page ${replayPageCount}: ${page.steps.length} step(s)`);
      for (const step of page.steps) {
        const before =
          step.before.map((member) => member.id).join(", ") || "(none)";
        const after =
          step.after.map((member) => member.id).join(", ") || "(none)";
        console.log(`    ${step.transition.cause}: [${before}] -> [${after}]`);
      }
      allSteps.push(...page.steps);
      replayCursor = page.nextFrom;
    } while (replayCursor !== undefined);

    assertTrue(replayPageCount > 1, "replay also needed more than one page");
    assertEqual(allSteps.length, 5, "replay pairs all five transitions");
    const lastStep = requireDefined(allSteps.at(-1));
    assertEqual(
      new Set(lastStep.after.map((member) => member.id)),
      new Set([crm.id, erp.id, support.id]),
      "the final step's `after` matches the live membership",
    );

    // ============================================================
    // 3. Retention
    // ============================================================

    console.log("\n=== 3. Retention: pruneIdentityTransitions ===\n");

    const secondTransition = requireDefined(allTransitions[1]);
    const retentionCutoff = secondTransition.recorded;

    const { transitions: beforePruneTransitions } =
      await store.identity.transitionsOf(crm);
    const beforeCount = beforePruneTransitions.length;
    const firstPrune = await pruneIdentityTransitions(store, {
      beforeRecorded: retentionCutoff,
    });
    const { transitions: afterPruneTransitions } =
      await store.identity.transitionsOf(crm);
    const afterCount = afterPruneTransitions.length;
    console.log(
      `  pruned ${firstPrune.pruned} transition(s) before revision ${firstPrune.prunedBeforeRevision}`,
    );
    console.log(`  transitionsOf: ${beforeCount} -> ${afterCount}`);
    assertEqual(
      firstPrune.pruned,
      1,
      "exactly the first (join) transition was pruned",
    );
    assertEqual(afterCount, beforeCount - 1, "one fewer transition is visible");

    const secondPrune = await pruneIdentityTransitions(store, {
      beforeRecorded: retentionCutoff,
    });
    console.log(
      `  pruning again at the same instant: pruned ${secondPrune.pruned}`,
    );
    assertEqual(
      secondPrune.pruned,
      0,
      "pruning at an already-passed watermark is a no-op",
    );

    // ============================================================
    // 4. Labeling restored transitions
    // ============================================================

    console.log(
      "\n=== 4. Restored transitions: a real archival export/import round trip ===\n",
    );

    const sourceBackend = createExampleBackend();
    const targetBackend = createExampleBackend();
    try {
      const [source] = await createAdapterStoreWithSchema(
        graph,
        sourceBackend,
        { history: true },
      );
      const sourceCrm = await source.nodes.CrmContact.create(
        { name: "Alex Rivera" },
        { id: "restore-crm" },
      );
      const sourceErp = await source.nodes.ErpContact.create(
        { name: "Alex Rivera" },
        { id: "restore-erp" },
      );
      const firstAssertion = await source.identity.assertSame(
        sourceCrm,
        sourceErp,
      );
      await source.identity.retractAssertion(firstAssertion.assertion.id);
      await source.identity.assertSame(sourceCrm, sourceErp);

      const { transitions: sourceTransitions } =
        await source.identity.transitionsOf(sourceCrm);
      console.log(
        `  source lineage: ${sourceTransitions.length} native transition(s)`,
      );

      const archive = await exportGraph(source, {
        identityMode: "archival",
        includeDeleted: true,
      });

      const [target] = await createAdapterStoreWithSchema(
        graph,
        targetBackend,
        { history: true },
      );
      const importResult = await importGraph(target, archive, {
        onConflict: "skip",
      });
      assertTrue(importResult.success, "the archival import succeeded");

      const { transitions: targetTransitions } =
        await target.identity.transitionsOf(sourceCrm);
      console.log("  target lineage, labeled:");
      for (const transition of targetTransitions) {
        console.log(`    ${transition.cause}: ${labelTransition(transition)}`);
      }

      const sourceTransitionIds = new Set(
        sourceTransitions.map((transition) => transition.transitionId),
      );
      const restoredHere = targetTransitions.filter((transition) =>
        sourceTransitionIds.has(transition.transitionId),
      );
      assertEqual(
        restoredHere.length,
        sourceTransitions.length,
        "every transplanted transition survived the round trip",
      );
      assertTrue(
        restoredHere.every(
          (transition) => transition.restored?.at !== undefined,
        ),
        "every transplanted transition is marked restored",
      );
      assertTrue(
        sourceTransitions.every(
          (transition) => transition.restored === undefined,
        ),
        "the SOURCE's own copies are never marked restored — the marker names where a row landed",
      );

      // The import itself performs a genuine identity write on the target
      // (materializing the archive's CURRENT assertion as live state), and
      // that write is native to this graph — captured by history exactly
      // like any other write — even though every historical explanation
      // beneath it arrived via restore. `replay` pairs that ONE native
      // transition with a before/after snapshot and excludes the four
      // restored ones, which is why `steps` is shorter than `transitions`.
      const targetReplay = await target.identity.replay(sourceCrm);
      console.log(
        `  target replay: ${targetReplay.steps.length} step(s), truncatedBefore=${targetReplay.truncatedBefore}`,
      );
      assertEqual(
        targetReplay.steps.length,
        1,
        "replay pairs only the import's own native transition",
      );
      assertTrue(
        requireDefined(targetReplay.steps[0]).transition.restored === undefined,
        "the one step replay produced is the NATIVE transition, never a restored one",
      );
    } finally {
      await sourceBackend.close();
      await targetBackend.close();
    }

    console.log("\n=== Identity history example complete ===");
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
