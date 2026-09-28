import { describe, expect, it } from "vitest";

import {
  createCommonOperationBackend,
  type OperationBackendBatchConfig,
} from "../src/backend/drizzle/operation-backend-core";
import {
  type CommonOperationStrategy,
  createSqliteOperationStrategy,
} from "../src/backend/drizzle/operations/strategy";
import { createSqliteTables } from "../src/backend/drizzle/schema/sqlite";

const BATCH_CONFIG: OperationBackendBatchConfig = {
  checkUniqueBatchChunkSize: 10,
  edgeInsertBatchSize: 10,
  edgeSchemaFencedInsertBatchSize: 10,
  findEdgesEndpointChunkSize: 10,
  getEdgesChunkSize: 10,
  getNodesChunkSize: 10,
  nodeInsertBatchSize: 10,
  nodeSchemaFencedInsertBatchSize: 10,
  uniqueDeleteChunkSize: 10,
  uniqueInsertBatchSize: 10,
};

function operationBackend(strategy: CommonOperationStrategy) {
  return createCommonOperationBackend({
    batchConfig: BATCH_CONFIG,
    commandSession: "root",
    execution: {
      compile: () => {
        throw new Error("No SQL expected");
      },
      execAll: () => Promise.resolve([]),
      execGet: () => Promise.resolve(undefined),
      execRun: () => Promise.resolve(),
    },
    maxBindParameters: 999,
    operationStrategy: strategy,
    rowMappers: {
      toEdgeRow: () => {
        throw new Error("No edge rows expected");
      },
      toNodeRow: () => {
        throw new Error("No node rows expected");
      },
      toSchemaVersionRow: () => {
        throw new Error("No schema rows expected");
      },
      toUniqueRow: () => {
        throw new Error("No unique rows expected");
      },
    },
  });
}

describe("optional operation read compatibility", () => {
  it("omits optional reads when a custom strategy has no builders", () => {
    const bundled = createSqliteOperationStrategy(
      createSqliteTables(),
      undefined,
    );
    const {
      buildFindNodesAcrossKinds,
      buildFindEdgesAcrossKinds,
      buildFindActiveEdgesBySourceV1,
      ...legacy
    } = bundled;
    expect(buildFindNodesAcrossKinds).toBeTypeOf("function");
    expect(buildFindEdgesAcrossKinds).toBeTypeOf("function");
    expect(buildFindActiveEdgesBySourceV1).toBeTypeOf("function");
    const legacyStrategy: CommonOperationStrategy = legacy;

    const legacyBackend = operationBackend(legacyStrategy);
    expect(legacyBackend.findNodesAcrossKinds).toBeUndefined();
    expect(legacyBackend.findEdgesAcrossKinds).toBeUndefined();
    expect(legacyBackend.findActiveEdgesBySourceV1).toBeUndefined();

    const bundledBackend = operationBackend(bundled);
    expect(bundledBackend.findNodesAcrossKinds).toBeTypeOf("function");
    expect(bundledBackend.findEdgesAcrossKinds).toBeTypeOf("function");
    expect(bundledBackend.findActiveEdgesBySourceV1).toBeTypeOf("function");
  });
});
