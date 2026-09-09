/**
 * Engine-native recorded time — PostgreSQL SIMULATION, PGlite lane.
 *
 * See `engine-native-recorded-time-simulation.ts` for what "simulation"
 * means here, why it is trustworthy evidence for the real
 * `GraphBackend.recordedTime` contract, and why the scenario is shared with
 * the server-lane counterpart (`engine-native-recorded-time.test.ts`, gated
 * on `POSTGRES_URL`).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, it } from "vitest";

import { generateVectorlessPostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import {
  buildEngineNativeSimulation,
  runEngineNativeSimulationScenario,
} from "./engine-native-recorded-time-simulation";

describe("engine-native recorded time (PostgreSQL simulation, PGlite)", () => {
  let pglite: PGlite | undefined;

  afterEach(async () => {
    await pglite?.close();
    pglite = undefined;
  });

  it("reconstructs a capturing store's recorded history through a simulated engine-native profile on the SAME database", async () => {
    pglite = await PGlite.create();
    await pglite.exec(generateVectorlessPostgresMigrationSQL());
    const simulation = await buildEngineNativeSimulation(drizzle(pglite));
    await runEngineNativeSimulationScenario(simulation);
  });
});
