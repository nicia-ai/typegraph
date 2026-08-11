import { projectBackend } from "../backend/derive-backend";
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
  // The edge cardinality fence. Both members write only the claim relation —
  // a reservation whose holder is a graph row, never a graph row itself — so
  // neither can bypass a capture flush, and a history-enabled store that could
  // not reach them would write constrained edges unfenced.
  "claimEdgeCardinality",
  "claimEdgeCardinalityBatch",
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
  // Installs a database-global extension — and `ensureTrigramExtension` is the
  // same operation under its deprecated `pg_trgm`-only name, so the two are
  // classified together or not at all. Like the `ensure*Table` members they sit
  // beside, they create storage-level scaffolding and write no graph row, so
  // neither can bypass a capture flush.
  "ensureExtension",
  "ensureFulltextTable",
  "ensureIndexMaterializationsTable",
  "ensureKindRemovalsTable",
  "ensureReconciliationMarkersTable",
  "ensureRevisionOriginsTable",
  "ensureRuntimeContributions",
  "ensureTrigramExtension",
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
  // Housekeeping for the relation above: drops claim rows whose holders are
  // already gone. Writes no graph row.
  "purgeEdgeClaims",
  // Read-only fence audit. Writes nothing at all, so it can bypass no capture
  // flush, and a history-enabled store that could not reach it would have no
  // way to report which declared constraint its data already violates.
  "readConstraintFenceViolations",
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
  return Object.freeze(projectBackend(backend, HISTORY_STORE_BACKEND_KEYS));
}
