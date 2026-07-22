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
  "compileSql",
  "countEdgesByKind",
  "countEdgesFrom",
  "countNodesByKind",
  "createVectorIndex",
  "deleteEdge",
  "deleteEdgesBatch",
  "deleteEmbedding",
  "deleteFulltext",
  "deleteFulltextBatch",
  "deleteNode",
  "deleteUnique",
  "deleteVectorSlotContribution",
  "dialect",
  "dropVectorIndex",
  "edgeExistsBetween",
  "ensureContributionMaterializationsTable",
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
  "upsertEmbedding",
  "upsertEmbeddingBatch",
  "upsertFulltext",
  "upsertFulltextBatch",
  "vectorSearch",
  "vectorStrategy",
] as const satisfies readonly (keyof GraphBackend)[];

type HistoryStoreBackendMember = (typeof HISTORY_STORE_BACKEND_KEYS)[number];

type UnsafeHistoryStoreBackendMember =
  | "clearGraph"
  | "commitSchemaVersionWithPreflight"
  | "executeDdl"
  | "executeRaw"
  | "executeStatement"
  | "ensureIdentityTables"
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
