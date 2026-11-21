/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/adapters/drizzle/indexes` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  buildPostgresEdgeIndexBuilders,
  buildPostgresNodeIndexBuilders,
  buildSqliteEdgeIndexBuilders,
  buildSqliteNodeIndexBuilders,
} from "@nicia-ai/typegraph/adapters/drizzle/indexes";

export const sqliteNodeIndexes = (
  ...args: Parameters<typeof buildSqliteNodeIndexBuilders>
) => buildSqliteNodeIndexBuilders(...args);
export const sqliteEdgeIndexes = (
  ...args: Parameters<typeof buildSqliteEdgeIndexBuilders>
) => buildSqliteEdgeIndexBuilders(...args);
export const postgresNodeIndexes = (
  ...args: Parameters<typeof buildPostgresNodeIndexBuilders>
) => buildPostgresNodeIndexBuilders(...args);
export const postgresEdgeIndexes = (
  ...args: Parameters<typeof buildPostgresEdgeIndexBuilders>
) => buildPostgresEdgeIndexBuilders(...args);
