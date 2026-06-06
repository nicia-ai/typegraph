/**
 * Step 6 contract: onBasePropertyConflict (§6.4-C) + the provenance base sentinel
 * (§6.4-D).
 *
 *   - A BASE↔branch property disagreement is governed by `onBasePropertyConflict`,
 *     which is SEPARATE from `onPropertyConflict` and does NOT inherit it: with
 *     `onPropertyConflict: "lastWriteWins"`, the default base policy ("flag") still
 *     keeps the committed value — a fuzzy branch match cannot silently overwrite
 *     committed data — while an explicit `onBasePropertyConflict` is honoured.
 *   - A base contribution carries the reserved BASE_PROVENANCE_BRANCH sentinel and
 *     round-trips through `persistProvenance` (NUL-free, so it persists on every
 *     backend) and `readProvenance`.
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
import { BASE_PROVENANCE_BRANCH } from "../../src/graph-merge/canonicalize";
import { mergeAgainstBase } from "../../src/graph-merge/merge";
import { openProvenanceStore, readProvenance } from "../../src/graph-merge/provenance-store";
import { isOk, unwrap } from "../../src/graph-merge/result";
import type { GraphBranch, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), mrn: z.string() }),
});

const careGraph = defineGraph({
  id: "base-prop-care",
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

describe.each(backendMatrix())(
  "base property conflict + provenance [$name]",
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

    /** A branch whose new patient duplicates a committed base patient by mrn, but
     * with a DIFFERENT name (the base↔branch conflict). */
    async function scenario(): Promise<{
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
      await provider.store.nodes.Patient.bulkCreate([
        { id: "new-ana", props: { name: "Ana Rivera", mrn: "MRN-1" } },
      ]);
      const [target] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
      );
      await target.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);
      return { forkBase, provider, target };
    }

    function baseOptions(
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
        branchOrder: [BRANCH],
      };
    }

    it("default onBasePropertyConflict keeps the committed value even when onPropertyConflict=lastWriteWins", async () => {
      cleanups = [];
      const { forkBase, provider, target } = await scenario();

      const result = await mergeAgainstBase<CareGraph>(forkBase, [provider], {
        ...baseOptions(target),
        // A staged policy that WOULD overwrite the committed value if it leaked into
        // the base↔branch decision. onBasePropertyConflict defaults to "flag".
        onPropertyConflict: "lastWriteWins",
      });
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) {
        return;
      }

      const patients = await target.nodes.Patient.find();
      console.info(
        `[${entry.name}] name after merge:`,
        patients.map((p) => p.name),
      );
      // The committed base value survives — the branch did NOT overwrite it.
      expect(patients).toHaveLength(1);
      expect(patients[0]?.name).toBe("Anna Rivera");

      // The disagreement is still REPORTED (flag does not suppress it).
      const nameConflict = result.data.conflicts.find(
        (c) => c.property === "name" && `${c.entityId}` === "base-ana",
      );
      expect(nameConflict).toBeDefined();
      expect(nameConflict?.resolution).toBe("Anna Rivera");
    });

    it("honours an explicit onBasePropertyConflict (separate from onPropertyConflict)", async () => {
      cleanups = [];
      const { forkBase, provider, target } = await scenario();

      const result = await mergeAgainstBase<CareGraph>(forkBase, [provider], {
        ...baseOptions(target),
        onPropertyConflict: "flag",
        // Explicitly let the highest-priority branch win the base↔branch conflict.
        onBasePropertyConflict: "lastWriteWins",
      });
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) {
        return;
      }

      const patients = await target.nodes.Patient.find();
      // branch BRANCH (rank 0) outranks the base sentinel, so its value wins now.
      expect(patients).toHaveLength(1);
      expect(patients[0]?.name).toBe("Ana Rivera");
    });

    it("persists the base contribution under the reserved sentinel and reads it back", async () => {
      cleanups = [];
      const { forkBase, provider, target } = await scenario();

      const result = await mergeAgainstBase<CareGraph>(forkBase, [provider], {
        ...baseOptions(target),
        persistProvenance: true,
      });
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) {
        return;
      }
      expect(result.data.provenancePersisted).toBeDefined();

      const provenanceStore = await openProvenanceStore(
        target.backend,
        target.graphId,
      );
      const baseRecords = await readProvenance(provenanceStore, {
        branchId: BASE_PROVENANCE_BRANCH,
      });
      console.info(
        `[${entry.name}] base provenance:`,
        baseRecords.map((r) => `${r.branchId}->${r.canonicalId}`),
      );
      // The base contribution round-tripped: the sentinel branch credits the
      // committed base id as the canonical it contributed to.
      const baseContribution = baseRecords.find(
        (r) => r.canonicalId === "base-ana",
      );
      expect(baseContribution).toBeDefined();
      expect(baseContribution?.branchId).toBe(BASE_PROVENANCE_BRANCH);
    });
  },
);
