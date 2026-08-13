/**
 * Batteries-included local PostgreSQL Store backed by PGlite.
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

export type LocalPgliteStoreOptions<
  TStoreOptions extends StoreOptions = StoreOptions,
> = Readonly<{
  /** PGlite data directory. Defaults to an in-memory database. */
  dataDir?: string;
  /** Whether to load pgvector. Defaults to true. */
  vector?: boolean;
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
  const impl = await loadDrizzleBackedModule(
    "./postgres/pglite",
    () => import("./pglite-store-impl"),
  );
  return impl.createLocalPgliteStoreImpl(graph, options);
}
