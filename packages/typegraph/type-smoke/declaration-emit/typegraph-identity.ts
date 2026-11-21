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
