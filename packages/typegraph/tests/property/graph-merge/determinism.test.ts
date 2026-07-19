/**
 * The headline P0 determinism gate (design §12 / §6.4, T12).
 *
 * For randomly-generated base + branch fixtures, `merge()` MUST be commutative in
 * the branch order: shuffling `branches` yields a deep-equal normalized
 * {@link MergeReport} AND a deep-equal committed graph — on BOTH backends.
 *
 * Why a SHARED base + branches built once:
 *   Each merge run mints no new ids (the duplicate / inherited / ontology nodes
 *   carry ids fixed when the branches are seeded), so the two runs are comparable
 *   id-for-id. We build the base + N branches ONCE, then merge the SAME branch
 *   objects in two orders — the natural order onto a fresh target clone, and a
 *   shuffled order onto a SECOND fresh target clone. `merge()` only READS the
 *   branch stores and WRITES the target, so reusing the branch objects across the
 *   two runs is safe and keeps every id identical between runs.
 *
 *   The `branchOrder` option is held FIXED across both runs — it is the stable,
 *   non-wall-clock tie-break anchor; only the `branches` ARRAY order is shuffled.
 *   If determinism depended on arrival order, the two normalized results would
 *   diverge and the property would fail.
 *
 * Coverage (every order-sensitive path the gate must prove commutative):
 *   - canonical selection + commutative property union (duplicate patient pair),
 *   - set-dedupe edges (both branches' collapsing edges onto one canonical),
 *   - node delete/modify conflicts (T8a — one branch deletes, another modifies),
 *   - ontology type reconciliation (T10 — a shared id staged under Doctor and
 *     SpecialistDoctor collapses to the most-specific kind).
 */
import type { GraphBackend, Node, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  subClassOf,
} from "@nicia-ai/typegraph";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { requireDefined } from "../../../src/utils/presence";
import {
  backendMatrix,
  setupSharedPgliteMergeEngine,
  type SharedPgliteMergeEngine,
} from "../../graph-merge/test-utils";
import type { DeterminismScenario } from "./arbitraries";
import { determinismScenarioArb } from "./arbitraries";
import { normalizeGraph, normalizeReport } from "./normalize";

/**
 * The same FHIR-flavored care graph the T11 merge suite uses: patients with
 * encounters/conditions, plus a `Doctor ⊐ SpecialistDoctor` ontology so
 * `reconcileTypes: "ontology"` is exercised end-to-end.
 */
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

const Doctor = defineNode("Doctor", {
  schema: z.object({ name: z.string() }),
});

const SpecialistDoctor = defineNode("SpecialistDoctor", {
  schema: z.object({ name: z.string() }),
});

const hadEncounter = defineEdge("hadEncounter", {
  schema: z.object({ on: z.string() }),
  from: [Patient],
  to: [Encounter],
});

const careGraph = defineGraph({
  id: "fhir-care-graph",
  nodes: {
    Patient: { type: Patient },
    Encounter: { type: Encounter },
    Doctor: { type: Doctor },
    SpecialistDoctor: { type: SpecialistDoctor },
  },
  edges: {
    hadEncounter: { type: hadEncounter, from: [Patient], to: [Encounter] },
  },
  ontology: [subClassOf(SpecialistDoctor, Doctor)],
});

type CareGraph = typeof careGraph;

const DEMO_THRESHOLD = 0.85;
const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");

/** Stable, non-wall-clock branch order — held FIXED across both merge runs. */
const FIXED_BRANCH_ORDER: readonly BranchId[] = [BRANCH_A, BRANCH_B];

/**
 * fast-check iterations. Each run needs ~6 PGlite-backed stores (two
 * materializations × base + two branches), so CI keeps a smaller run budget even
 * though the PGlite engine is reused with isolated tables within this file. The
 * deterministic, non-property tests pin the same order-independence paths on both
 * backends; a dev box runs the full set.
 */
const DETERMINISM_RUNS = process.env["CI"] ? 12 : 30;

/** In-memory Dice trigram over the `name` field (no embeddings). */
const nameSimilarity: SimilarityStrategy<CareGraph> = {
  kind: "fulltext",
  fields: ["name"],
};

/** Blocks patients by `birthDate`, bounding the O(n²) comparisons. */
function blockByBirthDate(node: Node): string | undefined {
  return (node as unknown as { birthDate?: string }).birthDate;
}

/** Blocks doctors by name so same-name members co-block and can cluster. */
function blockByName(node: Node): string | undefined {
  return (node as unknown as { name?: string }).name;
}

/**
 * The merge options shared by every property run. `reconcileTypes: "ontology"`
 * collapses the Doctor/SpecialistDoctor pair; `onPropertyConflict: "flag"` and
 * `onDeleteModifyConflict: "flag"` surface (not auto-resolve) every conflict; the
 * branch order is FIXED so determinism cannot leak through arrival order.
 */
function determinismMergeOptions(): MergeOptions<CareGraph> {
  return {
    resolve: {
      Patient: {
        block: (node) => blockByBirthDate(node),
        similarity: nameSimilarity,
        threshold: DEMO_THRESHOLD,
      },
      Doctor: {
        block: (node) => blockByName(node),
        similarity: nameSimilarity,
        threshold: DEMO_THRESHOLD,
      },
      SpecialistDoctor: {
        block: (node) => blockByName(node),
        similarity: nameSimilarity,
        threshold: DEMO_THRESHOLD,
      },
    },
    reconcileTypes: "ontology",
    onPropertyConflict: "flag",
    onDeleteModifyConflict: "flag",
    branchOrder: FIXED_BRANCH_ORDER,
  };
}

/** The materialized fixture for one property run: a base + its two branches. */
type Fixture = Readonly<{
  base: Store<CareGraph>;
  branches: readonly GraphBranch<CareGraph>[];
}>;

describe.each(backendMatrix())(
  "determinism property — shuffled branch order [$name]",
  (entry) => {
    let sharedPglite: SharedPgliteMergeEngine | undefined;

    beforeAll(async () => {
      if (entry.name === "PGlite") {
        sharedPglite = await setupSharedPgliteMergeEngine();
      }
    });

    afterAll(async () => {
      await sharedPglite?.dispose();
    });

    async function makeBackend(
      disposers: (() => Promise<void>)[],
    ): Promise<GraphBackend> {
      const fixture =
        sharedPglite === undefined ?
          await entry.make()
        : await sharedPglite.makeFixture();
      disposers.push(fixture.cleanup);
      return fixture.backend;
    }

    /**
     * Materializes a {@link DeterminismScenario} into a fresh base store + two
     * branches. EVERY node and edge is seeded with an EXPLICIT, scenario-derived
     * id (via `bulkCreate`) — never a random nanoid — so two independent
     * materializations of the same scenario produce id-for-id identical graphs.
     * That is what makes the natural-order vs shuffled-order committed graphs
     * deep-comparable: each run merges into its OWN base store, and the two base
     * stores start from identical content.
     *
     * The base carries the inherited patient both branches diverge on; each
     * branch then stages its half of the scenario:
     *
     *   - branch A DELETES the inherited patient, adds the LEFT duplicate name
     *     (with a shared-id encounter edge), a distinct patient, and the ontology
     *     member as a `Doctor`.
     *   - branch B MODIFIES the inherited patient's mrn, adds the RIGHT duplicate
     *     name (with the same shared-id encounter edge + identical props →
     *     set-dedupe), and the ontology member as a `SpecialistDoctor` UNDER THE
     *     SAME id (so the cluster has mixed kinds → reconciliation collapses it).
     */
    async function materialize(
      scenario: DeterminismScenario,
      disposers: (() => Promise<void>)[],
    ): Promise<Fixture> {
      const [base] = await createStoreWithSchema(
        careGraph,
        await makeBackend(disposers),
      );

      // Explicit, scenario-stable ids. The two duplicate patients are DISTINCT
      // ids that cluster; the encounter and ontology member are SHARED ids so the
      // branches' contributions co-locate.
      const inheritedId = "pat-inherited";
      const leftPatientId = "pat-left";
      const rightPatientId = "pat-right";
      const distinctPatientId = "pat-distinct";
      const sharedEncounterId = "enc-shared";
      const sharedOntologyId = "doc-shared";
      const encounterEdgeAId = "edge-enc-a";
      const encounterEdgeBId = "edge-enc-b";

      // Inherited patient both branches will diverge on (delete vs modify, T8a).
      // Capture the created node so its BRANDED id can drive `delete`/`update` in
      // the branch clones (the id value is identical across clones).
      const [inherited] = await base.nodes.Patient.bulkCreate([
        {
          id: inheritedId,
          props: {
            name: scenario.inherited.name,
            birthDate: scenario.inherited.birthDate,
            mrn: scenario.inherited.baseMrn,
          },
        },
      ]);
      const inheritedNodeId = requireDefined(inherited).id;

      const branchA = unwrap(
        await branch<CareGraph>(base, () => makeBackend(disposers), {
          id: BRANCH_A,
        }),
      );
      const branchB = unwrap(
        await branch<CareGraph>(base, () => makeBackend(disposers), {
          id: BRANCH_B,
        }),
      );

      // --- branch A ---------------------------------------------------------
      // Delete the inherited patient (the delete side of the delete/modify pair).
      await branchA.store.nodes.Patient.delete(inheritedNodeId);
      // The LEFT duplicate patient + a shared-id encounter edge onto her.
      await branchA.store.nodes.Patient.bulkCreate([
        {
          id: leftPatientId,
          props: {
            name: scenario.duplicate.pair.left,
            birthDate: scenario.duplicate.birthDate,
            mrn: scenario.duplicate.leftMrn,
          },
        },
      ]);
      await branchA.store.nodes.Encounter.bulkCreate([
        {
          id: sharedEncounterId,
          props: { reason: scenario.duplicate.encounterReason },
        },
      ]);
      await branchA.store.edges.hadEncounter.bulkCreate([
        {
          id: encounterEdgeAId,
          from: { kind: "Patient", id: leftPatientId },
          to: { kind: "Encounter", id: sharedEncounterId },
          props: { on: scenario.duplicate.birthDate },
        },
      ]);
      // A distinct patient that must remain its own singleton (no over-merge).
      await branchA.store.nodes.Patient.bulkCreate([
        {
          id: distinctPatientId,
          props: {
            name: scenario.distinct.name,
            birthDate: scenario.distinct.birthDate,
          },
        },
      ]);
      // The ontology member as a Doctor under the shared id.
      await branchA.store.nodes.Doctor.bulkCreate([
        { id: sharedOntologyId, props: { name: scenario.ontology.pair.left } },
      ]);

      // --- branch B ---------------------------------------------------------
      // Modify the inherited patient's mrn (the modify side of the pair).
      await branchB.store.nodes.Patient.update(inheritedNodeId, {
        mrn: scenario.inherited.modifiedMrn,
      });
      // The RIGHT duplicate patient + the SAME shared-id encounter edge with
      // identical props, so after repoint the two edges set-dedupe to one.
      await branchB.store.nodes.Patient.bulkCreate([
        {
          id: rightPatientId,
          props: {
            name: scenario.duplicate.pair.right,
            birthDate: scenario.duplicate.birthDate,
          },
        },
      ]);
      await branchB.store.nodes.Encounter.bulkCreate([
        {
          id: sharedEncounterId,
          props: { reason: scenario.duplicate.encounterReason },
        },
      ]);
      await branchB.store.edges.hadEncounter.bulkCreate([
        {
          id: encounterEdgeBId,
          from: { kind: "Patient", id: rightPatientId },
          to: { kind: "Encounter", id: sharedEncounterId },
          props: { on: scenario.duplicate.birthDate },
        },
      ]);
      // The ontology member as a SpecialistDoctor UNDER THE SAME id → the cluster
      // has mixed kinds, so reconcileTypes: "ontology" collapses it to the
      // most-specific kind (SpecialistDoctor).
      await branchB.store.nodes.SpecialistDoctor.bulkCreate([
        { id: sharedOntologyId, props: { name: scenario.ontology.pair.right } },
      ]);

      return { base, branches: [branchA, branchB] };
    }

    it(
      "yields a deep-equal normalized report + graph for any branch ordering",
      { timeout: 300_000 },
      async () => {
        await fc.assert(
          fc.asyncProperty(
            determinismScenarioArb,
            fc.boolean(),
            async (scenario, reverse) => {
              // Each property iteration owns its backends and disposes them inline,
              // so PGlite's in-process engines never accumulate across the 30 runs.
              const disposers: (() => Promise<void>)[] = [];
              try {
                // TWO independent materializations of the SAME scenario. Because
                // every node/edge carries an explicit, scenario-derived id, the two
                // base stores start id-for-id identical — so their committed graphs
                // are deep-comparable after merging in different orders.
                const natural = await materialize(scenario, disposers);
                const shuffled = await materialize(scenario, disposers);

                const naturalResult = await merge<CareGraph>(
                  natural.base,
                  natural.branches,
                  determinismMergeOptions(),
                );
                const shuffledBranches =
                  reverse ?
                    [...shuffled.branches].reverse()
                  : shuffled.branches;
                const shuffledResult = await merge<CareGraph>(
                  shuffled.base,
                  shuffledBranches,
                  determinismMergeOptions(),
                );

                expect(isOk(naturalResult)).toBe(true);
                expect(isOk(shuffledResult)).toBe(true);
                if (!isOk(naturalResult) || !isOk(shuffledResult)) {
                  return;
                }

                const branchIds = FIXED_BRANCH_ORDER;
                const naturalReport = normalizeReport(
                  naturalResult.data,
                  branchIds,
                );
                const shuffledReport = normalizeReport(
                  shuffledResult.data,
                  branchIds,
                );
                expect(shuffledReport).toEqual(naturalReport);

                const naturalGraph = await normalizeGraph(natural.base);
                const shuffledGraph = await normalizeGraph(shuffled.base);
                expect(shuffledGraph).toEqual(naturalGraph);

                // The scenario actually exercised the order-sensitive paths: an
                // entity resolution (the duplicate pair), an edge set-dedupe (one
                // surviving hadEncounter), a delete/modify conflict (the inherited
                // patient), and an ontology reconciliation (Doctor → Specialist).
                expect(naturalReport.resolutions.length).toBeGreaterThanOrEqual(
                  1,
                );
                expect(
                  naturalReport.deleteModifyConflicts.length,
                ).toBeGreaterThanOrEqual(1);
                expect(
                  naturalReport.typeReconciliations.length,
                ).toBeGreaterThanOrEqual(1);
              } finally {
                for (const dispose of disposers) {
                  await dispose();
                }
              }
            },
          ),
          { numRuns: DETERMINISM_RUNS },
        );
      },
    );
  },
);
