/** PostgreSQL parity for the timestamp-only recorded-time migration. */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  migrateLegacyRecordedTime,
  migrateRecordedAnchor,
} from "../../../src/backend/migrate-recorded-time";
import {
  createPostgresBackend,
  createPostgresTables,
} from "../../../src/backend/postgres";

const DATABASE_URL =
  process.env["POSTGRES_URL"] ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";
const RECORDED_NODES = "tg_mrt_recorded_nodes";
const RECORDED_EDGES = "tg_mrt_recorded_edges";
const RECORDED_CLOCK = "tg_mrt_recorded_clock";
const MAPPING_TABLE = `${RECORDED_CLOCK}_legacy_recorded_anchors`;
const FIRST = "2026-01-01T00:00:00.000Z";
const SECOND = "2026-01-01T00:00:00.001Z";
const LEGACY_MAX = "9999-12-31T23:59:59.999Z";

let pool: Pool | undefined;

beforeAll(async () => {
  if (process.env["POSTGRES_URL"] === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  if (pool === undefined) return;
  for (const table of [
    RECORDED_NODES,
    RECORDED_EDGES,
    RECORDED_CLOCK,
    MAPPING_TABLE,
  ]) {
    await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  }
});

async function seedLegacySchema(target: Pool): Promise<void> {
  await target.query(`
    CREATE TABLE "${RECORDED_NODES}" (
      history_id TEXT NOT NULL PRIMARY KEY,
      graph_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      props JSONB NOT NULL,
      version INTEGER NOT NULL,
      valid_from TIMESTAMPTZ,
      valid_to TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ,
      recorded_from TIMESTAMPTZ NOT NULL,
      recorded_to TIMESTAMPTZ NOT NULL,
      op TEXT NOT NULL,
      schema_version INTEGER,
      tx_id TEXT,
      meta JSONB
    );
    CREATE TABLE "${RECORDED_EDGES}" (
      history_id TEXT NOT NULL PRIMARY KEY,
      graph_id TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      from_kind TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_kind TEXT NOT NULL,
      to_id TEXT NOT NULL,
      props JSONB NOT NULL,
      valid_from TIMESTAMPTZ,
      valid_to TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ,
      recorded_from TIMESTAMPTZ NOT NULL,
      recorded_to TIMESTAMPTZ NOT NULL,
      op TEXT NOT NULL,
      schema_version INTEGER,
      tx_id TEXT,
      meta JSONB
    );
    CREATE TABLE "${RECORDED_CLOCK}" (
      graph_id TEXT NOT NULL PRIMARY KEY,
      recorded_at TIMESTAMPTZ NOT NULL
    );
  `);
  await target.query(
    `INSERT INTO "${RECORDED_NODES}" (
       history_id, graph_id, kind, id, props, version, created_at, updated_at,
       recorded_from, recorded_to, op, meta
     ) VALUES
       ('h1', 'pg-legacy', 'Item', 'a', '{"label":"first"}', 1,
        $1, $1, $1, $2, 'create', '{}'),
       ('h2', 'pg-legacy', 'Item', 'a', '{"label":"second"}', 2,
        $1, $2, $2, $3, 'update', '{}')`,
    [FIRST, SECOND, LEGACY_MAX],
  );
  await target.query(
    `INSERT INTO "${RECORDED_CLOCK}" (graph_id, recorded_at)
     VALUES ('pg-legacy', $1)`,
    [SECOND],
  );
}

describe.runIf(process.env["POSTGRES_URL"])(
  "migrateLegacyRecordedTime (PostgreSQL)",
  () => {
    it("rewrites range columns to BIGINT and remaps checkpoints", async () => {
      if (pool === undefined) throw new Error("PostgreSQL pool unavailable");
      await seedLegacySchema(pool);
      const tables = createPostgresTables({
        recordedNodes: RECORDED_NODES,
        recordedEdges: RECORDED_EDGES,
        recordedClock: RECORDED_CLOCK,
      });
      const backend = createPostgresBackend(drizzle(pool), { tables });

      await expect(
        migrateLegacyRecordedTime({ backend }),
      ).resolves.toMatchObject({ migrated: true, anchors: 2, graphs: 1 });
      const columns = await pool.query<{
        column_name: string;
        data_type: string;
      }>(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_name IN ($1, $2)
           AND column_name IN ('recorded_from', 'revision')
         ORDER BY column_name`,
        [RECORDED_NODES, RECORDED_CLOCK],
      );
      expect(columns.rows).toEqual([
        { column_name: "recorded_from", data_type: "bigint" },
        { column_name: "revision", data_type: "bigint" },
      ]);
      await expect(
        migrateRecordedAnchor({
          backend,
          graphId: "pg-legacy",
          anchor: FIRST,
        }),
      ).resolves.toBe("r1:0000000000000001:2026-01-01T00:00:00.000Z");

      await backend.close();
    });
  },
);
