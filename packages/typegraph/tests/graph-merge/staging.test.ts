import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { unwrap } from "../../src/graph-merge/result";
import type { StagingSet } from "../../src/graph-merge/staging";
import { stageBranches } from "../../src/graph-merge/staging";
import type { BranchId, GraphBranch } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
  from: [Person],
  to: [Person],
});

const graph = defineGraph({
  id: "staging-test",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

type G = typeof graph;

/**
 * A comparable, fully-sorted plain projection of a {@link StagingSet} so two
 * sets can be deep-equality compared independent of branch ordering. Raw rows
 * carry non-deterministic meta (timestamps), so we project only the load-bearing
 * fields: ids, kinds, branch tags, and parsed props.
 */
type StagingShape = Readonly<{
  newNodes: readonly Readonly<{
    kind: string;
    id: string;
    branchId: string;
    name: unknown;
  }>[];
  modifiedNodes: readonly Readonly<{
    kind: string;
    id: string;
    branchId: string;
    name: unknown;
  }>[];
  deletedNodes: readonly Readonly<{
    kind: string;
    id: string;
    branchId: string;
  }>[];
  newEdges: readonly Readonly<{
    kind: string;
    id: string;
    branchId: string;
    from: string;
    to: string;
  }>[];
  modifiedEdges: readonly Readonly<{
    kind: string;
    id: string;
    branchId: string;
  }>[];
  deletedEdges: readonly Readonly<{
    kind: string;
    id: string;
    branchId: string;
  }>[];
}>;

function projectStaging(staging: StagingSet): StagingShape {
  const newNodes = [...staging.newNodesByKind.entries()].flatMap(
    ([kind, members]) =>
      members.map((member) => ({
        kind,
        id: member.node.id,
        branchId: member.branchId,
        name: member.node.props.name,
      })),
  );
  const newEdges = [...staging.newEdgesByKind.entries()].flatMap(
    ([kind, members]) =>
      members.map((member) => ({
        kind,
        id: member.edge.id,
        branchId: member.branchId,
        from: member.edge.fromId,
        to: member.edge.toId,
      })),
  );
  return {
    newNodes,
    modifiedNodes: staging.modifiedNodes.map((member) => ({
      kind: member.node.kind,
      id: member.node.id,
      branchId: member.branchId,
      name: member.node.forkProps.name,
    })),
    deletedNodes: staging.deletedNodes.map((member) => ({
      kind: member.node.kind,
      id: member.node.id,
      branchId: member.branchId,
    })),
    newEdges,
    modifiedEdges: staging.modifiedEdges.map((member) => ({
      kind: member.edge.kind,
      id: member.edge.id,
      branchId: member.branchId,
    })),
    deletedEdges: staging.deletedEdges.map((member) => ({
      kind: member.edge.kind,
      id: member.edge.id,
      branchId: member.branchId,
    })),
  };
}

describe.each(backendMatrix())("staging [$name]", (entry) => {
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

  async function makeBranch(baseStore: Store<G>): Promise<GraphBranch<G>> {
    return unwrap(await branch<G>(baseStore, () => makeBackend()));
  }

  it("unions both branches' diffs, tags provenance, surfaces the inherited node once per branch", async () => {
    const [baseStore] = await createStoreWithSchema(graph, await makeBackend());
    const inherited = await baseStore.nodes.Person.create({ name: "Origin" });

    const branchA = await makeBranch(baseStore);
    const branchB = await makeBranch(baseStore);

    // Each branch modifies the SAME inherited node differently...
    await branchA.store.nodes.Person.update(inherited.id, { name: "From A" });
    await branchB.store.nodes.Person.update(inherited.id, { name: "From B" });
    // ...and each adds a DISTINCT new node.
    const newA = await branchA.store.nodes.Person.create({ name: "Alpha" });
    const newB = await branchB.store.nodes.Person.create({ name: "Beta" });

    const staging = await stageBranches(baseStore, [branchA, branchB]);

    // Both new nodes present and tagged by their origin branch.
    const personNew = staging.newNodesByKind.get("Person") ?? [];
    const newById = new Map(
      personNew.map((member) => [member.node.id as string, member] as const),
    );
    expect(newById.size).toBe(2);
    expect(newById.get(newA.id)?.branchId).toBe(branchA.id);
    expect(newById.get(newA.id)?.node.props).toMatchObject({ name: "Alpha" });
    expect(newById.get(newB.id)?.branchId).toBe(branchB.id);
    expect(newById.get(newB.id)?.node.props).toMatchObject({ name: "Beta" });

    // The inherited node appears ONCE PER BRANCH (ready for conflict detection),
    // each entry tagged + carrying that branch's divergent props.
    const inheritedMods = staging.modifiedNodes.filter(
      (member) => (member.node.id as string) === inherited.id,
    );
    expect(inheritedMods).toHaveLength(2);
    const moduleByBranch = new Map<BranchId, (typeof inheritedMods)[number]>(
      inheritedMods.map((member) => [member.branchId, member] as const),
    );
    expect(moduleByBranch.get(branchA.id)?.node.forkProps).toMatchObject({
      name: "From A",
    });
    expect(moduleByBranch.get(branchB.id)?.node.forkProps).toMatchObject({
      name: "From B",
    });

    // No spurious deletes / edge churn for this scenario.
    expect(staging.deletedNodes).toHaveLength(0);
    expect(staging.modifiedEdges).toHaveLength(0);
    expect(staging.deletedEdges).toHaveLength(0);
  });

  it("produces a structurally identical StagingSet for reversed branch order", async () => {
    const [baseStore] = await createStoreWithSchema(graph, await makeBackend());
    const inherited = await baseStore.nodes.Person.create({ name: "Origin" });
    const peer = await baseStore.nodes.Person.create({ name: "Peer" });
    const inheritedEdge = await baseStore.edges.knows.create(inherited, peer, {
      since: "2020",
    });

    const branchA = await makeBranch(baseStore);
    const branchB = await makeBranch(baseStore);

    // branchA: modify inherited node + edge, add a new node, delete peer's edge? No —
    // exercise a deletion: branchA deletes the inherited edge then peer.
    await branchA.store.nodes.Person.update(inherited.id, { name: "From A" });
    await branchA.store.nodes.Person.create({ name: "Alpha" });
    await branchA.store.edges.knows.update(inheritedEdge.id, { since: "2021" });

    // branchB: modify the same inherited node differently, add a new node,
    // delete the inherited edge then peer (so a deletion is staged too).
    await branchB.store.nodes.Person.update(inherited.id, { name: "From B" });
    await branchB.store.nodes.Person.create({ name: "Beta" });
    await branchB.store.edges.knows.delete(inheritedEdge.id);
    await branchB.store.nodes.Person.delete(peer.id);

    const forward = await stageBranches(baseStore, [branchA, branchB]);
    const reversed = await stageBranches(baseStore, [branchB, branchA]);

    // The union staging set is a pure function of the unordered branch SET, so
    // its canonical projection must be byte-identical across input orderings.
    expect(projectStaging(reversed)).toEqual(projectStaging(forward));

    // Sanity: the scenario actually produced cross-branch churn worth ordering.
    expect(forward.modifiedNodes.length).toBeGreaterThanOrEqual(2);
    expect(forward.deletedNodes.length).toBeGreaterThanOrEqual(1);
    expect(forward.deletedEdges.length).toBeGreaterThanOrEqual(1);
    expect(forward.modifiedEdges.length).toBeGreaterThanOrEqual(1);
    expect(
      (forward.newNodesByKind.get("Person") ?? []).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("stages an empty union when no branch diverges from base", async () => {
    const [baseStore] = await createStoreWithSchema(graph, await makeBackend());
    await baseStore.nodes.Person.create({ name: "Untouched" });

    const branchA = await makeBranch(baseStore);
    const branchB = await makeBranch(baseStore);

    const staging = await stageBranches(baseStore, [branchA, branchB]);

    expect(staging.newNodesByKind.size).toBe(0);
    expect(staging.modifiedNodes).toHaveLength(0);
    expect(staging.deletedNodes).toHaveLength(0);
    expect(staging.newEdgesByKind.size).toBe(0);
    expect(staging.modifiedEdges).toHaveLength(0);
    expect(staging.deletedEdges).toHaveLength(0);
  });
});
