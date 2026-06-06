/**
 * Step 7: the new-vs-base invariant gates at the SYNTHETIC scope (design §6.4-B,
 * §7), exercising the candidate-source + scoring + reconciler pipeline via
 * `mergeAgainstBase` — bypassing the public-`merge()` snapshot precondition rather
 * than fighting it.
 *
 *   1. FIXED POINT (§6.4-B): re-merging the SAME branch against an already-absorbed,
 *      consistent evolved base is a no-op — the committed graph does not churn.
 *   2. PERMUTATION-INVARIANCE (§7): with base sources ACTIVE, shuffling branch order
 *      yields a deep-equal committed graph and normalized report. This is the
 *      new-axis analogue of the branch-permutation gate; it must hold unconditionally.
 *
 * Both run on BOTH backends. Comparison uses the same canonical `normalizeGraph` /
 * `normalizeReport` the headline determinism gate uses — `normalizeGraph` strips the
 * non-deterministic META (version / timestamps), so an idempotent re-commit (which
 * bumps `version`) still compares equal when the logical graph is unchanged.
 */

import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { mergeAgainstBase } from "../../src/graph-merge/merge";
import { isOk, unwrap } from "../../src/graph-merge/result";
import type { BranchId, GraphBranch, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { normalizeGraph, normalizeReport } from "../property/graph-merge/normalize";
import { backendMatrix } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({
    name: z.string(),
    mrn: z.string(),
    cohort: z.string().optional(),
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

const careGraph = defineGraph({
  id: "nvb-determinism-care",
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
    Encounter: { type: Encounter },
  },
  edges: {
    hadEncounter: { type: hadEncounter, from: [Patient], to: [Encounter] },
  },
});
type CareGraph = typeof careGraph;

const A = asBranchId("provider-a");
const B = asBranchId("provider-b");
const FIXED_ORDER: readonly BranchId[] = [A, B];

function options(
  target: GraphBranch<CareGraph>["store"],
): MergeOptions<CareGraph> {
  return {
    target,
    resolve: {
      Patient: {
        block: (node) => (node as unknown as { mrn?: string }).mrn,
        similarity: { kind: "fulltext", fields: ["name"] },
        threshold: 0.85,
      },
    },
    onPropertyConflict: "flag",
    branchOrder: FIXED_ORDER,
  };
}

function cohortOptions(
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

describe.each(backendMatrix())("new-vs-base invariants [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[];

  afterEach(async () => {
    for (const cleanup of cleanups ?? []) {
      await cleanup();
    }
    cleanups = [];
  });

  async function makeBackend(): Promise<GraphBackend> {
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  it("FIXED POINT: re-merging the same branch against the evolved base does not churn", async () => {
    cleanups = [];
    const [forkBase] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );
    const provider = unwrap(
      await branch<CareGraph>(forkBase, () => makeBackend(), { id: A }),
    );
    // Consistent with the base (same name) + an encounter edge to exercise repoint
    // idempotency across the re-merge.
    await provider.store.nodes.Patient.bulkCreate([
      { id: "new-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
    ]);
    await provider.store.nodes.Encounter.bulkCreate([
      { id: "enc-1", props: { reason: "checkup" } },
    ]);
    await provider.store.edges.hadEncounter.bulkCreate([
      {
        id: "edge-1",
        from: { kind: "Patient", id: "new-ana" },
        to: { kind: "Encounter", id: "enc-1" },
        props: { on: "2026-06-04" },
      },
    ]);

    const [target] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );
    await target.nodes.Patient.bulkCreate([
      { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
    ]);

    // First merge: absorb new-ana into base-ana, commit enc + repointed edge.
    const first = await mergeAgainstBase<CareGraph>(
      forkBase,
      [provider],
      options(target),
    );
    expect(isOk(first)).toBe(true);
    const afterFirst = await normalizeGraph(target);

    // Second merge of the SAME branch against the now-evolved base.
    const second = await mergeAgainstBase<CareGraph>(
      forkBase,
      [provider],
      options(target),
    );
    expect(isOk(second)).toBe(true);
    const afterSecond = await normalizeGraph(target);

    // No churn: the committed graph is byte-identical after the re-merge.
    expect(afterSecond).toEqual(afterFirst);
    // And it really did absorb (one Patient, the committed base id).
    const patients = await target.nodes.Patient.find();
    expect(patients.map((p) => p.id)).toEqual(["base-ana"]);
  });

  it("PERMUTATION-INVARIANCE: shuffling branch order is identical with base sources active", async () => {
    cleanups = [];
    // One fork-point + two read-only branches, each re-discovering a DIFFERENT
    // committed base entity. Merged into two identically-seeded targets in opposite
    // orders.
    const [forkBase] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );
    const branchA = unwrap(
      await branch<CareGraph>(forkBase, () => makeBackend(), { id: A }),
    );
    await branchA.store.nodes.Patient.bulkCreate([
      { id: "new-ana", props: { name: "Ana Rivera", mrn: "MRN-1" } },
    ]);
    const branchB = unwrap(
      await branch<CareGraph>(forkBase, () => makeBackend(), { id: B }),
    );
    await branchB.store.nodes.Patient.bulkCreate([
      { id: "new-bob", props: { name: "Bobby Lee", mrn: "MRN-2" } },
    ]);

    async function seededTarget(): Promise<GraphBranch<CareGraph>["store"]> {
      const [target] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
      );
      await target.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
        { id: "base-bob", props: { name: "Bob Lee", mrn: "MRN-2" } },
      ]);
      return target;
    }

    const targetNatural = await seededTarget();
    const targetReversed = await seededTarget();

    const natural = await mergeAgainstBase<CareGraph>(
      forkBase,
      [branchA, branchB],
      options(targetNatural),
    );
    const reversed = await mergeAgainstBase<CareGraph>(
      forkBase,
      [branchB, branchA],
      options(targetReversed),
    );
    expect(isOk(natural) && isOk(reversed)).toBe(true);
    if (!isOk(natural) || !isOk(reversed)) {
      return;
    }

    // Deep-equal normalized report AND committed graph across the two orderings.
    expect(normalizeReport(reversed.data, FIXED_ORDER)).toEqual(
      normalizeReport(natural.data, FIXED_ORDER),
    );
    expect(await normalizeGraph(targetReversed)).toEqual(
      await normalizeGraph(targetNatural),
    );

    // The run actually exercised base resolution (both new nodes absorbed).
    expect(natural.data.resolutions.length).toBeGreaterThanOrEqual(2);
    const ids = (await targetNatural.nodes.Patient.find())
      .map((p) => p.id)
      .sort();
    expect(ids).toEqual(["base-ana", "base-bob"]);
  });

  it("PERMUTATION-INVARIANCE: reports non-empty base ambiguities deterministically", async () => {
    cleanups = [];
    // Same `base-a ~ new-1 ~ new-2 ~ base-b` chain as the base-guard contract,
    // but split across two branches so the determinism reducer sees a real,
    // non-empty baseAmbiguities report under branch-order permutation.
    const [forkBase] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );
    const branchA = unwrap(
      await branch<CareGraph>(forkBase, () => makeBackend(), { id: A }),
    );
    await branchA.store.nodes.Patient.bulkCreate([
      {
        id: "new-1",
        props: { name: "Anna Rivera", mrn: "MRN-A", cohort: "C1" },
      },
    ]);
    const branchB = unwrap(
      await branch<CareGraph>(forkBase, () => makeBackend(), { id: B }),
    );
    await branchB.store.nodes.Patient.bulkCreate([
      {
        id: "new-2",
        props: { name: "Ana Rivera", mrn: "MRN-B", cohort: "C1" },
      },
    ]);

    async function seededTarget(): Promise<GraphBranch<CareGraph>["store"]> {
      const [target] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
      );
      await target.nodes.Patient.bulkCreate([
        {
          id: "base-a",
          props: { name: "Anna R.", mrn: "MRN-A", cohort: "C0" },
        },
        {
          id: "base-b",
          props: { name: "Ana R.", mrn: "MRN-B", cohort: "C0" },
        },
      ]);
      return target;
    }

    const targetNatural = await seededTarget();
    const targetReversed = await seededTarget();

    const natural = await mergeAgainstBase<CareGraph>(
      forkBase,
      [branchA, branchB],
      cohortOptions(targetNatural),
    );
    const reversed = await mergeAgainstBase<CareGraph>(
      forkBase,
      [branchB, branchA],
      cohortOptions(targetReversed),
    );
    expect(isOk(natural) && isOk(reversed)).toBe(true);
    if (!isOk(natural) || !isOk(reversed)) {
      return;
    }

    expect(natural.data.baseAmbiguities).toHaveLength(1);
    expect(reversed.data.baseAmbiguities).toHaveLength(1);
    expect(normalizeReport(reversed.data, FIXED_ORDER)).toEqual(
      normalizeReport(natural.data, FIXED_ORDER),
    );
    expect(await normalizeGraph(targetReversed)).toEqual(
      await normalizeGraph(targetNatural),
    );

    const ambiguity = natural.data.baseAmbiguities[0]!;
    expect(
      ambiguity.baseIds
        .map((identity) => `${identity.kind}:${identity.id}`)
        .sort(),
    ).toEqual(["Patient:base-a", "Patient:base-b"]);
    expect(
      ambiguity.memberIds
        .map((identity) => `${identity.kind}:${identity.id}`)
        .sort(),
    ).toEqual([
      "Patient:base-a",
      "Patient:base-b",
      "Patient:new-1",
      "Patient:new-2",
    ]);
  });
});
