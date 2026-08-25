/**
 * Internal execution boundary for a closed, precompiled SQL write program.
 *
 * This is deliberately an out-of-band root capability. The exact bundled
 * backend object is marked by its factory; derived backends and transaction
 * backends do not inherit the mark. A static batch is therefore never
 * confused with an interactive transaction or forwarded through a wrapper
 * whose behavior has not been audited for the program contract.
 */
import { CompilerInvariantError } from "../../errors";
import type { GraphBackend, TransactionBackend } from "../types";

export type AtomicSqlRow = Readonly<Record<string, unknown>>;

/** A transport-ready statement in the portable atomic-program protocol. */
export type CompiledAtomicSqlStatement = Readonly<{
  params: readonly unknown[];
  sql: string;
}>;

/** A native all-or-nothing dispatch for a closed statement sequence. */
export type AtomicSqlBatchExecutor = <TRow>(
  statements: readonly CompiledAtomicSqlStatement[],
) => Promise<readonly (readonly TRow[])[]>;

export type AtomicSqlProgramAdapter = Readonly<{
  executeAtomicBatch?: AtomicSqlBatchExecutor;
}>;

type AtomicSqlResultCardinality = "none" | "one" | "many";

/** One closed statement and the typed decoder for its result slot. */
type AtomicSqlProgramSlot<TResult> = Readonly<{
  statement: CompiledAtomicSqlStatement;
  cardinality: AtomicSqlResultCardinality;
  decode: (rows: readonly AtomicSqlRow[]) => TResult;
}>;

/**
 * A statically closed program. Every slot uses the same result union so a
 * heterogeneous node/edge program can still preserve a typed result at the
 * program boundary without introducing `any` into the erased executor.
 */
export type AtomicSqlProgram<TRowResult, TResult> = Readonly<{
  slots: readonly AtomicSqlProgramSlot<TRowResult>[];
  assemble: (results: readonly TRowResult[]) => TResult;
}>;

export type AtomicSqlProgramExecutor = Readonly<{
  execute: <TRowResult, TResult>(
    program: AtomicSqlProgram<TRowResult, TResult>,
  ) => Promise<TResult>;
}>;

const ROOT_ATOMIC_SQL_PROGRAM_EXECUTORS = new WeakMap<
  object,
  AtomicSqlProgramExecutor
>();

function assertResultCardinality(
  slot: Readonly<{ cardinality: AtomicSqlResultCardinality }>,
  index: number,
  rows: readonly AtomicSqlRow[],
): void {
  const valid =
    slot.cardinality === "none" ? rows.length === 0
    : slot.cardinality === "one" ? rows.length === 1
    : true;
  if (valid) return;
  throw new CompilerInvariantError(
    `Atomic SQL program slot ${index} returned ${rows.length} rows, ` +
      `expected ${slot.cardinality}.`,
    {
      slot: index,
      cardinality: slot.cardinality,
      rowCount: rows.length,
    },
  );
}

function assertResultSlotCount(
  expected: number,
  actual: readonly (readonly AtomicSqlRow[])[],
): void {
  if (expected === actual.length) return;
  throw new CompilerInvariantError(
    `Atomic SQL program returned ${actual.length} result slots, ` +
      `expected ${expected}.`,
    { expected, actual: actual.length },
  );
}

/** Executes the one canonical closed-program protocol. */
async function executeAtomicSqlProgram<TRowResult, TResult>(
  executeAtomicBatch: AtomicSqlBatchExecutor,
  program: AtomicSqlProgram<TRowResult, TResult>,
): Promise<TResult> {
  if (program.slots.length === 0) return program.assemble([]);

  const statements = program.slots.map((slot) => slot.statement);
  const rows = await executeAtomicBatch<AtomicSqlRow>(statements);

  assertResultSlotCount(program.slots.length, rows);
  const decoded = program.slots.map((slot, index) => {
    const slotRows = rows[index];
    if (slotRows === undefined) {
      throw new CompilerInvariantError(
        `Atomic SQL program result slot ${index} is missing.`,
        { slot: index },
      );
    }
    assertResultCardinality(slot, index, slotRows);
    return slot.decode(slotRows);
  });

  return program.assemble(decoded);
}

function createExecutor(
  executeAtomicBatch: AtomicSqlBatchExecutor,
): AtomicSqlProgramExecutor {
  return {
    async execute<TRowResult, TResult>(
      program: AtomicSqlProgram<TRowResult, TResult>,
    ): Promise<TResult> {
      return executeAtomicSqlProgram(executeAtomicBatch, program);
    },
  };
}

/** @internal Creates the executor shared by lowering and root registration. */
export function createAtomicSqlProgramExecutor(
  adapter: AtomicSqlProgramAdapter,
): AtomicSqlProgramExecutor | undefined {
  const executeAtomicBatch = adapter.executeAtomicBatch;
  return executeAtomicBatch === undefined ? undefined : (
      createExecutor(executeAtomicBatch)
    );
}

/** @internal Called only by bundled root backend factories. */
export function markBundledRootAtomicSqlProgram<T extends object>(
  target: T,
  executor: AtomicSqlProgramExecutor | undefined,
): T {
  ROOT_ATOMIC_SQL_PROGRAM_EXECUTORS.delete(target);
  if (executor !== undefined) {
    ROOT_ATOMIC_SQL_PROGRAM_EXECUTORS.set(target, executor);
  }
  return target;
}

/**
 * Resolves the static program executor for an exact bundled root.
 * Transaction-scoped and derived/projected backends return `undefined`.
 */
export function resolveBundledRootAtomicSqlProgramExecutor(
  target: GraphBackend | TransactionBackend,
): AtomicSqlProgramExecutor | undefined {
  return ROOT_ATOMIC_SQL_PROGRAM_EXECUTORS.get(target);
}
