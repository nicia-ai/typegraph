/**
 * A PostgreSQL schema commit's data checks under a snapshot-isolation server
 * default.
 *
 * A managed writer holds the graph's active schema row `FOR SHARE` for its
 * whole transaction and changes nothing in it. A schema commit waits for that
 * writer on its `FOR UPDATE`, and the commit's tightening preflight then reads
 * the graph. At `REPEATABLE READ` or `SERIALIZABLE` the commit's snapshot was
 * taken by its first statement, before the wait, and a lock granted after a
 * share-locker commits raises no serialization failure — so the preflight would
 * read the graph as it was before the writer committed. The schema-write
 * transaction therefore asks for `READ COMMITTED` whatever the server default
 * is, and the fence statement confirms the session got it.
 *
 * Server PostgreSQL only: the race needs a second connection holding the
 * writer's transaction open while the commit waits.
 */
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  MigrationError,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import {
  createPostgresBackend,
  createPostgresTransactionBackend,
} from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";
import { createGate } from "../../concurrency-utils";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const SNAPSHOT_DEFAULTS = ["repeatable read", "serializable"] as const;
type SnapshotDefault = (typeof SNAPSHOT_DEFAULTS)[number];

const LOCK_WAIT_POLL_MS = 20;

const Task = defineNode("Task", { schema: z.object({}) });
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });

function taskGraph(id: string, acyclic: boolean) {
  return defineGraph({
    id,
    nodes: { Task: { type: Task } },
    edges: {
      dependsOn: {
        type: dependsOn,
        from: [Task],
        to: [Task],
        ...(acyclic ? { acyclic: true } : {}),
      },
    },
  });
}

let writerPool: Pool | undefined;
let observerPool: Pool | undefined;
const migratorPools = new Map<SnapshotDefault, Pool>();

function createPool(defaultIsolation?: SnapshotDefault): Pool {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 2,
    ...(defaultIsolation === undefined ?
      {}
    : {
        options: `-c default_transaction_isolation=${defaultIsolation.replace(" ", String.raw`\ `)}`,
      }),
  });
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const writer = createPool();
  const observer = createPool();
  const migrators = SNAPSHOT_DEFAULTS.map(
    (level) => [level, createPool(level)] as const,
  );
  await runServerSuiteSetup(
    "schema-commit-isolation",
    [writer, observer, ...migrators.map(([, pool]) => pool)],
    async () => {
      await writer.query(generatePostgresMigrationSQL());
      await observer.query("SELECT 1");
      for (const [level, pool] of migrators) {
        const { rows } = await pool.query<{ level: string }>(
          "SELECT current_setting('default_transaction_isolation') AS level",
        );
        if (rows[0]?.level !== level) {
          throw new Error(
            `The migrator pool runs at ${String(rows[0]?.level)}, not ${level}.`,
          );
        }
        migratorPools.set(level, pool);
      }
      writerPool = writer;
      observerPool = observer;
    },
  );
});

afterAll(async () => {
  await writerPool?.end();
  await observerPool?.end();
  for (const pool of migratorPools.values()) await pool.end();
});

/** Resolves once some session of THIS database is parked on a lock. */
async function untilSessionWaitsOnLock(observer: Pool): Promise<void> {
  for (;;) {
    const { rows } = await observer.query<{ waiting: string }>(
      `SELECT count(*) AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]?.waiting) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_POLL_MS));
  }
}

type SessionState = Readonly<{
  lockTimeout: string;
  advisoryLocks: number;
}>;

/** The caller-visible state a refused schema write must leave untouched. */
async function readSessionState(
  tx: Pick<NodePgDatabase, "execute">,
): Promise<SessionState> {
  const { rows } = await tx.execute(sql`
    SELECT current_setting('lock_timeout') AS lock_timeout,
      (SELECT count(*) FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid()) AS advisory_locks
  `);
  return {
    lockTimeout: String(rows[0]?.["lock_timeout"]),
    advisoryLocks: Number(rows[0]?.["advisory_locks"]),
  };
}

/** The error `work` rejects with; a resolved `work` fails the test. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the schema write to be refused.");
}

describe.runIf(process.env["POSTGRES_URL"])(
  "schema commit isolation under a snapshot server default (PostgreSQL)",
  () => {
    for (const level of SNAPSHOT_DEFAULTS) {
      it(`refuses an acyclic tightening over a cycle a writer committed while the commit waited, at a ${level} default`, async () => {
        const graphId = `schema-commit-isolation-${level.replace(" ", "-")}`;
        const writerBackend = createPostgresBackend(
          drizzle(requireDefined(writerPool)),
        );
        const [writer] = await createStoreWithSchema(
          taskGraph(graphId, false),
          writerBackend,
        );
        const a = await writer.nodes.Task.create({}, { id: "a" });
        const b = await writer.nodes.Task.create({}, { id: "b" });
        await writer.edges.dependsOn.create(a, b);

        const closing = createGate();
        const holding = createGate();
        const closingWrite = writer.transaction(async (tx) => {
          await tx.edges.dependsOn.create(b, a);
          holding.open();
          await closing.opened;
        });
        await holding.opened;

        const migration = rejection(
          createStoreWithSchema(
            taskGraph(graphId, true),
            createPostgresBackend(
              drizzle(requireDefined(migratorPools.get(level))),
            ),
          ),
        );
        // A commit refused before it reaches the schema row never waits; the
        // race lets the assertions below report that refusal instead.
        await Promise.race([
          untilSessionWaitsOnLock(requireDefined(observerPool)),
          migration,
        ]);
        closing.open();
        await closingWrite;
        const refusal = await migration;

        expect(refusal).toBeInstanceOf(MigrationError);
        expect((refusal as MigrationError).details).toMatchObject({
          reason: "ontology-tightening-violated",
          violations: [
            expect.objectContaining({
              family: "edgeAcyclicity",
              relation: "dependsOn",
            }),
          ],
        });
        const active = await writerBackend.getActiveSchema(graphId);
        expect(active?.version).toBe(1);
      });
    }

    it("refuses to fence a schema write on a caller's repeatable read transaction", async () => {
      const db = drizzle(requireDefined(writerPool));
      const adopt = requireDefined(
        createPostgresBackend(db).adoptSchemaWriteTransaction,
      );

      const refusal = await rejection(
        db.transaction(
          (tx) =>
            adopt(tx, "schema-commit-isolation-adopted", {
              waitBudgetMs: 5000,
            }),
          { isolationLevel: "repeatable read" },
        ),
      );

      expect(refusal).toBeInstanceOf(ConfigurationError);
      expect((refusal as ConfigurationError).details).toMatchObject({
        code: "SCHEMA_WRITE_REQUIRES_READ_COMMITTED",
        isolation: "repeatable_read",
      });
    });

    it("leaves a caller's repeatable read transaction as it found it after refusing to fence a schema write", async () => {
      const db = drizzle(requireDefined(writerPool));
      const adopt = requireDefined(
        createPostgresBackend(db).adoptSchemaWriteTransaction,
      );

      const { before, refusal, after } = await db.transaction(
        async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '30s'`);
          const stateBefore = await readSessionState(tx);
          const caught = await rejection(
            adopt(tx, "schema-commit-isolation-adopted-residue", {
              waitBudgetMs: 5000,
            }),
          );
          return {
            before: stateBefore,
            refusal: caught,
            after: await readSessionState(tx),
          };
        },
        { isolationLevel: "repeatable read" },
      );

      expect(refusal).toBeInstanceOf(ConfigurationError);
      expect((refusal as ConfigurationError).details).toMatchObject({
        code: "SCHEMA_WRITE_REQUIRES_READ_COMMITTED",
      });
      expect(before).toEqual({ lockTimeout: "30s", advisoryLocks: 0 });
      expect(after).toEqual(before);
    });

    it("refuses a schema write through a transaction-scoped backend on a caller's repeatable read transaction, holding no schema fence afterwards", async () => {
      const db = drizzle(requireDefined(writerPool));
      const graphId = "schema-commit-isolation-transaction-scoped";

      const { refusal, after } = await db.transaction(
        async (tx) => {
          const caught = await rejection(
            createStoreWithSchema(
              taskGraph(graphId, false),
              createPostgresTransactionBackend(tx),
            ),
          );
          return { refusal: caught, after: await readSessionState(tx) };
        },
        { isolationLevel: "repeatable read" },
      );

      expect(refusal).toBeInstanceOf(ConfigurationError);
      expect((refusal as ConfigurationError).details).toMatchObject({
        code: "SCHEMA_WRITE_REQUIRES_READ_COMMITTED",
        graphId,
        isolation: "repeatable_read",
      });
      expect(after.advisoryLocks).toBe(0);
      const active = await createPostgresBackend(db).getActiveSchema(graphId);
      expect(active).toBeUndefined();
    });

    it("commits a schema write through a transaction-scoped backend on a caller's read committed transaction", async () => {
      const db = drizzle(requireDefined(writerPool));
      const graphId = "schema-commit-isolation-transaction-scoped-rc";

      await db.transaction(
        async (tx) => {
          await createStoreWithSchema(
            taskGraph(graphId, false),
            createPostgresTransactionBackend(tx),
          );
        },
        { isolationLevel: "read committed" },
      );

      const active = await createPostgresBackend(db).getActiveSchema(graphId);
      expect(active?.version).toBe(1);
    });
  },
);
