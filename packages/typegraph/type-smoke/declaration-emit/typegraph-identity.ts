/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/identity` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  asIdentityAssertionId,
  pruneIdentityTransitions,
  rebuildIdentityClosure,
} from "@nicia-ai/typegraph/identity";

export const assertionId = asIdentityAssertionId("assertion-1");
export const prune = (...args: Parameters<typeof pruneIdentityTransitions>) =>
  pruneIdentityTransitions(...args);
export const rebuild = (...args: Parameters<typeof rebuildIdentityClosure>) =>
  rebuildIdentityClosure(...args);

// Needs a load: `Store` is exported by the root, not by `/identity`, so this
// inferred return type is nameable only through the root the entrypoint loads.
export const storeOf = (...args: Parameters<typeof rebuildIdentityClosure>) =>
  args[0];
