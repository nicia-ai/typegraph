import { type Assert, type ContainsAll } from "../utils/type-assert";
import type { CLAIMS } from "./capabilities/bundle-registry";
import { type GraphBackend } from "./types";

/**
 * Runtime allowlist for the portable GraphBackend port.
 *
 * Data only: the projection constructors that consume this allowlist live in
 * `derive-backend.ts`, the one seam that carries a backend's
 * serialized-resource audit.
 *
 * `satisfies` rejects misspelled/non-port keys. The coverage record below
 * rejects every newly added GraphBackend key until it is deliberately added
 * here, so a port expansion can neither leak through structural forwarding nor
 * silently disappear from a narrowed backend.
 *
 * @internal
 */
export const GRAPH_BACKEND_PROJECTION_KEYS = [
  "dialect",
  "capabilities",
  "tableNames",
  "fulltextStrategy",
  "vectorStrategy",
  "insertNode",
  "insertNodeIfAbsent",
  "insertNodeWithFulltext",
  "insertNodeWithSchemaFenceAndFulltext",
  "insertNodeNoReturn",
  "insertNodesBatch",
  "insertNodesBatchReturning",
  "updateNode",
  "updateNodeSet",
  "deleteNode",
  "hardDeleteNode",
  "getNode",
  "getNodes",
  "insertEdge",
  "insertEdgeIfEndpointsLive",
  "insertEdgeIfEndpointsLiveWithCardinalityClaim",
  "insertEdgeNoReturn",
  "insertEdgesBatch",
  "insertEdgesBatchReturning",
  "updateEdge",
  "deleteEdge",
  "hardDeleteEdge",
  "deleteEdgesBatch",
  "hardDeleteEdgesBatch",
  "getEdge",
  "getEdges",
  "countEdgesFrom",
  "edgeExistsBetween",
  "findEdgesConnectedTo",
  "findNodesByKind",
  "countNodesByKind",
  "findEdgesByKind",
  "findEdgesByEndpointSet",
  "findEdgesByHeterogeneousEndpointSet",
  "countEdgesByKind",
  "insertUnique",
  "insertUniqueBatch",
  "deleteUnique",
  "hardDeleteUniquesByNodeIds",
  "hardDeleteUniquesByConcreteKind",
  "checkUnique",
  "checkUniqueBatch",
  "claimEdgeCardinality",
  "claimEdgeCardinalityGuarded",
  "claimEdgeCardinalityBatch",
  "purgeEdgeClaims",
  "readConstraintFenceViolations",
  "getActiveSchema",
  "getSchemaVersion",
  "commitSchemaVersion",
  "commitSchemaVersionIfKindsEmpty",
  "lockSchemaVersionForWrite",
  "lockSchemaVersionAndGraphWrite",
  "commitSchemaVersionWithPreflight",
  "setActiveVersion",
  "schemaWriteTransaction",
  "upsertEmbedding",
  "upsertEmbeddingBatch",
  "deleteEmbedding",
  "deleteEmbeddingBatch",
  "vectorSearch",
  "createVectorIndex",
  "dropVectorIndex",
  "hybridSearch",
  "upsertFulltext",
  "deleteFulltext",
  "upsertFulltextBatch",
  "deleteFulltextBatch",
  "fulltextSearch",
  "ensureIndexMaterializationsTable",
  "ensureTrigramExtension",
  "ensureRevisionOriginsTable",
  "getIndexMaterialization",
  "getIndexMaterializations",
  "recordIndexMaterialization",
  "claimIndexMaterialization",
  "releaseIndexMaterializationClaim",
  "ensureContributionMaterializationsTable",
  "getContributionMaterialization",
  "recordContributionMaterialization",
  "assertRuntimeContributionsInitialized",
  "ensureKindRemovalsTable",
  "getPendingKindRemovals",
  "getAllKindRemovals",
  "recordKindRemoval",
  "ensureReconciliationMarkersTable",
  "ensureRuntimeContributions",
  "ensureVectorSlotContribution",
  "ensureVectorSlotContributions",
  "assertVectorSlotInitialized",
  "assertVectorSlotsInitialized",
  "deleteVectorSlotContribution",
  "verifyContributions",
  "repairContributions",
  "probeContributions",
  "rebuildContribution",
  "ensureFulltextTable",
  "ensureIdentityTables",
  "identityTableDdl",
  "recordedTableDdl",
  "getReconciliationMarker",
  "setReconciliationMarker",
  "insertNodeIfAbsentWithSchemaFence",
  "insertNodeWithSchemaFence",
  "insertEdgeIfEndpointsLiveWithSchemaFence",
  "clearGraph",
  "bootstrapTables",
  "refreshStatistics",
  "trustedImport",
  "execute",
  "executeStatement",
  "executeTemporaryStatement",
  "executeRaw",
  "compileSql",
  "executeDdl",
  "ensureExtension",
  "transaction",
  "close",
] as const satisfies readonly (keyof GraphBackend)[];

/** @internal */
export type ProjectedGraphBackendKey =
  (typeof GRAPH_BACKEND_PROJECTION_KEYS)[number];

const MISSING_GRAPH_BACKEND_PROJECTION_KEYS: Record<
  Exclude<keyof GraphBackend, ProjectedGraphBackendKey>,
  never
> = {};
void MISSING_GRAPH_BACKEND_PROJECTION_KEYS;

// I13: the projection carries every `claims` core member, or a projected
// backend could forward the declaration while silently dropping one of the
// four members `claimSupport` binds.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _projectionContainsClaimsCore = Assert<
  ContainsAll<
    typeof GRAPH_BACKEND_PROJECTION_KEYS,
    (typeof CLAIMS)["core"][number]
  >
>;
