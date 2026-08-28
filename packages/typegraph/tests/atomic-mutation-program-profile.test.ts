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
  hasAtomicMutationProgramRegistration,
  registerAtomicMutationPrograms,
  resolveAtomicMutationPrograms,
  resolveBundledRootAtomicMutationPrograms,
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
import type { GraphBackend } from "../src/backend/types";
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
  } as GraphBackend;
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
      [sqliteTables.nodes, sqliteTables.edges, sqliteTables.edgeClaims],
    );
    assertRefusalSentinelsAreNotNull(
      createPostgresOperationStrategy(postgresTables, tsvectorStrategy),
      [postgresTables.nodes, postgresTables.edges, postgresTables.edgeClaims],
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
    expect(resolveAtomicMutationPrograms(backend)).toEqual({ createNodes });
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
    ).toBe(createNodes);
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
    Object.defineProperty(createNodes, "maxClaimedEntries", {
      configurable: true,
      value: -1,
    });

    const error = captureThrown(() =>
      registerAtomicMutationPrograms(backend, { createNodes }),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      details: {
        code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
        family: "createNodes",
        limit: "maxClaimedEntries",
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
