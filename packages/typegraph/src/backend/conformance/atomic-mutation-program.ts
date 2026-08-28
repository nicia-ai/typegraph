/**
 * Framework-agnostic conformance checks for semantic mutation programs.
 *
 * Transport conformance proves that a backend can dispatch a closed SQL
 * program atomically. This runner proves the next boundary: each registered
 * TypeGraph mutation family preserves its Store-visible result, schema fence,
 * refusal, rollback, and exact-root contracts. Backend authors supply real
 * Store operations and database observers; the runner owns the required case
 * inventory and every verdict.
 */
import { TypeGraphError } from "../../errors";
import {
  type AtomicMutationProgramExecutor,
  hasAtomicMutationProgramRegistration,
  resolveAtomicMutationPrograms,
} from "../capabilities/atomic-mutation-program";
import { projectGraphBackend } from "../derive-backend";
import type { GraphBackend } from "../types";
import {
  assertExactRootRegistrationProvenance,
  type ExactRootRegistrationProvenanceChecks,
} from "./exact-root-provenance";

/** Every independently provable semantic variant in a mutation profile. */
export const ATOMIC_MUTATION_PROGRAM_VARIANTS = [
  "createNodes",
  "createEdges",
  "deleteNodes",
  "deleteEdges",
  "updateNodes",
  "updateEdges",
  "mutateNodes",
  "mutateEdges.resolvedSet",
  "mutateEdges.durableConvergence",
] as const;

/** One independently provable semantic variant in a mutation profile. */
export type AtomicMutationProgramVariant =
  (typeof ATOMIC_MUTATION_PROGRAM_VARIANTS)[number];

/** Independently derived success oracles returned by fixture preparation. */
export type AtomicMutationProgramConformancePreparation = Readonly<{
  expectedResult: unknown;
  expectedState: unknown;
}>;

/** Independently derived no-write oracle returned by fixture preparation. */
export type AtomicMutationProgramRefusalPreparation = Readonly<{
  expectedState: unknown;
}>;

/** One successful Store operation and its independent state observers. */
export type AtomicMutationProgramSuccessCase = Readonly<{
  /** Establishes isolated state and returns independently derived oracles. */
  prepare: () =>
    | AtomicMutationProgramConformancePreparation
    | PromiseLike<AtomicMutationProgramConformancePreparation>;
  /** Resolves the exact registered backend root used by this case. */
  resolveBackend: () => GraphBackend;
  /** Invokes the public Store operation whose registered family is claimed. */
  execute: () => unknown;
  /** Reads committed database state without trusting the returned postimages. */
  observeState: () => unknown;
  /** Counts invocations of the exact registered semantic executor. */
  observeDispatchCount: () => number | PromiseLike<number>;
}>;

/** One refusing Store operation and its independent state observers. */
export type AtomicMutationProgramRefusalCase = Readonly<{
  /** Establishes isolated state and returns its no-write oracle. */
  prepare: () =>
    | AtomicMutationProgramRefusalPreparation
    | PromiseLike<AtomicMutationProgramRefusalPreparation>;
  /** Resolves the exact registered backend root used by this case. */
  resolveBackend: () => GraphBackend;
  /** Invokes the public Store operation that must refuse atomically. */
  execute: () => unknown;
  /** Reads committed database state after the refusal. */
  observeState: () => unknown;
  /** Counts invocations of the exact registered semantic executor. */
  observeDispatchCount: () => number | PromiseLike<number>;
  /** Matches the Store-level typed error, never a driver sentinel alone. */
  errorMatches: (error: unknown) => boolean;
}>;

/** The three mandatory checks for one semantic mutation variant. */
export type AtomicMutationProgramConformanceCase = Readonly<{
  variant: AtomicMutationProgramVariant;
  /** Proves ordered results and independently observed committed state. */
  orderedSuccess: AtomicMutationProgramSuccessCase;
  /** Proves a stale schema fence cannot leave any write behind. */
  staleFenceNoWrite: AtomicMutationProgramRefusalCase;
  /** Proves the family's semantic refusal rolls back every sibling write. */
  semanticRefusalRollback: AtomicMutationProgramRefusalCase;
}>;

/** Complete caller-owned fixture for the framework-agnostic runner. */
export type AtomicMutationProgramConformanceFixture = Readonly<{
  /** A representative exact root registered by the backend factory. */
  backend: GraphBackend;
  equal: (actual: unknown, expected: unknown) => boolean;
  cases: readonly AtomicMutationProgramConformanceCase[];
}>;

/** Passed checks grouped by semantic variant and exact-root provenance. */
export type AtomicMutationProgramConformanceReport = Readonly<{
  variants: readonly Readonly<{
    variant: AtomicMutationProgramVariant;
    passed: readonly string[];
  }>[];
  provenance: readonly string[];
}>;

/** A failed semantic mutation program conformance verdict. */
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

const VARIANTS_BY_FAMILY = {
  createNodes: ["createNodes"],
  createEdges: ["createEdges"],
  deleteNodes: ["deleteNodes"],
  deleteEdges: ["deleteEdges"],
  updateNodes: ["updateNodes"],
  updateEdges: ["updateEdges"],
  mutateNodes: ["mutateNodes"],
  mutateEdges: ["mutateEdges.resolvedSet", "mutateEdges.durableConvergence"],
} as const satisfies Readonly<
  Record<
    keyof AtomicMutationProgramExecutor,
    readonly AtomicMutationProgramVariant[]
  >
>;

const ATOMIC_MUTATION_PROGRAM_FAMILIES = Object.keys(
  VARIANTS_BY_FAMILY,
) as readonly (keyof typeof VARIANTS_BY_FAMILY)[];

function expectedVariants(
  registration: AtomicMutationProgramExecutor,
): readonly AtomicMutationProgramVariant[] {
  const variants: AtomicMutationProgramVariant[] = [];
  for (const family of ATOMIC_MUTATION_PROGRAM_FAMILIES) {
    if (family === "updateNodes") {
      if ((registration.updateNodes?.maxEntries ?? 0) > 0) {
        variants.push("updateNodes");
      }
      continue;
    }
    if (family === "updateEdges") {
      if ((registration.updateEdges?.maxEntries ?? 0) > 0) {
        variants.push("updateEdges");
      }
      continue;
    }
    if (family === "mutateNodes") {
      if ((registration.mutateNodes?.maxEntries ?? 0) > 0) {
        variants.push("mutateNodes");
      }
      continue;
    }
    if (family === "mutateEdges") {
      const executor = registration.mutateEdges;
      if (executor === undefined) continue;
      if (executor.maxEntries.resolvedSet > 0) {
        variants.push("mutateEdges.resolvedSet");
      }
      if (executor.maxEntries.durableConvergence > 0) {
        variants.push("mutateEdges.durableConvergence");
      }
      continue;
    }
    if (registration[family] === undefined) continue;
    variants.push(...VARIANTS_BY_FAMILY[family]);
  }
  return variants;
}

function assertCaseBackendMatchesProfile(
  fixtureBackend: GraphBackend,
  profile: AtomicMutationProgramExecutor,
  backend: GraphBackend,
  variant: AtomicMutationProgramVariant,
  check: string,
): void {
  const registered = resolveAtomicMutationPrograms(backend);
  if (backend === fixtureBackend && registered === profile) {
    return;
  }
  throw new AtomicMutationProgramConformanceError(
    `Atomic mutation program conformance case is not bound to the exact registered ${variant} root during ${check}.`,
    { variant, check },
  );
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

function assertDispatched(
  before: number,
  after: number,
  variant: AtomicMutationProgramVariant,
  check: string,
): void {
  if (
    Number.isSafeInteger(before) &&
    Number.isSafeInteger(after) &&
    after > before
  ) {
    return;
  }
  throw new AtomicMutationProgramConformanceError(
    `Atomic mutation program conformance did not dispatch ${variant} during ${check}.`,
    { variant, check, before, after },
  );
}

async function runSuccessCase(
  fixture: AtomicMutationProgramConformanceFixture,
  variant: AtomicMutationProgramVariant,
  conformanceCase: AtomicMutationProgramSuccessCase,
): Promise<void> {
  const expected = await conformanceCase.prepare();
  assertCaseBackendMatchesProfile(
    fixture.backend,
    fixtureProfile(fixture),
    conformanceCase.resolveBackend(),
    variant,
    "ordered success",
  );
  const before = await conformanceCase.observeDispatchCount();
  const result = await conformanceCase.execute();
  const after = await conformanceCase.observeDispatchCount();
  assertDispatched(before, after, variant, "ordered success");
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
  variant: AtomicMutationProgramVariant,
  check: string,
  conformanceCase: AtomicMutationProgramRefusalCase,
): Promise<void> {
  const expected = await conformanceCase.prepare();
  assertCaseBackendMatchesProfile(
    fixture.backend,
    fixtureProfile(fixture),
    conformanceCase.resolveBackend(),
    variant,
    check,
  );
  const before = await conformanceCase.observeDispatchCount();
  let refusal: unknown;
  try {
    await conformanceCase.execute();
  } catch (error) {
    refusal = error;
  }
  const after = await conformanceCase.observeDispatchCount();
  assertDispatched(before, after, variant, check);
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

/**
 * Runs every mandatory semantic check for the profile the backend registers.
 *
 * Zero entry limits are honest opt-outs and therefore do not require an
 * unreachable case. Any positive registered variant requires exactly one
 * case, while a case for an unregistered variant is refused as misleading.
 */
export async function runAtomicMutationProgramConformance(
  fixture: AtomicMutationProgramConformanceFixture,
): Promise<AtomicMutationProgramConformanceReport> {
  const profile = fixtureProfile(fixture);
  const required = expectedVariants(profile);
  const indexedCases = indexCases(fixture.cases);
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

  const provenance = await assertExactRootRegistrationProvenance(
    {
      exactRootRegistration: () =>
        hasAtomicMutationProgramRegistration(fixture.backend),
      derivedBackendIsolation: () =>
        !hasAtomicMutationProgramRegistration(
          projectGraphBackend(fixture.backend),
        ),
      transactionBackendIsolation: () => {
        if (!fixture.backend.capabilities.execution.interactiveTransactions) {
          return true;
        }
        return fixture.backend.transaction((transaction) =>
          Promise.resolve(!hasAtomicMutationProgramRegistration(transaction)),
        );
      },
    } satisfies ExactRootRegistrationProvenanceChecks,
    (name) =>
      new AtomicMutationProgramConformanceError(
        `Atomic mutation program provenance check failed: ${name}.`,
        { check: name },
      ),
  );

  const variants: AtomicMutationProgramConformanceReport["variants"][number][] =
    [];
  for (const variant of required) {
    const conformanceCase = indexedCases.get(variant);
    if (conformanceCase === undefined) continue;
    await runSuccessCase(fixture, variant, conformanceCase.orderedSuccess);
    await runRefusalCase(
      fixture,
      variant,
      "stale fence",
      conformanceCase.staleFenceNoWrite,
    );
    await runRefusalCase(
      fixture,
      variant,
      "semantic refusal",
      conformanceCase.semanticRefusalRollback,
    );
    variants.push({
      variant,
      passed: [
        "ordered result and committed state",
        "stale fence no-write",
        "semantic refusal rollback",
      ],
    });
  }

  return { variants, provenance };
}
