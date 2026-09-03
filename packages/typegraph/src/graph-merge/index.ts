// Public barrel for @nicia-ai/typegraph/graph-merge.
//
// Keep this surface deliberately narrower than the implementation modules:
// branch()/merge(), the stable option/report types, working-copy extension
// points, typed errors, and durable provenance helpers. The phase-level
// algorithms stay internal and are covered through relative test imports.
export type {
  ContributionDiagnostic,
  ContributionDiagnosticState,
  ContributionRepairEntry,
  ContributionRepairResult,
} from "../backend/types";
export type { IngestionImportTarget } from "../interchange/ingestion-import-target";
export { computeBaseVersion } from "./base-version";
export { branch } from "./branch";
export type {
  PlanCandidateWriteSetReviewArgs,
  RevalidateCandidateWriteSetReviewArgs,
} from "./candidate-review";
export {
  planCandidateWriteSetReview,
  revalidateCandidateWriteSetReview,
} from "./candidate-review";
export type {
  CandidateWriteSet,
  CandidateWriteSetTarget,
  PlanCandidateWriteSetArgs,
} from "./candidate-write-set";
export {
  CANDIDATE_WRITE_SET_FORMAT_VERSION,
  CandidateWriteSetSchema,
  CandidateWriteSetTargetSchema,
  captureCandidateWriteSetTarget,
  planCandidateWriteSet,
} from "./candidate-write-set";
export type { MergeConstraintConflictErrorDetails } from "./errors";
export {
  BaseVersionMismatchError,
  BranchError,
  CandidateSourceError,
  CandidateWriteSetError,
  IdentityMergeConflictError,
  InvalidMergeOptionsError,
  InvalidMergePlanError,
  MatchEvidenceError,
  MERGE_ERROR_CODES,
  MergeConflictError,
  MergeConstraintConflictError,
  MergeError,
  MergePlanCapabilityError,
  MergePlanDigestMismatchError,
  MergePlanningStaleError,
  MergePlanOriginMismatchError,
  MergePlanSchemaMismatchError,
  MergePlanTargetMismatchError,
  MergeReviewError,
  SimilarityUnavailableError,
  StaleMergePlanError,
  UnsupportedMergePlanVersionError,
} from "./errors";
export type {
  CandidateDiagnostic,
  CandidateDiagnostics,
  EntityRef,
  MatchEvidence,
  MatchSource,
  MatchStrategy,
} from "./evidence";
export { ingestionBranch } from "./ingestion-branch";
export {
  applyMergePlan,
  merge,
  mergeIncremental,
  planMerge,
  planMergeIncremental,
} from "./merge";
export type { NormalizedMergeOptions } from "./options";
export { MERGE_OPTION_DEFAULTS, normalizeMergeOptions } from "./options";
export type {
  MergePlanAnchors,
  MergePlanArtifact,
  MergePlanArtifactV1,
  MergePlanArtifactV1Input,
  MergePlanBranchAnchor,
  MergePlanCandidateDiagnostic,
  MergePlanCanonicalMapping,
  MergePlanDiagnostics,
  MergePlanDigest,
  MergePlanEdgeDelete,
  MergePlanEdgeUpsert,
  MergePlanEntityRef,
  MergePlanEntityResolution,
  MergePlanGuards,
  MergePlanIdentityAssertion,
  MergePlanMatchEvidence,
  MergePlanMatchSource,
  MergePlanNodeDelete,
  MergePlanNodeUpsert,
  MergePlanProposedSummary,
  MergePlanProvenanceOptions,
  MergePlanRetype,
  MergePlanReview,
  MergePlanRevisionFence,
  MergePlanSchemaFence,
  MergePlanSimilarityStrategy,
  MergePlanTargetFence,
  MergePlanTypeReconciliation,
  MergePlanWrites,
} from "./plan-schema";
export {
  MERGE_PLAN_DIGEST_ALGORITHM,
  MERGE_PLAN_FORMAT_VERSION,
} from "./plan-schema";
export type {
  ProvenanceGraph,
  ProvenanceNode,
  ProvenanceQuery,
} from "./provenance-store";
export {
  openProvenanceStore,
  persistProvenanceRecords,
  provenanceGraphId,
  readProvenance,
} from "./provenance-store";
export type { Result } from "./result";
export { isErr, isOk, unwrap } from "./result";
export type {
  MergeReviewArtifact,
  MergeReviewBaseline,
  MergeReviewDifference,
  MergeReviewPolicy,
  MergeReviewRevalidation,
  MergeReviewRow,
} from "./review-schema";
export { MERGE_REVIEW_FORMAT_VERSION } from "./review-schema";
export type {
  BaseNodeLookup,
  CandidateSource,
  KeylessConfig,
  SourceScope,
} from "./sources";
export type { IdentityAssertionWriteFacade } from "./typegraph-internal";
export type {
  BaseAmbiguity,
  BaseVersion,
  BranchId,
  BranchOptions,
  BranchProvenance,
  CandidateDiagnosticsOptions,
  ComparisonCeilingPolicy,
  ConflictingValue,
  DeleteModifyConflict,
  DeleteModifyPolicy,
  DroppedItem,
  Embedder,
  EntityResolution,
  GraphBranch,
  IngestionBranch,
  IngestionNodeCollections,
  MergeBranch,
  MergedCounts,
  MergeIncrementalArgs,
  MergeOptions,
  MergeReport,
  PropertyConflict,
  PropertyConflictPolicy,
  ProvenanceIndex,
  ProvenanceRecord,
  ReconcileTypesMode,
  ResolveConfig,
  ResolvedCluster,
  ResolveMap,
  SimilarityStrategy,
  TypeReconciliation,
  ValidityEndResolution,
} from "./types";
export {
  asBaseVersion,
  asBranchId,
  VALIDITY_END_TARGET_PRECEDENCE,
} from "./types";
export type { MakeBackend, WorkingCopyStrategy } from "./working-copy";
export { cloneWorkingCopyStrategy } from "./working-copy";
