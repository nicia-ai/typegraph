import { type GraphBackend } from "./types";

/**
 * Runtime allowlist for the portable GraphBackend port.
 *
 * `satisfies` rejects misspelled/non-port keys. The coverage record below
 * rejects every newly added GraphBackend key until it is deliberately added
 * here, so a port expansion can neither leak through structural forwarding nor
 * silently disappear from a narrowed backend.
 */
const GRAPH_BACKEND_PROJECTION_KEYS = [
  "dialect",
  "capabilities",
  "tableNames",
  "fulltextStrategy",
  "vectorStrategy",
  "insertNode",
  "insertNodeNoReturn",
  "insertNodesBatch",
  "insertNodesBatchReturning",
  "updateNode",
  "deleteNode",
  "hardDeleteNode",
  "getNode",
  "getNodes",
  "insertEdge",
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
  "countEdgesByKind",
  "insertUnique",
  "insertUniqueBatch",
  "deleteUnique",
  "checkUnique",
  "checkUniqueBatch",
  "getActiveSchema",
  "getSchemaVersion",
  "commitSchemaVersion",
  "setActiveVersion",
  "upsertEmbedding",
  "upsertEmbeddingBatch",
  "deleteEmbedding",
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
  "ensureFulltextTable",
  "getReconciliationMarker",
  "setReconciliationMarker",
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
  "transaction",
  "close",
] as const satisfies readonly (keyof GraphBackend)[];

type ProjectedGraphBackendKey = (typeof GRAPH_BACKEND_PROJECTION_KEYS)[number];

const MISSING_GRAPH_BACKEND_PROJECTION_KEYS: Record<
  Exclude<keyof GraphBackend, ProjectedGraphBackendKey>,
  never
> = {};
void MISSING_GRAPH_BACKEND_PROJECTION_KEYS;

/** @internal */
export function projectBackendMembers<
  TBackend extends object,
  const TKey extends keyof TBackend,
>(backend: TBackend, keys: readonly TKey[]): Readonly<Pick<TBackend, TKey>> {
  const entries = keys.flatMap((key) => {
    if (!Reflect.has(backend, key)) return [];
    return [[key, Reflect.get(backend, key)] as const];
  });

  // Keys are constrained to TBackend and values are copied from that same
  // object without reshaping. Optional members remain absent.
  return Object.fromEntries(entries) as Readonly<Pick<TBackend, TKey>>;
}

/**
 * Creates a runtime GraphBackend projection.
 *
 * Structurally wider inputs (for example AdapterBackend) lose every property
 * not named by the portable GraphBackend allowlist. Optional port members stay
 * absent when the source does not provide them.
 *
 * @internal
 */
export function createGraphBackendProjection(
  backend: GraphBackend,
): GraphBackend {
  return projectBackendMembers(backend, GRAPH_BACKEND_PROJECTION_KEYS);
}
