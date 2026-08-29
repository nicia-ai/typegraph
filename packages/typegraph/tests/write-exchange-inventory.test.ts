import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { resolveBundledRootAtomicMutationPrograms } from "../src/backend/capabilities/atomic-mutation-program";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { createStoreWithSchema, createVerifiedStore } from "../src/store";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const ClaimedPerson = defineNode("ClaimedPerson", {
  schema: z.object({ name: z.string() }),
});
const unconstrained = defineEdge("unconstrained", {
  schema: z.object({ role: z.string() }),
});
const constrained = defineEdge("constrained", {
  schema: z.object({ role: z.string() }),
});
const durable = defineEdge("durable", {
  schema: z.object({ role: z.string() }),
});
const graph = defineGraph({
  id: "write-exchange-inventory",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
    ClaimedPerson: {
      type: ClaimedPerson,
      unique: [
        {
          name: "claimed_person_name",
          fields: ["name"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    unconstrained: {
      type: unconstrained,
      from: [Person],
      to: [Company],
    },
    constrained: {
      type: constrained,
      from: [Person],
      to: [Company],
      cardinality: "one",
    },
    durable: {
      type: durable,
      from: [Person],
      to: [Company],
      matchIdentity: { name: "role", fields: ["role"] },
    },
  },
});

describe("managed write exchange inventory", () => {
  it("records current libSQL transport calls by bulk shape", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-write-exchanges-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const { backend, db } = await createLibsqlBackend(client);
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const transactionlessBackend = createSqliteBackend(db, {
        executionProfile: { isSync: false, transactionMode: "none" },
      });
      const [transactionlessStore] = await createVerifiedStore(
        graph,
        transactionlessBackend,
      );
      expect(
        resolveBundledRootAtomicMutationPrograms(transactionlessBackend)
          ?.updateEdges,
      ).toBeDefined();
      const from = await store.nodes.Person.create({ name: "Alice" });
      const to = await store.nodes.Company.create({ name: "Acme" });
      const deletableEdges = await store.edges.unconstrained.bulkCreate([
        { from, to, props: { role: "Delete A" } },
        { from, to, props: { role: "Delete B" } },
      ]);
      const deletableNodes = await store.nodes.Person.bulkCreate([
        { props: { name: "Delete Node A" } },
        { props: { name: "Delete Node B" } },
      ]);
      const upsertableNodes = await store.nodes.Person.bulkCreate([
        { props: { name: "Upsert Node A" } },
        { props: { name: "Upsert Node B" } },
      ]);
      const upsertableEdges = await store.edges.unconstrained.bulkCreate([
        { from, to, props: { role: "Upsert Edge A" } },
        { from, to, props: { role: "Upsert Edge B" } },
      ]);
      const singletonNode = await store.nodes.Person.create({
        name: "Singleton Node",
      });
      const singletonEdge = await store.edges.unconstrained.create(from, to, {
        role: "Singleton Edge",
      });
      const singletonDeletableNode = await store.nodes.Person.create({
        name: "Singleton Delete Node",
      });
      const singletonDeletableEdge = await store.edges.unconstrained.create(
        from,
        to,
        { role: "Singleton Delete Edge" },
      );
      const execute = vi.spyOn(client, "execute");
      const batch = vi.spyOn(client, "batch");

      async function measure(name: string, fn: () => Promise<unknown>) {
        execute.mockClear();
        batch.mockClear();
        await fn();
        return {
          name,
          execute: execute.mock.calls.length,
          batch: batch.mock.calls.length,
        };
      }

      const measurements = [
        await measure("atomic-node-batch", () =>
          store.nodes.Person.bulkInsert([
            { props: { name: "Generated A" } },
            { props: { name: "Generated B" } },
          ]),
        ),
        await measure("caller-id-node-batch", () =>
          store.nodes.Person.bulkInsert([
            { id: "caller-a", props: { name: "Caller A" } },
            { id: "caller-b", props: { name: "Caller B" } },
          ]),
        ),
        await measure("mixed-id-node-batch", () =>
          store.nodes.Person.bulkInsert([
            { props: { name: "Mixed Generated" } },
            { id: "mixed-caller", props: { name: "Mixed Caller" } },
          ]),
        ),
        await measure("generated-node-create-batch", () =>
          store.nodes.Person.bulkCreate([
            { props: { name: "Created Generated A" } },
            { props: { name: "Created Generated B" } },
          ]),
        ),
        await measure("caller-id-node-create-batch", () =>
          store.nodes.Person.bulkCreate([
            { id: "create-caller-a", props: { name: "Created Caller A" } },
            { id: "create-caller-b", props: { name: "Created Caller B" } },
          ]),
        ),
        await measure("mixed-id-node-create-batch", () =>
          store.nodes.Person.bulkCreate([
            { props: { name: "Created Mixed Generated" } },
            {
              id: "create-mixed-caller",
              props: { name: "Created Mixed Caller" },
            },
          ]),
        ),
        await measure("generated-claimed-node-batch", () =>
          store.nodes.ClaimedPerson.bulkInsert([
            { props: { name: "Claimed Generated A" } },
            { props: { name: "Claimed Generated B" } },
          ]),
        ),
        await measure("generated-claimed-node-create-batch", () =>
          store.nodes.ClaimedPerson.bulkCreate([
            { props: { name: "Claimed Created A" } },
            { props: { name: "Claimed Created B" } },
          ]),
        ),
        await measure("unconstrained-edge-batch", () =>
          store.edges.unconstrained.bulkInsert([
            { from, to, props: { role: "U1" } },
            { from, to, props: { role: "U2" } },
          ]),
        ),
        await measure("constrained-edge-batch", () =>
          store.edges.constrained.bulkInsert([
            { from, to, props: { role: "C1" } },
          ]),
        ),
        await measure("durable-edge-batch", () =>
          store.edges.durable.bulkInsert([
            { from, to, props: { role: "D1" } },
            { from, to, props: { role: "D2" } },
          ]),
        ),
        await measure("durable-edge-bulk-get-or-create", () =>
          store.edges.durable.bulkGetOrCreateByEndpoints([
            { from, to, props: { role: "D3" } },
            { from, to, props: { role: "D4" } },
          ]),
        ),
        await measure("singleton-node-update", () =>
          store.nodes.Person.update(singletonNode.id, {
            name: "Updated Singleton Node",
          }),
        ),
        await measure("singleton-edge-update", () =>
          store.edges.unconstrained.update(singletonEdge.id, {
            role: "Updated Singleton Edge",
          }),
        ),
        await measure("singleton-edge-delete", () =>
          store.edges.unconstrained.delete(singletonDeletableEdge.id),
        ),
        await measure("singleton-node-delete", () =>
          store.nodes.Person.delete(singletonDeletableNode.id),
        ),
        await measure("edge-delete-batch", () =>
          store.edges.unconstrained.bulkDelete(
            deletableEdges.map((edge) => edge.id),
          ),
        ),
        await measure("node-delete-batch", () =>
          store.nodes.Person.bulkDelete(deletableNodes.map((node) => node.id)),
        ),
        await measure("node-update-upsert-batch", () =>
          transactionlessStore.nodes.Person.bulkUpsertById(
            upsertableNodes.map((node, index) => ({
              id: node.id,
              props: { name: `Updated Node ${index}` },
            })),
          ),
        ),
        await measure("edge-update-upsert-batch", () =>
          transactionlessStore.edges.unconstrained.bulkUpsertById(
            upsertableEdges.map((edge, index) => ({
              id: edge.id,
              from,
              to,
              props: { role: `Updated Edge ${index}` },
            })),
          ),
        ),
        await measure("node-mixed-upsert-batch", () =>
          transactionlessStore.nodes.Person.bulkUpsertById([
            {
              id: requireDefined(upsertableNodes[0]).id,
              props: { name: "Mixed Node Update" },
            },
            { id: "mixed-node-create", props: { name: "Mixed Node Create" } },
          ]),
        ),
        await measure("edge-mixed-upsert-batch", () =>
          transactionlessStore.edges.unconstrained.bulkUpsertById([
            {
              id: requireDefined(upsertableEdges[0]).id,
              from,
              to,
              props: { role: "Mixed Edge Update" },
            },
            {
              id: "mixed-edge-create" as never,
              from,
              to,
              props: { role: "Mixed Edge Create" },
            },
          ]),
        ),
      ];

      expect(measurements).toMatchInlineSnapshot(`
        [
          {
            "batch": 1,
            "execute": 0,
            "name": "atomic-node-batch",
          },
          {
            "batch": 1,
            "execute": 0,
            "name": "caller-id-node-batch",
          },
          {
            "batch": 1,
            "execute": 0,
            "name": "mixed-id-node-batch",
          },
          {
            "batch": 1,
            "execute": 0,
            "name": "generated-node-create-batch",
          },
          {
            "batch": 1,
            "execute": 0,
            "name": "caller-id-node-create-batch",
          },
          {
            "batch": 1,
            "execute": 0,
            "name": "mixed-id-node-create-batch",
          },
          {
            "batch": 1,
            "execute": 0,
            "name": "generated-claimed-node-batch",
          },
          {
            "batch": 1,
            "execute": 0,
            "name": "generated-claimed-node-create-batch",
          },
          {
            "batch": 1,
            "execute": 0,
            "name": "unconstrained-edge-batch",
          },
          {
            "batch": 1,
            "execute": 0,
            "name": "constrained-edge-batch",
          },
          {
            "batch": 1,
            "execute": 0,
            "name": "durable-edge-batch",
          },
          {
            "batch": 1,
            "execute": 0,
            "name": "durable-edge-bulk-get-or-create",
          },
          {
            "batch": 1,
            "execute": 1,
            "name": "singleton-node-update",
          },
          {
            "batch": 1,
            "execute": 1,
            "name": "singleton-edge-update",
          },
          {
            "batch": 1,
            "execute": 1,
            "name": "singleton-edge-delete",
          },
          {
            "batch": 1,
            "execute": 1,
            "name": "singleton-node-delete",
          },
          {
            "batch": 1,
            "execute": 0,
            "name": "edge-delete-batch",
          },
          {
            "batch": 1,
            "execute": 0,
            "name": "node-delete-batch",
          },
          {
            "batch": 1,
            "execute": 1,
            "name": "node-update-upsert-batch",
          },
          {
            "batch": 1,
            "execute": 1,
            "name": "edge-update-upsert-batch",
          },
          {
            "batch": 1,
            "execute": 1,
            "name": "node-mixed-upsert-batch",
          },
          {
            "batch": 1,
            "execute": 1,
            "name": "edge-mixed-upsert-batch",
          },
        ]
      `);
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
