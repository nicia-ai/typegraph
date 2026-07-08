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
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import {
  enumerateAllEdges,
  enumerateAllNodes,
} from "../../src/graph-merge/state-diff";
import { asBranchId } from "../../src/graph-merge/types";
import { cloneWorkingCopyStrategy } from "../../src/graph-merge/working-copy";
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
  id: "branch-test",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

type G = typeof graph;

/** Live `{ id, name }` snapshot of every Person node in a store, sorted by id. */
async function snapshotPeople(
  store: Store<G>,
): Promise<readonly Readonly<{ id: string; name: unknown }>[]> {
  const rows = await enumerateAllNodes(store.backend, store.graphId, "Person");
  return rows
    .filter((row) => row.deleted_at === undefined)
    .map((row) => ({
      id: row.id,
      name: rowPropsToObject(row.props).name,
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
  const rows = await enumerateAllEdges(store.backend, store.graphId, "knows");
  return rows
    .filter((row) => row.deleted_at === undefined)
    .map((row) => ({
      id: row.id,
      from: row.from_id,
      to: row.to_id,
      since: rowPropsToObject(row.props).since,
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
    expect(branchA.store.backend).not.toBe(branchB.store.backend);
    expect(branchA.store.backend).not.toBe(baseStore.backend);

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
    const legacy = await baseStore.backend.insertNode({
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
      get(target, property, receiver) {
        if (property === "close") {
          return async () => {
            closeCount += 1;
            await target.close();
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
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
});
