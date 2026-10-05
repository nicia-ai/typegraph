import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../../src";
import { createStoreWithSchema } from "../../../src/store/store";
import { createTestBackend } from "../../test-utils";

const A = defineNode("A", { schema: z.object({ n: z.string() }) });
const B = defineNode("B", { schema: z.object({ n: z.string() }) });
const C = defineNode("C", { schema: z.object({ n: z.string() }) });
const e = defineEdge("e", { schema: z.object({}) });

const nodes = { A: { type: A }, B: { type: B }, C: { type: C } };
const wide = defineGraph({
  id: "audit_endpoint_narrowing",
  nodes,
  edges: { e: { type: e, from: [A], to: [B, C] } },
});
const narrow = defineGraph({
  id: "audit_endpoint_narrowing",
  nodes,
  edges: { e: { type: e, from: [A], to: [B] } },
});

describe("audit: narrowing an edge kind's declared endpoints", () => {
  it("edge-endpoint-narrowing-commit", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(wide, backend);
    const a = await store.nodes.A.create({ n: "a" });
    const c = await store.nodes.C.create({ n: "c" });
    await store.edges.e.create(a, c as never, {});

    // Correct behavior: the commit is refused (a tightening that live rows
    // violate), or the stored graph still satisfies its declared constraints.
    const outcome = await createStoreWithSchema(narrow, backend).then(
      ([narrowed]) => narrowed,
      () => undefined,
    );
    if (outcome !== undefined) {
      expect(await outcome.verifyConstraintFences()).toEqual([]);
    }
  });
});
