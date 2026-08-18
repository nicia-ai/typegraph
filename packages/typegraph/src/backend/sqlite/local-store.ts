/**
 * Batteries-included local SQLite Store for strict TypeScript consumers.
 *
 * This entrypoint owns the connection and intentionally exposes the portable
 * TypeGraph Store surface rather than the adapter-native Drizzle handle.
 */
import { type GraphDef } from "../../core/define-graph";
import { type SchemaManagerOptions } from "../../schema/manager";
import {
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
import { loadDrizzleBackedModule } from "../missing-peer-ledger";
import { type BackendCapabilities } from "../types";
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
  const impl = await loadDrizzleBackedModule(
    "./sqlite/local",
    () => import("./local-store-impl"),
  );
  return impl.createLocalSqliteStoreImpl(graph, options);
}
