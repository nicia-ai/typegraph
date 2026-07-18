import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { buildBranchRank } from "../../src/graph-merge/conflict-policy";
import type { DeleteModifyResolution } from "../../src/graph-merge/delete-modify";
import {
  DELETED_NODE_DROP_REASON,
  resolveDeleteModify,
} from "../../src/graph-merge/delete-modify";
import { unwrap } from "../../src/graph-merge/result";
import { stageBranches } from "../../src/graph-merge/staging";
import type {
  BranchId,
  DeleteModifyPolicy,
  GraphBranch,
} from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "delete-modify-test",
  nodes: { Person: { type: Person } },
  edges: {},
});

type G = typeof graph;

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");

/**
 * A plain, fully-comparable projection of a {@link DeleteModifyResolution} so two
 * resolutions can be deep-equality compared independent of input branch order.
 * Surviving modifications carry non-deterministic row meta, so we keep only the
 * load-bearing fields.
 */
type ResolutionShape = Readonly<{
  survivingModifications: readonly Readonly<{
    id: string;
    branchId: string;
    name: unknown;
  }>[];
  nodeDeletions: readonly Readonly<{ id: string; kind: string }>[];
  conflicts: readonly Readonly<{
    entityId: string;
    kind: string;
    deletedBy: string;
    modifiedBy: string;
    resolution: DeleteModifyPolicy;
  }>[];
  dropped: readonly Readonly<{ kind: string; id: string; reason: string }>[];
}>;

function projectResolution(
  resolution: DeleteModifyResolution,
): ResolutionShape {
  return {
    survivingModifications: resolution.survivingModifications.map(
      (modification) => ({
        id: modification.node.id,
        branchId: modification.branchId,
        name: modification.node.forkProps["name"],
      }),
    ),
    nodeDeletions: resolution.nodeDeletions.map((deletion) => ({
      id: deletion.id,
      kind: deletion.kind,
    })),
    conflicts: resolution.conflicts.map((conflict) => ({
      entityId: conflict.entityId,
      kind: conflict.kind,
      deletedBy: conflict.deletedBy,
      modifiedBy: conflict.modifiedBy,
      resolution: conflict.resolution,
    })),
    dropped: resolution.dropped.map((item) => ({
      kind: item.kind,
      id: item.id,
      reason: item.reason,
    })),
  };
}

describe.each(backendMatrix())("delete/modify resolution [$name]", (entry) => {
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
    baseStore: Store<G>,
    id: BranchId,
  ): Promise<GraphBranch<G>> {
    return unwrap(await branch<G>(baseStore, () => makeBackend(), { id }));
  }

  /**
   * Scenario shared by every policy: branchA DELETES inherited node N, branchB
   * MODIFIES N's name. Returns the staging set, the conflicted node id, and the
   * captured stable branch rank ([branchA, branchB]).
   */
  async function stageDeleteVsModify(): Promise<
    Readonly<{
      nodeId: string;
      staging: Awaited<ReturnType<typeof stageBranches<G>>>;
      branchRank: ReadonlyMap<BranchId, number>;
      branchA: GraphBranch<G>;
      branchB: GraphBranch<G>;
    }>
  > {
    const [baseStore] = await createStoreWithSchema(graph, await makeBackend());
    const inherited = await baseStore.nodes.Person.create({ name: "Origin" });

    const branchA = await makeBranch(baseStore, BRANCH_A);
    const branchB = await makeBranch(baseStore, BRANCH_B);

    await branchA.store.nodes.Person.delete(inherited.id);
    await branchB.store.nodes.Person.update(inherited.id, { name: "Modified" });

    const staging = await stageBranches(baseStore, [branchA, branchB]);
    const branchRank = buildBranchRank(
      [BRANCH_A, BRANCH_B],
      [branchA.id, branchB.id],
    );

    // The scenario must actually stage exactly one delete + one modify of N.
    expect(staging.deletedNodes).toHaveLength(1);
    expect(staging.modifiedNodes).toHaveLength(1);
    expect(staging.deletedNodes[0]?.node.id).toBe(inherited.id);
    expect(staging.modifiedNodes[0]?.node.id).toBe(inherited.id);

    return { nodeId: inherited.id, staging, branchRank, branchA, branchB };
  }

  it("'deleteWins' deletes N, records the conflict, and drops the node", async () => {
    const { nodeId, staging, branchRank } = await stageDeleteVsModify();

    const resolution = resolveDeleteModify(staging, "deleteWins", branchRank);

    // N is finally deleted; its modification does NOT survive.
    expect(resolution.survivingModifications).toHaveLength(0);
    expect(resolution.nodeDeletions).toHaveLength(1);
    expect(resolution.nodeDeletions[0]).toEqual({
      id: nodeId,
      kind: "Person",
    });

    // The conflict is recorded with the correct provenance + resolution.
    expect(resolution.conflicts).toHaveLength(1);
    expect(resolution.conflicts[0]).toEqual({
      entityId: nodeId,
      kind: "Person",
      deletedBy: BRANCH_A,
      modifiedBy: BRANCH_B,
      resolution: "deleteWins",
    });

    // The deleted node is enumerated as dropped from the merged graph.
    expect(resolution.dropped).toEqual([
      { kind: "node", id: nodeId, reason: DELETED_NODE_DROP_REASON },
    ]);
  });

  it("'modifyWins' resurrects N with branchB's props and records the conflict", async () => {
    const { nodeId, staging, branchRank } = await stageDeleteVsModify();

    const resolution = resolveDeleteModify(staging, "modifyWins", branchRank);

    // N is kept: branchB's modification survives, nothing is deleted/dropped.
    expect(resolution.nodeDeletions).toHaveLength(0);
    expect(resolution.dropped).toHaveLength(0);
    expect(resolution.survivingModifications).toHaveLength(1);
    const survivor = requireDefined(resolution.survivingModifications[0]);
    expect(survivor.node.id).toBe(nodeId);
    expect(survivor.branchId).toBe(BRANCH_B);
    expect(survivor.node.forkProps).toMatchObject({ name: "Modified" });

    // The conflict is still recorded (resolved as modifyWins).
    expect(resolution.conflicts).toHaveLength(1);
    expect(resolution.conflicts[0]).toEqual({
      entityId: nodeId,
      kind: "Person",
      deletedBy: BRANCH_A,
      modifiedBy: BRANCH_B,
      resolution: "modifyWins",
    });
  });

  it("'flag' keeps the modification but surfaces the conflict UNRESOLVED", async () => {
    const { nodeId, staging, branchRank } = await stageDeleteVsModify();

    const resolution = resolveDeleteModify(staging, "flag", branchRank);

    // Like modifyWins, the modification is kept and nothing is deleted...
    expect(resolution.nodeDeletions).toHaveLength(0);
    expect(resolution.dropped).toHaveLength(0);
    expect(resolution.survivingModifications).toHaveLength(1);
    expect(resolution.survivingModifications[0]?.node.id).toBe(nodeId);
    expect(resolution.survivingModifications[0]?.node.forkProps).toMatchObject({
      name: "Modified",
    });

    // ...but the conflict is recorded as UNRESOLVED ("flag") for human review.
    expect(resolution.conflicts).toHaveLength(1);
    expect(resolution.conflicts[0]?.resolution).toBe("flag");
    expect(resolution.conflicts[0]).toEqual({
      entityId: nodeId,
      kind: "Person",
      deletedBy: BRANCH_A,
      modifiedBy: BRANCH_B,
      resolution: "flag",
    });
  });

  it.each<DeleteModifyPolicy>(["deleteWins", "modifyWins", "flag"])(
    "resolves identically across reversed branch order under '%s'",
    async (policy) => {
      const [baseStore] = await createStoreWithSchema(
        graph,
        await makeBackend(),
      );
      const inherited = await baseStore.nodes.Person.create({ name: "Origin" });

      const branchA = await makeBranch(baseStore, BRANCH_A);
      const branchB = await makeBranch(baseStore, BRANCH_B);

      await branchA.store.nodes.Person.delete(inherited.id);
      await branchB.store.nodes.Person.update(inherited.id, {
        name: "Modified",
      });

      // Stage + rank the branches FORWARD ([A, B]) and REVERSED ([B, A]). Both
      // staging (T7) and the captured branch rank (T8) are pure functions of the
      // unordered set, so the delete/modify resolution must be identical.
      const forwardStaging = await stageBranches(baseStore, [branchA, branchB]);
      const reversedStaging = await stageBranches(baseStore, [
        branchB,
        branchA,
      ]);
      const forwardRank = buildBranchRank(
        [BRANCH_A, BRANCH_B],
        [branchA.id, branchB.id],
      );
      const reversedRank = buildBranchRank(
        [BRANCH_A, BRANCH_B],
        [branchB.id, branchA.id],
      );

      const forward = resolveDeleteModify(forwardStaging, policy, forwardRank);
      const reversed = resolveDeleteModify(
        reversedStaging,
        policy,
        reversedRank,
      );

      expect(projectResolution(reversed)).toEqual(projectResolution(forward));
    },
  );

  it("passes pure deletions and pure modifications through unconflicted", async () => {
    const [baseStore] = await createStoreWithSchema(graph, await makeBackend());
    const toDelete = await baseStore.nodes.Person.create({ name: "Doomed" });
    const toModify = await baseStore.nodes.Person.create({ name: "Mutable" });

    const branchA = await makeBranch(baseStore, BRANCH_A);
    const branchB = await makeBranch(baseStore, BRANCH_B);

    // branchA deletes one node; branchB modifies a DIFFERENT node. No overlap →
    // no delete/modify conflict.
    await branchA.store.nodes.Person.delete(toDelete.id);
    await branchB.store.nodes.Person.update(toModify.id, { name: "Changed" });

    const staging = await stageBranches(baseStore, [branchA, branchB]);
    const branchRank = buildBranchRank(
      [BRANCH_A, BRANCH_B],
      [branchA.id, branchB.id],
    );

    const resolution = resolveDeleteModify(staging, "flag", branchRank);

    expect(resolution.conflicts).toHaveLength(0);
    expect(resolution.dropped).toHaveLength(0);
    expect(resolution.nodeDeletions).toEqual([
      { id: toDelete.id, kind: "Person" },
    ]);
    expect(resolution.survivingModifications).toHaveLength(1);
    expect(resolution.survivingModifications[0]?.node.id).toBe(toModify.id);
    expect(resolution.survivingModifications[0]?.node.forkProps).toMatchObject({
      name: "Changed",
    });
  });
});
