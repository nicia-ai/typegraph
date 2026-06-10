import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { exportGraph, importGraph } from "@nicia-ai/typegraph/interchange";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { computeBaseVersion } from "../../src/graph-merge/base-version";
import {
  diffAgainstBase,
  enumerateAllEdges,
  enumerateAllNodes,
} from "../../src/graph-merge/state-diff";
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
  id: "state-diff-test",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

type G = typeof graph;

/**
 * Clones a base store into a fresh store on a new backend via the public
 * interchange API, preserving ids. This stands in for T4's `branch()` clone:
 * the diff reference remains the ORIGINAL base store (the Interchange meta schema
 * has no `deletedAt`, so soft-deletes do not survive a round-trip — exactly the
 * fidelity limitation that mandates diffing against the original base).
 */
async function cloneToFork(
  baseStore: Store<G>,
  forkBackend: GraphBackend,
): Promise<Store<G>> {
  const data = await exportGraph(baseStore, {
    includeMeta: true,
    includeDeleted: true,
  });
  const [forkStore] = await createStoreWithSchema(baseStore.graph, forkBackend);
  await importGraph(forkStore, data, {
    onConflict: "skip",
    onUnknownProperty: "error",
    validateReferences: true,
    batchSize: 1000,
  });
  return forkStore;
}

describe.each(backendMatrix())("state-diff [$name]", (entry) => {
  let baseBackend: GraphBackend;
  let forkBackend: GraphBackend;
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

  it("reports new / modified / deleted nodes and edges of a fork", async () => {
    baseBackend = await makeBackend();
    forkBackend = await makeBackend();

    const [baseStore] = await createStoreWithSchema(graph, baseBackend);

    // Seed base: nodes A, B and edge A -> B.
    const nodeA = await baseStore.nodes.Person.create({ name: "Alice" });
    const nodeB = await baseStore.nodes.Person.create({ name: "Bob" });
    const edgeAB = await baseStore.edges.knows.create(nodeA, nodeB, {
      since: "2020",
    });

    const forkStore = await cloneToFork(baseStore, forkBackend);

    // Mutate fork: modify A, delete edge A->B then soft-delete B, add C and
    // edge A -> C. (The default restrict delete behavior requires removing the
    // incident edge before the node — exercising both edge AND node deletion.)
    await forkStore.nodes.Person.update(nodeA.id, { name: "Alice Updated" });
    await forkStore.edges.knows.delete(edgeAB.id);
    await forkStore.nodes.Person.delete(nodeB.id);
    const nodeC = await forkStore.nodes.Person.create({ name: "Carol" });
    const edgeAC = await forkStore.edges.knows.create(
      { kind: "Person", id: nodeA.id },
      nodeC,
      { since: "2024" },
    );

    const diff = await diffAgainstBase(baseStore, forkStore);

    // Node A modified.
    expect(diff.nodes.modified).toHaveLength(1);
    expect(diff.nodes.modified[0]!.id).toBe(nodeA.id);
    expect(diff.nodes.modified[0]!.forkProps).toMatchObject({
      name: "Alice Updated",
    });
    expect(diff.nodes.modified[0]!.baseProps).toMatchObject({ name: "Alice" });

    // Node B deleted.
    expect(diff.nodes.deleted.map((entry) => entry.id)).toEqual([nodeB.id]);

    // Node C new.
    expect(diff.nodes.new).toHaveLength(1);
    expect(diff.nodes.new[0]!.id).toBe(nodeC.id);
    expect(diff.nodes.new[0]!.props).toMatchObject({ name: "Carol" });

    // Edge A -> C new.
    expect(diff.edges.new.map((entry) => entry.id)).toEqual([edgeAC.id]);
    expect(diff.edges.new[0]!.fromId).toBe(nodeA.id);
    expect(diff.edges.new[0]!.toId).toBe(nodeC.id);

    // Edge A -> B deleted.
    expect(diff.edges.deleted.map((entry) => entry.id)).toEqual([edgeAB.id]);
    expect(diff.edges.modified).toHaveLength(0);
  });

  it("enumerates soft-deleted rows with excludeDeleted:false on both backends", async () => {
    baseBackend = await makeBackend();
    const [store] = await createStoreWithSchema(graph, baseBackend);

    const live = await store.nodes.Person.create({ name: "Live" });
    const gone = await store.nodes.Person.create({ name: "Gone" });
    await store.nodes.Person.delete(gone.id);

    const rows = await enumerateAllNodes(
      store.backend,
      store.graphId,
      "Person",
    );
    const byId = new Map(rows.map((row) => [row.id, row] as const));

    expect(byId.get(live.id)?.deleted_at).toBeUndefined();
    expect(byId.get(gone.id)?.deleted_at).not.toBeUndefined();
    // Both rows are visible — Store.find() would have hidden the deleted one.
    expect(rows).toHaveLength(2);
  });

  it("enumerates edges in stable id order independent of insertion order", async () => {
    baseBackend = await makeBackend();
    const [store] = await createStoreWithSchema(graph, baseBackend);

    const a = await store.nodes.Person.create({ name: "A" });
    const b = await store.nodes.Person.create({ name: "B" });
    const c = await store.nodes.Person.create({ name: "C" });
    // DELIBERATELY inserted out of id order, with explicit all-lowercase ids:
    // every backend collation (SQLite byte order, PGlite "C", a server
    // Postgres database under a linguistic/ICU collation) agrees on the
    // ordering of same-shape lowercase ASCII ids, so the expected sequence is
    // portable — mixed-case generated ids are NOT (e.g. "V" < "s" in code
    // units but not under a case-insensitive linguistic collation).
    await store.edges.knows.bulkCreate([
      {
        id: "e-ccc",
        from: { kind: "Person", id: c.id },
        to: { kind: "Person", id: a.id },
        props: { since: "3" },
      },
      {
        id: "e-aaa",
        from: { kind: "Person", id: a.id },
        to: { kind: "Person", id: b.id },
        props: { since: "1" },
      },
      {
        id: "e-bbb",
        from: { kind: "Person", id: b.id },
        to: { kind: "Person", id: c.id },
        props: { since: "2" },
      },
    ]);

    const rows = await enumerateAllEdges(store.backend, store.graphId, "knows");
    expect(rows.map((row) => row.id)).toEqual(["e-aaa", "e-bbb", "e-ccc"]);
  });

  it("detects no changes between a base and its faithful clone", async () => {
    baseBackend = await makeBackend();
    forkBackend = await makeBackend();
    const [baseStore] = await createStoreWithSchema(graph, baseBackend);
    const a = await baseStore.nodes.Person.create({ name: "A" });
    const b = await baseStore.nodes.Person.create({ name: "B" });
    await baseStore.edges.knows.create(a, b, { since: "x" });

    const forkStore = await cloneToFork(baseStore, forkBackend);
    const diff = await diffAgainstBase(baseStore, forkStore);

    expect(diff.nodes.new).toHaveLength(0);
    expect(diff.nodes.modified).toHaveLength(0);
    expect(diff.nodes.deleted).toHaveLength(0);
    expect(diff.edges.new).toHaveLength(0);
    expect(diff.edges.modified).toHaveLength(0);
    expect(diff.edges.deleted).toHaveLength(0);
  });

  it("reports an edge whose props were modified in the fork", async () => {
    baseBackend = await makeBackend();
    forkBackend = await makeBackend();
    const [baseStore] = await createStoreWithSchema(graph, baseBackend);
    const a = await baseStore.nodes.Person.create({ name: "A" });
    const b = await baseStore.nodes.Person.create({ name: "B" });
    const edge = await baseStore.edges.knows.create(a, b, { since: "2020" });

    const forkStore = await cloneToFork(baseStore, forkBackend);
    await forkStore.edges.knows.update(edge.id, { since: "2025" });

    const diff = await diffAgainstBase(baseStore, forkStore);
    expect(diff.edges.modified).toHaveLength(1);
    expect(diff.edges.modified[0]!.id).toBe(edge.id);
    expect(diff.edges.modified[0]!.forkProps).toMatchObject({ since: "2025" });
    expect(diff.edges.modified[0]!.baseProps).toMatchObject({ since: "2020" });
    expect(diff.edges.new).toHaveLength(0);
    expect(diff.edges.deleted).toHaveLength(0);
  });
});

describe.each(backendMatrix())("computeBaseVersion [$name]", (entry) => {
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

  it("is stable for identical content and changes when content changes", async () => {
    const [store] = await createStoreWithSchema(graph, await makeBackend());
    const before = await computeBaseVersion(store);
    const again = await computeBaseVersion(store);
    expect(again).toBe(before);

    const node = await store.nodes.Person.create({ name: "Alice" });
    const afterAdd = await computeBaseVersion(store);
    expect(afterAdd).not.toBe(before);

    await store.nodes.Person.update(node.id, { name: "Alice Renamed" });
    const afterModify = await computeBaseVersion(store);
    expect(afterModify).not.toBe(afterAdd);
  });

  it("ignores soft-deleted rows in the live-content fingerprint", async () => {
    const [store] = await createStoreWithSchema(graph, await makeBackend());
    const keep = await store.nodes.Person.create({ name: "Keep" });
    const baseline = await computeBaseVersion(store);

    const transient = await store.nodes.Person.create({ name: "Transient" });
    expect(await computeBaseVersion(store)).not.toBe(baseline);

    await store.nodes.Person.delete(transient.id);
    // Live content is back to just `keep`, so the fingerprint returns to baseline.
    expect(await computeBaseVersion(store)).toBe(baseline);
    expect(keep.id).toBeDefined();
  });
});
