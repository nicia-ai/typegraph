import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { getTableColumns, getTableName, type Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type AtomicEdgeMutationProgramExecutor,
  type AtomicMutationProgramRegistration,
  type AtomicNodeBatchExecutor,
  type AtomicNodeBatchInput,
  atomicNodeClaimInputCost,
  type AtomicNodeResolvedUpdateBatchExecutor,
  hasAtomicMutationProgramRegistration,
  registerAtomicMutationPrograms,
  resolveAtomicMutationPrograms,
  resolveBundledRootAtomicMutationPrograms,
  supportsAtomicNodeClaims,
} from "../src/backend/capabilities/atomic-mutation-program";
import {
  type AtomicSqlBatchExecutor,
  registerAtomicSqlProgram,
} from "../src/backend/capabilities/atomic-sql-program";
import { deriveBackend } from "../src/backend/derive-backend";
import {
  type CommonOperationStrategy,
  createPostgresOperationStrategy,
  createSqliteOperationStrategy,
} from "../src/backend/drizzle/operations/strategy";
import { tables as postgresTables } from "../src/backend/drizzle/schema/postgres";
import { tables as sqliteTables } from "../src/backend/drizzle/schema/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import type { GraphBackend, NodeInsertClaim } from "../src/backend/types";
import { defineGraph, defineNode } from "../src/core";
import { ConfigurationError } from "../src/errors";
import {
  fts5Strategy,
  tsvectorStrategy,
} from "../src/query/dialect/fulltext-strategy";
import { buildKindRegistry } from "../src/registry";
import { resolveAtomicNodeBatchExecutor } from "../src/store/operations/atomic-mutation-program";

type RefusalConstraints = Pick<
  CommonOperationStrategy,
  "atomicEdgeRefusalConstraints" | "atomicNodeRefusalConstraints"
>;

function repeatClaim(
  claim: NodeInsertClaim,
  count: number,
): readonly NodeInsertClaim[] {
  return Array.from({ length: count }, () => claim);
}

const CustomNode = defineNode("CustomNode", {
  schema: z.object({ name: z.string() }),
});
const customGraph = defineGraph({
  id: "custom-semantic-program",
  nodes: { CustomNode: { type: CustomNode } },
  edges: {},
});

function createCustomAtomicRoot(): GraphBackend {
  return {
    capabilities: {
      execution: { interactiveTransactions: false, atomicBatch: "root" },
    },
    commands: {
      session: "root",
      execute: () => Promise.reject(new Error("unused command port")),
    },
  } as unknown as GraphBackend;
}

const emptyAtomicBatch: AtomicSqlBatchExecutor = () => Promise.resolve([]);

async function executeCustomNodeBatch(
  input: AtomicNodeBatchInput & Readonly<{ resultMode: "count" }>,
): Promise<number>;
async function executeCustomNodeBatch(
  input: AtomicNodeBatchInput & Readonly<{ resultMode: "rows" }>,
): Promise<readonly never[]>;
function executeCustomNodeBatch(
  input: AtomicNodeBatchInput,
): Promise<number | readonly never[]> {
  return Promise.resolve(
    input.resultMode === "count" ? input.entries.length : [],
  );
}

function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function assertRefusalSentinelsAreNotNull(
  strategy: RefusalConstraints,
  tables: readonly Table[],
): void {
  const constraints = [
    ...Object.values(strategy.atomicEdgeRefusalConstraints),
    ...Object.values(strategy.atomicNodeRefusalConstraints),
  ];
  for (const constraint of constraints) {
    const table = tables.find(
      (candidate) => getTableName(candidate) === constraint.table,
    );
    expect(table, `refusal table ${constraint.table}`).toBeDefined();
    if (table === undefined) continue;
    const column = Object.values(getTableColumns(table)).find(
      (candidate) => candidate.name === constraint.column,
    );
    expect(
      column?.notNull,
      `refusal sentinel ${constraint.table}.${constraint.column}`,
    ).toBe(true);
  }
}

describe("atomic mutation program execution profile", () => {
  it("keeps the unvalidated compatibility mark inside its test-seam owner", () => {
    const productionFiles = execFileSync(
      "git",
      [
        "grep",
        "-l",
        "markBundledRootAtomicMutationPrograms",
        "--",
        "packages/typegraph/src",
      ],
      {
        cwd: path.resolve(import.meta.dirname, "../../.."),
        encoding: "utf8",
      },
    )
      .trim()
      .split("\n");

    expect(productionFiles).toEqual([
      "packages/typegraph/src/backend/capabilities/atomic-mutation-program.ts",
    ]);
  });

  it("binds every refusal classifier to a NOT NULL schema column", () => {
    assertRefusalSentinelsAreNotNull(
      createSqliteOperationStrategy(sqliteTables, fts5Strategy),
      [
        sqliteTables.nodes,
        sqliteTables.edges,
        sqliteTables.edgeClaims,
        sqliteTables.contributionMaterializations,
      ],
    );
    assertRefusalSentinelsAreNotNull(
      createPostgresOperationStrategy(postgresTables, tsvectorStrategy),
      [
        postgresTables.nodes,
        postgresTables.edges,
        postgresTables.edgeClaims,
        postgresTables.contributionMaterializations,
      ],
    );
  });

  it("registers every semantic program once on the exact bundled root", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-mutation-profile-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const { backend } = await createLibsqlBackend(client);
    try {
      const profile = resolveBundledRootAtomicMutationPrograms(backend);
      expect(typeof profile?.createNodes).toBe("function");
      expect(typeof profile?.createEdges).toBe("function");
      expect(typeof profile?.deleteNodes).toBe("function");
      expect(typeof profile?.deleteEdges).toBe("function");
      expect(
        resolveBundledRootAtomicMutationPrograms(deriveBackend(backend, {})),
      ).toBeUndefined();
      await backend.transaction((transactionBackend) => {
        expect(transactionBackend.capabilities.execution.atomicBatch).toBe(
          "none",
        );
        expect(
          resolveBundledRootAtomicMutationPrograms(transactionBackend),
        ).toBeUndefined();
        return Promise.resolve();
      });
    } finally {
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("opens only explicitly registered semantic families on a custom root", () => {
    const backend = createCustomAtomicRoot();
    const createNodes: AtomicNodeBatchExecutor = executeCustomNodeBatch;
    registerAtomicSqlProgram(backend, emptyAtomicBatch);

    expect(
      resolveAtomicNodeBatchExecutor({
        backend,
        graph: customGraph,
        registry: buildKindRegistry(customGraph),
        inputs: [{ kind: "CustomNode", props: { name: "Alice" } }],
        schemaVersion: 1,
        identityEnabled: false,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      }),
    ).toBeUndefined();

    registerAtomicMutationPrograms(backend, { createNodes });

    expect(hasAtomicMutationProgramRegistration(backend)).toBe(true);
    const registered = resolveAtomicMutationPrograms(backend);
    expect(typeof registered?.createNodes).toBe("function");
    expect(registered?.createNodes).not.toBe(createNodes);
    expect(
      resolveAtomicNodeBatchExecutor({
        backend,
        graph: customGraph,
        registry: buildKindRegistry(customGraph),
        inputs: [{ kind: "CustomNode", props: { name: "Alice" } }],
        schemaVersion: 1,
        identityEnabled: false,
        historyEnabled: false,
        revisionTrackingEnabled: false,
      }),
    ).toBe(registered?.createNodes);
    expect(resolveAtomicMutationPrograms(deriveBackend(backend, {}))).toBe(
      undefined,
    );
    expect(
      captureThrown(() =>
        registerAtomicMutationPrograms(backend, { createNodes }),
      ),
    ).toMatchObject({
      details: { code: "ATOMIC_MUTATION_PROGRAM_ALREADY_REGISTERED" },
    });
  });

  it("instruments executors without snapshotting or dropping their properties", () => {
    const backend = createCustomAtomicRoot();
    registerAtomicSqlProgram(backend, emptyAtomicBatch);
    let maxEntries = 1;
    const marker = Symbol("custom executor property");
    const updateNodes = (() =>
      Promise.resolve([])) as unknown as AtomicNodeResolvedUpdateBatchExecutor;
    Object.defineProperties(updateNodes, {
      maxEntries: {
        configurable: true,
        enumerable: true,
        get: () => maxEntries,
      },
      [marker]: { value: "preserved" },
    });

    registerAtomicMutationPrograms(backend, { updateNodes });
    const instrumented = resolveAtomicMutationPrograms(backend)?.updateNodes;
    if (instrumented === undefined) {
      throw new Error("Expected an instrumented updateNodes executor.");
    }
    expect(instrumented.maxEntries).toBe(1);
    maxEntries = 2;
    expect(instrumented.maxEntries).toBe(2);
    expect(Reflect.get(instrumented, marker)).toBe("preserved");
    expect(Object.getOwnPropertyDescriptor(instrumented, "maxEntries")).toEqual(
      Object.getOwnPropertyDescriptor(updateNodes, "maxEntries"),
    );
  });

  it("refuses semantic registration without exact-root transport evidence", () => {
    const backend = createCustomAtomicRoot();
    const createNodes: AtomicNodeBatchExecutor = executeCustomNodeBatch;

    const error = captureThrown(() =>
      registerAtomicMutationPrograms(backend, { createNodes }),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      details: { code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH" },
    });
    expect(hasAtomicMutationProgramRegistration(backend)).toBe(false);
  });

  it("refuses semantic registration after the root declaration is downgraded", () => {
    const backend = createCustomAtomicRoot();
    registerAtomicSqlProgram(backend, emptyAtomicBatch);
    Object.defineProperty(backend, "capabilities", {
      configurable: true,
      value: {
        execution: { interactiveTransactions: false, atomicBatch: "none" },
      },
    });

    const error = captureThrown(() =>
      registerAtomicMutationPrograms(backend, {
        createNodes: executeCustomNodeBatch,
      }),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      details: {
        atomicBatch: "none",
        code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
        transportRegistered: true,
      },
    });
    expect(hasAtomicMutationProgramRegistration(backend)).toBe(false);
  });

  it("refuses an empty semantic profile", () => {
    const backend = createCustomAtomicRoot();
    registerAtomicSqlProgram(backend, emptyAtomicBatch);

    const error = captureThrown(() =>
      registerAtomicMutationPrograms(backend, {}),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      details: { code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH" },
    });
  });

  it("refuses a null semantic profile with the typed registration error", () => {
    const backend = createCustomAtomicRoot();
    registerAtomicSqlProgram(backend, emptyAtomicBatch);
    const malformedRegistration = JSON.parse(
      "null",
    ) as unknown as AtomicMutationProgramRegistration;

    const error = captureThrown(() =>
      registerAtomicMutationPrograms(backend, malformedRegistration),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      details: { code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH" },
    });
    expect(hasAtomicMutationProgramRegistration(backend)).toBe(false);
  });

  it("refuses malformed family limits before publishing the profile", () => {
    const backend = createCustomAtomicRoot();
    registerAtomicSqlProgram(backend, emptyAtomicBatch);
    const createNodes: AtomicNodeBatchExecutor =
      executeCustomNodeBatch.bind(undefined);
    Object.defineProperty(createNodes, "claimSupport", {
      configurable: true,
      value: { families: ["uniqueness"], maxInputCostPerEntry: -1 },
    });

    const error = captureThrown(() =>
      registerAtomicMutationPrograms(backend, { createNodes }),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      details: {
        code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
        family: "createNodes",
        limit: "claimSupport.maxInputCostPerEntry",
      },
    });
    expect(hasAtomicMutationProgramRegistration(backend)).toBe(false);
  });

  it("refuses malformed claim-family declarations", () => {
    const backend = createCustomAtomicRoot();
    registerAtomicSqlProgram(backend, emptyAtomicBatch);
    const createNodes: AtomicNodeBatchExecutor =
      executeCustomNodeBatch.bind(undefined);
    Object.defineProperty(createNodes, "claimSupport", {
      configurable: true,
      value: { families: ["unknown"], maxInputCostPerEntry: 1 },
    });

    const error = captureThrown(() =>
      registerAtomicMutationPrograms(backend, { createNodes }),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      details: {
        code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
        family: "createNodes",
        limit: "claimSupport.families",
      },
    });
    expect(hasAtomicMutationProgramRegistration(backend)).toBe(false);
  });

  it("accepts an empty claim-support envelope as an honest opt-out", () => {
    const backend = createCustomAtomicRoot();
    registerAtomicSqlProgram(backend, emptyAtomicBatch);
    const createNodes: AtomicNodeBatchExecutor =
      executeCustomNodeBatch.bind(undefined);
    Object.defineProperty(createNodes, "claimSupport", {
      configurable: true,
      value: { families: [], maxInputCostPerEntry: 0 },
    });

    expect(() =>
      registerAtomicMutationPrograms(backend, { createNodes }),
    ).not.toThrow();
    expect(hasAtomicMutationProgramRegistration(backend)).toBe(true);
  });

  it("applies claim families and per-member input cost independently", () => {
    const uniquenessClaim = {
      axis: "Person",
      constraintName: "person-name",
      key: "name",
      placement: "pre-insert",
      verdict: {
        kind: "uniqueness",
        fields: ["name"],
        probeAxes: ["Person"],
      },
    } as const satisfies NodeInsertClaim;
    const disjointnessClaim = {
      axis: "Person|Rival",
      constraintName: "disjoint",
      key: "id",
      placement: "pre-insert",
      verdict: { kind: "disjointness", conflictingKinds: ["Rival"] },
    } as const satisfies NodeInsertClaim;
    const support = {
      families: ["uniqueness", "disjointness"],
      maxInputCostPerEntry: 42,
    } as const;

    expect(
      supportsAtomicNodeClaims(support, repeatClaim(uniquenessClaim, 7)),
    ).toBe(true);
    expect(
      supportsAtomicNodeClaims(support, repeatClaim(uniquenessClaim, 8)),
    ).toBe(false);
    expect(
      supportsAtomicNodeClaims(support, repeatClaim(disjointnessClaim, 3)),
    ).toBe(true);
    expect(
      supportsAtomicNodeClaims(support, repeatClaim(disjointnessClaim, 4)),
    ).toBe(false);
    expect(
      supportsAtomicNodeClaims(support, [
        ...repeatClaim(uniquenessClaim, 4),
        disjointnessClaim,
      ]),
    ).toBe(true);
    expect(
      supportsAtomicNodeClaims(support, [
        ...repeatClaim(uniquenessClaim, 6),
        disjointnessClaim,
      ]),
    ).toBe(false);
  });

  it("prices uniqueness and disjointness compatibility probes by emitted binds", () => {
    const uniquenessClaim = {
      axis: "Person",
      constraintName: "person-name",
      key: "name",
      placement: "pre-insert",
      verdict: {
        kind: "uniqueness",
        fields: ["name"],
        probeAxes: ["Person", "Employee", "Manager", "Director", "Founder"],
      },
    } as const satisfies NodeInsertClaim;
    const disjointnessClaim = {
      axis: "Person|Rival",
      constraintName: "disjoint",
      key: "id",
      placement: "pre-insert",
      verdict: {
        kind: "disjointness",
        conflictingKinds: ["Rival", "Enemy", "Competitor", "Opponent"],
      },
    } as const satisfies NodeInsertClaim;

    expect(atomicNodeClaimInputCost([uniquenessClaim])).toBe(42);
    expect(atomicNodeClaimInputCost([disjointnessClaim])).toBe(30);
  });

  it("refuses infinite family limits before publishing the profile", () => {
    const backend = createCustomAtomicRoot();
    registerAtomicSqlProgram(backend, emptyAtomicBatch);
    const updateNodes = (() =>
      Promise.resolve([])) as unknown as AtomicNodeResolvedUpdateBatchExecutor;
    Object.defineProperty(updateNodes, "maxEntries", {
      configurable: true,
      value: Number.POSITIVE_INFINITY,
    });

    const error = captureThrown(() =>
      registerAtomicMutationPrograms(backend, { updateNodes }),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      details: {
        code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
        family: "updateNodes",
        limit: "maxEntries",
      },
    });
    expect(hasAtomicMutationProgramRegistration(backend)).toBe(false);
  });

  it("refuses malformed node projection support before publishing the profile", () => {
    const backend = createCustomAtomicRoot();
    registerAtomicSqlProgram(backend, emptyAtomicBatch);
    const updateNodes = (() =>
      Promise.resolve([])) as unknown as AtomicNodeResolvedUpdateBatchExecutor;
    Object.defineProperties(updateNodes, {
      maxEntries: { configurable: true, value: 1 },
      projectionSupport: {
        configurable: true,
        value: { families: ["fulltext", "fulltext"] },
      },
    });

    const error = captureThrown(() =>
      registerAtomicMutationPrograms(backend, { updateNodes }),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      details: {
        code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
        family: "updateNodes",
        limit: "projectionSupport.families",
      },
    });
    expect(hasAtomicMutationProgramRegistration(backend)).toBe(false);
  });

  it("refuses malformed edge mutation limits before publishing the profile", () => {
    const backend = createCustomAtomicRoot();
    registerAtomicSqlProgram(backend, emptyAtomicBatch);
    const mutateEdges = (() =>
      Promise.resolve([])) as unknown as AtomicEdgeMutationProgramExecutor;
    Object.defineProperty(mutateEdges, "maxEntries", {
      configurable: true,
      value: { durableConvergence: -1, resolvedSet: 1 },
    });

    const error = captureThrown(() =>
      registerAtomicMutationPrograms(backend, { mutateEdges }),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      details: {
        code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
        family: "mutateEdges",
        limit: "maxEntries.durableConvergence",
      },
    });
    expect(hasAtomicMutationProgramRegistration(backend)).toBe(false);
  });

  it("refuses non-callable families before publishing the profile", () => {
    const backend = createCustomAtomicRoot();
    registerAtomicSqlProgram(backend, emptyAtomicBatch);
    const registration = {
      createNodes: 1,
    } as unknown as AtomicMutationProgramRegistration;

    const error = captureThrown(() =>
      registerAtomicMutationPrograms(backend, registration),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      details: {
        code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
        family: "createNodes",
      },
    });
    expect(hasAtomicMutationProgramRegistration(backend)).toBe(false);
  });
});
