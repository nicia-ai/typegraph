import { describe, expect, it } from "vitest";

import {
  type AtomicSqlProgram,
  type AtomicSqlProgramAdapter,
  type AtomicSqlRow,
  registerAtomicSqlProgram,
  resolveAtomicSqlProgramExecutor,
} from "../src/backend/capabilities/atomic-sql-program";
import { deriveBackend, projectBackend } from "../src/backend/derive-backend";
import {
  type CompiledSqlQuery,
  type SqlExecutionAdapter,
} from "../src/backend/drizzle/execution/types";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";
import { CompilerInvariantError, ConfigurationError } from "../src/errors";

type TestResult = Readonly<{ value: number }>;

function createAdapter(
  executeAtomicBatch?: NonNullable<SqlExecutionAdapter["executeAtomicBatch"]>,
): SqlExecutionAdapter {
  return {
    compile: () => ({ sql: "TEST", params: [] }),
    execute: () => Promise.resolve([]),
    ...(executeAtomicBatch === undefined ? {} : { executeAtomicBatch }),
  };
}

function oneRowProgram(
  statements: readonly CompiledSqlQuery[],
): AtomicSqlProgram<TestResult, readonly TestResult[]> {
  return {
    slots: statements.map((statement) => ({
      statement,
      cardinality: "one",
      decode: (rows: readonly AtomicSqlRow[]): TestResult => ({
        value: Number(rows[0]?.["value"]),
      }),
    })),
    assemble: (results) => results,
  };
}

function oneRowBatch<TRow>(
  statements: readonly CompiledSqlQuery[],
): Promise<readonly (readonly TRow[])[]> {
  return Promise.resolve(
    statements.map((statement) => [
      { value: statement.params[0] },
    ]) as unknown as readonly (readonly TRow[])[],
  );
}

function oneValueBatch<TRow>(): Promise<readonly (readonly TRow[])[]> {
  return Promise.resolve([[{ value: 1 }] as unknown as readonly TRow[]]);
}

function noRowsBatch<TRow>(): Promise<readonly (readonly TRow[])[]> {
  return Promise.resolve([[] as readonly TRow[]]);
}

function createCountingBatch(): Readonly<{
  execute: NonNullable<SqlExecutionAdapter["executeAtomicBatch"]>;
  dispatches: () => number;
}> {
  let count = 0;
  return {
    execute: <TRow>(_statements: readonly CompiledSqlQuery[]) => {
      count += 1;
      return Promise.resolve([] as readonly (readonly TRow[])[]);
    },
    dispatches: () => count,
  };
}

function createRoot(): GraphBackend {
  return {
    capabilities: {
      execution: { atomicBatch: "root" },
    },
  } as GraphBackend;
}

function expectRegistrationMismatch(action: () => unknown): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigurationError);
  if (!(thrown instanceof ConfigurationError)) return;
  expect(thrown.details["code"]).toBe(
    "ATOMIC_SQL_PROGRAM_REGISTRATION_MISMATCH",
  );
}

describe("atomic SQL program executor", () => {
  it("dispatches closed slots through one native batch and decodes them", async () => {
    const calls: CompiledSqlQuery[][] = [];
    const executeAtomicBatch: NonNullable<
      SqlExecutionAdapter["executeAtomicBatch"]
    > = <TRow>(statements: readonly CompiledSqlQuery[]) => {
      calls.push([...statements]);
      return oneRowBatch<TRow>(statements);
    };
    const root = createRoot();
    registerAtomicSqlProgram(root, executeAtomicBatch);

    const executor = resolveAtomicSqlProgramExecutor(root);
    expect(executor).toBeDefined();
    if (executor === undefined) throw new Error("Expected root executor");

    const result = await executor.execute(
      oneRowProgram([
        { sql: "SELECT $1", params: [11] },
        { sql: "SELECT $1", params: [22] },
      ]),
    );

    expect(result).toEqual([{ value: 11 }, { value: 22 }]);
    expect(calls).toEqual([
      [
        { sql: "SELECT $1", params: [11] },
        { sql: "SELECT $1", params: [22] },
      ],
    ]);
  });

  it("enforces result-slot and per-slot cardinality contracts", async () => {
    const root = createRoot();
    const executeAtomicBatch: NonNullable<
      SqlExecutionAdapter["executeAtomicBatch"]
    > = oneValueBatch;
    registerAtomicSqlProgram(root, { executeAtomicBatch });
    const executor = resolveAtomicSqlProgramExecutor(root);
    if (executor === undefined) throw new Error("Expected root executor");

    await expect(
      executor.execute({
        slots: [
          {
            statement: { sql: "SELECT 1", params: [] },
            cardinality: "one",
            decode: () => ({ value: 1 }),
          },
          {
            statement: { sql: "SELECT 2", params: [] },
            cardinality: "one",
            decode: () => ({ value: 2 }),
          },
        ],
        assemble: (results) => results,
      }),
    ).rejects.toThrow(/returned 1 result slots, expected 2/);

    const emptyRowsRoot = createRoot();
    const emptyRowsExecutor: NonNullable<
      SqlExecutionAdapter["executeAtomicBatch"]
    > = noRowsBatch;
    registerAtomicSqlProgram(emptyRowsRoot, emptyRowsExecutor);
    const emptyRowsRootExecutor =
      resolveAtomicSqlProgramExecutor(emptyRowsRoot);
    if (emptyRowsRootExecutor === undefined) {
      throw new Error("Expected empty-row root executor");
    }
    await expect(
      emptyRowsRootExecutor.execute({
        slots: [
          {
            statement: { sql: "INSERT", params: [] },
            cardinality: "one",
            decode: () => ({ value: 1 }),
          },
        ],
        assemble: (results) => results,
      }),
    ).rejects.toThrow(/expected one/);
  });

  it("delegates bind validation and driver errors to the native adapter", async () => {
    const root = createRoot();
    const executeAtomicBatch: NonNullable<
      SqlExecutionAdapter["executeAtomicBatch"]
    > = <TRow>(statements: readonly CompiledSqlQuery[]) => {
      if (statements.some((statement) => statement.params.length > 1)) {
        return Promise.reject(new Error("driver bind limit"));
      }
      return Promise.resolve(
        statements.map(() => [{ value: 1 }] as unknown as readonly TRow[]),
      );
    };
    registerAtomicSqlProgram(root, executeAtomicBatch);
    const executor = resolveAtomicSqlProgramExecutor(root);
    if (executor === undefined) throw new Error("Expected root executor");

    await expect(
      executor.execute(
        oneRowProgram([{ sql: "SELECT $1, $2", params: [1, 2] }]),
      ),
    ).rejects.toThrow("driver bind limit");
  });

  it("does not inherit through derived backends or roots without native batch", () => {
    const root = createRoot();
    registerAtomicSqlProgram(root, createAdapter(oneValueBatch));
    expect(resolveAtomicSqlProgramExecutor(root)).toBeDefined();
    const derived = deriveBackend(root, {});
    expect(derived.capabilities.execution.atomicBatch).toBe("none");
    expect(resolveAtomicSqlProgramExecutor(derived)).toBeUndefined();
    const projected = projectBackend(root, ["capabilities"]);
    expect(projected.capabilities.execution.atomicBatch).toBe("none");
    expect(
      resolveAtomicSqlProgramExecutor({} as TransactionBackend),
    ).toBeUndefined();

    const noBatch = createRoot();
    expectRegistrationMismatch(() => registerAtomicSqlProgram(noBatch, {}));
  });

  it("refuses a malformed adapter instead of recording unusable evidence", () => {
    const malformed = {
      executeAtomicBatch: "not a function",
    } as unknown as AtomicSqlProgramAdapter;

    expectRegistrationMismatch(() =>
      registerAtomicSqlProgram(createRoot(), malformed),
    );
  });

  it("refuses malformed executor results at the program boundary", async () => {
    const malformedBatch = (() =>
      Promise.resolve(undefined)) as unknown as NonNullable<
      SqlExecutionAdapter["executeAtomicBatch"]
    >;
    const root = createRoot();
    registerAtomicSqlProgram(root, malformedBatch);
    const executor = resolveAtomicSqlProgramExecutor(root);
    if (executor === undefined) throw new Error("Expected root executor");

    await expect(
      executor.execute(oneRowProgram([{ sql: "SELECT 1", params: [] }])),
    ).rejects.toBeInstanceOf(CompilerInvariantError);
  });

  it("requires the root atomic-batch declaration", () => {
    const undeclared = {
      capabilities: { execution: { atomicBatch: "none" } },
    } as GraphBackend;

    expectRegistrationMismatch(() =>
      registerAtomicSqlProgram(undeclared, oneValueBatch),
    );
    expect(() => registerAtomicSqlProgram(undeclared, oneValueBatch)).toThrow(
      /atomicBatch: "root"/,
    );
  });

  it("refuses to overwrite an exact root transport registration", () => {
    const root = createRoot();
    registerAtomicSqlProgram(root, oneValueBatch);

    let thrown: unknown;
    try {
      registerAtomicSqlProgram(root, noRowsBatch);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationError);
    if (!(thrown instanceof ConfigurationError)) return;
    expect(thrown.details["code"]).toBe(
      "ATOMIC_SQL_PROGRAM_ALREADY_REGISTERED",
    );
  });

  it("assembles an empty program without contacting the driver", async () => {
    const countingBatch = createCountingBatch();
    const root = createRoot();
    registerAtomicSqlProgram(root, countingBatch.execute);
    const executor = resolveAtomicSqlProgramExecutor(root);
    if (executor === undefined) throw new Error("Expected root executor");

    await expect(
      executor.execute({ slots: [], assemble: (results) => results.length }),
    ).resolves.toBe(0);
    expect(countingBatch.dispatches()).toBe(0);
  });
});
