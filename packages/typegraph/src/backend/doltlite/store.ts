import { type GraphDef } from "../../core/define-graph";
import {
  type HistoryStore,
  type RecordedReadStore,
  type Store,
} from "../../store/store";
import {
  type HistoryStoreOptions,
  type RecordedReadStoreOptions,
  type StoreOptions,
  type UnboundLiveStoreOptions,
} from "../../store/types";
import { loadDrizzleBackedModule } from "../missing-peer-ledger";
import { type LocalSqliteStoreOptions } from "../sqlite/local-store";

export type DoltliteStoreOptions<T extends StoreOptions = StoreOptions> = Pick<
  LocalSqliteStoreOptions<T>,
  "store" | "schemaManagement" | "fulltext" | "capabilities"
> &
  Readonly<{
    path?: string;
    branch?: string;
    busyTimeoutMs?: number;
    vector?: false;
  }>;

export function createDoltliteStore<G extends GraphDef>(
  graph: G,
  options?: DoltliteStoreOptions<UnboundLiveStoreOptions>,
): Promise<Store<G>>;
export function createDoltliteStore<G extends GraphDef>(
  graph: G,
  options: DoltliteStoreOptions<HistoryStoreOptions> &
    Readonly<{ store: HistoryStoreOptions }>,
): Promise<HistoryStore<G>>;
export function createDoltliteStore<G extends GraphDef>(
  graph: G,
  options: DoltliteStoreOptions<RecordedReadStoreOptions> &
    Readonly<{ store: RecordedReadStoreOptions }>,
): Promise<RecordedReadStore<G>>;
export function createDoltliteStore<G extends GraphDef>(
  graph: G,
  options: DoltliteStoreOptions,
): Promise<Store<G> | HistoryStore<G> | RecordedReadStore<G>>;
export async function createDoltliteStore<G extends GraphDef>(
  graph: G,
  options: DoltliteStoreOptions = {},
): Promise<Store<G> | HistoryStore<G> | RecordedReadStore<G>> {
  const module = await loadDrizzleBackedModule(
    "./doltlite",
    () => import("./store-impl"),
    ["@dolthub/doltlite"],
  );
  return module.createDoltliteStoreImpl(graph, options);
}
