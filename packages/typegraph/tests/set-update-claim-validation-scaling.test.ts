/**
 * A set update's uniqueness validation stays linear in the number of rows it
 * rewrites. `validateResolvedNodeClaims` refuses two members of the set that
 * compete for one claim row; it used to compare every proposal with every
 * earlier one, re-encoding both claim keys per comparison, so 10,000 rows of a
 * uniquely constrained kind spent ~15 s in that loop alone. The count of
 * proposal comparisons is the deterministic measure. Every comparison first
 * asks whether the two proposals share an owner (`isSameClaimOwner`), so the
 * calls to it count the comparisons whatever else a comparison reuses: they
 * grow linearly with the set when a proposal is compared only with its own
 * claim row's earlier proposals, and quadratically when it is compared with
 * every earlier one — even when each proposal's encoded key is cached, which
 * leaves the count of key encodings linear.
 *
 * The refusal of two members that compete for one claim must stay with that
 * in-set check: the persisted-claim probe and the claim rebuild that follow it
 * would also fail on such a set, but only after reading and rewriting claim
 * rows, so the refusal case counts the calls that reach them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../src";
import {
  deriveBackend,
  type ExactBackendOverlay,
} from "../src/backend/derive-backend";
import type { TransactionBackend } from "../src/backend/types";
import type * as ClaimAxis from "../src/store/claims/axis";
import { createTestBackend } from "./test-utils";

const comparisons = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/store/claims/axis", async (importOriginal) => {
  const actual = await importOriginal<typeof ClaimAxis>();
  return {
    ...actual,
    isSameClaimOwner: (...args: Parameters<typeof actual.isSameClaimOwner>) => {
      comparisons.count += 1;
      return actual.isSameClaimOwner(...args);
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

/** The backend members a set update's claim maintenance reaches, in order. */
const CLAIM_MEMBERS = [
  "previewNodeSetUpdate",
  "updateNodeSet",
  "checkUniqueBatch",
  "hardDeleteUniquesByNodeIds",
  "insertUniqueBatch",
] as const;

type ClaimMember = (typeof CLAIM_MEMBERS)[number];

/**
 * Counts {@link CLAIM_MEMBERS} calls on `backend` and on every transaction it
 * opens, where the set update runs.
 */
function countingClaimMembers(backend: GraphBackend): Readonly<{
  backend: GraphBackend;
  counts: Record<ClaimMember, number>;
}> {
  const counts = Object.fromEntries(
    CLAIM_MEMBERS.map((member) => [member, 0]),
  ) as Record<ClaimMember, number>;
  function counted<T extends GraphBackend | TransactionBackend>(target: T): T {
    const overrides: Record<string, unknown> = {};
    for (const member of CLAIM_MEMBERS) {
      const original: unknown = Reflect.get(target, member);
      if (typeof original !== "function") continue;
      overrides[member] = (...args: unknown[]) => {
        counts[member] += 1;
        return (original as (...callArguments: unknown[]) => unknown).apply(
          target,
          args,
        );
      };
    }
    return deriveBackend<T, Partial<T>>(
      target,
      overrides as ExactBackendOverlay<T, Partial<T>>,
    );
  }
  return {
    backend: deriveBackend(counted(backend), {
      transaction: (run, options) =>
        backend.transaction((target) => run(counted(target)), options),
    }),
    counts,
  };
}

async function comparisonsForUpdateOf(count: number): Promise<number> {
  const store = await seededStore(createTestBackend(), count);
  comparisons.count = 0;
  const { affectedCount } = await store.nodes.Ticket.updateWhere({
    all: true,
    patch: { status: "closed" },
  });
  expect(affectedCount).toBe(count);
  return comparisons.count;
}

describe("set-update uniqueness validation", () => {
  beforeEach(() => {
    comparisons.count = 0;
  });

  it("compares proposals a number of times linear in the rows it rewrites", async () => {
    const small = await comparisonsForUpdateOf(500);
    const large = await comparisonsForUpdateOf(1000);

    // Bucketed by claim row: one owner check per row (500, then 1,000), all
    // outside the in-set comparison since no two codes share a row. Compared
    // with every earlier proposal: 125,250, then 500,500.
    expect(small).toBeLessThanOrEqual(2 * 500);
    expect(large).toBeLessThanOrEqual(2 * 1000);
    expect(large / small).toBeLessThan(2.5);
  });

  it("refuses two rewritten rows that compete for one claim in the set itself, before any claim row is read or rewritten", async () => {
    const { backend, counts } = countingClaimMembers(createTestBackend());
    const store = await seededStore(backend, 3);
    for (const member of CLAIM_MEMBERS) counts[member] = 0;

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
    // The dry-run ran (its after-images are what the check reads); the row
    // write, the persisted-claim probe and the rebuild never did.
    expect(counts).toEqual({
      previewNodeSetUpdate: 1,
      updateNodeSet: 0,
      checkUniqueBatch: 0,
      hardDeleteUniquesByNodeIds: 0,
      insertUniqueBatch: 0,
    });
  });
});
