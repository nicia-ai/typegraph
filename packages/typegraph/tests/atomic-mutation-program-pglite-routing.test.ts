import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  reachableAtomicMutationProgramVariants,
  resolveAtomicMutationPrograms,
  withAtomicMutationProgramDispatchObserver,
} from "../src/backend/capabilities/atomic-mutation-program";
import { deriveBackend } from "../src/backend/derive-backend";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { EndpointNotFoundError } from "../src/errors";
import { createStoreWithSchema, createVerifiedStore } from "../src/store";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), score: z.number() }),
});
const relates = defineEdge("relates", {
  schema: z.object({ label: z.string() }),
});
const durableRelates = defineEdge("durableRelates", {
  schema: z.object({ label: z.string() }),
});
const graph = defineGraph({
  id: "atomic-mutation-program-pglite-routing",
  nodes: { Person: { type: Person, onDelete: "restrict" } },
  edges: {
    relates: { type: relates, from: [Person], to: [Person] },
    durableRelates: {
      type: durableRelates,
      from: [Person],
      to: [Person],
      matchIdentity: { name: "label", fields: ["label"] },
    },
  },
});

describe("interactive PostgreSQL atomic mutation routing", () => {
  it("dispatches every reachable family variant on a real engine", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    const backend = createPostgresBackend(local.db, { vector: false });
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const profile = requireDefined(resolveAtomicMutationPrograms(backend));
      expect(
        reachableAtomicMutationProgramVariants(
          profile,
          backend.capabilities.execution,
        ),
      ).toEqual([
        "createNodes",
        "createEdges",
        "deleteNodes",
        "deleteEdges",
        "updateNodes",
        "updateEdges",
        "mutateEdges.durableConvergence",
      ]);

      const seeded = await store.nodes.Person.bulkCreate([
        { id: "from", props: { name: "From", score: 1 } },
        { id: "to", props: { name: "To", score: 2 } },
        { id: "update-node", props: { name: "Update", score: 3 } },
        { id: "mutate-node", props: { name: "Mutate", score: 4 } },
        { id: "delete-node", props: { name: "Delete", score: 5 } },
      ]);
      const from = requireDefined(seeded[0]);
      const to = requireDefined(seeded[1]);
      await store.edges.relates.bulkCreate([
        {
          id: "update-edge",
          from,
          to,
          props: { label: "Update" },
        },
        {
          id: "mutate-edge",
          from,
          to,
          props: { label: "Mutate" },
        },
        {
          id: "delete-edge",
          from,
          to,
          props: { label: "Delete" },
        },
      ]);

      const dispatched: string[] = [];
      await withAtomicMutationProgramDispatchObserver(
        backend,
        (variant) => {
          dispatched.push(variant);
        },
        async () => {
          await store.nodes.Person.bulkCreate([
            { id: "created-node-a", props: { name: "A", score: 10 } },
            { id: "created-node-b", props: { name: "B", score: 11 } },
          ]);
          await store.edges.relates.bulkCreate([
            {
              id: "created-edge-a",
              from,
              to,
              props: { label: "A" },
            },
            {
              id: "created-edge-b",
              from: to,
              to: from,
              props: { label: "B" },
            },
          ]);
          await store.nodes.Person.update("update-node" as never, {
            name: "Updated",
            score: 20,
          });
          await store.edges.relates.update("update-edge" as never, {
            label: "Updated",
          });
          await store.edges.durableRelates.bulkGetOrCreateByEndpoints([
            { from, to, props: { label: "Durable" } },
          ]);
          await store.edges.relates.bulkDelete(["delete-edge" as never]);
          await store.nodes.Person.bulkDelete(["delete-node" as never]);
        },
      );

      expect(dispatched).toEqual([
        "createNodes",
        "createEdges",
        "updateNodes",
        "updateEdges",
        "mutateEdges.durableConvergence",
        "deleteEdges",
        "deleteNodes",
      ]);
      await expect(
        store.nodes.Person.getById("update-node" as never),
      ).resolves.toMatchObject({ name: "Updated", score: 20 });
      await expect(
        store.edges.relates.getById("update-edge" as never),
      ).resolves.toMatchObject({ label: "Updated" });
      await expect(
        store.nodes.Person.getById("delete-node" as never),
      ).resolves.toBeUndefined();
    } finally {
      await local.backend.close();
    }
  });

  it("rebinds mixed resolved sets to their exact collection transaction", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    const backend = createPostgresBackend(local.db, { vector: false });
    try {
      const [seedStore] = await createStoreWithSchema(graph, backend);
      const [from, to, existingNode] = await seedStore.nodes.Person.bulkCreate([
        { id: "session-from", props: { name: "From", score: 1 } },
        { id: "session-to", props: { name: "To", score: 2 } },
        { id: "session-node", props: { name: "Existing", score: 3 } },
      ]);
      const existingEdge = await seedStore.edges.relates.create(
        requireDefined(from),
        requireDefined(to),
        { label: "Existing" },
        { id: "session-edge" },
      );

      const dispatched: string[] = [];
      const observedBackend = deriveBackend(backend, {
        transaction: (fn, options) =>
          backend.transaction(async (transactionBackend) => {
            expect(transactionBackend.capabilities.execution.atomicBatch).toBe(
              "session",
            );
            expect("executeRaw" in transactionBackend).toBe(false);
            expect(Object.hasOwn(transactionBackend, "executeRaw")).toBe(false);
            const sessionProfile = requireDefined(
              resolveAtomicMutationPrograms(transactionBackend),
            );
            expect(Object.keys(sessionProfile)).toEqual([
              "mutateNodes",
              "mutateEdges",
            ]);
            expect(
              sessionProfile.mutateEdges?.maxEntries.durableConvergence,
            ).toBe(0);
            expect(
              reachableAtomicMutationProgramVariants(
                sessionProfile,
                transactionBackend.capabilities.execution,
              ),
            ).toEqual(["mutateNodes", "mutateEdges.resolvedSet"]);
            const ordinaryWrapper = deriveBackend(transactionBackend, {});
            expect(ordinaryWrapper.capabilities.execution.atomicBatch).toBe(
              "none",
            );
            expect(
              resolveAtomicMutationPrograms(ordinaryWrapper),
            ).toBeUndefined();
            return withAtomicMutationProgramDispatchObserver(
              transactionBackend,
              (variant) => {
                dispatched.push(variant);
              },
              () => fn(transactionBackend),
            );
          }, options),
      });
      const [store] = await createVerifiedStore(graph, observedBackend);

      await store.nodes.Person.bulkUpsertById([
        { id: "session-new-node", props: { name: "New", score: 4 } },
        {
          id: requireDefined(existingNode).id,
          props: { name: "Updated", score: 5 },
        },
      ]);
      await store.edges.relates.bulkUpsertById([
        {
          id: existingEdge.id,
          from: requireDefined(from),
          to: requireDefined(to),
          props: { label: "Updated" },
        },
        {
          id: "session-new-edge" as never,
          from: requireDefined(to),
          to: requireDefined(from),
          props: { label: "New" },
        },
      ]);
      expect(dispatched).toEqual(["mutateNodes", "mutateEdges.resolvedSet"]);

      dispatched.length = 0;
      await store.transaction((tx) =>
        tx.nodes.Person.bulkUpsertById([
          {
            id: "caller-session-new",
            props: { name: "Caller new", score: 6 },
          },
          {
            id: requireDefined(existingNode).id,
            props: { name: "Caller updated", score: 7 },
          },
        ]),
      );
      expect(dispatched).toEqual(["mutateNodes"]);

      dispatched.length = 0;
      const repeated = await store.nodes.Person.bulkUpsertById([
        { id: "session-repeated", props: { name: "First", score: 8 } },
        { id: "session-repeated", props: { name: "Second", score: 9 } },
      ]);
      expect(dispatched).toEqual([]);
      expect(dispatched).not.toContain("mutateNodes");
      expect(repeated.map((node) => [node.name, node.score])).toEqual([
        ["First", 8],
        ["Second", 9],
      ]);
    } finally {
      await local.backend.close();
    }
  });

  it("restores the session after a program refusal so diagnosis stays typed", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    const backend = createPostgresBackend(local.db, { vector: false });
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const [from, to] = await store.nodes.Person.bulkCreate([
        { id: "refusal-from", props: { name: "From", score: 1 } },
        { id: "refusal-to", props: { name: "To", score: 2 } },
      ]);
      const existing = await store.edges.relates.create(
        requireDefined(from),
        requireDefined(to),
        { label: "Before" },
        { id: "refusal-existing" },
      );

      await expect(
        store.edges.relates.bulkUpsertById([
          {
            id: existing.id,
            from: requireDefined(from),
            to: requireDefined(to),
            props: { label: "Must roll back" },
          },
          {
            id: "refusal-new" as never,
            from: requireDefined(from),
            to: { kind: Person.kind, id: "missing-endpoint" },
            props: { label: "Invalid" },
          },
        ]),
      ).rejects.toBeInstanceOf(EndpointNotFoundError);

      await expect(
        store.edges.relates.getById(existing.id),
      ).resolves.toMatchObject({ label: "Before" });
      await expect(
        store.edges.relates.getById("refusal-new" as never),
      ).resolves.toBeUndefined();
    } finally {
      await local.backend.close();
    }
  });
});
