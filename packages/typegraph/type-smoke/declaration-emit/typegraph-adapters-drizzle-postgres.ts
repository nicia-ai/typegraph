/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/adapters/drizzle/postgres` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  createPostgresTables,
  generatePostgresDDL,
  tables,
} from "@nicia-ai/typegraph/adapters/drizzle/postgres";

// Not exported here: the backend and the vector strategies. Their types (`AdapterBackend`,
// the strategy contracts) are backend-authoring contracts only `/backend` exports, which stay out of
// covered consumers' declarations until #902 rules on it.
export const customTables = (
  ...args: Parameters<typeof createPostgresTables>
) => createPostgresTables(...args);
export const ddl = (...args: Parameters<typeof generatePostgresDDL>) =>
  generatePostgresDDL(...args);
export const defaultTables = tables;
