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

// Needs no load, and its declarations carry none (the packed-artifact check
// asserts it): the only types this entrypoint references from elsewhere come
// through `PostgresTables` from `/adapters/drizzle/postgres`, an alias of
// `ReturnType<typeof …>` that declaration emit spells out rather than names,
// as this inferred return type shows.
export const tablesOption = (
  options: NonNullable<Parameters<typeof createLocalPgliteBackend>[0]>,
) => options.tables;
