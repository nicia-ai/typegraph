/**
 * End-to-end regression for the unique-constraint blocking + force-merge fix.
 *
 * Two branches each add a Patient sharing an `mrn` (a unique constraint) but with a
 * DIFFERENT `birthDate` (the block key). The old composite-key blocking split them
 * into different buckets, so entity resolution NEVER compared them — the duplicate
 * survived (and committing two same-mrn rows would even violate the merged graph's
 * own uniqueness). Two cases:
 *
 *   1. near-duplicate names — they co-bucket on the shared mrn and resolve into ONE
 *      canonical;
 *   2. DISSIMILAR names (fuzzy score ~0) — an exact unique match is definitional, so
 *      they are FORCE-merged regardless of similarity, with the name disagreement
 *      reported as a property conflict (never a silent commit-time uniqueness fail).
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
import { merge } from "../../src/graph-merge/merge";
import { isOk, unwrap } from "../../src/graph-merge/result";
import type { GraphBranch, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({
    name: z.string(),
    birthDate: z.string(),
    mrn: z.string(),
  }),
});

const careGraph = defineGraph({
  id: "unique-blocking-care",
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

const BRANCH_A = asBranchId("provider-a");
const BRANCH_B = asBranchId("provider-b");

/** Block by birthDate; fuzzy-match names. The mrn unique constraint is folded in
 * automatically by `merge()` via `store.introspect()`. */
function mergeOptions(): MergeOptions<CareGraph> {
  return {
    resolve: {
      Patient: {
        block: (node) => (node as unknown as { birthDate?: string }).birthDate,
        similarity: { kind: "fulltext", fields: ["name"] },
        threshold: 0.85,
      },
    },
    onPropertyConflict: "flag",
    branchOrder: [BRANCH_A, BRANCH_B],
  };
}

describe.each(backendMatrix())(
  "unique-constraint blocking merge [$name]",
  (entry) => {
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

    it("resolves a same-mrn duplicate whose birthDate (block key) differs", async () => {
      cleanups = [];
      const [base] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
      );
      const branchA = unwrap(
        await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_A }),
      );
      const branchB = unwrap(
        await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_B }),
      );

      // Same mrn, DIFFERENT birthDate, near-duplicate name.
      await branchA.store.nodes.Patient.bulkCreate([
        {
          id: "pat-a",
          props: { name: "Anna Rivera", birthDate: "1974-03-09", mrn: "MRN-1" },
        },
      ]);
      await branchB.store.nodes.Patient.bulkCreate([
        {
          id: "pat-b",
          props: { name: "Ana Rivera", birthDate: "1990-01-01", mrn: "MRN-1" },
        },
      ]);

      const branches: readonly GraphBranch<CareGraph>[] = [branchA, branchB];
      const result = await merge<CareGraph>(base, branches, mergeOptions());
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) {
        return;
      }

      // One canonical Patient (the duplicate resolved) spanning BOTH branches — and
      // the commit did not trip the mrn unique constraint.
      const patients = await base.nodes.Patient.find();
      expect(patients).toHaveLength(1);
      expect(patients[0]?.mrn).toBe("MRN-1");
      expect(result.data.resolutions).toHaveLength(1);
      expect(new Set(result.data.resolutions[0]?.branchOrigins).size).toBe(2);
    });

    it("FORCE-merges an exact unique match even when names are dissimilar", async () => {
      cleanups = [];
      const [base] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
      );
      const branchA = unwrap(
        await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_A }),
      );
      const branchB = unwrap(
        await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_B }),
      );

      // Same mrn, but WILDLY different names (fuzzy score ~0, far below 0.85) and
      // different birthDate. A unique match is definitional, so they MUST merge —
      // never fall through to a commit-time uniqueness failure.
      await branchA.store.nodes.Patient.bulkCreate([
        {
          id: "pat-a",
          props: { name: "Anna Rivera", birthDate: "1974-03-09", mrn: "MRN-9" },
        },
      ]);
      await branchB.store.nodes.Patient.bulkCreate([
        {
          id: "pat-b",
          props: {
            name: "Robert Smith",
            birthDate: "1990-01-01",
            mrn: "MRN-9",
          },
        },
      ]);

      const branches: readonly GraphBranch<CareGraph>[] = [branchA, branchB];
      const result = await merge<CareGraph>(base, branches, mergeOptions());
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) {
        return;
      }

      // Forced into ONE canonical despite the dissimilar names.
      const patients = await base.nodes.Patient.find();
      expect(patients).toHaveLength(1);
      expect(patients[0]?.mrn).toBe("MRN-9");
      expect(result.data.resolutions).toHaveLength(1);

      // The name disagreement is REPORTED as a property conflict, not suppressed.
      const nameConflict = result.data.conflicts.find(
        (conflict) => conflict.property === "name",
      );
      expect(nameConflict).toBeDefined();
      const values = new Set(
        (nameConflict?.values ?? []).map((value) => value.value),
      );
      expect(values.has("Anna Rivera")).toBe(true);
      expect(values.has("Robert Smith")).toBe(true);
    });
  },
);
