/**
 * Acceptance gate for merging valid-time windows on INHERITED rows (issue #369).
 *
 * `update(id, {}, { validTo })` is an ordinary write on a branch, and the merge
 * used to discard it: modification detection compared properties only, so a
 * branch that ended a row's validity merged as a no-op. These cases pin the
 * contract that replaces that silence, for nodes and edges alike:
 *
 *   1. a window-only change is carried to the target;
 *   2. props + window change together apply in one write;
 *   3. disjoint edits across branches all survive;
 *   4. two branches ending differently resolve to the EARLIEST end, reported;
 *   5. a deletion ABSORBS another branch's ending — no delete/modify conflict;
 *   6. the incremental target's own end wins over a branch's;
 *   7. re-writing the end the target already holds is not a write at all;
 *   8. a fork `validFrom` divergence is reported unapplicable, not applied;
 *   9. two inherited edges folded by repoint/dedupe take the earliest end;
 *  10. a single branch may EXTEND an end to a later instant.
 *
 * Runs on every backend in the matrix — SQLite and PGlite always, real server
 * Postgres under `POSTGRES_URL`. That is load-bearing rather than incidental:
 * `valid_to` is a timestamp column whose driver rendering differs per dialect,
 * so an ordering rule verified on one backend could resolve differently on the
 * other. A per-dialect test would happily certify that divergence.
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

import { asEdgeId, asNodeId } from "../../src/core/types";
import { branch } from "../../src/graph-merge/branch";
import { merge, mergeIncremental } from "../../src/graph-merge/merge";
import { unwrap } from "../../src/graph-merge/result";
import type { GraphBranch, MergeReport } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { WINDOW_NOT_APPLICABLE_DROP_REASON } from "../../src/graph-merge/valid-window";
import { canonicalizeDatabaseTimestamp } from "../../src/utils/date";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix, getStoreBackend } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), note: z.string().optional() }),
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
  id: "valid-window-care",
  nodes: { Patient: { type: Patient }, Encounter: { type: Encounter } },
  edges: {
    hadEncounter: { type: hadEncounter, from: [Patient], to: [Encounter] },
  },
});
type CareGraph = typeof careGraph;
type CareStore = GraphBranch<CareGraph>["store"];

/** Branded ids for the seeded fixture rows. */
const PATIENT = asNodeId<typeof Patient>("pat-1");
/** A second, EDGE-FREE patient: the default `restrict` delete behavior refuses
 *  to delete a node with connected edges, so deletion cases use this one. */
const LONE_PATIENT = asNodeId<typeof Patient>("pat-2");
const ENCOUNTER = asNodeId<typeof Encounter>("enc-1");
const EDGE_1 = asEdgeId<typeof hadEncounter>("edge-1");
const EDGE_2 = asEdgeId<typeof hadEncounter>("edge-2");

const BRANCH_A = asBranchId("window-branch-a");
const BRANCH_B = asBranchId("window-branch-b");
const BRANCH_ORDER = [BRANCH_A, BRANCH_B];

/**
 * Three ordered instants, `EARLY` the minimum. All are in the FUTURE: a row's
 * `validFrom` defaults to its creation instant, and the store refuses an
 * inverted window, so an end before that instant is not authorable at all.
 */
const EARLY = "2100-01-01T00:00:00.000Z";
const LATE = "2100-06-01T00:00:00.000Z";
const LATEST = "2100-09-01T00:00:00.000Z";

describe.each(backendMatrix())(
  "merging valid-time windows [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const cleanup of cleanups.reverse()) {
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
     * Seeds a store with the shared fixture: two patients, one encounter, and the
     * edge joining `pat-1` to it — all with OPEN windows, so every ending a case
     * authors is the merge's only window input.
     */
    async function seed(store: CareStore): Promise<CareStore> {
      await store.nodes.Patient.create({ name: "Ana Rivera" }, { id: "pat-1" });
      await store.nodes.Patient.create({ name: "Ben Okafor" }, { id: "pat-2" });
      await store.nodes.Encounter.create(
        { reason: "checkup" },
        { id: "enc-1" },
      );
      await store.edges.hadEncounter.create(
        { kind: "Patient", id: "pat-1" },
        { kind: "Encounter", id: "enc-1" },
        { on: "2026-01-05" },
        { id: "edge-1" },
      );
      return store;
    }

    async function newStore(
      options?: Readonly<{ coalesceUnchangedUpserts?: boolean }>,
    ): Promise<CareStore> {
      const [store] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
        options,
      );
      return store;
    }

    async function seededForkPoint(
      options?: Readonly<{ coalesceUnchangedUpserts?: boolean }>,
    ): Promise<CareStore> {
      return seed(await newStore(options));
    }

    async function forkOf(
      forkPoint: CareStore,
      id: typeof BRANCH_A,
    ): Promise<GraphBranch<CareGraph>> {
      return unwrap(
        await branch<CareGraph>(forkPoint, () => makeBackend(), { id }),
      );
    }

    /** A committed node's raw row, for reading window + version directly. */
    async function nodeRow(store: CareStore, kind: string, id: string) {
      return requireDefined(
        await getStoreBackend(store).getNode(store.graphId, kind, id),
      );
    }

    async function edgeRow(store: CareStore, id: string) {
      return requireDefined(
        await getStoreBackend(store).getEdge(store.graphId, id),
      );
    }

    /** The node's end-of-validity as a canonical instant (`undefined` = open). */
    async function nodeEnd(
      store: CareStore,
      kind: string,
      id: string,
    ): Promise<string | undefined> {
      return canonicalizeDatabaseTimestamp(
        (await nodeRow(store, kind, id)).valid_to,
      );
    }

    async function edgeEnd(
      store: CareStore,
      id: string,
    ): Promise<string | undefined> {
      return canonicalizeDatabaseTimestamp((await edgeRow(store, id)).valid_to);
    }

    /** The window-not-applicable entries of a report, by id. */
    function unapplicableIds(
      report: MergeReport<CareGraph>,
    ): readonly string[] {
      return report.dropped
        .filter((item) => item.reason === WINDOW_NOT_APPLICABLE_DROP_REASON)
        .map((item) => item.id);
    }

    it("carries a window-only ending from a branch to the target", async () => {
      const forkPoint = await seededForkPoint();
      const branchA = await forkOf(forkPoint, BRANCH_A);
      await branchA.store.nodes.Patient.update(PATIENT, {}, { validTo: LATE });
      await branchA.store.edges.hadEncounter.update(
        EDGE_1,
        {},
        { validTo: LATE },
      );

      const report = unwrap(
        await merge(forkPoint, [branchA], { branchOrder: BRANCH_ORDER }),
      );

      expect(await nodeEnd(forkPoint, "Patient", "pat-1")).toBe(LATE);
      expect(await edgeEnd(forkPoint, "edge-1")).toBe(LATE);
      // Props are untouched: an ending says WHEN a fact stopped holding, never
      // what it said.
      const patient = await nodeRow(forkPoint, "Patient", "pat-1");
      expect(patient.deleted_at).toBeUndefined();
      expect(report.validityEnds).toEqual([
        {
          entity: "node",
          kind: "Patient",
          id: "pat-1",
          validTo: LATE,
          claimedBy: [BRANCH_A],
        },
        {
          entity: "edge",
          kind: "hadEncounter",
          id: "edge-1",
          validTo: LATE,
          claimedBy: [BRANCH_A],
        },
      ]);
    });

    it("applies a props edit and an ending in one write", async () => {
      const forkPoint = await seededForkPoint();
      const branchA = await forkOf(forkPoint, BRANCH_A);
      await branchA.store.nodes.Patient.update(
        PATIENT,
        { note: "discharged" },
        { validTo: LATE },
      );

      unwrap(await merge(forkPoint, [branchA], { branchOrder: BRANCH_ORDER }));

      const patient = requireDefined(
        await forkPoint.nodes.Patient.getById(PATIENT),
      );
      expect(patient.note).toBe("discharged");
      expect(await nodeEnd(forkPoint, "Patient", "pat-1")).toBe(LATE);
    });

    it("keeps a disjoint props edit and another branch's ending", async () => {
      const forkPoint = await seededForkPoint();
      const branchA = await forkOf(forkPoint, BRANCH_A);
      const branchB = await forkOf(forkPoint, BRANCH_B);
      await branchA.store.nodes.Patient.update(PATIENT, { note: "flagged" });
      await branchB.store.nodes.Patient.update(PATIENT, {}, { validTo: LATE });

      const report = unwrap(
        await merge(forkPoint, [branchA, branchB], {
          branchOrder: BRANCH_ORDER,
        }),
      );

      const patient = requireDefined(
        await forkPoint.nodes.Patient.getById(PATIENT),
      );
      expect(patient.note).toBe("flagged");
      expect(await nodeEnd(forkPoint, "Patient", "pat-1")).toBe(LATE);
      // Ending a row a sibling branch edited is not a property disagreement.
      expect(report.conflicts).toEqual([]);
      expect(report.deleteModifyConflicts).toEqual([]);
    });

    it("resolves two differing endings to the earliest, and reports it", async () => {
      const forkPoint = await seededForkPoint();
      const branchA = await forkOf(forkPoint, BRANCH_A);
      const branchB = await forkOf(forkPoint, BRANCH_B);
      // Branch A claims the LATER end so the assertion cannot pass by accident on
      // a branch-order tie-break: only a least-claim rule yields EARLY here.
      await branchA.store.nodes.Patient.update(PATIENT, {}, { validTo: LATE });
      await branchB.store.nodes.Patient.update(PATIENT, {}, { validTo: EARLY });

      const report = unwrap(
        await merge(forkPoint, [branchA, branchB], {
          branchOrder: BRANCH_ORDER,
        }),
      );

      expect(await nodeEnd(forkPoint, "Patient", "pat-1")).toBe(EARLY);
      expect(report.validityEnds).toEqual([
        {
          entity: "node",
          kind: "Patient",
          id: "pat-1",
          validTo: EARLY,
          claimedBy: [BRANCH_A, BRANCH_B],
        },
      ]);
      // An ending is a monotone claim, like a deletion: two branches ending the
      // same row at different instants do not DISAGREE, so nothing is flagged.
      expect(report.conflicts).toEqual([]);
    });

    it("lets a deletion absorb another branch's ending, with no conflict", async () => {
      const forkPoint = await seededForkPoint();
      const branchA = await forkOf(forkPoint, BRANCH_A);
      const branchB = await forkOf(forkPoint, BRANCH_B);
      await branchA.store.nodes.Patient.update(
        LONE_PATIENT,
        {},
        { validTo: LATE },
      );
      await branchB.store.nodes.Patient.delete(LONE_PATIENT);

      const report = unwrap(
        await merge(forkPoint, [branchA, branchB], {
          branchOrder: BRANCH_ORDER,
        }),
      );

      const row = await nodeRow(forkPoint, "Patient", "pat-2");
      expect(row.deleted_at).not.toBeUndefined();
      // Deleting and ending are both "no longer true"; the stronger statement
      // wins and the two do not disagree.
      expect(report.deleteModifyConflicts).toEqual([]);
      expect(report.validityEnds).toEqual([]);
    });

    it("keeps the incremental target's own end over a branch's", async () => {
      const forkPoint = await seededForkPoint();
      const target = (await forkOf(forkPoint, asBranchId("window-target")))
        .store;
      const branchA = await forkOf(forkPoint, BRANCH_A);
      await target.nodes.Patient.update(PATIENT, {}, { validTo: LATE });
      await branchA.store.nodes.Patient.update(PATIENT, {}, { validTo: EARLY });

      unwrap(
        await mergeIncremental<CareGraph>({
          forkPoint,
          target,
          branches: [branchA],
          options: { branchOrder: BRANCH_ORDER },
        }),
      );

      // The committed target already windowed this row; a user branch never
      // re-windows it, even with an EARLIER (otherwise winning) claim.
      expect(await nodeEnd(target, "Patient", "pat-1")).toBe(LATE);
    });

    it("leaves a row the TARGET alone windowed out of the merge entirely", async () => {
      const forkPoint = await seededForkPoint();
      const target = (await forkOf(forkPoint, asBranchId("window-target")))
        .store;
      const branchA = await forkOf(forkPoint, BRANCH_A);
      // Only the committed target moves this end. No branch mentions the row.
      await target.nodes.Patient.update(PATIENT, {}, { validTo: LATE });
      const versionBefore = (await nodeRow(target, "Patient", "pat-1")).version;
      await branchA.store.nodes.Encounter.update(ENCOUNTER, {
        reason: "follow-up",
      });

      const report = unwrap(
        await mergeIncremental<CareGraph>({
          forkPoint,
          target,
          branches: [branchA],
          options: { branchOrder: BRANCH_ORDER },
        }),
      );

      // The target's own delta describes the DESTINATION, not a claim staged
      // against it, so there is nothing to apply and nothing to report. Writing
      // the row back at itself would bump the version, the history row and the
      // recorded-time entry of a row no branch touched — this store has
      // coalescing OFF, so only the plan can keep the write from happening.
      expect((await nodeRow(target, "Patient", "pat-1")).version).toBe(
        versionBefore,
      );
      expect(await nodeEnd(target, "Patient", "pat-1")).toBe(LATE);
      expect(report.validityEnds).toEqual([]);
    });

    it("does not write when a branch re-states the end the target holds", async () => {
      const forkPoint = await seededForkPoint();
      // A hand-seeded target with coalescing on: `branch()` clones do not inherit
      // store options, and the option is only meaningful on the WRITE side.
      const target = await seed(
        await newStore({ coalesceUnchangedUpserts: true }),
      );
      await target.nodes.Patient.update(PATIENT, {}, { validTo: LATE });
      const versionBefore = (await nodeRow(target, "Patient", "pat-1")).version;

      const branchA = await forkOf(forkPoint, BRANCH_A);
      await branchA.store.nodes.Patient.update(PATIENT, {}, { validTo: LATE });

      unwrap(
        await mergeIncremental<CareGraph>({
          forkPoint,
          target,
          branches: [branchA],
          options: { branchOrder: BRANCH_ORDER },
        }),
      );

      // The reconciled end differs from BASE (so it IS passed to the upsert) but
      // equals the committed one, so the coalesce check sees no window change and
      // skips the write entirely — no version bump, no history row, no revision
      // churn.
      expect((await nodeRow(target, "Patient", "pat-1")).version).toBe(
        versionBefore,
      );
      expect(await nodeEnd(target, "Patient", "pat-1")).toBe(LATE);
    });

    it("reports a fork validFrom divergence as unapplicable", async () => {
      const forkPoint = await seededForkPoint();
      const branchA = await forkOf(forkPoint, BRANCH_A);
      const beforeFrom = canonicalizeDatabaseTimestamp(
        (await nodeRow(forkPoint, "Patient", "pat-2")).valid_from,
      );
      // Soft-delete + resurrect is the only way to move a live row's lower bound,
      // and it moves it only inside the fork: the update SQL writes `valid_from`
      // under `clearDeleted` alone, so the merge can never apply the divergence.
      await branchA.store.nodes.Patient.delete(LONE_PATIENT);
      await branchA.store.nodes.Patient.upsertById(
        LONE_PATIENT,
        { name: "Ben Okafor" },
        { validFrom: LATEST },
      );

      const report = unwrap(
        await merge(forkPoint, [branchA], { branchOrder: BRANCH_ORDER }),
      );

      expect(unapplicableIds(report)).toContain("pat-2");
      expect(
        canonicalizeDatabaseTimestamp(
          (await nodeRow(forkPoint, "Patient", "pat-2")).valid_from,
        ),
      ).toBe(beforeFrom);
    });

    it("takes the earliest end across edges folded by repoint/dedupe", async () => {
      const forkPoint = await seededForkPoint();
      // A SECOND inherited edge with identical endpoints and props: repoint/dedupe
      // folds the two into one survivor, so the fold must not lose either end.
      await forkPoint.edges.hadEncounter.create(
        { kind: "Patient", id: "pat-1" },
        { kind: "Encounter", id: "enc-1" },
        { on: "2026-01-05" },
        { id: "edge-2" },
      );
      const branchA = await forkOf(forkPoint, BRANCH_A);
      const branchB = await forkOf(forkPoint, BRANCH_B);
      await branchA.store.edges.hadEncounter.update(
        EDGE_2,
        {},
        { validTo: LATE },
      );
      await branchB.store.edges.hadEncounter.update(
        EDGE_1,
        {},
        { validTo: EARLY },
      );

      unwrap(
        await merge(forkPoint, [branchA, branchB], {
          branchOrder: BRANCH_ORDER,
        }),
      );

      // "edge-1" is the min-id survivor of the fold; the end claimed on the
      // folded-away "edge-2" must not silently outlive its row unresolved.
      expect(await edgeEnd(forkPoint, "edge-1")).toBe(EARLY);
    });

    it("keeps a folded-away edge's end when the target's edge survives", async () => {
      const forkPoint = await seededForkPoint();
      await forkPoint.edges.hadEncounter.create(
        { kind: "Patient", id: "pat-1" },
        { kind: "Encounter", id: "enc-1" },
        { on: "2026-01-05" },
        { id: "edge-2" },
      );
      const target = (await forkOf(forkPoint, asBranchId("window-target")))
        .store;
      const branchA = await forkOf(forkPoint, BRANCH_A);
      // The target edits the SURVIVING edge's props and claims no end at all;
      // the branch ends the other edge of the same dedupe group.
      await target.edges.hadEncounter.update(EDGE_1, { on: "2026-02-02" });
      await branchA.store.edges.hadEncounter.update(
        EDGE_2,
        {},
        { validTo: EARLY },
      );

      unwrap(
        await mergeIncremental<CareGraph>({
          forkPoint,
          target,
          branches: [branchA],
          options: { branchOrder: BRANCH_ORDER },
        }),
      );

      // A survivor from the preferred branch keeps its own end verbatim, but it
      // has none here — so there is no committed-target window to protect, and
      // swallowing the only claimed end would be a silent window loss.
      expect(await edgeEnd(target, "edge-1")).toBe(EARLY);
    });

    it("lets a single branch extend an end to a later instant", async () => {
      const forkPoint = await seededForkPoint();
      await forkPoint.nodes.Patient.update(PATIENT, {}, { validTo: LATE });
      const branchA = await forkOf(forkPoint, BRANCH_A);
      await branchA.store.nodes.Patient.update(
        PATIENT,
        {},
        { validTo: LATEST },
      );

      unwrap(await merge(forkPoint, [branchA], { branchOrder: BRANCH_ORDER }));

      // The single-changer rule, not a blind `min` against base — otherwise no
      // branch could ever extend a window.
      expect(await nodeEnd(forkPoint, "Patient", "pat-1")).toBe(LATEST);
    });

    it("leaves the target's window alone for a props-only modification", async () => {
      const forkPoint = await seededForkPoint({
        coalesceUnchangedUpserts: true,
      });
      await forkPoint.nodes.Patient.update(PATIENT, {}, { validTo: LATE });
      const branchA = await forkOf(forkPoint, BRANCH_A);
      await branchA.store.nodes.Patient.update(PATIENT, { note: "seen" });

      const report = unwrap(
        await merge(forkPoint, [branchA], { branchOrder: BRANCH_ORDER }),
      );

      // A props-only edit passes NO window, so the committed one stands — the
      // compat anchor for every merge that predates window reconciliation.
      expect(await nodeEnd(forkPoint, "Patient", "pat-1")).toBe(LATE);
      expect(report.validityEnds).toEqual([]);
    });

    it("does not rewrite an unchanged row when nothing changed at all", async () => {
      const forkPoint = await seededForkPoint({
        coalesceUnchangedUpserts: true,
      });
      await forkPoint.nodes.Patient.update(PATIENT, {}, { validTo: LATE });
      const versionBefore = (await nodeRow(forkPoint, "Patient", "pat-1"))
        .version;
      const branchA = await forkOf(forkPoint, BRANCH_A);
      await branchA.store.nodes.Encounter.update(ENCOUNTER, {
        reason: "follow-up",
      });

      unwrap(await merge(forkPoint, [branchA], { branchOrder: BRANCH_ORDER }));

      expect((await nodeRow(forkPoint, "Patient", "pat-1")).version).toBe(
        versionBefore,
      );
    });
  },
);
