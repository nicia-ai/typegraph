/**
 * A required part whose inherited composition edge canonicalization drops
 * because the whole is deleted.
 *
 * Fixture: `partOf(EPart, EWhole, { via: eHolds, existence: "required" })`.
 * The fork point holds `w1`, `p1` and the composition edge between them.
 * Branch A edits `p1` and the edge; branch B deletes `w1`, which cascades its
 * own copies of `p1` and the edge. The merge then resolves the
 * delete/modify conflict on `p1` and the edge under each
 * `onDeleteModifyConflict` policy.
 *
 * Under `modifyWins` and `flag`, `p1` survives, while the edge is dropped
 * with `edge:endpoint-deleted`: its whole is gone. The merge issues no write
 * for that dropped edge, so no per-write composition guard ever sees it. The
 * plan-time report and the in-transaction apply refusal still catch the
 * orphan, because the "deleted" arm reads the target's live parts closure of
 * every whole the plan deletes. Under `deleteWins` the part is deleted with
 * its whole and the merge commits cleanly.
 *
 * The surviving part is also a node upsert, so the final-state "unattached"
 * check would refuse it as well; asserting `cause: "deleted"` pins the
 * "deleted" arm, which runs first. Disabling that arm turns the refusal into
 * `cause: "unattached"`; disabling both lets apply commit the orphan.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { ENDPOINT_DELETED_DROP_REASON } from "../../src/graph-merge/edge-repoint";
import { MergeCompositionOrphanError } from "../../src/graph-merge/errors";
import {
  applyMergePlan,
  planMergeIncremental,
} from "../../src/graph-merge/merge";
import { isErr, isOk } from "../../src/graph-merge/result";
import {
  asBranchId,
  type DeleteModifyPolicy,
  type GraphBranch,
} from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const EWhole = defineNode("EWhole", {
  schema: z.object({ name: z.string() }),
});
const EPart = defineNode("EPart", { schema: z.object({ name: z.string() }) });
const eHolds = defineEdge("eHolds", {
  schema: z.object({ note: z.string() }),
});

const graph = defineGraph({
  id: "composition-orphan-endpoint-deleted-test",
  nodes: {
    EWhole: { type: EWhole },
    EPart: { type: EPart },
  },
  edges: {
    eHolds: {
      type: eHolds,
      from: [EPart],
      to: [EWhole],
      cardinality: "one",
    },
  },
  ontology: [partOf(EPart, EWhole, { via: eHolds, existence: "required" })],
});
type G = typeof graph;

const BRANCH_EDITS_PART = asBranchId("branch-edits-part");
const BRANCH_DELETES_WHOLE = asBranchId("branch-deletes-whole");

const ORPHANING_POLICIES: readonly DeleteModifyPolicy[] = [
  "modifyWins",
  "flag",
];

describe.each(backendMatrix())(
  "composition orphan — required part whose whole another branch deletes [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const cleanup of cleanups) {
        await cleanup();
      }
      cleanups = [];
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function makeBranchOf(
      forkPoint: Store<G>,
      id: ReturnType<typeof asBranchId>,
    ): Promise<GraphBranch<G>> {
      const result = await branch<G>(forkPoint, () => makeBackend(), { id });
      if (isErr(result)) throw result.error;
      return result.data;
    }

    async function divergentBranches(): Promise<
      Readonly<{
        target: Store<G>;
        edgeId: string;
        branches: readonly GraphBranch<G>[];
      }>
    > {
      const [target] = await createStoreWithSchema(graph, await makeBackend(), {
        revisionTracking: true,
      });
      const whole = await target.nodes.EWhole.create(
        { name: "whole" },
        { id: "w1" },
      );
      const part = await target.nodes.EPart.create(
        { name: "part" },
        {
          id: "p1",
          partOf: {
            whole: { kind: "EWhole", id: whole.id },
            props: { note: "original" },
          },
        },
      );
      const [edge] = await target.edges.eHolds.find({});
      if (edge === undefined) throw new Error("expected a composition edge");

      const editsPart = await makeBranchOf(target, BRANCH_EDITS_PART);
      await editsPart.store.nodes.EPart.update(part.id, {
        name: "part (edited)",
      });
      await editsPart.store.edges.eHolds.update(edge.id, {
        note: "edited",
      });

      const deletesWhole = await makeBranchOf(target, BRANCH_DELETES_WHOLE);
      await deletesWhole.store.nodes.EWhole.delete(whole.id);

      return {
        target,
        edgeId: edge.id,
        branches: [editsPart, deletesWhole],
      };
    }

    it.each(ORPHANING_POLICIES)(
      "reports at plan time and refuses at apply when the part survives under %s",
      async (policy) => {
        const { target, edgeId, branches } = await divergentBranches();

        const planResult = await planMergeIncremental<G>({
          forkPoint: target,
          target,
          branches,
          options: { onDeleteModifyConflict: policy },
        });
        if (!isOk(planResult)) throw planResult.error;
        const artifact = planResult.data;

        expect(
          artifact.writes.nodeDeletes.map((deletion) => deletion.id),
        ).toEqual(["w1"]);
        expect(artifact.review.dropped).toContainEqual({
          kind: "edge",
          id: edgeId,
          reason: ENDPOINT_DELETED_DROP_REASON,
        });
        expect(artifact.review.compositionOrphans).toEqual([
          {
            part: { kind: "EPart", id: "p1" },
            whole: { kind: "EWhole", id: "w1" },
            viaEdgeKind: "eHolds",
            cause: "deleted",
          },
        ]);

        const applyResult = await applyMergePlan(target, artifact);
        if (!isErr(applyResult)) {
          throw new Error(
            `expected apply to be refused; committed revision ${JSON.stringify(applyResult.data)}`,
          );
        }
        expect(applyResult.error).toBeInstanceOf(MergeCompositionOrphanError);
        expect(applyResult.error.details).toEqual({
          part: { kind: "EPart", id: "p1" },
          whole: { kind: "EWhole", id: "w1" },
          viaEdgeKind: "eHolds",
          cause: "deleted",
        });

        await expect(
          target.nodes.EWhole.getById("w1" as never),
        ).resolves.toMatchObject({ name: "whole" });
        await expect(
          target.nodes.EPart.getById("p1" as never),
        ).resolves.toMatchObject({ name: "part" });
        await expect(target.edges.eHolds.find({})).resolves.toEqual([
          expect.objectContaining({ id: edgeId, note: "original" }),
        ]);
        await expect(target.verifyConstraintFences()).resolves.toEqual([]);
      },
    );

    it("deletes the part with its whole under deleteWins", async () => {
      const { target, branches } = await divergentBranches();

      const planResult = await planMergeIncremental<G>({
        forkPoint: target,
        target,
        branches,
        options: { onDeleteModifyConflict: "deleteWins" },
      });
      if (!isOk(planResult)) throw planResult.error;
      const artifact = planResult.data;

      expect(
        artifact.writes.nodeDeletes.map((deletion) => deletion.id).toSorted(),
      ).toEqual(["p1", "w1"]);
      expect(artifact.review.compositionOrphans).toEqual([]);

      const applyResult = await applyMergePlan(target, artifact);
      if (!isOk(applyResult)) throw applyResult.error;

      await expect(
        target.nodes.EWhole.getById("w1" as never),
      ).resolves.toBeUndefined();
      await expect(
        target.nodes.EPart.getById("p1" as never),
      ).resolves.toBeUndefined();
      await expect(target.edges.eHolds.find({})).resolves.toEqual([]);
      await expect(target.verifyConstraintFences()).resolves.toEqual([]);
    });
  },
);
