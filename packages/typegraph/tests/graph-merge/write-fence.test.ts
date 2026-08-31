import { describe, expect, it } from "vitest";

import { type TransactionBackend } from "../../src/backend/types";
import { StaleVersionError } from "../../src/errors";
import { BaseVersionMismatchError } from "../../src/graph-merge/errors";
import { lockMergeTargetWrite } from "../../src/graph-merge/write-fence";

function makeBackend(
  events: string[],
  staleSchema = false,
): TransactionBackend {
  return {
    dialect: "postgres",
    capabilities: {
      execution: {
        interactiveTransactions: true,
        atomicBatch: "none",
      },
      pessimisticLocks: {
        advisoryLocks: true,
        tableLocks: true,
        serializedWriters: false,
      },
    },
    lockSchemaVersionForWrite: async () => {
      events.push("schema");
      if (staleSchema) {
        throw new StaleVersionError({
          graphId: "merge-fence",
          expected: 3,
          actual: 4,
        });
      }
    },
    execute: async () => {
      events.push("graph");
      return [{ transaction_isolation: "read committed" }];
    },
  } as unknown as TransactionBackend;
}

describe("graph-merge write fences", () => {
  it("acquires the schema fence before the graph lock", async () => {
    const events: string[] = [];
    await lockMergeTargetWrite(makeBackend(events), {
      graphId: "merge-fence",
      schemaVersion: 3,
      graphLock: "required",
      staleSchemaError: (cause) =>
        new BaseVersionMismatchError("schema moved", { cause }),
    });
    expect(events).toEqual(["schema", "graph"]);
  });

  it("translates a stale schema without acquiring the graph lock", async () => {
    const events: string[] = [];
    const backend = makeBackend(events, true);

    await expect(
      lockMergeTargetWrite(backend, {
        graphId: "merge-fence",
        schemaVersion: 3,
        graphLock: "required",
        staleSchemaError: (cause) =>
          new BaseVersionMismatchError("schema moved", { cause }),
      }),
    ).rejects.toBeInstanceOf(BaseVersionMismatchError);
    expect(events).toEqual(["schema"]);
  });

  it("can fence schema-managed writes without taking the revision graph lock", async () => {
    const events: string[] = [];
    await lockMergeTargetWrite(makeBackend(events), {
      graphId: "merge-fence",
      schemaVersion: 3,
      graphLock: "not-required",
      staleSchemaError: (cause) =>
        new BaseVersionMismatchError("schema moved", { cause }),
    });
    expect(events).toEqual(["schema"]);
  });
});
