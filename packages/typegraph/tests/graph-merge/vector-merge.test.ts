/**
 * End-to-end vector/hybrid similarity through `merge()` (real embeddings path).
 *
 * Exercises the whole injected-embedder flow — precompute the staged texts'
 * vectors, score candidate pairs by in-memory cosine, cluster, canonicalize — on
 * BOTH backends, using the deterministic offline {@link fakeEmbedder} (no model
 * download). Three properties:
 *
 *   1. a `hybrid` strategy WITH an embedder resolves the near-duplicate patient
 *      pair into ONE canonical survivor (the duplicate the fulltext demo resolves,
 *      now via real cosine + trigram blend);
 *   2. the result is ORDER-INDEPENDENT — merging the two branches in either order
 *      yields an identical committed graph (the embedding precompute is keyed by
 *      text and sorted, so it adds no order dependence to the merge contract);
 *   3. a `vector`/`hybrid` strategy with NO embedder configured fails with a typed
 *      error surfaced as a `MergeError`.
 */

import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import type {
  Embedder,
  GraphBranch,
  MergeOptions,
} from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix, fakeEmbedder } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({
    name: z.string(),
    birthDate: z.string(),
    mrn: z.string().optional(),
  }),
});

const careGraph = defineGraph({
  id: "vector-merge-patient",
  nodes: { Patient: { type: Patient } },
  edges: {},
});

type CareGraph = typeof careGraph;

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");

/** Explicit ids so the two materializations are id-for-id comparable across runs. */
const LEFT_PATIENT_ID = "pat-anna";
const RIGHT_PATIENT_ID = "pat-ana";

/**
 * Hybrid (cosine + trigram) over `name`, blocked by birthDate. Threshold 0.7 is
 * cleared by the near-duplicate under the fake character-frequency embedding.
 */
function hybridMergeOptions(embedder?: Embedder): MergeOptions<CareGraph> {
  return {
    resolve: {
      Patient: {
        block: (node) => (node as unknown as { birthDate?: string }).birthDate,
        similarity: { kind: "hybrid", fields: ["name"] },
        threshold: 0.7,
      },
    },
    onPropertyConflict: "flag",
    branchOrder: [BRANCH_A, BRANCH_B],
    ...(embedder === undefined ? {} : { embedder }),
  };
}

type Fixture = Readonly<{
  base: Store<CareGraph>;
  branches: readonly GraphBranch<CareGraph>[];
}>;

describe.each(backendMatrix())("merge vector/hybrid path [$name]", (entry) => {
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
   * Base + two branches: branch A adds "Anna Rivera" (with an mrn), branch B adds
   * "Ana Rivera" — same birthDate (same block), near-duplicate name. Explicit ids
   * make two materializations id-for-id identical.
   */
  async function materialize(): Promise<Fixture> {
    const [base] = await createStoreWithSchema(careGraph, await makeBackend());
    const branchA = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchB = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_B }),
    );
    await branchA.store.nodes.Patient.bulkCreate([
      {
        id: LEFT_PATIENT_ID,
        props: { name: "Anna Rivera", birthDate: "1974-03-09", mrn: "MRN-001" },
      },
    ]);
    await branchB.store.nodes.Patient.bulkCreate([
      {
        id: RIGHT_PATIENT_ID,
        props: { name: "Ana Rivera", birthDate: "1974-03-09" },
      },
    ]);
    return { base, branches: [branchA, branchB] };
  }

  it("hybrid + embedder resolves the near-duplicate into ONE canonical Patient", async () => {
    cleanups = [];
    const { base, branches } = await materialize();

    const result = await merge<CareGraph>(
      base,
      branches,
      hybridMergeOptions(fakeEmbedder),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }

    // Exactly one resolution, spanning BOTH branches.
    expect(result.data.resolutions).toHaveLength(1);
    expect(new Set(result.data.resolutions[0]?.branchOrigins).size).toBe(2);

    // The committed base holds ONE canonical Patient — the default canonical rule
    // keeps the lexicographically-minimal member id.
    const expectedCanonical = [LEFT_PATIENT_ID, RIGHT_PATIENT_ID].sort(
      (left, right) =>
        left < right ? -1
        : left > right ? 1
        : 0,
    )[0];
    const patients = await base.nodes.Patient.find();
    expect(patients).toHaveLength(1);
    expect(patients[0]?.id).toBe(expectedCanonical);
  });

  it("is order-independent: natural vs reversed branch order commit the same graph", async () => {
    cleanups = [];
    const natural = await materialize();
    const shuffled = await materialize();

    const naturalResult = await merge<CareGraph>(
      natural.base,
      natural.branches,
      hybridMergeOptions(fakeEmbedder),
    );
    const shuffledResult = await merge<CareGraph>(
      shuffled.base,
      [...shuffled.branches].reverse(),
      hybridMergeOptions(fakeEmbedder),
    );
    expect(isOk(naturalResult) && isOk(shuffledResult)).toBe(true);

    const naturalPatients = await natural.base.nodes.Patient.find();
    const shuffledPatients = await shuffled.base.nodes.Patient.find();
    // Same single survivor, same id, same retained props — independent of order.
    expect(naturalPatients).toHaveLength(1);
    expect(shuffledPatients).toHaveLength(1);
    expect(shuffledPatients[0]?.id).toBe(naturalPatients[0]?.id);
    expect(shuffledPatients[0]?.name).toBe(naturalPatients[0]?.name);
    expect(shuffledPatients[0]?.mrn).toBe(naturalPatients[0]?.mrn);
  });

  it("hybrid with NO embedder configured fails the merge", async () => {
    cleanups = [];
    const { base, branches } = await materialize();

    const result = await merge<CareGraph>(base, branches, hybridMergeOptions());
    // The SimilarityUnavailableError from candidate-gen surfaces as a MergeError.
    expect(isErr(result)).toBe(true);
  });
});
