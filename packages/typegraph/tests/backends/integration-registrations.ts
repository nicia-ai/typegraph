/**
 * The shared integration suite's registrations, as data.
 *
 * Vitest parallelizes and shards by FILE, so a lane that registered every
 * sub-suite from one file ran ~2,000 tests serially on one core. Each lane now
 * registers the suite from several slice files; this module is the single
 * owner of what the suite contains and of which slice each registration lands
 * in, so the slice files only ever state `{ index, count }`.
 *
 * Adding a sub-suite is one line in {@link INTEGRATION_REGISTRATIONS}. It is
 * assigned to a slice automatically — no slice file changes — and
 * `tests/integration-suite-slices.test.ts` fails if any registration is ever
 * dropped or duplicated across a lane's slices.
 */
import {
  registerAdoptedEvolutionConcurrencyTests,
  registerAdoptedEvolutionIntegrationTests,
  registerAdvancedEdgePropertyIntegrationTests,
  registerAggregateIntegrationTests,
  registerAlgorithmIntegrationTests,
  registerBackendProvenanceIntegrationTests,
  registerBatchWriteVerdictIntegrationTests,
  registerBulkFindByIndexIntegrationTests,
  registerBulkFindEndpointIntegrationTests,
  registerBulkFindHeterogeneousIntegrationTests,
  registerBulkUpsertRepeatedIdIntegrationTests,
  registerCapabilityBundleNoThrowIntegrationTests,
  registerCapabilityMemberDropMatrixIntegrationTests,
  registerCapabilityPortBindingIntegrationTests,
  registerCapabilityRefusalIntegrationTests,
  registerClaimCompensationIntegrationTests,
  registerClaimLookupPreferenceIntegrationTests,
  registerClaimOwnerIdentityIntegrationTests,
  registerClearIntegrationTests,
  registerCoalesceUpsertIntegrationTests,
  registerCollectionAggregateIntegrationTests,
  registerCompositionAttachmentIntegrationTests,
  registerCompositionDeletePlanIntegrationTests,
  registerCompositionExistenceIntegrationTests,
  registerCompositionFenceIntegrationTests,
  registerCompositionMembershipReadIntegrationTests,
  registerCompositionNavigationIntegrationTests,
  registerCompositionReadsModelIntegrationTests,
  registerCompositionTighteningIntegrationTests,
  registerCompositionWindowOverlapIntegrationTests,
  registerConstraintFenceErrorIntegrationTests,
  registerConstraintFenceTransactionHealthTests,
  registerConstraintFenceVerificationIntegrationTests,
  registerContributionDiagnosticIntegrationTests,
  registerCrossBackendConsistencyTests,
  registerCurrentIdentityTraversalTests,
  registerDatabaseExpressionQueryIntegrationTests,
  registerDurableEdgeMatchIdentityIntegrationTests,
  registerEdgeAcyclicityIntegrationTests,
  registerEdgeCardinalityTighteningIntegrationTests,
  registerEdgeCaseIntegrationTests,
  registerEdgeClaimSelfHealIntegrationTests,
  registerEdgeOperationIntegrationTests,
  registerEdgePropertyIntegrationTests,
  registerEdgeTargetCardinalityIntegrationTests,
  registerEdgeTargetCardinalityTemporalIntegrationTests,
  registerExpressionSubqueryQueryIntegrationTests,
  registerFulltextIntegrationTests,
  registerGraphAnnotationsIntegrationTests,
  registerGraphMergeCallbackIntegrationTests,
  registerGraphMergeCompositionIntegrationTests,
  registerGraphMergePlanIntegrationTests,
  registerGraphMergeReviewIntegrationTests,
  registerGraphMergeReviewV2IntegrationTests,
  registerGraphMergeTargetCardinalityIntegrationTests,
  registerGraphStorageIntegrationTests,
  registerHistoricalIdentityTraversalTests,
  registerIdentityImportIntegrationTests,
  registerIdentityIntegrationTests,
  registerIdentityReplayIntegrationTests,
  registerIdentitySeparationIntegrationTests,
  registerImportDuplicateEdgeOrderIntegrationTests,
  registerImportRequiredPartPurgeIntegrationTests,
  registerImportTargetCardinalityIntegrationTests,
  registerImportUniquenessIntegrationTests,
  registerKeysetPaginationPropertyTests,
  registerLateMaterializationIntegrationTests,
  registerLegacyClaimAxisIntegrationTests,
  registerLineageConformanceIntegrationTests,
  registerMatchResultFilteringIntegrationTests,
  registerMatchResultRankingIntegrationTests,
  registerMigrateSchemaKindIntegrationTests,
  registerMultiKindQueryIntegrationTests,
  registerMultiRecursiveTraversalIntegrationTests,
  registerMultiRootSubgraphBatchIntegrationTests,
  registerMutationPlanningIntegrationTests,
  registerOntologyEquivalenceIntegrationTests,
  registerOntologyTighteningIntegrationTests,
  registerOntologyTypedSubsumptionIntegrationTests,
  registerOrderingIntegrationTests,
  registerPaginationIntegrationTests,
  registerPredicateIntegrationTests,
  registerProvenanceIntegrationTests,
  registerQueryHookIntegrationTests,
  registerQueryTerminalIntegrationTests,
  registerReadEfficiencyIntegrationTests,
  registerReconciledSchemaIntegrationTests,
  registerRecordedAdjacencyIntegrationTests,
  registerRecordedReadBindingIntegrationTests,
  registerRecordedTimeIntegrationTests,
  registerRecursiveDelimiterIdIntegrationTests,
  registerRecursiveIntegrationTests,
  registerRecursiveSharedIdIntegrationTests,
  registerRecursiveStopExpansionIntegrationTests,
  registerRefusedCreateClaimIntegrationTests,
  registerRelationalCompositionIntegrationTests,
  registerReleasedClaimLookupIntegrationTests,
  registerRemovalMaterializationIntegrationTests,
  registerSavepointRecoveryIntegrationTests,
  registerSchemaCheckedReadIntegrationTests,
  registerSelectiveRetryIntegrationTests,
  registerSetNodeMutationIntegrationTests,
  registerSetOperationIntegrationTests,
  registerStoreAnalysisIntegrationTests,
  registerStoreOperationIntegrationTests,
  registerStoreViewIntegrationTests,
  registerSubgraphIntegrationTests,
  registerSubgraphSharedIdIntegrationTests,
  registerTemporalIntegrationTests,
  registerTemporalOracleIntegrationTests,
  registerTransactionReceiptIntegrationTests,
  registerTraversalIntegrationTests,
  registerTrustedImportIntegrationTests,
  registerUniquenessClaimGateIntegrationTests,
  registerValidityEndClearingIntegrationTests,
  registerValidityLowerBoundIntegrationTests,
  registerWeightedShortestPathExtractionIntegrationTests,
  registerWriteFenceConformanceIntegrationTests,
} from "./integration";
import type { IntegrationTestContext } from "./integration/test-context";

export type IntegrationRegistration = Readonly<{
  register: (context: IntegrationTestContext) => void;
  /**
   * Relative wall-time cost, in thousandths of the whole suite, averaged over
   * the backend lanes it was measured on. Only used to balance slices, so it
   * needs no upkeep: a stale weight costs balance, never coverage. Omit it for
   * a new registration; {@link DEFAULT_REGISTRATION_WEIGHT} applies.
   */
  weight?: number;
}>;

/** Slice `index` (zero-based) of `count` equal-cost parts of the suite. */
export type IntegrationSuiteSlice = Readonly<{ index: number; count: number }>;

/** The mean measured weight: an unmeasured registration is assumed typical. */
const DEFAULT_REGISTRATION_WEIGHT = 8;

export const INTEGRATION_REGISTRATIONS: readonly IntegrationRegistration[] = [
  { register: registerAggregateIntegrationTests, weight: 10 },
  { register: registerCollectionAggregateIntegrationTests, weight: 6 },
  { register: registerDatabaseExpressionQueryIntegrationTests, weight: 4 },
  { register: registerRelationalCompositionIntegrationTests, weight: 9 },
  { register: registerMatchResultRankingIntegrationTests, weight: 1 },
  { register: registerMatchResultFilteringIntegrationTests, weight: 2 },
  { register: registerMultiRecursiveTraversalIntegrationTests, weight: 4 },
  { register: registerMultiKindQueryIntegrationTests, weight: 2 },
  { register: registerMultiRootSubgraphBatchIntegrationTests, weight: 27 },
  { register: registerExpressionSubqueryQueryIntegrationTests, weight: 2 },
  { register: registerQueryTerminalIntegrationTests, weight: 2 },
  { register: registerBackendProvenanceIntegrationTests, weight: 2 },
  { register: registerBulkFindByIndexIntegrationTests, weight: 4 },
  { register: registerBulkFindEndpointIntegrationTests, weight: 6 },
  { register: registerBulkFindHeterogeneousIntegrationTests, weight: 3 },
  { register: registerBulkUpsertRepeatedIdIntegrationTests, weight: 8 },
  { register: registerCapabilityBundleNoThrowIntegrationTests, weight: 1 },
  { register: registerCapabilityMemberDropMatrixIntegrationTests, weight: 1 },
  { register: registerCapabilityPortBindingIntegrationTests, weight: 1 },
  { register: registerCapabilityRefusalIntegrationTests, weight: 2 },
  { register: registerCoalesceUpsertIntegrationTests, weight: 14 },
  { register: registerCompositionAttachmentIntegrationTests, weight: 26 },
  { register: registerCompositionDeletePlanIntegrationTests, weight: 6 },
  { register: registerCompositionExistenceIntegrationTests, weight: 16 },
  { register: registerCompositionFenceIntegrationTests, weight: 6 },
  { register: registerCompositionMembershipReadIntegrationTests, weight: 12 },
  { register: registerCompositionReadsModelIntegrationTests, weight: 15 },
  { register: registerCompositionNavigationIntegrationTests, weight: 22 },
  { register: registerCompositionWindowOverlapIntegrationTests, weight: 7 },
  { register: registerGraphAnnotationsIntegrationTests, weight: 1 },
  { register: registerValidityLowerBoundIntegrationTests, weight: 10 },
  { register: registerValidityEndClearingIntegrationTests, weight: 2 },
  { register: registerContributionDiagnosticIntegrationTests, weight: 7 },
  { register: registerPredicateIntegrationTests, weight: 12 },
  { register: registerProvenanceIntegrationTests, weight: 4 },
  { register: registerQueryHookIntegrationTests, weight: 1 },
  { register: registerReadEfficiencyIntegrationTests, weight: 3 },
  { register: registerOrderingIntegrationTests, weight: 6 },
  { register: registerLateMaterializationIntegrationTests, weight: 3 },
  { register: registerTemporalIntegrationTests, weight: 3 },
  { register: registerTemporalOracleIntegrationTests, weight: 8 },
  { register: registerTransactionReceiptIntegrationTests, weight: 8 },
  { register: registerAdoptedEvolutionIntegrationTests, weight: 10 },
  { register: registerAdoptedEvolutionConcurrencyTests, weight: 1 },
  { register: registerMigrateSchemaKindIntegrationTests, weight: 2 },
  { register: registerReconciledSchemaIntegrationTests, weight: 3 },
  { register: registerOntologyEquivalenceIntegrationTests, weight: 1 },
  { register: registerOntologyTypedSubsumptionIntegrationTests, weight: 12 },
  { register: registerRecordedTimeIntegrationTests, weight: 33 },
  { register: registerRecordedAdjacencyIntegrationTests, weight: 4 },
  { register: registerMutationPlanningIntegrationTests, weight: 17 },
  { register: registerStoreOperationIntegrationTests, weight: 10 },
  { register: registerLineageConformanceIntegrationTests, weight: 5 },
  { register: registerRemovalMaterializationIntegrationTests, weight: 1 },
  { register: registerLegacyClaimAxisIntegrationTests, weight: 2 },
  { register: registerClaimOwnerIdentityIntegrationTests, weight: 1 },
  { register: registerClaimCompensationIntegrationTests, weight: 1 },
  { register: registerClaimLookupPreferenceIntegrationTests, weight: 4 },
  { register: registerReleasedClaimLookupIntegrationTests, weight: 4 },
  { register: registerRefusedCreateClaimIntegrationTests, weight: 1 },
  { register: registerConstraintFenceErrorIntegrationTests, weight: 2 },
  { register: registerConstraintFenceTransactionHealthTests, weight: 1 },
  { register: registerSavepointRecoveryIntegrationTests, weight: 1 },
  { register: registerConstraintFenceVerificationIntegrationTests, weight: 5 },
  { register: registerOntologyTighteningIntegrationTests, weight: 10 },
  { register: registerUniquenessClaimGateIntegrationTests, weight: 12 },
  { register: registerEdgeCardinalityTighteningIntegrationTests, weight: 4 },
  { register: registerCompositionTighteningIntegrationTests, weight: 6 },
  { register: registerRecordedReadBindingIntegrationTests, weight: 2 },
  { register: registerSetOperationIntegrationTests, weight: 3 },
  { register: registerSetNodeMutationIntegrationTests, weight: 8 },
  { register: registerSelectiveRetryIntegrationTests, weight: 2 },
  { register: registerSchemaCheckedReadIntegrationTests, weight: 2 },
  { register: registerEdgeOperationIntegrationTests, weight: 9 },
  { register: registerRecursiveIntegrationTests, weight: 6 },
  { register: registerRecursiveSharedIdIntegrationTests, weight: 2 },
  { register: registerRecursiveDelimiterIdIntegrationTests, weight: 2 },
  { register: registerRecursiveStopExpansionIntegrationTests, weight: 3 },
  { register: registerPaginationIntegrationTests, weight: 11 },
  { register: registerKeysetPaginationPropertyTests, weight: 12 },
  { register: registerTraversalIntegrationTests, weight: 2 },
  { register: registerEdgePropertyIntegrationTests, weight: 4 },
  { register: registerAdvancedEdgePropertyIntegrationTests, weight: 9 },
  { register: registerSubgraphIntegrationTests, weight: 6 },
  { register: registerSubgraphSharedIdIntegrationTests, weight: 16 },
  { register: registerStoreViewIntegrationTests, weight: 9 },
  { register: registerStoreAnalysisIntegrationTests, weight: 2 },
  { register: registerClearIntegrationTests, weight: 3 },
  { register: registerGraphStorageIntegrationTests, weight: 10 },
  { register: registerAlgorithmIntegrationTests, weight: 19 },
  {
    register: registerWeightedShortestPathExtractionIntegrationTests,
    weight: 1,
  },
  { register: registerFulltextIntegrationTests, weight: 4 },
  { register: registerGraphMergeCallbackIntegrationTests, weight: 15 },
  { register: registerGraphMergeCompositionIntegrationTests, weight: 97 },
  { register: registerGraphMergePlanIntegrationTests, weight: 33 },
  { register: registerGraphMergeTargetCardinalityIntegrationTests, weight: 9 },
  { register: registerGraphMergeReviewIntegrationTests, weight: 110 },
  { register: registerGraphMergeReviewV2IntegrationTests, weight: 3 },
  { register: registerImportDuplicateEdgeOrderIntegrationTests, weight: 2 },
  { register: registerImportRequiredPartPurgeIntegrationTests, weight: 3 },
  { register: registerImportTargetCardinalityIntegrationTests, weight: 1 },
  { register: registerImportUniquenessIntegrationTests, weight: 3 },
  { register: registerIdentityIntegrationTests, weight: 22 },
  { register: registerIdentityImportIntegrationTests, weight: 6 },
  { register: registerIdentityReplayIntegrationTests, weight: 20 },
  { register: registerHistoricalIdentityTraversalTests, weight: 8 },
  { register: registerCurrentIdentityTraversalTests, weight: 16 },
  { register: registerIdentitySeparationIntegrationTests, weight: 3 },
  { register: registerEdgeCaseIntegrationTests, weight: 4 },
  { register: registerEdgeAcyclicityIntegrationTests, weight: 8 },
  { register: registerEdgeClaimSelfHealIntegrationTests, weight: 1 },
  { register: registerEdgeTargetCardinalityIntegrationTests, weight: 2 },
  { register: registerBatchWriteVerdictIntegrationTests, weight: 10 },
  {
    register: registerEdgeTargetCardinalityTemporalIntegrationTests,
    weight: 13,
  },
  { register: registerCrossBackendConsistencyTests, weight: 2 },
  { register: registerDurableEdgeMatchIdentityIntegrationTests, weight: 1 },
  { register: registerTrustedImportIntegrationTests, weight: 1 },
  { register: registerWriteFenceConformanceIntegrationTests, weight: 20 },
];

function assertValidSlice(slice: IntegrationSuiteSlice): void {
  const { index, count } = slice;
  const isValid =
    Number.isInteger(count) &&
    count >= 1 &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < count;
  if (!isValid) {
    throw new RangeError(
      `Integration suite slice must satisfy 0 <= index < count with integers (got index ${index} of count ${count}).`,
    );
  }
}

/**
 * The registrations slice `slice.index` of `slice.count` runs, in suite order.
 *
 * Longest-processing-time bin packing: registrations are placed heaviest
 * first, each into the currently lightest slice (ties go to the earlier
 * registration and the lower slice index), so the result depends only on the
 * registration list and `count`. Every registration lands in exactly one
 * slice, and a newly added one is placed like any other.
 */
export function selectIntegrationRegistrations(
  slice: IntegrationSuiteSlice,
  registrations: readonly IntegrationRegistration[] = INTEGRATION_REGISTRATIONS,
): readonly IntegrationRegistration[] {
  assertValidSlice(slice);

  const weighted = registrations.map((registration, position) => ({
    registration,
    position,
    weight: registration.weight ?? DEFAULT_REGISTRATION_WEIGHT,
  }));
  const heaviestFirst = weighted.toSorted(
    (left, right) =>
      right.weight - left.weight || left.position - right.position,
  );

  const sliceLoads = Array.from({ length: slice.count }, () => 0);
  const selected: (typeof weighted)[number][] = [];
  for (const entry of heaviestFirst) {
    const lightestSlice = sliceLoads.indexOf(Math.min(...sliceLoads));
    sliceLoads[lightestSlice] = (sliceLoads[lightestSlice] ?? 0) + entry.weight;
    if (lightestSlice === slice.index) selected.push(entry);
  }

  return selected
    .toSorted((left, right) => left.position - right.position)
    .map((entry) => entry.registration);
}
