/**
 * End-to-end contract for EDGE FOLD SURVIVORSHIP through a merge (issue #395).
 *
 * A repoint-induced fold rewrites the one row it keeps and ends none of the rows that
 * folded into it. Which member it keeps therefore decides whether the merge writes
 * ONTO a row the target already holds or BESIDE it: with the survivor picked by
 * minimum edge id, a branch-created row that happened to sort lower won, so the target
 * ended up holding the committed row at its pre-merge props AND a new row carrying the
 * merged result — two live rows for one folded relationship, with the edit staged for
 * the committed row never written and `merged.edges` counting one.
 *
 * The rule is now inherited-wins, the edge analog of the node path's base-id-wins
 * (design §6.4-C). These cases pin it end-to-end:
 *
 *   1. the inherited row survives whichever way the branch-created id sorts, so the
 *      outcome no longer depends on id lexicographics;
 *   2. the branch's edit lands on that row and no stale row is left beside it;
 *   3. the report agrees with the store — `merged.edges`, the property conflict's
 *      `entityId`, and the window resolution all name the row that persists;
 *   4. it holds with and without a preferred branch, so it does not ride on the
 *      incremental target's own survivor preference.
 *
 * Every case resolves a branch node against a COMMITTED one, because that is the only
 * way a fold set can hold an inherited row: clustering under the public snapshot
 * `merge()` runs over staged NEW nodes alone, so no committed endpoint is ever
 * repointed there and an inherited edge only ever meets a branch edge that already
 * named its endpoints — parallel rows, which #393 keeps apart.
 *
 * Runs on every backend in the matrix: what is asserted is the set of committed rows,
 * and a per-dialect test would happily certify a divergence.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  defineNodeIndex,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { rowPropsToObject } from "../../src/backend/types";
import { asEdgeId } from "../../src/core/types";
import { branch } from "../../src/graph-merge/branch";
import {
  mergeAgainstBase,
  mergeIncremental,
} from "../../src/graph-merge/merge";
import { unwrap } from "../../src/graph-merge/result";
import { enumerateAllEdges } from "../../src/graph-merge/state-diff";
import type { GraphBranch, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { canonicalizeDatabaseTimestamp } from "../../src/utils/date";
import { backendMatrix, getStoreBackend } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string() }),
});
const Encounter = defineNode("Encounter", {
  schema: z.object({ reason: z.string(), code: z.string() }),
});
const hadEncounter = defineEdge("hadEncounter", {
  // `note` is OPTIONAL so a fork can DELETE it: the commit resolves a folded inherited
  // row against that row's base props, which only happens when the fold lands on it.
  schema: z.object({ on: z.string(), note: z.string().optional() }),
  from: [Patient],
  to: [Encounter],
});

/**
 * The block key identity resolution works over: a declared, NON-unique index on
 * `code`, so a branch may stage a near-duplicate encounter carrying the committed
 * one's code (a unique constraint would refuse it in the branch store itself).
 */
const encounterCode = defineNodeIndex(Encounter, {
  name: "encounter_code_idx",
  fields: ["code"],
});

const careGraph = defineGraph({
  id: "edge-survivor-care",
  nodes: { Patient: { type: Patient }, Encounter: { type: Encounter } },
  edges: {
    hadEncounter: { type: hadEncounter, from: [Patient], to: [Encounter] },
  },
  indexes: [encounterCode],
});
type CareGraph = typeof careGraph;
type CareStore = Store<CareGraph>;

const PATIENT = { kind: "Patient", id: "pat-1" } as const;
const ENCOUNTER = { kind: "Encounter", id: "enc-1" } as const;
/** The near-duplicate encounter a branch stages; it resolves onto `enc-1`. */
const DUPLICATE_ENCOUNTER = { kind: "Encounter", id: "enc-2" } as const;
/** The inherited edge present at the fork point — the row the target holds. */
const INHERITED_EDGE = "edge-5";
const INHERITED = asEdgeId<typeof hadEncounter>(INHERITED_EDGE);
const BRANCH_A = asBranchId("survivor-branch-a");
const TARGET_BRANCH = asBranchId("survivor-target");
const BRANCH_ORDER = [BRANCH_A];

const ENCOUNTER_CODE = "code-1";
const ENCOUNTER_REASON = "routine annual physical examination";
/** Dice trigram ≈ 0.96 against `ENCOUNTER_REASON`, so the two resolve as one. */
const DUPLICATE_REASON = "routine annual physical examinations";

const INHERITED_DATE = "2026-01-05";
/** A base-only property, seeded when a case is about the fork DELETING one. */
const BASE_NOTE = "seen at reception";
/** What the branch edits the INHERITED edge's `on` to. */
const EDITED_DATE = "2026-02-02";
/** What the branch's own repointed edge says. */
const BRANCH_DATE = "2026-03-11";
/** In the FUTURE: `validFrom` defaults to creation and an inverted window is
 *  refused, so an authorable end must be after that instant. */
const END = "2100-01-01T00:00:00.000Z";

/**
 * The identity resolution every case needs: the branch's near-duplicate encounter
 * resolves against the committed one through the declared block index, so the edge
 * the branch authored onto it repoints onto the endpoints the inherited edge holds.
 */
function resolveDuplicateEncounters(): MergeOptions<CareGraph> {
  return {
    resolve: {
      Encounter: {
        blockIndex: "encounter_code_idx",
        similarity: { kind: "fulltext", fields: ["reason"] },
        threshold: 0.85,
      },
    },
    onPropertyConflict: "flag",
    branchOrder: BRANCH_ORDER,
  };
}

/** One committed `hadEncounter` row, reduced to what these cases assert. */
type CommittedEdge = Readonly<{
  id: string;
  fromId: string;
  toId: string;
  on: unknown;
  note: unknown;
  validTo: string | undefined;
}>;

describe.each(backendMatrix())("edge fold survivorship [$name]", (entry) => {
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
   * A fork point holding one patient, one encounter, and ONE edge joining them — so
   * every additional row a case ends up with is the merge's own doing. `baseNote` seeds
   * the optional edge property a fork can delete.
   */
  async function seededForkPoint(baseNote?: string): Promise<CareStore> {
    const [store] = await createStoreWithSchema(careGraph, await makeBackend());
    await store.nodes.Patient.create({ name: "Ana Rivera" }, { id: "pat-1" });
    await store.nodes.Encounter.create(
      { reason: ENCOUNTER_REASON, code: ENCOUNTER_CODE },
      { id: "enc-1" },
    );
    await store.edges.hadEncounter.create(
      PATIENT,
      ENCOUNTER,
      {
        on: INHERITED_DATE,
        ...(baseNote === undefined ? {} : { note: baseNote }),
      },
      { id: INHERITED_EDGE },
    );
    return store;
  }

  async function forkOf(
    forkPoint: CareStore,
    id = BRANCH_A,
  ): Promise<GraphBranch<CareGraph>> {
    return unwrap(
      await branch<CareGraph>(forkPoint, () => makeBackend(), { id }),
    );
  }

  /** Every LIVE `hadEncounter` row, id-sorted. */
  async function liveEdges(
    store: CareStore,
  ): Promise<readonly CommittedEdge[]> {
    const rows = await enumerateAllEdges(
      getStoreBackend(store),
      store.graphId,
      "hadEncounter",
    );
    return rows
      .filter((row) => row.deleted_at === undefined)
      .map((row) => ({
        id: row.id,
        fromId: row.from_id,
        toId: row.to_id,
        on: rowPropsToObject(row.props)["on"],
        note: rowPropsToObject(row.props)["note"],
        validTo: canonicalizeDatabaseTimestamp(row.valid_to),
      }))
      .sort((left, right) =>
        left.id < right.id ? -1
        : left.id > right.id ? 1
        : 0,
      );
  }

  // Both orderings of the branch-created id against the inherited "edge-5". The
  // min-id rule agreed with inherited-wins only in the second, so the LOW id is the
  // issue's reproduction and the HIGH id — which passed by luck — pins that the two
  // orders now agree.
  describe.each([
    { position: "sorts BEFORE", branchEdgeId: "edge-1" },
    { position: "sorts AFTER", branchEdgeId: "edge-9" },
  ])(
    "a repointed branch edge whose id $position the inherited one",
    ({ branchEdgeId }) => {
      /**
       * The branch edits the inherited edge and, separately, authors an edge onto a
       * near-duplicate encounter that resolves onto the inherited edge's endpoint. The
       * two edges become one relationship, so the merge folds them.
       */
      async function stageFoldOnto(
        forkPoint: CareStore,
      ): Promise<GraphBranch<CareGraph>> {
        const branchA = await forkOf(forkPoint);
        await branchA.store.edges.hadEncounter.update(INHERITED, {
          on: EDITED_DATE,
        });
        await branchA.store.nodes.Encounter.create(
          { reason: DUPLICATE_REASON, code: ENCOUNTER_CODE },
          { id: DUPLICATE_ENCOUNTER.id },
        );
        await branchA.store.edges.hadEncounter.create(
          PATIENT,
          DUPLICATE_ENCOUNTER,
          { on: BRANCH_DATE },
          { id: branchEdgeId },
        );
        return branchA;
      }

      it("folds onto the committed row, leaving no row beside it", async () => {
        const forkPoint = await seededForkPoint();
        const target = (await forkOf(forkPoint, TARGET_BRANCH)).store;
        const branchA = await stageFoldOnto(forkPoint);

        const report = unwrap(
          await mergeIncremental<CareGraph>({
            forkPoint,
            target,
            branches: [branchA],
            options: resolveDuplicateEncounters(),
          }),
        );

        expect(
          report.resolutions.map((resolution) => resolution.canonicalId),
        ).toEqual(["enc-1"]);
        // ONE row: the committed one, at the props the merge resolved. With the
        // branch-created id sorting lower this used to be two rows — the committed
        // edge still at INHERITED_DATE beside a new row holding the merged result.
        expect(
          (await liveEdges(target)).map((edge) => ({
            id: edge.id,
            toId: edge.toId,
            on: edge.on,
          })),
        ).toEqual([{ id: INHERITED_EDGE, toId: "enc-1", on: EDITED_DATE }]);
        // ...and the report describes exactly that row.
        expect(report.merged.edges).toBe(1);
        expect(
          report.conflicts
            .filter((conflict) => conflict.kind === "hadEncounter")
            .map((conflict) => ({
              entityId: conflict.entityId,
              property: conflict.property,
              values: conflict.values.map((value) => value.value),
            })),
        ).toEqual([
          {
            entityId: INHERITED_EDGE,
            property: "on",
            values: [EDITED_DATE, BRANCH_DATE],
          },
        ]);
      });

      it("folds onto the committed row with no preferred branch", async () => {
        // The same fold through the new-vs-base scope, whose target is the fork point
        // itself and which names no preferred branch. Nothing about inherited-wins
        // rides on the preferred-branch pick, so the outcome is the same one.
        const forkPoint = await seededForkPoint();
        const branchA = await stageFoldOnto(forkPoint);

        const report = unwrap(
          await mergeAgainstBase(
            forkPoint,
            [branchA],
            resolveDuplicateEncounters(),
          ),
        );

        expect(
          (await liveEdges(forkPoint)).map((edge) => ({
            id: edge.id,
            toId: edge.toId,
            on: edge.on,
          })),
        ).toEqual([{ id: INHERITED_EDGE, toId: "enc-1", on: EDITED_DATE }]);
        expect(report.merged.edges).toBe(1);
      });
    },
  );

  it("honors a fork's property DELETION on the committed row it folds onto", async () => {
    // Edges are written with PATCH semantics, so a removed key only disappears when the
    // commit resolves the write against the row's BASE props — which it looks up by the
    // surviving edge id. A survivor the target did not hold has no such entry, so the
    // deletion used to be dropped together with the row it was staged for; landing the
    // fold on the inherited row is what makes it reachable.
    const forkPoint = await seededForkPoint(BASE_NOTE);
    const target = (await forkOf(forkPoint, TARGET_BRANCH)).store;
    const branchA = await forkOf(forkPoint);
    await branchA.store.edges.hadEncounter.update(INHERITED, {
      on: EDITED_DATE,
      note: undefined,
    });
    await branchA.store.nodes.Encounter.create(
      { reason: DUPLICATE_REASON, code: ENCOUNTER_CODE },
      { id: DUPLICATE_ENCOUNTER.id },
    );
    await branchA.store.edges.hadEncounter.create(
      PATIENT,
      DUPLICATE_ENCOUNTER,
      { on: BRANCH_DATE },
      { id: "edge-1" },
    );

    unwrap(
      await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [branchA],
        options: resolveDuplicateEncounters(),
      }),
    );

    expect(
      (await liveEdges(target)).map((edge) => ({
        id: edge.id,
        on: edge.on,
        note: edge.note,
      })),
    ).toEqual([{ id: INHERITED_EDGE, on: EDITED_DATE, note: undefined }]);
  });

  it("lands a folded END on the committed row the branch ended", async () => {
    // The branch ends the inherited edge and authors a repointed edge that folds with
    // it. The end is resolved across the fold set either way; what the survivor rule
    // decides is WHICH row receives it. Picking the branch-created row put the end on
    // a brand-new row and left the ended one open — and the report said otherwise.
    const forkPoint = await seededForkPoint();
    const target = (await forkOf(forkPoint, TARGET_BRANCH)).store;
    const branchA = await forkOf(forkPoint);
    await branchA.store.edges.hadEncounter.update(
      INHERITED,
      {},
      {
        validTo: END,
      },
    );
    await branchA.store.nodes.Encounter.create(
      { reason: DUPLICATE_REASON, code: ENCOUNTER_CODE },
      { id: DUPLICATE_ENCOUNTER.id },
    );
    await branchA.store.edges.hadEncounter.create(
      PATIENT,
      DUPLICATE_ENCOUNTER,
      { on: BRANCH_DATE },
      { id: "edge-1" },
    );

    const report = unwrap(
      await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [branchA],
        options: resolveDuplicateEncounters(),
      }),
    );

    expect(
      (await liveEdges(target)).map((edge) => ({
        id: edge.id,
        validTo: edge.validTo,
      })),
    ).toEqual([{ id: INHERITED_EDGE, validTo: END }]);
    // The window resolution named the inherited row all along — now the store agrees.
    expect(
      report.validityEnds.map((resolution) => ({
        id: resolution.id,
        validTo: resolution.validTo,
      })),
    ).toEqual([{ id: INHERITED_EDGE, validTo: END }]);
  });
});
