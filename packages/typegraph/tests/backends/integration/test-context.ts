import type { GraphBackend, GraphDef, HistoryStoreBackend } from "../../../src";
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

export type IntegrationTestContext = Readonly<{
  getStore: () => IntegrationStore;
  createStore: <G extends GraphDef>(
    graph: G,
    options?: LiveStoreOptions,
  ) => Promise<InspectableStore<G>>;
  createHistoryStore: <G extends GraphDef>(
    graph: G,
    options?: Omit<HistoryStoreOptions, "history">,
  ) => Promise<InspectableHistoryStore<G>>;
}>;
