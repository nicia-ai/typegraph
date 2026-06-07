/**
 * Fuzzed new-vs-base permutation-invariance gate (review #5; design §6.4-B / §7).
 *
 * The headline determinism property (`determinism.test.ts`) drives the public
 * `merge()` snapshot path, where base sources are never active. The single-scenario
 * `new-vs-base-determinism.test.ts` proves permutation-invariance for ONE fixed
 * 2-branch case with DISTINCT base entities. Neither fuzzes the new-vs-base axis, and
 * the path most likely to leak emission order — MULTIPLE branches re-discovering the
 * SAME committed base entity (same unique value) — was untested.
 *
 * This gate closes that gap: a fast-check scenario seeds a target with committed base
 * patients and two read-only branches whose new patients:
 *
 *   - collide on `mrn` with the base (forced new↔base merges),
 *   - sometimes collide on `mrn` with each other across branches (same-base
 *     re-discovery),
 *   - sometimes share an independent `cohort` despite DIFFERENT `mrn`s
 *     (base-a ~ new-1 ~ new-2 ~ base-b ambiguity).
 *
 * Shuffling the branch order MUST yield a deep-equal normalized report and a
 * deep-equal committed graph, with base sources active, on BOTH backends. The
 * property also asserts that at least one run produces non-empty `baseAmbiguities`,
 * so the base-guard portion cannot silently regress to vacuous coverage.
 *
 * forkBase + branches are READ-ONLY under `mergeAgainstBase` (it diffs against them
 * and commits to `target`), so they are built ONCE and reused across the two orders;
 * only the two `target`s are independent so their committed graphs are comparable.
 */

import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../../src/graph-merge/branch";
import { mergeAgainstBase } from "../../../src/graph-merge/merge";
import { isOk, unwrap } from "../../../src/graph-merge/result";
import type {
  BranchId,
  GraphBranch,
  MergeOptions,
} from "../../../src/graph-merge/types";
import { asBranchId } from "../../../src/graph-merge/types";
import { backendMatrix } from "../../graph-merge/test-utils";
import { normalizeGraph, normalizeReport } from "./normalize";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), mrn: z.string(), cohort: z.string() }),
});

const careGraph = defineGraph({
  id: "nvb-prop-care",
  nodes: {
    Patient: {
      type: Patient,
      unique: [
        {
          name: "mrn_unique",
          fields: ["mrn"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});
type CareGraph = typeof careGraph;

const A = asBranchId("provider-a");
const B = asBranchId("provider-b");
const FIXED_ORDER: readonly BranchId[] = [A, B];

/**
 * fast-check iterations. Each run boots 5 backends (forkBase + two branches + two
 * targets); PGlite (in-process WASM Postgres) makes that the slow axis, so CI runs
 * fewer (still meaningful — the deterministic new-vs-base tests pin the same paths on
 * both backends). A dev box runs the full set.
 */
const RUNS = process.env.CI ? 8 : 16;

/**
 * A new patient a branch stages: keyed by `mrn` for forced unique matches, and
 * separately blocked by `cohort` so the fuzzer can generate different-mrn fuzzy
 * bridges across committed base identities.
 */
type NewPatient = Readonly<{ mrn: string; name: string; cohort: string }>;

/** Committed-base mrn pool. `MN` is deliberately ABSENT — a novel cross-branch key. */
const BASE_POOL = ["M0", "M1", "M2", "M3", "MA", "MB"] as const;
const BRIDGE_A: NewPatient = {
  mrn: "MA",
  name: "Anna Rivera",
  cohort: "C-BRIDGE",
};
const BRIDGE_B: NewPatient = {
  mrn: "MB",
  name: "Ana Rivera",
  cohort: "C-BRIDGE",
};

/**
 * Per-branch candidate patients with UNIQUE mrns within each list (so a `subarray`
 * is always a valid single-branch store under the `mrn` unique constraint). The
 * overlapping mrns across A and B (`M0`, `M2`, `MN`) are where two branches
 * re-discover the same entity at once.
 */
const A_CANDIDATES: readonly NewPatient[] = [
  { mrn: "M0", name: "Anna Rivera", cohort: "C-M0" },
  { mrn: "M1", name: "Bob Lee", cohort: "C-M1" },
  { mrn: "M2", name: "Cara Diaz", cohort: "C-M2" },
  { mrn: "MN", name: "Dora Vale", cohort: "C-MN" },
  BRIDGE_A,
];
const B_CANDIDATES: readonly NewPatient[] = [
  { mrn: "M0", name: "Ana Rivera", cohort: "C-M0" },
  { mrn: "M2", name: "Cora Diaz", cohort: "C-M2" },
  { mrn: "M3", name: "Evan Poe", cohort: "C-M3" },
  { mrn: "MN", name: "Dara Vale", cohort: "C-MN" },
  BRIDGE_B,
];

type NvbScenario = Readonly<{
  baseMrns: readonly string[];
  branchA: readonly NewPatient[];
  branchB: readonly NewPatient[];
}>;

const BRIDGE_EXAMPLE: NvbScenario = {
  baseMrns: ["MA", "MB"],
  branchA: [BRIDGE_A],
  branchB: [BRIDGE_B],
};

/**
 * The general scenario arbitrary. `subarray` over unique-mrn sources guarantees
 * every single-branch store is valid, while the shared mrns produce the same-base
 * multi-branch collisions (base + A + B onto one entity) and novel new↔new
 * collisions (`MN`, never in base).
 */
const generalScenarioArb: fc.Arbitrary<NvbScenario> = fc.record({
  baseMrns: fc.subarray([...BASE_POOL], { minLength: 0, maxLength: 6 }),
  branchA: fc.subarray([...A_CANDIDATES], { minLength: 0, maxLength: 5 }),
  branchB: fc.subarray([...B_CANDIDATES], { minLength: 0, maxLength: 5 }),
});

const A_NON_BRIDGE = A_CANDIDATES.filter((patient) => patient !== BRIDGE_A);
const B_NON_BRIDGE = B_CANDIDATES.filter((patient) => patient !== BRIDGE_B);
const NON_BRIDGE_BASE_POOL = BASE_POOL.filter(
  (mrn) => mrn !== BRIDGE_A.mrn && mrn !== BRIDGE_B.mrn,
);

/**
 * A biased bridge arbitrary: every generated value contains two different-mrn
 * staged nodes sharing one cohort, plus both matching base mrns. That creates the
 * base-a ~ new-1 ~ new-2 ~ base-b component shape the general arbitrary only hits
 * by chance.
 */
const bridgeScenarioArb: fc.Arbitrary<NvbScenario> = fc
  .record({
    extraBaseMrns: fc.subarray([...NON_BRIDGE_BASE_POOL], {
      minLength: 0,
      maxLength: 4,
    }),
    branchAExtras: fc.subarray([...A_NON_BRIDGE], {
      minLength: 0,
      maxLength: 4,
    }),
    branchBExtras: fc.subarray([...B_NON_BRIDGE], {
      minLength: 0,
      maxLength: 4,
    }),
  })
  .map(({ extraBaseMrns, branchAExtras, branchBExtras }) => ({
    baseMrns: [BRIDGE_A.mrn, BRIDGE_B.mrn, ...extraBaseMrns],
    branchA: [BRIDGE_A, ...branchAExtras],
    branchB: [BRIDGE_B, ...branchBExtras],
  }));

const nvbScenarioArb: fc.Arbitrary<NvbScenario> = fc.oneof(
  generalScenarioArb,
  bridgeScenarioArb,
);

function options(
  target: GraphBranch<CareGraph>["store"],
): MergeOptions<CareGraph> {
  return {
    target,
    resolve: {
      Patient: {
        block: (node) => (node as unknown as { cohort?: string }).cohort,
        similarity: { kind: "fulltext", fields: ["name"] },
        threshold: 0.85,
      },
    },
    onPropertyConflict: "flag",
    branchOrder: FIXED_ORDER,
  };
}

describe.each(backendMatrix())(
  "new-vs-base determinism property — shuffled branch order [$name]",
  (entry) => {
    async function makeBackend(
      disposers: (() => Promise<void>)[],
    ): Promise<GraphBackend> {
      const fixture = await entry.make();
      disposers.push(fixture.cleanup);
      return fixture.backend;
    }

    /** Seeds a branch's new patients under stable `${label}-${mrn}` ids. */
    async function seedBranch(
      target: GraphBranch<CareGraph>,
      label: string,
      news: readonly NewPatient[],
    ): Promise<void> {
      if (news.length === 0) {
        return;
      }
      await target.store.nodes.Patient.bulkCreate(
        news.map((patient) => ({
          id: `${label}-${patient.mrn}`,
          props: {
            name: patient.name,
            mrn: patient.mrn,
            cohort: patient.cohort,
          },
        })),
      );
    }

    /** A fresh target seeded with the committed base patients under `base-${mrn}` ids. */
    async function seededTarget(
      disposers: (() => Promise<void>)[],
      baseMrns: readonly string[],
    ): Promise<GraphBranch<CareGraph>["store"]> {
      const [target] = await createStoreWithSchema(
        careGraph,
        await makeBackend(disposers),
      );
      if (baseMrns.length > 0) {
        await target.nodes.Patient.bulkCreate(
          baseMrns.map((mrn) => ({
            id: `base-${mrn}`,
            props: { name: `Base-${mrn}`, mrn, cohort: `BASE-${mrn}` },
          })),
        );
      }
      return target;
    }

    it(
      "yields a deep-equal normalized report + committed graph for either branch order",
      { timeout: 300_000 },
      async () => {
        let nonEmptyBaseAmbiguityRuns = 0;
        await fc.assert(
          fc.asyncProperty(nvbScenarioArb, async (scenario) => {
            const disposers: (() => Promise<void>)[] = [];
            try {
              // forkBase + branches are read-only across both runs; reuse them.
              const [forkBase] = await createStoreWithSchema(
                careGraph,
                await makeBackend(disposers),
              );
              const branchA = unwrap(
                await branch<CareGraph>(
                  forkBase,
                  () => makeBackend(disposers),
                  { id: A },
                ),
              );
              const branchB = unwrap(
                await branch<CareGraph>(
                  forkBase,
                  () => makeBackend(disposers),
                  { id: B },
                ),
              );
              await seedBranch(branchA, "a", scenario.branchA);
              await seedBranch(branchB, "b", scenario.branchB);

              const targetNatural = await seededTarget(
                disposers,
                scenario.baseMrns,
              );
              const targetShuffled = await seededTarget(
                disposers,
                scenario.baseMrns,
              );

              const naturalResult = await mergeAgainstBase<CareGraph>(
                forkBase,
                [branchA, branchB],
                options(targetNatural),
              );
              // Always the REVERSED order — with two branches that is the only
              // non-trivial permutation, so every run actually exercises order
              // independence (the prior `reverse` boolean made ~half the runs
              // re-run the natural order and assert nothing).
              const shuffledResult = await mergeAgainstBase<CareGraph>(
                forkBase,
                [branchB, branchA],
                options(targetShuffled),
              );

              expect(isOk(naturalResult)).toBe(true);
              expect(isOk(shuffledResult)).toBe(true);
              if (!isOk(naturalResult) || !isOk(shuffledResult)) {
                return;
              }

              expect(shuffledResult.data.baseAmbiguities.length).toBe(
                naturalResult.data.baseAmbiguities.length,
              );
              if (naturalResult.data.baseAmbiguities.length > 0) {
                nonEmptyBaseAmbiguityRuns += 1;
              }

              expect(normalizeReport(shuffledResult.data, FIXED_ORDER)).toEqual(
                normalizeReport(naturalResult.data, FIXED_ORDER),
              );
              expect(await normalizeGraph(targetShuffled)).toEqual(
                await normalizeGraph(targetNatural),
              );
            } finally {
              for (const dispose of disposers) {
                await dispose();
              }
            }
          }),
          { numRuns: RUNS, examples: [[BRIDGE_EXAMPLE]] },
        );
        expect(nonEmptyBaseAmbiguityRuns).toBeGreaterThan(0);
      },
    );
  },
);
