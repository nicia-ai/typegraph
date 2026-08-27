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
import { CompilerInvariantError, DatabaseOperationError } from "../src/errors";
import { createStoreWithSchema, createVerifiedStore } from "../src/store";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), score: z.number() }),
});
const relates = defineEdge("relates", {
  schema: z.object({ label: z.string() }),
});
const graph = defineGraph({
  id: "atomic-resolved-mutation-set",
  nodes: { Person: { type: Person } },
  edges: { relates: { type: relates, from: [Person], to: [Person] } },
});

describe("atomic resolved mutation sets", () => {
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
    return { backend, db, store };
  }

  it("restores mixed node and edge results to public input order", async () => {
    const { db, store } = await fixture();
    const [from, to, existingNode] = await store.nodes.Person.bulkCreate([
      { id: "from", props: { name: "From", score: 1 } },
      { id: "to", props: { name: "To", score: 2 } },
      { id: "existing-node", props: { name: "Existing", score: 3 } },
    ]);
    const existingEdge = await store.edges.relates.create(
      requireDefined(from),
      requireDefined(to),
      { label: "Existing" },
      { id: "existing-edge" },
    );
    const transactionlessBackend = createSqliteBackend(db, {
      executionProfile: { isSync: false, transactionMode: "none" },
    });
    const [root] = await createVerifiedStore(graph, transactionlessBackend);

    const nodes = await root.nodes.Person.bulkUpsertById([
      { id: "new-node", props: { name: "New", score: 4 } },
      {
        id: requireDefined(existingNode).id,
        props: { name: "Updated", score: 5 },
      },
    ]);
    const edges = await root.edges.relates.bulkUpsertById([
      {
        id: existingEdge.id,
        from: requireDefined(from),
        to: requireDefined(to),
        props: { label: "Updated" },
      },
      {
        id: "new-edge" as never,
        from: requireDefined(from),
        to: requireDefined(to),
        props: { label: "New" },
      },
    ]);

    expect(nodes.map((node) => [node.id, node.name])).toEqual([
      ["new-node", "New"],
      ["existing-node", "Updated"],
    ]);
    expect(edges.map((edge) => [edge.id, edge.label])).toEqual([
      ["existing-edge", "Updated"],
      ["new-edge", "New"],
    ]);
  });

  it("rolls a node create back when one guarded update preimage moved", async () => {
    const { backend, store } = await fixture();
    await store.nodes.Person.create(
      { name: "Existing", score: 1 },
      { id: "existing" },
    );
    const before = requireDefined(
      await backend.getNode(graph.id, Person.kind, "existing"),
    );
    await store.nodes.Person.update("existing" as never, { score: 2 });
    const executor = requireDefined(
      resolveBundledRootAtomicMutationPrograms(backend)?.mutateNodes,
    );

    const result = await executor({
      creates: [
        {
          idSource: "caller",
          params: {
            graphId: graph.id,
            kind: Person.kind,
            id: "new",
            props: { name: "New", score: 3 },
          },
        },
      ],
      updates: [
        {
          graphId: graph.id,
          kind: Person.kind,
          id: before.id,
          props: { ...rowPropsToObject(before.props), score: 4 },
          expectedVersion: before.version,
        },
      ],
      schemaFence: { graphId: graph.id, expectedVersion: 1 },
    });

    expect(result).toEqual({ created: [], updated: [] });
    await expect(
      store.nodes.Person.getById("new" as never),
    ).resolves.toBeUndefined();
    await expect(
      store.nodes.Person.getById("existing" as never),
    ).resolves.toMatchObject({ score: 2 });
  });

  it("preserves a live node create collision instead of reporting movement", async () => {
    const { backend, store } = await fixture();
    await store.nodes.Person.bulkCreate([
      { id: "collision", props: { name: "Collision", score: 1 } },
      { id: "existing", props: { name: "Existing", score: 2 } },
    ]);
    const before = requireDefined(
      await backend.getNode(graph.id, Person.kind, "existing"),
    );
    const executor = requireDefined(
      resolveBundledRootAtomicMutationPrograms(backend)?.mutateNodes,
    );

    await expect(
      executor({
        creates: [
          {
            idSource: "caller",
            params: {
              graphId: graph.id,
              kind: Person.kind,
              id: "collision",
              props: { name: "Replacement", score: 3 },
            },
          },
        ],
        updates: [
          {
            graphId: graph.id,
            kind: Person.kind,
            id: before.id,
            props: { ...rowPropsToObject(before.props), score: 4 },
            expectedVersion: before.version,
          },
        ],
        schemaFence: { graphId: graph.id, expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ details: { reason: "duplicate_key" } });
  });

  it("refuses create-less mutation programs at the backend seam", async () => {
    const { backend, store } = await fixture();
    await store.nodes.Person.create(
      { name: "Existing", score: 1 },
      { id: "existing" },
    );
    const node = requireDefined(
      await backend.getNode(graph.id, Person.kind, "existing"),
    );
    const [from, to] = await store.nodes.Person.bulkCreate([
      { id: "from", props: { name: "From", score: 2 } },
      { id: "to", props: { name: "To", score: 3 } },
    ]);
    await store.edges.relates.create(
      requireDefined(from),
      requireDefined(to),
      { label: "Existing" },
      { id: "existing-edge" },
    );
    const edge = requireDefined(
      await backend.getEdge(graph.id, "existing-edge"),
    );
    const profile = requireDefined(
      resolveBundledRootAtomicMutationPrograms(backend),
    );

    await expect(
      requireDefined(profile.mutateNodes)({
        creates: [],
        updates: [
          {
            graphId: graph.id,
            kind: Person.kind,
            id: node.id,
            props: { ...rowPropsToObject(node.props), score: 4 },
            expectedVersion: node.version,
          },
        ],
        schemaFence: { graphId: graph.id, expectedVersion: 1 },
      }),
    ).rejects.toBeInstanceOf(CompilerInvariantError);
    await expect(
      requireDefined(profile.mutateEdges)({
        creates: [],
        updates: [{ existing: edge, props: { label: "Updated" } }],
        schemaFence: { graphId: graph.id, expectedVersion: 1 },
      }),
    ).rejects.toBeInstanceOf(CompilerInvariantError);
  });

  it("rolls an edge create back when one guarded update preimage moved", async () => {
    const { backend, store } = await fixture();
    const [from, to] = await store.nodes.Person.bulkCreate([
      { id: "from", props: { name: "From", score: 1 } },
      { id: "to", props: { name: "To", score: 2 } },
    ]);
    await store.edges.relates.create(
      requireDefined(from),
      requireDefined(to),
      { label: "Existing" },
      { id: "existing" },
    );
    const before = requireDefined(await backend.getEdge(graph.id, "existing"));
    await store.edges.relates.update("existing" as never, { label: "Moved" });
    const executor = requireDefined(
      resolveBundledRootAtomicMutationPrograms(backend)?.mutateEdges,
    );

    const result = await executor({
      creates: [
        {
          graphId: graph.id,
          kind: relates.kind,
          id: "new",
          fromKind: Person.kind,
          fromId: requireDefined(from).id,
          toKind: Person.kind,
          toId: requireDefined(to).id,
          props: { label: "New" },
        },
      ],
      updates: [{ existing: before, props: { label: "Resolved" } }],
      schemaFence: { graphId: graph.id, expectedVersion: 1 },
    });

    expect(result).toEqual({ created: [], updated: [] });
    await expect(
      store.edges.relates.getById("new" as never),
    ).resolves.toBeUndefined();
    await expect(
      store.edges.relates.getById("existing" as never),
    ).resolves.toMatchObject({ label: "Moved" });
  });

  it("writes nothing when the mixed-set schema fence is stale", async () => {
    const { backend, store } = await fixture();
    await store.nodes.Person.create(
      { name: "Existing", score: 1 },
      { id: "existing" },
    );
    const before = requireDefined(
      await backend.getNode(graph.id, Person.kind, "existing"),
    );
    const executor = requireDefined(
      resolveBundledRootAtomicMutationPrograms(backend)?.mutateNodes,
    );

    await expect(
      executor({
        creates: [
          {
            idSource: "caller",
            params: {
              graphId: graph.id,
              kind: Person.kind,
              id: "new",
              props: { name: "New", score: 2 },
            },
          },
        ],
        updates: [
          {
            graphId: graph.id,
            kind: Person.kind,
            id: before.id,
            props: { ...rowPropsToObject(before.props), score: 3 },
            expectedVersion: before.version,
          },
        ],
        schemaFence: { graphId: graph.id, expectedVersion: 99 },
      }),
    ).resolves.toEqual({ created: [], updated: [] });
    await expect(
      store.nodes.Person.getById("new" as never),
    ).resolves.toBeUndefined();
    await expect(
      store.nodes.Person.getById("existing" as never),
    ).resolves.toMatchObject({ score: 1 });
  });

  it("rebuilds a mixed node partition after authoritative movement", async () => {
    const { db, store } = await fixture();
    await store.nodes.Person.create(
      { name: "Existing", score: 1 },
      { id: "existing" },
    );
    const transactionlessBackend = createSqliteBackend(db, {
      executionProfile: { isSync: false, transactionMode: "none" },
    });
    const [root] = await createVerifiedStore(graph, transactionlessBackend);
    const profile = requireDefined(
      resolveBundledRootAtomicMutationPrograms(transactionlessBackend),
    );
    const original = requireDefined(profile.mutateNodes);
    let attempts = 0;
    const retrying = Object.assign(
      vi.fn(async (input: Parameters<typeof original>[0]) => {
        attempts += 1;
        if (attempts === 1) return { created: [], updated: [] };
        return original(input);
      }),
      { maxEntries: original.maxEntries },
    ) satisfies typeof original;
    markBundledRootAtomicMutationPrograms(transactionlessBackend, {
      ...profile,
      mutateNodes: retrying,
    });

    const rows = await root.nodes.Person.bulkUpsertById([
      { id: "existing", props: { name: "Updated", score: 2 } },
      { id: "new", props: { name: "New", score: 3 } },
    ]);

    expect(retrying).toHaveBeenCalledTimes(2);
    expect(rows.map((row) => [row.id, row.name])).toEqual([
      ["existing", "Updated"],
      ["new", "New"],
    ]);
  });

  it("rebuilds a mixed edge partition after authoritative movement", async () => {
    const { db, store } = await fixture();
    const [from, to] = await store.nodes.Person.bulkCreate([
      { id: "from", props: { name: "From", score: 1 } },
      { id: "to", props: { name: "To", score: 2 } },
    ]);
    await store.edges.relates.create(
      requireDefined(from),
      requireDefined(to),
      { label: "Existing" },
      { id: "existing" },
    );
    const transactionlessBackend = createSqliteBackend(db, {
      executionProfile: { isSync: false, transactionMode: "none" },
    });
    const [root] = await createVerifiedStore(graph, transactionlessBackend);
    const profile = requireDefined(
      resolveBundledRootAtomicMutationPrograms(transactionlessBackend),
    );
    const original = requireDefined(profile.mutateEdges);
    let attempts = 0;
    const retrying = Object.assign(
      vi.fn(async (input: Parameters<typeof original>[0]) => {
        attempts += 1;
        if (attempts === 1) return { created: [], updated: [] };
        return original(input);
      }),
      { maxEntries: original.maxEntries },
    ) satisfies typeof original;
    markBundledRootAtomicMutationPrograms(transactionlessBackend, {
      ...profile,
      mutateEdges: retrying,
    });

    const rows = await root.edges.relates.bulkUpsertById([
      {
        id: "existing" as never,
        from: requireDefined(from),
        to: requireDefined(to),
        props: { label: "Updated" },
      },
      {
        id: "new" as never,
        from: requireDefined(from),
        to: requireDefined(to),
        props: { label: "New" },
      },
    ]);

    expect(retrying).toHaveBeenCalledTimes(2);
    expect(rows.map((row) => [row.id, row.label])).toEqual([
      ["existing", "Updated"],
      ["new", "New"],
    ]);
  });

  it("fails closed when a mixed node partition never stabilizes", async () => {
    const { db, store } = await fixture();
    await store.nodes.Person.create(
      { name: "Existing", score: 1 },
      { id: "existing" },
    );
    const transactionlessBackend = createSqliteBackend(db, {
      executionProfile: { isSync: false, transactionMode: "none" },
    });
    const [root] = await createVerifiedStore(graph, transactionlessBackend);
    const profile = requireDefined(
      resolveBundledRootAtomicMutationPrograms(transactionlessBackend),
    );
    const original = requireDefined(profile.mutateNodes);
    const refusing = Object.assign(
      vi.fn(() => Promise.resolve({ created: [], updated: [] })),
      { maxEntries: original.maxEntries },
    ) satisfies typeof original;
    markBundledRootAtomicMutationPrograms(transactionlessBackend, {
      ...profile,
      mutateNodes: refusing,
    });

    await expect(
      root.nodes.Person.bulkUpsertById([
        { id: "existing", props: { name: "Updated", score: 2 } },
        { id: "new", props: { name: "New", score: 3 } },
      ]),
    ).rejects.toBeInstanceOf(DatabaseOperationError);
    expect(refusing).toHaveBeenCalledTimes(2);
    await expect(
      root.nodes.Person.getById("new" as never),
    ).resolves.toBeUndefined();
  });
});
