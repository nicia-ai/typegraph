import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import {
  BaseSchemaMigrationError,
  SchemaFenceTimeoutError,
} from "../../../src/errors";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { lookupRecordedAnchor } from "../../../src/store/recorded-anchor-log";
import { delay } from "../../../src/utils/delay";
import { requireDefined } from "../../../src/utils/presence";
import { isPostgresLockTimeout } from "../../../src/utils/sql-errors";
import { raceTimeout } from "../../concurrency-utils";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const databaseUrl = await provisionPostgresTestDatabase(import.meta.url);

describe.skipIf(!process.env["POSTGRES_URL"])(
  "recorded retention adoption behind a captured writer",
  () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const statements: string[] = [];
    const backend = createPostgresBackend(
      drizzle(pool, {
        logger: {
          logQuery(query) {
            statements.push(query);
          },
        },
      }),
      { vector: false, fulltext: false },
    );
    beforeAll(async () => {
      await requireDefined(backend.bootstrapTables)();
    });
    beforeEach(async () => {
      await pool.query(
        "ALTER TABLE typegraph_recorded_clock ADD COLUMN IF NOT EXISTS anchor_retention TEXT",
      );
      await pool.query(
        "INSERT INTO typegraph_recorded_clock (graph_id, revision, recorded_at) VALUES ('held', 1, '2026-06-01T00:00:00.000Z') ON CONFLICT DO NOTHING",
      );
      await pool.query(
        "UPDATE typegraph_base_schema_versions SET version=8 WHERE installation=1",
      );
      statements.length = 0;
    });
    afterAll(async () => {
      await pool.end();
    });

    async function holdWriter() {
      const writer = await pool.connect();
      await writer.query("BEGIN");
      await writer.query(
        "UPDATE typegraph_recorded_clock SET revision=revision WHERE graph_id='held'",
      );
      return async () => {
        await writer.query("ROLLBACK");
        writer.release();
      };
    }
    function adoptionAttempts() {
      return statements.filter((query) =>
        query.includes("ACCESS EXCLUSIVE MODE NOWAIT"),
      ).length;
    }
    async function waitForAttempts(minimum = 2) {
      await raceTimeout(
        (async () => {
          while (adoptionAttempts() < minimum) await delay(5);
        })(),
        1000,
      );
    }

    it("skips column DDL when the watermark column is already installed", async () => {
      const release = await holdWriter();
      try {
        await raceTimeout(requireDefined(backend.adoptBaseSchema)(), 500);
      } finally {
        await release();
      }
      expect(adoptionAttempts()).toBe(0);
    });

    it("retries transient contention without queueing other graphs' writes", async () => {
      await pool.query(
        "ALTER TABLE typegraph_recorded_clock DROP COLUMN anchor_retention",
      );
      const release = await holdWriter();
      const adopting = requireDefined(backend.adoptBaseSchema)();
      try {
        await waitForAttempts();
        const independent = await pool.connect();
        try {
          await independent.query("BEGIN");
          await independent.query(
            "LOCK TABLE typegraph_recorded_clock IN ROW EXCLUSIVE MODE NOWAIT",
          );
        } finally {
          await independent.query("ROLLBACK");
          independent.release();
        }
      } finally {
        await release();
      }
      await adopting;
      expect(adoptionAttempts()).toBeGreaterThan(1);
      await requireDefined(backend.assertBaseSchemaCurrent)();
    });

    it("retries contention inside a caller transaction without reusing an aborted session", async () => {
      await pool.query(
        "ALTER TABLE typegraph_recorded_clock DROP COLUMN anchor_retention",
      );
      const release = await holdWriter();
      const adopting = drizzle(pool, {
        logger: {
          logQuery(query) {
            statements.push(query);
          },
        },
      }).transaction(async (transaction) => {
        const attached = createPostgresBackend(transaction, {
          vector: false,
          fulltext: false,
        });
        await requireDefined(attached.adoptBaseSchema)();
        await transaction.execute("SELECT 1");
      });
      try {
        await waitForAttempts();
      } finally {
        await release();
      }
      await adopting;
      expect(adoptionAttempts()).toBeGreaterThan(1);
      await requireDefined(backend.assertBaseSchemaCurrent)();
    });

    it("bounds persistent contention with a typed timeout and leaves adoption resumable", async () => {
      await pool.query(
        "ALTER TABLE typegraph_recorded_clock DROP COLUMN anchor_retention",
      );
      await expect(
        lookupRecordedAnchor(
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
        outcome = await raceTimeout(adopting, 3000);
      } finally {
        await release();
      }
      expect(outcome).toBeInstanceOf(SchemaFenceTimeoutError);
      expect(outcome).toMatchObject({
        details: {
          baseSchemaTable: "typegraph_recorded_clock",
          waitBudgetMs: 1000,
        },
      });
      expect(isPostgresLockTimeout(outcome)).toBe(true);
      expect(adoptionAttempts()).toBeGreaterThan(1);
      const marker = await pool.query(
        "SELECT version FROM typegraph_base_schema_versions WHERE installation=1",
      );
      expect(marker.rows).toEqual([{ version: 8 }]);
      await requireDefined(backend.adoptBaseSchema)();
      await requireDefined(backend.assertBaseSchemaCurrent)();
    });

    it("converges concurrent cold adopters after a captured writer releases", async () => {
      await pool.query(
        "ALTER TABLE typegraph_recorded_clock DROP COLUMN anchor_retention",
      );
      const release = await holdWriter();
      const adopting = Promise.all([
        requireDefined(backend.adoptBaseSchema)(),
        requireDefined(backend.adoptBaseSchema)(),
      ]);
      try {
        await waitForAttempts(3);
      } finally {
        await release();
      }
      await adopting;
      await requireDefined(backend.assertBaseSchemaCurrent)();
    });

    it("does not request an exclusive adoption lock after creating a missing clock", async () => {
      await pool.query("DROP TABLE typegraph_recorded_clock");
      await requireDefined(backend.adoptBaseSchema)();
      expect(adoptionAttempts()).toBe(0);
      const clock = await pool.query(
        "SELECT anchor_retention FROM typegraph_recorded_clock",
      );
      expect(clock.rows).toEqual([]);
      await requireDefined(backend.assertBaseSchemaCurrent)();
    });
  },
);
