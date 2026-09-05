/**
 * Validates the bundled capability declarations a factory assembles before
 * exposing them, then clones and deep-freezes the object so nothing
 * downstream can mutate a capability sub-object after the fact (I14) without
 * freezing objects owned by the caller.
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
 * Refuses the pre-execution-profile transaction override at bundled factory
 * boundaries. JavaScript and previously compiled callers can still supply the
 * removed member even though the current TypeScript surface excludes it; a
 * shallow capability merge would preserve it as inert data while leaving
 * interactive transactions enabled.
 *
 * Mapping it silently would also be dishonest: the old boolean cannot state
 * the independent root atomic-batch capability introduced by the replacement
 * execution profile.
 *
 * @internal
 */
export function assertNoLegacyTransactionCapability(
  capabilities: unknown,
): void {
  if (
    typeof capabilities !== "object" ||
    capabilities === null ||
    !Object.hasOwn(capabilities, "transactions")
  ) {
    return;
  }
  throw new ConfigurationError(
    "The capabilities.transactions override was removed; use capabilities.execution.interactiveTransactions instead.",
    {
      code: "LEGACY_CAPABILITY_OVERRIDE",
      member: "transactions",
      replacement: "execution.interactiveTransactions",
    },
    {
      suggestion:
        "Move the transaction availability override under `capabilities.execution.interactiveTransactions`; declare root atomic batching separately through a supported backend transport.",
    },
  );
}

/**
 * Refuses a bundled capability declaration that contradicts its own shape,
 * then returns a deep-frozen, backend-owned clone.
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
  return sealCapabilityDeclaration(capabilities);
}

/**
 * THE one way a capability declaration becomes immutable: a structured clone
 * (so nothing the caller passed in is retained or frozen — I14) that is then
 * deep-frozen. `assertBundledCapabilityDeclarations` seals the finalized
 * capabilities every backend exposes; the two bundled profile builders seal
 * their `declaredCapabilities` the same way before the profile exists, so a
 * profile derived from a bundled one shares an immutable bag rather than a
 * mutable alias of the builder's own declaration.
 */
export function sealCapabilityDeclaration(
  capabilities: BackendCapabilities,
): BackendCapabilities {
  return deepFreeze(structuredClone(capabilities));
}
