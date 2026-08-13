/**
 * Validates the bundled capability declarations a factory assembles before
 * exposing them, then deep-freezes the object so nothing downstream can
 * mutate a capability sub-object after the fact (I14).
 */
import { ConfigurationError } from "../../errors";
import { type BackendCapabilities } from "../types";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const propertyValue of Object.values(value as Record<string, unknown>)) {
    deepFreeze(propertyValue);
  }
  return value;
}

/**
 * Refuses a bundled capability declaration that contradicts its own shape,
 * then deep-freezes and returns the same object.
 *
 * Two contradictions are refused:
 *
 * 1. `recursiveTraversal.supported === false` with no `reason` — the
 *    declaration claims the engine cannot recurse but does not say why.
 * 2. `recursiveTraversal.supported === true` with a dangling `reason` — the
 *    declaration claims support while also carrying an explanation for a
 *    lack of it.
 *
 * Deliberately narrow: no `pessimisticLocks` / `graphAnalytics` / surface
 * cross-checks here. An all-`false` lock declaration is legitimate on its
 * own, and declaration-vs-surface consistency is a different concern (a
 * resolved bundle's job, not a bundled declaration's).
 *
 * @throws {ConfigurationError} when a declaration contradicts its own shape.
 */
export function assertBundledCapabilityDeclarations(
  capabilities: BackendCapabilities,
): BackendCapabilities {
  const { recursiveTraversal } = capabilities;
  if (
    recursiveTraversal?.supported === false &&
    recursiveTraversal.reason === undefined
  ) {
    throw new ConfigurationError(
      "Backend capability declaration is contradictory: recursiveTraversal.supported is false but no reason is given.",
      {
        code: "CAPABILITY_DECLARATION_CONTRADICTION",
        member: "recursiveTraversal",
        missing: "reason",
      },
      {
        suggestion:
          "Supply a `reason` explaining why this backend cannot perform recursive traversal.",
      },
    );
  }
  if (
    recursiveTraversal?.supported === true &&
    recursiveTraversal.reason !== undefined
  ) {
    throw new ConfigurationError(
      "Backend capability declaration is contradictory: recursiveTraversal.supported is true but a dangling reason is present.",
      {
        code: "CAPABILITY_DECLARATION_CONTRADICTION",
        member: "recursiveTraversal",
        danglingReason: recursiveTraversal.reason,
      },
      {
        suggestion:
          "Remove `reason` when recursiveTraversal.supported is true — it is only meaningful alongside `supported: false`.",
      },
    );
  }
  return deepFreeze(capabilities);
}
