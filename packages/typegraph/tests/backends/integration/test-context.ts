import type { GraphBackend, GraphDef, HistoryStoreBackend } from "../../../src";
import type {
  AdapterBackend,
  BundledBackendCapabilityOverrides,
} from "../../../src/backend/types";
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
}>;

/**
 * THE one refusal a lane whose `createSerializedBackend` has no
 * construction-time capability override to forward `overrides.capabilities`
 * into calls before building anything — naming the lane, so a future test
 * that mistakenly passes `capabilities` on that lane fails loudly instead of
 * silently exercising a default backend under a capability-driven
 * assertion that was never actually applied. Both SQLite lanes
 * (`sqlite-backend.test.ts`, `libsql-backend.test.ts`) call this; the
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
}>;
