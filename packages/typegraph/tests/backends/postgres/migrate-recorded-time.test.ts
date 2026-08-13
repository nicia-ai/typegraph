/** PostgreSQL parity for the timestamp-only recorded-time migration. */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ConfigurationError,
  migrateLegacyRecordedTime,
  migrateRecordedAnchor,
} from "../../../src";
import {
  createPostgresBackend,
  createPostgresTables,
} from "../../../src/backend/postgres";
import { type RecordedTableNames } from "../../../src/backend/types";
import { shortHash } from "../../../src/query/dialect/vector-strategy";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);
const RECORDED_NODES = "tg_mrt_recorded_nodes";
const RECORDED_EDGES = "tg_mrt_recorded_edges";
const RECORDED_CLOCK = "tg_mrt_recorded_clock";
const MAPPING_TABLE = `${RECORDED_CLOCK}_legacy_recorded_anchors`;
const RECORDED_NAMES: RecordedTableNames = {
  recordedNodes: RECORDED_NODES,
  recordedEdges: RECORDED_EDGES,
  recordedClock: RECORDED_CLOCK,
};
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

async function seedLegacySchema(
  target: Pool,
  names: RecordedTableNames,
  options: Readonly<{ withRows?: boolean }> = {},
): Promise<void> {
  await target.query(`
    CREATE TABLE "${names.recordedNodes}" (
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
    CREATE TABLE "${names.recordedEdges}" (
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
    CREATE TABLE "${names.recordedClock}" (
      graph_id TEXT NOT NULL PRIMARY KEY,
      recorded_at TIMESTAMPTZ NOT NULL
    );
  `);
  if (options.withRows === false) return;
  await target.query(
    `INSERT INTO "${names.recordedNodes}" (
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
    `INSERT INTO "${names.recordedClock}" (graph_id, recorded_at)
     VALUES ('pg-legacy', $1)`,
    [SECOND],
  );
}

/**
 * Independent recomputation of the migration's identifier-reduction step
 * (`shortenedIdentifier` in `migrate-recorded-time.ts`), so T7c-2 can tell a
 * dropped reduction (M9) from a correctly reduced constraint name apart —
 * asserting against the same production code the test guards would not.
 */
function expectedReducedConstraintName(tableName: string): string {
  const full = `${tableName}_pkey`;
  if (full.length <= 63) return full;
  return `${full.slice(0, 50)}_${shortHash(full)}`;
}

describe.runIf(process.env["POSTGRES_URL"])(
  "migrateLegacyRecordedTime (PostgreSQL)",
  () => {
    it("rewrites range columns to BIGINT and remaps checkpoints", async () => {
      if (pool === undefined) throw new Error("PostgreSQL pool unavailable");
      await seedLegacySchema(pool, RECORDED_NAMES);
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

    it("rewrites existing empty legacy tables and normalizes constraint names", async () => {
      if (pool === undefined) throw new Error("PostgreSQL pool unavailable");
      await seedLegacySchema(pool, RECORDED_NAMES, { withRows: false });
      const tables = createPostgresTables({
        recordedNodes: RECORDED_NODES,
        recordedEdges: RECORDED_EDGES,
        recordedClock: RECORDED_CLOCK,
      });
      const backend = createPostgresBackend(drizzle(pool), { tables });

      await expect(
        migrateLegacyRecordedTime({ backend }),
      ).resolves.toMatchObject({ migrated: true, anchors: 0, graphs: 0 });
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

      const constraints = await pool.query<{
        constraint_name: string;
        table_name: string;
      }>(
        `SELECT constraint_name, table_name
         FROM information_schema.table_constraints
         WHERE table_schema = current_schema()
           AND constraint_type = 'PRIMARY KEY'
           AND table_name IN ($1, $2, $3)
         ORDER BY table_name`,
        [RECORDED_NODES, RECORDED_EDGES, RECORDED_CLOCK],
      );
      expect(constraints.rows).toEqual([
        {
          constraint_name: `${RECORDED_CLOCK}_pkey`,
          table_name: RECORDED_CLOCK,
        },
        {
          constraint_name: `${RECORDED_EDGES}_pkey`,
          table_name: RECORDED_EDGES,
        },
        {
          constraint_name: `${RECORDED_NODES}_pkey`,
          table_name: RECORDED_NODES,
        },
      ]);

      await backend.close();
    });

    it("fails typed before copying a boundary beyond millisecond precision", async () => {
      if (pool === undefined) throw new Error("PostgreSQL pool unavailable");
      await seedLegacySchema(pool, RECORDED_NAMES);
      await pool.query(
        `UPDATE "${RECORDED_NODES}"
         SET recorded_from = '2026-01-01T00:00:00.000123Z'
         WHERE history_id = 'h1'`,
      );
      const tables = createPostgresTables({
        recordedNodes: RECORDED_NODES,
        recordedEdges: RECORDED_EDGES,
        recordedClock: RECORDED_CLOCK,
      });
      const backend = createPostgresBackend(drizzle(pool), { tables });

      const migration = migrateLegacyRecordedTime({ backend });
      await expect(migration).rejects.toThrow(ConfigurationError);
      await expect(migration).rejects.toThrow(
        "Legacy recorded-time boundaries could not be mapped exactly.",
      );

      const columns = await pool.query<{ data_type: string }>(
        `SELECT data_type
         FROM information_schema.columns
         WHERE table_name = $1 AND column_name = 'recorded_from'`,
        [RECORDED_NODES],
      );
      expect(columns.rows).toEqual([{ data_type: "timestamp with time zone" }]);

      await backend.close();
    });

    it("the engine's primary-key constraint name is the name recordedTableDdl returns", async () => {
      if (pool === undefined) throw new Error("PostgreSQL pool unavailable");
      const names: RecordedTableNames = {
        recordedNodes: "tg_mrt_pk_probe_nodes",
        recordedEdges: "tg_mrt_pk_probe_edges",
        recordedClock: "tg_mrt_pk_probe_clock",
      };
      const tables = createPostgresTables(names);
      const backend = createPostgresBackend(drizzle(pool), { tables });
      const ddl = requireDefined(backend.recordedTableDdl)(names);

      try {
        for (const key of [
          "recordedNodes",
          "recordedEdges",
          "recordedClock",
        ] as const) {
          await pool.query(ddl[key].createTable);
        }
        const constraints = await pool.query<{
          constraint_name: string;
          table_name: string;
        }>(
          `SELECT constraint_name, table_name
           FROM information_schema.table_constraints
           WHERE table_schema = current_schema()
             AND constraint_type = 'PRIMARY KEY'
             AND table_name IN ($1, $2, $3)`,
          [names.recordedNodes, names.recordedEdges, names.recordedClock],
        );
        const constraintNameFor = new Map(
          constraints.rows.map((row) => [row.table_name, row.constraint_name]),
        );
        expect(constraintNameFor.get(names.recordedNodes)).toBe(
          ddl.recordedNodes.primaryKeyConstraintName,
        );
        expect(constraintNameFor.get(names.recordedEdges)).toBe(
          ddl.recordedEdges.primaryKeyConstraintName,
        );
        expect(constraintNameFor.get(names.recordedClock)).toBe(
          ddl.recordedClock.primaryKeyConstraintName,
        );
      } finally {
        for (const name of Object.values(names)) {
          await pool.query(`DROP TABLE IF EXISTS "${name}" CASCADE`);
        }
        await backend.close();
      }
    });

    it("reduces the renamed primary-key constraint for an over-long recorded table name", async () => {
      if (pool === undefined) throw new Error("PostgreSQL pool unavailable");
      const names: RecordedTableNames = {
        recordedNodes: "tg_mrt_long_nodes_".padEnd(60, "z"),
        recordedEdges: "tg_mrt_long_edges_".padEnd(60, "z"),
        recordedClock: "tg_mrt_long_clock_".padEnd(60, "z"),
      };
      // Fixture precondition: every configured name is short enough for
      // `validateTableName`'s 63-byte cap, but `<name>_pkey` is not — which
      // is exactly the condition that forces the migration's rename target
      // through `shortenedIdentifier`.
      for (const name of Object.values(names)) {
        expect(name.length).toBe(60);
        expect(`${name}_pkey`.length).toBeGreaterThan(63);
      }

      try {
        await seedLegacySchema(pool, names);
        const tables = createPostgresTables(names);
        const backend = createPostgresBackend(drizzle(pool), { tables });

        await expect(
          migrateLegacyRecordedTime({ backend }),
        ).resolves.toMatchObject({ migrated: true });

        const constraints = await pool.query<{
          constraint_name: string;
          table_name: string;
        }>(
          `SELECT constraint_name, table_name
           FROM information_schema.table_constraints
           WHERE table_schema = current_schema()
             AND constraint_type = 'PRIMARY KEY'
             AND table_name IN ($1, $2, $3)`,
          [names.recordedNodes, names.recordedEdges, names.recordedClock],
        );
        const constraintNameFor = new Map(
          constraints.rows.map((row) => [row.table_name, row.constraint_name]),
        );
        for (const name of Object.values(names)) {
          const expected = expectedReducedConstraintName(name);
          expect(expected.length).toBeLessThanOrEqual(63);
          expect(constraintNameFor.get(name)).toBe(expected);
        }

        await backend.close();
      } finally {
        for (const name of Object.values(names)) {
          await pool.query(`DROP TABLE IF EXISTS "${name}" CASCADE`);
        }
      }
    });
  },
);
