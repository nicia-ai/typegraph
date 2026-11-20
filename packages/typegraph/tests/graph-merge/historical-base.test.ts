import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../src";
import { computeBaseVersion } from "../../src/graph-merge/base-version";
import { parseRowProps } from "../../src/graph-merge/canonical-props";
import { createRecordedBaseReader } from "../../src/graph-merge/historical-base";
import { stageBranches } from "../../src/graph-merge/staging";
import { asBranchId } from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix } from "./test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
  from: [Person],
  to: [Person],
});
const graph = defineGraph({
  id: "historical-merge-reader",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});
const identityGraph = defineGraph({
  id: "historical-merge-reader-identity",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

describe.each(backendMatrix())("recorded merge ancestor [$name]", (entry) => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("reads the exact old raw rows and tombstones after the target advances", async () => {
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    const [store] = await createStoreWithSchema(graph, fixture.backend, {
      history: true,
    });
    const ada = await store.nodes.Person.create({ name: "Ada" });
    const bea = await store.nodes.Person.create({ name: "Bea" });
    const deleted = await store.nodes.Person.create({ name: "Deleted" });
    const edge = await store.edges.knows.create(ada, bea, { since: "2020" });
    await store.nodes.Person.delete(deleted.id);
    const recorded = await store.recordedNow();
    expect(recorded).toBeDefined();
    if (recorded === undefined) throw new Error("Missing recorded cut");

    await store.nodes.Person.update(ada.id, { name: "Ada now" });
    const later = await store.nodes.Person.create({ name: "Later" });
    const reader = createRecordedBaseReader(store, recorded);
    const people = await reader.readNodes("Person");
    const edges = await reader.readEdges("knows");

    expect(people).toHaveLength(3);
    const oldAda = requireDefined(people.find((row) => row.id === ada.id));
    expect(parseRowProps(oldAda.props)).toEqual({ name: "Ada" });
    expect(
      people.find((row) => row.id === deleted.id)?.deleted_at,
    ).toBeDefined();
    expect(people.some((row) => row.id === later.id)).toBe(false);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.id).toBe(edge.id);
    expect(await reader.readNodes("Person", [ada.id])).toHaveLength(1);
    expect(await reader.readNodes("Person", [later.id])).toEqual([]);
    expect(await reader.readEdges("knows", [edge.id])).toHaveLength(1);
  });

  it("reads identity assertions at the recorded cut", async () => {
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    const [store] = await createStoreWithSchema(
      identityGraph,
      fixture.backend,
      {
        history: true,
      },
    );
    const ada = await store.nodes.Person.create({ name: "Ada" });
    const bea = await store.nodes.Person.create({ name: "Bea" });
    const { assertion } = await store.identity.assertSame(ada, bea);
    const recorded = await store.recordedNow();
    if (recorded === undefined) throw new Error("Missing recorded cut");
    await store.identity.retractAssertion(assertion.id);

    const reader = createRecordedBaseReader(store, recorded);
    expect((await reader.readIdentity("state")).map((row) => row.id)).toEqual([
      assertion.id,
    ]);
    expect(
      (await reader.readIdentity("archival")).map((row) => row.id),
    ).toEqual([assertion.id]);
  });

  it("limits the committed target diff to keys changed since the recorded cut", async () => {
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    const [store] = await createStoreWithSchema(graph, fixture.backend, {
      history: true,
    });
    const ada = await store.nodes.Person.create({ name: "Ada" });
    await store.nodes.Person.create({ name: "Unchanged" });
    const recorded = await store.recordedNow();
    if (recorded === undefined) throw new Error("Missing recorded cut");
    const base = await computeBaseVersion(store);
    await store.nodes.Person.update(ada.id, { name: "Ada now" });

    const source = createRecordedBaseReader(store, recorded);
    const nodeReads: (readonly string[] | undefined)[] = [];
    const reader = {
      ...source,
      readNodes(kind: string, ids?: readonly string[]) {
        nodeReads.push(ids);
        return source.readNodes(kind, ids);
      },
    };
    const targetId = asBranchId("committed-target");
    const targetBranch = {
      id: targetId,
      base,
      store,
      close: (): Promise<void> => Promise.resolve(),
    };
    const staged = await stageBranches(store, [targetBranch], targetId, reader);

    expect(nodeReads).toEqual([[ada.id]]);
    expect(staged.modifiedNodes).toHaveLength(1);
    expect(staged.targetNodeVersions.size).toBe(1);
  });
});
