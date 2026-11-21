/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/adapters/drizzle/sqlite/libsql` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import { createLibsqlBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/libsql";

// Not exported here: the backend and `libsqlVectorStrategy`. Their types are
// backend-authoring contracts only `/backend` exports, which stay out of
// covered consumers' declarations until #902 rules on it.

export const openDatabase = async (
  ...args: Parameters<typeof createLibsqlBackend>
) => (await createLibsqlBackend(...args)).db;
