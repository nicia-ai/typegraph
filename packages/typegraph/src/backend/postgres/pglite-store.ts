/**
 * Batteries-included local PostgreSQL Store backed by PGlite.
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
import { createPostgresTables } from "../drizzle/schema/postgres";
import { closeAfterFailure } from "../types";
import { createLocalPgliteBackend } from "./pglite";

export type LocalPgliteStoreOptions<
  TStoreOptions extends StoreOptions = StoreOptions,
> = Readonly<{
  /** PGlite data directory. Defaults to an in-memory database. */
  dataDir?: string;
  /** Whether to load pgvector. Defaults to true. */
  vector?: boolean;
  /** Store behavior, including hooks, history, and custom table names. */
  store?: TStoreOptions;
  /** Schema initialization and migration policy. */
  schemaManagement?: SchemaManagerOptions;
}>;

/** Creates, provisions, and returns a full typed local PGlite Store. */
export function createLocalPgliteStore<G extends GraphDef>(
  graph: G,
  options?: LocalPgliteStoreOptions<UnboundLiveStoreOptions>,
): Promise<Store<G>>;
export function createLocalPgliteStore<G extends GraphDef>(
  graph: G,
  options: LocalPgliteStoreOptions<HistoryStoreOptions> &
    Readonly<{ store: HistoryStoreOptions }>,
): Promise<HistoryStore<G>>;
export function createLocalPgliteStore<G extends GraphDef>(
  graph: G,
  options: LocalPgliteStoreOptions<RecordedReadStoreOptions> &
    Readonly<{ store: RecordedReadStoreOptions }>,
): Promise<RecordedReadStore<G>>;
export function createLocalPgliteStore<G extends GraphDef>(
  graph: G,
  options: LocalPgliteStoreOptions<LiveStoreOptions>,
): Promise<Store<G> | RecordedReadStore<G>>;
export function createLocalPgliteStore<G extends GraphDef>(
  graph: G,
  options: LocalPgliteStoreOptions,
): Promise<Store<G> | HistoryStore<G> | RecordedReadStore<G>>;
export async function createLocalPgliteStore<G extends GraphDef>(
  graph: G,
  options: LocalPgliteStoreOptions = {},
): Promise<Store<G> | HistoryStore<G> | RecordedReadStore<G>> {
  const tables =
    options.store?.schema === undefined ?
      undefined
    : createPostgresTables(options.store.schema.tables);
  const { backend } = await createLocalPgliteBackend({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.vector === false ? { vector: false as const } : {}),
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
