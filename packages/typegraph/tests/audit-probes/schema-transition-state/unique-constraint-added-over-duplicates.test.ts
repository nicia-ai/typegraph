import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../../src";
import { createStoreWithSchema } from "../../../src/store/store";
import { createTestBackend } from "../../test-utils";

const Member = defineNode("Member", {
  schema: z.object({ email: z.string() }),
});
const without = defineGraph({
  id: "audit_unique_added",
  nodes: { Member: { type: Member } },
  edges: {},
});
const withUnique = defineGraph({
  id: "audit_unique_added",
  nodes: {
    Member: {
      type: Member,
      unique: [
        { name: "member_email", fields: ["email"], scope: "kind", collation: "binary" },
      ],
    },
  },
  edges: {},
});

describe("audit: adding a unique constraint to a populated kind", () => {
  it("unique-constraint-added-over-duplicates", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(without, backend);
    await store.nodes.Member.create({ email: "dup@example.com" });
    await store.nodes.Member.create({ email: "dup@example.com" });

    // Store.evolve() refuses this tightening on a populated kind; the
    // code-graph commit paths must not publish a constraint the stored rows
    // already violate.
    await expect(createStoreWithSchema(withUnique, backend)).rejects.toThrow();
  });
});
