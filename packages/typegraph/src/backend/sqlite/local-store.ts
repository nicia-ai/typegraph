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

export type { GraphIdentityConfig } from "../../core/define-graph";
export type {
  IdentityAssertion,
  IdentityAssertionId,
  IdentityAssertionResult,
  IdentityFacade,
  IdentityNode,
  IdentityNodeRefInput,
  IdentityPair,
  IdentityReadFacade,
  IdentityRelation,
  IdentityWriteSummary,
} from "../../identity";
export type {
  ContributionDiagnostic,
  ContributionDiagnosticState,
  ContributionRepairEntry,
  ContributionRepairResult,
} from "../types";
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
  /**
   * Schema initialization and migration policy. `schema` is excluded here:
   * the effective SqlSchema has exactly one source — `store.schema` — which
   * this constructor also uses to provision the physical tables, so a
   * second schema could name tables that were never created.
   */
  schemaManagement?: Omit<SchemaManagerOptions, "schema">;
}>;

/**
 * Drops a smuggled `schema` from the nested schema-management options: the
 * effective `SqlSchema` has exactly one source (`store.schema`), which also
 * drives physical table provisioning in this constructor.
 */
function withoutSchemaOverride(
  schemaManagement: Omit<SchemaManagerOptions, "schema"> | undefined,
): Omit<SchemaManagerOptions, "schema"> {
  if (schemaManagement === undefined) return {};
  const { schema: smuggled, ...rest } =
    schemaManagement as SchemaManagerOptions;
  void smuggled;
  return rest;
}

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
      // The type already excludes `schema` here; the runtime strip guards
      // untyped callers, so the provisioned schema (or the default tables)
      // can never diverge from the one the Store reads.
      ...withoutSchemaOverride(options.schemaManagement),
    });
    return store;
  } catch (error) {
    return closeAfterFailure(backend, error);
  }
}
