/**
 * `baseKey` source contract (design §6.2, descriptor-backed block key). Drives
 * `mergeAgainstBase` end-to-end over a kind whose NEW-vs-BASE block key is a declared
 * TypeGraph node index (`defineNodeIndex`), named via `ResolveConfig.blockIndex`, and
 * proves the source's defining behaviours:
 *
 *   - a staged node sharing a committed node's INDEX key becomes a SCORED candidate
 *     pair — it merges (base-id-wins) only when it CLEARS the kind's threshold;
 *   - a shared index key is NOT definitional: a same-key pair BELOW threshold does
 *     NOT merge (the contrast with `baseUnique`'s forced edge);
 *   - a different index key is never even compared (the blocking reduction holds
 *     against the base, not just staged-vs-staged).
 *
 * The kind has NO unique constraint, so `baseUnique` contributes nothing and `baseKey`
 * is the only base source doing work. The branch forks from an EMPTY fork-point; the
 * committed base lives in a separate TARGET (the evolved-base shape). Both backends.
 */
import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  defineNodeIndex,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { mergeAgainstBase } from "../../src/graph-merge/merge";
import { isOk, unwrap } from "../../src/graph-merge/result";
import type { GraphBranch, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), cohort: z.string() }),
});
// The NEW-vs-BASE block key: a declared, indexed field-set (here `cohort`). This is
// the queryable surface `baseKey` looks committed nodes up against.
const patientCohort = defineNodeIndex(Patient, {
  name: "patient_cohort_idx",
  fields: ["cohort"],
});

const careGraph = defineGraph({
  id: "base-key-care",
  // No unique constraint on Patient — so `baseUnique` is a no-op and `baseKey` owns
  // new-vs-base recall for this kind.
  nodes: { Patient: { type: Patient } },
  edges: {},
  indexes: [patientCohort],
});
type CareGraph = typeof careGraph;
type CareStore = GraphBranch<CareGraph>["store"];

const BRANCH = asBranchId("provider-x");

function mergeOptions(target: CareStore): MergeOptions<CareGraph> {
  return {
    target,
    resolve: {
      Patient: {
        // No staged-vs-staged `block`; the new-vs-base key is the declared index.
        blockIndex: "patient_cohort_idx",
        similarity: { kind: "fulltext", fields: ["name"] },
        threshold: 0.85,
      },
    },
    onPropertyConflict: "flag",
    branchOrder: [BRANCH],
  };
}

describe.each(backendMatrix())("baseKey source [$name]", (entry) => {
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

  async function emptyStore(): Promise<CareStore> {
    const [store] = await createStoreWithSchema(careGraph, await makeBackend());
    return store;
  }

  async function forkOf(forkBase: CareStore): Promise<GraphBranch<CareGraph>> {
    return unwrap(
      await branch<CareGraph>(forkBase, () => makeBackend(), { id: BRANCH }),
    );
  }

  /** Seeds the target with one committed base patient and returns it. */
  async function targetWithBase(
    id: string,
    props: { name: string; cohort: string },
  ): Promise<CareStore> {
    const target = await emptyStore();
    await target.nodes.Patient.bulkCreate([{ id, props }]);
    return target;
  }

  it("MERGES a staged node sharing the index key when it clears the threshold (base-id-wins)", async () => {
    cleanups = [];
    const forkBase = await emptyStore();
    const provider = await forkOf(forkBase);
    // Same cohort as the committed base, near-duplicate name (Dice ≈ 0.857 ≥ 0.85).
    await provider.store.nodes.Patient.bulkCreate([
      { id: "new-1", props: { name: "Anna Rivera", cohort: "C1" } },
    ]);
    const target = await targetWithBase("base-1", {
      name: "Ana Rivera",
      cohort: "C1",
    });

    const result = await mergeAgainstBase<CareGraph>(
      forkBase,
      [provider],
      mergeOptions(target),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }
    // Absorbed onto the committed base id (no duplicate), base value kept (keep-base).
    const patients = await target.nodes.Patient.find();
    expect(patients.map((patient) => patient.id)).toEqual(["base-1"]);
    expect(requireDefined(patients[0]).name).toBe("Ana Rivera");
    expect(result.data.resolutions.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT merge a same-index-key pair below threshold (a block key is a candidate, not a forced match)", async () => {
    cleanups = [];
    const forkBase = await emptyStore();
    const provider = await forkOf(forkBase);
    // Same cohort (so it IS proposed as a pair) but a dissimilar name (below 0.85).
    await provider.store.nodes.Patient.bulkCreate([
      { id: "new-2", props: { name: "Zachary Quux", cohort: "C1" } },
    ]);
    const target = await targetWithBase("base-1", {
      name: "Ana Rivera",
      cohort: "C1",
    });

    const result = await mergeAgainstBase<CareGraph>(
      forkBase,
      [provider],
      mergeOptions(target),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }
    // Both survive: the shared block key was scored and REJECTED, not force-merged.
    const ids = (await target.nodes.Patient.find())
      .map((patient) => patient.id)
      .sort();
    expect(ids).toEqual(["base-1", "new-2"]);
    expect(result.data.resolutions).toHaveLength(0);
    // The rejected hit must NOT pull the committed base row back into the write set:
    // exactly ONE node is committed (`new-2`); `base-1` is left untouched — no re-commit,
    // no spurious provenance under the base sentinel. (Before the fix this was 2: the
    // orphan base member was seeded as a singleton cluster and re-upserted.)
    expect(result.data.merged.nodes).toBe(1);
  });

  it("never compares a staged node with a DIFFERENT index key (blocking holds vs base)", async () => {
    cleanups = [];
    const forkBase = await emptyStore();
    const provider = await forkOf(forkBase);
    // Near-duplicate name to the base, but a DIFFERENT cohort — so the index lookup
    // never surfaces the base, and the pair is never even proposed.
    await provider.store.nodes.Patient.bulkCreate([
      { id: "new-3", props: { name: "Ana Rivera", cohort: "C2" } },
    ]);
    const target = await targetWithBase("base-1", {
      name: "Ana Rivera",
      cohort: "C1",
    });

    const result = await mergeAgainstBase<CareGraph>(
      forkBase,
      [provider],
      mergeOptions(target),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }
    const ids = (await target.nodes.Patient.find())
      .map((patient) => patient.id)
      .sort();
    expect(ids).toEqual(["base-1", "new-3"]);
    expect(result.data.resolutions).toHaveLength(0);
  });
});
