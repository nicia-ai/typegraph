/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/sqlite/local` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  createLocalSqliteStore,
  DEFAULT_LOCAL_SQLITE_PRAGMAS,
} from "@nicia-ai/typegraph/sqlite/local";

type LocalGraph = Parameters<typeof createLocalSqliteStore>[0];

export const openStore = <G extends LocalGraph>(graph: G) =>
  createLocalSqliteStore(graph, { path: ":memory:" });
export const pragmas = DEFAULT_LOCAL_SQLITE_PRAGMAS;
