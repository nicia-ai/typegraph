/**
 * `@nicia-ai/typegraph/identity`: the identity-ledger surface behind
 * `store.identity` — assertion, facade, transition and replay types, the
 * maintenance functions, and the identity errors.
 */

export {
  IdentityContradictionError,
  type IdentityContradictionErrorDetails,
  IdentityEndpointValidityError,
  type IdentityEndpointValidityErrorDetails,
  IdentityReplayError,
  type IdentityReplayErrorDetails,
  IdentitySeparationViolationError,
  type IdentitySeparationViolationErrorDetails,
  type IdentityTransitionLogOperation,
  IdentityValidityWindowError,
  type IdentityValidityWindowErrorDetails,
} from "./errors";
export {
  asIdentityAssertionId,
  IDENTITY_REPLAY_DEFAULT_LIMIT,
  IDENTITY_REPLAY_MAX_LIMIT,
  type IdentityAssertion,
  type IdentityAssertionId,
  type IdentityAssertionResult,
  type IdentityAssertionWriteFacade,
  type IdentityClass,
  type IdentityClassPage,
  type IdentityClassPageOptions,
  type IdentityDecisionProvenance,
  type IdentityFacade,
  type IdentityHistoryCompleteness,
  type IdentityHistoryIncompleteReason,
  type IdentityNode,
  type IdentityNodeReference,
  type IdentityNodeRefInput,
  type IdentityPair,
  type IdentityReadFacade,
  type IdentityRelation,
  type IdentityReplay,
  type IdentityReplayOptions,
  type IdentityReplayStep,
  type IdentitySamePathStep,
  type IdentityTransition,
  type IdentityTransitionCause,
  type IdentityTransitionCursor,
  type IdentityTransitionCut,
  type IdentityTransitionHistory,
  type IdentityTransitionPruneResult,
  type IdentityTransitionRetention,
  type IdentityTransitionTransfer,
  type IdentityValidityWindow,
  type IdentityWriteSummary,
  pruneIdentityTransitions,
  rebuildIdentityClosure,
  type RecordedIdentityTransition,
  type RestoredIdentityTransition,
  type TransitionPageCursor,
} from "./identity";

/**
 * Types the public declarations name without being everyday API: exported so
 * a consumer's declaration emit can spell an inferred type through a public
 * specifier. Entrypoints whose declarations name them load this entrypoint's
 * declarations (contract 3 in `tests/public-type-reachability.test.ts`).
 */
export type { PlainNodeRef } from "./identity/sql-target";
