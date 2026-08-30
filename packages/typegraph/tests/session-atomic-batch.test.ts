import { describe, expect, it, vi } from "vitest";

import { createSessionAtomicBatchAdapter } from "../src/backend/drizzle/execution/session-atomic-batch";
import type { SqlExecutionAdapter } from "../src/backend/drizzle/execution/types";
import { CompilerInvariantError } from "../src/errors";
import { requireDefined } from "../src/utils/presence";

function createSessionAdapter(
  executeCompiled: NonNullable<SqlExecutionAdapter["executeCompiled"]>,
) {
  const connection = {
    compile: vi.fn(),
    execute: vi.fn(),
    executeCompiled,
  } as unknown as SqlExecutionAdapter;
  let exclusiveCalls = 0;
  const runExclusive: NonNullable<SqlExecutionAdapter["runExclusive"]> = async <
    T,
  >(
    critical: (adapter: SqlExecutionAdapter) => Promise<T>,
  ) => {
    exclusiveCalls += 1;
    return critical(connection);
  };
  return {
    execution: { executeCompiled, runExclusive },
    exclusiveCalls: () => exclusiveCalls,
  };
}

describe("transaction-session atomic batches", () => {
  it("holds one exclusive window around the savepoint and ordered program", async () => {
    const statements: string[] = [];
    const executeCompiled: NonNullable<
      SqlExecutionAdapter["executeCompiled"]
    > = <TRow>(statement: Readonly<{ sql: string }>) => {
      statements.push(statement.sql);
      return Promise.resolve([
        { sql: statement.sql },
      ] as unknown as readonly TRow[]);
    };
    const { execution, exclusiveCalls } = createSessionAdapter(executeCompiled);
    const batch = requireDefined(
      createSessionAtomicBatchAdapter(execution)?.executeAtomicBatch,
    );

    const result = await batch<{ sql: string }>([
      { sql: "SELECT first", params: [] },
      { sql: "SELECT second", params: [] },
    ]);

    expect(exclusiveCalls()).toBe(1);
    expect(statements).toEqual([
      "SAVEPOINT typegraph_atomic_program",
      "SELECT first",
      "SELECT second",
      "RELEASE SAVEPOINT typegraph_atomic_program",
    ]);
    expect(result).toEqual([
      [{ sql: "SELECT first" }],
      [{ sql: "SELECT second" }],
    ]);
  });

  it("restores a failed program before returning its original refusal", async () => {
    const refusal = new Error("sentinel refusal");
    const statements: string[] = [];
    const executeCompiled: NonNullable<
      SqlExecutionAdapter["executeCompiled"]
    > = <TRow>(statement: Readonly<{ sql: string }>) => {
      statements.push(statement.sql);
      if (statement.sql === "BROKEN") return Promise.reject(refusal);
      return Promise.resolve([] as readonly TRow[]);
    };
    const { execution } = createSessionAdapter(executeCompiled);
    const batch = requireDefined(
      createSessionAtomicBatchAdapter(execution)?.executeAtomicBatch,
    );

    await expect(batch([{ sql: "BROKEN", params: [] }])).rejects.toBe(refusal);
    expect(statements).toEqual([
      "SAVEPOINT typegraph_atomic_program",
      "BROKEN",
      "ROLLBACK TO SAVEPOINT typegraph_atomic_program",
      "RELEASE SAVEPOINT typegraph_atomic_program",
    ]);
  });

  it("reports failed savepoint recovery instead of returning a poisoned session", async () => {
    const refusal = new Error("sentinel refusal");
    const recoveryFailure = new Error("savepoint recovery failed");
    const statements: string[] = [];
    const executeCompiled: NonNullable<
      SqlExecutionAdapter["executeCompiled"]
    > = <TRow>(statement: Readonly<{ sql: string }>) => {
      statements.push(statement.sql);
      if (statement.sql === "BROKEN") {
        return Promise.reject(refusal);
      }
      if (statement.sql.startsWith("ROLLBACK TO")) {
        return Promise.reject(recoveryFailure);
      }
      return Promise.resolve([] as readonly TRow[]);
    };
    const { execution } = createSessionAdapter(executeCompiled);
    const batch = requireDefined(
      createSessionAtomicBatchAdapter(execution)?.executeAtomicBatch,
    );

    const failure = await batch([{ sql: "BROKEN", params: [] }]).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CompilerInvariantError);
    const failures = (failure as Error).cause;
    expect(failures).toBeInstanceOf(AggregateError);
    expect((failures as AggregateError).cause).toBe(refusal);
    expect((failures as AggregateError).errors).toEqual([
      refusal,
      recoveryFailure,
    ]);
    expect(statements).toEqual([
      "SAVEPOINT typegraph_atomic_program",
      "BROKEN",
      "ROLLBACK TO SAVEPOINT typegraph_atomic_program",
    ]);
  });

  it("returns an empty program without opening a savepoint or queue slot", async () => {
    const executeCompiled = vi.fn().mockResolvedValue([]);
    const { execution, exclusiveCalls } = createSessionAdapter(executeCompiled);
    const batch = requireDefined(
      createSessionAtomicBatchAdapter(execution)?.executeAtomicBatch,
    );

    await expect(batch([])).resolves.toEqual([]);
    expect(exclusiveCalls()).toBe(0);
    expect(executeCompiled).not.toHaveBeenCalled();
  });
});
