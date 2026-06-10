/**
 * Three-way merge LAW properties (complements the T12 determinism gate).
 *
 * `merge()` claims Dolt-class deterministic THREE-WAY merge semantics — NOT
 * CRDT semilattice (ACI) convergence. Entity-resolution merge is not
 * associative or idempotent in general (similarity is not transitive), so the
 * honest, checkable law set for an LCA-anchored merge `m(base, branches…)` is:
 *
 *   1. SYMMETRY        m(B, [a, b]) ≡ m(B, [b, a])
 *      — covered by `determinism.test.ts` (shuffled branch order), including
 *        the resolution-triggering paths.
 *   2. IDENTITY        m(B, [ε]) ≡ B
 *      — a branch that changed nothing merges as a no-op: the committed graph
 *        is unchanged and the report is empty.
 *   3. DIFF-COHERENCE  m(B, [B + d]) ≡ B + d
 *      — a single branch's non-colliding diff is applied FAITHFULLY: the
 *        target's live graph after merge equals the branch's live graph.
 *   4. IDEMPOTENCE     m(B, [a, a′]) ≡ m(B, [a])
 *      — merging an identical twin branch (same mutations under the same
 *        explicit ids, forked from the same base) adds nothing.
 *
 * Laws 2–4 are asserted here over randomized base content and diffs
 * ({@link mergeLawScenarioArb}), on both backends. The scenarios deliberately
 * avoid similarity collisions (pairwise-distinct names below the Dice
 * threshold) so the laws quantify over plain three-way diffs — the regime in
 * which they are claimed to hold.
 */

import type { GraphBackend, Node, NodeId, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../../src/graph-merge/branch";
import { merge } from "../../../src/graph-merge/merge";
import { isOk, unwrap } from "../../../src/graph-merge/result";
import type {
  BranchId,
  GraphBranch,
  MergeOptions,
  SimilarityStrategy,
} from "../../../src/graph-merge/types";
import { asBranchId } from "../../../src/graph-merge/types";
import { backendMatrix } from "../../graph-merge/test-utils";
import type { MergeLawScenario } from "./arbitraries";
import { mergeLawScenarioArb } from "./arbitraries";
import { normalizeGraph, normalizeReport } from "./normalize";

const Patient = defineNode("Patient", {
  schema: z.object({
    name: z.string(),
    birthDate: z.string(),
    mrn: z.string().optional(),
  }),
});

const Encounter = defineNode("Encounter", {
  schema: z.object({ reason: z.string() }),
});

const hadEncounter = defineEdge("hadEncounter", {
  schema: z.object({ on: z.string() }),
  from: [Patient],
  to: [Encounter],
});

const lawGraph = defineGraph({
  id: "merge-law-graph",
  nodes: {
    Patient: { type: Patient },
    Encounter: { type: Encounter },
  },
  edges: {
    hadEncounter: { type: hadEncounter, from: [Patient], to: [Encounter] },
  },
});

type LawGraph = typeof lawGraph;

const DEMO_THRESHOLD = 0.85;
const BRANCH_A = asBranchId("law-branch-a");
const BRANCH_B = asBranchId("law-branch-b");

/**
 * fast-check iterations. Each idempotence iteration boots up to 5 in-process
 * backends (two bases + three branches), so CI runs fewer iterations — same
 * rationale as the determinism gate's run budget.
 */
const LAW_RUNS = process.env.CI ? 8 : 16;

/** In-memory Dice trigram over the `name` field (no embeddings). */
const nameSimilarity: SimilarityStrategy<LawGraph> = {
  kind: "fulltext",
  fields: ["name"],
};

/** Blocks patients by `birthDate`, bounding the O(n²) comparisons. */
function blockByBirthDate(node: Node): string | undefined {
  return (node as unknown as { birthDate?: string }).birthDate;
}

/**
 * Realistic merge options — resolution CONFIGURED (so the laws hold under the
 * options real callers use), but the scenario data guarantees nothing clusters.
 */
function lawMergeOptions(
  branchOrder: readonly BranchId[],
): MergeOptions<LawGraph> {
  return {
    resolve: {
      Patient: {
        block: (node) => blockByBirthDate(node),
        similarity: nameSimilarity,
        threshold: DEMO_THRESHOLD,
      },
    },
    onPropertyConflict: "flag",
    onDeleteModifyConflict: "flag",
    branchOrder,
  };
}

/** Explicit, scenario-stable ids (never random — see arbitraries.ts header). */
const INHERITED_ID = "pat-inherited";
const ANCHOR_PATIENT_ID = "pat-anchor";
const ANCHOR_ENCOUNTER_ID = "enc-anchor";
const ANCHOR_EDGE_ID = "edge-anchor";
const ADDED_PATIENT_ID = "pat-added";
const ADDED_ENCOUNTER_ID = "enc-added";
const ADDED_EDGE_ID = "edge-added";

describe.each(backendMatrix())("merge law properties [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[];

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  async function makeBackend(
    disposers: (() => Promise<void>)[],
  ): Promise<GraphBackend> {
    const fixture = await entry.make();
    disposers.push(fixture.cleanup);
    return fixture.backend;
  }

  /**
   * Materializes the scenario's base store: the edge-free inherited patient
   * plus the static anchor content (patient + encounter + edge) that every
   * merge must pass through untouched. The inherited patient's BRANDED id is
   * captured at creation (the id VALUE is identical across branch clones) so
   * the diff can drive `update`/`delete` in any clone.
   */
  async function materializeBase(
    scenario: MergeLawScenario,
    disposers: (() => Promise<void>)[],
  ): Promise<
    Readonly<{
      base: Store<LawGraph>;
      inheritedNodeId: NodeId<typeof Patient>;
    }>
  > {
    const [base] = await createStoreWithSchema(
      lawGraph,
      await makeBackend(disposers),
    );

    const [inherited] = await base.nodes.Patient.bulkCreate([
      {
        id: INHERITED_ID,
        props: {
          name: scenario.inherited.name,
          birthDate: scenario.inherited.birthDate,
          mrn: scenario.inherited.mrn,
        },
      },
      {
        id: ANCHOR_PATIENT_ID,
        props: {
          name: scenario.anchor.name,
          birthDate: scenario.anchor.birthDate,
        },
      },
    ]);
    await base.nodes.Encounter.bulkCreate([
      {
        id: ANCHOR_ENCOUNTER_ID,
        props: { reason: scenario.anchor.encounterReason },
      },
    ]);
    await base.edges.hadEncounter.bulkCreate([
      {
        id: ANCHOR_EDGE_ID,
        from: { kind: "Patient", id: ANCHOR_PATIENT_ID },
        to: { kind: "Encounter", id: ANCHOR_ENCOUNTER_ID },
        props: { on: scenario.anchor.edgeOn },
      },
    ]);

    return { base, inheritedNodeId: inherited!.id };
  }

  /**
   * Applies the scenario's diff `d` to a branch store: the inherited action
   * (none / update / delete) plus the additions (patient + encounter + edge).
   * Applied identically to twin branches so their staged diffs are id-for-id
   * and prop-for-prop equal.
   */
  async function applyDiff(
    store: Store<LawGraph>,
    scenario: MergeLawScenario,
    inheritedNodeId: NodeId<typeof Patient>,
  ): Promise<void> {
    switch (scenario.inheritedAction) {
      case "update": {
        await store.nodes.Patient.update(inheritedNodeId, {
          mrn: scenario.inherited.updatedMrn,
        });
        break;
      }
      case "delete": {
        await store.nodes.Patient.delete(inheritedNodeId);
        break;
      }
      case "none": {
        break;
      }
    }

    await store.nodes.Patient.bulkCreate([
      {
        id: ADDED_PATIENT_ID,
        props: {
          name: scenario.added.name,
          birthDate: scenario.added.birthDate,
          mrn: scenario.added.mrn,
        },
      },
    ]);
    await store.nodes.Encounter.bulkCreate([
      {
        id: ADDED_ENCOUNTER_ID,
        props: { reason: scenario.added.encounterReason },
      },
    ]);
    await store.edges.hadEncounter.bulkCreate([
      {
        id: ADDED_EDGE_ID,
        from: { kind: "Patient", id: ADDED_PATIENT_ID },
        to: { kind: "Encounter", id: ADDED_ENCOUNTER_ID },
        props: { on: scenario.added.edgeOn },
      },
    ]);
  }

  async function makeBranch(
    base: Store<LawGraph>,
    id: BranchId,
    disposers: (() => Promise<void>)[],
  ): Promise<GraphBranch<LawGraph>> {
    return unwrap(
      await branch<LawGraph>(base, () => makeBackend(disposers), { id }),
    );
  }

  it(
    "IDENTITY — an unchanged branch merges as a no-op",
    { timeout: 300_000 },
    async () => {
      cleanups = [];
      await fc.assert(
        fc.asyncProperty(mergeLawScenarioArb, async (scenario) => {
          const disposers: (() => Promise<void>)[] = [];
          try {
            const { base } = await materializeBase(scenario, disposers);
            const before = await normalizeGraph(base);

            const unchanged = await makeBranch(base, BRANCH_A, disposers);
            const result = await merge<LawGraph>(
              base,
              [unchanged],
              lawMergeOptions([BRANCH_A]),
            );

            expect(isOk(result)).toBe(true);
            if (!isOk(result)) {
              return;
            }

            const report = normalizeReport(result.data, [BRANCH_A]);
            expect(report.merged).toEqual({ nodes: 0, edges: 0 });
            expect(report.resolutions).toEqual([]);
            expect(report.conflicts).toEqual([]);
            expect(report.deleteModifyConflicts).toEqual([]);
            expect(report.typeReconciliations).toEqual([]);
            expect(report.dropped).toEqual([]);
            expect(report.baseAmbiguities).toEqual([]);

            const after = await normalizeGraph(base);
            expect(after).toEqual(before);
          } finally {
            for (const dispose of disposers) {
              await dispose();
            }
          }
        }),
        { numRuns: LAW_RUNS },
      );
    },
  );

  it(
    "DIFF-COHERENCE — a single branch's non-colliding diff is applied faithfully",
    { timeout: 300_000 },
    async () => {
      cleanups = [];
      await fc.assert(
        fc.asyncProperty(mergeLawScenarioArb, async (scenario) => {
          const disposers: (() => Promise<void>)[] = [];
          try {
            const { base, inheritedNodeId } = await materializeBase(
              scenario,
              disposers,
            );
            const mutated = await makeBranch(base, BRANCH_A, disposers);
            await applyDiff(mutated.store, scenario, inheritedNodeId);

            const result = await merge<LawGraph>(
              base,
              [mutated],
              lawMergeOptions([BRANCH_A]),
            );

            expect(isOk(result)).toBe(true);
            if (!isOk(result)) {
              return;
            }

            // The law itself: target's live graph == the branch's live graph.
            const targetGraph = await normalizeGraph(base);
            const branchGraph = await normalizeGraph(mutated.store);
            expect(targetGraph).toEqual(branchGraph);

            // With one branch and no similarity collisions, nothing may be
            // resolved, conflicted, or dropped along the way.
            const report = normalizeReport(result.data, [BRANCH_A]);
            expect(report.resolutions).toEqual([]);
            expect(report.conflicts).toEqual([]);
            expect(report.deleteModifyConflicts).toEqual([]);
            expect(report.dropped).toEqual([]);
          } finally {
            for (const dispose of disposers) {
              await dispose();
            }
          }
        }),
        { numRuns: LAW_RUNS },
      );
    },
  );

  it(
    "IDEMPOTENCE — merging an identical twin branch adds nothing",
    { timeout: 300_000 },
    async () => {
      cleanups = [];
      await fc.assert(
        fc.asyncProperty(mergeLawScenarioArb, async (scenario) => {
          const disposers: (() => Promise<void>)[] = [];
          try {
            // Twin run: two branches with the SAME diff under the SAME ids.
            const twin = await materializeBase(scenario, disposers);
            const twinA = await makeBranch(twin.base, BRANCH_A, disposers);
            const twinB = await makeBranch(twin.base, BRANCH_B, disposers);
            await applyDiff(twinA.store, scenario, twin.inheritedNodeId);
            await applyDiff(twinB.store, scenario, twin.inheritedNodeId);

            // Single run: one branch with the same diff, from an id-for-id
            // identical second materialization of the same scenario.
            const solo = await materializeBase(scenario, disposers);
            const single = await makeBranch(solo.base, BRANCH_A, disposers);
            await applyDiff(single.store, scenario, solo.inheritedNodeId);

            const twinResult = await merge<LawGraph>(
              twin.base,
              [twinA, twinB],
              lawMergeOptions([BRANCH_A, BRANCH_B]),
            );
            const singleResult = await merge<LawGraph>(
              solo.base,
              [single],
              lawMergeOptions([BRANCH_A]),
            );

            expect(isOk(twinResult)).toBe(true);
            expect(isOk(singleResult)).toBe(true);
            if (!isOk(twinResult) || !isOk(singleResult)) {
              return;
            }

            // The law itself: identical twins commit the same graph as one.
            const twinGraph = await normalizeGraph(twin.base);
            const singleGraph = await normalizeGraph(solo.base);
            expect(twinGraph).toEqual(singleGraph);

            // Identical props can never conflict, and identical diffs commit
            // the same number of rows.
            const twinReport = normalizeReport(twinResult.data, [
              BRANCH_A,
              BRANCH_B,
            ]);
            const singleReport = normalizeReport(singleResult.data, [BRANCH_A]);
            expect(twinReport.conflicts).toEqual([]);
            expect(singleReport.conflicts).toEqual([]);
            expect(twinReport.deleteModifyConflicts).toEqual([]);
            expect(twinReport.merged).toEqual(singleReport.merged);
          } finally {
            for (const dispose of disposers) {
              await dispose();
            }
          }
        }),
        { numRuns: LAW_RUNS },
      );
    },
  );
});
