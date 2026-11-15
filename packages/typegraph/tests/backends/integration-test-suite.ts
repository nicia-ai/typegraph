/**
 * Shared Integration Test Suite
 *
 * Tests real query execution against any backend that supports the full
 * TypeGraph query builder interface. All backends (SQLite, PostgreSQL, etc.)
 * must pass these tests.
 *
 * The suite's contents and their assignment to slices live in
 * `integration-registrations.ts`; each backend lane calls this once per slice
 * file (see "Integration Tests" in `docs/TESTING.md`).
 *
 * @example
 * ```typescript
 * import { createIntegrationTestSuite } from "./integration-test-suite";
 *
 * createIntegrationTestSuite(
 *   "SQLite",
 *   () => {
 *     const db = createTestDatabase();
 *     return {
 *       backend: createSqliteBackend(db),
 *       createSerializedBackend: () => {
 *         const { backend } = createLocalSqliteBackend();
 *         return Promise.resolve({ backend, close: () => backend.close() });
 *       },
 *     };
 *   },
 *   { slice: { index: 0, count: 2 } },
 * );
 * ```
 */
import { afterEach, beforeEach, describe } from "vitest";

import { createAdapterStoreWithSchema } from "../../src";
import type { AdapterBackend } from "../../src/backend/types";
import {
  type IntegrationStore,
  type IntegrationTestContext,
  integrationTestGraph,
} from "./integration";
import type {
  InspectableHistoryStore,
  SerializedBackendHandle,
  SerializedBackendOverrides,
} from "./integration/test-context";
import {
  type IntegrationSuiteSlice,
  selectIntegrationRegistrations,
} from "./integration-registrations";

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
  createSerializedBackend: (overrides?: SerializedBackendOverrides) => Promise<
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
  /**
   * Which part of the suite this file registers. Required: vitest parallelizes
   * and shards by file, so a lane states its slices explicitly rather than
   * falling back to the whole suite in one serial file.
   */
  slice: IntegrationSuiteSlice;
  /** Skip tests that require specific dialect features */
  skipDialectSpecific?: boolean;
  /**
   * Creates a physically isolated backend for concurrently live working
   * copies. Defaults to the suite backend factory when that factory already
   * owns independent storage (for example, in-memory SQLite).
   */
  createIsolatedBackend?: IsolatedBackendFactory<TIsolatedTransaction>;
  /**
   * Whether this lane's `createSerializedBackend` hands out genuinely
   * independent physical connections — see
   * {@link IntegrationTestContext.serverLaneConcurrency}. Defaults to
   * `false`; only the two server-PostgreSQL lane registrations set it to
   * `true`.
   */
  serverLaneConcurrency?: boolean;
}>;

/**
 * Creates an integration test suite for a backend implementation.
 *
 * @param name - Display name for the backend (e.g., "SQLite", "PostgreSQL")
 * @param createBackend - Factory function that returns a fresh backend
 * @param options - The slice of the suite to register, plus lane configuration
 */
export function createIntegrationTestSuite<
  TNativeTransaction,
  TIsolatedTransaction = TNativeTransaction,
>(
  name: string,
  createBackend: BackendFactory<TNativeTransaction>,
  options: IntegrationTestSuiteOptions<TIsolatedTransaction>,
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
      createSerializedBackend: async (
        overrides?: SerializedBackendOverrides,
      ): Promise<SerializedBackendHandle> => {
        if (openSerializedBackend === undefined) {
          throw new Error("Integration backend is not initialized.");
        }
        const handle = await openSerializedBackend(overrides);
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
      serverLaneConcurrency: options.serverLaneConcurrency ?? false,
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

    for (const registration of selectIntegrationRegistrations(options.slice)) {
      registration.register(context);
    }
  });
}
