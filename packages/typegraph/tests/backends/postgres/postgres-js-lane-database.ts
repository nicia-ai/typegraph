/**
 * Connection, schema and per-test reset for the postgres-js lane's test
 * database.
 *
 * One owner for the postgres-js backend suite and every slice of that lane's
 * shared integration suite: each file provisions its own database, and all of
 * them must prepare and reset it identically.
 */
import postgres, { type Sql } from "postgres";

import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { TRUNCATE_RESETTABLE_TABLES_SQL } from "./managed-tables";

const CONNECT_MAX_ATTEMPTS = 5;
const CONNECT_RETRY_DELAY_MS = 1000;
const CONNECT_TIMEOUT_SECONDS = 5;

/** Pool size of every non-serialized postgres-js client the lane opens. */
export const POSTGRES_JS_LANE_MAX_CONNECTIONS = 4;

/**
 * Opens a client on `databaseUrl`, retrying to absorb CI startup timing.
 * Returns `undefined` when the server never answers.
 */
export async function connectPostgresJsLaneClient(
  databaseUrl: string,
): Promise<Sql | undefined> {
  for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt++) {
    const sql = postgres(databaseUrl, {
      max: POSTGRES_JS_LANE_MAX_CONNECTIONS,
      connect_timeout: CONNECT_TIMEOUT_SECONDS,
      onnotice: () => {
        // Silence NOTICE messages from CREATE IF NOT EXISTS so test
        // output stays readable.
      },
    });

    try {
      await sql`SELECT 1`;
      return sql;
    } catch {
      await sql.end().catch(() => {
        // Ignore cleanup errors
      });
      if (attempt < CONNECT_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, CONNECT_RETRY_DELAY_MS),
        );
      }
    }
  }

  return undefined;
}

/**
 * Runs the generated migration SQL. It uses CREATE TABLE IF NOT EXISTS and
 * CREATE EXTENSION IF NOT EXISTS against a database the calling file just
 * provisioned, so nothing is dropped first.
 */
export async function migratePostgresJsLaneTables(sql: Sql): Promise<void> {
  await sql.unsafe(generatePostgresMigrationSQL());
}

/**
 * Clears all data from TypeGraph tables.
 */
export async function clearPostgresJsLaneData(sql: Sql): Promise<void> {
  // Clear the durable contribution markers (#135) alongside the data so each
  // test starts genuinely un-provisioned: `createStoreWithSchema` (run per
  // test by the integration suite) then re-materializes every per-field
  // vector table + marker in lockstep. Leaving markers behind on this
  // long-lived test database would let a marker outlive a dropped table, so a
  // later boot would trust the marker, skip the CREATE, and writes would hit a
  // missing relation.
  await sql.unsafe(TRUNCATE_RESETTABLE_TABLES_SQL);
  // Per-(kind, field) vector tables are materialized per field, so enumerate
  // and truncate any that exist (there is no single shared embeddings table).
  // createStoreWithSchema re-creates any that are missing (markers cleared).
  const rows = await sql.unsafe<{ tablename: string }[]>(
    String.raw`SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`,
  );
  for (const row of rows) {
    await sql.unsafe(`TRUNCATE "${row.tablename}" CASCADE`);
  }
}
