/**
 * In-transaction base@V re-validation (the TOCTOU guard).
 *
 * `merge()` validates the base@V precondition and resolves the whole plan from
 * reads taken OUTSIDE the commit transaction. A write landing on the target in
 * that window used to be invisible: the stale plan committed anyway. The guard
 * re-derives the target's content fingerprint INSIDE the commit transaction and
 * refuses to apply a plan whose captured token no longer matches.
 *
 * The drift is injected deterministically through the `embedder` callback: it
 * runs after the precondition check and before the commit — exactly the window
 * a concurrent writer would hit — and writes straight to the target store.
 * `mergeAgainstBase()` (no branch-level precondition) gets the same
 * plan-stability guard from a token captured at plan start, so it is covered
 * here too. The serialization-retry half of the commit path is unit-tested in
 * `tx-retry.test.ts`; true multi-session SSI races need concurrent server
 * connections that in-process backends cannot produce.
 */

import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { BaseVersionMismatchError } from "../../src/graph-merge/errors";
import { merge, mergeAgainstBase } from "../../src/graph-merge/merge";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import { enumerateAllNodes } from "../../src/graph-merge/state-diff";
import type {
  BranchId,
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
  }),
});

const driftGraph = defineGraph({
  id: "commit-revalidation-graph",
  nodes: { Patient: { type: Patient } },
  edges: {},
});

type DriftGraph = typeof driftGraph;

const BRANCH_A = asBranchId("branch-a");

/**
 * Hybrid similarity so `merge()` invokes the embedder during planning — the
 * deterministic stand-in for "a concurrent writer landed mid-merge". The high
 * threshold keeps the two distinct branch patients from actually clustering;
 * the guard under test is orthogonal to entity resolution.
 */
function revalidationMergeOptions(
  embedder: Embedder,
): MergeOptions<DriftGraph> {
  return {
    resolve: {
      Patient: {
        block: (node) => (node as unknown as { birthDate?: string }).birthDate,
        similarity: { kind: "hybrid", fields: ["name"] },
        threshold: 0.95,
      },
    },
    embedder,
    onPropertyConflict: "flag",
    branchOrder: [BRANCH_A],
  };
}

/** Live patient ids in the store, sorted. */
async function livePatientIds(
  store: Store<DriftGraph>,
): Promise<readonly string[]> {
  const rows = await enumerateAllNodes(store.backend, store.graphId, "Patient");
  return rows
    .filter((row) => row.deleted_at === undefined)
    .map((row) => row.id)
    .sort();
}

describe.each(backendMatrix())(
  "merge — in-transaction base@V re-validation [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    beforeEach(() => {
      cleanups = [];
    });

    afterEach(async () => {
      for (const cleanup of cleanups) {
        await cleanup();
      }
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function makeBranch(
      baseStore: Store<DriftGraph>,
      id: BranchId,
    ): Promise<GraphBranch<DriftGraph>> {
      return unwrap(
        await branch<DriftGraph>(baseStore, () => makeBackend(), { id }),
      );
    }

    /** Base with one anchor patient plus a branch that adds two more. */
    async function seedScenario(): Promise<
      Readonly<{
        baseStore: Store<DriftGraph>;
        branchA: GraphBranch<DriftGraph>;
      }>
    > {
      const [baseStore] = await createStoreWithSchema(
        driftGraph,
        await makeBackend(),
      );
      await baseStore.nodes.Patient.bulkCreate([
        {
          id: "pat-base",
          props: { name: "Wei Chen", birthDate: "1965-07-02" },
        },
      ]);

      const branchA = await makeBranch(baseStore, BRANCH_A);
      await branchA.store.nodes.Patient.bulkCreate([
        {
          id: "pat-robert",
          props: { name: "Robert Smith", birthDate: "1974-03-09" },
        },
        {
          id: "pat-maria",
          props: { name: "Maria Gonzalez", birthDate: "1974-03-09" },
        },
      ]);
      return { baseStore, branchA };
    }

    /**
     * Wraps {@link fakeEmbedder} so the FIRST invocation also writes a patient
     * straight to `target` — a deterministic concurrent write inside the
     * precondition→commit window.
     */
    function driftingEmbedder(target: Store<DriftGraph>): Embedder {
      let driftInjected = false;
      return async (texts) => {
        if (!driftInjected) {
          driftInjected = true;
          await target.nodes.Patient.bulkCreate([
            {
              id: "pat-drift",
              props: { name: "Olu Adeyemi", birthDate: "1991-02-14" },
            },
          ]);
        }
        return fakeEmbedder(texts);
      };
    }

    it("rejects the commit when the target was written mid-merge, applying nothing", async () => {
      const { baseStore, branchA } = await seedScenario();

      const result = await merge<DriftGraph>(
        baseStore,
        [branchA],
        revalidationMergeOptions(driftingEmbedder(baseStore)),
      );

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
        expect(result.error.code).toBe("GRAPH_MERGE_BASE_VERSION_MISMATCH");
      }

      // The drift write survives; the stale plan committed NOTHING on top.
      expect(await livePatientIds(baseStore)).toEqual([
        "pat-base",
        "pat-drift",
      ]);
    });

    it("commits normally when no write lands in the window (control)", async () => {
      const { baseStore, branchA } = await seedScenario();

      const result = await merge<DriftGraph>(
        baseStore,
        [branchA],
        revalidationMergeOptions(fakeEmbedder),
      );

      expect(isOk(result)).toBe(true);
      expect(await livePatientIds(baseStore)).toEqual([
        "pat-base",
        "pat-maria",
        "pat-robert",
      ]);
    });

    it("guards mergeAgainstBase the same way via the plan-start token", async () => {
      const { baseStore, branchA } = await seedScenario();

      const result = await mergeAgainstBase<DriftGraph>(
        baseStore,
        [branchA],
        revalidationMergeOptions(driftingEmbedder(baseStore)),
      );

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
      }
      expect(await livePatientIds(baseStore)).toEqual([
        "pat-base",
        "pat-drift",
      ]);
    });
  },
);
