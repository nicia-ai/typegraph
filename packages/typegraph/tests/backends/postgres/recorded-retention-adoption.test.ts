import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { BaseSchemaMigrationError } from "../../../src/errors";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { lookupRecordedAnchor } from "../../../src/store/recorded-anchor-log";
import { requireDefined } from "../../../src/utils/presence";
import { isPostgresLockTimeout } from "../../../src/utils/sql-errors";
import { raceTimeout } from "../../concurrency-utils";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const databaseUrl = await provisionPostgresTestDatabase(import.meta.url);

describe.skipIf(!process.env["POSTGRES_URL"])(
  "recorded retention adoption behind a captured writer",
  () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const backend = createPostgresBackend(drizzle(pool), {
      vector: false,
      fulltext: false,
    });
    beforeAll(async () => {
      await requireDefined(backend.bootstrapTables)();
      await pool.query(
        "INSERT INTO typegraph_recorded_clock (graph_id, revision, recorded_at) VALUES ('held', 1, '2026-06-01T00:00:00.000Z')",
      );
    });
    afterAll(async () => {
      await pool.end();
    });

    it("skips column DDL when the watermark column is already installed", async () => {
      await pool.query(
        "UPDATE typegraph_base_schema_versions SET version=8 WHERE installation=1",
      );
      const writer = await pool.connect();
      await writer.query("BEGIN");
      await writer.query(
        "UPDATE typegraph_recorded_clock SET revision=revision WHERE graph_id='held'",
      );
      const adopting = requireDefined(backend.adoptBaseSchema)();
      let result: unknown;
      try {
        result = await raceTimeout(adopting, 500);
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
      }
      await adopting;
      expect(result).toBeUndefined();
    });

    it("refuses missing-column adoption immediately without queueing other graphs' writes", async () => {
      await pool.query(
        "ALTER TABLE typegraph_recorded_clock DROP COLUMN anchor_retention",
      );
      await pool.query(
        "UPDATE typegraph_base_schema_versions SET version=8 WHERE installation=1",
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
      const writer = await pool.connect();
      await writer.query("BEGIN");
      await writer.query(
        "UPDATE typegraph_recorded_clock SET revision=revision WHERE graph_id='held'",
      );
      const adopting = requireDefined(backend.adoptBaseSchema)().then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
      let result: unknown;
      try {
        result = await raceTimeout(adopting, 500);
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
        await writer.query("ROLLBACK");
        writer.release();
      }
      const outcome = await adopting;
      expect(result).toBe(outcome);
      expect(outcome.ok).toBe(false);
      expect(
        isPostgresLockTimeout(outcome.ok ? undefined : outcome.error),
      ).toBe(true);
      const before = await pool.query<{ version: number }>(
        "SELECT version FROM typegraph_base_schema_versions WHERE installation=1",
      );
      expect(before.rows).toEqual([{ version: 8 }]);
      await requireDefined(backend.adoptBaseSchema)();
      const after = await pool.query<{ version: number }>(
        "SELECT version FROM typegraph_base_schema_versions WHERE installation=1",
      );
      expect(after.rows).toEqual([{ version: 9 }]);
    });
  },
);
