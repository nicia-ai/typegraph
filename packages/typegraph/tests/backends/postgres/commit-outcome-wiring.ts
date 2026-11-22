/**
 * Shared driver wiring cases for the commit-outcome evidence, registered by
 * `pglite-commit-outcome.test.ts` (in-process) and
 * `postgres-commit-outcome.test.ts` (server drivers).
 *
 * The behaviour itself — a transaction the database rolled back rejects, one a
 * savepoint recovered commits, one the callback ended has an unknown outcome —
 * is the shared integration suite's (`integration/transaction-commit-outcome.ts`).
 * This file pins what is per driver, from the statements the driver itself
 * sends (not Drizzle's logger, which never sees a statement handed straight to
 * the driver client):
 *
 * - a transaction in which nothing failed and whose native handle was never
 *   read sends exactly what it sent before the evidence existed;
 * - reading the handle plants the marker ahead of anything the caller then
 *   sends through it, in the same tick, and costs one plant and one read;
 * - a failure with the handle never read costs nothing: the reply to the
 *   `COMMIT` decides, and the driver's own refusal on postgres-js;
 * - an abort the client never saw (a statement a node-postgres
 *   `query_timeout` abandoned and the server then failed, one a
 *   `statement_timeout` cancelled) is reported as the rollback it is, a
 *   history store included, and a deferred constraint failing at `COMMIT`
 *   rejects with its own error;
 * - the decision waits for a statement the callback left running;
 * - a nested transaction plants nothing and shares the enclosing
 *   connection's statement queue, and a handle read inside it is covered by
 *   the enclosing marker;
 * - the plant takes no snapshot (server drivers);
 * - postgres-js, which rolls back a transaction scope in which any statement
 *   failed, is reported as the rollback it is.
 */
import {
  PGlite,
  type Transaction as PGliteTransaction,
} from "@electric-sql/pglite";
import { vector as pgvectorExtension } from "@electric-sql/pglite-pgvector";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import { Pool, type PoolClient } from "pg";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStore,
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  TransactionOutcomeUnknownError,
  TransactionRolledBackError,
} from "../../../src";
import { resolveRegisteredAtomicSqlBatchExecutor } from "../../../src/backend/capabilities/atomic-sql-program";
import {
  backendDerivationChain,
  deriveBackend,
} from "../../../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import {
  type NodeRow,
  type TransactionBackend,
} from "../../../src/backend/types";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";

const WiringNote = defineNode("WiringNote", {
  schema: z.object({ body: z.string() }),
});
const wiringGraph = defineGraph({
  id: "postgres_commit_outcome_wiring",
  nodes: { WiringNote: { type: WiringNote } },
  edges: {},
});

const PLANT_PREFIX = "set local typegraph.transaction_marker";
const READ_PREFIX = "select current_setting('typegraph.transaction_marker'";
const MISSING_RELATION_SQL = "SELECT * FROM commit_outcome_missing_table";
/** A marker value: generated per attempt, from a fixed alphabet. */
const MARKER_VALUE_SHAPE = /^[\da-f]{32}$/;
const CALLER_MARKER_READ =
  "SELECT current_setting('typegraph.transaction_marker', true) AS seen_by_caller";

type NativeHandle = Readonly<{
  execute: (query: ReturnType<typeof drizzleSql.raw>) => Promise<unknown>;
  transaction: <T>(body: (nested: NativeHandle) => Promise<T>) => Promise<T>;
}>;

function nativeHandleOf(transactionContext: object): NativeHandle {
  return Reflect.get(transactionContext, "sql") as NativeHandle;
}

/** The rows of a native `execute`, whichever shape the driver returns. */
function rowsOf(result: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (Array.isArray(result))
    return result as Readonly<Record<string, unknown>>[];
  return (result as Readonly<{ rows: Readonly<Record<string, unknown>>[] }>)
    .rows;
}

async function noteBody(
  store: Readonly<{
    nodes: Readonly<{
      WiringNote: Readonly<{
        getById: (id: never) => Promise<Readonly<{ body: string }> | undefined>;
      }>;
    }>;
  }>,
  id: string,
): Promise<string | undefined> {
  const note = await store.nodes.WiringNote.getById(id as never);
  return note?.body;
}

const SLOW_READ_MILLISECONDS = 300;
const SLOW_READ_SQL = "select pg_sleep(0.3)";
/** Holds the connection for {@link SLOW_READ_MILLISECONDS}, then fails (22P02). */
const SLOW_FAILING_READ_SQL = "select (pg_sleep(0.3)::text || 'x')::int";

/**
 * Holds the connection for 0.4 s, then fails on the server with a division by
 * zero (22012): long enough for a 150 ms node-postgres `query_timeout` to
 * abandon it on the client first.
 */
const ABANDONED_FAILING_READ_SQL =
  "select 1 / (count(*)::int - 1) from pg_sleep(0.4)";
const CLIENT_QUERY_TIMEOUT_MILLISECONDS = 150;
/** Longer than {@link ABANDONED_FAILING_READ_SQL} runs on the server. */
const SERVER_FAILURE_WAIT_MILLISECONDS = 700;

const DEFERRED_PARENT_TABLE = "commit_outcome_deferred_parent";
const DEFERRED_CHILD_TABLE = "commit_outcome_deferred_child";
/** Accepted when sent; its foreign key is checked only at COMMIT (23503). */
const DEFERRED_VIOLATION_SQL = `insert into ${DEFERRED_CHILD_TABLE} values (42)`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The SQLSTATE of the first engine error in `error`'s cause chain. */
function engineCodeOf(error: unknown): string | undefined {
  let link: unknown = error;
  for (let depth = 0; depth < 10 && link !== undefined; depth += 1) {
    if (typeof link !== "object" || link === null) return undefined;
    const code: unknown = Reflect.get(link, "code");
    if (typeof code === "string" && /^[\dA-Z]{5}$/.test(code)) return code;
    link = Reflect.get(link, "cause");
  }
  return undefined;
}

/**
 * The same backend, with every transaction's `getNode` a managed read that
 * runs `statement` (or each of `statement`, in order) through the
 * transaction's statement queue.
 */
function backendWithRead(
  backend: ReturnType<typeof createPostgresBackend>,
  statement: string | readonly string[],
): ReturnType<typeof createPostgresBackend> {
  const statements = typeof statement === "string" ? [statement] : statement;
  function reading(target: TransactionBackend): TransactionBackend {
    return deriveBackend(target, {
      getNode: async (): Promise<NodeRow | undefined> => {
        for (const each of statements) {
          await target.execute(asCompiledRowsSql(sql.raw(each)));
        }
        return undefined;
      },
    });
  }
  // A history store opens its transactions through `transaction`, an
  // adapter Store through `transactionWithNative`.
  return deriveBackend(backend, {
    transaction: (run, options) =>
      backend.transaction((target) => run(reading(target)), options),
    transactionWithNative: (run, options) =>
      backend.transactionWithNative(
        (target, native) => run(reading(target), native),
        options,
      ),
  });
}

/** The first statement of the batch {@link runFailingAtomicBatch} runs. */
const BATCH_FIRST_STATEMENT = "select 'inside the typegraph savepoint'";

/**
 * Runs, inside TypeGraph's own savepoint on the transaction session `target`
 * (its registered atomic batch), {@link BATCH_FIRST_STATEMENT} and then a
 * statement that fails, so TypeGraph rolls the savepoint back.
 */
async function runFailingAtomicBatch(
  target: TransactionBackend,
): Promise<void> {
  for (const link of backendDerivationChain(target)) {
    const batch = resolveRegisteredAtomicSqlBatchExecutor(
      link as TransactionBackend,
    );
    if (batch === undefined) continue;
    await batch([
      { sql: BATCH_FIRST_STATEMENT, params: [] },
      { sql: MISSING_RELATION_SQL, params: [] },
    ]);
    return;
  }
  throw new Error("The transaction session has no atomic batch.");
}

type SentStatement = Readonly<{ statement: string; at: number }>;

/**
 * Every statement the driver sends, recorded where it is handed to the
 * driver: the marker's plant included, which goes straight to the client.
 */
type StatementLog = Readonly<{
  record: (statement: string) => void;
  sent: () => readonly SentStatement[];
  statements: () => readonly string[];
  count: (prefix: string) => number;
  /**
   * Statements handed to a node-postgres client while another was still
   * executing on it: the overlap `pg@9` removes.
   */
  overlaps: () => number;
  recordOverlap: () => void;
  /**
   * Whether an overlapping statement is refused, as a client that runs one
   * statement at a time must.
   */
  strict: () => boolean;
  setStrict: (strict: boolean) => void;
  /**
   * Runs `hook` once, synchronously, as the first statement starting with
   * `prefix` is handed to the driver.
   */
  onStatement: (prefix: string, hook: () => void) => void;
  reset: () => void;
}>;

function createStatementLog(): StatementLog {
  const statements: SentStatement[] = [];
  let overlaps = 0;
  let strict = false;
  let pendingHook: Readonly<{ prefix: string; hook: () => void }> | undefined;
  return {
    onStatement: (prefix, hook) => {
      pendingHook = { prefix, hook };
    },
    overlaps: () => overlaps,
    strict: () => strict,
    setStrict: (value) => {
      strict = value;
    },
    recordOverlap: () => {
      overlaps += 1;
    },
    record: (statement) => {
      const normalized = statement.trim().replaceAll(/\s+/g, " ").toLowerCase();
      statements.push({ statement: normalized, at: performance.now() });
      if (
        pendingHook !== undefined &&
        normalized.startsWith(pendingHook.prefix)
      ) {
        const { hook } = pendingHook;
        pendingHook = undefined;
        hook();
      }
    },
    sent: () => [...statements],
    statements: () => statements.map(({ statement }) => statement),
    count: (prefix) =>
      statements.filter(({ statement }) => statement.startsWith(prefix)).length,
    reset: () => {
      statements.length = 0;
      overlaps = 0;
      strict = false;
      pendingHook = undefined;
    },
  };
}

/** The statements sent while the slow read held the connection. */
function sentDuringSlowRead(sent: readonly SentStatement[]): readonly string[] {
  const readIndex = sent.findIndex(
    ({ statement }) =>
      statement.startsWith(SLOW_READ_SQL) ||
      statement.startsWith(SLOW_FAILING_READ_SQL),
  );
  expect(readIndex).toBeGreaterThanOrEqual(0);
  const read = requireDefined(sent[readIndex]);
  return sent
    .slice(readIndex + 1)
    .filter(({ at }) => at - read.at < SLOW_READ_MILLISECONDS * 0.8)
    .map(({ statement }) => statement);
}

/** Each statement's leading keyword, which is what the clean-path gate pins. */
function keywordsOf(statements: readonly string[]): readonly string[] {
  return statements.map((statement) => statement.split(" ")[0] ?? "");
}

function textOf(query: unknown): string {
  if (typeof query === "string") return query;
  const text: unknown = Reflect.get(new Object(query), "text");
  return typeof text === "string" ? text : String(query);
}

type OpenedDriver = Readonly<{
  backend: ReturnType<typeof createPostgresBackend>;
  /** Runs one statement outside any transaction. */
  admin: (statement: string) => Promise<void>;
  close: () => Promise<void>;
}>;

export type DriverFixture = Readonly<{
  name: string;
  /**
   * Whether the reply to the `COMMIT` that ends a transaction is read
   * (node-postgres, PGlite); postgres-js refuses to commit instead.
   */
  commitReplyReadable: boolean;
  /** Whether the engine cancels a statement at its `statement_timeout`. */
  enforcesStatementTimeout: boolean;
  /**
   * Opens the driver with a client-side query timeout: the driver rejects a
   * statement on the client while the server may still be running it.
   */
  openWithQueryTimeout?: (milliseconds: number) => Promise<OpenedDriver>;
  /** Whether the driver rolls back a scope whose statement failed. */
  driverTracksScopeFailures: boolean;
  /**
   * Whether the backend's root can commit on another connection while a
   * transaction is open (a pool); PGlite has one session.
   */
  independentConnections: boolean;
  open: (log: StatementLog) => Promise<OpenedDriver>;
}>;

/** What a strict test client answers a statement sent while another runs. */
const STRICT_CLIENT_REFUSAL =
  "strict test client: a statement is already executing";

/**
 * PGlite sends `BEGIN` and `COMMIT` / `ROLLBACK` itself, around the callback
 * of its `transaction`, and hands the callback a transaction object; both are
 * recorded here, the transaction object's statement members included.
 */
function recordPgliteStatements(client: PGlite, log: StatementLog): void {
  const statementMembers = new Set<PropertyKey>(["query", "exec", "sql"]);
  const openTransaction = client.transaction.bind(client);
  client.transaction = <T>(
    callback: (transaction: PGliteTransaction) => Promise<T>,
  ): Promise<T> =>
    openTransaction(async (transaction) => {
      log.record("BEGIN");
      let executing = 0;
      const recording = new Proxy(transaction, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          if (!statementMembers.has(property)) {
            return (...args: unknown[]): unknown =>
              Reflect.apply(value, target, args);
          }
          return (...args: unknown[]): unknown => {
            log.record(textOf(args[0]));
            if (executing > 0) {
              log.recordOverlap();
              if (log.strict()) {
                return Promise.reject(new Error(STRICT_CLIENT_REFUSAL));
              }
            }
            executing += 1;
            const pending = Reflect.apply(
              value,
              target,
              args,
            ) as Promise<unknown>;
            const settle = (): void => {
              executing -= 1;
            };
            pending.then(settle, settle);
            return pending;
          };
        },
      });
      try {
        const result = await callback(recording);
        if (!transaction.closed) log.record("COMMIT");
        return result;
      } catch (error) {
        // PGlite sends its ROLLBACK itself, once the callback settles: a
        // statement still executing then would overlap it.
        if (executing > 0) log.recordOverlap();
        if (!transaction.closed) log.record("ROLLBACK");
        throw error;
      }
    });
}

export const pgliteFixture: DriverFixture = {
  name: "PGlite",
  commitReplyReadable: true,
  // Single-threaded WASM: nothing interrupts a running statement.
  enforcesStatementTimeout: false,
  driverTracksScopeFailures: false,
  independentConnections: false,
  async open(log) {
    const client = new PGlite({ extensions: { vector: pgvectorExtension } });
    await client.exec(generatePostgresMigrationSQL());
    recordPgliteStatements(client, log);
    return {
      backend: createPostgresBackend(drizzlePglite(client)),
      admin: async (statement) => {
        await client.exec(statement);
      },
      close: () => client.close(),
    };
  },
};

export function nodePostgresFixture(databaseUrl: string): DriverFixture {
  return {
    name: "node-postgres",
    commitReplyReadable: true,
    enforcesStatementTimeout: true,
    openWithQueryTimeout(milliseconds) {
      const pool = new Pool({
        connectionString: databaseUrl,
        query_timeout: milliseconds,
      });
      return Promise.resolve({
        backend: createPostgresBackend(drizzleNodePg(pool)),
        admin: async (statement) => {
          await pool.query(statement);
        },
        close: () => pool.end(),
      });
    },
    driverTracksScopeFailures: false,
    independentConnections: true,
    async open(log) {
      const pool = new Pool({ connectionString: databaseUrl });
      pool.on("connect", (client: PoolClient) => {
        const query = client.query.bind(client) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        let executing = 0;
        Reflect.set(client, "query", (...args: unknown[]): unknown => {
          log.record(textOf(args[0]));
          if (executing > 0) {
            log.recordOverlap();
            if (log.strict()) {
              const refusal = new Error(STRICT_CLIENT_REFUSAL);
              const callback = args.find(
                (argument) => typeof argument === "function",
              ) as ((error: Error) => unknown) | undefined;
              if (callback === undefined) return Promise.reject(refusal);
              queueMicrotask(() => callback(refusal));
              return undefined;
            }
          }
          executing += 1;
          const settle = (): void => {
            executing -= 1;
          };
          // The pool itself calls `query` with a callback, and gets no promise.
          const callbackIndex = args.findIndex(
            (argument) => typeof argument === "function",
          );
          if (callbackIndex !== -1) {
            const callback = args[callbackIndex] as (
              ...results: unknown[]
            ) => unknown;
            args[callbackIndex] = (...results: unknown[]): unknown => {
              settle();
              return callback(...results);
            };
            return query(...args);
          }
          const pending = query(...args);
          pending.then(settle, settle);
          return pending;
        });
      });
      await pool.query(generatePostgresMigrationSQL());
      await pool.query(
        "TRUNCATE typegraph_nodes, typegraph_edges, typegraph_schema_versions CASCADE",
      );
      return {
        backend: createPostgresBackend(drizzleNodePg(pool)),
        admin: async (statement) => {
          await pool.query(statement);
        },
        close: () => pool.end(),
      };
    },
  };
}

export function postgresJsFixture(databaseUrl: string): DriverFixture {
  return {
    name: "postgres-js",
    commitReplyReadable: false,
    enforcesStatementTimeout: true,
    driverTracksScopeFailures: true,
    independentConnections: true,
    async open(log) {
      const client = postgres(databaseUrl, {
        onnotice: () => {
          // Silence CREATE IF NOT EXISTS notices.
        },
        debug: (_connection, query) => {
          log.record(query);
        },
      });
      await client.unsafe(generatePostgresMigrationSQL()).simple();
      await client.unsafe(
        "TRUNCATE typegraph_nodes, typegraph_edges, typegraph_schema_versions CASCADE",
      );
      return {
        backend: createPostgresBackend(drizzlePostgresJs(client)),
        admin: async (statement) => {
          await client.unsafe(statement);
        },
        close: () => client.end(),
      };
    },
  };
}

/**
 * The statement keywords a clean transaction sends, as recorded on `main`
 * before the commit-outcome evidence existed: BEGIN, the callback's own
 * statements, COMMIT.
 */
const CLEAN_GET_NODE_KEYWORDS = ["begin", "select", "commit"];
const CLEAN_STORE_CREATE_KEYWORDS = ["begin", "insert", "commit"];

export function registerCommitOutcomeWiringTests(fixture: DriverFixture): void {
  describe(`commit-outcome evidence on ${fixture.name}`, () => {
    const statementLog = createStatementLog();
    // Opened in `beforeAll`, not at registration: the two server drivers
    // share this file's database and must not run its migration concurrently.
    let opened: OpenedDriver | undefined;
    let storePromise: ReturnType<typeof openStore> | undefined;

    function openStore(backend: ReturnType<typeof createPostgresBackend>) {
      return createAdapterStoreWithSchema(wiringGraph, backend).then(
        ([store]) => store,
      );
    }

    beforeAll(async () => {
      opened = await fixture.open(statementLog);
      storePromise = openStore(opened.backend);
      await storePromise;
      await opened.admin(
        `CREATE TABLE IF NOT EXISTS ${DEFERRED_PARENT_TABLE} (id integer PRIMARY KEY)`,
      );
      await opened.admin(
        `CREATE TABLE IF NOT EXISTS ${DEFERRED_CHILD_TABLE} (parent_id integer REFERENCES ${DEFERRED_PARENT_TABLE} (id) DEFERRABLE INITIALLY DEFERRED)`,
      );
    });

    afterAll(async () => {
      await opened?.close();
    });

    it("adds no statement to a clean transaction whose native handle was never read", async () => {
      const store = await requireDefined(storePromise);
      const { backend } = requireDefined(opened);

      statementLog.reset();
      await backend.transaction(async (tx) => {
        await tx.getNode(wiringGraph.id, "WiringNote", "absent");
      });
      expect(keywordsOf(statementLog.statements())).toEqual(
        CLEAN_GET_NODE_KEYWORDS,
      );

      // An adapter Store's transaction carries the native handle on
      // `tx.sql`; a callback that never reads it pays nothing for it.
      statementLog.reset();
      await store.transaction(async (tx) => {
        await tx.nodes.WiringNote.create({ body: "clean" });
      });
      expect(keywordsOf(statementLog.statements())).toEqual(
        CLEAN_STORE_CREATE_KEYWORDS,
      );
    });

    it("plants the marker ahead of a statement the caller sends through the handle in the same tick", async () => {
      const store = await requireDefined(storePromise);

      statementLog.reset();
      const seen = await store.transaction(async (tx) => {
        // Read and used in one expression: nothing awaits in between.
        const rows = rowsOf(
          await nativeHandleOf(tx).execute(drizzleSql.raw(CALLER_MARKER_READ)),
        );
        return rows[0]?.["seen_by_caller"];
      });

      expect(seen).toMatch(MARKER_VALUE_SHAPE);
      expect(statementLog.overlaps()).toBe(0);
      const statements = statementLog.statements();
      expect(keywordsOf(statements)).toEqual([
        "begin",
        "set",
        "select",
        "select",
        "commit",
      ]);
      expect(statements[1]).toMatch(new RegExp(`^${PLANT_PREFIX}`));
      expect(statements[3]).toMatch(/^select current_setting\('typegraph/);
    });

    it("plants the marker without overlapping a statement still executing on the connection", async () => {
      await requireDefined(storePromise);
      const slowReadStore = createAdapterStore(
        wiringGraph,
        backendWithRead(requireDefined(opened).backend, SLOW_READ_SQL),
      );
      statementLog.reset();

      const seen = await slowReadStore.transaction(async (tx) => {
        const slowRead = tx.nodes.WiringNote.getById("in-flight" as never);
        // The slow read is on the wire when the handle is read; the handle
        // is used only once the read is done, so only the plant could
        // overlap it.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const native = nativeHandleOf(tx);
        await slowRead;
        const rows = rowsOf(
          await native.execute(drizzleSql.raw(CALLER_MARKER_READ)),
        );
        return rows[0]?.["seen_by_caller"];
      });

      expect(seen).toMatch(MARKER_VALUE_SHAPE);
      expect(statementLog.overlaps()).toBe(0);
      expect(statementLog.count(PLANT_PREFIX)).toBe(1);
    });

    it("costs one plant and one read when the handle is read and never used", async () => {
      const store = await requireDefined(storePromise);

      statementLog.reset();
      await store.transaction(async (tx) => {
        await tx.nodes.WiringNote.create(
          { body: "handle read" },
          { id: `${fixture.name}-handle-read` },
        );
        expect(nativeHandleOf(tx)).toBeDefined();
        // A second read of the handle plants nothing more.
        expect(nativeHandleOf(tx)).toBe(nativeHandleOf(tx));
      });

      expect([
        statementLog.count(PLANT_PREFIX),
        statementLog.count(READ_PREFIX),
      ]).toEqual([1, 1]);
      expect(await noteBody(store, `${fixture.name}-handle-read`)).toBe(
        "handle read",
      );
    });

    it("adds no statement after a failure with the handle never read, and says how the rollback was detected", async () => {
      await requireDefined(storePromise);
      const failingReadStore = createAdapterStore(
        wiringGraph,
        backendWithRead(requireDefined(opened).backend, MISSING_RELATION_SQL),
      );

      statementLog.reset();
      const outcome = await failingReadStore
        .transaction(async (tx) =>
          tx.nodes.WiringNote.getById("missing" as never).then(
            () => "the read did not fail",
            () => "callback caught the failure",
          ),
        )
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(TransactionRolledBackError);
      expect((outcome as TransactionRolledBackError).details).toEqual({
        conflict: false,
        detectedBy: fixture.commitReplyReadable ? "commit-reply" : "driver",
        causeObserved: true,
      });
      // BEGIN, the failing read, then COMMIT (answered ROLLBACK), or the
      // ROLLBACK postgres-js sends in its place: nothing added.
      expect(keywordsOf(statementLog.statements())).toEqual([
        "begin",
        "select",
        fixture.commitReplyReadable ? "commit" : "rollback",
      ]);
    });

    it("decides only after a failing read the callback left running has finished", async () => {
      await requireDefined(storePromise);
      const slowReadStore = createAdapterStore(
        wiringGraph,
        backendWithRead(requireDefined(opened).backend, SLOW_FAILING_READ_SQL),
      );
      statementLog.reset();
      let leftRunning: Promise<unknown> | undefined;

      const outcome = await slowReadStore
        .transaction((tx) => {
          // Not awaited: the callback returns while the read is on the wire,
          // and the read fails only after the callback has returned.
          leftRunning = tx.nodes.WiringNote.getById("in-flight" as never).catch(
            () => "caught",
          );
          return Promise.resolve("callback returned");
        })
        .catch((error: unknown) => error);
      await leftRunning;

      // Nothing is sent while the read holds the connection, and its failure
      // decides the outcome.
      expect(sentDuringSlowRead(statementLog.sent())).toEqual([]);
      expect(outcome).toBeInstanceOf(TransactionRolledBackError);
    });

    it.runIf(fixture.enforcesStatementTimeout)(
      "rejects as rolled back a transaction whose caught statement a statement_timeout cancelled",
      async () => {
        const store = await requireDefined(storePromise);
        const cancelledReadStore = createAdapterStore(
          wiringGraph,
          backendWithRead(requireDefined(opened).backend, [
            "SET LOCAL statement_timeout = 50",
            "select pg_sleep(1)",
          ]),
        );
        const id = `${fixture.name}-statement-timeout`;
        let cancelled: string | undefined;

        const outcome = await cancelledReadStore
          .transaction(async (tx) => {
            await tx.nodes.WiringNote.create(
              { body: "before the timeout" },
              { id },
            );
            cancelled = await tx.nodes.WiringNote.getById(
              "cancelled" as never,
            ).then(
              () => "the read was not cancelled",
              (error: unknown) => engineCodeOf(error),
            );
            return "callback returned";
          })
          .catch((error: unknown) => error);

        expect(cancelled).toBe("57014");
        expect(outcome).toBeInstanceOf(TransactionRolledBackError);
        expect((outcome as TransactionRolledBackError).details).toEqual({
          conflict: false,
          detectedBy: fixture.commitReplyReadable ? "commit-reply" : "driver",
          causeObserved: true,
        });
        expect(engineCodeOf(outcome)).toBe("57014");
        expect(await noteBody(store, id)).toBeUndefined();
      },
    );

    it("rejects with the constraint's own error a transaction whose deferred constraint fails at COMMIT", async () => {
      const store = await requireDefined(storePromise);
      const violatingStore = createAdapterStore(
        wiringGraph,
        backendWithRead(requireDefined(opened).backend, DEFERRED_VIOLATION_SQL),
      );
      const id = `${fixture.name}-deferred`;

      const outcome = await violatingStore
        .transaction(async (tx) => {
          await tx.nodes.WiringNote.create({ body: "before COMMIT" }, { id });
          // Accepted now: the foreign key is checked at COMMIT.
          await tx.nodes.WiringNote.getById("violation" as never);
          return "callback returned";
        })
        .catch((error: unknown) => error);

      expect(outcome).not.toBe("callback returned");
      expect(outcome).not.toBeInstanceOf(TransactionRolledBackError);
      expect(engineCodeOf(outcome)).toBe("23503");
      expect(await noteBody(store, id)).toBeUndefined();
    });

    for (const history of [false, true]) {
      it.runIf(fixture.openWithQueryTimeout !== undefined)(
        `rejects as rolled back, with no cause, a transaction a statement abandoned by query_timeout aborted on the server${history ? " (history store)" : ""}`,
        async () => {
          const openWithQueryTimeout = requireDefined(
            fixture.openWithQueryTimeout,
          );
          const store = await requireDefined(storePromise);
          const timed = await openWithQueryTimeout(
            CLIENT_QUERY_TIMEOUT_MILLISECONDS,
          );
          try {
            const abandoningStore = createAdapterStore(
              wiringGraph,
              backendWithRead(timed.backend, ABANDONED_FAILING_READ_SQL),
              history ? { history: true } : {},
            );
            const id = `${fixture.name}-abandoned-${history ? "history" : "plain"}`;
            let abandoned: unknown;

            const outcome = await abandoningStore
              .transaction(async (tx) => {
                await tx.nodes.WiringNote.create(
                  { body: "before the abandoned read" },
                  { id },
                );
                abandoned = await tx.nodes.WiringNote.getById(
                  "abandoned" as never,
                ).then(
                  () => "the read did not time out",
                  (error: unknown) => error,
                );
                await delay(SERVER_FAILURE_WAIT_MILLISECONDS);
                return "callback returned";
              })
              .catch((error: unknown) => error);

            // Rejected on the client, with no SQLSTATE: nothing told the
            // client that the statement then failed on the server.
            expect(abandoned).toBeInstanceOf(Error);
            expect(engineCodeOf(abandoned)).toBeUndefined();
            expect(outcome).toBeInstanceOf(TransactionRolledBackError);
            expect((outcome as TransactionRolledBackError).details).toEqual({
              conflict: false,
              // The history store's capture flush, before COMMIT, meets the
              // aborted session; a plain store reaches COMMIT, which replies
              // ROLLBACK.
              detectedBy: history ? "refused-statement" : "commit-reply",
              causeObserved: false,
            });
            expect((outcome as Error).cause).toBeUndefined();
            expect(await noteBody(store, id)).toBeUndefined();
          } finally {
            await timed.close();
          }
        },
      );
    }

    it("plants no marker in a nested transaction, which shares the enclosing connection's statement queue", async () => {
      await requireDefined(storePromise);
      const { backend } = requireDefined(opened);
      statementLog.reset();

      // A `transactionWithNative` callback receives the handle: released.
      await backend.transactionWithNative(async (outer, native) => {
        const nested = backendWithRead(
          createPostgresBackend(native),
          SLOW_READ_SQL,
        );
        await nested.transactionWithNative(async (inner, nestedNative) => {
          expect(nestedNative).toBeDefined();
          // Not awaited: the nested transaction's slow read holds the
          // connection while the enclosing transaction sends a statement.
          const slowRead = inner.getNode(wiringGraph.id, "WiringNote", "x");
          await outer.execute(
            asCompiledRowsSql(sql.raw("select 'enclosing statement'")),
          );
          await slowRead;
        });
      });

      expect(statementLog.count(PLANT_PREFIX)).toBe(1);
      expect(statementLog.count(READ_PREFIX)).toBe(1);
      expect(sentDuringSlowRead(statementLog.sent())).toEqual([]);
    });

    it("reports an unknown outcome when a handle read inside a nested Store transaction ends the whole transaction", async () => {
      const store = await requireDefined(storePromise);
      const id = `${fixture.name}-nested-ended`;

      const outcome = await store
        .transaction(async (tx) => {
          await tx.nodes.WiringNote.create({ body: "outer write" }, { id });
          const nestedStore = createAdapterStore(
            wiringGraph,
            createPostgresBackend(nativeHandleOf(tx) as never),
          );
          await nestedStore
            .transaction(async (inner) => {
              await nativeHandleOf(inner).execute(drizzleSql.raw("ROLLBACK"));
            })
            .catch(() => "the nested scope could not release its savepoint");
          return "callback returned";
        })
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(TransactionOutcomeUnknownError);
      expect(await noteBody(store, id)).toBeUndefined();
    });

    it("commits when a handle read inside a nested Store transaction is never used", async () => {
      const store = await requireDefined(storePromise);
      const id = `${fixture.name}-nested-clean`;
      statementLog.reset();

      await store.transaction(async (tx) => {
        const nestedStore = createAdapterStore(
          wiringGraph,
          createPostgresBackend(nativeHandleOf(tx) as never),
        );
        await nestedStore.transaction(async (inner) => {
          await inner.nodes.WiringNote.create({ body: "nested write" }, { id });
          expect(nativeHandleOf(inner)).toBeDefined();
        });
      });

      expect(statementLog.count(PLANT_PREFIX)).toBe(1);
      expect(statementLog.count(READ_PREFIX)).toBe(1);
      expect(await noteBody(store, id)).toBe("nested write");
    });

    it("waits for the plant before the driver rolls back a callback that threw, and rejects with the callback's own error", async () => {
      await requireDefined(storePromise);
      const slowReadStore = createAdapterStore(
        wiringGraph,
        backendWithRead(requireDefined(opened).backend, SLOW_READ_SQL),
      );
      const failure = new Error("the callback's own failure");
      statementLog.reset();
      statementLog.setStrict(true);

      const outcome = await slowReadStore
        .transaction(async (tx) => {
          void tx.nodes.WiringNote.getById("in-flight" as never).catch(
            () => "left running",
          );
          // The slow read is on the wire, so the plant waits behind it, and
          // the callback throws before either has finished.
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(nativeHandleOf(tx)).toBeDefined();
          throw failure;
        })
        .catch((error: unknown) => error);
      statementLog.setStrict(false);

      // Not a conflict, so no retry loop would re-run it: the callback's own
      // error, intact, after the ROLLBACK the strict client accepted.
      expect(outcome).toBe(failure);
      expect(statementLog.overlaps()).toBe(0);
      const statements = statementLog.statements();
      const plant = statements.findIndex((statement) =>
        statement.startsWith(PLANT_PREFIX),
      );
      expect(plant).toBeGreaterThanOrEqual(0);
      expect(statements.indexOf("rollback")).toBeGreaterThan(plant);
    });

    it("plants the marker again after TypeGraph rolls back a savepoint of its own that the plant landed in", async () => {
      const store = await requireDefined(storePromise);
      const { backend } = requireDefined(opened);
      const id = `${fixture.name}-savepoint-rearm`;
      const batchStore = createAdapterStore(
        wiringGraph,
        deriveBackend(backend, {
          transactionWithNative: (run, options) =>
            backend.transactionWithNative(
              (target, native) =>
                run(
                  deriveBackend(target, {
                    getNode: async (): Promise<NodeRow | undefined> => {
                      await runFailingAtomicBatch(target);
                      return undefined;
                    },
                  }),
                  native,
                ),
              options,
            ),
        }),
      );
      statementLog.reset();

      const outcome = await batchStore
        .transaction(async (tx) => {
          await tx.nodes.WiringNote.create({ body: "kept" }, { id });
          // Read as TypeGraph's SAVEPOINT is already on the session and its
          // first statement is handed to the driver: the plant the release
          // sends lands inside the savepoint, whose rollback undoes it.
          statementLog.onStatement(BATCH_FIRST_STATEMENT, () => {
            nativeHandleOf(tx);
          });
          return tx.nodes.WiringNote.getById("x" as never).then(
            () => "the batch did not fail",
            () => "TypeGraph rolled its savepoint back",
          );
        })
        .catch((error: unknown) => error);

      expect(outcome).toBe("TypeGraph rolled its savepoint back");
      const statements = statementLog.statements();
      const savepointRolledBack = statements.indexOf(
        "rollback to savepoint typegraph_atomic_program",
      );
      expect(
        statements.findIndex((statement) => statement.startsWith(PLANT_PREFIX)),
      ).toBeLessThan(savepointRolledBack);
      expect(statementLog.count(PLANT_PREFIX)).toBe(2);
      expect(await noteBody(store, id)).toBe("kept");
    });

    it("never plants the marker again in a transaction the callback opened, when TypeGraph rolls back a savepoint taken there", async () => {
      await requireDefined(storePromise);
      const { backend } = requireDefined(opened);
      const batchStore = createAdapterStore(
        wiringGraph,
        deriveBackend(backend, {
          transactionWithNative: (run, options) =>
            backend.transactionWithNative(
              (target, native) =>
                run(
                  deriveBackend(target, {
                    getNode: async (): Promise<NodeRow | undefined> => {
                      await runFailingAtomicBatch(target);
                      return undefined;
                    },
                  }),
                  native,
                ),
              options,
            ),
        }),
      );
      statementLog.reset();

      const outcome = await batchStore
        .transaction(async (tx) => {
          const native = nativeHandleOf(tx);
          await native.execute(drizzleSql.raw("COMMIT"));
          // postgres-js refuses a BEGIN outside its own transaction API.
          await native.execute(drizzleSql.raw("BEGIN")).catch(() => "refused");
          // TypeGraph's own savepoint, taken in the transaction the callback
          // opened, rolls back: re-planting there would vouch for it.
          await tx.nodes.WiringNote.getById("x" as never).catch(
            () => "TypeGraph's savepoint scope failed",
          );
          return "callback returned";
        })
        .catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(TransactionOutcomeUnknownError);
      expect(statementLog.count(PLANT_PREFIX)).toBe(1);
    });

    for (const options of [
      { isolationLevel: "repeatable_read", accessMode: "read_only" },
      { isolationLevel: "serializable" },
    ] as const) {
      it.runIf(fixture.independentConnections)(
        `leaves the snapshot to the callback's first statement when the handle is read first (${JSON.stringify(options)})`,
        async () => {
          const store = await requireDefined(storePromise);
          const id = `${fixture.name}-${options.isolationLevel}-after-plant`;
          statementLog.reset();

          const seen = await store.transaction(async (tx) => {
            // Released before anything else: the plant is the transaction's
            // first statement after BEGIN.
            expect(nativeHandleOf(tx)).toBeDefined();
            // Committed on another connection after the plant, before the
            // callback's first statement takes the snapshot.
            await store.nodes.WiringNote.create(
              { body: "committed elsewhere" },
              { id },
            );
            const note = await tx.nodes.WiringNote.getById(id as never);
            return note?.body;
          }, options);

          expect(seen).toBe("committed elsewhere");
          // The plant ran (and was read back before COMMIT): without it this
          // case would pass whatever the plant does to the snapshot.
          expect([
            statementLog.count(PLANT_PREFIX),
            statementLog.count(READ_PREFIX),
          ]).toEqual([1, 1]);
        },
      );
    }

    it("reports what the driver does after raw savepoint statements on the outer handle recovered a failure", async () => {
      const store = await requireDefined(storePromise);

      const outcome = await store
        .transaction(async (tx) => {
          const native = nativeHandleOf(tx);
          await native.execute(drizzleSql.raw("SAVEPOINT caller_raw"));
          const failure = await native
            .execute(drizzleSql.raw(MISSING_RELATION_SQL))
            .then(
              () => "succeeded",
              () => "failed",
            );
          await native.execute(
            drizzleSql.raw("ROLLBACK TO SAVEPOINT caller_raw"),
          );
          if (failure !== "failed") return "statement did not fail";
          await tx.nodes.WiringNote.create(
            { body: "after raw recovery" },
            { id: `${fixture.name}-raw-recovered` },
          );
          return "committed";
        })
        .catch((error: unknown) =>
          error instanceof TransactionOutcomeUnknownError ?
            {
              unknown: error.details.reason,
              cause: Reflect.get(
                requireDefined(error.cause as object),
                "code",
              ) as unknown,
            }
          : error,
        );

      // The session is healthy and the marker is found either way. postgres-js
      // still rolls back a transaction scope in which a statement failed, and
      // rethrows that failure in place of committing. The handle was read, so
      // that is reported as an unknown outcome, with the failure as its cause.
      expect(outcome).toEqual(
        fixture.driverTracksScopeFailures ?
          { unknown: "native-handle-released", cause: "42P01" }
        : "committed",
      );
      const recovered = await store.nodes.WiringNote.getById(
        `${fixture.name}-raw-recovered` as never,
      );
      expect(recovered?.body).toBe(
        fixture.driverTracksScopeFailures ? undefined : "after raw recovery",
      );
    });
  });
}
