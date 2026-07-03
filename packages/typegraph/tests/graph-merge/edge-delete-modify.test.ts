import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { rowPropsToObject } from "../../src/backend/types";
import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import { isOk, unwrap } from "../../src/graph-merge/result";
import { enumerateAllEdges } from "../../src/graph-merge/state-diff";
import type {
  BranchId,
  GraphBranch,
  MergeOptions,
} from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

/**
 * Regression coverage for inherited-EDGE delete/modify handling (parity with the
 * node path):
 *   - an inherited edge deleted in a branch is actually removed from the merged
 *     target (previously staged but never applied — the edge stayed live);
 *   - disjoint edits to the same inherited edge by different branches 3-way merge
 *     against base instead of false-conflicting and dropping one edit;
 *   - a genuine same-field edge disagreement still surfaces as a conflict.
 *
 * The `link` edge carries TWO independent fields (`since`, `note`) so a per-field
 * disjoint edit is expressible.
 */
const Thing = defineNode("Thing", {
  schema: z.object({ name: z.string() }),
});

const link = defineEdge("link", {
  schema: z.object({ since: z.string(), note: z.string() }),
  from: [Thing],
  to: [Thing],
});

const graph = defineGraph({
  id: "edge-delete-modify-graph",
  nodes: { Thing: { type: Thing } },
  edges: { link: { type: link, from: [Thing], to: [Thing] } },
});

type EdgeGraph = typeof graph;

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");

function mergeOptions(): MergeOptions<EdgeGraph> {
  return { onPropertyConflict: "flag", branchOrder: [BRANCH_A, BRANCH_B] };
}

async function liveLinks(
  store: Store<EdgeGraph>,
): Promise<
  readonly Readonly<{ id: string; props: Record<string, unknown> }>[]
> {
  const rows = await enumerateAllEdges(store.backend, store.graphId, "link");
  return rows
    .filter((row) => row.deleted_at === undefined)
    .map((row) => ({
      id: row.id,
      props: rowPropsToObject(row.props),
    }));
}

describe.each(backendMatrix())("edge delete/modify [$name]", (entry) => {
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
    baseStore: Store<EdgeGraph>,
    id: BranchId,
  ): Promise<GraphBranch<EdgeGraph>> {
    return unwrap(
      await branch<EdgeGraph>(baseStore, () => makeBackend(), { id }),
    );
  }

  /** Base: two Things joined by one `link` edge, so every branch inherits it. */
  async function seed() {
    const [baseStore] = await createStoreWithSchema(graph, await makeBackend());
    const a = await baseStore.nodes.Thing.create({ name: "a" });
    const b = await baseStore.nodes.Thing.create({ name: "b" });
    const edge = await baseStore.edges.link.create(a, b, {
      since: "base",
      note: "base",
    });
    return { baseStore, edgeId: edge.id };
  }

  it("propagates an inherited edge deletion to the merged target", async () => {
    const { baseStore, edgeId } = await seed();
    const branchA = await makeBranch(baseStore, BRANCH_A);
    await branchA.store.edges.link.delete(edgeId);

    const result = await merge<EdgeGraph>(baseStore, [branchA], mergeOptions());
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      throw result.error;
    }

    // The branch's deletion is honored: the edge is gone from the target.
    expect(await liveLinks(baseStore)).toHaveLength(0);
    expect(result.data.deleteModifyConflicts).toHaveLength(0);
  });

  it("3-way merges disjoint edge edits without false conflicts or lost edits", async () => {
    const { baseStore, edgeId } = await seed();
    const branchA = await makeBranch(baseStore, BRANCH_A);
    const branchB = await makeBranch(baseStore, BRANCH_B);

    // Disjoint edits: A changes `since` only, B changes `note` only.
    await branchA.store.edges.link.update(edgeId, { since: "2025" });
    await branchB.store.edges.link.update(edgeId, { note: "B" });

    const result = await merge<EdgeGraph>(
      baseStore,
      [branchA, branchB],
      mergeOptions(),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      throw result.error;
    }

    // Both independent edits survive; neither is dropped and nothing false-conflicts.
    const links = await liveLinks(baseStore);
    expect(links).toHaveLength(1);
    expect(links[0]!.props).toMatchObject({ since: "2025", note: "B" });
    expect(result.data.conflicts).toHaveLength(0);
  });

  it("flags a genuine same-field edge conflict (both branches change `since`)", async () => {
    const { baseStore, edgeId } = await seed();
    const branchA = await makeBranch(baseStore, BRANCH_A);
    const branchB = await makeBranch(baseStore, BRANCH_B);

    await branchA.store.edges.link.update(edgeId, { since: "2025-A" });
    await branchB.store.edges.link.update(edgeId, { since: "2025-B" });

    const result = await merge<EdgeGraph>(
      baseStore,
      [branchA, branchB],
      mergeOptions(),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      throw result.error;
    }

    const sinceConflict = result.data.conflicts.find(
      (conflict) => conflict.property === "since",
    );
    expect(sinceConflict).toBeDefined();
    expect(sinceConflict!.entityId).toBe(edgeId);
    expect(sinceConflict!.values.map((value) => value.value).sort()).toEqual([
      "2025-A",
      "2025-B",
    ]);
    // `note` was untouched by both branches → no spurious conflict on it.
    expect(
      result.data.conflicts.some((conflict) => conflict.property === "note"),
    ).toBe(false);
  });
});
