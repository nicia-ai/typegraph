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
 * - a failure with the handle never read costs one probe and no marker;
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
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { type NodeRow } from "../../../src/backend/types";
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
const PROBE_PREFIX = "select 1 as healthy";
const MISSING_RELATION_SQL = "SELECT * FROM commit_outcome_missing_table";
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
 * The same backend, with every transaction's `getNode` a managed read that
 * runs `statement` through the transaction's statement queue.
 */
function backendWithRead(
  backend: ReturnType<typeof createPostgresBackend>,
  statement: string,
): ReturnType<typeof createPostgresBackend> {
  return deriveBackend(backend, {
    transactionWithNative: (run, options) =>
      backend.transactionWithNative(
        (target, native) =>
          run(
            deriveBackend(target, {
              getNode: async (): Promise<NodeRow | undefined> => {
                await target.execute(asCompiledRowsSql(sql.raw(statement)));
                return undefined;
              },
            }),
            native,
          ),
        options,
      ),
  });
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
  reset: () => void;
}>;

function createStatementLog(): StatementLog {
  const statements: SentStatement[] = [];
  return {
    record: (statement) => {
      statements.push({
        statement: statement.trim().replaceAll(/\s+/g, " ").toLowerCase(),
        at: performance.now(),
      });
    },
    sent: () => [...statements],
    statements: () => statements.map(({ statement }) => statement),
    count: (prefix) =>
      statements.filter(({ statement }) => statement.startsWith(prefix)).length,
    reset: () => {
      statements.length = 0;
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

export type DriverFixture = Readonly<{
  name: string;
  /** Whether the driver rolls back a scope whose statement failed. */
  driverTracksScopeFailures: boolean;
  /**
   * Whether the backend's root can commit on another connection while a
   * transaction is open (a pool); PGlite has one session.
   */
  independentConnections: boolean;
  open: (log: StatementLog) => Promise<
    Readonly<{
      backend: ReturnType<typeof createPostgresBackend>;
      close: () => Promise<void>;
    }>
  >;
}>;

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
            return Reflect.apply(value, target, args);
          };
        },
      });
      try {
        const result = await callback(recording);
        if (!transaction.closed) log.record("COMMIT");
        return result;
      } catch (error) {
        if (!transaction.closed) log.record("ROLLBACK");
        throw error;
      }
    });
}

export const pgliteFixture: DriverFixture = {
  name: "PGlite",
  driverTracksScopeFailures: false,
  independentConnections: false,
  async open(log) {
    const client = new PGlite({ extensions: { vector: pgvectorExtension } });
    await client.exec(generatePostgresMigrationSQL());
    recordPgliteStatements(client, log);
    return {
      backend: createPostgresBackend(drizzlePglite(client)),
      close: () => client.close(),
    };
  },
};

export function nodePostgresFixture(databaseUrl: string): DriverFixture {
  return {
    name: "node-postgres",
    driverTracksScopeFailures: false,
    independentConnections: true,
    async open(log) {
      const pool = new Pool({ connectionString: databaseUrl });
      pool.on("connect", (client: PoolClient) => {
        const query = client.query.bind(client) as (
          ...args: unknown[]
        ) => unknown;
        Reflect.set(client, "query", (...args: unknown[]): unknown => {
          log.record(textOf(args[0]));
          return query(...args);
        });
      });
      await pool.query(generatePostgresMigrationSQL());
      await pool.query(
        "TRUNCATE typegraph_nodes, typegraph_edges, typegraph_schema_versions CASCADE",
      );
      return {
        backend: createPostgresBackend(drizzleNodePg(pool)),
        close: () => pool.end(),
      };
    },
  };
}

export function postgresJsFixture(databaseUrl: string): DriverFixture {
  return {
    name: "postgres-js",
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
    let opened: Awaited<ReturnType<DriverFixture["open"]>> | undefined;
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

      expect(seen).toBe("open");
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
        statementLog.count(PROBE_PREFIX),
      ]).toEqual([1, 1, 0]);
      expect(await noteBody(store, `${fixture.name}-handle-read`)).toBe(
        "handle read",
      );
    });

    it("probes once, and plants nothing, after a failure with the handle never read", async () => {
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
      expect([
        statementLog.count(PLANT_PREFIX),
        statementLog.count(READ_PREFIX),
        statementLog.count(PROBE_PREFIX),
      ]).toEqual([0, 0, 1]);
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
      expect(statementLog.count(PROBE_PREFIX)).toBe(1);
    });

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

    for (const options of [
      { isolationLevel: "repeatable_read", accessMode: "read_only" },
      { isolationLevel: "serializable" },
    ] as const) {
      it.runIf(fixture.independentConnections)(
        `leaves the snapshot to the callback's first statement when the handle is read first (${JSON.stringify(options)})`,
        async () => {
          const store = await requireDefined(storePromise);
          const id = `${fixture.name}-${options.isolationLevel}-after-plant`;

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
          error instanceof TransactionRolledBackError ?
            {
              rolledBack: Reflect.get(
                requireDefined(error.cause as object),
                "code",
              ) as unknown,
            }
          : error,
        );

      // The session is healthy and the marker is found either way. postgres-js
      // still rolls back a transaction scope in which a statement failed, and
      // rethrows that failure in place of committing: reported as the
      // rollback it is, with that failure as the cause.
      expect(outcome).toEqual(
        fixture.driverTracksScopeFailures ?
          { rolledBack: "42P01" }
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
