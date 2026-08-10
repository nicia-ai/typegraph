/**
 * Stable identity-service entry point.
 *
 * The implementation is divided by responsibility behind this facade so
 * consumers do not depend on its internal module layout.
 */
export {
  readIdentityAssertionPageAtTarget,
  readIdentityAssertionsForInterchange,
} from "./interchange-read";
export { toTransferAssertion } from "./row-codec";
export { UnionFind } from "./service-components";
export {
  createIdentityFacade,
  createIdentityReadFacade,
} from "./service-facade";
export {
  applyIdentityChangesForContext,
  IDENTITY_IMPORT_FAILED_ASSERTION,
  IDENTITY_IMPORT_PROGRESS,
  importIdentityAssertionsIntoTarget,
} from "./service-interchange-write";
export type { IdentityRebuildContext } from "./service-maintenance";
export {
  assertAffectedIdentityClassesConsistent,
  deleteAssertionsTouchingKinds,
  detachIdentityForNode,
  foldIdentityForCreatedNodes,
  hasAssertionsTouchingKinds,
  liveNodeKindsSharingIds,
  purgeAssertionsWithUnregisteredKinds,
  rebuildIdentityClosureForContext,
  removeIdentityKindsForContext,
  requireNodeValidityEndCompatible,
  validateIdentityForContext,
} from "./service-maintenance";
export { loadAssertionsByIds } from "./service-mutation";
export {
  loadCurrentStructuralClasses,
  lockIdentityEnablementNodes,
  lockIdentityGraph,
  refKey,
} from "./service-read";
export type {
  IdentityImportSummary,
  IdentityServiceContext,
  IdentityTransferAssertion,
} from "./service-types";
