/**
 * Step 5 contract: the component-level BASE GUARD (design §6.4-A).
 *
 * Single-link clustering is transitive, so two committed base entities fuse through
 * ANY chain — even one where no single new node spans both:
 *
 *     base-a ~ new-1 ~ new-2 ~ base-b
 *       (forced)  (fuzzy)  (forced)
 *
 * new-1 matches base-a by unique value, new-2 matches base-b, and new-1 ~ new-2 is a
 * staged fuzzy edge — so the component bridges TWO committed entities. The guard:
 *
 *   - DEFAULT: refuses the base↔base collapse — drop-weakest splits the component
 *     (containment) so base-a and base-b stay SEPARATE — and reports the ambiguity.
 *   - clusterMaxDiameter: even when the diameter guard splits the chain first, the
 *     base guard (run on the raw components) still reports the ambiguity (§6.4-A).
 *
 * Runs on BOTH backends (new-vs-base semantics parity).
 */

import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { mergeAgainstBase } from "../../src/graph-merge/merge";
import { isOk, unwrap } from "../../src/graph-merge/result";
import type { GraphBranch, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({
    name: z.string(),
    mrn: z.string(),
    cohort: z.string(),
  }),
});

const careGraph = defineGraph({
  id: "base-guard-care",
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

const BRANCH = asBranchId("provider-x");

/** Block by the shared cohort so the two new nodes co-block and fuzzy-match. */
function options(
  target: GraphBranch<CareGraph>["store"],
  clusterMaxDiameter?: number,
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
    branchOrder: [BRANCH],
    ...(clusterMaxDiameter === undefined ? {} : { clusterMaxDiameter }),
  };
}

describe.each(backendMatrix())("component base guard [$name]", (entry) => {
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

  /**
   * Builds the `base-a ~ new-1 ~ new-2 ~ base-b` chain: an empty fork-point, a
   * branch with two near-duplicate new patients (co-blocked by cohort, each keyed to
   * a different committed base mrn), and a target holding the two committed bases.
   */
  async function buildChain(): Promise<{
    forkBase: GraphBranch<CareGraph>["store"];
    provider: GraphBranch<CareGraph>;
    target: GraphBranch<CareGraph>["store"];
  }> {
    const [forkBase] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );
    const provider = unwrap(
      await branch<CareGraph>(forkBase, () => makeBackend(), { id: BRANCH }),
    );
    // Near-duplicate names (Dice ≈ 0.857 ≥ 0.85) so new-1 ~ new-2 is a fuzzy edge
    // STRICTLY weaker than the forced (max-score) new↔base edges — so drop-weakest
    // severs the bridge, not a forced edge.
    await provider.store.nodes.Patient.bulkCreate([
      {
        id: "new-1",
        props: { name: "Anna Rivera", mrn: "MRN-A", cohort: "C1" },
      },
      {
        id: "new-2",
        props: { name: "Ana Rivera", mrn: "MRN-B", cohort: "C1" },
      },
    ]);
    const [target] = await createStoreWithSchema(
      careGraph,
      await makeBackend(),
    );
    await target.nodes.Patient.bulkCreate([
      { id: "base-a", props: { name: "Anna R.", mrn: "MRN-A", cohort: "C0" } },
      { id: "base-b", props: { name: "Ana R.", mrn: "MRN-B", cohort: "C0" } },
    ]);
    return { forkBase, provider, target };
  }

  it("DEFAULT: refuses base↔base collapse — splits to keep both committed entities, reports ambiguity", async () => {
    cleanups = [];
    const { forkBase, provider, target } = await buildChain();

    const result = await mergeAgainstBase<CareGraph>(
      forkBase,
      [provider],
      options(target),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }
    console.info(
      `[${entry.name}] baseAmbiguities:`,
      JSON.stringify(result.data.baseAmbiguities),
    );

    // BOTH committed entities survive, separate — the collapse was refused.
    const patients = await target.nodes.Patient.find();
    const ids = patients.map((p) => p.id).sort();
    console.info(`[${entry.name}] patients:`, ids);
    expect(ids).toEqual(["base-a", "base-b"]);

    // The ambiguity is reported, spanning both base ids.
    expect(result.data.baseAmbiguities).toHaveLength(1);
    const ambiguity = result.data.baseAmbiguities[0]!;
    expect(ambiguity.baseIds.map((identity) => identity.id)).toEqual([
      "base-a",
      "base-b",
    ]);
    // The report carries the full (kind, id) identity, not a bare id.
    expect(ambiguity.baseIds.every((index) => index.kind === "Patient")).toBe(true);
    expect(
      ambiguity.memberIds.map((identity) => identity.id).sort(),
    ).toEqual(["base-a", "base-b", "new-1", "new-2"]);
    expect(ambiguity.memberIds.every((index) => index.kind === "Patient")).toBe(true);

    // Each base absorbed its OWN matching new node — never the other base's.
    const resolutionTargets = result.data.resolutions
      .map((r) => r.canonicalId)
      .sort();
    expect(resolutionTargets).toEqual(["base-a", "base-b"]);
  });

  it("reports the ambiguity even when clusterMaxDiameter splits the chain first (§6.4-A on raw components)", async () => {
    cleanups = [];
    const { forkBase, provider, target } = await buildChain();

    // clusterMaxDiameter: 1 forces the diameter guard to split the 3-hop chain. The
    // base guard runs on the RAW component FIRST, so the base↔base bridge is still
    // detected and the ambiguity reported — the diameter split cannot hide it.
    const result = await mergeAgainstBase<CareGraph>(
      forkBase,
      [provider],
      options(target, 1),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }

    // Ambiguity still reported despite the diameter split.
    expect(result.data.baseAmbiguities).toHaveLength(1);
    expect(
      result.data.baseAmbiguities[0]!.baseIds.map(
        (identity) => identity.id,
      ),
    ).toEqual(["base-a", "base-b"]);

    // Both committed entities still survive, separate.
    const patients = await target.nodes.Patient.find();
    expect(patients.map((p) => p.id).sort()).toEqual(["base-a", "base-b"]);
  });
});
