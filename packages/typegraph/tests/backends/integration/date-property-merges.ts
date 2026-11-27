/**
 * A graph merge carries a dated row's props in their STORED form — the ISO
 * text the store wrote for each `Date` — and writes them back through the
 * target's schema, where `z.date()` refuses text.
 *
 * `planMerge()` succeeded for a branch that added or edited a dated row, and
 * `applyMergePlan()` then refused the plan as not validating against the
 * active schema; `merge()` failed while committing; candidate staging (which
 * stages through import) returned a plan apply refused. Merge revives the
 * stored text through the store's one revival decision before validating and
 * writing, as import does.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
} from "../../../src";
import {
  applyMergePlan,
  asBranchId,
  branch,
  type CandidateWriteSet,
  captureCandidateWriteSetTarget,
  createMutationPlanBuilder,
  merge,
  planCandidateWriteSet,
  planMerge,
} from "../../../src/graph-merge";
import { isErr, isOk, unwrap } from "../../../src/graph-merge/result";
import { expectObservation } from "../../helpers/known-defect";
import { type IntegrationTestContext } from "./test-context";

const PUBLISHED = new Date("2024-01-02T03:04:05.678Z");
const REVISED = new Date("2024-03-04T05:06:07.890Z");
const LATER = new Date("2025-06-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

const MergedDocument = defineNode("MergedDatedDoc", {
  schema: z.object({
    title: z.string(),
    publishedAt: z.date(),
    review: z.object({ at: z.date() }).optional(),
    revisions: z.array(z.date()).optional(),
  }),
});

/** A date whose wrapper rewrites it on every parse. */
const ShiftedDocument = defineNode("MergedShiftedDoc", {
  schema: z.object({
    title: z.string(),
    at: z
      .date()
      .optional()
      .overwrite((date) =>
        date === undefined ? date : new Date(date.getTime() + DAY_MS),
      ),
  }),
});

const mergedCites = defineEdge("mergedDatedCites", {
  schema: z.object({ at: z.date() }),
});

const mergeGraph = defineGraph({
  id: "date_property_merges",
  nodes: {
    MergedDatedDoc: { type: MergedDocument },
    MergedShiftedDoc: { type: ShiftedDocument },
  },
  edges: {
    mergedDatedCites: {
      type: mergedCites,
      from: [MergedDocument],
      to: [MergedDocument],
    },
  },
});

type MergeStore = Store<typeof mergeGraph>;

/** What a read returns for the dated rows: the stored text, per id. */
async function storedDates(store: MergeStore) {
  const nodes = await store.nodes.MergedDatedDoc.find();
  const edges = await store.edges.mergedDatedCites.find();
  return {
    nodes: Object.fromEntries(
      nodes
        .map(
          (node) =>
            [
              node.id,
              {
                title: node.title,
                publishedAt: node.publishedAt,
                review: node.review,
                revisions: node.revisions,
              },
            ] as const,
        )
        .toSorted(([left], [right]) => left.localeCompare(right)),
    ),
    edges: Object.fromEntries(edges.map((edge) => [edge.id, edge.at])),
  };
}

/** A base holding one dated document, and a branch that adds and edits dated rows. */
async function seedBranch(context: IntegrationTestContext, branchId: string) {
  const base = await context.createStore(mergeGraph, {
    revisionTracking: true,
  });
  await base.nodes.MergedDatedDoc.create(
    {
      title: "kept",
      publishedAt: PUBLISHED,
      review: { at: PUBLISHED },
      revisions: [PUBLISHED],
    },
    { id: "kept" },
  );
  const fork = unwrap(
    await branch(base, () => context.createIsolatedBackend(), {
      id: asBranchId(branchId),
    }),
  );
  await fork.store.nodes.MergedDatedDoc.create(
    {
      title: "added",
      publishedAt: REVISED,
      review: { at: REVISED },
      revisions: [PUBLISHED, REVISED],
    },
    { id: "added" },
  );
  // An edit that leaves every date untouched, and one that restates a date.
  await fork.store.nodes.MergedDatedDoc.update(asNodeId("kept"), {
    title: "kept2",
  });
  await fork.store.edges.mergedDatedCites.create(
    { kind: "MergedDatedDoc", id: "added" },
    { kind: "MergedDatedDoc", id: "kept" },
    { at: LATER },
    { id: "cites" },
  );
  return { base, fork };
}

const MERGED_DATES = {
  nodes: {
    added: {
      title: "added",
      publishedAt: REVISED,
      review: { at: REVISED },
      revisions: [PUBLISHED, REVISED],
    },
    kept: {
      title: "kept2",
      publishedAt: PUBLISHED,
      review: { at: PUBLISHED },
      revisions: [PUBLISHED],
    },
  },
  edges: { cites: LATER },
} as const;

export function registerDatePropertyMergeIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a graph merge of dated rows", () => {
    it("planMerge plans and applyMergePlan applies a branch's dated writes", async () => {
      const { base, fork } = await seedBranch(context, "dated-plan");
      const plan = await planMerge(base, [fork]);
      expect(isOk(plan)).toBe(true);
      const applied = await applyMergePlan(base, unwrap(plan));
      expect(isErr(applied) ? applied.error.message : "applied").toBe(
        "applied",
      );
      expect(await storedDates(base)).toEqual(MERGED_DATES);
    });

    it("merge commits a branch's dated writes", async () => {
      const { base, fork } = await seedBranch(context, "dated-merge");
      const merged = await merge(base, [fork]);
      expect(isErr(merged) ? merged.error.message : "merged").toBe("merged");
      expect(await storedDates(base)).toEqual(MERGED_DATES);
    });

    it("a candidate write set of stored dates plans what apply applies", async () => {
      const target = await context.createStore(mergeGraph, {
        revisionTracking: true,
      });
      const writeSet: CandidateWriteSet = {
        formatVersion: 1,
        sourceId: "dated-candidate",
        target: await captureCandidateWriteSetTarget(target),
        nodes: [
          {
            kind: "MergedDatedDoc",
            id: "candidate",
            properties: {
              title: "candidate",
              publishedAt: REVISED.toISOString(),
              revisions: [REVISED.toISOString()],
            },
            validFrom: "2024-01-01T00:00:00.000Z",
          },
        ],
        edges: [],
      };
      const planned = await planCandidateWriteSet({
        target,
        writeSet,
        makeBackend: () => context.createIsolatedBackend(),
      });
      expect(isErr(planned) ? planned.error.message : "planned").toBe(
        "planned",
      );
      const applied = await applyMergePlan(target, unwrap(planned).plan);
      expect(isErr(applied) ? applied.error.message : "applied").toBe(
        "applied",
      );
      const read = await target.nodes.MergedDatedDoc.getById(
        asNodeId("candidate"),
      );
      expect([read?.publishedAt, read?.revisions]).toEqual([
        REVISED,
        [REVISED],
      ]);
    });

    it("a mutation plan of dated writes plans what apply applies", async () => {
      const store = await context.createHistoryStore(mergeGraph);
      await store.nodes.MergedDatedDoc.create(
        { title: "kept", publishedAt: PUBLISHED },
        { id: "kept" },
      );
      const builder = await createMutationPlanBuilder(store, "dated-mutations");
      const planned = await builder
        .createNode("MergedDatedDoc", "created", {
          title: "created",
          publishedAt: REVISED,
          revisions: [REVISED],
        })
        .updateNode("MergedDatedDoc", "kept", { review: { at: LATER } })
        .plan({ makeBackend: () => context.createIsolatedBackend() });
      expect(isErr(planned) ? planned.error.message : "planned").toBe(
        "planned",
      );
      const applied = await applyMergePlan(store, unwrap(planned));
      expect(isErr(applied) ? applied.error.message : "applied").toBe(
        "applied",
      );
      const [created, kept] = await Promise.all([
        store.nodes.MergedDatedDoc.getById(asNodeId("created")),
        store.nodes.MergedDatedDoc.getById(asNodeId("kept")),
      ]);
      expect([
        created?.publishedAt,
        created?.revisions,
        kept?.publishedAt,
        kept?.review,
      ]).toEqual([REVISED, [REVISED], PUBLISHED, { at: LATER }]);
    });

    it("a merge keeps a date whose wrapper rewrites it", async () => {
      const base = await context.createStore(mergeGraph, {
        revisionTracking: true,
      });
      const fork = unwrap(
        await branch(base, () => context.createIsolatedBackend(), {
          id: asBranchId("shifted"),
        }),
      );
      const created = await fork.store.nodes.MergedShiftedDoc.create(
        { title: "shifted", at: PUBLISHED },
        { id: "shifted" },
      );
      const stored = new Date(PUBLISHED.getTime() + DAY_MS).toISOString();
      expect(created.at).toEqual(new Date(stored));
      const merged = await merge(base, [fork]);
      expect(isErr(merged) ? merged.error.message : "merged").toBe("merged");
      const [row] = await base.nodes.MergedShiftedDoc.find();
      // The merge writes the branch's stored row through the target's schema,
      // so the wrapper's `.overwrite()` shifts the date again, as an update of
      // another property does. Main refused the write instead (every dated
      // row was refused).
      expectObservation({
        lane: { dialect: base.backend.dialect },
        observed: row?.at?.toISOString(),
        correct: stored,
        defects: [
          {
            label: "merge re-parses a stored value",
            on: {},
            today: new Date(PUBLISHED.getTime() + 2 * DAY_MS).toISOString(),
          },
        ],
      });
    });
  });
}
