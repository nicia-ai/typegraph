/**
 * Contract B: after a REFUSED operation the stored graph still satisfies its
 * declared constraints, including when the caller catches the refusal inside
 * an enclosing `store.transaction(...)` and lets that transaction commit.
 *
 * `store.verifyConstraintFences()` is the oracle.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../../../src";
import { createTestBackend } from "../../test-utils";

const Task = defineNode("Task", { schema: z.object({}) });
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });
const acyclicGraph = defineGraph({
  id: "audit_edge_refusal_acyclic",
  nodes: { Task: { type: Task } },
  edges: {
    dependsOn: { type: dependsOn, from: [Task], to: [Task], acyclic: true },
  },
});

async function refusalOf(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("refused writes caught inside an enclosing transaction", () => {
  it("edge-batch-acyclicity-refusal-leaves-cycle", async () => {
    const leftBehind: string[] = [];
    const variants = [
      "bulkCreate",
      "bulkInsert",
      "bulkUpsertById",
      "bulkGetOrCreateByEndpoints",
    ] as const;
    for (const variant of variants) {
      const store = createStore(acyclicGraph, createTestBackend());
      const first = await store.nodes.Task.create({});
      const second = await store.nodes.Task.create({});
      await store.edges.dependsOn.create(first, second, {});
      const closing = { from: second, to: first, props: {} };

      let refusal: unknown;
      await store.transaction(async (tx) => {
        refusal = await refusalOf(async () => {
          switch (variant) {
            case "bulkCreate": {
              await tx.edges.dependsOn.bulkCreate([closing]);
              break;
            }
            case "bulkInsert": {
              await tx.edges.dependsOn.bulkInsert([closing]);
              break;
            }
            case "bulkUpsertById": {
              await tx.edges.dependsOn.bulkUpsertById([
                { id: "closing-edge" as never, ...closing },
              ]);
              break;
            }
            case "bulkGetOrCreateByEndpoints": {
              await tx.edges.dependsOn.bulkGetOrCreateByEndpoints([closing]);
              break;
            }
          }
        });
      });

      expect(refusal, `${variant} must be refused`).toBeDefined();
      const violations = await store.verifyConstraintFences();
      if (violations.length > 0) leftBehind.push(variant);
    }
    expect(leftBehind).toEqual([]);
  });
});
