export { bindExtraIfReachable } from "../backend/capabilities/bind";
export { BATCH_POINT_READ } from "../backend/capabilities/bundle-registry";
export { requireLineage } from "../backend/capabilities/lineage";
export {
  batchPointReadVerdict,
  recordedRevisionOriginsVerdict,
} from "../backend/capabilities/resolve";
export { runRetriedUnit } from "../backend/capabilities/retried-unit";
export {
  requireFenceLockTables,
  requireWriteFence,
  resolveWriteFencePlan,
} from "../backend/capabilities/write-fence";
export {
  isBackendDerivedFrom,
  wrapWithManagedClose,
} from "../backend/derive-backend";
export {
  sharesSerializedTransactionResource,
  snapshotExportContention,
} from "../backend/transaction-resource";
export type {
  EngineRevision,
  EntityKey,
  GraphBackend,
  GraphReadBackend,
  LineageDelta,
  LineageMembers,
  LineageSession,
  NodeRow,
  TransactionBackend,
  TransactionOptions,
} from "../backend/types";
export { computeUniqueKey } from "../constraints";
export {
  defineInternalGraph,
  getEdgeKinds,
  getNodeKinds,
  type GetNodeType,
  type GraphDef,
  type NodeKinds,
} from "../core/define-graph";
export { defineNode } from "../core/node";
export type { EdgeId, JsonValue, NodeId, NodeType } from "../core/types";
export {
  ConfigurationError,
  IdentityContradictionError,
  NodeNotFoundError,
  TransactionConflictError,
  TypeGraphError,
  type TypeGraphErrorOptions,
} from "../errors";
export {
  bulkIsSeparated,
  IDENTITY_STORAGE_MISSING_CODE,
  separationClassPairKey,
  separationFactsEmpty,
} from "../identity/separation";
export type { IdentityTransferAssertion } from "../identity/service";
export { currentClassKey } from "../identity/service-mutation";
export {
  refKey as identityReferenceKeyOf,
  loadCurrentStructuralClasses,
  loadSpanningDifferentAssertion,
} from "../identity/service-read";
export type { PlainNodeRef } from "../identity/sql-target";
export type { IdentityDecisionProvenance } from "../identity/transition-log";
export type {
  IdentityAssertionWriteFacade,
  IdentityFacade,
  IdentityRelation,
} from "../identity/types";
export { exportGraph, exportGraphStream } from "../interchange/export";
export { importGraph, importGraphStream } from "../interchange/import";
export { getEdgeRowsByIds } from "../store/edge-fetch";
export { getNodeRowsByIds } from "../store/node-fetch";
// The provenance ownership probe needs graph-scoped raw SQL to look for rows
// under a graph id whose schema was never registered.
export {
  createSqlSchema,
  type ResolvedSqlTableNames,
} from "../query/compiler/schema";
export { getDialect } from "../query/dialect";
export { sql } from "../query/sql-fragment";
export { asCompiledRowsSql, asCompiledStatementSql } from "../query/sql-intent";
export { type KindRegistry } from "../registry/kind-registry";
export { sortedReplacer } from "../schema/canonical";
export { computeSchemaHash, serializeSchema } from "../schema/serializer";
export {
  acyclicEdgeRelations,
  type EdgeAcyclicityViolation,
  edgeKindIsInAcyclicRelation,
  type ProposedRelationEdge,
  readProposedEdgeAcyclicityViolations,
} from "../store/acyclicity";
export { type UniqueIntrospection } from "../store/introspect";
export { planCompositionCascade } from "../store/operations/composition-cascade";
export { findLiveCompositionWhole } from "../store/operations/composition-create";
export { type NodeDeletePolicy } from "../store/operations/node-write-pipeline";
export { forceWriteTransactionRevision } from "../store/operations/write-transaction";
export {
  advanceRevisionClock,
  encodeRecordedLineageRevision,
  ensureRevisionOrigin,
  forceRecordedGraphRevision,
  readRecordedClock,
  readRevisionOrigin,
  recordedRelationsLineage,
  resolveLineage,
} from "../store/recorded-capture";
export {
  type GraphWriteLock,
  lockRecordedGraphWrite,
  uncapturedGraphWriteLock,
} from "../store/recorded-capture/clock";
export {
  storeBackend,
  storeCaptureEnabled,
  storeQueryBackend,
  storeRuntime,
  transactionBackend,
  type TransactionDeleteNodeWithPolicy,
  transactionDeleteNodeWithPolicy,
} from "../store/runtime-port";
export type { Store } from "../store/store";
export { createStore, createStoreWithSchema } from "../store/store";
export {
  type Edge,
  type Node,
  type StoreOptions,
  type ValidityEndMutation,
} from "../store/types";
export { compareCodePoints } from "../utils/compare";
export { canonicalizeDatabaseTimestamp } from "../utils/date";
export { sha256Hex } from "../utils/hash";
export { generateId } from "../utils/id";
