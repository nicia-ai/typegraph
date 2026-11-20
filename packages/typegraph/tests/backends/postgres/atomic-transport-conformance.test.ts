import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveRegisteredAtomicSqlBatchExecutor } from "../../../src/backend/capabilities/atomic-sql-program";
import { runAtomicTransportConformance } from "../../../src/backend/conformance/atomic-transport";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const RUN_POSTGRES = process.env["POSTGRES_URL"] !== undefined;
const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

type Snapshot = Readonly<{
  primary: readonly string[];
  sidecar: readonly string[];
}>;

function equal(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

describe.runIf(RUN_POSTGRES)(
  "node-postgres atomic transport conformance",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: TEST_DATABASE_URL });
      await pool.query(
        "CREATE TABLE atomic_transport_primary (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      await pool.query(
        "CREATE TABLE atomic_transport_sidecar (id TEXT PRIMARY KEY, primary_id TEXT NOT NULL)",
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it("proves ordered parameters, rollback, and exact-session provenance", async () => {
      const backend = createPostgresBackend(drizzle(pool), { vector: false });
      const executeAtomicBatch =
        resolveRegisteredAtomicSqlBatchExecutor(backend);
      if (executeAtomicBatch === undefined) {
        throw new Error("node-postgres did not expose atomic batch execution");
      }
      const observe = async (): Promise<Snapshot> => {
        const [primary, sidecar] = await Promise.all([
          pool.query<{ id: string }>(
            "SELECT id FROM atomic_transport_primary ORDER BY id",
          ),
          pool.query<{ id: string }>(
            "SELECT id FROM atomic_transport_sidecar ORDER BY id",
          ),
        ]);
        return {
          primary: primary.rows.map((row) => row.id),
          sidecar: sidecar.rows.map((row) => row.id),
        };
      };
      const clear = async () => {
        await pool.query("DELETE FROM atomic_transport_sidecar");
        await pool.query("DELETE FROM atomic_transport_primary");
      };

      const report = await runAtomicTransportConformance<Snapshot, Snapshot>({
        backend,
        derivedBackends: [deriveBackend(backend, {})],
        executeAtomicBatch,
        equal,
        orderedResults: {
          statements: [
            { sql: "SELECT $1::text AS slot", params: ["first"] },
            { sql: "SELECT $1::text AS slot", params: ["second"] },
          ],
          expected: [[{ slot: "first" }], [{ slot: "second" }]],
        },
        parameterPreservation: {
          statements: [
            {
              sql: "INSERT INTO atomic_transport_primary (id, value) VALUES ($1, $2)",
              params: ["parameter-id", "parameter-value"],
            },
          ],
          expected: { primary: ["parameter-id"], sidecar: [] },
          observe,
        },
        rollback: {
          prepare: clear,
          statements: [
            {
              sql: "INSERT INTO atomic_transport_primary (id, value) VALUES ($1, $2)",
              params: ["primary-1", "value"],
            },
            {
              sql: "INSERT INTO atomic_transport_sidecar (id, primary_id) VALUES ($1, $2)",
              params: ["sidecar-1", "primary-1"],
            },
            {
              sql: "INSERT INTO atomic_transport_sidecar (id, primary_id) VALUES ($1, $2)",
              params: ["sidecar-1", "primary-1"],
            },
          ],
          observe,
          expectedBefore: { primary: [], sidecar: [] },
        },
        emptyBatch: {
          prepare: clear,
          observe,
          expected: { primary: [], sidecar: [] },
        },
      });

      expect(report.skipped).toEqual([]);
    });
  },
);
