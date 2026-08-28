/**
 * Shared test utilities for TypeGraph tests.
 *
 * Uses createLocalSqliteBackend from the public sqlite module.
 */
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { afterEach, expect } from "vitest";

import type { GraphDef, Store } from "../src";
import {
  type AdapterStore,
  createAdapterStore,
  createAdapterStoreWithSchema,
  createStore,
  createStoreWithSchema,
  IMMUTABLE_VALIDITY_LOWER_BOUND_CODE,
  INVERTED_VALIDITY_WINDOW_CODE,
  ValidationError,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution";
import type { SqliteTables } from "../src/backend/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  type BackendResourceProvenance,
  backendResourceProvenance,
} from "../src/backend/transaction-resource";
import {
  type AdapterBackend,
  type GraphBackend,
  SQLITE_CAPABILITIES,
  type TransactionBackend,
  type TransactionOptions,
} from "../src/backend/types";
import {
  createRecordedInstant,
  type RecordedInstant,
  recordedInstantRevision,
} from "../src/core/temporal";
import { requireDefined } from "../src/utils/presence";

const backendsToClose: GraphBackend[] = [];

/** A row carrying a validity window, as the backend returns it. */
type ValidityWindowRow = Readonly<{
  valid_from: string | undefined;
  valid_to: string | undefined;
}>;

export function recordedRevisionFromDriver(value: unknown): number {
  const revision =
    typeof value === "bigint" ? Number(value)
    : typeof value === "string" ? Number(value)
    : value;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision)) {
    throw new TypeError(
      `Expected a safe recorded revision, got ${String(value)}`,
    );
  }
  return revision;
}

export function recordedWallTimeFromDriver(value: unknown): string {
  const date =
    value instanceof Date ? value
    : typeof value === "string" ? new Date(value)
    : undefined;
  if (date === undefined || Number.isNaN(date.getTime())) {
    throw new Error(`Expected a recorded wall time, got ${String(value)}`);
  }
  return date.toISOString();
}

export function recordedInstantFromDriver(
  revision: unknown,
  recordedAt: unknown,
): RecordedInstant {
  return createRecordedInstant(
    recordedRevisionFromDriver(revision),
    recordedWallTimeFromDriver(recordedAt),
  );
}

async function closeCreatedTestBackends(): Promise<void> {
  const current = backendsToClose.splice(0);
  await Promise.all(current.map((backend) => backend.close()));
}

afterEach(closeCreatedTestBackends);

/**
 * Creates a GraphBackend using in-memory SQLite.
 * This is the primary way to create backends for testing.
 */
export function createTestBackend(
  customTables?: SqliteTables,
): AdapterBackend<AnySqliteDatabase> {
  const options = customTables ? { tables: customTables } : {};
  const { backend } = createLocalSqliteBackend(options);
  backendsToClose.push(backend);
  return backend;
}

/**
 * A GraphBackend-shaped object no factory has audited.
 *
 * A backend's serialized-resource verdict is written ONCE, before the object
 * escapes its factory, and a second conflicting audit throws. A fixture built
 * by {@link createTestBackend} therefore cannot be re-audited with a test's own
 * sentinel resource: better-sqlite3 detection has already audited it
 * "serialized" on its own client. Tests that need to own the verdict — the
 * sharing and stream-lease contracts, which are about which OBJECTS share a
 * connection, not about driver detection — start from this instead.
 *
 * Only the members those guards read are provided: they classify a backend by
 * object identity and never call through it.
 */
export function makeUnauditedBackend(): GraphBackend {
  return {
    dialect: "sqlite",
    capabilities: SQLITE_CAPABILITIES,
    close: () => Promise.resolve(),
  } as GraphBackend;
}

/**
 * Asserts that a backend one of this package's factories built — or one the
 * construction seam derived from such a backend — carries a connection verdict,
 * and returns the verdict so the caller can keep reasoning about it.
 *
 * SCOPE, which is the point of the name: this is a property of the FIXTURE's
 * backend, never an invariant of the library. Two populations are legitimately
 * `"unaudited"` forever — transaction-scoped backends, which are built from an
 * operations fragment and have no source backend to inherit from, and
 * `GraphBackend`s implemented outside this package. Pointing this at either one
 * asserts something false.
 *
 * WHICH verdict is right is lane-dependent (a better-sqlite3 or PGlite fixture
 * is `"serialized"`, a default-size pool is `"independent"`), so the assertion
 * is deliberately only that a factory LOOKED.
 */
export function expectAuditedBackend(
  backend: object,
): BackendResourceProvenance {
  const provenance = backendResourceProvenance(backend);
  expect(provenance).not.toBe("unaudited");
  return provenance;
}

/**
 * Creates an in-memory SQLite database with TypeGraph tables.
 * Use this when you need direct database access in tests.
 */
export function createTestDatabase(
  customTables?: SqliteTables,
): BetterSQLite3Database {
  const options = customTables ? { tables: customTables } : {};
  const { backend, db } = createLocalSqliteBackend(options);
  backendsToClose.push(backend);
  return db;
}

/**
 * Boots a store through the canonical async path
 * (`createStoreWithSchema`) and returns just the `Store`.
 *
 * Post-#135 this is the test idiom for any suite exercising fulltext
 * (or transactions that touch it): `createStoreWithSchema` is the
 * single durable-materialization writer, so a sync `createStore`
 * against an unmaterialized in-memory backend now (correctly) throws
 * `StoreNotInitializedError` on the first fulltext op. Tests that are
 * NOT asserting the init contract use this helper to get an
 * already-initialized store with minimal call-site churn.
 */
export function createInitializedStore<G extends GraphDef, TNativeTransaction>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
): Promise<AdapterStore<G, TNativeTransaction>>;
export function createInitializedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
): Promise<Store<G>>;
export async function createInitializedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
): Promise<Store<G>> {
  if (isAdapterBackend(backend)) {
    const [store] = await createAdapterStoreWithSchema(graph, backend);
    return store;
  }
  const [store] = await createStoreWithSchema(graph, backend);
  return store;
}

/**
 * Initializes storage through the managed factory, then returns a fresh raw
 * Store. Use this only in tests that deliberately exercise unversioned Store
 * behavior against already-provisioned tables.
 */
export function createRawInitializedStore<
  G extends GraphDef,
  TNativeTransaction,
>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
): Promise<AdapterStore<G, TNativeTransaction>>;
export function createRawInitializedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
): Promise<Store<G>>;
export async function createRawInitializedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
): Promise<Store<G>> {
  await createInitializedStore(graph, backend);
  return isAdapterBackend(backend) ?
      createAdapterStore(graph, backend)
    : createStore(graph, backend);
}

function isAdapterBackend(
  backend: GraphBackend,
): backend is AdapterBackend<unknown> {
  return (
    typeof Reflect.get(backend, "transactionWithNative") === "function" &&
    typeof Reflect.get(backend, "adoptTransaction") === "function"
  );
}

export type CapturedStatement = Readonly<{
  sql: string;
  params: readonly unknown[];
}>;

export type PlanCaptureHarness = Readonly<{
  /** Pass to createStore/createStoreWithSchema; auto-closed after the test. */
  backend: GraphBackend;
  /** Every executed statement, in order. Reset with `captured.length = 0`. */
  captured: CapturedStatement[];
  /** Raw better-sqlite3 client, for EXPLAIN QUERY PLAN. */
  client: Database.Database;
}>;

/**
 * An in-memory SQLite backend that captures every executed statement so a
 * test can assert its actual query plan — the "index exists but the
 * planner won't use it" failure class that DDL-presence assertions can't
 * catch. Pair with {@link explainQueryPlan}:
 *
 * ```ts
 * const { backend, captured, client } = createPlanCaptureBackend();
 * const store = createStore(graph, backend);
 * // ... seed data, refreshStatistics() ...
 * captured.length = 0;
 * await store.algorithms.degree(node.id);
 * const plan = explainQueryPlan(client, captured.at(-1)!);
 * expect(plan).toContain("my_expected_idx");
 * expect(plan).not.toContain("SCAN typegraph_nodes");
 * ```
 */
export function createPlanCaptureBackend(): PlanCaptureHarness {
  const { backend: raw, db } = createLocalSqliteBackend();
  const captured: CapturedStatement[] = [];
  function captureTarget(target: TransactionBackend): TransactionBackend {
    return deriveBackend(target, {
      async execute<T>(query: Parameters<TransactionBackend["execute"]>[0]) {
        const compiled = target.compileSql?.(query);
        if (compiled) {
          captured.push({ sql: compiled.sql, params: compiled.params });
        }
        return target.execute<T>(query);
      },
      async executeRaw<T>(sqlText: string, params: readonly unknown[]) {
        captured.push({ sql: sqlText, params });
        return requireDefined(target.executeRaw)<T>(sqlText, params);
      },
    });
  }
  const backend: GraphBackend = deriveBackend(raw, {
    async execute<T>(query: Parameters<GraphBackend["execute"]>[0]) {
      const compiled = raw.compileSql?.(query);
      if (compiled) {
        captured.push({ sql: compiled.sql, params: compiled.params });
      }
      return raw.execute<T>(query);
    },
    // Reads run through the cached-template fast path (executeRaw), which
    // receives SQL text with all placeholders already filled — directly
    // EXPLAIN-able.
    async executeRaw<T>(sqlText: string, params: readonly unknown[]) {
      captured.push({ sql: sqlText, params });
      return requireDefined(raw.executeRaw)<T>(sqlText, params);
    },
    transaction: (fn, options) =>
      raw.transaction((target) => fn(captureTarget(target)), options),
  });
  backendsToClose.push(raw);
  const client = (db as unknown as { $client: Database.Database }).$client;
  return { backend, captured, client };
}

/**
 * Wraps an adapter backend so calls to `getActiveSchema` — the schema-reconcile
 * read a verified open performs — can be counted, using the same derivation
 * idiom as {@link createPlanCaptureBackend}. Every other method delegates
 * unchanged. Used to assert that the cacheable-store path issues no verify
 * round-trip, and that `getCommittedSchemaVersion` is a single read.
 */
export function spyGetActiveSchema<TNativeTransaction>(
  backend: AdapterBackend<TNativeTransaction>,
): Readonly<{
  backend: AdapterBackend<TNativeTransaction>;
  calls: () => number;
}> {
  let calls = 0;
  const wrapped = deriveBackend(backend, {
    getActiveSchema: (graphId: string) => {
      calls += 1;
      return backend.getActiveSchema(graphId);
    },
  });
  return { backend: wrapped, calls: () => calls };
}

/**
 * The `EXPLAIN QUERY PLAN` detail lines for a captured statement, joined
 * with newlines — assert index usage with `toContain("<index name>")` and
 * scan absence with `not.toContain("SCAN <table>")`.
 */
export function explainQueryPlan(
  client: Database.Database,
  statement: CapturedStatement,
): string {
  const rows = client
    .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .all(...statement.params) as readonly { detail: string }[];
  return rows.map((row) => row.detail).join("\n");
}

/**
 * Wraps a real backend so any unconditional `transaction(...)` rejects and it
 * reports `capabilities.execution.interactiveTransactions: false` — the shape of
 * `drizzle-orm/neon-http` and Cloudflare D1. Use it to exercise the
 * non-transactional sequential fall-through.
 *
 * THE ONE DOUBLE IN THIS FILE THAT IS NOT DERIVED THROUGH THE SEAM, and the
 * reason is a contradiction rather than an oversight. This double models a
 * driver that is NOT a serialized resource, so it must not read as one: a
 * marked non-transactional double used as an import TARGET would claim the
 * stream lease (`capabilities.execution.interactiveTransactions: false` short-circuits
 * `snapshotExportContention`'s source arm only, never
 * `acquireSerializedStreamLease`) and start refusing work that succeeds today.
 * But `deriveBackend` carries the base's verdict, and a backend's verdict is
 * written ONCE — so deriving from a better-sqlite3-backed base and then
 * auditing the result `{ kind: "independent" }` throws the write-once refusal.
 * Constructing a fresh object leaves the double UNAUDITED, which takes the
 * lease's no-op arm exactly as `independent` would.
 *
 * Recorded as a declared entry in the conversion ratchet
 * (tests/backend-derivation-population.test.ts) and suppressed inline with that
 * reason, not as a silent omission.
 */
export function disableTransactions<TNativeTransaction>(
  backend: AdapterBackend<TNativeTransaction>,
): AdapterBackend<TNativeTransaction>;
export function disableTransactions(backend: GraphBackend): GraphBackend;
export function disableTransactions(backend: GraphBackend): GraphBackend {
  return {
    // eslint-disable-next-line no-restricted-syntax -- A fresh object is the point: see this function's doc comment. Deriving through the seam would carry the base's serialized verdict onto a double that models a driver which is NOT a serialized resource, and the write-once audit refuses to overwrite it with `independent`.
    ...backend,
    capabilities: {
      ...backend.capabilities,
      execution: {
        ...backend.capabilities.execution,
        interactiveTransactions: false,
      },
    },
    transaction: () =>
      Promise.reject(new Error("synthetic backend has transactions disabled")),
    ...("transactionWithNative" in backend ?
      {
        transactionWithNative: () =>
          Promise.reject(
            new Error("synthetic backend has transactions disabled"),
          ),
      }
    : {}),
  };
}

/**
 * Wraps a backend — and every transaction-scoped backend it hands out — so each
 * `updateEdge` call is counted.
 *
 * Edges carry no version counter and `updated_at` collides within a millisecond,
 * which is the resolution a repeated write runs at, so an exact write count is
 * the only way to assert that an edge write did NOT happen. Wrapping the
 * transaction too is what makes the count survive the one `bulkUpsertById` opens.
 */
export function withEdgeUpdateCounting(
  base: GraphBackend,
): Readonly<{ backend: GraphBackend; updates: () => number }> {
  let updates = 0;
  function countingUpdateEdge(
    target: Pick<GraphBackend, "updateEdge">,
  ): GraphBackend["updateEdge"] {
    return (params) => {
      updates += 1;
      return target.updateEdge(params);
    };
  }
  return {
    backend: deriveBackend(base, {
      updateEdge: countingUpdateEdge(base),
      transaction: <T>(
        fn: (tx: TransactionBackend) => Promise<T>,
        options?: TransactionOptions,
      ) =>
        base.transaction<T>(
          (txBackend) =>
            fn(
              deriveBackend(txBackend, {
                updateEdge: countingUpdateEdge(txBackend),
              }),
            ),
          options,
        ),
    }),
    updates: () => updates,
  };
}

/**
 * The same instant in a different text form: `...T00:00:00.000+00:00` for
 * `...T00:00:00.000Z`.
 */
function toZonedTimestampText(value: string | undefined): string | undefined {
  if (!value?.endsWith("Z")) return value;
  return `${value.slice(0, -1)}+00:00`;
}

function withZonedWindow<T extends ValidityWindowRow>(row: T): T {
  return {
    ...row,
    valid_from: toZonedTimestampText(row.valid_from),
    valid_to: toZonedTimestampText(row.valid_to),
  };
}

/**
 * Re-renders the validity window of every row the four id-keyed reads return.
 *
 * An overload pair over a concrete union implementation signature, not a type
 * parameter: `deriveBackend`'s overlay is `Partial<T>`, and an object literal is
 * not assignable to `Partial<T>` for an unresolved `T`. The pair is the same
 * shape {@link disableTransactions} already uses in this file.
 */
function withZonedWindowReads(target: GraphBackend): GraphBackend;
function withZonedWindowReads(target: TransactionBackend): TransactionBackend;
function withZonedWindowReads(
  target: GraphBackend | TransactionBackend,
): GraphBackend | TransactionBackend {
  return deriveBackend(target, {
    getNode: async (graphId: string, kind: string, id: string) => {
      const row = await target.getNode(graphId, kind, id);
      return row === undefined ? undefined : withZonedWindow(row);
    },
    getEdge: async (graphId: string, id: string) => {
      const row = await target.getEdge(graphId, id);
      return row === undefined ? undefined : withZonedWindow(row);
    },
    ...(target.getNodes === undefined ?
      {}
    : {
        getNodes: async (
          graphId: string,
          kind: string,
          ids: readonly string[],
        ) => {
          const rows = await requireDefined(target.getNodes)(
            graphId,
            kind,
            ids,
          );
          return rows.map((row) => withZonedWindow(row));
        },
      }),
    ...(target.getEdges === undefined ?
      {}
    : {
        getEdges: async (graphId: string, ids: readonly string[]) => {
          const rows = await requireDefined(target.getEdges)(graphId, ids);
          return rows.map((row) => withZonedWindow(row));
        },
      }),
  });
}

/**
 * Wraps a backend — and every transaction-scoped backend it hands out — so a
 * stored validity window reaches the store as an EQUIVALENT INSTANT IN A
 * DIFFERENT TEXT FORM.
 *
 * That is the shape a Postgres driver which returns a zoned string rather than a
 * `Date` produces: `formatPostgresTimestamp` passes any "T"-bearing string
 * through verbatim, so a window comparison ends up reading the caller's canonical
 * bound against driver text. Every driver in the matrix normalizes `timestamptz`
 * to a `Date` today, which is why comparing that text directly looked harmless —
 * it agreed with the canonical comparison by luck. Simulating the other rendering
 * is what turns the cross-dialect rule into something every backend can assert
 * (issue #412).
 */
export function withZonedValidityWindowText(base: GraphBackend): GraphBackend {
  return deriveBackend(withZonedWindowReads(base), {
    transaction: <T>(
      fn: (tx: TransactionBackend) => Promise<T>,
      options?: TransactionOptions,
    ) =>
      base.transaction<T>(
        (txBackend) => fn(withZonedWindowReads(txBackend)),
        options,
      ),
  });
}

/**
 * Asserts an operation was refused for stating a `validFrom` the write could not
 * apply, identified by its stable issue code rather than by message text.
 *
 * One helper for every path, because the point of the refusal is that it is the
 * SAME refusal wherever a stated lower bound meets a live row — a per-file copy
 * asserting "some ValidationError" would let one path drift to a different
 * failure and still pass.
 */
export async function expectImmutableLowerBoundRefusal(
  operation: Promise<unknown>,
): Promise<void> {
  await expect(operation).rejects.toThrow(ValidationError);
  const error = await operation.catch((error_: unknown) => error_);
  expect(
    (error as ValidationError).details.issues.map((issue) => issue.code),
  ).toContain(IMMUTABLE_VALIDITY_LOWER_BOUND_CODE);
}

/**
 * Asserts an operation was refused for naming a window of negative width,
 * identified by its stable issue code rather than by message text.
 *
 * Sibling of {@link expectImmutableLowerBoundRefusal}, and here for the same
 * reason: the refusal is one refusal wherever an end lands before a start, so
 * every path that expects it asserts it the same way.
 */
export async function expectInvertedWindowRefusal(
  operation: Promise<unknown>,
): Promise<void> {
  await expect(operation).rejects.toThrow(ValidationError);
  const error = await operation.catch((error_: unknown) => error_);
  expect(
    (error as ValidationError).details.issues.map((issue) => issue.code),
  ).toContain(INVERTED_VALIDITY_WINDOW_CODE);
}

export { generateSqliteDDL } from "../src/backend/drizzle/ddl";
export { storeBackend as getStoreBackend } from "../src/store/runtime-port";

/**
 * Flattens all edges from a subgraph adjacency map into a single array.
 */
export function collectAllEdges<E>(
  adjacency: ReadonlyMap<string, ReadonlyMap<string, readonly E[]>>,
): E[] {
  const edges: E[] = [];
  for (const kindMap of adjacency.values()) {
    for (const edgeList of kindMap.values()) {
      edges.push(...edgeList);
    }
  }
  return edges;
}

/**
 * Shared time anchors for temporal-behavior tests.
 *
 * Use these to build fixtures that exercise `temporalMode` / `asOf` across
 * the store. Spacing between anchors is intentional so individual tests can
 * assert snapshot boundaries without coordinating timestamps.
 */
export const TEMPORAL_ANCHORS = {
  PAST: "2020-01-01T00:00:00.000Z",
  BEFORE: "2021-01-01T00:00:00.000Z",
  EDGE_ENDED: "2022-01-01T00:00:00.000Z",
  FUTURE: "2030-01-01T00:00:00.000Z",
} as const;

/**
 * How many recorded revisions elapsed between two anchors. Recorded order is a
 * logical revision, independent of wall time, so a "advanced exactly once"
 * assertion needs no clock control.
 */
export function revisionsAdvanced(
  before: RecordedInstant | undefined,
  after: RecordedInstant | undefined,
): number {
  return (
    recordedInstantRevision(requireDefined(after, "after anchor")) -
    recordedInstantRevision(requireDefined(before, "before anchor"))
  );
}

/**
 * Wraps a nested asymmetric matcher so it enters an object literal as `unknown`
 * rather than `any`, keeping the surrounding assertion type-checked. Vitest
 * types `expect.objectContaining` as `any`, which would otherwise silently
 * disable checking of the whole expected shape.
 */
export function matchingObject(shape: Record<string, unknown>): unknown {
  return expect.objectContaining(shape);
}

/** Array counterpart of {@link matchingObject}. */
export function matchingArray(items: unknown[]): unknown {
  return expect.arrayContaining(items);
}
