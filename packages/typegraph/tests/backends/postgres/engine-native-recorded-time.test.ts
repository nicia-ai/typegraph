/**
 * Engine-native recorded time — PostgreSQL SIMULATION, server lane.
 *
 * Skipped unless `POSTGRES_URL` is set (`pnpm test:postgres`); provisions
 * its own database per docs/TESTING.md. See `engine-native-recorded-time-
 * simulation.ts` for the shared scenario and `pglite-engine-native-
 * recorded-time.test.ts` for the always-on PGlite half.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";

import { generateVectorlessPostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import {
  buildEngineNativeSimulation,
  runEngineNativeSimulationScenario,
} from "./engine-native-recorded-time-simulation";

const DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

let pool: Pool | undefined;

beforeAll(async () => {
  if (process.env["POSTGRES_URL"] === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query(generateVectorlessPostgresMigrationSQL());
});

afterAll(async () => {
  await pool?.end();
});

describe.runIf(process.env["POSTGRES_URL"])(
  "engine-native recorded time (PostgreSQL simulation, server)",
  () => {
    it("reconstructs a capturing store's recorded history through a simulated engine-native profile on the SAME database", async () => {
      if (pool === undefined) throw new Error("PostgreSQL pool unavailable");
      const simulation = await buildEngineNativeSimulation(drizzle(pool));
      await runEngineNativeSimulationScenario(simulation);
    });
  },
);
