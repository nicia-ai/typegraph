/**
 * In-transaction NEW-vs-BASE identity re-resolution (the incremental TOCTOU guard).
 *
 * `mergeIncremental()` resolves each branch addition against the target's
 * committed rows from `baseUnique`/`baseKey` lookups taken OUTSIDE the commit
 * transaction. A committed row that shares a branch addition's identity key (a
 * unique constraint or a declared block index) and LANDS in the plan→commit
 * window is invisible to the per-row write guards — they only re-fetch the
 * plan's own write ids — so the stale plan would commit the addition under its
 * own id, leaving a duplicate the base-source resolution would otherwise have
 * collapsed. Serializable isolation cannot catch a read taken before the
 * transaction began, so the guard RE-DERIVES the matched base keys through the
 * tx-scoped store and refuses any plan whose identity resolution drifted.
 *
 * The window write is injected deterministically by wrapping `target.transaction`
 * (the seam the commit goes through): the first call writes the colliding row
 * straight to the target, then delegates — exactly the window a concurrent
 * writer would hit. The control case proves an UNRELATED advance (a row sharing
 * neither identity key) is still tolerated: incremental merge is defined against
 * an advancing target.
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
import { BaseVersionMismatchError } from "../../src/graph-merge/errors";
import { mergeIncremental } from "../../src/graph-merge/merge";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import type { GraphBranch, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), cohort: z.string(), mrn: z.string() }),
});
// The NEW-vs-BASE block key (`baseKey`): a declared, non-unique index.
const patientCohort = defineNodeIndex(Patient, {
  name: "patient_cohort_idx",
  fields: ["cohort"],
});

const careGraph = defineGraph({
  id: "incremental-toctou-care",
  nodes: {
    Patient: {
      type: Patient,
      // The definitional identity key (`baseUnique`). The uniques side-table
      // would reject the duplicate WRITE late with an opaque error; the guard
      // fires earlier and typed, before any row is touched.
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
  indexes: [patientCohort],
});
type CareGraph = typeof careGraph;
type CareStore = GraphBranch<CareGraph>["store"];

const BRANCH = asBranchId("provider-x");

function mergeOptions(): MergeOptions<CareGraph> {
  return {
    resolve: {
      Patient: {
        blockIndex: "patient_cohort_idx",
        similarity: { kind: "fulltext", fields: ["name"] },
        threshold: 0.85,
      },
    },
    onPropertyConflict: "flag",
    onBasePropertyConflict: "flag",
    branchOrder: [BRANCH],
  };
}

/**
 * Wraps `target.transaction` so the FIRST call writes `rows` straight to the
 * target before delegating — a deterministic concurrent write inside the
 * plan→commit window. Returns a restore fn so a re-run can commit cleanly.
 * `injected` flips BEFORE the write so a transaction the write itself opens does
 * not re-enter the injection.
 */
function injectWindowWrite(
  target: CareStore,
  rows: readonly Readonly<{
    id: string;
    props: { name: string; cohort: string; mrn: string };
  }>[],
): () => void {
  const original = target.transaction.bind(target);
  let injected = false;
  (target as { transaction: unknown }).transaction = async (
    fn: unknown,
    options: unknown,
  ) => {
    if (!injected) {
      injected = true;
      await target.nodes.Patient.bulkCreate(rows);
    }
    return (original as (f: unknown, o: unknown) => unknown)(fn, options);
  };
  return () => {
    (target as { transaction: unknown }).transaction = original;
  };
}

async function patientIds(store: CareStore): Promise<readonly string[]> {
  return (await store.nodes.Patient.find()).map((patient) => patient.id).sort();
}

describe.each(backendMatrix())(
  "mergeIncremental — in-transaction identity re-resolution [$name]",
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

    async function emptyStore(): Promise<CareStore> {
      const [store] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
      );
      return store;
    }

    async function forkWithAddition(
      forkPoint: CareStore,
      props: { name: string; cohort: string; mrn: string },
    ): Promise<GraphBranch<CareGraph>> {
      const provider = unwrap(
        await branch<CareGraph>(forkPoint, () => makeBackend(), { id: BRANCH }),
      );
      await provider.store.nodes.Patient.bulkCreate([{ id: "new-1", props }]);
      return provider;
    }

    it("REFUSES the commit when a same-block-index row appears in the window, applying nothing", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkWithAddition(forkPoint, {
        name: "Anna Rivera",
        cohort: "C1",
        mrn: "MRN-1",
      });
      const target = await emptyStore();

      // A near-duplicate-name, same-cohort row (a `baseKey` match the planner
      // never saw), DIFFERENT mrn so only the block-index path is exercised.
      const restore = injectWindowWrite(target, [
        {
          id: "drift-1",
          props: { name: "Ana Rivera", cohort: "C1", mrn: "MRN-9" },
        },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: mergeOptions(),
      });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
        expect(result.error.code).toBe("GRAPH_MERGE_BASE_VERSION_MISMATCH");
      }
      // The window write survives; the stale plan committed NOTHING — no duplicate.
      expect(await patientIds(target)).toEqual(["drift-1"]);

      // Re-running against the now-stable target re-plans WITH the row visible:
      // the addition clusters onto it (base-id-wins), leaving a single Patient.
      restore();
      const rerun = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: mergeOptions(),
      });
      expect(isOk(rerun)).toBe(true);
      expect(await patientIds(target)).toEqual(["drift-1"]);
    });

    // The uniques side-table PK would itself reject this duplicate at write
    // time (an opaque late MergeError), so this case is not a SILENT duplicate
    // like the block-index path. The guard's value here is a clean, early,
    // typed refusal that touches no rows — and it unifies both paths.
    it("REFUSES the commit when a same-unique-key row appears in the window", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkWithAddition(forkPoint, {
        name: "Anna Rivera",
        cohort: "C1",
        mrn: "MRN-1",
      });
      const target = await emptyStore();

      // Same mrn (the definitional `baseUnique` key) but a DIFFERENT cohort and
      // an unrelated name, so ONLY the unique-constraint path is exercised.
      injectWindowWrite(target, [
        {
          id: "drift-1",
          props: { name: "Zachary Quux", cohort: "C9", mrn: "MRN-1" },
        },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: mergeOptions(),
      });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
      }
      // Nothing committed on top of the window write — no unique-key duplicate.
      expect(await patientIds(target)).toEqual(["drift-1"]);
    });

    it("COMMITS normally when the window write shares NEITHER identity key (advancing target)", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkWithAddition(forkPoint, {
        name: "Anna Rivera",
        cohort: "C1",
        mrn: "MRN-1",
      });
      const target = await emptyStore();

      // An unrelated advance: different cohort AND different mrn. Incremental
      // merge tolerates a target that moved on — only an identity-key MATCH trips.
      injectWindowWrite(target, [
        {
          id: "drift-2",
          props: { name: "Mara Lopez", cohort: "C9", mrn: "MRN-9" },
        },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: mergeOptions(),
      });

      expect(isOk(result)).toBe(true);
      // Both survive: the addition committed under its own id, the advance kept.
      expect(await patientIds(target)).toEqual(["drift-2", "new-1"]);
    });

    it("COMMITS normally when no write lands in the window (control)", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkWithAddition(forkPoint, {
        name: "Anna Rivera",
        cohort: "C1",
        mrn: "MRN-1",
      });
      const target = await emptyStore();

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: mergeOptions(),
      });

      expect(isOk(result)).toBe(true);
      expect(await patientIds(target)).toEqual(["new-1"]);
    });
  },
);
