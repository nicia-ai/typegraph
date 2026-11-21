/**
 * Shared driver wiring cases for the commit-outcome check, registered by
 * `pglite-commit-outcome.test.ts` (in-process) and
 * `postgres-commit-outcome.test.ts` (server drivers).
 *
 * Driver wiring of the commit-outcome check every TypeGraph-owned PostgreSQL
 * transaction runs before its `COMMIT` (`postgres-commit-outcome.ts`).
 *
 * The behaviour itself — a transaction the database rolled back rejects, one a
 * savepoint recovered commits — is the shared integration suite's
 * (`integration/transaction-commit-outcome.ts`). This file pins what differs
 * per driver: the check costs no statement when nothing failed, node-postgres
 * and PGlite ask the session with one probe after a recovered failure, and
 * postgres-js, whose driver rolls back any transaction scope with a failed
 * statement, needs no probe and cannot be recovered by savepoint statements
 * sent through the outer handle.
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
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  TransactionRolledBackError,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";

const WiringNote = defineNode("WiringNote", {
  schema: z.object({ body: z.string() }),
});
const wiringGraph = defineGraph({
  id: "postgres_commit_outcome_wiring",
  nodes: { WiringNote: { type: WiringNote } },
  edges: {},
});

const PROBE_SQL = "select 1";
const MISSING_RELATION_SQL = "SELECT * FROM commit_outcome_missing_table";

type NativeHandle = Readonly<{
  execute: (query: ReturnType<typeof drizzleSql.raw>) => Promise<unknown>;
  transaction: (
    body: (savepoint: NativeHandle) => Promise<unknown>,
  ) => Promise<unknown>;
}>;

function nativeHandleOf(transactionContext: object): NativeHandle {
  return Reflect.get(transactionContext, "sql") as NativeHandle;
}

/** Records every statement Drizzle sends, the probe included. */
function createStatementLog(): Readonly<{
  logger: Logger;
  probes: () => number;
  reset: () => void;
}> {
  const statements: string[] = [];
  return {
    logger: {
      logQuery: (query) => {
        statements.push(query.trim().toLowerCase());
      },
    },
    probes: () =>
      statements.filter((statement) => statement === PROBE_SQL).length,
    reset: () => {
      statements.length = 0;
    },
  };
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
  describe(`commit-outcome check on ${fixture.name}`, () => {
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

    it("sends no probe for a transaction in which nothing failed", async () => {
      const store = await requireDefined(storePromise);
      statementLog.reset();

      await store.transaction(async (tx) => {
        await tx.nodes.WiringNote.create({ body: "clean" });
      });

      expect(statementLog.probes()).toBe(0);
    });

    it("asks the session once after a failure a savepoint recovered, then commits", async () => {
      const store = await requireDefined(storePromise);
      statementLog.reset();

      await store.transaction(async (tx) => {
        const native = nativeHandleOf(tx);
        await expect(
          native.transaction((savepoint) =>
            savepoint.execute(drizzleSql.raw(MISSING_RELATION_SQL)),
          ),
        ).rejects.toThrow();
        await tx.nodes.WiringNote.create(
          { body: "after recovery" },
          { id: `${fixture.name}-recovered` },
        );
      });

      // postgres-js attributes the failure to its own savepoint scope, so the
      // transaction's scope saw no failure and nothing needs asking.
      expect(statementLog.probes()).toBe(
        fixture.driverTracksScopeFailures ? 0 : 1,
      );
      expect(
        await store.nodes.WiringNote.getById(
          `${fixture.name}-recovered` as never,
        ),
      ).toMatchObject({ body: "after recovery" });
    });

    it("treats savepoint statements on the outer handle by what the driver will do", async () => {
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
          error instanceof TransactionRolledBackError ? "rolled back" : error,
        );

      // The session is healthy either way; postgres-js still rolls back a
      // transaction scope in which a statement failed, so the check reports
      // the rollback the driver is about to perform instead of letting the
      // driver's raw error through.
      expect(outcome).toBe(
        fixture.driverTracksScopeFailures ? "rolled back" : "committed",
      );
    });
  });
}
