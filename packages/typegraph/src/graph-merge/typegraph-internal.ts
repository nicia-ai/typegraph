export {
  requireWriteFence,
  resolveWriteFencePlan,
} from "../backend/capabilities/write-fence";
export { snapshotExportContention } from "../backend/transaction-resource";
export type {
  GraphBackend,
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
  TypeGraphError,
  type TypeGraphErrorOptions,
} from "../errors";
export type { IdentityTransferAssertion } from "../identity/service";
export type {
  IdentityAssertionWriteFacade,
  IdentityFacade,
} from "../identity/types";
export { exportGraph, exportGraphStream } from "../interchange/export";
export { importGraph, importGraphStream } from "../interchange/import";
export { computeTransitiveClosure, isReachable } from "../ontology/closures";
export {
  META_EDGE_EQUIVALENT_TO,
  META_EDGE_SAME_AS,
} from "../ontology/constants";
// The provenance ownership probe needs graph-scoped raw SQL to look for rows
// under a graph id whose schema was never registered.
export { createSqlSchema } from "../query/compiler/schema";
export { sql } from "../query/sql-fragment";
export { asCompiledRowsSql, asCompiledStatementSql } from "../query/sql-intent";
export { sortedReplacer } from "../schema/canonical";
export { computeSchemaHash, serializeSchema } from "../schema/serializer";
export {
  type OntologyIntrospection,
  type UniqueIntrospection,
} from "../store/introspect";
export { forceWriteTransactionRevision } from "../store/operations/write-transaction";
export {
  advanceRevisionClock,
  forceRecordedGraphRevision,
  readRecordedClock,
  readRevisionOrigin,
} from "../store/recorded-capture";
export {
  storeBackend,
  storeQueryBackend,
  storeRuntime,
  transactionBackend,
} from "../store/runtime-port";
export type { Store } from "../store/store";
export { createStoreWithSchema } from "../store/store";
export { type Edge, type Node, type ValidityEndMutation } from "../store/types";
export { compareCodePoints } from "../utils/compare";
export { canonicalizeDatabaseTimestamp } from "../utils/date";
export { sha256Hex } from "../utils/hash";
export { generateId } from "../utils/id";
export { isSerializationFailure } from "../utils/sql-errors";
