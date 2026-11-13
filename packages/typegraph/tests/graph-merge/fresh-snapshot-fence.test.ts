import { describe, expect, it } from "vitest";

import { postgresFenceSql } from "../../src/backend/drizzle/postgres-fence-sql";
import type {
  BackendCapabilities,
  TransactionBackend,
} from "../../src/backend/types";
import { MergePlanCapabilityError } from "../../src/graph-merge/errors";
import { lockMergeTargetWrite } from "../../src/graph-merge/write-fence";

const EXECUTION_CAPABILITIES = {
  interactiveTransactions: true,
  atomicBatch: "none",
  unitOfWork: "interactive",
} as const;

/**
 * A transaction whose fence statement reports `isolation` and, when
 * `generation` is given, an advanced fence row.
 */
function transactionBackend(
  writeFence: BackendCapabilities["writeFence"],
  isolation: unknown,
  generation?: number,
): TransactionBackend {
  return {
    dialect: "postgres",
    capabilities: {
      execution: EXECUTION_CAPABILITIES,
      writeFence,
    },
    fenceSql: postgresFenceSql,
    lockSchemaVersionForWrite: () => Promise.resolve(),
    execute: () =>
      Promise.resolve([
        {
          transaction_isolation: isolation,
          ...(generation === undefined ? {} : { generation }),
        },
      ]),
  } as unknown as TransactionBackend;
}

async function mutateAfterFreshFence(
  backend: TransactionBackend,
  witness: { mutated: boolean },
): Promise<void> {
  await lockMergeTargetWrite(backend, {
    graphId: "fresh-snapshot-fence",
    schemaVersion: 1,
    graphLock: "required",
    requireFreshSnapshot: true,
    staleSchemaError: (cause) =>
      new MergePlanCapabilityError("schema changed", { cause }),
  });
  witness.mutated = true;
}

describe("graph-merge fresh-snapshot fences", () => {
  it("refuses caller-serialized transactions that return no session coordination", async () => {
    const backend = transactionBackend(
      { mechanism: "caller-serialized" },
      "read committed",
    );
    const witness = { mutated: false };

    await expect(mutateAfterFreshFence(backend, witness)).rejects.toEqual(
      expect.objectContaining({
        name: "MergePlanCapabilityError",
        details: expect.objectContaining({
          capability: "mergeCallbackIsolation",
        }) as unknown,
      }),
    );
    expect(witness.mutated).toBe(false);
  });

  it("refuses an advisory lock whose session reports unknown isolation", async () => {
    const backend = transactionBackend(
      { mechanism: "advisory", drain: "table-lock" },
      "vendor snapshot",
    );
    const witness = { mutated: false };

    await expect(mutateAfterFreshFence(backend, witness)).rejects.toEqual(
      expect.objectContaining({
        name: "MergePlanCapabilityError",
        details: expect.objectContaining({
          capability: "mergeCallbackIsolation",
          isolation: "unknown",
        }) as unknown,
      }),
    );
    expect(witness.mutated).toBe(false);
  });
  const ADVISORY_FENCE = {
    mechanism: "advisory",
    drain: "table-lock",
  } as const;

  // The fence row is advanced by the holders that make a lock-only decision,
  // not by every holder, so advancing it shows nothing about a holder that
  // only captured history or a revision. The applier reads the whole target:
  // only a per-statement snapshot observes every earlier holder.
  it.each([
    ["repeatable read", "repeatable_read"],
    ["serializable", "serializable"],
  ])(
    "refuses a %s session even when its acquisition advanced the fence row",
    async (isolation, reported) => {
      const backend = transactionBackend(ADVISORY_FENCE, isolation, 7);
      const witness = { mutated: false };

      await expect(mutateAfterFreshFence(backend, witness)).rejects.toEqual(
        expect.objectContaining({
          name: "MergePlanCapabilityError",
          details: expect.objectContaining({
            capability: "mergeCallbackIsolation",
            isolation: reported,
          }) as unknown,
        }),
      );
      expect(witness.mutated).toBe(false);
    },
  );

  it.each([undefined, 7])(
    "accepts a read-committed session (fence-row generation: %s)",
    async (generation) => {
      const witness = { mutated: false };

      await mutateAfterFreshFence(
        transactionBackend(ADVISORY_FENCE, "read committed", generation),
        witness,
      );

      expect(witness.mutated).toBe(true);
    },
  );
});
