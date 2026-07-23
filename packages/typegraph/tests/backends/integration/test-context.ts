import type { GraphBackend, GraphDef, HistoryStoreBackend } from "../../../src";
import type { AdapterBackend } from "../../../src/backend/types";
import type { HistoryStore, Store } from "../../../src/store/store";
import type {
  HistoryStoreOptions,
  LiveStoreOptions,
} from "../../../src/store/types";
import { type IntegrationStore } from "./fixtures";

type InspectableStore<G extends GraphDef> = Store<G> &
  Readonly<{ backend: GraphBackend }>;

type InspectableHistoryStore<G extends GraphDef> = HistoryStore<G> &
  Readonly<{ backend: HistoryStoreBackend }>;

export type IntegrationTestContext = Readonly<{
  getStore: () => IntegrationStore;
  /**
   * The adapter backend for the current test, for exercising construction
   * functions (`createVerifiedAdapterStore`, `createAdapterStore`) and
   * schema-read helpers (`getCommittedSchemaVersion`) directly against a
   * backend rather than through the pre-built store.
   */
  getBackend: () => AdapterBackend<unknown>;
  createStore: <G extends GraphDef>(
    graph: G,
    options?: LiveStoreOptions,
  ) => Promise<InspectableStore<G>>;
  createHistoryStore: <G extends GraphDef>(
    graph: G,
    options?: Omit<HistoryStoreOptions, "history">,
  ) => Promise<InspectableHistoryStore<G>>;
}>;
