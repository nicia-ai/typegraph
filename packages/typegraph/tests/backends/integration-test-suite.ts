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

import { createStore } from "../../src";
import type { GraphBackend } from "../../src/backend/types";
import type { IntegrationStore, IntegrationTestContext } from "./integration";
import {
  integrationTestGraph,
  registerAdvancedEdgePropertyIntegrationTests,
  registerAggregateIntegrationTests,
  registerCrossBackendConsistencyTests,
  registerEdgeCaseIntegrationTests,
  registerEdgeOperationIntegrationTests,
  registerEdgePropertyIntegrationTests,
  registerOrderingIntegrationTests,
  registerPaginationIntegrationTests,
  registerPredicateIntegrationTests,
  registerRecursiveIntegrationTests,
  registerSetOperationIntegrationTests,
  registerTemporalIntegrationTests,
  registerTraversalIntegrationTests,
} from "./integration";

/**
 * Result from a backend factory, including optional cleanup function.
 */
type BackendFactoryResult = Readonly<{
  backend: GraphBackend;
  /** Optional cleanup function called after each test (e.g., to close connection pools) */
  cleanup?: () => void | Promise<void>;
}>;

/**
 * Factory function that creates a fresh backend for each test.
 * Returns the backend and an optional cleanup function for resource management.
 */
type BackendFactory = () => BackendFactoryResult;

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
export function createIntegrationTestSuite(
  name: string,
  createBackend: BackendFactory,
  _options: IntegrationTestSuiteOptions = {},
): void {
  describe(`${name} Integration Tests`, () => {
    let store: IntegrationStore | undefined;
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
    } as const satisfies IntegrationTestContext;

    beforeEach(() => {
      const result = createBackend();
      store = createStore(integrationTestGraph, result.backend);
      cleanup = result.cleanup;
    });

    afterEach(async () => {
      if (cleanup) {
        await cleanup();
        cleanup = undefined;
      }
    });

    registerAggregateIntegrationTests(context);
    registerPredicateIntegrationTests(context);
    registerOrderingIntegrationTests(context);
    registerTemporalIntegrationTests(context);
    registerSetOperationIntegrationTests(context);
    registerEdgeOperationIntegrationTests(context);
    registerRecursiveIntegrationTests(context);
    registerPaginationIntegrationTests(context);
    registerTraversalIntegrationTests(context);
    registerEdgePropertyIntegrationTests(context);
    registerAdvancedEdgePropertyIntegrationTests(context);
    registerEdgeCaseIntegrationTests(context);
    registerCrossBackendConsistencyTests(context);
  });
}
