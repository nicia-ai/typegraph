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
import { TypeGraphError } from "../../errors";
import {
  type AtomicSqlBatchExecutor,
  type AtomicSqlRow,
  type CompiledAtomicSqlStatement,
  hasAtomicSqlProgramRegistration,
  resolveRegisteredAtomicSqlBatchExecutor,
} from "../capabilities/atomic-sql-program";
import type { GraphBackend } from "../types";
import {
  assertExactRootRegistrationProvenance,
  type ExactRootRegistrationProvenanceFixture,
} from "./exact-root-provenance";

export type AtomicTransportEquality = (
  actual: unknown,
  expected: unknown,
) => boolean;

export type AtomicTransportRollbackCase<TSnapshot> = Readonly<{
  /** Prepare the baseline state that the failing program must preserve. */
  prepare: () => void | PromiseLike<void>;
  statements: readonly CompiledAtomicSqlStatement[];
  observe: () => TSnapshot | PromiseLike<TSnapshot>;
  expectedBefore: TSnapshot;
  /** Optional check for the backend's native error shape. */
  errorMatches?: (error: unknown) => boolean;
}>;

export type AtomicTransportConformanceFixture<TSnapshot = unknown> = Readonly<{
  /** Exact root that registered the batch function under test. */
  backend: GraphBackend;
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
    /** An independent snapshot of the exact sequence the transport must see. */
    expected: readonly CompiledAtomicSqlStatement[];
    /** Observe the sequence received by the engine-specific transport. */
    observe: () =>
      | readonly CompiledAtomicSqlStatement[]
      | undefined
      | PromiseLike<readonly CompiledAtomicSqlStatement[] | undefined>;
  }>;
  /** A later failure must roll back both the primary row and its sidecar. */
  rollback: AtomicTransportRollbackCase<TSnapshot>;
  /** Empty programs are successful no-ops and return no result slots. */
  emptyBatch: Readonly<{
    prepare?: () => void | PromiseLike<void>;
    observe: () => TSnapshot | PromiseLike<TSnapshot>;
    expected: TSnapshot;
  }>;
}> &
  ExactRootRegistrationProvenanceFixture;

export type AtomicTransportConformanceReport = Readonly<{
  passed: readonly string[];
  skipped: readonly string[];
}>;

export class AtomicTransportConformanceError extends TypeGraphError {
  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, "ATOMIC_TRANSPORT_CONFORMANCE_ERROR", {
      category: "system",
      details,
    });
    this.name = "AtomicTransportConformanceError";
  }
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

async function invoke(
  execute: AtomicSqlBatchExecutor,
  statements: readonly CompiledAtomicSqlStatement[],
): Promise<readonly (readonly AtomicSqlRow[])[]> {
  return execute<AtomicSqlRow>(statements);
}

/**
 * Runs the mandatory transport checks and exact-root provenance checks.
 *
 * This runner deliberately does not manufacture SQL or inspect a catalog.
 * The fixture owns those engine-specific details; the runner verifies the
 * transport protocol around them.
 */
export async function runAtomicTransportConformance<TSnapshot = unknown>(
  fixture: AtomicTransportConformanceFixture<TSnapshot>,
): Promise<AtomicTransportConformanceReport> {
  const passed: string[] = [];

  if (
    resolveRegisteredAtomicSqlBatchExecutor(fixture.backend) !==
    fixture.executeAtomicBatch
  ) {
    throw new AtomicTransportConformanceError(
      "Atomic transport conformance is not bound to the exact registered batch function.",
      { check: "registration binding" },
    );
  }

  const provenance = await assertExactRootRegistrationProvenance(
    fixture.backend,
    fixture,
    (target) => hasAtomicSqlProgramRegistration(target),
    (name) =>
      new AtomicTransportConformanceError(
        `Atomic transport provenance check failed: ${name}.`,
        { check: `provenance: ${name}` },
      ),
  );

  const orderedRows = await invoke(
    fixture.executeAtomicBatch,
    fixture.orderedResults.statements,
  );
  assertEqual(
    fixture.equal,
    orderedRows,
    fixture.orderedResults.expected,
    "ordered result slots",
  );
  passed.push("ordered result slots");

  await invoke(
    fixture.executeAtomicBatch,
    fixture.parameterPreservation.statements,
  );
  assertEqual(
    fixture.equal,
    await fixture.parameterPreservation.observe(),
    fixture.parameterPreservation.expected,
    "parameter preservation",
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
    await invoke(fixture.executeAtomicBatch, fixture.rollback.statements);
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
  assertEqual(fixture.equal, after, before, "later-statement rollback");
  passed.push("later-statement rollback");

  await fixture.emptyBatch.prepare?.();
  const emptyBefore = await fixture.emptyBatch.observe();
  assertEqual(
    fixture.equal,
    emptyBefore,
    fixture.emptyBatch.expected,
    "empty-batch precondition",
  );
  const emptyRows = await invoke(fixture.executeAtomicBatch, []);
  assertEqual(fixture.equal, emptyRows, [], "empty-batch result");
  const emptyAfter = await fixture.emptyBatch.observe();
  assertEqual(fixture.equal, emptyAfter, emptyBefore, "empty-batch no-op");
  passed.push(
    "empty batch",
    ...provenance.passed.map((name) => `provenance: ${name}`),
  );

  return {
    passed,
    skipped: provenance.skipped.map((name) => `provenance: ${name}`),
  };
}
