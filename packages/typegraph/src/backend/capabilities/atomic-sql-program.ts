/**
 * Internal execution boundary for a closed, precompiled SQL write program.
 *
 * This is deliberately an out-of-band root capability. An author registers
 * the exact root backend object after its transport has earned the root
 * execution declaration; derived backends and transaction backends do not
 * inherit the registration. A static batch is therefore never confused with
 * an interactive transaction or forwarded through a wrapper whose behavior
 * has not been audited for the program contract.
 */
import { CompilerInvariantError, ConfigurationError } from "../../errors";
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

/** The transport forms accepted by an atomic program author. */
export type AtomicSqlProgramRegistration =
  AtomicSqlBatchExecutor | AtomicSqlProgramAdapter;

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

function isAtomicSqlResultSlots(
  value: unknown,
): value is readonly (readonly AtomicSqlRow[])[] {
  return Array.isArray(value) && value.every((slot) => Array.isArray(slot));
}

/** Executes the one canonical closed-program protocol. */
async function executeAtomicSqlProgram<TRowResult, TResult>(
  executeAtomicBatch: AtomicSqlBatchExecutor,
  program: AtomicSqlProgram<TRowResult, TResult>,
): Promise<TResult> {
  if (program.slots.length === 0) return program.assemble([]);

  const statements = program.slots.map((slot) => slot.statement);
  const result: unknown = await executeAtomicBatch<AtomicSqlRow>(statements);
  if (!isAtomicSqlResultSlots(result)) {
    throw new CompilerInvariantError(
      "Atomic SQL program executor returned malformed result slots.",
      { resultType: typeof result },
    );
  }
  const rows = result;

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
  return typeof executeAtomicBatch === "function" ?
      createExecutor(executeAtomicBatch)
    : undefined;
}

function normalizeAtomicSqlProgramRegistration(
  registration: AtomicSqlProgramRegistration,
): AtomicSqlProgramExecutor | undefined {
  const adapter: AtomicSqlProgramAdapter =
    typeof registration === "function" ?
      { executeAtomicBatch: registration }
    : registration;
  return createAtomicSqlProgramExecutor(adapter);
}

function throwAtomicSqlProgramRegistrationMismatch(
  declaration: GraphBackend["capabilities"]["execution"]["atomicBatch"],
  registration: AtomicSqlProgramExecutor | undefined,
): never {
  throw new ConfigurationError(
    'An atomic SQL program requires `capabilities.execution.atomicBatch: "root"` and a usable atomic batch executor.',
    {
      code: "ATOMIC_SQL_PROGRAM_REGISTRATION_MISMATCH",
      declared: declaration,
      registered: registration !== undefined,
    },
    {
      suggestion:
        'Declare `capabilities.execution.atomicBatch: "root"` only on an exact root backend whose executor submits the complete statement sequence atomically.',
    },
  );
}

/**
 * Registers an atomic SQL program executor for one exact GraphBackend root.
 *
 * The declaration and executable transport are checked together so a backend
 * cannot claim root atomic execution while omitting the executor, nor expose
 * an executor without declaring the session on which it is valid. The
 * registration is keyed by object identity; derived and transaction-scoped
 * backends therefore do not resolve this root-only program.
 */
export function registerAtomicSqlProgram<T extends GraphBackend>(
  target: T,
  registration: AtomicSqlProgramRegistration,
): T {
  const executor = normalizeAtomicSqlProgramRegistration(registration);
  const declaration = target.capabilities.execution.atomicBatch;
  if (declaration !== "root" || executor === undefined) {
    throwAtomicSqlProgramRegistrationMismatch(declaration, executor);
  }
  ROOT_ATOMIC_SQL_PROGRAM_EXECUTORS.set(target, executor);
  return target;
}

/**
 * Resolves the static program executor for an exact registered root.
 * Transaction-scoped and derived/projected backends return `undefined`.
 */
export function resolveAtomicSqlProgramExecutor(
  target: GraphBackend | TransactionBackend,
): AtomicSqlProgramExecutor | undefined {
  return ROOT_ATOMIC_SQL_PROGRAM_EXECUTORS.get(target);
}

/** Returns whether this exact object owns a registered atomic SQL transport. */
export function hasAtomicSqlProgramRegistration(
  target: GraphBackend | TransactionBackend,
): boolean {
  return ROOT_ATOMIC_SQL_PROGRAM_EXECUTORS.has(target);
}
