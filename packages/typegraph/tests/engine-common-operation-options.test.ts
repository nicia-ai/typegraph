/**
 * `buildCommonOperationOptions`
 * (`src/backend/drizzle/engine/operation-layer.ts`) assembles one
 * `createCommonOperationBackend` options object identically for either
 * dialect. This exercises it directly against two `fusion` shapes modeled
 * on what `buildPostgresEngineProfile` / `buildSqliteEngineProfile` actually
 * construct at their `createCommonOperationBackend` call sites — SQLite
 * supplies only `atomicProgramsAtTransactionScope`; PostgreSQL always adds
 * its projection-fusion hooks and `tableExistenceCache`, and adds its three
 * transaction-scope-only keys only when transaction-scoped — across both
 * command sessions, asserting the exact key set and, for fields that are
 * plain data, the literal value passed in. Functions are compared by
 * presence only: the three projection-evidence callbacks are new closures
 * every call, so reference equality is never the right check for them.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { AtomicSqlProgramExecutor } from "../src/backend/capabilities/atomic-sql-program";
import type { ContributionMaterializer } from "../src/backend/drizzle/contribution-materializations";
import {
  buildCommonOperationOptions,
  type CommonOperationOptionsDeps,
} from "../src/backend/drizzle/engine/operation-layer";
import type {
  OperationBackendBatchConfig,
  OperationBackendRowMappers,
} from "../src/backend/drizzle/operation-backend-core";
import type { CommonOperationStrategy } from "../src/backend/drizzle/operations/strategy";
import type {
  EdgeRow,
  NodeRow,
  SchemaVersionRow,
  UniqueRow,
} from "../src/backend/types";

const BATCH_CONFIG: OperationBackendBatchConfig = {
  checkUniqueBatchChunkSize: 11,
  edgeInsertBatchSize: 22,
  edgeSchemaFencedInsertBatchSize: 33,
  findEdgesEndpointChunkSize: 44,
  getEdgesChunkSize: 55,
  getNodesChunkSize: 66,
  nodeInsertBatchSize: 77,
  nodeSchemaFencedInsertBatchSize: 88,
  uniqueDeleteChunkSize: 99,
  uniqueInsertBatchSize: 111,
};

const ROW_MAPPERS: OperationBackendRowMappers = {
  toEdgeRow: (row) => row as unknown as EdgeRow,
  toNodeRow: (row) => row as unknown as NodeRow,
  toSchemaVersionRow: (row) => row as unknown as SchemaVersionRow,
  toUniqueRow: (row) => row as unknown as UniqueRow,
};

const OPERATION_STRATEGY = {} as unknown as CommonOperationStrategy;

const CONTRIBUTION_MATERIALIZER = {
  resolveNodeProjectionEvidence: () => Promise.resolve([]),
  diagnoseNodeProjectionEvidence: () => Promise.resolve(),
  refuseUnavailableNodeInsertProjections: (): Promise<never> => {
    throw new Error("not called in this test");
  },
} as unknown as ContributionMaterializer;

const ATOMIC_SQL_PROGRAM_EXECUTOR = {
  marker: "atomic-sql-program-executor-fake",
} as unknown as AtomicSqlProgramExecutor;

const EXECUTION: CommonOperationOptionsDeps["execution"] = {
  compile: () => {
    throw new Error("not called in this test");
  },
  execAll: () => Promise.resolve([]),
  execGet: () => Promise.resolve(undefined),
  execRun: () => Promise.resolve(),
};

const SCHEMA_FENCE_LOCK_CLAUSE: CommonOperationOptionsDeps["schemaFenceLockClause"] =
  sql.raw("FOR SHARE");

/** The keys `buildCommonOperationOptions` sets on every call, regardless of dialect or scope. */
const SHARED_KEYS = [
  "batchConfig",
  "commandSession",
  "execution",
  "nowIso",
  "maxBindParameters",
  "operationStrategy",
  "rowMappers",
  "schemaFenceLockClause",
  "resolveAtomicNodeProjectionEvidence",
  "diagnoseAtomicNodeProjectionEvidence",
  "refuseAtomicNodeProjectionError",
];

function baseDeps(
  overrides: Readonly<Partial<CommonOperationOptionsDeps>>,
): CommonOperationOptionsDeps {
  return {
    batchConfig: BATCH_CONFIG,
    commandSession: "root",
    execution: EXECUTION,
    atomicSqlProgramExecutor: ATOMIC_SQL_PROGRAM_EXECUTOR,
    nowIso: () => "2026-01-01T00:00:00.000Z",
    maxBindParameters: 999,
    operationStrategy: OPERATION_STRATEGY,
    rowMappers: ROW_MAPPERS,
    schemaFenceLockClause: SCHEMA_FENCE_LOCK_CLAUSE,
    contributionMaterializer: CONTRIBUTION_MATERIALIZER,
    fusion: { atomicProgramsAtTransactionScope: false },
    ...overrides,
  };
}

/** The `fusion` value SQLite's dialect factory builds today: no PostgreSQL-only keys, at either scope. */
function sqliteFusion(): CommonOperationOptionsDeps["fusion"] {
  return { atomicProgramsAtTransactionScope: false };
}

/**
 * The `fusion` value PostgreSQL's dialect factory builds today: the
 * projection-fusion hooks and `tableExistenceCache` unconditionally, plus
 * the three transaction-scope-only keys exactly when `transactionScoped`.
 */
function postgresFusion(
  transactionScoped: boolean,
): CommonOperationOptionsDeps["fusion"] {
  return {
    atomicProgramsAtTransactionScope: true,
    nodeProjectionInsertFusion: true,
    beforeNodeProjectionInsert: () => Promise.resolve(),
    refuseNodeProjectionError: (): Promise<never> => {
      throw new Error("not called in this test");
    },
    ...(transactionScoped ?
      {
        schemaGraphWriteLockNamespace: "graph-write-lock-namespace",
        edgeCardinalityInsertFusion: true,
        nodeClaimInsertFusion: true,
      }
    : {}),
    tableExistenceCache: { cacheExisting: false },
  };
}

function assertSharedValuesPassedThrough(
  options: ReturnType<typeof buildCommonOperationOptions>,
): void {
  expect(options.batchConfig).toBe(BATCH_CONFIG);
  expect(options.rowMappers).toBe(ROW_MAPPERS);
  expect(options.operationStrategy).toBe(OPERATION_STRATEGY);
  expect(options.schemaFenceLockClause).toBe(SCHEMA_FENCE_LOCK_CLAUSE);
  expect(options.maxBindParameters).toBe(999);
  for (const key of [
    "resolveAtomicNodeProjectionEvidence",
    "diagnoseAtomicNodeProjectionEvidence",
    "refuseAtomicNodeProjectionError",
  ] as const) {
    expect(typeof options[key]).toBe("function");
  }
}

describe("buildCommonOperationOptions", () => {
  it("assembles SQLite's root-scope options with the atomic executor present and no PostgreSQL-only keys", () => {
    const options = buildCommonOperationOptions(
      baseDeps({ commandSession: "root", fusion: sqliteFusion() }),
    );

    expect(Object.keys(options).toSorted()).toEqual(
      [...SHARED_KEYS, "atomicSqlProgramExecutor"].toSorted(),
    );
    assertSharedValuesPassedThrough(options);
    expect(options.atomicSqlProgramExecutor).toBe(ATOMIC_SQL_PROGRAM_EXECUTOR);
  });

  it("excludes the atomic executor from SQLite's transaction-scoped options", () => {
    const options = buildCommonOperationOptions(
      baseDeps({ commandSession: "transaction", fusion: sqliteFusion() }),
    );

    expect(Object.keys(options).toSorted()).toEqual(
      [...SHARED_KEYS].toSorted(),
    );
    expect("atomicSqlProgramExecutor" in options).toBe(false);
    assertSharedValuesPassedThrough(options);
  });

  it("assembles PostgreSQL's root-scope options with the projection-fusion hooks but no transaction-scope-only keys", () => {
    const options = buildCommonOperationOptions(
      baseDeps({ commandSession: "root", fusion: postgresFusion(false) }),
    );

    expect(Object.keys(options).toSorted()).toEqual(
      [
        ...SHARED_KEYS,
        "atomicSqlProgramExecutor",
        "nodeProjectionInsertFusion",
        "beforeNodeProjectionInsert",
        "refuseNodeProjectionError",
        "tableExistenceCache",
      ].toSorted(),
    );
    assertSharedValuesPassedThrough(options);
    expect(options.atomicSqlProgramExecutor).toBe(ATOMIC_SQL_PROGRAM_EXECUTOR);
    expect(options.nodeProjectionInsertFusion).toBe(true);
    expect(typeof options.beforeNodeProjectionInsert).toBe("function");
    expect(typeof options.refuseNodeProjectionError).toBe("function");
    expect(options.tableExistenceCache).toEqual({ cacheExisting: false });
    expect("schemaGraphWriteLockNamespace" in options).toBe(false);
    expect("edgeCardinalityInsertFusion" in options).toBe(false);
    expect("nodeClaimInsertFusion" in options).toBe(false);
  });

  it("adds PostgreSQL's transaction-scope-only keys at transaction scope, keeping the atomic executor present", () => {
    const options = buildCommonOperationOptions(
      baseDeps({ commandSession: "transaction", fusion: postgresFusion(true) }),
    );

    expect(Object.keys(options).toSorted()).toEqual(
      [
        ...SHARED_KEYS,
        "atomicSqlProgramExecutor",
        "nodeProjectionInsertFusion",
        "beforeNodeProjectionInsert",
        "refuseNodeProjectionError",
        "tableExistenceCache",
        "schemaGraphWriteLockNamespace",
        "edgeCardinalityInsertFusion",
        "nodeClaimInsertFusion",
      ].toSorted(),
    );
    assertSharedValuesPassedThrough(options);
    expect(options.atomicSqlProgramExecutor).toBe(ATOMIC_SQL_PROGRAM_EXECUTOR);
    expect(options.schemaGraphWriteLockNamespace).toBe(
      "graph-write-lock-namespace",
    );
    expect(options.edgeCardinalityInsertFusion).toBe(true);
    expect(options.nodeClaimInsertFusion).toBe(true);
  });

  it("omits the atomic executor entirely when none is supplied, regardless of dialect or scope", () => {
    const cases = [
      { commandSession: "root", fusion: sqliteFusion() },
      { commandSession: "transaction", fusion: sqliteFusion() },
      { commandSession: "root", fusion: postgresFusion(false) },
      { commandSession: "transaction", fusion: postgresFusion(true) },
    ] as const;

    for (const testCase of cases) {
      const options = buildCommonOperationOptions(
        baseDeps({ ...testCase, atomicSqlProgramExecutor: undefined }),
      );
      expect("atomicSqlProgramExecutor" in options).toBe(false);
    }
  });
});
