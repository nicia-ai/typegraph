import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  createPostgresTables,
  generatePostgresDropSQL,
  generatePostgresMigrationSQL,
} from "../../../src/backend/postgres";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

describe.runIf(process.env["POSTGRES_URL"] !== undefined)(
  "PostgreSQL working-copy table cleanup",
  () => {
    it("refuses dependent application objects and drops only its own tables", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL });
      const tables = createPostgresTables({
        nodes: 'copy_"nodes',
        edges: "copy_edges",
        fulltext: "copy_fulltext",
      });
      try {
        await pool.query(generatePostgresMigrationSQL(tables));
        await pool.query(
          'CREATE VIEW application_nodes AS SELECT id FROM "copy_""nodes"',
        );
        await expect(
          pool.query(generatePostgresDropSQL(tables)),
        ).rejects.toMatchObject({ code: "2BP01" });
        const before = await pool.query<{ present: boolean }>(
          `SELECT to_regclass('"copy_""nodes"') IS NOT NULL AS present`,
        );
        expect(before.rows[0]?.present).toBe(true);

        await pool.query("DROP VIEW application_nodes");
        await pool.query(generatePostgresDropSQL(tables));
        const after = await pool.query<{ present: boolean }>(
          `SELECT to_regclass('"copy_""nodes"') IS NOT NULL AS present`,
        );
        expect(after.rows[0]?.present).toBe(false);
        await pool.query("CREATE TABLE application_control (id INTEGER)");
        await pool.query(generatePostgresDropSQL(tables));
        const control = await pool.query<{ name: unknown }>(
          "SELECT to_regclass('application_control')::text AS name",
        );
        expect(control.rows[0]?.name).toBe("application_control");
      } finally {
        await pool.end();
      }
    });
  },
);
