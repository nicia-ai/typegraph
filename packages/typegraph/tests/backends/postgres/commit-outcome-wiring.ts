/**
 * Shared driver wiring cases for the commit-outcome marker, registered by
 * `pglite-commit-outcome.test.ts` (in-process) and
 * `postgres-commit-outcome.test.ts` (server drivers).
 *
 * The behaviour itself — a transaction the database rolled back rejects, one a
 * savepoint recovered commits, one the callback ended has an unknown outcome —
 * is the shared integration suite's (`integration/transaction-commit-outcome.ts`).
 * This file pins what is per driver: the statements the marker costs on the
 * clean path, that its read waits for a statement the callback left running,
 * that a nested transaction plants no marker and shares the enclosing
 * connection's statement queue, and how postgres-js — which rolls back a
 * transaction scope in which any statement failed — is reported.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector as pgvectorExtension } from "@electric-sql/pglite-pgvector";
import { type Logger, sql as drizzleSql } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import { Pool } from "pg";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStore,
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
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

const PLANT_PREFIX = "select set_config(";
const READ_PREFIX = "select current_setting(";
const MISSING_RELATION_SQL = "SELECT * FROM commit_outcome_missing_table";

type NativeHandle = Readonly<{
  execute: (query: ReturnType<typeof drizzleSql.raw>) => Promise<unknown>;
}>;

function nativeHandleOf(transactionContext: object): NativeHandle {
  return Reflect.get(transactionContext, "sql") as NativeHandle;
}

const SLOW_READ_MILLISECONDS = 300;
const SLOW_READ_SQL = "select pg_sleep(0.3)";

/**
 * The same backend, with every transaction's `getNode` a managed read that
 * holds the connection for {@link SLOW_READ_MILLISECONDS}.
 */
function backendWithSlowRead(
  backend: ReturnType<typeof createPostgresBackend>,
): ReturnType<typeof createPostgresBackend> {
  return deriveBackend(backend, {
    transactionWithNative: (run, options) =>
      backend.transactionWithNative(
        (target, native) =>
          run(
            deriveBackend(target, {
              getNode: async (): Promise<NodeRow | undefined> => {
                await target.execute(asCompiledRowsSql(sql.raw(SLOW_READ_SQL)));
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

/** Records every statement Drizzle sends, the marker's included. */
function createStatementLog(): Readonly<{
  logger: Logger;
  sent: () => readonly SentStatement[];
  count: (prefix: string) => number;
  reset: () => void;
}> {
  const statements: SentStatement[] = [];
  return {
    logger: {
      logQuery: (query) => {
        statements.push({
          statement: query.trim().toLowerCase(),
          at: performance.now(),
        });
      },
    },
    sent: () => [...statements],
    count: (prefix) =>
      statements.filter(({ statement }) => statement.startsWith(prefix)).length,
    reset: () => {
      statements.length = 0;
    },
  };
}

/** The statements sent while the slow read held the connection. */
function sentDuringSlowRead(sent: readonly SentStatement[]): readonly string[] {
  const readIndex = sent.findIndex(({ statement }) =>
    statement.startsWith(SLOW_READ_SQL),
  );
  expect(readIndex).toBeGreaterThanOrEqual(0);
  const read = requireDefined(sent[readIndex]);
  return sent
    .slice(readIndex + 1)
    .filter(({ at }) => at - read.at < SLOW_READ_MILLISECONDS * 0.8)
    .map(({ statement }) => statement);
}

export type DriverFixture = Readonly<{
  name: string;
  /** Whether the driver rolls back a scope whose statement failed. */
  driverTracksScopeFailures: boolean;
  open: (logger: Logger) => Promise<
    Readonly<{
      backend: ReturnType<typeof createPostgresBackend>;
      close: () => Promise<void>;
    }>
  >;
}>;

export const pgliteFixture: DriverFixture = {
  name: "PGlite",
  driverTracksScopeFailures: false,
  async open(logger) {
    const client = new PGlite({ extensions: { vector: pgvectorExtension } });
    await client.exec(generatePostgresMigrationSQL());
    return {
      backend: createPostgresBackend(drizzlePglite(client, { logger })),
      close: () => client.close(),
    };
  },
};

export function nodePostgresFixture(databaseUrl: string): DriverFixture {
  return {
    name: "node-postgres",
    driverTracksScopeFailures: false,
    async open(logger) {
      const pool = new Pool({ connectionString: databaseUrl });
      await pool.query(generatePostgresMigrationSQL());
      await pool.query(
        "TRUNCATE typegraph_nodes, typegraph_edges, typegraph_schema_versions CASCADE",
      );
      return {
        backend: createPostgresBackend(drizzleNodePg(pool, { logger })),
        close: () => pool.end(),
      };
    },
  };
}

export function postgresJsFixture(databaseUrl: string): DriverFixture {
  return {
    name: "postgres-js",
    driverTracksScopeFailures: true,
    async open(logger) {
      const client = postgres(databaseUrl, {
        onnotice: () => {
          // Silence CREATE IF NOT EXISTS notices.
        },
      });
      await client.unsafe(generatePostgresMigrationSQL()).simple();
      await client.unsafe(
        "TRUNCATE typegraph_nodes, typegraph_edges, typegraph_schema_versions CASCADE",
      );
      return {
        backend: createPostgresBackend(drizzlePostgresJs(client, { logger })),
        close: () => client.end(),
      };
    },
  };
}

export function registerCommitOutcomeWiringTests(fixture: DriverFixture): void {
  describe(`commit-outcome marker on ${fixture.name}`, () => {
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
      opened = await fixture.open(statementLog.logger);
      storePromise = openStore(opened.backend);
      await storePromise;
    });

    afterAll(async () => {
      await opened?.close();
    });

    it("costs one statement after BEGIN and one before COMMIT on the clean path", async () => {
      const store = await requireDefined(storePromise);
      const { backend } = requireDefined(opened);

      statementLog.reset();
      await backend.transaction(async (tx) => {
        await tx.getNode(wiringGraph.id, "WiringNote", "absent");
      });
      expect([
        statementLog.count(PLANT_PREFIX),
        statementLog.count(READ_PREFIX),
      ]).toEqual([1, 1]);

      // The Store checks the marker as soon as the callback returns, before
      // its own work; the backend's check before COMMIT then has nothing new
      // to read, since no statement was sent in between.
      statementLog.reset();
      await store.transaction(async (tx) => {
        await tx.nodes.WiringNote.create({ body: "clean" });
      });
      expect([
        statementLog.count(PLANT_PREFIX),
        statementLog.count(READ_PREFIX),
      ]).toEqual([1, 1]);
      const sent = statementLog.sent().map(({ statement }) => statement);
      const plantIndex = sent.findIndex((statement) =>
        statement.startsWith(PLANT_PREFIX),
      );
      const readIndex = sent.findIndex((statement) =>
        statement.startsWith(READ_PREFIX),
      );
      // Planted before the callback's first statement, read after its last.
      expect(plantIndex).toBeLessThan(
        sent.findIndex((statement) => statement.startsWith("insert")),
      );
      expect(readIndex).toBe(
        sent.findLastIndex(
          (statement) =>
            statement !== "commit" && !statement.startsWith("commit"),
        ),
      );
    });

    it("reads the marker only after a read the callback left running has finished", async () => {
      await requireDefined(storePromise);
      const slowReadStore = createAdapterStore(
        wiringGraph,
        backendWithSlowRead(requireDefined(opened).backend),
      );
      statementLog.reset();
      let leftRunning: Promise<unknown> | undefined;

      await slowReadStore.transaction((tx) => {
        // Not awaited: the callback returns while the read is on the wire.
        leftRunning = tx.nodes.WiringNote.getById("in-flight" as never);
        return Promise.resolve();
      });
      await leftRunning;

      // The marker read joins the connection's statement queue, so nothing is
      // sent until the read in flight has finished.
      expect(sentDuringSlowRead(statementLog.sent())).toEqual([]);
      expect(statementLog.count(READ_PREFIX)).toBe(1);
    });

    it("plants no marker in a nested transaction, which shares the enclosing connection's statement queue", async () => {
      await requireDefined(storePromise);
      const { backend } = requireDefined(opened);
      statementLog.reset();

      await backend.transactionWithNative(async (outer, native) => {
        const nested = backendWithSlowRead(createPostgresBackend(native));
        await nested.transactionWithNative(async (inner) => {
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
