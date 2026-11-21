/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/adapters/drizzle/postgres/pglite` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import { createLocalPgliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres/pglite";

// Not exported here: the backend itself. Its type is `AdapterBackend`, a
// backend-authoring contract only `/backend` exports, which stays out of
// covered consumers' declarations until #902 rules on it.

export const openDatabase = async (
  ...args: Parameters<typeof createLocalPgliteBackend>
) => {
  const { client, db } = await createLocalPgliteBackend(...args);
  return { client, db };
};
