// Public barrel for @nicia-ai/typegraph/graph-merge.
//
// Keep this surface deliberately narrower than the implementation modules:
// branch()/merge(), the stable option/report types, working-copy extension
// points, typed errors, and durable provenance helpers. The phase-level
// algorithms stay internal and are covered through relative test imports.
export { computeBaseVersion } from "./base-version";
export { branch } from "./branch";
export {
  BaseVersionMismatchError,
  BranchError,
  MERGE_ERROR_CODES,
  MergeConflictError,
  MergeError,
  SimilarityUnavailableError,
} from "./errors";
export { merge, mergeIncremental } from "./merge";
export type { NormalizedMergeOptions } from "./options";
export { MERGE_OPTION_DEFAULTS, normalizeMergeOptions } from "./options";
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
  BaseNodeLookup,
  CandidateSource,
  KeylessConfig,
  SourceScope,
} from "./sources";
export type {
  BaseAmbiguity,
  BaseVersion,
  BranchId,
  BranchOptions,
  BranchProvenance,
  ComparisonCeilingPolicy,
  ConflictingValue,
  DeleteModifyConflict,
  DeleteModifyPolicy,
  DroppedItem,
  Embedder,
  EntityResolution,
  GraphBranch,
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
} from "./types";
export { asBaseVersion, asBranchId } from "./types";
export type { MakeBackend, WorkingCopyStrategy } from "./working-copy";
export { cloneWorkingCopyStrategy } from "./working-copy";
