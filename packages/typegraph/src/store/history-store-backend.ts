import { projectBackendMembers } from "../backend/graph-backend-projection";
import { type GraphBackend } from "../backend/types";

/**
 * Members that are safe to expose through a history-enabled adapter Store.
 *
 * Graph entity writes remain because the source is the capture-wrapped
 * backend. Direct raw SQL, native import, graph clearing, and nested backend
 * transactions stay internal because each can mutate live rows without a
 * corresponding capture flush.
 */
const HISTORY_STORE_BACKEND_KEYS = [
  "assertRuntimeContributionsInitialized",
  "assertVectorSlotInitialized",
  "assertVectorSlotsInitialized",
  "bootstrapTables",
  "capabilities",
  "checkUnique",
  "checkUniqueBatch",
  "claimIndexMaterialization",
  "close",
  "commitSchemaVersion",
  "commitSchemaVersionIfKindsEmpty",
  "lockSchemaVersionForWrite",
  "compileSql",
  "countEdgesByKind",
  "countEdgesFrom",
  "countNodesByKind",
  "createVectorIndex",
  "deleteEdge",
  "deleteEdgesBatch",
  "deleteEmbedding",
  "deleteEmbeddingBatch",
  "deleteFulltext",
  "deleteFulltextBatch",
  "deleteNode",
  "deleteUnique",
  "hardDeleteUniquesByNodeIds",
  "deleteVectorSlotContribution",
  "dialect",
  "dropVectorIndex",
  "edgeExistsBetween",
  "ensureContributionMaterializationsTable",
  // Installs a database-global extension. Like the `ensure*Table` members it
  // sits beside, it creates storage-level scaffolding and writes no graph row,
  // so it cannot bypass a capture flush.
  "ensureExtension",
  "ensureFulltextTable",
  "ensureIndexMaterializationsTable",
  "ensureKindRemovalsTable",
  "ensureReconciliationMarkersTable",
  "ensureRevisionOriginsTable",
  "ensureRuntimeContributions",
  "ensureVectorSlotContribution",
  "ensureVectorSlotContributions",
  "execute",
  "executeTemporaryStatement",
  "findEdgesByKind",
  "findEdgesByEndpointSet",
  "findEdgesByHeterogeneousEndpointSet",
  "findEdgesConnectedTo",
  "findNodesByKind",
  "fulltextSearch",
  "fulltextStrategy",
  "getActiveSchema",
  "getAllKindRemovals",
  "getContributionMaterialization",
  "getEdge",
  "getEdges",
  "getIndexMaterialization",
  "getIndexMaterializations",
  "getNode",
  "getNodes",
  "getPendingKindRemovals",
  "getReconciliationMarker",
  "getSchemaVersion",
  "hardDeleteEdge",
  "hardDeleteEdgesBatch",
  "hardDeleteNode",
  // Reaps the claims a removed kind's nodes own. Like the sibling
  // `hardDeleteUniquesByNodeIds` beside it, it clears sidecar rows whose
  // entity rows are already gone, so it cannot bypass a capture flush.
  "hardDeleteUniquesByConcreteKind",
  "hardDeleteUniquesByNodeIds",
  "hybridSearch",
  "insertEdge",
  "insertEdgeNoReturn",
  "insertEdgesBatch",
  "insertEdgesBatchReturning",
  "insertNode",
  "insertNodeNoReturn",
  "insertNodesBatch",
  "insertNodesBatchReturning",
  "insertUnique",
  "insertUniqueBatch",
  "probeContributions",
  "recordContributionMaterialization",
  "recordIndexMaterialization",
  "recordKindRemoval",
  "refreshStatistics",
  "releaseIndexMaterializationClaim",
  "setActiveVersion",
  "setReconciliationMarker",
  "tableNames",
  "updateEdge",
  "updateNode",
  "updateNodeSet",
  "upsertEmbedding",
  "upsertEmbeddingBatch",
  "upsertFulltext",
  "upsertFulltextBatch",
  "vectorSearch",
  "vectorStrategy",
  "verifyContributions",
] as const satisfies readonly (keyof GraphBackend)[];

type HistoryStoreBackendMember = (typeof HISTORY_STORE_BACKEND_KEYS)[number];

type UnsafeHistoryStoreBackendMember =
  | "clearGraph"
  | "commitSchemaVersionWithPreflight"
  | "executeDdl"
  | "executeRaw"
  | "executeStatement"
  | "ensureIdentityTables"
  | "identityTableDdl"
  | "rebuildContribution"
  | "repairContributions"
  | "schemaWriteTransaction"
  | "transaction"
  | "trustedImport";

type UnclassifiedHistoryStoreBackendMember = Exclude<
  keyof GraphBackend,
  HistoryStoreBackendMember | UnsafeHistoryStoreBackendMember
>;

export type HistoryStoreBackend =
  UnclassifiedHistoryStoreBackendMember extends never ?
    Readonly<Pick<GraphBackend, HistoryStoreBackendMember>>
  : never;

/** @internal */
export function createHistoryStoreBackendProjection(
  backend: GraphBackend,
): HistoryStoreBackend {
  return Object.freeze(
    projectBackendMembers(backend, HISTORY_STORE_BACKEND_KEYS),
  );
}
