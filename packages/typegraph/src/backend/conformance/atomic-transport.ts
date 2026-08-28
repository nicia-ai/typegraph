/**
 * Framework-agnostic conformance checks for atomic SQL transports.
 *
 * An atomic transport is stronger than an executor that happens to accept an
 * array of statements: it must preserve statement order and parameters,
 * return one result slot per statement, and leave no writes behind when a
 * later statement fails. Backend authors provide the small set of statements
 * and state observers needed to exercise those promises; this module owns the
 * checks and the failure vocabulary without depending on a test framework or
 * a database client.
 */
import type {
  AtomicSqlBatchExecutor,
  AtomicSqlRow,
  CompiledAtomicSqlStatement,
} from "../capabilities/atomic-sql-program";

type Awaitable<T> = T | PromiseLike<T>;

export type AtomicTransportEquality = (
  actual: unknown,
  expected: unknown,
) => boolean;

export type AtomicTransportRollbackCase<TSnapshot> = Readonly<{
  /** Prepare a primary row and its sidecar before the failing program. */
  prepare: () => Awaitable<void>;
  statements: readonly CompiledAtomicSqlStatement[];
  observe: () => Awaitable<TSnapshot>;
  expectedBefore: TSnapshot;
  /** Optional check for the backend's native error shape. */
  errorMatches?: (error: unknown) => boolean;
}>;

export type AtomicTransportConformanceFixture<TSnapshot = unknown> = Readonly<{
  executeAtomicBatch: AtomicSqlBatchExecutor;
  equal: AtomicTransportEquality;
  /** A multi-statement program whose result slots identify their positions. */
  orderedResults: Readonly<{
    statements: readonly CompiledAtomicSqlStatement[];
    expected: readonly (readonly AtomicSqlRow[])[];
  }>;
  /** A program whose SQL and bound values must reach the transport unchanged. */
  parameterPreservation: Readonly<{
    statements: readonly CompiledAtomicSqlStatement[];
    /** Observe the sequence received by the engine-specific transport. */
    observe: () => Awaitable<readonly CompiledAtomicSqlStatement[] | undefined>;
  }>;
  /** A later failure must roll back both the primary row and its sidecar. */
  rollback: AtomicTransportRollbackCase<TSnapshot>;
  /** Empty programs are successful no-ops and return no result slots. */
  emptyBatch: Readonly<{
    prepare?: () => Awaitable<void>;
    observe: () => Awaitable<TSnapshot>;
    expected: TSnapshot;
  }>;
  /**
   * Caller-supplied checks for exact-root registration and provenance.
   * Typical checks resolve a certified root, then assert that a derived or
   * transaction-scoped object does not inherit the registration.
   */
  provenance?: readonly AtomicTransportProvenanceCheck[];
}>;

export type AtomicTransportProvenanceCheck = Readonly<{
  name: string;
  check: () => Awaitable<boolean>;
}>;

export type AtomicTransportConformanceReport = Readonly<{
  passed: readonly string[];
}>;

export class AtomicTransportConformanceError extends Error {
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AtomicTransportConformanceError";
    this.details = details;
  }
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.hasOwn(right, key) && valuesEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function assertEqual(
  equal: AtomicTransportEquality,
  actual: unknown,
  expected: unknown,
  check: string,
): void {
  if (equal(actual, expected)) return;
  throw new AtomicTransportConformanceError(
    `Atomic transport conformance check failed: ${check}.`,
    { check, actual, expected },
  );
}

function assertStatementsEqual(
  actual: readonly CompiledAtomicSqlStatement[] | undefined,
  expected: readonly CompiledAtomicSqlStatement[],
): void {
  if (actual !== undefined && valuesEqual(actual, expected)) return;
  throw new AtomicTransportConformanceError(
    "Atomic transport did not preserve the submitted statement sequence.",
    { check: "parameter preservation", actual, expected },
  );
}

async function invoke(
  execute: AtomicSqlBatchExecutor,
  statements: readonly CompiledAtomicSqlStatement[],
): Promise<readonly (readonly AtomicSqlRow[])[]> {
  return execute<AtomicSqlRow>(statements);
}

/**
 * Runs the mandatory transport checks and caller-supplied provenance checks.
 *
 * This runner deliberately does not manufacture SQL or inspect a catalog.
 * The fixture owns those engine-specific details; the runner verifies the
 * transport protocol around them.
 */
export async function runAtomicTransportConformance<TSnapshot = unknown>(
  fixture: AtomicTransportConformanceFixture<TSnapshot>,
): Promise<AtomicTransportConformanceReport> {
  const execute: AtomicSqlBatchExecutor = async <TRow>(
    statements: readonly CompiledAtomicSqlStatement[],
  ) =>
    fixture.executeAtomicBatch<TRow>(statements);
  const passed: string[] = [];

  const orderedRows = await invoke(execute, fixture.orderedResults.statements);
  assertEqual(
    fixture.equal,
    orderedRows,
    fixture.orderedResults.expected,
    "ordered result slots",
  );
  passed.push("ordered result slots");

  const expectedStatements = structuredClone(
    fixture.parameterPreservation.statements,
  );
  await invoke(execute, fixture.parameterPreservation.statements);
  assertStatementsEqual(
    await fixture.parameterPreservation.observe(),
    expectedStatements,
  );
  passed.push("parameter preservation");

  await fixture.rollback.prepare();
  const before = await fixture.rollback.observe();
  assertEqual(
    fixture.equal,
    before,
    fixture.rollback.expectedBefore,
    "rollback precondition",
  );
  let rollbackError: unknown;
  try {
    await invoke(execute, fixture.rollback.statements);
  } catch (error) {
    rollbackError = error;
  }
  if (rollbackError === undefined) {
    throw new AtomicTransportConformanceError(
      "Atomic transport accepted a program that must fail during rollback conformance.",
      { check: "later-statement rollback" },
    );
  }
  if (
    fixture.rollback.errorMatches !== undefined &&
    !fixture.rollback.errorMatches(rollbackError)
  ) {
    throw new AtomicTransportConformanceError(
      "Atomic transport returned an unexpected rollback error.",
      { check: "later-statement rollback", error: rollbackError },
    );
  }
  const after = await fixture.rollback.observe();
  assertEqual(
    fixture.equal,
    after,
    before,
    "later-statement rollback",
  );
  passed.push("later-statement rollback");

  await fixture.emptyBatch.prepare?.();
  const emptyBefore = await fixture.emptyBatch.observe();
  assertEqual(
    fixture.equal,
    emptyBefore,
    fixture.emptyBatch.expected,
    "empty-batch precondition",
  );
  const emptyRows = await invoke(execute, []);
  assertEqual(fixture.equal, emptyRows, [], "empty-batch result");
  const emptyAfter = await fixture.emptyBatch.observe();
  assertEqual(
    fixture.equal,
    emptyAfter,
    fixture.emptyBatch.expected,
    "empty-batch no-op",
  );
  passed.push("empty batch");

  for (const provenance of fixture.provenance ?? []) {
    if (await provenance.check()) {
      passed.push(`provenance: ${provenance.name}`);
      continue;
    }
    throw new AtomicTransportConformanceError(
      `Atomic transport provenance check failed: ${provenance.name}.`,
      { check: `provenance: ${provenance.name}` },
    );
  }

  return { passed };
}
