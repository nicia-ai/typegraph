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
 *   return {
 *     backend: createSqliteBackend(db),
 *     createSerializedBackend: () => {
 *       const { backend } = createLocalSqliteBackend();
 *       return Promise.resolve({ backend, close: () => backend.close() });
 *     },
 *   };
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
  registerBackendProvenanceIntegrationTests,
  registerBulkFindByIndexIntegrationTests,
  registerBulkFindEndpointIntegrationTests,
  registerBulkFindHeterogeneousIntegrationTests,
  registerBulkUpsertRepeatedIdIntegrationTests,
  registerCapabilityBundleNoThrowIntegrationTests,
  registerCapabilityMemberDropMatrixIntegrationTests,
  registerCapabilityPortBindingIntegrationTests,
  registerCapabilityRefusalIntegrationTests,
  registerClaimCompensationIntegrationTests,
  registerClaimLookupPreferenceIntegrationTests,
  registerClaimOwnerIdentityIntegrationTests,
  registerCoalesceUpsertIntegrationTests,
  registerConstraintFenceErrorIntegrationTests,
  registerConstraintFenceTransactionHealthTests,
  registerConstraintFenceVerificationIntegrationTests,
  registerContributionDiagnosticIntegrationTests,
  registerCrossBackendConsistencyTests,
  registerCurrentIdentityTraversalTests,
  registerDurableEdgeMatchIdentityIntegrationTests,
  registerEdgeCaseIntegrationTests,
  registerEdgeClaimSelfHealIntegrationTests,
  registerEdgeOperationIntegrationTests,
  registerEdgePropertyIntegrationTests,
  registerFulltextIntegrationTests,
  registerGraphAnnotationsIntegrationTests,
  registerGraphMergePlanIntegrationTests,
  registerHistoricalIdentityTraversalTests,
  registerIdentityImportIntegrationTests,
  registerIdentityIntegrationTests,
  registerIdentitySeparationIntegrationTests,
  registerImportUniquenessIntegrationTests,
  registerLateMaterializationIntegrationTests,
  registerLegacyClaimAxisIntegrationTests,
  registerMigrateSchemaKindIntegrationTests,
  registerOrderingIntegrationTests,
  registerPaginationIntegrationTests,
  registerPredicateIntegrationTests,
  registerProvenanceIntegrationTests,
  registerQueryHookIntegrationTests,
  registerReconciledSchemaIntegrationTests,
  registerRecordedReadBindingIntegrationTests,
  registerRecordedTimeIntegrationTests,
  registerRecursiveIntegrationTests,
  registerRemovalMaterializationIntegrationTests,
  registerSelectiveRetryIntegrationTests,
  registerSetNodeMutationIntegrationTests,
  registerSetOperationIntegrationTests,
  registerStoreAnalysisIntegrationTests,
  registerStoreViewIntegrationTests,
  registerSubgraphIntegrationTests,
  registerTemporalIntegrationTests,
  registerTemporalOracleIntegrationTests,
  registerTransactionReceiptIntegrationTests,
  registerTraversalIntegrationTests,
  registerTrustedImportIntegrationTests,
  registerValidityEndClearingIntegrationTests,
  registerValidityLowerBoundIntegrationTests,
  registerWeightedShortestPathExtractionIntegrationTests,
} from "./integration";
import type {
  InspectableHistoryStore,
  SerializedBackendHandle,
} from "./integration/test-context";

/**
 * Result from a backend factory, including optional cleanup function.
 */
type BackendFactoryResult<TNativeTransaction> = Readonly<{
  backend: AdapterBackend<TNativeTransaction>;
  /** Optional cleanup function called after each test (e.g., to close connection pools) */
  cleanup?: () => void | Promise<void>;
  /**
   * Opens a backend on a SERIALIZED connection for this lane — see
   * {@link IntegrationTestContext.createSerializedBackend}.
   *
   * Required, not optional: a lane allowed to omit it would silently turn every
   * shared-connection assertion in the suite into a no-op on exactly the
   * backends whose answer differs. The type checker asks each lane instead.
   */
  createSerializedBackend: () => Promise<
    Readonly<{
      backend: AdapterBackend<TNativeTransaction>;
      close: () => Promise<void>;
    }>
  >;
}>;

/**
 * Factory function that creates a fresh backend for each test.
 * Returns the backend and an optional cleanup function for resource management.
 * May be async (e.g. for libsql which requires async DDL setup).
 */
type BackendFactory<TNativeTransaction> = () =>
  | BackendFactoryResult<TNativeTransaction>
  | Promise<BackendFactoryResult<TNativeTransaction>>;

type IsolatedBackendFactoryResult<TNativeTransaction> = Omit<
  BackendFactoryResult<TNativeTransaction>,
  "createSerializedBackend"
>;

type IsolatedBackendFactory<TNativeTransaction> = () =>
  | IsolatedBackendFactoryResult<TNativeTransaction>
  | Promise<IsolatedBackendFactoryResult<TNativeTransaction>>;

/**
 * Options for the integration test suite.
 */
type IntegrationTestSuiteOptions<TIsolatedTransaction> = Readonly<{
  /** Skip tests that require specific dialect features */
  skipDialectSpecific?: boolean;
  /**
   * Creates a physically isolated backend for concurrently live working
   * copies. Defaults to the suite backend factory when that factory already
   * owns independent storage (for example, in-memory SQLite).
   */
  createIsolatedBackend?: IsolatedBackendFactory<TIsolatedTransaction>;
}>;

/**
 * Creates an integration test suite for a backend implementation.
 *
 * @param name - Display name for the backend (e.g., "SQLite", "PostgreSQL")
 * @param createBackend - Factory function that returns a fresh backend
 * @param options - Optional test configuration
 */
export function createIntegrationTestSuite<
  TNativeTransaction,
  TIsolatedTransaction = TNativeTransaction,
>(
  name: string,
  createBackend: BackendFactory<TNativeTransaction>,
  options: IntegrationTestSuiteOptions<TIsolatedTransaction> = {},
): void {
  describe(`${name} Integration Tests`, () => {
    let store: IntegrationStore | undefined;
    let adapterBackend: AdapterBackend<TNativeTransaction> | undefined;
    let cleanup: (() => void | Promise<void>) | undefined;
    const isolatedCleanups: (() => void | Promise<void>)[] = [];
    let openSerializedBackend:
      | BackendFactoryResult<TNativeTransaction>["createSerializedBackend"]
      | undefined;

    const context = {
      getStore: () => {
        if (store === undefined) {
          throw new Error(
            "Integration store is not initialized. This indicates a test suite wiring bug.",
          );
        }
        return store;
      },
      getBackend: () => {
        if (adapterBackend === undefined) {
          throw new Error("Integration backend is not initialized.");
        }
        return adapterBackend as AdapterBackend<unknown>;
      },
      createIsolatedBackend: async () => {
        const result =
          options.createIsolatedBackend === undefined ?
            await createBackend()
          : await options.createIsolatedBackend();
        if (result.cleanup !== undefined) isolatedCleanups.push(result.cleanup);
        return result.backend as AdapterBackend<unknown>;
      },
      createSerializedBackend: async (): Promise<SerializedBackendHandle> => {
        if (openSerializedBackend === undefined) {
          throw new Error("Integration backend is not initialized.");
        }
        const handle = await openSerializedBackend();
        // Same erasure `getBackend` performs, for the same reason:
        // `AdapterBackend` is invariant in its native-transaction parameter, and
        // the shared suite is written against every lane at once.
        return {
          backend: handle.backend as AdapterBackend<unknown>,
          close: handle.close,
        };
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
        return createdStore as unknown as InspectableHistoryStore<typeof graph>;
      },
    } as const satisfies IntegrationTestContext;

    beforeEach(async () => {
      const result = await createBackend();
      adapterBackend = result.backend;
      openSerializedBackend = result.createSerializedBackend;
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
      for (const isolatedCleanup of isolatedCleanups.splice(0).toReversed()) {
        await isolatedCleanup();
      }
      if (cleanup) {
        await cleanup();
        cleanup = undefined;
      }
    });

    registerAggregateIntegrationTests(context);
    registerBackendProvenanceIntegrationTests(context);
    registerBulkFindByIndexIntegrationTests(context);
    registerBulkFindEndpointIntegrationTests(context);
    registerBulkFindHeterogeneousIntegrationTests(context);
    registerBulkUpsertRepeatedIdIntegrationTests(context);
    registerCapabilityBundleNoThrowIntegrationTests(context);
    registerCapabilityMemberDropMatrixIntegrationTests(context);
    registerCapabilityPortBindingIntegrationTests(context);
    registerCapabilityRefusalIntegrationTests(context);
    registerCoalesceUpsertIntegrationTests(context);
    registerGraphAnnotationsIntegrationTests(context);
    registerValidityLowerBoundIntegrationTests(context);
    registerValidityEndClearingIntegrationTests(context);
    registerContributionDiagnosticIntegrationTests(context);
    registerPredicateIntegrationTests(context);
    registerProvenanceIntegrationTests(context);
    registerQueryHookIntegrationTests(context);
    registerOrderingIntegrationTests(context);
    registerLateMaterializationIntegrationTests(context);
    registerTemporalIntegrationTests(context);
    registerTemporalOracleIntegrationTests(context);
    registerTransactionReceiptIntegrationTests(context);
    registerMigrateSchemaKindIntegrationTests(context);
    registerReconciledSchemaIntegrationTests(context);
    registerRecordedTimeIntegrationTests(context);
    registerRemovalMaterializationIntegrationTests(context);
    registerLegacyClaimAxisIntegrationTests(context);
    registerClaimOwnerIdentityIntegrationTests(context);
    registerClaimCompensationIntegrationTests(context);
    registerClaimLookupPreferenceIntegrationTests(context);
    registerConstraintFenceErrorIntegrationTests(context);
    registerConstraintFenceTransactionHealthTests(context);
    registerConstraintFenceVerificationIntegrationTests(context);
    registerRecordedReadBindingIntegrationTests(context);
    registerSetOperationIntegrationTests(context);
    registerSetNodeMutationIntegrationTests(context);
    registerSelectiveRetryIntegrationTests(context);
    registerEdgeOperationIntegrationTests(context);
    registerRecursiveIntegrationTests(context);
    registerPaginationIntegrationTests(context);
    registerTraversalIntegrationTests(context);
    registerEdgePropertyIntegrationTests(context);
    registerAdvancedEdgePropertyIntegrationTests(context);
    registerSubgraphIntegrationTests(context);
    registerStoreViewIntegrationTests(context);
    registerStoreAnalysisIntegrationTests(context);
    registerAlgorithmIntegrationTests(context);
    registerWeightedShortestPathExtractionIntegrationTests(context);
    registerFulltextIntegrationTests(context);
    registerGraphMergePlanIntegrationTests(context);
    registerImportUniquenessIntegrationTests(context);
    registerIdentityIntegrationTests(context);
    registerIdentityImportIntegrationTests(context);
    registerHistoricalIdentityTraversalTests(context);
    registerCurrentIdentityTraversalTests(context);
    registerIdentitySeparationIntegrationTests(context);
    registerEdgeCaseIntegrationTests(context);
    registerEdgeClaimSelfHealIntegrationTests(context);
    registerCrossBackendConsistencyTests(context);
    registerDurableEdgeMatchIdentityIntegrationTests(context);
    registerTrustedImportIntegrationTests(context);
  });
}
