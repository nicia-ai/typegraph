/**
 * T5: a set operation whose operand is a variable-length traversal refuses
 * on a backend that declares no recursive traversal — proving the verdict
 * threads through `compileSetOperation`'s `compileOperand` (`ctx.compileQuery`
 * closure), not just the top-level `compileQuery` entry.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string().optional() }),
});

const graph = defineGraph({
  id: "set_operation_recursive_verdict",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

describe("set operation over a variable-length operand on a no-recursion backend", () => {
  it("refuses with the recursive traversal error, not a compiled recursion", async () => {
    const base = createTestBackend();
    const refusingBackend = deriveBackend(base, {
      capabilities: {
        ...base.capabilities,
        recursiveTraversal: {
          supported: false,
          reason: "set-operation-recursive-verdict test backend",
        },
      },
    });
    const [store] = await createStoreWithSchema(graph, refusingBackend);

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    await store.edges.knows.create(alice, bob, { since: "2020" });

    const plainQuery = store
      .query()
      .from("Person", "p")
      .select((ctx) => ctx.p.name);

    const recursiveQuery = store
      .query()
      .from("Person", "p")
      .traverse("knows", "e")
      .recursive()
      .to("Person", "friend")
      .select((ctx) => ctx.friend.name);

    const caught = await plainQuery
      .union(recursiveQuery)
      .execute()
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ConfigurationError);
    const error = caught as ConfigurationError;
    expect(error.details["code"]).toBe("RECURSIVE_TRAVERSAL_UNSUPPORTED");
    expect(error.details["reason"]).toBe(
      "set-operation-recursive-verdict test backend",
    );
  });
});
