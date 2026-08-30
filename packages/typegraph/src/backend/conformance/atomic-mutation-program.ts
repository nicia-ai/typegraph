/** Framework-agnostic conformance checks for semantic mutation programs. */
import { TypeGraphError } from "../../errors";
import {
  type AtomicMutationProgramExecutor,
  type AtomicMutationProgramVariant,
  hasAtomicMutationProgramRegistration,
  reachableAtomicMutationProgramVariants,
  resolveAtomicMutationPrograms,
  withAtomicMutationProgramDispatchObserver,
} from "../capabilities/atomic-mutation-program";
import type { GraphBackend } from "../types";
import {
  assertExactRootRegistrationProvenance,
  type ExactRootRegistrationProvenanceFixture,
  type ExactRootRegistrationProvenanceReport,
} from "./exact-root-provenance";

export {
  ATOMIC_MUTATION_PROGRAM_VARIANTS,
  type AtomicMutationProgramVariant,
} from "../capabilities/atomic-mutation-program";

export type AtomicMutationProgramConformancePreparation = Readonly<{
  expectedResult: unknown;
  expectedState: unknown;
}>;
export type AtomicMutationProgramRefusalPreparation = Readonly<{
  expectedState: unknown;
}>;
export type AtomicMutationProgramSuccessCase = Readonly<{
  prepare: () =>
    | AtomicMutationProgramConformancePreparation
    | PromiseLike<AtomicMutationProgramConformancePreparation>;
  execute: () => unknown;
  observeState: () => unknown;
}>;
export type AtomicMutationProgramRefusalDispatch = "required" | "pre-dispatch";
export type AtomicMutationProgramRefusalCase = Readonly<{
  prepare: () =>
    | AtomicMutationProgramRefusalPreparation
    | PromiseLike<AtomicMutationProgramRefusalPreparation>;
  execute: () => unknown;
  observeState: () => unknown;
  errorMatches: (error: unknown) => boolean;
  /** Makes a legitimate Store-level precondition refusal explicit. */
  dispatch: AtomicMutationProgramRefusalDispatch;
}>;
export type AtomicMutationProgramConformanceCase = Readonly<{
  /** Exact root used by every callback in this case. */
  backend: GraphBackend;
  variant: AtomicMutationProgramVariant;
  orderedSuccess: AtomicMutationProgramSuccessCase;
  staleFenceNoWrite: AtomicMutationProgramRefusalCase &
    Readonly<{ dispatch: "required" }>;
  semanticRefusalRollback: AtomicMutationProgramRefusalCase;
}>;
export type AtomicMutationProgramConformanceFixture = Readonly<{
  /** Exact root reserved exclusively for this conformance run. */
  backend: GraphBackend;
  equal: (actual: unknown, expected: unknown) => boolean;
  cases: readonly AtomicMutationProgramConformanceCase[];
}> &
  ExactRootRegistrationProvenanceFixture;
export type AtomicMutationProgramConformanceReport = Readonly<{
  variants: readonly Readonly<{
    variant: AtomicMutationProgramVariant;
    passed: readonly string[];
  }>[];
  provenance: ExactRootRegistrationProvenanceReport;
}>;

export class AtomicMutationProgramConformanceError extends TypeGraphError {
  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, "ATOMIC_MUTATION_PROGRAM_CONFORMANCE_ERROR", {
      category: "system",
      details,
    });
    this.name = "AtomicMutationProgramConformanceError";
  }
}

type DispatchCounts = ReadonlyMap<AtomicMutationProgramVariant, number>;

function countDispatches(
  counts: DispatchCounts,
  variant: AtomicMutationProgramVariant,
): number {
  return counts.get(variant) ?? 0;
}

function assertEqual(
  fixture: AtomicMutationProgramConformanceFixture,
  actual: unknown,
  expected: unknown,
  variant: AtomicMutationProgramVariant,
  check: string,
): void {
  if (fixture.equal(actual, expected)) return;
  throw new AtomicMutationProgramConformanceError(
    `Atomic mutation program conformance check failed: ${variant} ${check}.`,
    { variant, check, actual, expected },
  );
}

function assertDispatchVerdict(
  before: number,
  after: number,
  expected: AtomicMutationProgramRefusalDispatch,
  variant: AtomicMutationProgramVariant,
  check: string,
): void {
  const matched = expected === "required" ? after > before : after === before;
  if (matched) return;
  throw new AtomicMutationProgramConformanceError(
    expected === "required" ?
      `Atomic mutation program conformance did not dispatch ${variant} during ${check}.`
    : `Atomic mutation program conformance unexpectedly dispatched ${variant} during ${check}.`,
    { variant, check, before, after, expected },
  );
}

async function runSuccessCase(
  fixture: AtomicMutationProgramConformanceFixture,
  profile: AtomicMutationProgramExecutor,
  counts: DispatchCounts,
  variant: AtomicMutationProgramVariant,
  conformanceCase: AtomicMutationProgramSuccessCase,
): Promise<void> {
  assertProfileBinding(fixture, profile, variant);
  const expected = await conformanceCase.prepare();
  assertProfileBinding(fixture, profile, variant);
  const before = countDispatches(counts, variant);
  const result = await conformanceCase.execute();
  assertProfileBinding(fixture, profile, variant);
  const after = countDispatches(counts, variant);
  assertDispatchVerdict(before, after, "required", variant, "ordered success");
  assertEqual(
    fixture,
    result,
    expected.expectedResult,
    variant,
    "ordered result",
  );
  assertEqual(
    fixture,
    await conformanceCase.observeState(),
    expected.expectedState,
    variant,
    "committed state",
  );
}

async function runRefusalCase(
  fixture: AtomicMutationProgramConformanceFixture,
  profile: AtomicMutationProgramExecutor,
  counts: DispatchCounts,
  variant: AtomicMutationProgramVariant,
  check: string,
  conformanceCase: AtomicMutationProgramRefusalCase,
  expectedDispatch: AtomicMutationProgramRefusalDispatch,
): Promise<void> {
  assertProfileBinding(fixture, profile, variant);
  const expected = await conformanceCase.prepare();
  assertProfileBinding(fixture, profile, variant);
  const before = countDispatches(counts, variant);
  let refusal: unknown;
  try {
    await conformanceCase.execute();
  } catch (error) {
    refusal = error;
  }
  assertProfileBinding(fixture, profile, variant);
  const after = countDispatches(counts, variant);
  assertDispatchVerdict(before, after, expectedDispatch, variant, check);
  if (refusal === undefined || !conformanceCase.errorMatches(refusal)) {
    throw new AtomicMutationProgramConformanceError(
      `Atomic mutation program conformance returned an unexpected refusal for ${variant} ${check}.`,
      { variant, check, refusal },
    );
  }
  assertEqual(
    fixture,
    await conformanceCase.observeState(),
    expected.expectedState,
    variant,
    `${check} rollback`,
  );
}

function fixtureProfile(
  fixture: AtomicMutationProgramConformanceFixture,
): AtomicMutationProgramExecutor {
  const profile = resolveAtomicMutationPrograms(fixture.backend);
  if (profile !== undefined) return profile;
  throw new AtomicMutationProgramConformanceError(
    "Atomic mutation program conformance requires an exact registered backend root.",
    { check: "exact root registration" },
  );
}

function assertProfileBinding(
  fixture: AtomicMutationProgramConformanceFixture,
  profile: AtomicMutationProgramExecutor,
  variant: AtomicMutationProgramVariant,
): void {
  if (resolveAtomicMutationPrograms(fixture.backend) === profile) return;
  throw new AtomicMutationProgramConformanceError(
    `Atomic mutation program conformance lost its registered profile while proving ${variant}.`,
    { check: "profile binding", variant },
  );
}

function assertCaseBinding(
  fixture: AtomicMutationProgramConformanceFixture,
  conformanceCase: AtomicMutationProgramConformanceCase,
): void {
  if (conformanceCase.backend === fixture.backend) return;
  throw new AtomicMutationProgramConformanceError(
    `Atomic mutation program conformance case ${conformanceCase.variant} is bound to a different backend root.`,
    { check: "case binding", variant: conformanceCase.variant },
  );
}

function indexCases(
  cases: readonly AtomicMutationProgramConformanceCase[],
): ReadonlyMap<
  AtomicMutationProgramVariant,
  AtomicMutationProgramConformanceCase
> {
  const indexed = new Map<
    AtomicMutationProgramVariant,
    AtomicMutationProgramConformanceCase
  >();
  for (const conformanceCase of cases) {
    if (indexed.has(conformanceCase.variant)) {
      throw new AtomicMutationProgramConformanceError(
        `Atomic mutation program conformance received duplicate ${conformanceCase.variant} cases.`,
        { variant: conformanceCase.variant },
      );
    }
    indexed.set(conformanceCase.variant, conformanceCase);
  }
  return indexed;
}

function assertCompleteCaseInventory(
  required: readonly AtomicMutationProgramVariant[],
  indexedCases: ReadonlyMap<AtomicMutationProgramVariant, unknown>,
): void {
  for (const variant of required) {
    if (indexedCases.has(variant)) continue;
    throw new AtomicMutationProgramConformanceError(
      `Atomic mutation program conformance is missing the registered ${variant} case.`,
      { variant },
    );
  }
  for (const variant of indexedCases.keys()) {
    if (required.includes(variant)) continue;
    throw new AtomicMutationProgramConformanceError(
      `Atomic mutation program conformance received a case for unregistered ${variant}.`,
      { variant },
    );
  }
}

/** Runs every mandatory semantic check for the exact registered profile. */
export async function runAtomicMutationProgramConformance(
  fixture: AtomicMutationProgramConformanceFixture,
): Promise<AtomicMutationProgramConformanceReport> {
  // Finish every binding and inventory verdict before preparation can write.
  const profile = fixtureProfile(fixture);
  const required = reachableAtomicMutationProgramVariants(
    profile,
    fixture.backend.capabilities.execution,
  );
  const indexedCases = indexCases(fixture.cases);
  assertCompleteCaseInventory(required, indexedCases);
  for (const conformanceCase of indexedCases.values()) {
    assertCaseBinding(fixture, conformanceCase);
  }
  const provenance = await assertExactRootRegistrationProvenance(
    fixture.backend,
    fixture,
    (target) => hasAtomicMutationProgramRegistration(target),
    (name) =>
      new AtomicMutationProgramConformanceError(
        `Atomic mutation program provenance check failed: ${name}.`,
        { check: name },
      ),
    (target) => resolveAtomicMutationPrograms(target) === profile,
  );

  const dispatchCounts = new Map<AtomicMutationProgramVariant, number>();
  const variants = await withAtomicMutationProgramDispatchObserver(
    fixture.backend,
    (variant) => {
      dispatchCounts.set(variant, countDispatches(dispatchCounts, variant) + 1);
    },
    async () => {
      const reports: AtomicMutationProgramConformanceReport["variants"][number][] =
        [];
      for (const variant of required) {
        const conformanceCase = indexedCases.get(variant);
        if (conformanceCase === undefined) continue;
        await runSuccessCase(
          fixture,
          profile,
          dispatchCounts,
          variant,
          conformanceCase.orderedSuccess,
        );
        await runRefusalCase(
          fixture,
          profile,
          dispatchCounts,
          variant,
          "stale fence",
          conformanceCase.staleFenceNoWrite,
          "required",
        );
        await runRefusalCase(
          fixture,
          profile,
          dispatchCounts,
          variant,
          "semantic refusal",
          conformanceCase.semanticRefusalRollback,
          conformanceCase.semanticRefusalRollback.dispatch,
        );
        reports.push({
          variant,
          passed: [
            "ordered result and committed state",
            "stale fence no-write",
            conformanceCase.semanticRefusalRollback.dispatch === "required" ?
              "semantic refusal rollback after native dispatch"
            : "semantic refusal no-write before native dispatch",
          ],
        });
      }
      return reports;
    },
  );

  return { variants, provenance };
}
