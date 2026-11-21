/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/adapters/drizzle/sqlite/local` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";

// Not exported here: the backend itself. Its type is `AdapterBackend`, a
// backend-authoring contract only `/backend` exports, which stays out of
// covered consumers' declarations until #902 rules on it.

export const database = createLocalSqliteBackend().db;
export const openDatabase = (
  ...args: Parameters<typeof createLocalSqliteBackend>
) => createLocalSqliteBackend(...args).db;
