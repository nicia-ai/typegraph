/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/postgres/pglite` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import { createLocalPgliteStore } from "@nicia-ai/typegraph/postgres/pglite";

type LocalGraph = Parameters<typeof createLocalPgliteStore>[0];

export const openStore = <G extends LocalGraph>(graph: G) =>
  createLocalPgliteStore(graph);
