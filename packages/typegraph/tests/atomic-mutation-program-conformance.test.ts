import { describe, expect, it, vi } from "vitest";

import {
  ATOMIC_EDGE_MUTATION_VARIANT_BY_KIND,
  type AtomicEdgeMutationProgramExecutor,
  type AtomicMutationProgramRegistration,
  type AtomicMutationProgramVariant,
  type AtomicNodeBatchExecutor,
  type AtomicNodeResolvedMutationSetExecutor,
  type AtomicNodeResolvedUpdateBatchExecutor,
  markBundledRootAtomicMutationPrograms,
  resolveAtomicMutationPrograms,
} from "../src/backend/capabilities/atomic-mutation-program";
import {
  type AtomicMutationProgramConformanceCase,
  AtomicMutationProgramConformanceError,
  type AtomicMutationProgramRefusalCase,
  runAtomicMutationProgramConformance,
} from "../src/backend/conformance/atomic-mutation-program";
import { assertExactRootRegistrationProvenance } from "../src/backend/conformance/exact-root-provenance";
import { deriveBackend } from "../src/backend/derive-backend";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";
import { requireDefined } from "../src/utils/presence";

class ExpectedRefusal extends Error {}

type UnboundConformanceCase = Omit<
  AtomicMutationProgramConformanceCase,
  "backend"
>;

function callableWithLimit<T>(limit: number): T {
  return Object.assign(() => Promise.resolve([]), { maxEntries: limit }) as T;
}

function edgeMutationExecutor(
  maxEntries?: AtomicEdgeMutationProgramExecutor["maxEntries"],
): AtomicEdgeMutationProgramExecutor {
  return Object.assign(() => Promise.resolve([]), {
    maxEntries: maxEntries ?? { durableConvergence: 1, resolvedSet: 1 },
  }) as unknown as AtomicEdgeMutationProgramExecutor;
}

function completeRegistration(): AtomicMutationProgramRegistration {
  const createNodes = (() =>
    Promise.resolve([])) as unknown as AtomicNodeBatchExecutor;
  return {
    createNodes,
    createEdges: (() => Promise.resolve([])) as never,
    deleteNodes: () =>
      Promise.resolve({ affectedCount: 0, schemaFenceMatched: true }),
    deleteEdges: () =>
      Promise.resolve({ affectedCount: 0, schemaFenceMatched: true }),
    updateNodes: callableWithLimit<AtomicNodeResolvedUpdateBatchExecutor>(1),
    updateEdges: callableWithLimit(1),
    mutateNodes: callableWithLimit<AtomicNodeResolvedMutationSetExecutor>(1),
    mutateEdges: edgeMutationExecutor(),
  };
}

function createProfileBackend(
  registration: AtomicMutationProgramRegistration,
  interactiveTransactions = false,
): GraphBackend {
  const backend = {
    capabilities: {
      execution: { atomicBatch: "root", interactiveTransactions },
    },
    ...(interactiveTransactions ?
      {
        transaction: <TResult>(
          run: (transaction: TransactionBackend) => Promise<TResult>,
        ) =>
          run({
            capabilities: {
              execution: {
                atomicBatch: "none",
                interactiveTransactions: true,
              },
            },
          } as TransactionBackend),
      }
    : {}),
  } as unknown as GraphBackend;
  return markBundledRootAtomicMutationPrograms(backend, registration);
}

async function dispatchVariant(
  backend: GraphBackend,
  variant: AtomicMutationProgramVariant,
): Promise<void> {
  const profile = resolveAtomicMutationPrograms(backend);
  const family = variant.split(".")[0] as keyof NonNullable<typeof profile>;
  const executor = profile?.[family];
  if (executor === undefined) throw new Error(`Missing ${variant} executor.`);
  const edgeKind = Object.entries(ATOMIC_EDGE_MUTATION_VARIANT_BY_KIND).find(
    ([, mappedVariant]) => mappedVariant === variant,
  )?.[0];
  const input = edgeKind === undefined ? undefined : { kind: edgeKind };
  await (executor as (value: never) => Promise<unknown>)(input as never);
}

function successCase() {
  let state: unknown = [];
  return {
    prepare: () => {
      state = [];
      return {
        expectedResult: ["second", "first"],
        expectedState: ["first", "second"],
      };
    },
    execute: () => {
      state = ["first", "second"];
      return ["second", "first"];
    },
    observeState: () => state,
  };
}

function refusalCase(
  dispatch: AtomicMutationProgramRefusalCase["dispatch"] = "required",
): AtomicMutationProgramRefusalCase {
  let state: unknown = ["before"];
  return {
    prepare: () => {
      state = ["before"];
      return { expectedState: ["before"] };
    },
    execute: () => {
      throw new ExpectedRefusal();
    },
    observeState: () => state,
    errorMatches: (error) => error instanceof ExpectedRefusal,
    dispatch,
  };
}

function conformanceCase(
  variant: AtomicMutationProgramVariant,
): UnboundConformanceCase {
  return {
    variant,
    orderedSuccess: successCase(),
    staleFenceNoWrite: { ...refusalCase(), dispatch: "required" },
    semanticRefusalRollback: refusalCase(),
  };
}

function completeCases(): readonly UnboundConformanceCase[] {
  return [
    "createNodes",
    "createEdges",
    "deleteNodes",
    "deleteEdges",
    "updateNodes",
    "updateEdges",
    "mutateNodes",
    "mutateEdges.resolvedSet",
    "mutateEdges.durableConvergence",
  ].map((variant) => conformanceCase(variant as AtomicMutationProgramVariant));
}

function bindCase(
  conformanceCase: UnboundConformanceCase,
  backend: GraphBackend,
): AtomicMutationProgramConformanceCase {
  function bind<T extends { execute: () => unknown }>(value: T): T {
    return {
      ...value,
      execute: async () => {
        if (
          (value as unknown as Partial<AtomicMutationProgramRefusalCase>)
            .dispatch !== "pre-dispatch"
        ) {
          await dispatchVariant(backend, conformanceCase.variant);
        }
        return value.execute();
      },
    };
  }
  return {
    ...conformanceCase,
    backend,
    orderedSuccess: bind(conformanceCase.orderedSuccess),
    staleFenceNoWrite: {
      ...bind(conformanceCase.staleFenceNoWrite),
      dispatch: "required",
    },
    semanticRefusalRollback: bind(conformanceCase.semanticRefusalRollback),
  };
}

function fixture(
  registration: AtomicMutationProgramRegistration = completeRegistration(),
  cases: readonly UnboundConformanceCase[] = completeCases(),
  interactiveTransactions = false,
) {
  const backend = createProfileBackend(registration, interactiveTransactions);
  return {
    backend,
    derivedBackends: [deriveBackend(backend, {})] as const,
    cases: cases.map((entry) => bindCase(entry, backend)),
    equal: (actual: unknown, expected: unknown) =>
      JSON.stringify(actual) === JSON.stringify(expected),
  } as const;
}

describe("atomic mutation program conformance runner", () => {
  it("runs every enabled variant and reports inapplicable provenance checks", async () => {
    const report = await runAtomicMutationProgramConformance(fixture());
    expect(report.variants.map((entry) => entry.variant)).toEqual(
      completeCases().map((entry) => entry.variant),
    );
    expect(report.provenance).toEqual({
      passed: [
        "exact root registration",
        "derived backend lineage",
        "derived backend isolation",
      ],
      skipped: ["transaction backend isolation"],
    });
  });

  it("owns zero-limit and mutateEdges sub-limit enablement", async () => {
    const registrations = [
      {
        updateNodes:
          callableWithLimit<AtomicNodeResolvedUpdateBatchExecutor>(0),
      },
      { updateEdges: callableWithLimit(0) },
      {
        mutateNodes:
          callableWithLimit<AtomicNodeResolvedMutationSetExecutor>(0),
      },
      {
        mutateEdges: edgeMutationExecutor({
          durableConvergence: 0,
          resolvedSet: 0,
        }),
      },
    ] satisfies readonly AtomicMutationProgramRegistration[];
    for (const registration of registrations) {
      const result = await runAtomicMutationProgramConformance(
        fixture(registration, []),
      );
      expect(result.variants).toEqual([]);
    }
    const report = await runAtomicMutationProgramConformance(
      fixture(
        {
          mutateEdges: edgeMutationExecutor({
            durableConvergence: 0,
            resolvedSet: 1,
          }),
        },
        [conformanceCase("mutateEdges.resolvedSet")],
      ),
    );
    expect(report.variants.map((entry) => entry.variant)).toEqual([
      "mutateEdges.resolvedSet",
    ]);

    const updateOnly = await runAtomicMutationProgramConformance(
      fixture(
        {
          updateNodes:
            callableWithLimit<AtomicNodeResolvedUpdateBatchExecutor>(1),
        },
        [conformanceCase("updateNodes")],
      ),
    );
    expect(updateOnly.variants.map((entry) => entry.variant)).toEqual([
      "updateNodes",
    ]);
  });

  it("owns the interactive-root routing exclusion for mixed resolved variants", async () => {
    const reachable = [
      "createNodes",
      "createEdges",
      "deleteNodes",
      "deleteEdges",
      "updateNodes",
      "updateEdges",
      "mutateEdges.durableConvergence",
    ] as const;
    const reachableSet = new Set<AtomicMutationProgramVariant>(reachable);
    const report = await runAtomicMutationProgramConformance(
      fixture(
        completeRegistration(),
        completeCases().filter((entry) => reachableSet.has(entry.variant)),
        true,
      ),
    );

    expect(report.variants.map((entry) => entry.variant)).toEqual(reachable);
  });

  it("refuses missing, unregistered, and duplicate cases", async () => {
    await expect(
      runAtomicMutationProgramConformance(
        fixture(undefined, completeCases().slice(1)),
      ),
    ).rejects.toMatchObject({ details: { variant: "createNodes" } });
    await expect(
      runAtomicMutationProgramConformance(
        fixture({ createNodes: completeRegistration().createNodes }, [
          conformanceCase("createNodes"),
          conformanceCase("createEdges"),
        ]),
      ),
    ).rejects.toMatchObject({ details: { variant: "createEdges" } });
    const duplicate = conformanceCase("createNodes");
    await expect(
      runAtomicMutationProgramConformance(
        fixture({ createNodes: completeRegistration().createNodes }, [
          duplicate,
          duplicate,
        ]),
      ),
    ).rejects.toBeInstanceOf(AtomicMutationProgramConformanceError);
  });

  it("catches success and required refusal paths that bypass native dispatch", async () => {
    const registration = { createNodes: completeRegistration().createNodes };
    const successFixture = fixture(registration, [
      conformanceCase("createNodes"),
    ]);
    const success = requireDefined(successFixture.cases[0]);
    await expect(
      runAtomicMutationProgramConformance({
        ...successFixture,
        cases: [
          {
            ...success,
            orderedSuccess: {
              ...success.orderedSuccess,
              execute: () => ["second", "first"],
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ details: { check: "ordered success" } });

    const refusalFixture = fixture(registration, [
      conformanceCase("createNodes"),
    ]);
    const refusal = requireDefined(refusalFixture.cases[0]);
    await expect(
      runAtomicMutationProgramConformance({
        ...refusalFixture,
        cases: [
          {
            ...refusal,
            staleFenceNoWrite: {
              ...refusal.staleFenceNoWrite,
              dispatch: "pre-dispatch" as never,
              execute: () => {
                throw new ExpectedRefusal();
              },
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ details: { check: "stale fence" } });
  });

  it("accepts an explicitly pre-dispatch semantic refusal", async () => {
    const registration = { createNodes: completeRegistration().createNodes };
    const base = conformanceCase("createNodes");
    const report = await runAtomicMutationProgramConformance(
      fixture(registration, [
        {
          ...base,
          semanticRefusalRollback: refusalCase("pre-dispatch"),
        },
      ]),
    );
    expect(report.variants[0]?.passed[2]).toContain("before native dispatch");
  });

  it("catches an ordered result that disagrees with committed state", async () => {
    let state: unknown = [];
    const conformance = conformanceCase("createNodes");
    const bound = fixture({ createNodes: completeRegistration().createNodes }, [
      {
        ...conformance,
        orderedSuccess: {
          prepare: () => {
            state = [];
            return {
              expectedResult: ["second", "first"],
              expectedState: ["first", "second"],
            };
          },
          execute: () => {
            state = ["second", "first"];
            return ["second", "first"];
          },
          observeState: () => state,
        },
      },
    ]);

    await expect(
      runAtomicMutationProgramConformance(bound),
    ).rejects.toMatchObject({
      details: { check: "committed state", variant: "createNodes" },
    });
  });

  it("catches a semantic refusal that leaks a sibling write", async () => {
    let state: unknown = ["before"];
    const leaking = conformanceCase("createNodes");
    const bound = fixture({ createNodes: completeRegistration().createNodes }, [
      {
        ...leaking,
        semanticRefusalRollback: {
          dispatch: "required",
          prepare: () => {
            state = ["before"];
            return { expectedState: ["before"] };
          },
          execute: () => {
            state = ["leaked"];
            throw new ExpectedRefusal();
          },
          observeState: () => state,
          errorMatches: (error) => error instanceof ExpectedRefusal,
        },
      },
    ]);

    await expect(
      runAtomicMutationProgramConformance(bound),
    ).rejects.toMatchObject({
      details: {
        check: "semantic refusal rollback",
        variant: "createNodes",
      },
    });
  });

  it("refuses a pre-dispatch case bound to another backend", async () => {
    const registration = { createNodes: completeRegistration().createNodes };
    const bound = fixture(registration, [
      {
        ...conformanceCase("createNodes"),
        semanticRefusalRollback: refusalCase("pre-dispatch"),
      },
    ]);
    const conformance = requireDefined(bound.cases[0]);

    await expect(
      runAtomicMutationProgramConformance({
        ...bound,
        cases: [
          {
            ...conformance,
            backend: createProfileBackend(registration),
          },
        ],
      }),
    ).rejects.toMatchObject({ details: { check: "case binding" } });
  });

  it("refuses a profile replacement made during preparation", async () => {
    const registration = { createNodes: completeRegistration().createNodes };
    const bound = fixture(registration, [conformanceCase("createNodes")]);
    const conformance = requireDefined(bound.cases[0]);

    await expect(
      runAtomicMutationProgramConformance({
        ...bound,
        cases: [
          {
            ...conformance,
            orderedSuccess: {
              ...conformance.orderedSuccess,
              prepare: async () => {
                const expected = await conformance.orderedSuccess.prepare();
                markBundledRootAtomicMutationPrograms(bound.backend, {
                  createNodes: completeRegistration().createNodes,
                });
                return expected;
              },
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ details: { check: "profile binding" } });
  });

  it("checks binding and provenance before fixture preparation", async () => {
    const prepare = vi.fn();
    const registration = { createNodes: completeRegistration().createNodes };
    const bound = fixture(registration, [conformanceCase("createNodes")]);
    const backend = {
      capabilities: {
        execution: { atomicBatch: "root", interactiveTransactions: false },
      },
    } as unknown as GraphBackend;
    const firstCase = requireDefined(bound.cases[0]);
    await expect(
      runAtomicMutationProgramConformance({
        ...bound,
        backend,
        derivedBackends: [deriveBackend(backend, {})],
        cases: [
          {
            ...firstCase,
            orderedSuccess: { ...firstCase.orderedSuccess, prepare },
          },
        ],
      }),
    ).rejects.toMatchObject({ details: { check: "exact root registration" } });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("owns exact-root, author-derived, and transaction isolation verdicts", async () => {
    const backend = createProfileBackend(completeRegistration());
    await expect(
      assertExactRootRegistrationProvenance(
        backend,
        { derivedBackends: [deriveBackend(backend, {})] },
        () => false,
        (check) => new Error(check),
      ),
    ).rejects.toThrow("exact root registration");
    await expect(
      assertExactRootRegistrationProvenance(
        backend,
        { derivedBackends: [createProfileBackend(completeRegistration())] },
        () => true,
        (check) => new Error(check),
      ),
    ).rejects.toThrow("derived backend lineage");
    const derived = deriveBackend(backend, {});
    await expect(
      assertExactRootRegistrationProvenance(
        backend,
        { derivedBackends: [derived] },
        (target) => target === backend || target === derived,
        (check) => new Error(check),
      ),
    ).rejects.toThrow("derived backend isolation");

    const transaction = {} as TransactionBackend;
    const interactive = {
      capabilities: {
        execution: { atomicBatch: "root", interactiveTransactions: true },
      },
      transaction: async (
        callback: (target: TransactionBackend) => Promise<unknown>,
      ) => callback(transaction),
    } as unknown as GraphBackend;
    await expect(
      assertExactRootRegistrationProvenance(
        interactive,
        { derivedBackends: [deriveBackend(interactive, {})] },
        (target) => target === interactive || target === transaction,
        (check) => new Error(check),
      ),
    ).rejects.toThrow("transaction backend isolation");
  });
});
