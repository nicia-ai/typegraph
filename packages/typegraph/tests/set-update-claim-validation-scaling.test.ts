/**
 * A set update's uniqueness validation stays linear in the number of rows it
 * rewrites. `validateResolvedNodeClaims` refuses two members of the set that
 * compete for one claim row; it used to compare every proposal with every
 * earlier one, re-encoding both claim keys per comparison, so 10,000 rows of a
 * uniquely constrained kind spent ~15 s in that loop alone. The count of
 * claim-key encodings is the deterministic measure: it doubles with the set
 * when the comparison is bucketed by claim row, and quadruples when it is not.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../src";
import type * as TupleKey from "../src/utils/tuple-key";
import { createTestBackend } from "./test-utils";

const encodings = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/utils/tuple-key", async (importOriginal) => {
  const actual = await importOriginal<typeof TupleKey>();
  return {
    ...actual,
    encodeTupleKey: (...args: Parameters<typeof actual.encodeTupleKey>) => {
      encodings.count += 1;
      return actual.encodeTupleKey(...args);
    },
  };
});

const Ticket = defineNode("Ticket", {
  schema: z.object({ code: z.string(), status: z.string() }),
});

const graph = defineGraph({
  id: "set_update_claim_scaling",
  nodes: {
    Ticket: {
      type: Ticket,
      unique: [
        {
          name: "ticket_code",
          fields: ["code"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

async function seededStore(backend: GraphBackend, count: number) {
  const [store] = await createStoreWithSchema(graph, backend, {
    autoRefreshStatistics: false,
  });
  await store.nodes.Ticket.bulkInsert(
    Array.from({ length: count }, (_, index) => ({
      id: `ticket-${index}`,
      props: { code: `code-${index}`, status: "open" },
    })),
  );
  return store;
}

async function encodingsForUpdateOf(count: number): Promise<number> {
  const store = await seededStore(createTestBackend(), count);
  encodings.count = 0;
  const { affectedCount } = await store.nodes.Ticket.updateWhere({
    all: true,
    patch: { status: "closed" },
  });
  expect(affectedCount).toBe(count);
  return encodings.count;
}

describe("set-update uniqueness validation", () => {
  beforeEach(() => {
    encodings.count = 0;
  });

  it("encodes claim keys a number of times linear in the rows it rewrites", async () => {
    const small = await encodingsForUpdateOf(500);
    const large = await encodingsForUpdateOf(1000);

    // Linear work doubles; the pairwise comparison quadrupled it.
    expect(large / small).toBeLessThan(2.5);
  });

  it("still refuses two rewritten rows that compete for one claim, writing nothing", async () => {
    const store = await seededStore(createTestBackend(), 3);

    await expect(
      store.nodes.Ticket.updateWhere({
        all: true,
        patch: { code: "shared" },
      }),
    ).rejects.toMatchObject({
      name: "UniquenessError",
      details: { constraintName: "ticket_code" },
    });
    const stored = await store.nodes.Ticket.getById(
      "ticket-0" as Parameters<typeof store.nodes.Ticket.getById>[0],
    );
    expect(stored?.code).toBe("code-0");
  });
});
