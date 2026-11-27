/**
 * THE classification of every backend member by what a read-only scope does
 * with it: the table the read-only write gate (`read-only-write-gate.ts`)
 * wraps a backend's members from.
 *
 * - `"write"`: the member can issue a write or DDL statement, or takes a row
 *   or schema lock that only a write takes. Inside a read-only scope the gate
 *   refuses it before any statement.
 * - `"raw"`: the member runs SQL its caller wrote. The gate refuses it only
 *   for a statement library code marked as a write (`markWriteStatement`);
 *   SQL a user hands it is left to the engine, which refuses a write on
 *   PostgreSQL and accepts one on SQLite.
 * - `"read"`: the member issues no write: a read, a static description, an
 *   adoption (whose transaction backend carries the gate itself), or a
 *   statement derivation that runs nothing.
 *
 * A transaction opener is a write: it opens a read-write unit, unless it is
 * asked for `accessMode: "read_only"`, which the gate lets through.
 *
 * Typed over every member name a backend object can carry (the portable
 * `GraphBackend`, the adapter-only members, and the schema-write
 * transaction's own), so a backend member does not compile until it is
 * classified here. `member-classes.ts` is the write pipeline's partition of
 * the same names; every member it classifies in a mutation class is pinned
 * `"write"` here below, so the two cannot disagree about a write.
 */
import { type Assert, type Equal } from "../utils/type-assert";
import type { GRAPH_BACKEND_MEMBER_CLASSES } from "./member-classes";
import type {
  AdapterBackend,
  GraphBackend,
  SchemaWriteTransactionBackend,
} from "./types";

export type BackendMemberAccess = "read" | "write" | "raw";

/** Every member name a backend object, root or transaction, can carry. */
export type BackendMemberName =
  keyof AdapterBackend<unknown> | keyof SchemaWriteTransactionBackend;

const BACKEND_MEMBER_ACCESS = {
  // Static description of the backend.
  dialect: "read",
  capabilities: "read",
  tableNames: "read",
  fulltextStrategy: "read",
  vectorStrategy: "read",
  fenceSql: "read",
  schemaProvisioning: "read",

  // Reads.
  getNode: "read",
  getNodes: "read",
  findNodesByKind: "read",
  findNodesAcrossKinds: "read",
  countNodesByKind: "read",
  getEdge: "read",
  getEdges: "read",
  countEdgesAtEndpoint: "read",
  countEdgesByKind: "read",
  edgeExistsBetween: "read",
  findEdgesConnectedTo: "read",
  findEdgesConnectedToNodes: "read",
  findEdgesByKind: "read",
  findActiveEdgesBySourceV1: "read",
  findEdgesByMatchIdentity: "read",
  findEdgesAcrossKinds: "read",
  findEdgesByEndpointSet: "read",
  findEdgesByHeterogeneousEndpointSet: "read",
  checkUnique: "read",
  checkUniqueBatch: "read",
  vectorSearch: "read",
  fulltextSearch: "read",
  hybridSearch: "read",
  getActiveSchema: "read",
  getSchemaVersion: "read",
  getIndexMaterialization: "read",
  getIndexMaterializations: "read",
  getContributionMaterialization: "read",
  getReconciliationMarker: "read",
  getAllKindRemovals: "read",
  getPendingKindRemovals: "read",
  probeContributions: "read",
  verifyContributions: "read",
  readConstraintFenceViolations: "read",
  revisionChangesJournalReady: "read",
  assertBaseSchemaCurrent: "read",
  assertRuntimeContributionsInitialized: "read",
  assertVectorSlotInitialized: "read",
  assertVectorSlotsInitialized: "read",
  tableExists: "read",
  // Bags of read-only probes, not themselves callable.
  catalog: "read",
  lineage: "read",
  recordedTime: "read",
  // Derive statement text without running it.
  identityTableDdl: "read",
  recordedTableDdl: "read",
  compileSql: "read",
  // Binding a caller's transaction and closing: the transaction backend
  // an adoption hands out carries the gate itself.
  adoptTransaction: "read",
  close: "read",

  // Transaction openers: a read-write unit is a write, refused as it opens;
  // one opened with `accessMode: "read_only"` is a read, and the transaction
  // backend it hands out carries the gate itself.
  transaction: "write",
  transactionWithNative: "write",

  // Row locks a write takes before it writes: PostgreSQL refuses them in a
  // read-only transaction.
  lockNodes: "write",

  // Graph-entity writes.
  insertNode: "write",
  insertNodeIfAbsent: "write",
  insertNodeIfAbsentWithSchemaFence: "write",
  insertNodeWithSchemaFence: "write",
  commands: "write",
  insertNodeNoReturn: "write",
  insertNodesBatch: "write",
  insertNodesBatchReturning: "write",
  updateNode: "write",
  upsertHeterogeneousNodes: "write",
  updateResolvedNodesBatch: "write",
  compareAndSetNode: "write",
  updateNodeSet: "write",
  deleteNode: "write",
  hardDeleteNode: "write",
  hardDeleteNodesBatch: "write",
  insertEdge: "write",
  insertEdgeNoReturn: "write",
  insertEdgesBatch: "write",
  insertEdgesBatchReturning: "write",
  insertEdgesDurableBatchReturning: "write",
  updateEdge: "write",
  deleteEdge: "write",
  deleteEdgesBatch: "write",
  hardDeleteEdge: "write",
  hardDeleteEdgesBatch: "write",

  // Derived-data writes.
  insertUnique: "write",
  insertUniqueBatch: "write",
  deleteUnique: "write",
  hardDeleteUniquesByNodeIds: "write",
  hardDeleteUniquesByConcreteKind: "write",
  claimEdgeCardinality: "write",
  claimEdgeCardinalityGuarded: "write",
  claimEdgeCardinalityBatch: "write",
  purgeEdgeClaims: "write",
  upsertEmbedding: "write",
  upsertEmbeddingBatch: "write",
  deleteEmbedding: "write",
  deleteEmbeddingBatch: "write",
  upsertFulltext: "write",
  upsertFulltextBatch: "write",
  deleteFulltext: "write",
  deleteFulltextBatch: "write",

  // Bulk ingestion.
  trustedImport: "write",

  // Projection maintenance and statistics.
  recordIndexMaterialization: "write",
  claimIndexMaterialization: "write",
  releaseIndexMaterializationClaim: "write",
  recordContributionMaterialization: "write",
  rebuildContribution: "write",
  repairContributions: "write",
  recordKindRemoval: "write",
  setReconciliationMarker: "write",
  refreshStatistics: "write",

  // Schema-version lifecycle and its locks.
  commitSchemaVersion: "write",
  commitSchemaVersionIfKindsEmpty: "write",
  commitSchemaVersionWithPreflight: "write",
  instantiateGraphTemplate: "write",
  registerGraphTemplate: "write",
  setActiveVersion: "write",
  setActiveVersionWithPreflight: "write",
  lockSchemaVersionForWrite: "write",
  lockSchemaVersionAndGraphWrite: "write",
  schemaWriteTransaction: "write",
  adoptSchemaWriteTransaction: "write",
  executeSchemaDdl: "write",
  deleteSchemaVectorSlotContribution: "write",

  // Provisioning and DDL.
  adoptBaseSchema: "write",
  bootstrapTables: "write",
  ensureExtension: "write",
  ensureTrigramExtension: "write",
  ensureFulltextTable: "write",
  ensureIdentityTables: "write",
  ensureIndexMaterializationsTable: "write",
  ensureContributionMaterializationsTable: "write",
  ensureKindRemovalsTable: "write",
  ensureReconciliationMarkersTable: "write",
  ensureRevisionOriginsTable: "write",
  ensureRevisionChangesJournal: "write",
  ensureEdgeMatchIdentityStorage: "write",
  ensureRuntimeContributions: "write",
  ensureVectorSlotContribution: "write",
  ensureVectorSlotContributions: "write",
  deleteVectorSlotContribution: "write",
  createVectorIndex: "write",
  dropVectorIndex: "write",
  executeDdl: "write",

  // Destroys a graph's rows.
  clearGraph: "write",
  clearGraphPreservingContributionMaterializations: "write",

  // SQL the caller wrote.
  execute: "raw",
  executeRaw: "raw",
  executeStatement: "raw",
  executeTemporaryStatement: "raw",
} as const satisfies Readonly<Record<BackendMemberName, BackendMemberAccess>>;

/** The members {@link BACKEND_MEMBER_ACCESS} classifies as `access`. */
export type BackendMembersWithAccess<Access extends BackendMemberAccess> = {
  [
    Member in keyof typeof BACKEND_MEMBER_ACCESS
  ]: (typeof BACKEND_MEMBER_ACCESS)[Member] extends Access ? Member : never;
}[keyof typeof BACKEND_MEMBER_ACCESS];

/** Every member name {@link BACKEND_MEMBER_ACCESS} classifies as `access`. */
export function backendMembersWithAccess<Access extends BackendMemberAccess>(
  access: Access,
): readonly BackendMembersWithAccess<Access>[] {
  return Object.entries(BACKEND_MEMBER_ACCESS).flatMap(([member, value]) =>
    value === access ? [member as BackendMembersWithAccess<Access>] : [],
  );
}

/* eslint-disable @typescript-eslint/no-unused-vars -- compile-time assertions */
// TOTALITY: the table names exactly the members a backend object can carry.
type _everyMemberIsClassified = Assert<
  Equal<keyof typeof BACKEND_MEMBER_ACCESS, BackendMemberName>
>;

// AGREEMENT: every member the write pipeline's partition classifies in a
// mutation class is a write here. Reported by name when one is not.
type MutationClassMember = (typeof GRAPH_BACKEND_MEMBER_CLASSES)[
  | "entityWrite"
  | "sidecarWrite"
  | "bulkWrite"
  | "maintenance"
  | "schema"][number];
type WriteMember = BackendMembersWithAccess<"write">;
type _mutationClassesAreWrites = Assert<
  [Exclude<MutationClassMember, WriteMember>] extends [never] ? true
  : [
      "MUTATION MEMBER NOT CLASSIFIED WRITE",
      Exclude<MutationClassMember, WriteMember>,
    ]
>;
// The raw-SQL class is the raw access, apart from the one that runs nothing.
type _rawSqlIsRaw = Assert<
  Equal<
    Exclude<
      (typeof GRAPH_BACKEND_MEMBER_CLASSES)["rawSql"][number],
      "compileSql"
    >,
    BackendMembersWithAccess<"raw">
  >
>;
// `GraphBackend` is what the portable surface is checked against.
type _graphBackendIsCovered = Assert<
  [Exclude<keyof GraphBackend, BackendMemberName>] extends [never] ? true
  : false
>;
/* eslint-enable @typescript-eslint/no-unused-vars */
