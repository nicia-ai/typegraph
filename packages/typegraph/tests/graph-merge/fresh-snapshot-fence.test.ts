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

function transactionBackend(
  writeFence: BackendCapabilities["writeFence"],
  isolation: unknown,
): TransactionBackend {
  return {
    dialect: "postgres",
    capabilities: {
      execution: EXECUTION_CAPABILITIES,
      writeFence,
    },
    fenceSql: postgresFenceSql,
    lockSchemaVersionForWrite: () => Promise.resolve(),
    execute: () => Promise.resolve([{ transaction_isolation: isolation }]),
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
});
