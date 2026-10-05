/**
 * FINDING acyclic-batch-cycle-survives-caught-refusal.
 *
 * Batch edge writes into an `acyclic: true` kind insert first and probe after.
 * The refusal is a typed `EdgeAcyclicityError`, and a caller may catch it
 * inside `store.transaction` and keep going (the documented per-row recovery
 * pattern). The refused rows are not removed, so the transaction commits a
 * graph that contains the cycle. The single `create` path (probe-then-insert)
 * leaves nothing behind.
 *
 * Correct behavior: after a refused write, the stored graph satisfies the
 * declared constraints even when the refusal is caught inside an enclosing
 * transaction.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { createTestBackend } from "../../test-utils";

const Task = defineNode("Task", { schema: z.object({}) });
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });

const graph = defineGraph({
  id: "audit_acyclic_batch_caught",
  nodes: { Task: { type: Task } },
  edges: {
    dependsOn: { type: dependsOn, from: [Task], to: [Task], acyclic: true },
  },
});

type BatchPath = Readonly<{
  name: string;
  write: (
    store: Awaited<ReturnType<typeof createStoreWithSchema<typeof graph>>>[0],
    from: { kind: "Task"; id: string },
    to: { kind: "Task"; id: string },
  ) => Promise<unknown>;
}>;

const BATCH_PATHS: readonly BatchPath[] = [
  {
    name: "bulkCreate",
    write: (tx, from, to) =>
      tx.edges.dependsOn.bulkCreate([{ from, to, props: {} }]),
  },
  {
    name: "bulkInsert",
    write: (tx, from, to) =>
      tx.edges.dependsOn.bulkInsert([{ from, to, props: {} }]),
  },
  {
    name: "bulkGetOrCreateByEndpoints",
    write: (tx, from, to) =>
      tx.edges.dependsOn.bulkGetOrCreateByEndpoints([{ from, to, props: {} }]),
  },
  {
    name: "bulkUpsertById",
    write: (tx, from, to) =>
      tx.edges.dependsOn.bulkUpsertById([
        { id: "closing-edge", from, to, props: {} },
      ] as never),
  },
];

describe("acyclic-batch-cycle-survives-caught-refusal", () => {
  it("leaves no cycle behind when a batch refusal is caught inside a transaction", async () => {
    const survivors: string[] = [];
    for (const path of BATCH_PATHS) {
      const [store] = await createStoreWithSchema(graph, createTestBackend());
      const a = await store.nodes.Task.create({});
      const b = await store.nodes.Task.create({});
      const c = await store.nodes.Task.create({});
      await store.edges.dependsOn.create(a, b, {});
      await store.edges.dependsOn.create(b, c, {});

      await store.transaction(async (tx) => {
        await path.write(tx as never, c, a).catch(() => undefined);
      });

      const violations = await store.verifyConstraintFences();
      if (violations.some((violation) => violation.family === "edgeAcyclicity")) {
        survivors.push(path.name);
      }
    }
    expect(survivors).toEqual([]);
  });
});
