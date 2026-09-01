import type { CLAIMS } from "../backend/capabilities/bundle-registry";
import { projectBackend } from "../backend/derive-backend";
import { type GraphBackend } from "../backend/types";
import { type Assert, type ContainsAll } from "../utils/type-assert";

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
  "claimEdgeCardinalityGuarded",
  "claimEdgeCardinalityBatch",
  "claimIndexMaterialization",
  "close",
  "commitSchemaVersion",
  "commitSchemaVersionIfKindsEmpty",
  "lockSchemaVersionForWrite",
  "lockSchemaVersionAndGraphWrite",
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
  "adoptBaseSchema",
  "assertBaseSchemaCurrent",
  "edgeExistsBetween",
  "ensureContributionMaterializationsTable",
  // Installs a database-global extension — and `ensureTrigramExtension` is the
  // same operation under its deprecated `pg_trgm`-only name, so the two are
  // classified together or not at all. Like the `ensure*Table` members they sit
  // beside, they create storage-level scaffolding and write no graph row, so
  // neither can bypass a capture flush.
  "ensureExtension",
  "ensureEdgeMatchIdentityStorage",
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
  "commands",
  "insertEdgeNoReturn",
  "insertEdgesBatch",
  "insertEdgesBatchReturning",
  "insertEdgesDurableBatchReturning",
  "insertNode",
  "insertNodeIfAbsent",
  "insertNodeIfAbsentWithSchemaFence",
  "insertNodeWithSchemaFence",
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
  "compareAndSetNode",
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

// I13: every `claims` core member is exposed through the history-store
// projection, or a history-enabled Store could silently lose access to a
// member `claimSupport` binds — unfencing exactly the constrained edge
// writes the claim relation exists to fence.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _historyStoreContainsClaimsCore = Assert<
  ContainsAll<
    typeof HISTORY_STORE_BACKEND_KEYS,
    (typeof CLAIMS)["core"][number]
  >
>;

type UnsafeHistoryStoreBackendMember =
  | "clearGraph"
  | "commitSchemaVersionWithPreflight"
  | "instantiateGraphTemplate"
  | "executeDdl"
  | "executeRaw"
  | "executeStatement"
  | "ensureIdentityTables"
  | "identityTableDdl"
  | "rebuildContribution"
  | "recordedTableDdl"
  | "repairContributions"
  | "registerGraphTemplate"
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
