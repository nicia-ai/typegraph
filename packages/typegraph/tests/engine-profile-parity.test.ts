/**
 * Characterization tests for the two bundled SQL backend factories
 * (`createSqliteBackend` / `createPostgresBackend`), written BEFORE the
 * engine-profile extraction (`docs/design/sql-engine-profile-plan.md`, S0).
 * These pin today's observable behavior so a later step that moves a member
 * body between the two factories and `createSqlBackend` fails loudly instead
 * of silently dropping one dialect's semantics.
 *
 * Four parts, run against a PGlite root (Postgres dialect, pgvector enabled)
 * and a better-sqlite3 root (SQLite dialect, sqlite-vec enabled):
 *
 * 1. The backend's own member-key set and its resolved capabilities
 *    (sorted, so key order never causes a spurious diff), plus explicit
 *    assertions on the two capabilities the extraction's refusals key off
 *    (`pessimisticLocks`, `maxBindParameters`).
 * 2. The three trust marks a bundled root — and a `transaction()` handle
 *    opened on it — carry (`isFirstPartyFactory`,
 *    `isSchemaFencedInsertEligible`, `isBundledRootAutocommitEligible`).
 * 3. An ORDERED capture of every statement issued for one fixed script per
 *    dialect. This is the only part of the file that would catch a moved
 *    member whose BODY silently changed while its name did not (the
 *    critique's A1/A2/A5/A6 findings) — see the capture helpers below for
 *    why interception happens at the raw driver, not at `backend.execute`.
 * 4. A SQLite serialization probe: proof that `runWithSerializedQueue`
 *    still wraps `execute`, since nothing else in the suite fails if it is
 *    removed.
 *
 * Per the construction ratchet (AGENTS.md, D4 in the critique), nothing here
 * spreads a backend or a call whose name ends in "Backend".
 */
import { createRequire } from "node:module";

import type { Transaction as PgliteTransactionHandle } from "@electric-sql/pglite";
import { PGlite } from "@electric-sql/pglite";
import type Database from "better-sqlite3";
import RealDatabase from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  embedding,
  searchable,
  UnsupportedBackendCapabilityError,
} from "../src";
import { isBundledRootAutocommitEligible } from "../src/backend/capabilities/autocommit-single-statement";
import { isSchemaFencedInsertEligible } from "../src/backend/capabilities/schema-fenced-insert";
import { isFirstPartyFactory } from "../src/backend/capabilities/write-fence";
import { PGLITE_MAX_BIND_PARAMETERS } from "../src/backend/drizzle/execution/postgres-execution";
import { createPostgresBackend } from "../src/backend/postgres";
import { createSqliteBackend } from "../src/backend/sqlite";
import {
  type GraphBackend,
  MODERN_SQLITE_MAX_BIND_PARAMETERS,
} from "../src/backend/types";
import {
  FORMAT_VERSION,
  type GraphData,
  trustedImportGraph,
} from "../src/interchange";
import { sqliteVecStrategy } from "../src/query/dialect/vector/sqlite-vec-strategy";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { createStore, createStoreWithSchema } from "../src/store";
import { requireDefined } from "../src/utils/presence";

const nodeRequire = createRequire(import.meta.url);

/** Placeholder default for a resolver captured out of a `Promise` executor. */
// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop(): void {}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// ============================================================
// Root construction — both roots vector-enabled, so the ordered-capture
// script (part 3) can exercise the SAME script shape on each dialect.
// ============================================================

async function createPgliteRoot(): Promise<GraphBackend> {
  const pgvectorModule = await import("@electric-sql/pglite-pgvector");
  const vectorExtension = pgvectorModule.vector;
  const client = await PGlite.create({
    extensions: { vector: vectorExtension },
  });
  cleanups.push(() => client.close());
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
  const backend = createPostgresBackend(drizzlePglite(client), {});
  return backend;
}

function createSqliteRoot(): GraphBackend {
  const sqlite = new RealDatabase(":memory:");
  cleanups.push(() => {
    sqlite.close();
    return Promise.resolve();
  });
  (nodeRequire("sqlite-vec") as { load: (db: Database.Database) => void }).load(
    sqlite,
  );
  const backend = createSqliteBackend(drizzleSqlite(sqlite), {
    executionProfile: { isSync: true },
    vector: sqliteVecStrategy,
  });
  return backend;
}

// ============================================================
// Snapshot normalization — deterministic key order and volatile-value
// placeholders, so the golden files reflect real behavior changes only.
// ============================================================

function sortedKeys(value: object): readonly string[] {
  return Object.keys(value).toSorted((left, right) =>
    left.localeCompare(right),
  );
}

/** Deep-sorts object keys so a snapshot's textual diff is never key-order noise. */
function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => deepSortKeys(entry));
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of sortedKeys(value)) {
      sorted[key] = deepSortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

/**
 * Replaces every wall-clock timestamp with a stable placeholder — global,
 * not anchored, since a timestamp shows up both as a standalone bound
 * parameter (`created_at`) and embedded inside a JSON-stringified
 * `schema_doc` (`generatedAt`). IDs are all caller-supplied in the script
 * below, so they never need normalizing.
 */
function normalizeCapturedValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replaceAll(ISO_TIMESTAMP_PATTERN, "<<TIMESTAMP>>");
  }
  if (Array.isArray(value))
    return value.map((entry) => normalizeCapturedValue(entry));
  return value;
}

type CapturedStatement = Readonly<{ sql: string; params: unknown }>;

function normalizeCapturedStatements(
  collected: readonly CapturedStatement[],
): readonly CapturedStatement[] {
  return collected.map((statement) => ({
    sql: statement.sql,
    params: normalizeCapturedValue(statement.params),
  }));
}

// ============================================================
// Part 1 + 2: member keys, capabilities, and marks
// ============================================================

describe("engine-profile parity: member keys, capabilities, marks", () => {
  it("PGlite root", async () => {
    const backend = await createPgliteRoot();
    expect(sortedKeys(backend)).toMatchSnapshot("pglite-root-keys");
    expect(deepSortKeys(backend.capabilities)).toMatchSnapshot(
      "pglite-root-capabilities",
    );
    expect(backend.capabilities.pessimisticLocks).toEqual({
      advisoryLocks: true,
      tableLocks: true,
      serializedWriters: false,
    });
    expect(backend.capabilities.maxBindParameters).toBe(
      PGLITE_MAX_BIND_PARAMETERS,
    );

    expect(isFirstPartyFactory(backend)).toBe(true);
    expect(isSchemaFencedInsertEligible(backend)).toBe(true);
    expect(isBundledRootAutocommitEligible(backend)).toBe(true);

    await backend.transaction((tx) => {
      expect(isFirstPartyFactory(tx)).toBe(true);
      expect(isSchemaFencedInsertEligible(tx)).toBe(true);
      return Promise.resolve();
    });
  });

  it("better-sqlite3 root", () => {
    const backend = createSqliteRoot();
    expect(sortedKeys(backend)).toMatchSnapshot("sqlite-root-keys");
    expect(deepSortKeys(backend.capabilities)).toMatchSnapshot(
      "sqlite-root-capabilities",
    );
    expect(backend.capabilities.pessimisticLocks).toEqual({
      advisoryLocks: false,
      tableLocks: false,
      serializedWriters: true,
    });
    // better-sqlite3 probes the compiled SQLITE_MAX_VARIABLE_NUMBER at
    // construction; on the version this suite runs against that resolves
    // to the modern ceiling, not the static SQLITE_CAPABILITIES default.
    expect(backend.capabilities.maxBindParameters).toBe(
      MODERN_SQLITE_MAX_BIND_PARAMETERS,
    );

    expect(isFirstPartyFactory(backend)).toBe(true);
    expect(isSchemaFencedInsertEligible(backend)).toBe(true);
    expect(isBundledRootAutocommitEligible(backend)).toBe(true);

    return backend.transaction((tx) => {
      expect(isFirstPartyFactory(tx)).toBe(true);
      expect(isSchemaFencedInsertEligible(tx)).toBe(true);
      return Promise.resolve();
    });
  });
});

// ============================================================
// Part 3: ordered compiled-SQL capture
//
// `backend.execute` is only ONE entry point into the execution adapter:
// `fulltextSearch`, `vectorSearch`, `commitSchemaVersion`, `bootstrapTables`
// and `trustedImport` each hold their OWN `execAll`/`execRun`/`db.run`
// closures, so wrapping the public `execute` member (the way
// `tests/statement-counting-backend.ts` does for a transaction) would miss
// all of them. The only interception point that sees every statement
// regardless of which internal closure issues it is the raw driver
// connection itself, so these helpers spy on `Database.prepare` (SQLite)
// and `PGlite.query` (Postgres) directly.
// ============================================================

/**
 * Statement methods that actually run the query — the moment to record it.
 * `iterate` is included for completeness though nothing in the script uses
 * it.
 */
const SQLITE_EXECUTING_METHODS = new Set(["all", "run", "get", "iterate"]);
/**
 * Statement methods that mutate configuration and return `this` for
 * chaining (`.raw(true).all(...)`, the shape Drizzle's own session uses).
 * Returning the target unwrapped here would let the chained `.all()` bypass
 * capture, so these are special-cased to return the PROXY instead.
 */
const SQLITE_CHAINABLE_METHODS = new Set([
  "raw",
  "pluck",
  "expand",
  "safeIntegers",
  "bind",
]);

function instrumentSqliteCapture(
  sqlite: Database.Database,
  collected: CapturedStatement[],
): void {
  const originalPrepare = sqlite.prepare.bind(sqlite);
  vi.spyOn(sqlite, "prepare").mockImplementation(
    (sqlText: string): Database.Statement => {
      const target = originalPrepare(sqlText);
      // A Proxy, not a hand-built object literal: Drizzle's own session
      // drives a prepared statement through more of better-sqlite3's API
      // than the fast path does (`.raw()`, `.pluck()`, ...), and its native
      // methods throw "Illegal invocation" unless `this` is the exact
      // Statement instance — so every forwarded method is rebound to
      // `target`, never left bound to the proxy.
      const proxy: Database.Statement = new Proxy(target, {
        get(currentTarget, property, _receiver) {
          const value: unknown = Reflect.get(
            currentTarget,
            property,
            currentTarget,
          );
          if (typeof value !== "function") return value;
          const bound = value.bind(currentTarget) as (
            ...args: unknown[]
          ) => unknown;
          if (
            typeof property === "string" &&
            SQLITE_EXECUTING_METHODS.has(property)
          ) {
            return (...params: unknown[]) => {
              collected.push({ sql: sqlText, params });
              return bound(...params);
            };
          }
          if (
            typeof property === "string" &&
            SQLITE_CHAINABLE_METHODS.has(property)
          ) {
            return (...args: unknown[]) => {
              const result = bound(...args);
              return result === currentTarget ? proxy : result;
            };
          }
          return bound;
        },
      });
      return proxy;
    },
  );
}

type PgliteQueryFunction = (
  ...args: readonly unknown[]
) => ReturnType<PGlite["query"]>;

type PgliteTransactionFunction = (
  ...args: readonly unknown[]
) => ReturnType<PGlite["transaction"]>;

/**
 * Wraps the native `Transaction` PGlite hands to a `client.transaction(...)`
 * callback so every `tx.query(...)` call is recorded too. `tx` is a plain
 * object (`query`, `sql`, `exec`, `rollback`, a `closed` getter), so a Proxy
 * forwarding every member to the real target — `query` intercepted, the rest
 * passed through — is enough; there is no chainable-builder surface here the
 * way better-sqlite3's `Statement` has.
 */
function wrapTransactionCapture(
  tx: PgliteTransactionHandle,
  collected: CapturedStatement[],
): PgliteTransactionHandle {
  return new Proxy(tx, {
    get(target, property, _receiver) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const bound = value.bind(target) as (...args: unknown[]) => unknown;
      if (property !== "query") return bound;
      return (...args: unknown[]) => {
        const [sqlText, params] = args;
        if (typeof sqlText === "string") {
          collected.push({ sql: sqlText, params: params ?? [] });
        }
        return bound(...args);
      };
    },
  });
}

/**
 * Two capture points, not one — and mutually exclusive by construction, so
 * no statement is ever seen twice:
 *
 * - A root-level call resolves PGlite's top-level `$client` and calls
 *   `client.query(...)` directly (caught by the first spy below).
 * - Any statement issued while a native transaction is open — whether
 *   opened by Drizzle's own `db.transaction(...)` (`runVectorSearch`'s GUC
 *   group) or by `trustedImport`'s raw bypass, which binds its execution
 *   adapter straight to the transaction's pinned client
 *   (`useTransactionClient: true` in `postgres-execution.ts`) — calls
 *   `tx.query(...)` on the `Transaction` object PGlite hands to the
 *   `client.transaction(...)` callback, never the outer `client`. Wrapping
 *   `client.transaction` to proxy that argument (second spy below) is the
 *   only way to see those statements, `trustedImport`'s included: it never
 *   goes through Drizzle's session or logger at all.
 *
 * A statement's client is resolved once, before it runs, to exactly one of
 * these two objects — never both — so the two spies never double-count.
 */
function instrumentPostgresCapture(
  client: PGlite,
  collected: CapturedStatement[],
): void {
  const originalQuery = client.query.bind(client) as PgliteQueryFunction;
  vi.spyOn(client, "query").mockImplementation(
    (...args: unknown[]): ReturnType<PGlite["query"]> => {
      const [sqlText, params] = args;
      if (typeof sqlText === "string") {
        collected.push({ sql: sqlText, params: params ?? [] });
      }
      return originalQuery(...args);
    },
  );

  const originalTransaction = client.transaction.bind(
    client,
  ) as PgliteTransactionFunction;
  vi.spyOn(client, "transaction").mockImplementation(
    (
      callback: (tx: PgliteTransactionHandle) => Promise<unknown>,
    ): ReturnType<PGlite["transaction"]> =>
      originalTransaction(async (tx: PgliteTransactionHandle) => {
        // PGlite issues a native transaction's BEGIN/COMMIT/ROLLBACK
        // through its private `#runExec`, reachable from neither
        // `client.query` (spied above) nor the wrapped `tx.query` below —
        // so without these synthetic markers the snapshot could not tell
        // "GUCs applied inside a transaction" from "GUCs applied in
        // autocommit", which is exactly the silent degradation a moved
        // `runVectorSearch` could introduce (a `set_config(..., true)`
        // issued outside a transaction rolls off with the statement and
        // is a no-op).
        collected.push({ sql: "-- BEGIN (native transaction) --", params: [] });
        try {
          const result = await callback(wrapTransactionCapture(tx, collected));
          collected.push({ sql: "-- COMMIT --", params: [] });
          return result;
        } catch (error) {
          collected.push({ sql: "-- ROLLBACK --", params: [] });
          throw error;
        }
      }),
  );
}

const EMBEDDING_DIMENSIONS = 3;

const ScriptDocument = defineNode("Document", {
  schema: z.object({
    title: searchable({ language: "english" }),
    embedding: embedding(EMBEDDING_DIMENSIONS),
  }),
});
const ScriptNote = defineNode("Note", {
  schema: z.object({ label: z.string() }),
});
const scriptGraph = defineGraph({
  id: "engine_profile_parity_script",
  nodes: { Document: { type: ScriptDocument }, Note: { type: ScriptNote } },
  edges: {},
});
/**
 * `trustedImport` refuses any store whose registry carries a searchable
 * kind ("Trusted import does not maintain fulltext sidecars.") — a
 * whole-registry check, not a per-row one — so it cannot run against a
 * store opened on `scriptGraph` at all. This graph shares `scriptGraph`'s
 * physical tables (same backend, same table names) but registers only the
 * plain "Note" kind, satisfying that check while the emptiness check
 * (global across all graphs on those tables) still passes because nothing
 * has been written yet.
 */
const noteOnlyGraph = defineGraph({
  id: "engine_profile_parity_script_notes",
  nodes: { Note: { type: ScriptNote } },
  edges: {},
});

function scriptGraphData(nodes: GraphData["nodes"]): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "external", description: "engine-profile-parity script" },
    nodes,
    edges: [],
  };
}

/**
 * One fixed sequence of backend operations, run identically against both
 * dialects, with every statement each operation issues captured in order.
 *
 * Two deviations from the plan's literal step order, both forced by
 * contracts this file does not own:
 *
 * - `trustedImport` runs right after `bootstrapTables` rather than last.
 *   Its emptiness precondition (`assertTrustedImportDatabaseEmpty`) refuses
 *   a database whose node/edge tables hold ANY row, globally, so it must
 *   run before the node create below populates them. It also refuses any
 *   store whose registry carries a searchable kind ("Trusted import does
 *   not maintain fulltext sidecars"), so it runs against `noteOnlyGraph`
 *   (see above) rather than `scriptGraph`.
 * - `commitSchemaVersion` is exercised via `createStoreWithSchema` rather
 *   than a standalone call. A node carrying an `embedding()` field refuses
 *   `create()` with `StoreNotInitializedError` on a plain `createStore` —
 *   its vector contribution is only marked initialized by schema
 *   management — and `createStoreWithSchema` commits the schema version as
 *   part of that initialization. A second, standalone
 *   `backend.commitSchemaVersion` call afterward would just re-fail the
 *   version it already committed.
 */
async function runCapturedScript(
  backend: GraphBackend,
  collected: CapturedStatement[],
): Promise<Readonly<{ vectorSearchOutcome: "applied" | "refused" }>> {
  await backend.bootstrapTables?.();

  const noteStore = createStore(noteOnlyGraph, backend);
  await trustedImportGraph(
    noteStore,
    scriptGraphData([
      { kind: "Note", id: "note-1", properties: { label: "first" } },
      { kind: "Note", id: "note-2", properties: { label: "second" } },
    ]),
  );

  const [store] = await createStoreWithSchema(scriptGraph, backend);
  await store.nodes.Document.create(
    { title: "Climate patterns", embedding: [1, 0, 0] },
    { id: "doc-1" },
  );

  await store.search.fulltext("Document", { query: "climate", limit: 5 });

  let vectorSearchOutcome: "applied" | "refused";
  try {
    await store.search.vector("Document", {
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0],
      limit: 5,
      metric: "cosine",
      efSearch: 40,
    });
    vectorSearchOutcome = "applied";
  } catch (error) {
    if (!(error instanceof UnsupportedBackendCapabilityError)) throw error;
    collected.push({
      sql: "-- vectorSearch efSearch override refused: UnsupportedBackendCapabilityError --",
      params: [],
    });
    vectorSearchOutcome = "refused";
  }

  // `store.search.vector` above routes through the `vectorSearch` backend
  // member, never through `execute`'s ANN-branded path (`postgres.ts`'s
  // `annIndexScanTypes(query)` check, reached only when a compiled SQL
  // fragment is handed to `execute` directly). An inline `similarTo(...,
  // { approximate: true })` predicate compiled through the query builder
  // and run via `.execute()` is the only way to exercise that second site,
  // so it is captured here too (API precedent:
  // `tests/backends/postgres/inline-ann-gucs.test.ts`).
  try {
    await store
      .query()
      .from("Document", "d")
      .whereNode("d", (document) =>
        document.embedding.similarTo([1, 0, 0], 5, {
          metric: "cosine",
          approximate: true,
        }),
      )
      .select((context) => ({ id: context.d.id }))
      .execute();
  } catch (error) {
    if (!(error instanceof UnsupportedBackendCapabilityError)) throw error;
    collected.push({
      sql: "-- inline approximate query refused: UnsupportedBackendCapabilityError --",
      params: [],
    });
  }

  return { vectorSearchOutcome };
}

describe("engine-profile parity: ordered compiled-SQL capture", () => {
  it("PGlite: efSearch override applies (GUC wrapping)", async () => {
    const pgvectorModule = await import("@electric-sql/pglite-pgvector");
    const vectorExtension = pgvectorModule.vector;
    const client = await PGlite.create({
      extensions: { vector: vectorExtension },
    });
    cleanups.push(() => client.close());
    await client.exec("CREATE EXTENSION IF NOT EXISTS vector");

    const collected: CapturedStatement[] = [];
    const backend = createPostgresBackend(drizzlePglite(client), {});
    instrumentPostgresCapture(client, collected);

    const { vectorSearchOutcome } = await runCapturedScript(backend, collected);

    expect(vectorSearchOutcome).toBe("applied");
    expect(normalizeCapturedStatements(collected)).toMatchSnapshot(
      "pglite-ordered-statements",
    );
  });

  it("better-sqlite3: efSearch override refuses (no ANN frontier parameter)", async () => {
    const sqlite = new RealDatabase(":memory:");
    cleanups.push(() => {
      sqlite.close();
      return Promise.resolve();
    });
    (
      nodeRequire("sqlite-vec") as { load: (db: Database.Database) => void }
    ).load(sqlite);
    const backend = createSqliteBackend(drizzleSqlite(sqlite), {
      executionProfile: { isSync: true },
      vector: sqliteVecStrategy,
    });

    const collected: CapturedStatement[] = [];
    instrumentSqliteCapture(sqlite, collected);

    const { vectorSearchOutcome } = await runCapturedScript(backend, collected);

    expect(vectorSearchOutcome).toBe("refused");
    expect(normalizeCapturedStatements(collected)).toMatchSnapshot(
      "sqlite-ordered-statements",
    );
  });
});

// ============================================================
// Part 4: SQLite serialization probe
// ============================================================

describe("engine-profile parity: SQLite serialization probe", () => {
  it("does not let a second backend.execute call start before the first finishes", async () => {
    // Nothing here can differ if two synchronous better-sqlite3 calls are
    // simply issued back to back (JS never runs two synchronous calls
    // concurrently, queue or no queue). The queue only matters once one
    // call is genuinely stalled — mimicked here by having `query-one`'s
    // mocked statement return a THENABLE instead of an array; `Promise.
    // resolve()` around a thenable adopts its state, so `executeCompiled`'s
    // returned promise settles only when `releaseFirst` is called. Without
    // `runWithSerializedQueue` wrapping `execute`, `query-two`'s statement —
    // registered synchronously right after `query-one`'s, with no queue to
    // chain it behind — would run immediately instead of waiting.
    const sqlite = new RealDatabase(":memory:");
    cleanups.push(() => {
      sqlite.close();
      return Promise.resolve();
    });
    const backend = createSqliteBackend(drizzleSqlite(sqlite), {
      executionProfile: { isSync: true },
    });

    const order: string[] = [];
    let releaseFirst: () => void = noop;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalPrepare = sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite, "prepare").mockImplementation(
      (sqlText: string): Database.Statement => {
        if (sqlText.includes("query_one")) {
          return {
            reader: true,
            all: () => {
              order.push("start-1");
              return firstGate.then(() => {
                order.push("finish-1");
                return [];
              }) as unknown as readonly unknown[];
            },
          } as unknown as Database.Statement;
        }
        if (sqlText.includes("query_two")) {
          return {
            reader: true,
            all: () => {
              order.push("start-2", "finish-2");
              return [];
            },
          } as unknown as Database.Statement;
        }
        return originalPrepare(sqlText);
      },
    );

    const first = backend.execute(
      asCompiledRowsSql(sql`SELECT 'query_one' AS marker`),
    );
    const second = backend.execute(
      asCompiledRowsSql(sql`SELECT 'query_two' AS marker`),
    );
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["start-1", "finish-1", "start-2", "finish-2"]);
  });
});

// ============================================================
// Part 5: index-materializations additive-column migration
// ============================================================

describe("engine-profile parity: index-materialization column migration", () => {
  it("PGlite: ensureIndexMaterializationsTable still issues the additive-column ALTERs", async () => {
    // #445's fix lives behind `EngineProvisioning.ensureIndexMaterializationColumns`,
    // an optional hook only the PostgreSQL profile supplies. A moved
    // `ensureIndexMaterializationsTable` that forgets to call it would still
    // pass every other test in this file (the CREATE already declares the
    // build-claim columns on a fresh install, so nothing downstream would
    // notice a missing migration) — this asserts the ALTERs are issued
    // directly, so the hook cannot be silently dropped in a later step.
    const client = await PGlite.create();
    cleanups.push(() => client.close());

    const collected: CapturedStatement[] = [];
    const backend = createPostgresBackend(drizzlePglite(client), {
      vector: false,
    });
    instrumentPostgresCapture(client, collected);

    await requireDefined(backend.ensureIndexMaterializationsTable)();

    const statementTexts = collected.map((statement) => statement.sql);
    expect(
      statementTexts.some((text) =>
        text.includes('ADD COLUMN IF NOT EXISTS "building_since" timestamptz'),
      ),
    ).toBe(true);
    expect(
      statementTexts.some((text) =>
        text.includes('ADD COLUMN IF NOT EXISTS "claim_token" text'),
      ),
    ).toBe(true);
  });
});
