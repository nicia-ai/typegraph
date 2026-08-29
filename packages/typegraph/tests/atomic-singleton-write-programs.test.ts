import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { withAtomicMutationProgramDispatchObserver } from "../src/backend/capabilities/atomic-mutation-program";
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
  id: "atomic-singleton-write-programs",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
  },
});

describe("atomic singleton write programs", () => {
  it("dispatches eligible updates and deletes under singleton hooks", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-singleton-programs-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const { backend } = await createLibsqlBackend(client);
    const hookEvents: string[] = [];
    try {
      const [store] = await createStoreWithSchema(graph, backend, {
        hooks: {
          onOperationStart: (context) => {
            hookEvents.push(`start:${context.operation}:${context.entity}`);
          },
          onOperationEnd: (context, result) => {
            hookEvents.push(
              `end:${context.operation}:${context.entity}:${result.outcome}`,
            );
          },
        },
      });
      const person = await store.nodes.Person.create({ name: "Alice" });
      const company = await store.nodes.Company.create({ name: "Acme" });
      const edge = await store.edges.worksAt.create(person, company, {
        role: "Engineer",
      });
      hookEvents.length = 0;
      const execute = vi.spyOn(client, "execute");
      const batch = vi.spyOn(client, "batch");
      const dispatches: string[] = [];
      const exchanges: Readonly<{ execute: number; batch: number }>[] = [];

      async function measure(run: () => Promise<unknown>): Promise<void> {
        execute.mockClear();
        batch.mockClear();
        await run();
        exchanges.push({
          execute: execute.mock.calls.length,
          batch: batch.mock.calls.length,
        });
      }

      await withAtomicMutationProgramDispatchObserver(
        backend,
        (variant) => {
          dispatches.push(variant);
        },
        async () => {
          await measure(() =>
            store.nodes.Person.update(person.id, { name: "Alice II" }),
          );
          await measure(() =>
            store.edges.worksAt.update(edge.id, { role: "Principal" }),
          );
          await measure(() => store.edges.worksAt.delete(edge.id));
          await measure(() => store.nodes.Person.delete(person.id));

          // The public singleton contract keeps missing/tombstoned deletes as
          // hook-free gate no-ops. The closed program must not dispatch merely
          // because the family is eligible.
          await store.edges.worksAt.delete(edge.id);
          await store.nodes.Person.delete(person.id);
        },
      );

      expect(dispatches).toEqual([
        "updateNodes",
        "updateEdges",
        "deleteEdges",
        "deleteNodes",
      ]);
      expect(exchanges).toEqual([
        { execute: 1, batch: 1 },
        { execute: 1, batch: 1 },
        { execute: 1, batch: 1 },
        { execute: 1, batch: 1 },
      ]);
      expect(hookEvents).toEqual([
        "start:update:node",
        "end:update:node:written",
        "start:update:edge",
        "end:update:edge:written",
        "start:delete:edge",
        "end:delete:edge:written",
        "start:delete:node",
        "end:delete:node:written",
      ]);
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
