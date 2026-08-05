/**
 * End-to-end contract for PARALLEL edges through a merge (issue #393).
 *
 * The store is a multigraph: nothing enforces uniqueness on `(from, kind, to)`,
 * `create()` makes a second edge between endpoints that already have one, and
 * `getOrCreateByEndpoints()` is the opt-in set-semantics accessor. A merge must
 * therefore produce what the branch's operation would have produced applied
 * straight to the target — so a branch that created a parallel edge merges as a
 * parallel edge.
 *
 * The repoint/dedupe fold used to group EVERY staged edge by `(from, kind, to)` and
 * collapse the group onto its min-id survivor. That destroyed the authored
 * multiplicity, and it did so unstably: whether the scenario ended with one edge or
 * two depended on how a branch-created id happened to sort against the inherited
 * one. These cases pin both halves of the replacement:
 *
 *   1. a branch-created parallel edge survives, with its OWN props, and raises no
 *      property conflict against the row it merely sits beside;
 *   2. that holds for both id orderings — the survivor pick can no longer decide
 *      the outcome;
 *   3. EDGE ID, not props equality, is what makes two staged edges "the same row":
 *      a new id is a new parallel edge even when its props coincide;
 *   4. a window claim lands on the row its author touched.
 *
 * A genuine repoint-induced collapse still folds — that fold is what the dedupe
 * exists for. Its end-to-end contract is `self-edge-collapse.test.ts` and
 * `valid-window-merge.test.ts`; its mechanics are `edge-repoint.test.ts`.
 *
 * Runs on every backend in the matrix: edge multiplicity is asserted through the
 * committed rows, and a per-dialect test would happily certify a divergence.
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
import { merge, mergeIncremental } from "../../src/graph-merge/merge";
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
  schema: z.object({ on: z.string() }),
  from: [Patient],
  to: [Encounter],
});

/**
 * The new-vs-base block key the MIXED case resolves on: a declared, non-unique index
 * over `code`, so a branch may stage a near-duplicate encounter carrying the committed
 * one's code (a unique constraint would refuse it in the branch store itself).
 */
const encounterCode = defineNodeIndex(Encounter, {
  name: "encounter_code_idx",
  fields: ["code"],
});

const careGraph = defineGraph({
  id: "parallel-edge-care",
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
/** The near-duplicate encounter a branch stages in the MIXED case. */
const DUPLICATE_ENCOUNTER = { kind: "Encounter", id: "enc-2" } as const;
/** The inherited edge present at the fork point. */
const INHERITED_EDGE = "edge-5";
const INHERITED = asEdgeId<typeof hadEncounter>(INHERITED_EDGE);
/** A SECOND inherited edge on the same endpoints, for the MIXED case. */
const SECOND_INHERITED_EDGE = "edge-7";
const SECOND_INHERITED = asEdgeId<typeof hadEncounter>(SECOND_INHERITED_EDGE);
const BRANCH_A = asBranchId("parallel-branch-a");
const TARGET_BRANCH = asBranchId("parallel-target");
const BRANCH_ORDER = [BRANCH_A];

/** The committed encounter's block key + reason, and the branch's near-duplicate of
 *  it (Dice trigram ≈ 0.96 ≥ the case's threshold, so the two resolve as one). */
const ENCOUNTER_CODE = "code-1";
const ENCOUNTER_REASON = "routine annual physical examination";
const DUPLICATE_REASON = "routine annual physical examinations";

const INHERITED_DATE = "2026-01-05";
/** What the SECOND inherited edge says at the fork point. */
const SECOND_INHERITED_DATE = "2026-01-19";
/** What a branch edits the INHERITED edge's `on` to. */
const EDITED_DATE = "2026-02-02";
/** What a branch edits the SECOND inherited edge's `on` to. */
const SECOND_EDITED_DATE = "2026-02-16";
/** What a branch's own, newly created parallel edge says. */
const BRANCH_DATE = "2026-03-11";
/** In the FUTURE: a row's `validFrom` defaults to creation, and an inverted
 *  window is refused, so an authorable end must be after that instant. */
const END = "2100-01-01T00:00:00.000Z";

/**
 * Merge options for the MIXED case: the branch's near-duplicate encounter resolves
 * against the committed one through the declared block index, so its edge repoints
 * onto endpoints the inherited parallel rows already occupy.
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

/** One committed `hadEncounter` row, reduced to what multiplicity cases assert. */
type CommittedEdge = Readonly<{
  id: string;
  fromId: string;
  toId: string;
  on: unknown;
  validTo: string | undefined;
}>;

describe.each(backendMatrix())("merging parallel edges [$name]", (entry) => {
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
   * A fork point holding one patient, one encounter, and ONE edge joining them —
   * so every additional edge a case commits is the merge's own doing.
   */
  async function seededForkPoint(): Promise<CareStore> {
    const [store] = await createStoreWithSchema(careGraph, await makeBackend());
    await store.nodes.Patient.create({ name: "Ana Rivera" }, { id: "pat-1" });
    await store.nodes.Encounter.create(
      { reason: ENCOUNTER_REASON, code: ENCOUNTER_CODE },
      { id: "enc-1" },
    );
    await store.edges.hadEncounter.create(
      PATIENT,
      ENCOUNTER,
      { on: INHERITED_DATE },
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
        validTo: canonicalizeDatabaseTimestamp(row.valid_to),
      }))
      .sort((left, right) =>
        left.id < right.id ? -1
        : left.id > right.id ? 1
        : 0,
      );
  }

  /** `liveEdges` is id-sorted, so every expectation is sorted the same way. */
  function byId<T extends Readonly<{ id: string }>>(rows: readonly T[]): T[] {
    return [...rows].sort((left, right) =>
      left.id < right.id ? -1
      : left.id > right.id ? 1
      : 0,
    );
  }

  // Both orderings of the branch-created id against the inherited "edge-5". The
  // branch also edits the inherited edge, which is what puts BOTH rows in front of
  // the fold — an untouched inherited edge is never staged, so the collision only
  // arises once some branch has something to say about it.
  //
  // On main the LOW branch id won the min-id pick, so the edit meant for the
  // inherited row landed on the branch's row and the inherited row kept its stale
  // props; the HIGH id kept the inherited row and dropped the branch's row
  // entirely. Both shapes lost an authored fact, and which one you got depended on
  // an id sort — the instability the adjudication called undependable.
  describe.each([
    { position: "sorts BEFORE", branchEdgeId: "edge-1" },
    { position: "sorts AFTER", branchEdgeId: "edge-9" },
  ])(
    "a branch-created parallel edge whose id $position the inherited one",
    ({ branchEdgeId }) => {
      it("commits beside the inherited edge, each carrying its own props", async () => {
        const forkPoint = await seededForkPoint();
        const branchA = await forkOf(forkPoint);
        await branchA.store.edges.hadEncounter.update(INHERITED, {
          on: EDITED_DATE,
        });
        await branchA.store.edges.hadEncounter.create(
          PATIENT,
          ENCOUNTER,
          { on: BRANCH_DATE },
          { id: branchEdgeId },
        );

        const report = unwrap(
          await merge(forkPoint, [branchA], { branchOrder: BRANCH_ORDER }),
        );

        expect(
          (await liveEdges(forkPoint)).map((edge) => ({
            id: edge.id,
            on: edge.on,
          })),
        ).toEqual(
          byId([
            { id: INHERITED_EDGE, on: EDITED_DATE },
            { id: branchEdgeId, on: BRANCH_DATE },
          ]),
        );
        // Two distinct rows sitting beside each other never disagree about a
        // property; the old fold reported a conflict it had itself manufactured.
        expect(report.conflicts).toEqual([]);
        expect(report.dropped).toEqual([]);
      });
    },
  );

  it("keeps a branch-created parallel edge whose props MATCH the inherited one", async () => {
    // Identity, not props equality, decides what counts as the same row: a fresh
    // id is a new relationship instance even when it says exactly the same thing.
    // On main the two shared a dedupe key, so this was the "exact-equal collapse"
    // fast path and the second row silently disappeared.
    const forkPoint = await seededForkPoint();
    const branchA = await forkOf(forkPoint);
    await branchA.store.edges.hadEncounter.update(INHERITED, {
      on: EDITED_DATE,
    });
    await branchA.store.edges.hadEncounter.create(
      PATIENT,
      ENCOUNTER,
      { on: EDITED_DATE },
      { id: "edge-1" },
    );

    unwrap(await merge(forkPoint, [branchA], { branchOrder: BRANCH_ORDER }));

    const edges = await liveEdges(forkPoint);
    expect(edges.map((edge) => edge.id)).toEqual(["edge-1", INHERITED_EDGE]);
    for (const edge of edges) {
      expect(edge.on).toBe(EDITED_DATE);
      expect(edge.fromId).toBe("pat-1");
      expect(edge.toId).toBe("enc-1");
    }
  });

  it("lands a window claim on the inherited row the branch ended", async () => {
    // The branch ends the inherited edge and, separately, adds a parallel one. On
    // main the end migrated to the min-id survivor — the branch's brand-new row —
    // and the row the author actually ended stayed open. This is the issue's
    // second symptom.
    const forkPoint = await seededForkPoint();
    const branchA = await forkOf(forkPoint);
    await branchA.store.edges.hadEncounter.update(
      INHERITED,
      {},
      {
        validTo: END,
      },
    );
    await branchA.store.edges.hadEncounter.create(
      PATIENT,
      ENCOUNTER,
      { on: BRANCH_DATE },
      { id: "edge-1" },
    );

    const report = unwrap(
      await merge(forkPoint, [branchA], { branchOrder: BRANCH_ORDER }),
    );

    expect(
      (await liveEdges(forkPoint)).map((edge) => ({
        id: edge.id,
        validTo: edge.validTo,
      })),
    ).toEqual([
      { id: "edge-1", validTo: undefined },
      { id: INHERITED_EDGE, validTo: END },
    ]);
    // The report describes the same two rows: the window resolution names the row it
    // landed on, and each parallel row counts once.
    expect(
      report.validityEnds.map((resolution) => ({
        id: resolution.id,
        validTo: resolution.validTo,
      })),
    ).toEqual([{ id: INHERITED_EDGE, validTo: END }]);
    expect(report.merged.edges).toBe(2);
  });

  it("keeps a parallel row's own edit when a repointed edge joins its endpoints", async () => {
    // The MIXED group: identity resolution collapses the branch's near-duplicate
    // encounter onto the committed one, so the branch's edge repoints onto endpoints
    // two parallel rows already occupy. The collapse is ACROSS the pre-repoint pairs —
    // it merges the repointed edge into ONE of those rows — and says nothing about the
    // rows that were already there. Folding the whole group instead left the other
    // row's edit unwritten (a folded-away committed row is never rewritten) and
    // reported a property conflict between rows that were never the same row.
    const forkPoint = await seededForkPoint();
    await forkPoint.edges.hadEncounter.create(
      PATIENT,
      ENCOUNTER,
      { on: SECOND_INHERITED_DATE },
      { id: SECOND_INHERITED_EDGE },
    );
    const target = (await forkOf(forkPoint, TARGET_BRANCH)).store;
    const branchA = await forkOf(forkPoint);
    await branchA.store.edges.hadEncounter.update(INHERITED, {
      on: EDITED_DATE,
    });
    await branchA.store.edges.hadEncounter.update(SECOND_INHERITED, {
      on: SECOND_EDITED_DATE,
    });
    await branchA.store.nodes.Encounter.create(
      { reason: DUPLICATE_REASON, code: ENCOUNTER_CODE },
      { id: DUPLICATE_ENCOUNTER.id },
    );
    await branchA.store.edges.hadEncounter.create(
      PATIENT,
      DUPLICATE_ENCOUNTER,
      { on: BRANCH_DATE },
      { id: "edge-9" },
    );

    const report = unwrap(
      await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [branchA],
        options: resolveDuplicateEncounters(),
      }),
    );

    // The duplicate encounter resolved onto the committed one...
    expect(
      report.resolutions.map((resolution) => resolution.canonicalId),
    ).toEqual(["enc-1"]);
    // ...the repointed edge folded into the min-id row of the pair it landed on, and
    // the other row committed the edit its author made.
    expect(
      (await liveEdges(target)).map((edge) => ({
        id: edge.id,
        toId: edge.toId,
        on: edge.on,
      })),
    ).toEqual([
      { id: INHERITED_EDGE, toId: "enc-1", on: EDITED_DATE },
      { id: SECOND_INHERITED_EDGE, toId: "enc-1", on: SECOND_EDITED_DATE },
    ]);
    // The only edge-level disagreement is between the two rows the collapse merged.
    expect(
      report.conflicts
        .filter((conflict) => conflict.kind === "hadEncounter")
        .map((conflict) => ({
          entityId: conflict.entityId,
          values: conflict.values.map((value) => value.value),
        })),
    ).toEqual([
      { entityId: INHERITED_EDGE, values: [EDITED_DATE, BRANCH_DATE] },
    ]);
  });

  it("resolves two INHERITED parallel edges independently", async () => {
    // Both rows exist at the fork point and the branch touches each differently:
    // it ends one and edits the other's props. Neither claim may cross over.
    const forkPoint = await seededForkPoint();
    await forkPoint.edges.hadEncounter.create(
      PATIENT,
      ENCOUNTER,
      { on: BRANCH_DATE },
      { id: "edge-1" },
    );
    const branchA = await forkOf(forkPoint);
    await branchA.store.edges.hadEncounter.update(
      INHERITED,
      {},
      {
        validTo: END,
      },
    );
    await branchA.store.edges.hadEncounter.update(
      asEdgeId<typeof hadEncounter>("edge-1"),
      { on: EDITED_DATE },
    );

    const report = unwrap(
      await merge(forkPoint, [branchA], { branchOrder: BRANCH_ORDER }),
    );

    expect(
      (await liveEdges(forkPoint)).map((edge) => ({
        id: edge.id,
        on: edge.on,
        validTo: edge.validTo,
      })),
    ).toEqual([
      { id: "edge-1", on: EDITED_DATE, validTo: undefined },
      { id: INHERITED_EDGE, on: INHERITED_DATE, validTo: END },
    ]);
    expect(report.conflicts).toEqual([]);
  });
});
