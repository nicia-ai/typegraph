/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/adapters/drizzle/sqlite` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  createSqliteTables,
  generateSqliteDDL,
  tables,
} from "@nicia-ai/typegraph/adapters/drizzle/sqlite";

// Not exported here: the backend itself. Its type is `AdapterBackend`, a
// backend-authoring contract only `/backend` exports, which stays out of
// covered consumers' declarations until #902 rules on it.
export const customTables = (...args: Parameters<typeof createSqliteTables>) =>
  createSqliteTables(...args);
export const ddl = (...args: Parameters<typeof generateSqliteDDL>) =>
  generateSqliteDDL(...args);
export const defaultTables = tables;
