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
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import {
  enumerateAllEdges,
  enumerateAllNodes,
} from "../../src/graph-merge/state-diff";
import { asBranchId } from "../../src/graph-merge/types";
import { cloneWorkingCopyStrategy } from "../../src/graph-merge/working-copy";
import { exportGraph, importGraph } from "../../src/interchange";
import {
  backendMatrix,
  getBackendProperty,
  getStoreBackend,
} from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
  from: [Person],
  to: [Person],
});

const graph = defineGraph({
  id: "branch-test",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

type G = typeof graph;

const WorkItem = defineNode("WorkItem", {
  schema: z.object({
    title: z.string(),
    status: z.string(),
  }),
});

const Label = defineNode("Label", {
  schema: z.object({
    name: z.string(),
  }),
});

const blocks = defineEdge("blocks", {
  schema: z.object({
    reason: z.string(),
  }),
  from: [WorkItem],
  to: [WorkItem],
});

const materializationGraph = defineGraph({
  id: "branch-materialization-copy-test",
  nodes: {
    WorkItem: { type: WorkItem },
    Label: { type: Label },
  },
  edges: {
    blocks: { type: blocks, from: [WorkItem], to: [WorkItem] },
  },
});

type MaterializationGraph = typeof materializationGraph;

/** Live `{ id, name }` snapshot of every Person node in a store, sorted by id. */
async function snapshotPeople(
  store: Store<G>,
): Promise<readonly Readonly<{ id: string; name: unknown }>[]> {
  const rows = await enumerateAllNodes(
    getStoreBackend(store),
    store.graphId,
    "Person",
  );
  return rows
    .filter((row) => row.deleted_at === undefined)
    .map((row) => ({
      id: row.id,
      name: rowPropsToObject(row.props)["name"],
    }))
    .sort((left, right) =>
      left.id < right.id ? -1
      : left.id > right.id ? 1
      : 0,
    );
}

/** Live `{ id, from, to, since }` snapshot of every knows edge, sorted by id. */
async function snapshotEdges(
  store: Store<G>,
): Promise<
  readonly Readonly<{ id: string; from: string; to: string; since: unknown }>[]
> {
  const rows = await enumerateAllEdges(
    getStoreBackend(store),
    store.graphId,
    "knows",
  );
  return rows
    .filter((row) => row.deleted_at === undefined)
    .map((row) => ({
      id: row.id,
      from: row.from_id,
      to: row.to_id,
      since: rowPropsToObject(row.props)["since"],
    }))
    .sort((left, right) =>
      left.id < right.id ? -1
      : left.id > right.id ? 1
      : 0,
    );
}

describe.each(backendMatrix())("branch [$name]", (entry) => {
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

  async function seedBase() {
    const [baseStore] = await createStoreWithSchema(graph, await makeBackend());
    const alice = await baseStore.nodes.Person.create({ name: "Alice" });
    const bob = await baseStore.nodes.Person.create({ name: "Bob" });
    const edge = await baseStore.edges.knows.create(alice, bob, {
      since: "2020",
    });
    return {
      baseStore,
      aliceId: alice.id,
      bobId: bob.id,
      edgeId: edge.id,
    };
  }

  it("identical base tokens, deep-copies base data, and isolates mutations", async () => {
    const { baseStore, aliceId, bobId, edgeId } = await seedBase();

    const baseBefore = await snapshotPeople(baseStore);
    const baseEdgesBefore = await snapshotEdges(baseStore);

    const branchAResult = await branch<G>(baseStore, () => makeBackend());
    const branchBResult = await branch<G>(baseStore, () => makeBackend());
    expect(isOk(branchAResult)).toBe(true);
    expect(isOk(branchBResult)).toBe(true);
    const branchA = unwrap(branchAResult);
    const branchB = unwrap(branchBResult);

    // (a) Both branches forked from the same immutable base@V.
    expect(branchA.base).toBe(branchB.base);

    // Distinct branch ids and distinct backing stores.
    expect(branchA.id).not.toBe(branchB.id);
    expect(branchA.store).not.toBe(branchB.store);
    expect(getStoreBackend(branchA.store)).not.toBe(
      getStoreBackend(branchB.store),
    );
    expect(getStoreBackend(branchA.store)).not.toBe(getStoreBackend(baseStore));

    // (b) Each branch.store is a deep, id-preserving copy of base data.
    expect(await snapshotPeople(branchA.store)).toEqual(baseBefore);
    expect(await snapshotPeople(branchB.store)).toEqual(baseBefore);
    expect(await snapshotEdges(branchA.store)).toEqual(baseEdgesBefore);
    expect(await snapshotEdges(branchB.store)).toEqual(baseEdgesBefore);
    // Spot-check ID preservation through the clone.
    expect((await branchA.store.nodes.Person.getById(aliceId))?.name).toBe(
      "Alice",
    );
    expect((await branchB.store.nodes.Person.getById(aliceId))?.name).toBe(
      "Alice",
    );

    // (c) Mutating branchA affects neither base nor branchB.
    await branchA.store.nodes.Person.update(aliceId, { name: "Alice (A)" });
    await branchA.store.nodes.Person.create({ name: "Dave (A only)" });
    await branchA.store.edges.knows.delete(edgeId);
    await branchA.store.nodes.Person.delete(bobId);

    // Base unchanged.
    expect(await snapshotPeople(baseStore)).toEqual(baseBefore);
    expect(await snapshotEdges(baseStore)).toEqual(baseEdgesBefore);
    // branchB unchanged.
    expect(await snapshotPeople(branchB.store)).toEqual(baseBefore);
    expect(await snapshotEdges(branchB.store)).toEqual(baseEdgesBefore);

    // branchA reflects its own mutations.
    const branchAPeople = await snapshotPeople(branchA.store);
    expect(branchAPeople.map((person) => person.name).sort()).toEqual([
      "Alice (A)",
      "Dave (A only)",
    ]);
    expect(await snapshotEdges(branchA.store)).toHaveLength(0);
  });

  it("uses a revision anchor through branch validation and merge commit", async () => {
    const [baseStore] = await createStoreWithSchema(
      graph,
      await makeBackend(),
      { revisionTracking: true },
    );
    const fork = await branch<G>(baseStore, () => makeBackend());
    expect(isOk(fork)).toBe(true);
    if (!isOk(fork)) throw fork.error;
    const forkBranch = unwrap(fork);
    expect(forkBranch.base).toContain("\0revision:");
    expect(forkBranch.store.revisionTrackingEnabled).toBe(true);

    await forkBranch.store.nodes.Person.create({ name: "From fork" });
    const firstMerge = await merge(baseStore, [forkBranch], {});
    expect(isOk(firstMerge)).toBe(true);
    expect(
      (await baseStore.nodes.Person.find()).map((node) => node.name),
    ).toEqual(["From fork"]);

    // The successful merge advanced the target's anchor, so a stale branch
    // cannot be applied twice.
    const secondMerge = await merge(baseStore, [forkBranch], {});
    expect(isErr(secondMerge)).toBe(true);
  });

  it("uses the recorded-time clock as the revision anchor for history stores", async () => {
    const [baseStore] = await createStoreWithSchema(
      graph,
      await makeBackend(),
      { history: true },
    );
    const forkResult = await branch<G>(baseStore, () => makeBackend());
    expect(isOk(forkResult)).toBe(true);
    if (!isOk(forkResult)) throw forkResult.error;
    const fork = unwrap(forkResult);
    expect(fork.base).toContain("\0revision:");

    await fork.store.nodes.Person.create({ name: "History fork" });
    const result = await merge(baseStore, [fork], {});
    expect(isOk(result)).toBe(true);
    expect(await baseStore.recordedNow()).toBeDefined();
  });

  it("preserves the base's exact validFrom on the clone, even when it was never set explicitly", async () => {
    // Regression test: an omitted validFrom defaults to the row's OWN
    // creation instant (#240), not open-left NULL. A branch is a clone taken
    // at a LATER instant, so if the export/import round trip dropped
    // validFrom, the clone would re-stamp it to the clone's own (later)
    // creation time — silently narrowing the fork's valid-time window and
    // making asOf reads on the fork diverge from identical reads on the base.
    const { baseStore, aliceId, edgeId } = await seedBase();
    const alice = await baseStore.nodes.Person.getById(aliceId);
    const edge = await baseStore.edges.knows.getById(edgeId);

    const result = await branch<G>(baseStore, () => makeBackend());
    expect(isOk(result)).toBe(true);
    const forkStore = unwrap(result).store;

    const forkedAlice = await forkStore.nodes.Person.getById(aliceId);
    const forkedEdge = await forkStore.edges.knows.getById(edgeId);

    expect(forkedAlice?.meta.validFrom).toBeDefined();
    expect(forkedAlice?.meta.validFrom).toBe(alice?.meta.validFrom);
    expect(forkedEdge?.meta.validFrom).toBeDefined();
    expect(forkedEdge?.meta.validFrom).toBe(edge?.meta.validFrom);
  });

  it("preserves a legacy row with no lower bound (valid_from = NULL) on the clone, still visible at an ancient asOf", async () => {
    // Regression test: a row predating the #240 fix (or written directly
    // via the backend, which the collection API can no longer produce) has
    // valid_from = NULL — "valid since forever". A faithful clone must NOT
    // narrow that to the fork's own creation instant.
    const { baseStore } = await seedBase();
    const legacy = await getStoreBackend(baseStore).insertNode({
      graphId: baseStore.graphId,
      kind: "Person",
      id: "legacy-null-validfrom",
      props: { name: "Legacy" },
      validFrom: null,
    });
    expect(legacy.valid_from).toBeUndefined();

    const result = await branch<G>(baseStore, () => makeBackend());
    expect(isOk(result)).toBe(true);
    const forkStore = unwrap(result).store;

    const ancientAsOf = "1900-01-01T00:00:00.000Z";
    const forkedLegacy = await forkStore.nodes.Person.getById(
      legacy.id as never,
      { temporalMode: "asOf", asOf: ancientAsOf },
    );
    expect(forkedLegacy).toBeDefined();
    expect(forkedLegacy?.meta.validFrom).toBeUndefined();
  });

  it("honors an explicit branch id from options", async () => {
    const { baseStore } = await seedBase();
    const explicitId = asBranchId("branch-explicit-id");
    const result = await branch<G>(baseStore, () => makeBackend(), {
      id: explicitId,
    });
    expect(isOk(result)).toBe(true);
    expect(unwrap(result).id).toBe(explicitId);
  });

  it("wraps clone failures in a BranchError with cause", async () => {
    const { baseStore } = await seedBase();
    const failure = new Error("backend boom");
    const result = await branch<G>(baseStore, () => Promise.reject(failure));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.name).toBe("BranchError");
      expect(result.error.cause).toBe(failure);
    }
  });

  it("fails loudly on a non-empty backend and closes it (no silent skip, no leak)", async () => {
    const { baseStore } = await seedBase();

    // A close-tracking wrapper so we can assert the failure path released the
    // backend it opened (rather than leaking the handle).
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    let closeCount = 0;
    const tracked: GraphBackend = new Proxy(fixture.backend, {
      get(target, property, _receiver) {
        if (property === "close") {
          return async () => {
            closeCount += 1;
            await target.close();
          };
        }
        return getBackendProperty(target, property);
      },
    });

    // First branch onto the empty backend succeeds and SEEDS it with base rows.
    const first = await branch<G>(baseStore, () => Promise.resolve(tracked));
    expect(isOk(first)).toBe(true);

    // Second branch onto the now-NON-EMPTY backend must fail loudly (onConflict
    // "error", never a silent skip) AND close the backend it was handed.
    const closesBefore = closeCount;
    const second = await branch<G>(baseStore, () => Promise.resolve(tracked));
    expect(isErr(second)).toBe(true);
    if (isErr(second)) {
      expect(second.error.name).toBe("BranchError");
    }
    expect(closeCount).toBe(closesBefore + 1);
  });

  it("accepts an explicit working-copy strategy override", async () => {
    const { baseStore, aliceId } = await seedBase();
    const strategy = cloneWorkingCopyStrategy<G>(() => makeBackend());
    const result = await branch<G>(
      baseStore,
      // makeBackend here is ignored because an explicit strategy is supplied;
      // it must never be invoked, so reject to prove the override path is taken.
      () => Promise.reject(new Error("default factory must not run")),
      undefined,
      strategy,
    );
    expect(isOk(result)).toBe(true);
    const created = unwrap(result);
    expect((await created.store.nodes.Person.getById(aliceId))?.name).toBe(
      "Alice",
    );
  });

  it("bulk-copies a history source subset into a non-history branch with update conflicts", async () => {
    const [sourceStore] = await createStoreWithSchema(
      materializationGraph,
      await makeBackend(),
      { history: true },
    );
    const [baseStore] = await createStoreWithSchema(
      materializationGraph,
      await makeBackend(),
    );

    await baseStore.nodes.WorkItem.upsertById("work-1", {
      title: "Old title",
      status: "stale",
    });

    const sourceWork = await sourceStore.nodes.WorkItem.upsertById("work-1", {
      title: "Fresh title",
      status: "open",
    });
    const dependency = await sourceStore.nodes.WorkItem.upsertById("work-2", {
      title: "Dependency",
      status: "blocked",
    });
    const omittedLabel = await sourceStore.nodes.Label.upsertById("label-1", {
      name: "not exported",
    });
    const copiedEdge = await sourceStore.edges.blocks.create(
      sourceWork,
      dependency,
      { reason: "waiting on import" },
    );
    expect(await sourceStore.recordedNow()).toBeDefined();

    const exported = await exportGraph(sourceStore, {
      nodeKinds: ["WorkItem"],
      edgeKinds: ["blocks"],
      includeMeta: true,
    });
    expect(exported.nodes).toHaveLength(2);
    expect(exported.nodes.every((node) => node.kind === "WorkItem")).toBe(true);
    expect(exported.edges).toHaveLength(1);
    expect(exported.edges[0]?.kind).toBe("blocks");

    const branchResult = await branch<MaterializationGraph>(
      baseStore,
      () => makeBackend(),
      { id: asBranchId("materialized-copy") },
    );
    expect(isOk(branchResult)).toBe(true);
    const copiedBranch = unwrap(branchResult);

    const result = await importGraph(copiedBranch.store, exported, {
      onConflict: "update",
      validateReferences: true,
    });
    expect(result.success).toBe(true);
    expect(result.nodes.updated).toBe(1);
    expect(result.nodes.created).toBe(1);
    expect(result.edges.created).toBe(1);

    const copiedWork = await copiedBranch.store.nodes.WorkItem.getById(
      sourceWork.id,
    );
    const copiedDependency = await copiedBranch.store.nodes.WorkItem.getById(
      dependency.id,
    );
    const omitted = await copiedBranch.store.nodes.Label.getById(
      omittedLabel.id,
    );
    const copiedRelationship = await copiedBranch.store.edges.blocks.getById(
      copiedEdge.id,
    );

    expect(copiedWork?.title).toBe("Fresh title");
    expect(copiedWork?.status).toBe("open");
    expect(copiedDependency?.title).toBe("Dependency");
    expect(omitted).toBeUndefined();
    expect(copiedRelationship?.fromId).toBe(sourceWork.id);
    expect(copiedRelationship?.toId).toBe(dependency.id);
    expect(copiedRelationship?.reason).toBe("waiting on import");
  });
});
