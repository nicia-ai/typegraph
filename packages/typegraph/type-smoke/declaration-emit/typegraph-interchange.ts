/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/interchange` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  exportGraph,
  exportGraphStream,
  GraphDataSchema,
  importGraph,
  ImportOptionsSchema,
} from "@nicia-ai/typegraph/interchange";

export const exportData = (...args: Parameters<typeof exportGraph>) =>
  exportGraph(...args);
export const exportStream = (...args: Parameters<typeof exportGraphStream>) =>
  exportGraphStream(...args);
export const importData = (...args: Parameters<typeof importGraph>) =>
  importGraph(...args);
export const graphDataSchema = GraphDataSchema;
export const importOptions = ImportOptionsSchema.parse({});

// Needs a load: `Store` is exported by the root, not by `/interchange`, so
// this inferred return type is nameable only through the root the entrypoint
// loads.
export const storeOf = (...args: Parameters<typeof exportGraph>) => args[0];
