import type { GraphBackend, GraphDef, HistoryStoreBackend } from "../../../src";
import type { AdapterBackend } from "../../../src/backend/types";
import type { HistoryStore, Store } from "../../../src/store/store";
import type {
  HistoryStoreOptions,
  LiveStoreOptions,
} from "../../../src/store/types";
import { type IntegrationStore } from "./fixtures";

export type InspectableStore<G extends GraphDef> = Store<G> &
  Readonly<{ backend: GraphBackend }>;

export type InspectableHistoryStore<G extends GraphDef> = HistoryStore<G> &
  Readonly<{ backend: HistoryStoreBackend }>;

/**
 * A backend that runs every statement on ONE connection, plus the teardown for
 * whatever it opened.
 *
 * `close` is the caller's responsibility and is deliberately not folded into
 * the suite's per-test cleanup: the two pooled PostgreSQL lanes fund this with
 * one extra capped connection, and the lane's connection budget is a global,
 * so the connection lives exactly as long as the test that asked for it.
 */
export type SerializedBackendHandle = Readonly<{
  backend: AdapterBackend<unknown>;
  close: () => Promise<void>;
}>;

export type IntegrationTestContext = Readonly<{
  getStore: () => IntegrationStore;
  /**
   * A backend over a SERIALIZED connection for the current lane — one every
   * statement of every wrapper over it lands on.
   *
   * `getBackend()` cannot serve this: on the two server-PostgreSQL lanes it is
   * a default-size pool, which hands out an independent connection per checkout
   * and is therefore audited `independent` on purpose. Any test about what two
   * wrappers on ONE connection do to each other is a no-op there, which is why
   * each lane supplies its own single-connection fixture and why one test
   * asserts that every lane's really is serialized.
   */
  createSerializedBackend: () => Promise<SerializedBackendHandle>;
  /**
   * The adapter backend for the current test, for exercising construction
   * functions (`createVerifiedAdapterStore`, `createAdapterStore`) and
   * schema-read helpers (`getCommittedSchemaVersion`) directly against a
   * backend rather than through the pre-built store.
   */
  getBackend: () => AdapterBackend<unknown>;
  /** Creates an independently-owned backend for branch working copies. */
  createIsolatedBackend: () => Promise<AdapterBackend<unknown>>;
  createStore: <G extends GraphDef>(
    graph: G,
    options?: LiveStoreOptions,
  ) => Promise<InspectableStore<G>>;
  createHistoryStore: <G extends GraphDef>(
    graph: G,
    options?: Omit<HistoryStoreOptions, "history">,
  ) => Promise<InspectableHistoryStore<G>>;
}>;
