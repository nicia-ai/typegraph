import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  markBundledRootAtomicMutationPrograms,
  resolveBundledRootAtomicMutationPrograms,
} from "../src/backend/capabilities/atomic-mutation-program";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { rowPropsToObject } from "../src/backend/types";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { CompilerInvariantError } from "../src/errors";
import { createStoreWithSchema, createVerifiedStore } from "../src/store";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), score: z.number() }),
});
const relates = defineEdge("relates", {
  schema: z.object({ label: z.string() }),
});
const graph = defineGraph({
  id: "atomic-resolved-update-batch",
  nodes: { Person: { type: Person } },
  edges: {
    relates: { type: relates, from: [Person], to: [Person] },
  },
});

describe("atomic resolved update batches", () => {
  const clients: ReturnType<typeof createClient>[] = [];

  afterEach(() => {
    for (const client of clients) client.close();
    clients.length = 0;
  });

  async function fixture() {
    const client = createClient({ url: "file::memory:" });
    clients.push(client);
    const { backend, db } = await createLibsqlBackend(client);
    const [store] = await createStoreWithSchema(graph, backend);
    const profile = requireDefined(
      resolveBundledRootAtomicMutationPrograms(backend),
    );
    return { backend, db, profile, store };
  }

  it("updates distinct nodes as one guarded set", async () => {
    const { backend, profile, store } = await fixture();
    const nodes = await store.nodes.Person.bulkCreate([
      { id: "a", props: { name: "A", score: 1 } },
      { id: "b", props: { name: "B", score: 2 } },
    ]);
    const before = await requireDefined(backend.getNodes)(
      graph.id,
      Person.kind,
      nodes.map((node) => node.id),
    );
    const executor = requireDefined(profile.updateNodes);
    const rows = await executor({
      entries: before.map((row) => ({
        graphId: graph.id,
        kind: row.kind,
        id: row.id,
        props: { ...rowPropsToObject(row.props), score: 10 },
        expectedVersion: row.version,
      })),
      schemaFence: { graphId: graph.id, expectedVersion: 1 },
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.version)).toEqual([2, 2]);
    expect(rows.map((row) => rowPropsToObject(row.props)["score"])).toEqual([
      10, 10,
    ]);
  });

  it("updates no node when one preimage moved", async () => {
    const { backend, profile, store } = await fixture();
    await store.nodes.Person.bulkCreate([
      { id: "a", props: { name: "A", score: 1 } },
      { id: "b", props: { name: "B", score: 2 } },
    ]);
    const before = await requireDefined(backend.getNodes)(
      graph.id,
      Person.kind,
      ["a", "b"],
    );
    await store.nodes.Person.update("a" as never, { score: 3 });

    const rows = await requireDefined(profile.updateNodes)({
      entries: before.map((row) => ({
        graphId: graph.id,
        kind: row.kind,
        id: row.id,
        props: { ...rowPropsToObject(row.props), score: 10 },
        expectedVersion: row.version,
      })),
      schemaFence: { graphId: graph.id, expectedVersion: 1 },
    });

    expect(rows).toEqual([]);
    expect(await store.nodes.Person.getById("a" as never)).toMatchObject({
      score: 3,
    });
    expect(await store.nodes.Person.getById("b" as never)).toMatchObject({
      score: 2,
    });
  });

  it("refuses a resolved node set that is not bound to its fence", async () => {
    const { backend, profile, store } = await fixture();
    await store.nodes.Person.bulkCreate([
      { id: "a", props: { name: "A", score: 1 } },
    ]);
    const row = requireDefined(
      await backend.getNode(graph.id, Person.kind, "a"),
    );

    await expect(
      requireDefined(profile.updateNodes)({
        entries: [
          {
            graphId: "another-graph",
            kind: row.kind,
            id: row.id,
            props: rowPropsToObject(row.props),
            expectedVersion: row.version,
          },
        ],
        schemaFence: { graphId: graph.id, expectedVersion: 1 },
      }),
    ).rejects.toBeInstanceOf(CompilerInvariantError);
  });

  it("updates no edge when one preimage moved", async () => {
    const { backend, profile, store } = await fixture();
    const [from, to] = await store.nodes.Person.bulkCreate([
      { id: "from", props: { name: "From", score: 1 } },
      { id: "to", props: { name: "To", score: 2 } },
    ]);
    const edges = await store.edges.relates.bulkCreate([
      {
        id: "a",
        from: requireDefined(from),
        to: requireDefined(to),
        props: { label: "A" },
      },
      {
        id: "b",
        from: requireDefined(from),
        to: requireDefined(to),
        props: { label: "B" },
      },
    ]);
    const before = await requireDefined(backend.getEdges)(
      graph.id,
      edges.map((edge) => edge.id),
    );
    await store.edges.relates.update("a" as never, { label: "moved" });

    const rows = await requireDefined(profile.updateEdges)({
      entries: before.map((existing) => ({
        existing,
        props: { label: "resolved" },
      })),
      schemaFence: { graphId: graph.id, expectedVersion: 1 },
    });

    expect(rows).toEqual([]);
    expect(await store.edges.relates.getById("a" as never)).toMatchObject({
      label: "moved",
    });
    expect(await store.edges.relates.getById("b" as never)).toMatchObject({
      label: "B",
    });
  });

  it("re-resolves the complete node set after a moved preimage", async () => {
    const { db, store } = await fixture();
    const nodes = await store.nodes.Person.bulkCreate([
      { id: "a", props: { name: "A", score: 1 } },
      { id: "b", props: { name: "B", score: 2 } },
    ]);
    const transactionlessBackend = createSqliteBackend(db, {
      executionProfile: { isSync: false, transactionMode: "none" },
    });
    const [transactionlessStore] = await createVerifiedStore(
      graph,
      transactionlessBackend,
    );
    const profile = requireDefined(
      resolveBundledRootAtomicMutationPrograms(transactionlessBackend),
    );
    const original = requireDefined(profile.updateNodes);
    let attempts = 0;
    const run = vi.fn(async (input: Parameters<typeof original>[0]) => {
      attempts += 1;
      if (attempts === 1) return [];
      return original(input);
    });
    const retrying = Object.assign(run, {
      maxEntries: original.maxEntries,
    }) satisfies typeof original;
    markBundledRootAtomicMutationPrograms(transactionlessBackend, {
      ...profile,
      updateNodes: retrying,
    });

    const updated = await transactionlessStore.nodes.Person.bulkUpsertById(
      nodes.map((node) => ({
        id: node.id,
        props: { name: node.name, score: 10 },
      })),
    );

    expect(retrying).toHaveBeenCalledTimes(2);
    expect(updated.map((node) => node.score)).toEqual([10, 10]);
  });
});
