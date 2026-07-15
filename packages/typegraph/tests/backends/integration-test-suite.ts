/**
 * Shared Integration Test Suite
 *
 * Tests real query execution against any backend that supports the full
 * TypeGraph query builder interface. All backends (SQLite, PostgreSQL, etc.)
 * must pass these tests.
 *
 * @example
 * ```typescript
 * import { createIntegrationTestSuite } from "./integration-test-suite";
 *
 * createIntegrationTestSuite("SQLite", () => {
 *   const db = createTestDatabase();
 *   return { backend: createSqliteBackend(db) };
 * });
 * ```
 */
import { afterEach, beforeEach, describe } from "vitest";

import { createAdapterStoreWithSchema } from "../../src";
import type { AdapterBackend } from "../../src/backend/types";
import type { IntegrationStore, IntegrationTestContext } from "./integration";
import {
  integrationTestGraph,
  registerAdvancedEdgePropertyIntegrationTests,
  registerAggregateIntegrationTests,
  registerAlgorithmIntegrationTests,
  registerBulkFindByIndexIntegrationTests,
  registerCoalesceUpsertIntegrationTests,
  registerCrossBackendConsistencyTests,
  registerEdgeCaseIntegrationTests,
  registerEdgeOperationIntegrationTests,
  registerEdgePropertyIntegrationTests,
  registerFulltextIntegrationTests,
  registerIdentityIntegrationTests,
  registerImportUniquenessIntegrationTests,
  registerLateMaterializationIntegrationTests,
  registerOrderingIntegrationTests,
  registerPaginationIntegrationTests,
  registerPredicateIntegrationTests,
  registerProvenanceIntegrationTests,
  registerRecordedReadBindingIntegrationTests,
  registerRecordedTimeIntegrationTests,
  registerRecursiveIntegrationTests,
  registerSetOperationIntegrationTests,
  registerStoreViewIntegrationTests,
  registerSubgraphIntegrationTests,
  registerTemporalIntegrationTests,
  registerTransactionReceiptIntegrationTests,
  registerTraversalIntegrationTests,
  registerTrustedImportIntegrationTests,
} from "./integration";

/**
 * Result from a backend factory, including optional cleanup function.
 */
type BackendFactoryResult<TNativeTransaction> = Readonly<{
  backend: AdapterBackend<TNativeTransaction>;
  /** Optional cleanup function called after each test (e.g., to close connection pools) */
  cleanup?: () => void | Promise<void>;
}>;

/**
 * Factory function that creates a fresh backend for each test.
 * Returns the backend and an optional cleanup function for resource management.
 * May be async (e.g. for libsql which requires async DDL setup).
 */
type BackendFactory<TNativeTransaction> = () =>
  | BackendFactoryResult<TNativeTransaction>
  | Promise<BackendFactoryResult<TNativeTransaction>>;

/**
 * Options for the integration test suite.
 */
type IntegrationTestSuiteOptions = Readonly<{
  /** Skip tests that require specific dialect features */
  skipDialectSpecific?: boolean;
}>;

/**
 * Creates an integration test suite for a backend implementation.
 *
 * @param name - Display name for the backend (e.g., "SQLite", "PostgreSQL")
 * @param createBackend - Factory function that returns a fresh backend
 * @param options - Optional test configuration
 */
export function createIntegrationTestSuite<TNativeTransaction>(
  name: string,
  createBackend: BackendFactory<TNativeTransaction>,
  _options: IntegrationTestSuiteOptions = {},
): void {
  describe(`${name} Integration Tests`, () => {
    let store: IntegrationStore | undefined;
    let adapterBackend: AdapterBackend<TNativeTransaction> | undefined;
    let cleanup: (() => void | Promise<void>) | undefined;

    const context = {
      getStore: () => {
        if (store === undefined) {
          throw new Error(
            "Integration store is not initialized. This indicates a test suite wiring bug.",
          );
        }
        return store;
      },
      createStore: async (graph, options) => {
        if (adapterBackend === undefined) {
          throw new Error("Integration backend is not initialized.");
        }
        const [createdStore] = await createAdapterStoreWithSchema(
          graph,
          adapterBackend,
          options,
        );
        return createdStore;
      },
      createHistoryStore: async (graph, options) => {
        if (adapterBackend === undefined) {
          throw new Error("Integration backend is not initialized.");
        }
        const [createdStore] = await createAdapterStoreWithSchema(
          graph,
          adapterBackend,
          { ...options, history: true },
        );
        return createdStore;
      },
    } as const satisfies IntegrationTestContext;

    beforeEach(async () => {
      const result = await createBackend();
      adapterBackend = result.backend;
      // #135: createStoreWithSchema is the canonical durable-marker
      // writer. The shared fulltext suite exercises fulltext ops, which
      // now (correctly) require materialization at boot.
      [store] = await createAdapterStoreWithSchema(
        integrationTestGraph,
        result.backend,
      );
      cleanup = result.cleanup;
    });

    afterEach(async () => {
      if (cleanup) {
        await cleanup();
        cleanup = undefined;
      }
    });

    registerAggregateIntegrationTests(context);
    registerBulkFindByIndexIntegrationTests(context);
    registerCoalesceUpsertIntegrationTests(context);
    registerPredicateIntegrationTests(context);
    registerProvenanceIntegrationTests(context);
    registerOrderingIntegrationTests(context);
    registerLateMaterializationIntegrationTests(context);
    registerTemporalIntegrationTests(context);
    registerTransactionReceiptIntegrationTests(context);
    registerRecordedTimeIntegrationTests(context);
    registerRecordedReadBindingIntegrationTests(context);
    registerSetOperationIntegrationTests(context);
    registerEdgeOperationIntegrationTests(context);
    registerRecursiveIntegrationTests(context);
    registerPaginationIntegrationTests(context);
    registerTraversalIntegrationTests(context);
    registerEdgePropertyIntegrationTests(context);
    registerAdvancedEdgePropertyIntegrationTests(context);
    registerSubgraphIntegrationTests(context);
    registerStoreViewIntegrationTests(context);
    registerAlgorithmIntegrationTests(context);
    registerFulltextIntegrationTests(context);
    registerImportUniquenessIntegrationTests(context);
    registerIdentityIntegrationTests(context);
    registerEdgeCaseIntegrationTests(context);
    registerCrossBackendConsistencyTests(context);
    registerTrustedImportIntegrationTests(context);
  });
}
