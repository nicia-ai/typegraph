import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { RECORDED_ANCHOR_ADOPTION_WAIT_BUDGET_MS } from "../../../src/backend/recorded-storage";
import {
  BaseSchemaAdoptionTimeoutError,
  BaseSchemaMigrationError,
} from "../../../src/errors";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { pruneRecordedAnchors } from "../../../src/store/recorded-anchor-log";
import { delay } from "../../../src/utils/delay";
import { requireDefined } from "../../../src/utils/presence";
import { isPostgresLockTimeout } from "../../../src/utils/sql-errors";
import { raceTimeout } from "../../concurrency-utils";
import {
  asForeignTransaction,
  ForeignPgTransaction,
} from "../../helpers/foreign-drizzle-handles";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const databaseUrl = await provisionPostgresTestDatabase(import.meta.url);
/**
 * A caller's transaction as this copy of Drizzle hands it out, and as a
 * transaction of another loaded copy of Drizzle is seen: adoption must open
 * its savepoint in either.
 */
const CALLER_TRANSACTION_VIEWS = [
  { name: "own copy", view: <T extends object>(handle: T): T => handle },
  {
    name: "another loaded copy",
    view: <T extends object>(handle: T): T =>
      asForeignTransaction(handle, ForeignPgTransaction),
  },
] as const;

// Harness observations need scheduler slack; adoption's database budget stays 1s.
const OBSERVER_TIMEOUT_MS = 5000;

describe.skipIf(!process.env["POSTGRES_URL"])(
  "recorded retention adoption under captured writes",
  () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const statements: string[] = [];
    const logger = {
      logQuery(query: string) {
        statements.push(query);
      },
    };
    const backend = createPostgresBackend(drizzle(pool, { logger }), {
      vector: false,
      fulltext: false,
    });
    beforeAll(async () => {
      await requireDefined(backend.bootstrapTables)();
    });
    beforeEach(async () => {
      await pool.query(
        "ALTER TABLE typegraph_recorded_clock ADD COLUMN IF NOT EXISTS anchor_retention TEXT",
      );
      await pool.query(
        "INSERT INTO typegraph_recorded_clock (graph_id, revision, recorded_at) VALUES ('held', 1, '2026-06-01T00:00:00.000Z'), ('overlap', 1, '2026-06-01T00:00:00.000Z') ON CONFLICT DO NOTHING",
      );
      await pool.query(
        "UPDATE typegraph_base_schema_versions SET version=8 WHERE installation=1",
      );
      statements.length = 0;
    });
    afterAll(async () => {
      await pool.end();
    });

    async function holdWriter(graphId = "held") {
      const writer = await pool.connect();
      await writer.query("BEGIN");
      await writer.query(
        "UPDATE typegraph_recorded_clock SET revision=revision WHERE graph_id=$1",
        [graphId],
      );
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await writer.query("ROLLBACK");
        writer.release();
      };
    }
    function adoptionAttempts() {
      return statements.filter(
        (query) =>
          query.includes("ALTER TABLE") && query.includes('"anchor_retention"'),
      ).length;
    }
    async function waitForQueuedLock(
      mode = "AccessExclusiveLock",
      minimum = 1,
    ) {
      const deadline = performance.now() + OBSERVER_TIMEOUT_MS;
      while (performance.now() < deadline) {
        const result = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_locks WHERE relation='typegraph_recorded_clock'::regclass AND mode=$1 AND NOT granted",
          [mode],
        );
        if (requireDefined(result.rows[0]).count >= minimum) return;
        await delay(5);
      }
      throw new Error(
        `No ${mode} queue with ${minimum} waiter(s) was observed.`,
      );
    }
    async function dropRetention() {
      await pool.query(
        "ALTER TABLE typegraph_recorded_clock DROP COLUMN anchor_retention",
      );
    }

    it("keeps warm node-postgres lookups working across v9 adoption on one connection", async () => {
      const warmPool = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        const warmBackend = createPostgresBackend(drizzle(warmPool), {
          vector: false,
          fulltext: false,
        });
        const Person = defineNode("Person", {
          schema: z.object({ name: z.string() }),
        });
        const graph = defineGraph({
          id: "warm_lookup_adoption",
          nodes: { Person: { type: Person } },
          edges: {},
        });
        const [store] = await createStoreWithSchema(graph, warmBackend, {
          history: true,
        });
        await store.nodes.Person.create({ name: "preserved" });
        const anchor = await store.recordedNow();
        await warmPool.query(
          "ALTER TABLE typegraph_recorded_clock DROP COLUMN anchor_retention",
        );
        await warmPool.query(
          "UPDATE typegraph_base_schema_versions SET version=8 WHERE installation=1",
        );
        const before = await warmPool.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        expect(
          await store.resolveRecordedInstant("2099-01-01T00:00:00.000Z"),
        ).toBe(anchor);
        await requireDefined(warmBackend.adoptBaseSchema)();
        expect(
          await store.resolveRecordedInstant("2099-01-01T00:00:00.000Z"),
        ).toBe(anchor);
        const after = await warmPool.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        expect(after.rows).toEqual(before.rows);
      } finally {
        await warmPool.end();
      }
    });

    it("skips adoption DDL when the retention column is already installed", async () => {
      const release = await holdWriter();
      try {
        await raceTimeout(
          requireDefined(backend.adoptBaseSchema)(),
          OBSERVER_TIMEOUT_MS,
        );
      } finally {
        await release();
      }
      expect(adoptionAttempts()).toBe(0);
    });

    it("queues ahead of new writers and makes progress through overlapping transactions", async () => {
      await dropRetention();
      const releaseFirst = await holdWriter();
      const releaseSecond = await holdWriter("overlap");
      const lateWriter = await pool.connect();
      await lateWriter.query("BEGIN");
      const adopting = requireDefined(backend.adoptBaseSchema)().catch(
        (error: unknown) => error,
      );
      try {
        await waitForQueuedLock();
        // This writer arrives while two older transactions still hold the table.
        // It must queue behind adoption instead of perpetually denying a NOWAIT poll.
        const writing = lateWriter.query(
          "UPDATE typegraph_recorded_clock SET revision=revision WHERE graph_id='held'",
        );
        await waitForQueuedLock("RowExclusiveLock");
        await releaseFirst();
        await releaseSecond();
        expect(
          await raceTimeout(adopting, OBSERVER_TIMEOUT_MS),
        ).toBeUndefined();
        await writing;
      } finally {
        await releaseFirst();
        await releaseSecond();
        await lateWriter.query("ROLLBACK");
        lateWriter.release();
      }
      expect(adoptionAttempts()).toBe(1);
      await requireDefined(backend.assertBaseSchemaCurrent)();
    });

    it.each(CALLER_TRANSACTION_VIEWS)(
      "preserves caller settings after queued adoption inside a savepoint ($name)",
      async ({ view }) => {
        await dropRetention();
        const release = await holdWriter();
        const adopting = drizzle(pool, { logger })
          .transaction(async (transaction) => {
            await transaction.execute("SET LOCAL lock_timeout = '2500ms'");
            const attached = createPostgresBackend(view(transaction), {
              vector: false,
              fulltext: false,
            });
            await requireDefined(attached.adoptBaseSchema)();
            const setting = await transaction.execute<{ value: string }>(
              "SELECT current_setting('lock_timeout') AS value",
            );
            return setting.rows;
          })
          .catch((error: unknown) => error);
        try {
          await waitForQueuedLock();
        } finally {
          await release();
        }
        expect(await adopting).toEqual([{ value: "2500ms" }]);
        expect(adoptionAttempts()).toBe(1);
      },
    );

    it("bounds persistent contention with a table-specific error and permits resumption", async () => {
      await dropRetention();
      await expect(
        pruneRecordedAnchors(
          {
            backend,
            schema: createSqlSchema(backend.tableNames),
            graphId: "held",
            captureEnabled: true,
          },
          "2099-01-01T00:00:00.000Z",
        ),
      ).rejects.toBeInstanceOf(BaseSchemaMigrationError);
      const release = await holdWriter();
      const adopting = requireDefined(backend.adoptBaseSchema)().catch(
        (error: unknown) => error,
      );
      let outcome: unknown;
      try {
        outcome = await raceTimeout(adopting, OBSERVER_TIMEOUT_MS);
      } finally {
        await release();
      }
      expect(outcome).toBeInstanceOf(BaseSchemaAdoptionTimeoutError);
      expect(outcome).toMatchObject({
        code: "BASE_SCHEMA_ADOPTION_TIMEOUT",
        details: {
          tableName: "typegraph_recorded_clock",
          waitBudgetMs: RECORDED_ANCHOR_ADOPTION_WAIT_BUDGET_MS,
        },
      });
      expect(outcome).not.toHaveProperty("details.graphId");
      expect(isPostgresLockTimeout(outcome)).toBe(true);
      expect(adoptionAttempts()).toBe(1);
      const marker = await pool.query(
        "SELECT version FROM typegraph_base_schema_versions WHERE installation=1",
      );
      expect(marker.rows).toEqual([{ version: 8 }]);
      await requireDefined(backend.adoptBaseSchema)();
      await requireDefined(backend.assertBaseSchemaCurrent)();
    });

    it.each(CALLER_TRANSACTION_VIEWS)(
      "honors a stricter caller timeout and rolls back the failed savepoint ($name)",
      async ({ view }) => {
        await dropRetention();
        const release = await holdWriter();
        try {
          await drizzle(pool, { logger }).transaction(async (transaction) => {
            await transaction.execute("SET LOCAL lock_timeout = '50ms'");
            const attached = createPostgresBackend(view(transaction), {
              vector: false,
              fulltext: false,
            });
            await expect(
              requireDefined(attached.adoptBaseSchema)(),
            ).rejects.toMatchObject({
              code: "BASE_SCHEMA_ADOPTION_TIMEOUT",
              details: {
                tableName: "typegraph_recorded_clock",
                waitBudgetMs: 50,
              },
            });
            const setting = await transaction.execute<{ value: string }>(
              "SELECT current_setting('lock_timeout') AS value",
            );
            expect(setting.rows).toEqual([{ value: "50ms" }]);
          });
        } finally {
          await release();
        }
        await requireDefined(backend.adoptBaseSchema)();
      },
    );

    it("converges two cold adopters waiting behind an existing writer", async () => {
      await dropRetention();
      const release = await holdWriter();
      const adopting = Promise.all([
        requireDefined(backend.adoptBaseSchema)(),
        requireDefined(backend.adoptBaseSchema)(),
      ]).catch((error: unknown) => error);
      try {
        await waitForQueuedLock("AccessExclusiveLock", 2);
      } finally {
        await release();
      }
      expect(await adopting).toEqual([undefined, undefined]);
      await requireDefined(backend.assertBaseSchemaCurrent)();
    });

    it("does not run adoption DDL after creating a missing clock", async () => {
      await pool.query("DROP TABLE typegraph_recorded_clock");
      await requireDefined(backend.adoptBaseSchema)();
      expect(adoptionAttempts()).toBe(0);
      await requireDefined(backend.assertBaseSchemaCurrent)();
    });
  },
);
