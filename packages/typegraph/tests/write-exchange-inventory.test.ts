import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { createStoreWithSchema } from "../src/store";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});
const graph = defineGraph({
  id: "write-exchange-inventory",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {
    unconstrained: {
      type: worksAt,
      from: [Person],
      to: [Company],
    },
    constrained: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "one",
    },
    durable: {
      type: worksAt,
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
    const { backend } = await createLibsqlBackend(client);
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const from = await store.nodes.Person.create({ name: "Alice" });
      const to = await store.nodes.Company.create({ name: "Acme" });
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
        await measure("generated-node-batch", () =>
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
      ];

      expect(measurements).toMatchInlineSnapshot(`
        [
          {
            "batch": 1,
            "execute": 0,
            "name": "generated-node-batch",
          },
          {
            "batch": 0,
            "execute": 5,
            "name": "caller-id-node-batch",
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
        ]
      `);
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
