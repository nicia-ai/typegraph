import type { GraphBackend, GraphDef } from "../../../src";
import type { PostgresTableNames } from "../../../src/backend/drizzle/schema/postgres";
import type {
  AdapterBackend,
  BundledBackendCapabilityOverrides,
} from "../../../src/backend/types";
import type { HistoryStore, Store } from "../../../src/store/store";
import type {
  HistoryStoreOptions,
  LiveStoreOptions,
} from "../../../src/store/types";
import type { HistoryStoreBackend } from "../../../src/store-entry";
import type { ReopenableStorage } from "../../helpers/reopenable-storage";
import type {
  TracedConnection,
  TracedTableNames,
} from "../../helpers/traced-connection";
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

/**
 * What a caller may ask `createSerializedBackend` to declare on the
 * connection it builds. `capabilities` is forwarded verbatim into the
 * lane's own bundled-factory call (`createPostgresBackend(db, {
 * capabilities })`), so it is applied at CONSTRUCTION — before
 * `finalizeEngineCapabilities` derives `execution.unitOfWork` and before
 * dialect-owned members (the schema-version write fence, among them) close
 * over their own resolved `WriteFenceTarget`. A `deriveBackend` overlay
 * applied to the handle this returns can override what a KEYED lock site
 * reads off the object it is handed directly (`resolveWriteFencePlan(tx)`),
 * but it can never reach a member closed over `capabilities` at
 * construction — this option exists for exactly the tests that need the
 * latter.
 */
export type SerializedBackendOverrides = Readonly<{
  capabilities?: BundledBackendCapabilityOverrides;
  schemaProvisioning?: "dml-only" | "transactional";
  /**
   * Physical table names for the backend, patched over the defaults and
   * forwarded into the lane's own table factory. The lane does not create
   * the tables: the caller runs `bootstrapTables()` and, on a lane whose
   * serialized backend shares the suite's database, drops them afterwards.
   */
  tableNames?: SerializedBackendTableNames;
}>;

/** The table-name patch a serialized backend may be built over. */
export type SerializedBackendTableNames = Readonly<
  Partial<Record<keyof PostgresTableNames, string>>
>;

/**
 * THE one refusal a lane whose `createSerializedBackend` has no
 * construction-time capability override to forward `overrides.capabilities`
 * into calls before building anything — naming the lane, so a future test
 * that mistakenly passes `capabilities` on that lane fails loudly instead of
 * silently exercising a default backend under a capability-driven
 * assertion that was never actually applied. Both SQLite lanes
 * (`sqlite-integration-lane.ts`, `libsql-integration-lane.ts`) call this; the
 * PostgreSQL lanes never do, since they forward `overrides.capabilities`
 * into their own `createPostgresBackend` call instead.
 */
export function refuseUnsupportedSerializedBackendCapabilities(
  lane: string,
  overrides: SerializedBackendOverrides | undefined,
): void {
  if (overrides?.capabilities !== undefined) {
    throw new Error(
      `createSerializedBackend: the "${lane}" lane has no construction-time ` +
        "capability override to apply overrides.capabilities to. Remove it, " +
        "or run this assertion only on a PostgreSQL lane.",
    );
  }
}

/**
 * The driver a lane of the shared suite runs on.
 *
 * For a shared case whose observed outcome on main differs by driver — a
 * known-failing case that fails on some drivers and holds on others
 * (`transaction-session-hazards.ts`). A case about backend semantics never
 * branches on it: the whole point of the shared suite is one expectation for
 * every lane.
 */
export type IntegrationLaneDriver =
  "better-sqlite3" | "libsql" | "pglite" | "node-postgres" | "postgres-js";

export type IntegrationTestContext = Readonly<{
  /**
   * The lane's display name, as its registration passes it to
   * `createIntegrationTestSuite` (`SQLite`, `libsql`, `PGlite`,
   * `PostgreSQL`, `PostgreSQL (postgres-js)`). For a test whose observation
   * genuinely differs between two lanes of one dialect — a driver that
   * reports a server's answer differently — and names the lane it pins.
   */
  lane: string;
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
   *
   * `overrides.capabilities`, when supplied, is forwarded into the PostgreSQL
   * lanes' own `createPostgresBackend` call (see
   * {@link SerializedBackendOverrides}). The SQLite lanes have no
   * construction-time capability override to forward it into, so they refuse
   * it via {@link refuseUnsupportedSerializedBackendCapabilities} rather than
   * silently building a default backend and letting a capability-driven
   * assertion pass against the wrong configuration.
   */
  createSerializedBackend: (
    overrides?: SerializedBackendOverrides,
  ) => Promise<SerializedBackendHandle>;
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
  /**
   * Whether this lane's `createSerializedBackend` hands out genuinely
   * independent physical connections — two callers can each hold one open
   * at once and block or observe the other's commit. `true` on the two
   * server-PostgreSQL lanes (a real pool against a real server); `false` on
   * every in-process lane (PGlite, SQLite, libsql), where a single engine
   * instance backs every connection the lane opens, so two "connections"
   * can never demonstrate one session blocking another.
   *
   * The one fact `write-fence-conformance.ts`'s server-lane-concurrency
   * tests gate on, in place of reading `POSTGRES_URL` directly: the tests'
   * actual requirement is independent connections, not that environment
   * variable, and a lane's registration is the one place that fact is
   * actually known.
   */
  serverLaneConcurrency: boolean;
  /** The driver this lane runs on; see {@link IntegrationLaneDriver}. */
  driver: IntegrationLaneDriver;
  /**
   * Opens one NEW connection of this lane's driver with one backend per
   * table-name set over it, recording every statement the connection runs
   * (`tests/helpers/traced-connection.ts`). Closing it is the caller's
   * responsibility, as for {@link createSerializedBackend}.
   */
  openTracedConnection: (
    tableNameSets: readonly TracedTableNames[],
  ) => Promise<TracedConnection>;
  /**
   * Opens storage of this lane's driver that a test can reach again through a
   * NEW session, one that has executed nothing
   * (`tests/helpers/reopenable-storage.ts`). Provisioning and seeding go
   * through the first session. Use it for engine state that belongs to the
   * session rather than the data. Closing it is the caller's responsibility.
   */
  openReopenableStorage: () => Promise<ReopenableStorage>;
}>;
