/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/maintenance` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  inspectGraphStorage,
  listGraphIds,
  repairInvertedValidityWindows,
} from "@nicia-ai/typegraph/maintenance";

export const inspect = (...args: Parameters<typeof inspectGraphStorage>) =>
  inspectGraphStorage(...args);
export const graphIds = (...args: Parameters<typeof listGraphIds>) =>
  listGraphIds(...args);
export const repair = (
  ...args: Parameters<typeof repairInvertedValidityWindows>
) => repairInvertedValidityWindows(...args);

// Needs a load: `Store` is exported by the root, not by `/maintenance`, so
// this inferred return type is nameable only through the root the entrypoint
// loads.
export const storeOf = (...args: Parameters<typeof inspectGraphStorage>) =>
  args[0];
