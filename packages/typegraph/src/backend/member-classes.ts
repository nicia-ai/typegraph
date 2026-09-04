/**
 * The TOTAL, DISJOINT classification of every {@link GraphBackend} member.
 *
 * The write pipeline bans a set of backend members outside the sanctioned
 * seam, and that ban is only as honest as the list it is computed from. A
 * hand-kept list drifts (a new sidecar write is added and nobody adds it to
 * the ban); a list derived from parameter shapes derives the wrong answers
 * (`CheckUniqueParams` is structurally assignable to `DeleteUniqueParams`, so
 * `checkUnique` — a READ that `WriteTarget` deliberately exposes — comes out
 * classified as a mutation, while `insertUniqueBatch`, a live sidecar write,
 * is missed). Structural assignability cannot express "this exact parameter
 * shape", so the derivation is abandoned in favour of an explicit partition
 * whose two defining properties are pinned at compile time:
 *
 * - **Totality.** Every `keyof GraphBackend` is in some class. Adding a
 *   backend member without classifying it fails `pnpm typecheck`, so whoever
 *   adds the member is the one who decides whether it is a write.
 * - **Disjointness.** No member is in two classes, so "the union of the three
 *   write classes" is a partition of the write surface rather than an
 *   over-count.
 *
 * This lives beside the type it classifies rather than beside its consumer:
 * `src/backend/**` is outside every write-pipeline lint scope (it *is* the
 * backend, and its files legitimately call these members), so the module is
 * data, not a call site.
 *
 * The existing facet types are not a substitute. They cover a strict subset of
 * the members and they deliberately overlap (`compileSql` is in both
 * `RawQueryExecutionBackend` and `SqlCompilationBackend`): a facet is a
 * capability PROJECTION, this is a PARTITION. Different jobs, different
 * module.
 */
import {
  type Assert,
  type ContainsAll,
  type Equal,
} from "../utils/type-assert";
import type { CLAIMS } from "./capabilities/bundle-registry";
import { type GraphBackend } from "./types";

/** Static description of the backend, not an operation. */
const IDENTITY_MEMBERS = [
  "dialect",
  "capabilities",
  "tableNames",
  "fulltextStrategy",
  "vectorStrategy",
  "fenceSql",
] as const satisfies readonly (keyof GraphBackend)[];

/**
 * Reads. `checkUnique` / `checkUniqueBatch` are here on purpose: they PROBE a
 * uniqueness key and write nothing, which is what makes `WriteTarget`'s
 * `Pick<UniqueConstraintBackend, "checkUnique" | "checkUniqueBatch">` coherent
 * with the ban instead of contradicting it.
 */
const READ_MEMBERS = [
  "getNode",
  "getNodes",
  "findNodesByKind",
  "countNodesByKind",
  "getEdge",
  "getEdges",
  "countEdgesFrom",
  "countEdgesByKind",
  "edgeExistsBetween",
  "findEdgesConnectedTo",
  "findEdgesByKind",
  "findEdgesByEndpointSet",
  "findEdgesByHeterogeneousEndpointSet",
  "checkUnique",
  "checkUniqueBatch",
  "vectorSearch",
  "fulltextSearch",
  "hybridSearch",
  "getActiveSchema",
  "getSchemaVersion",
  "getIndexMaterialization",
  "getIndexMaterializations",
  "getContributionMaterialization",
  "getReconciliationMarker",
  "getAllKindRemovals",
  "getPendingKindRemovals",
  "probeContributions",
  "verifyContributions",
  // The constraint-fence AUDIT read. `verifyConstraintFences()` reports
  // contended claim axes without touching them, so it is a probe like
  // `checkUnique` — and for the same reason it must NOT be a write member: the
  // audit runs from `store.ts`, outside any write frame.
  "readConstraintFenceViolations",
] as const satisfies readonly (keyof GraphBackend)[];

/**
 * Graph-entity writes: the node and edge rows themselves. Pinned equal to the
 * recorded-capture write checklist in `write-members.ts` — one owner for "what
 * is a graph-entity write", so the capture overlay and the pipeline ban cannot
 * disagree about it.
 */
export const ENTITY_WRITE_MEMBERS = [
  "insertNode",
  "insertNodeIfAbsent",
  "insertNodeIfAbsentWithSchemaFence",
  "insertNodeWithSchemaFence",
  "commands",
  "insertNodeNoReturn",
  "insertNodesBatch",
  "insertNodesBatchReturning",
  "updateNode",
  "compareAndSetNode",
  "updateNodeSet",
  "deleteNode",
  "hardDeleteNode",
  "insertEdge",
  "insertEdgeNoReturn",
  "insertEdgesBatch",
  "insertEdgesBatchReturning",
  "insertEdgesDurableBatchReturning",
  "updateEdge",
  "deleteEdge",
  "deleteEdgesBatch",
  "hardDeleteEdge",
  "hardDeleteEdgesBatch",
] as const satisfies readonly (keyof GraphBackend)[];

/**
 * Derived-data writes a graph-entity write obliges: CLAIM reservations,
 * embeddings, fulltext. These are the sidecars the fused session methods apply
 * — never something a write path may issue on its own.
 *
 * The claim relations are here, not in a class of their own, because a claim IS
 * derived data a row write obliges: the row and the claim rows that fence it are
 * written as one unit, at placements the claim entry decides, and a path that
 * issued one without the other is precisely the defect the seam closes. Both
 * relations are covered — the `uniques` relation (node uniqueness and
 * `disjointWith` claims) and the `edge_claims` relation (edge cardinality) — so
 * neither family can be written from outside a step or sidecar module.
 */
export const SIDECAR_WRITE_MEMBERS = [
  "insertUnique",
  "insertUniqueBatch",
  "deleteUnique",
  "hardDeleteUniquesByNodeIds",
  "hardDeleteUniquesByConcreteKind",
  "claimEdgeCardinality",
  "claimEdgeCardinalityGuarded",
  "claimEdgeCardinalityBatch",
  "purgeEdgeClaims",
  "upsertEmbedding",
  "upsertEmbeddingBatch",
  "deleteEmbedding",
  "deleteEmbeddingBatch",
  "upsertFulltext",
  "upsertFulltextBatch",
  "deleteFulltext",
  "deleteFulltextBatch",
] as const satisfies readonly (keyof GraphBackend)[];

/**
 * Backend-owned bulk ingestion. `trustedImport` writes graph rows, so it IS a
 * write and is banned outside its declared exemption — leaving it unclassified
 * as a write would make the ban's coverage a lie. It gets its own class
 * because it is an all-or-nothing session that takes the managed-write fence
 * itself and requires empty tables, so no `WritePlan` applies to it.
 */
export const BULK_WRITE_MEMBERS = [
  "trustedImport",
] as const satisfies readonly (keyof GraphBackend)[];

/**
 * Projection maintenance. `rebuildContribution` / `repairContributions`
 * rebuild a whole projection from the rows, take their own fences, and are
 * reached from `store.*` maintenance APIs — never from a row write.
 */
const MAINTENANCE_MEMBERS = [
  "recordIndexMaterialization",
  "claimIndexMaterialization",
  "releaseIndexMaterializationClaim",
  "recordContributionMaterialization",
  "rebuildContribution",
  "repairContributions",
  "recordKindRemoval",
  "setReconciliationMarker",
  "refreshStatistics",
] as const satisfies readonly (keyof GraphBackend)[];

/** Schema-version lifecycle, owned by the schema manager. */
const SCHEMA_MEMBERS = [
  "commitSchemaVersion",
  "commitSchemaVersionIfKindsEmpty",
  "commitSchemaVersionWithPreflight",
  "instantiateGraphTemplate",
  "registerGraphTemplate",
  "setActiveVersion",
  "lockSchemaVersionForWrite",
  "lockSchemaVersionAndGraphWrite",
  "schemaWriteTransaction",
] as const satisfies readonly (keyof GraphBackend)[];

/**
 * Table/index provisioning and DDL — the backend-setup carve-out.
 *
 * `ensureExtension` (and its deprecated `ensureTrigramExtension` alias) install
 * a database-global extension under a per-extension advisory lock. That is DDL
 * provisioning, not a graph write: it precedes every index build, takes its own
 * fence, and no `WritePlan` applies to it.
 */
const PROVISIONING_MEMBERS = [
  "adoptBaseSchema",
  "assertBaseSchemaCurrent",
  "bootstrapTables",
  "catalog",
  "ensureExtension",
  "ensureTrigramExtension",
  "ensureFulltextTable",
  "ensureIdentityTables",
  "ensureIndexMaterializationsTable",
  "ensureContributionMaterializationsTable",
  "ensureKindRemovalsTable",
  "ensureReconciliationMarkersTable",
  "ensureRevisionOriginsTable",
  "ensureEdgeMatchIdentityStorage",
  "ensureRuntimeContributions",
  "ensureVectorSlotContribution",
  "ensureVectorSlotContributions",
  "deleteVectorSlotContribution",
  "createVectorIndex",
  "dropVectorIndex",
  "executeDdl",
  "identityTableDdl",
  "recordedTableDdl",
  "assertRuntimeContributionsInitialized",
  "assertVectorSlotInitialized",
  "assertVectorSlotsInitialized",
] as const satisfies readonly (keyof GraphBackend)[];

/**
 * The raw-SQL seam. Deliberately NOT write members: their uses in scope are
 * raw identity DML, kind-removal materialization and a bare `LOCK TABLE` — no
 * graph-entity or sidecar write, and no sensible `WritePlan`. Banning the
 * names would buy permanent exemptions while still not covering `execute` /
 * `executeRaw`; the raw-SQL seam has its own owner (`identity/sql-target.ts`).
 */
const RAW_SQL_MEMBERS = [
  "execute",
  "executeRaw",
  "compileSql",
  "executeStatement",
  "executeTemporaryStatement",
] as const satisfies readonly (keyof GraphBackend)[];

/**
 * Connection and graph lifecycle. `clearGraph` destroys a graph rather than
 * writing one: it has no `WritePlan`, and its one caller is `store.clear()`.
 */
const LIFECYCLE_MEMBERS = [
  "transaction",
  "close",
  "clearGraph",
] as const satisfies readonly (keyof GraphBackend)[];

/**
 * The partition itself, as data: ten classes whose union is
 * `keyof GraphBackend` and whose pairwise intersections are empty. The two
 * properties are pinned at compile time below; this record is what lets a test
 * witness them at runtime as well, and what keeps a class from being written
 * and then never referenced.
 */
export const GRAPH_BACKEND_MEMBER_CLASSES = {
  identity: IDENTITY_MEMBERS,
  read: READ_MEMBERS,
  entityWrite: ENTITY_WRITE_MEMBERS,
  sidecarWrite: SIDECAR_WRITE_MEMBERS,
  bulkWrite: BULK_WRITE_MEMBERS,
  maintenance: MAINTENANCE_MEMBERS,
  schema: SCHEMA_MEMBERS,
  provisioning: PROVISIONING_MEMBERS,
  rawSql: RAW_SQL_MEMBERS,
  lifecycle: LIFECYCLE_MEMBERS,
} as const;

type IdentityMember = (typeof IDENTITY_MEMBERS)[number];
type ReadMember = (typeof READ_MEMBERS)[number];
type EntityWriteMember = (typeof ENTITY_WRITE_MEMBERS)[number];
type SidecarWriteMember = (typeof SIDECAR_WRITE_MEMBERS)[number];
type BulkWriteMember = (typeof BULK_WRITE_MEMBERS)[number];
type MaintenanceMember = (typeof MAINTENANCE_MEMBERS)[number];
type SchemaMember = (typeof SCHEMA_MEMBERS)[number];
type ProvisioningMember = (typeof PROVISIONING_MEMBERS)[number];
type RawSqlMember = (typeof RAW_SQL_MEMBERS)[number];
type LifecycleMember = (typeof LIFECYCLE_MEMBERS)[number];

/** Every member this module claims to have classified. */
type ClassifiedMember =
  | IdentityMember
  | ReadMember
  | EntityWriteMember
  | SidecarWriteMember
  | BulkWriteMember
  | MaintenanceMember
  | SchemaMember
  | ProvisioningMember
  | RawSqlMember
  | LifecycleMember;

// TOTALITY. A backend member that no class names is UNCLASSIFIED, and this
// line is where that is reported: `pnpm typecheck` fails until someone decides
// which class the new member belongs to — in particular whether it is a write.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _everyMemberIsClassified = Assert<
  Equal<ClassifiedMember, keyof GraphBackend>
>;

/**
 * DISJOINTNESS, written to REPORT the offender.
 *
 * `Assert<Equal<Extract<A, B>, never>>` looks like the obvious spelling and is
 * useless here: inside a generic alias `Equal` defers to `boolean`, which
 * satisfies neither `true` nor `false`, so the assertion passes whatever it is
 * given. Returning a tuple that carries the doubly-classified member makes the
 * failure name it.
 */
type Disjoint<A, B> =
  [Extract<A, B>] extends [never] ? true
  : ["MEMBER CLASSIFIED TWICE", Extract<A, B>];

/* eslint-disable @typescript-eslint/no-unused-vars -- compile-time assertions */
type _d1 = Assert<
  Disjoint<
    IdentityMember,
    | ReadMember
    | EntityWriteMember
    | SidecarWriteMember
    | BulkWriteMember
    | MaintenanceMember
    | SchemaMember
    | ProvisioningMember
    | RawSqlMember
    | LifecycleMember
  >
>;
type _d2 = Assert<
  Disjoint<
    ReadMember,
    | EntityWriteMember
    | SidecarWriteMember
    | BulkWriteMember
    | MaintenanceMember
    | SchemaMember
    | ProvisioningMember
    | RawSqlMember
    | LifecycleMember
  >
>;
type _d3 = Assert<
  Disjoint<
    EntityWriteMember,
    | SidecarWriteMember
    | BulkWriteMember
    | MaintenanceMember
    | SchemaMember
    | ProvisioningMember
    | RawSqlMember
    | LifecycleMember
  >
>;
type _d4 = Assert<
  Disjoint<
    SidecarWriteMember,
    | BulkWriteMember
    | MaintenanceMember
    | SchemaMember
    | ProvisioningMember
    | RawSqlMember
    | LifecycleMember
  >
>;
type _d5 = Assert<
  Disjoint<
    BulkWriteMember,
    | MaintenanceMember
    | SchemaMember
    | ProvisioningMember
    | RawSqlMember
    | LifecycleMember
  >
>;
type _d6 = Assert<
  Disjoint<
    MaintenanceMember,
    SchemaMember | ProvisioningMember | RawSqlMember | LifecycleMember
  >
>;
type _d7 = Assert<
  Disjoint<SchemaMember, ProvisioningMember | RawSqlMember | LifecycleMember>
>;
type _d8 = Assert<Disjoint<ProvisioningMember, RawSqlMember | LifecycleMember>>;
type _d9 = Assert<Disjoint<RawSqlMember, LifecycleMember>>;

// I13: every `claims` core member is classified `sidecarWrite`, or a class
// list that dropped one of the four would silently narrow the write pipeline's
// own view of which members a claim write may call.
type _sidecarWriteContainsClaimsCore = Assert<
  ContainsAll<typeof SIDECAR_WRITE_MEMBERS, (typeof CLAIMS)["core"][number]>
>;
/* eslint-enable @typescript-eslint/no-unused-vars */
