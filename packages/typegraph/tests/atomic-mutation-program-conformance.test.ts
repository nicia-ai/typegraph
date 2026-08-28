import { describe, expect, it, vi } from "vitest";

import {
  type AtomicEdgeMutationProgramExecutor,
  type AtomicMutationProgramRegistration,
  type AtomicNodeBatchExecutor,
  type AtomicNodeResolvedMutationSetExecutor,
  type AtomicNodeResolvedUpdateBatchExecutor,
  markBundledRootAtomicMutationPrograms,
} from "../src/backend/capabilities/atomic-mutation-program";
import {
  type AtomicMutationProgramConformanceCase,
  AtomicMutationProgramConformanceError,
  type AtomicMutationProgramRefusalCase,
  runAtomicMutationProgramConformance,
} from "../src/backend/conformance/atomic-mutation-program";
import { assertExactRootRegistrationProvenance } from "../src/backend/conformance/exact-root-provenance";
import type { GraphBackend } from "../src/backend/types";
import { requireDefined } from "../src/utils/presence";

class ExpectedRefusal extends Error {}

function callableWithLimit<T>(limit: number): T {
  const executor = (() => Promise.resolve([])) as T;
  Object.defineProperty(executor, "maxEntries", {
    value: limit,
  });
  return executor;
}

function edgeMutationExecutor(
  maxEntries?: AtomicEdgeMutationProgramExecutor["maxEntries"],
): AtomicEdgeMutationProgramExecutor {
  const executor = (() =>
    Promise.resolve([])) as unknown as AtomicEdgeMutationProgramExecutor;
  Object.defineProperty(executor, "maxEntries", {
    value: maxEntries ?? { durableConvergence: 1, resolvedSet: 1 },
  });
  return executor;
}

function completeRegistration(): AtomicMutationProgramRegistration {
  const noLimitExecutor = (() =>
    Promise.resolve([])) as unknown as AtomicNodeBatchExecutor;
  return {
    createNodes: noLimitExecutor,
    createEdges: (() => Promise.resolve([])) as never,
    deleteNodes: () =>
      Promise.resolve({
        affectedCount: 0,
        schemaFenceMatched: true,
      }),
    deleteEdges: () =>
      Promise.resolve({
        affectedCount: 0,
        schemaFenceMatched: true,
      }),
    updateNodes: callableWithLimit<AtomicNodeResolvedUpdateBatchExecutor>(1),
    updateEdges: callableWithLimit(1),
    mutateNodes: callableWithLimit<AtomicNodeResolvedMutationSetExecutor>(1),
    mutateEdges: edgeMutationExecutor(),
  };
}

function successCase() {
  let dispatchCount = 0;
  let state: unknown = [];
  return {
    prepare: () => {
      state = [];
      return {
        expectedResult: ["second", "first"],
        expectedState: ["first", "second"],
      };
    },
    resolveBackend: () => {
      throw new Error("Conformance case was not bound to a backend.");
    },
    execute: () => {
      dispatchCount += 1;
      state = ["first", "second"];
      return ["second", "first"];
    },
    observeState: () => state,
    observeDispatchCount: () => dispatchCount,
  };
}

function refusalCase(): AtomicMutationProgramRefusalCase {
  let dispatchCount = 0;
  let state: unknown = ["before"];
  return {
    prepare: () => {
      state = ["before"];
      return { expectedState: ["before"] };
    },
    resolveBackend: () => {
      throw new Error("Conformance case was not bound to a backend.");
    },
    execute: () => {
      dispatchCount += 1;
      throw new ExpectedRefusal();
    },
    observeState: () => state,
    observeDispatchCount: () => dispatchCount,
    errorMatches: (error) => error instanceof ExpectedRefusal,
  };
}

function conformanceCase(
  variant: AtomicMutationProgramConformanceCase["variant"],
): AtomicMutationProgramConformanceCase {
  return {
    variant,
    orderedSuccess: successCase(),
    staleFenceNoWrite: refusalCase(),
    semanticRefusalRollback: refusalCase(),
  };
}

function completeCases(): readonly AtomicMutationProgramConformanceCase[] {
  return [
    conformanceCase("createNodes"),
    conformanceCase("createEdges"),
    conformanceCase("deleteNodes"),
    conformanceCase("deleteEdges"),
    conformanceCase("updateNodes"),
    conformanceCase("updateEdges"),
    conformanceCase("mutateNodes"),
    conformanceCase("mutateEdges.resolvedSet"),
    conformanceCase("mutateEdges.durableConvergence"),
  ];
}

function createProfileBackend(
  registration: AtomicMutationProgramRegistration,
): GraphBackend {
  const backend = {
    capabilities: {
      execution: {
        atomicBatch: "root",
        interactiveTransactions: false,
      },
    },
  } as unknown as GraphBackend;
  return markBundledRootAtomicMutationPrograms(backend, registration);
}

function bindCaseToBackend(
  conformanceCase: AtomicMutationProgramConformanceCase,
  backend: GraphBackend,
): AtomicMutationProgramConformanceCase {
  return {
    ...conformanceCase,
    orderedSuccess: {
      ...conformanceCase.orderedSuccess,
      resolveBackend: () => backend,
    },
    staleFenceNoWrite: {
      ...conformanceCase.staleFenceNoWrite,
      resolveBackend: () => backend,
    },
    semanticRefusalRollback: {
      ...conformanceCase.semanticRefusalRollback,
      resolveBackend: () => backend,
    },
  };
}

function fixture(
  registration: AtomicMutationProgramRegistration = completeRegistration(),
  cases: readonly AtomicMutationProgramConformanceCase[] = completeCases(),
) {
  const backend = createProfileBackend(registration);
  return {
    backend,
    cases: cases.map((conformanceCase) =>
      bindCaseToBackend(conformanceCase, backend),
    ),
    equal: (actual: unknown, expected: unknown) =>
      JSON.stringify(actual) === JSON.stringify(expected),
  } as const;
}

describe("atomic mutation program conformance runner", () => {
  it("runs every enabled family variant and exact-root provenance check", async () => {
    const report = await runAtomicMutationProgramConformance(fixture());

    expect(report.variants.map((entry) => entry.variant)).toEqual([
      "createNodes",
      "createEdges",
      "deleteNodes",
      "deleteEdges",
      "updateNodes",
      "updateEdges",
      "mutateNodes",
      "mutateEdges.resolvedSet",
      "mutateEdges.durableConvergence",
    ]);
    expect(report.variants.every((entry) => entry.passed.length === 3)).toBe(
      true,
    );
    expect(report.provenance).toEqual([
      "exact root registration",
      "derived backend isolation",
      "transaction backend isolation",
    ]);
  });

  it("requires a case for every positive registered variant", async () => {
    const cases = completeCases().filter(
      (entry) => entry.variant !== "deleteNodes",
    );

    await expect(
      runAtomicMutationProgramConformance(fixture(undefined, cases)),
    ).rejects.toMatchObject({
      details: { variant: "deleteNodes" },
    });
  });

  it("does not let an unregistered family borrow another family proof", async () => {
    const registration = { createNodes: completeRegistration().createNodes };

    await expect(
      runAtomicMutationProgramConformance(
        fixture(registration, [
          conformanceCase("createNodes"),
          conformanceCase("createEdges"),
        ]),
      ),
    ).rejects.toMatchObject({
      details: { variant: "createEdges" },
    });
  });

  it("treats zero limits as honest disabled variants", async () => {
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
      const report = await runAtomicMutationProgramConformance(
        fixture(registration, []),
      );
      expect(report.variants).toEqual([]);
    }
  });

  it("requires only the positive mutateEdges sub-limit", async () => {
    const registration = {
      mutateEdges: edgeMutationExecutor({
        durableConvergence: 0,
        resolvedSet: 1,
      }),
    };

    const report = await runAtomicMutationProgramConformance(
      fixture(registration, [conformanceCase("mutateEdges.resolvedSet")]),
    );

    expect(report.variants.map((entry) => entry.variant)).toEqual([
      "mutateEdges.resolvedSet",
    ]);
  });

  it("refuses duplicate cases instead of choosing one proof", async () => {
    const registration = { createNodes: completeRegistration().createNodes };
    const duplicate = conformanceCase("createNodes");

    await expect(
      runAtomicMutationProgramConformance(
        fixture(registration, [duplicate, duplicate]),
      ),
    ).rejects.toBeInstanceOf(AtomicMutationProgramConformanceError);
  });

  it("catches a success case that bypasses the registered executor", async () => {
    const registration = { createNodes: completeRegistration().createNodes };
    const base = conformanceCase("createNodes");
    const bypassed = {
      ...base,
      orderedSuccess: {
        prepare: () => ({
          expectedResult: ["second", "first"],
          expectedState: ["first", "second"],
        }),
        resolveBackend: base.orderedSuccess.resolveBackend,
        execute: vi.fn(() => ["second", "first"]),
        observeState: () => ["first", "second"],
        observeDispatchCount: () => 0,
      },
    };

    await expect(
      runAtomicMutationProgramConformance(fixture(registration, [bypassed])),
    ).rejects.toMatchObject({
      details: { check: "ordered success", variant: "createNodes" },
    });
  });

  it("catches an ordered result that disagrees with committed state", async () => {
    const registration = { createNodes: completeRegistration().createNodes };
    const base = conformanceCase("createNodes");
    const misordered = {
      ...base,
      orderedSuccess: {
        ...base.orderedSuccess,
        execute: () => {
          base.orderedSuccess.execute();
          return ["first", "second"];
        },
      },
    };

    await expect(
      runAtomicMutationProgramConformance(fixture(registration, [misordered])),
    ).rejects.toMatchObject({
      details: { check: "ordered result", variant: "createNodes" },
    });
  });

  it("catches a refusal that bypasses the registered executor", async () => {
    const registration = { createNodes: completeRegistration().createNodes };
    const base = conformanceCase("createNodes");
    const bypassed = {
      ...base,
      staleFenceNoWrite: {
        ...base.staleFenceNoWrite,
        execute: () => {
          throw new ExpectedRefusal();
        },
        observeDispatchCount: () => 0,
      },
    };

    await expect(
      runAtomicMutationProgramConformance(fixture(registration, [bypassed])),
    ).rejects.toMatchObject({
      details: { check: "stale fence", variant: "createNodes" },
    });
  });

  it("catches a semantic refusal that leaks a sibling write", async () => {
    const registration = { createNodes: completeRegistration().createNodes };
    const base = conformanceCase("createNodes");
    let state: unknown = ["before"];
    let dispatchCount = 0;
    const leaking = {
      ...base,
      semanticRefusalRollback: {
        ...base.semanticRefusalRollback,
        prepare: () => {
          state = ["before"];
          return { expectedState: ["before"] };
        },
        execute: () => {
          dispatchCount += 1;
          state = ["leaked"];
          throw new ExpectedRefusal();
        },
        observeDispatchCount: () => dispatchCount,
        observeState: () => state,
      },
    };

    await expect(
      runAtomicMutationProgramConformance(fixture(registration, [leaking])),
    ).rejects.toMatchObject({
      details: {
        check: "semantic refusal rollback",
        variant: "createNodes",
      },
    });
  });

  it("refuses an unregistered profile before executing a case", async () => {
    const registration = { createNodes: completeRegistration().createNodes };
    const base = conformanceCase("createNodes");
    const bound = fixture(registration, [base]);
    const execute = vi.fn(base.orderedSuccess.execute);
    const backend = {
      capabilities: {
        execution: {
          atomicBatch: "root",
          interactiveTransactions: false,
        },
      },
    } as unknown as GraphBackend;

    await expect(
      runAtomicMutationProgramConformance({
        ...bound,
        backend,
        cases: bound.cases.map((entry) => ({
          ...entry,
          orderedSuccess: { ...entry.orderedSuccess, execute },
        })),
      }),
    ).rejects.toMatchObject({
      details: { check: "exact root registration" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses transaction-scoped registration leakage before executing a case", async () => {
    const registration = { createNodes: completeRegistration().createNodes };
    const base = conformanceCase("createNodes");
    const execute = vi.fn(base.orderedSuccess.execute);
    const backend = {
      capabilities: {
        execution: {
          atomicBatch: "root",
          interactiveTransactions: true,
        },
      },
      transaction: (callback: (transaction: GraphBackend) => unknown) =>
        Promise.resolve(callback(backend)),
    } as unknown as GraphBackend;
    markBundledRootAtomicMutationPrograms(backend, registration);
    const bound = bindCaseToBackend(
      {
        ...base,
        orderedSuccess: { ...base.orderedSuccess, execute },
      },
      backend,
    );

    await expect(
      runAtomicMutationProgramConformance({
        backend,
        cases: [bound],
        equal: (actual, expected) => actual === expected,
      }),
    ).rejects.toMatchObject({
      details: { check: "transaction backend isolation" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an equivalent profile bound to a different root", async () => {
    const registration = { createNodes: completeRegistration().createNodes };
    const bound = fixture(registration, [conformanceCase("createNodes")]);
    const boundCase = requireDefined(bound.cases[0]);
    const differentBackend = createProfileBackend(registration);
    const mismatched = {
      ...boundCase,
      orderedSuccess: {
        ...boundCase.orderedSuccess,
        resolveBackend: () => differentBackend,
      },
    };

    await expect(
      runAtomicMutationProgramConformance({ ...bound, cases: [mismatched] }),
    ).rejects.toMatchObject({
      details: { check: "ordered success", variant: "createNodes" },
    });
  });

  it.each([
    ["exactRootRegistration", "exact root registration"],
    ["derivedBackendIsolation", "derived backend isolation"],
    ["transactionBackendIsolation", "transaction backend isolation"],
  ] as const)("owns the %s provenance verdict", async (member, name) => {
    const checks = {
      exactRootRegistration: () => true,
      derivedBackendIsolation: () => true,
      transactionBackendIsolation: () => true,
      [member]: () => false,
    };

    await expect(
      assertExactRootRegistrationProvenance(
        checks,
        (check) => new Error(check),
      ),
    ).rejects.toThrow(name);
  });
});
