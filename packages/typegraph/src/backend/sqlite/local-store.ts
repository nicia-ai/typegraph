/**
 * Batteries-included local SQLite Store for strict TypeScript consumers.
 *
 * This entrypoint owns the connection and intentionally exposes the portable
 * TypeGraph Store surface rather than the adapter-native Drizzle handle.
 */
import { type GraphDef } from "../../core/define-graph";
import { type SchemaManagerOptions } from "../../schema/manager";
import {
  createStoreWithSchema,
  type HistoryStore,
  type RecordedReadStore,
  type Store,
} from "../../store/store";
import {
  type HistoryStoreOptions,
  type LiveStoreOptions,
  type RecordedReadStoreOptions,
  type StoreOptions,
  type UnboundLiveStoreOptions,
} from "../../store/types";
import { createSqliteTables } from "../drizzle/schema/sqlite";
import { type BackendCapabilities, closeAfterFailure } from "../types";
import { createLocalSqliteBackend } from "./local";
import { type LocalSqlitePragmaOptions } from "./local-options";

export {
  DEFAULT_LOCAL_SQLITE_PRAGMAS,
  type LocalSqliteJournalMode,
  type LocalSqlitePragmaOptions,
  type LocalSqliteSynchronousMode,
} from "./local-options";

export type LocalSqliteStoreOptions<
  TStoreOptions extends StoreOptions = StoreOptions,
> = Readonly<{
  /** SQLite file path. Defaults to an in-memory database. */
  path?: string;
  /** Connection pragmas applied when the owned database is opened. */
  pragmas?: LocalSqlitePragmaOptions | false;
  /** Optional backend capability overrides, primarily for controlled hosts. */
  capabilities?: Partial<BackendCapabilities>;
  /** Store behavior, including hooks, history, and custom table names. */
  store?: TStoreOptions;
  /** Schema initialization and migration policy. */
  schemaManagement?: SchemaManagerOptions;
}>;

/** Creates, provisions, and returns a full typed local SQLite Store. */
export function createLocalSqliteStore<G extends GraphDef>(
  graph: G,
  options?: LocalSqliteStoreOptions<UnboundLiveStoreOptions>,
): Promise<Store<G>>;
export function createLocalSqliteStore<G extends GraphDef>(
  graph: G,
  options: LocalSqliteStoreOptions<HistoryStoreOptions> &
    Readonly<{ store: HistoryStoreOptions }>,
): Promise<HistoryStore<G>>;
export function createLocalSqliteStore<G extends GraphDef>(
  graph: G,
  options: LocalSqliteStoreOptions<RecordedReadStoreOptions> &
    Readonly<{ store: RecordedReadStoreOptions }>,
): Promise<RecordedReadStore<G>>;
export function createLocalSqliteStore<G extends GraphDef>(
  graph: G,
  options: LocalSqliteStoreOptions<LiveStoreOptions>,
): Promise<Store<G> | RecordedReadStore<G>>;
export function createLocalSqliteStore<G extends GraphDef>(
  graph: G,
  options: LocalSqliteStoreOptions,
): Promise<Store<G> | HistoryStore<G> | RecordedReadStore<G>>;
export async function createLocalSqliteStore<G extends GraphDef>(
  graph: G,
  options: LocalSqliteStoreOptions = {},
): Promise<Store<G> | HistoryStore<G> | RecordedReadStore<G>> {
  const tables =
    options.store?.schema === undefined ?
      undefined
    : createSqliteTables(options.store.schema.tables);
  const { backend } = createLocalSqliteBackend({
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.pragmas === undefined ? {} : { pragmas: options.pragmas }),
    ...(options.capabilities === undefined ?
      {}
    : { capabilities: options.capabilities }),
    ...(tables === undefined ? {} : { tables }),
  });
  try {
    const [store] = await createStoreWithSchema(graph, backend, {
      ...options.store,
      ...options.schemaManagement,
    });
    return store;
  } catch (error) {
    return closeAfterFailure(backend, error);
  }
}
