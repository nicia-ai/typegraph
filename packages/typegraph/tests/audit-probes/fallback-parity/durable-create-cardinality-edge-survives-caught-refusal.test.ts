/**
 * FINDING durable-create-cardinality-edge-survives-caught-refusal.
 *
 * An edge kind with a durable `matchIdentity` skips the pre-insert cardinality
 * probe and takes its cardinality claim AFTER the converge-create command has
 * inserted the row ("if claiming refuses, the surrounding write frame rolls the
 * command back"). That rollback only exists when the frame owns the
 * transaction. Inside `store.transaction`, a caller that catches the
 * `CardinalityError` keeps the committed second edge, so a `cardinality: "one"`
 * kind ends with two live edges from one source.
 *
 * Correct behavior: a refused create leaves no edge row, whatever transaction
 * it runs in.
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

const Person = defineNode("Person", { schema: z.object({}) });
const knows = defineEdge("knows", { schema: z.object({ label: z.string() }) });

const graph = defineGraph({
  id: "audit_durable_caught",
  nodes: { Person: { type: Person } },
  edges: {
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "one",
      matchIdentity: { name: "knows-label", fields: ["label"] },
    },
  },
});

describe("durable-create-cardinality-edge-survives-caught-refusal", () => {
  it("keeps one live edge per source after a caught CardinalityError", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend());
    const source = await store.nodes.Person.create({});
    const first = await store.nodes.Person.create({});
    const second = await store.nodes.Person.create({});
    await store.edges.knows.create(source, first, { label: "first" });

    await store.transaction(async (tx) => {
      await tx.edges.knows
        .create(source, second, { label: "second" })
        .catch(() => undefined);
    });

    expect(await store.edges.knows.find({})).toHaveLength(1);
    expect(await store.verifyConstraintFences()).toEqual([]);
  });
});
