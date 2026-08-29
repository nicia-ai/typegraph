import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  reachableAtomicMutationProgramVariants,
  resolveAtomicMutationPrograms,
  withAtomicMutationProgramDispatchObserver,
} from "../src/backend/capabilities/atomic-mutation-program";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { createStoreWithSchema } from "../src/store";
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
});
