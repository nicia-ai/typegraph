/**
 * Valid arguments for every backend member `member-access.ts` classifies,
 * over the read-only-transaction fixture graph (`read-only-transaction-
 * writes.ts`'s `seed`): typed against each member's own signature, and total
 * over the classification, so a member added to the table does not compile
 * here until it has arguments.
 */
import {
  type BackendMemberName,
  type BackendMembersWithAccess,
} from "../../../src/backend/member-access";
import {
  type AdapterBackend,
  type GraphCommand,
  type GraphCommandExecutionContext,
  type IdentityTableNames,
  type InsertEdgeParams,
  type InsertNodeParams,
  type SchemaWriteTransactionBackend,
} from "../../../src/backend/types";
import { type VectorSlot } from "../../../src/query/dialect/vector-strategy";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledSelectSql } from "../../../src/query/sql-intent";
import { type SerializedSchema } from "../../../src/schema/types";

/** What the argument builders read off the fixture graph. */
export type BackendMemberFixture = Readonly<{
  graphId: string;
  schemaVersion: number;
  schemaHash: string;
  schemaDoc: SerializedSchema;
  identityTableNames: IdentityTableNames;
  /** The caller's native transaction (`tx.sql`). */
  nativeTransaction: unknown;
  /** The command session of the backend object the member is called on. */
  commandSession: GraphCommandExecutionContext["session"];
}>;

type MemberOf<M extends BackendMemberName> =
  M extends keyof AdapterBackend<unknown> ?
    NonNullable<AdapterBackend<unknown>[M]>
  : M extends keyof SchemaWriteTransactionBackend ?
    NonNullable<SchemaWriteTransactionBackend[M]>
  : never;

/** The arguments of a callable member; a command port's are its `execute`'s. */
type MemberArguments<M extends BackendMemberName> =
  MemberOf<M> extends (...args: infer A) => unknown ? A
  : MemberOf<M> extends Readonly<{ execute: (...args: infer A) => unknown }> ? A
  : readonly [];

/**
 * Builds a member's arguments, or names why the member cannot be reached on
 * a backend object a caller holds inside a read-only scope.
 */
type ArgumentBuilder<M extends BackendMemberName> = (
  fixture: BackendMemberFixture,
) => MemberArguments<M> | Readonly<{ unreachable: string }>;

const NOW = "2026-01-01T00:00:00.000Z";

function team(fixture: BackendMemberFixture, id: string): InsertNodeParams {
  return {
    graphId: fixture.graphId,
    kind: "RotTeam",
    id,
    props: { name: id },
  };
}

function knows(fixture: BackendMemberFixture, id: string): InsertEdgeParams {
  return {
    graphId: fixture.graphId,
    id,
    kind: "rotKnows",
    fromKind: "RotPerson",
    fromId: "p2",
    toKind: "RotPerson",
    toId: "p1",
    props: {},
  };
}

function fence(fixture: BackendMemberFixture) {
  return { graphId: fixture.graphId, expectedVersion: fixture.schemaVersion };
}

function slot(fixture: BackendMemberFixture): VectorSlot {
  return {
    graphId: fixture.graphId,
    nodeKind: "RotPerson",
    fieldPath: "embedding",
    dimensions: 2,
    metric: "cosine",
    indexType: "none",
  };
}

function nextVersion(fixture: BackendMemberFixture) {
  return {
    graphId: fixture.graphId,
    expected: { kind: "active", version: fixture.schemaVersion },
    version: fixture.schemaVersion + 1,
    schemaHash: fixture.schemaHash,
    schemaDoc: fixture.schemaDoc,
  } as const;
}

function candidateTeams() {
  return asCompiledSelectSql(sql`SELECT 't1' AS id`);
}

function nodeCreateCommand(fixture: BackendMemberFixture): GraphCommand {
  return {
    kind: "node.create",
    plan: {
      entity: "node",
      params: team(fixture, "t-command"),
      idGenerated: false,
      mode: { kind: "ordinary" },
      claims: [],
      projections: [],
    },
  };
}

function commandContext(
  fixture: BackendMemberFixture,
): GraphCommandExecutionContext {
  return fixture.commandSession === "root" ?
      { session: "root", coordination: "none" }
    : { session: "transaction", coordination: "none" };
}

/** Valid arguments for every member classified `"write"`. */
export const WRITE_MEMBER_ARGUMENTS: {
  readonly [M in BackendMembersWithAccess<"write">]: ArgumentBuilder<M>;
} = {
  transaction: () => [() => Promise.resolve()],
  transactionWithNative: () => [() => Promise.resolve()],
  lockNodes: (f) => [f.graphId, "RotPerson", ["p1"], "edgeEndpoint"],
  insertNode: (f) => [team(f, "t-new")],
  insertNodeIfAbsent: (f) => [team(f, "t-new")],
  insertNodeIfAbsentWithSchemaFence: (f) => [team(f, "t-new"), fence(f)],
  insertNodeWithSchemaFence: (f) => [team(f, "t-new"), fence(f)],
  commands: (f) => [nodeCreateCommand(f), commandContext(f)],
  insertNodeNoReturn: (f) => [team(f, "t-new")],
  insertNodesBatch: (f) => [[team(f, "t-new")]],
  insertNodesBatchReturning: (f) => [[team(f, "t-new")]],
  updateNode: (f) => [
    { graphId: f.graphId, kind: "RotTeam", id: "t1", props: { name: "t1b" } },
  ],
  upsertHeterogeneousNodes: (f) => [
    {
      entries: [
        {
          kind: "RotTeam",
          id: "t-upsert",
          props: { name: "t-upsert" },
          updateProps: { name: "t-upsert" },
        },
      ],
      schemaFence: fence(f),
    },
  ],
  updateResolvedNodesBatch: (f) => [
    {
      entries: [
        {
          graphId: f.graphId,
          kind: "RotTeam",
          id: "t1",
          props: { name: "t1b" },
          expectedVersion: 1,
        },
      ],
    },
  ],
  compareAndSetNode: (f) => [
    {
      operation: "compareAndSet",
      graphId: f.graphId,
      kind: "RotTeam",
      patch: { name: "t1b" },
      candidateIds: candidateTeams(),
      candidateIdColumn: "id",
      expected: {},
    },
  ],
  updateNodeSet: (f) => [
    {
      operation: "updateWhere",
      graphId: f.graphId,
      kind: "RotTeam",
      patch: { name: "t1b" },
      candidateIds: candidateTeams(),
      candidateIdColumn: "id",
    },
  ],
  deleteNode: (f) => [{ graphId: f.graphId, kind: "RotTeam", id: "t2" }],
  hardDeleteNode: (f) => [{ graphId: f.graphId, kind: "RotTeam", id: "t2" }],
  hardDeleteNodesBatch: (f) => [
    { graphId: f.graphId, kind: "RotTeam", ids: ["t2"] },
  ],
  insertEdge: (f) => [knows(f, "k-new")],
  insertEdgeNoReturn: (f) => [knows(f, "k-new")],
  insertEdgesBatch: (f) => [[knows(f, "k-new")]],
  insertEdgesBatchReturning: (f) => [[knows(f, "k-new")]],
  insertEdgesDurableBatchReturning: (f) => [[knows(f, "k-new")]],
  updateEdge: (f) => [{ graphId: f.graphId, id: "k1", props: {} }],
  deleteEdge: (f) => [{ graphId: f.graphId, id: "k1" }],
  deleteEdgesBatch: (f) => [{ graphId: f.graphId, ids: ["k1"] }],
  hardDeleteEdge: (f) => [{ graphId: f.graphId, id: "k1" }],
  hardDeleteEdgesBatch: (f) => [{ graphId: f.graphId, ids: ["k1"] }],
  insertUnique: (f) => [
    {
      graphId: f.graphId,
      nodeKind: "RotPerson",
      constraintName: "rot_person_email",
      key: "new@example.test",
      nodeId: "p1",
      concreteKind: "RotPerson",
    },
  ],
  insertUniqueBatch: (f) => [
    [
      {
        graphId: f.graphId,
        nodeKind: "RotPerson",
        constraintName: "rot_person_email",
        key: "new@example.test",
        nodeId: "p1",
        concreteKind: "RotPerson",
      },
    ],
  ],
  deleteUnique: (f) => [
    {
      graphId: f.graphId,
      nodeKind: "RotPerson",
      constraintName: "rot_person_email",
      key: "p1@example.test",
      nodeId: "p1",
      concreteKind: "RotPerson",
    },
  ],
  releaseUniquesByOwner: (f) => [
    {
      graphId: f.graphId,
      concreteKind: "RotPerson",
      nodeId: "p1",
      constraintNames: ["rot_person_email"],
      keep: [],
    },
  ],
  hardDeleteUniquesByNodeIds: (f) => [
    { graphId: f.graphId, concreteKind: "RotPerson", nodeIds: ["p1"] },
  ],
  hardDeleteUniquesByConcreteKind: (f) => [
    { graphId: f.graphId, concreteKind: "RotPerson" },
  ],
  claimEdgeCardinality: (f) => [memberOfClaim(f)],
  claimEdgeCardinalityGuarded: (f) => [memberOfClaim(f)],
  claimEdgeCardinalityBatch: (f) => [[memberOfClaim(f)]],
  purgeEdgeClaims: (f) => [{ graphId: f.graphId, edgeIds: ["m1"] }],
  upsertEmbedding: (f) => [{ ...slot(f), nodeId: "p1", embedding: [0.1, 0.2] }],
  upsertEmbeddingBatch: (f) => [
    { ...slot(f), rows: [{ nodeId: "p1", embedding: [0.1, 0.2] }] },
  ],
  deleteEmbedding: (f) => [{ ...slot(f), nodeId: "p1" }],
  deleteEmbeddingBatch: (f) => [{ ...slot(f), nodeIds: ["p1"] }],
  upsertFulltext: (f) => [
    {
      graphId: f.graphId,
      nodeKind: "RotPerson",
      nodeId: "p1",
      content: "p1",
      language: "english",
    },
  ],
  upsertFulltextBatch: (f) => [
    {
      graphId: f.graphId,
      nodeKind: "RotPerson",
      rows: [{ nodeId: "p1", content: "p1", language: "english" }],
    },
  ],
  deleteFulltext: (f) => [
    { graphId: f.graphId, nodeKind: "RotPerson", nodeId: "p1" },
  ],
  deleteFulltextBatch: (f) => [
    { graphId: f.graphId, nodeKind: "RotPerson", nodeIds: ["p1"] },
  ],
  trustedImport: () => [() => Promise.resolve()],
  recordIndexMaterialization: (f) => [
    {
      indexName: "rot_gate_index",
      graphId: f.graphId,
      entity: "node",
      kind: "RotPerson",
      signature: "signature",
      schemaVersion: f.schemaVersion,
      attemptedAt: NOW,
      materializedAt: NOW,
      error: undefined,
    },
  ],
  claimIndexMaterialization: (f) => [
    {
      indexName: "rot_gate_index",
      graphId: f.graphId,
      entity: "node",
      kind: "RotPerson",
      signature: "signature",
      schemaVersion: f.schemaVersion,
      token: "token",
      leaseMs: 60_000,
    },
  ],
  releaseIndexMaterializationClaim: () => [
    { indexName: "rot_gate_index", token: "token" },
  ],
  recordContributionMaterialization: (f) => [
    {
      graphId: f.graphId,
      logicalName: "fulltext",
      owner: "fulltext",
      tableName: "rot_gate_fulltext",
      signature: "signature",
      attemptedAt: NOW,
      materializedAt: NOW,
      error: undefined,
    },
  ],
  rebuildContribution: (f) => [
    f.graphId,
    "fulltext",
    () => Promise.resolve({ processed: 0, repopulated: 0, skipped: 0 }),
  ],
  repairContributions: (f) => [f.graphId, []],
  recordKindRemoval: (f) => [
    {
      graphId: f.graphId,
      kindName: "RotTeam",
      entity: "node",
      schemaVersion: f.schemaVersion,
      attemptedAt: NOW,
      removedAt: undefined,
      error: undefined,
    },
  ],
  setReconciliationMarker: (f) => [f.graphId, f.schemaVersion],
  refreshStatistics: () => [],
  commitSchemaVersion: (f) => [nextVersion(f)],
  commitSchemaVersionIfKindsEmpty: (f) => [
    nextVersion(f),
    [{ entity: "node", kind: "RotTeam", rows: "all" }],
  ],
  commitSchemaVersionWithPreflight: (f) => [
    nextVersion(f),
    () => Promise.resolve(),
  ],
  instantiateGraphTemplate: (f) => [
    {
      templateId: "rot_gate_template",
      templateSchemaHash: f.schemaHash,
      graphId: `${f.graphId}_instance`,
      schemaHash: f.schemaHash,
    },
  ],
  registerGraphTemplate: (f) => [
    {
      templateId: "rot_gate_template",
      schemaHash: f.schemaHash,
      schemaDoc: f.schemaDoc,
    },
  ],
  setActiveVersion: (f) => [
    {
      graphId: f.graphId,
      expected: { kind: "active", version: f.schemaVersion },
      version: f.schemaVersion,
    },
  ],
  setActiveVersionWithPreflight: (f) => [
    {
      graphId: f.graphId,
      expected: { kind: "active", version: f.schemaVersion },
      version: f.schemaVersion,
    },
    () => Promise.resolve(),
  ],
  lockSchemaVersionForWrite: (f) => [fence(f)],
  lockSchemaVersionAndGraphWrite: (f) => [{ ...fence(f), fenceRow: "leave" }],
  schemaWriteTransaction: (f) => [f.graphId, () => Promise.resolve()],
  adoptSchemaWriteTransaction: (f) => [
    f.nativeTransaction,
    f.graphId,
    { waitBudgetMs: 1000 },
  ],
  executeSchemaDdl: () => ({
    unreachable:
      "only on the transaction schemaWriteTransaction() hands out, which is refused",
  }),
  deleteSchemaVectorSlotContribution: () => ({
    unreachable:
      "only on the transaction schemaWriteTransaction() hands out, which is refused",
  }),
  adoptBaseSchema: () => [],
  bootstrapTables: () => [],
  ensureExtension: () => ["pg_trgm"],
  ensureTrigramExtension: () => [],
  ensureFulltextTable: (f) => [f.graphId],
  ensureIdentityTables: (f) => [
    f.identityTableNames,
    { provisionMissing: true },
  ],
  ensureIndexMaterializationsTable: () => [],
  ensureContributionMaterializationsTable: () => [],
  ensureKindRemovalsTable: () => [],
  ensureReconciliationMarkersTable: () => [],
  ensureRevisionOriginsTable: () => [],
  ensureRevisionChangesJournal: () => [],
  ensureEdgeMatchIdentityStorage: () => [],
  ensureRuntimeContributions: (f) => [f.graphId],
  ensureVectorSlotContribution: (f) => [slot(f)],
  ensureVectorSlotContributions: (f) => [[slot(f)]],
  deleteVectorSlotContribution: (f) => [slot(f)],
  createVectorIndex: (f) => [{ ...slot(f), indexType: "hnsw" }],
  dropVectorIndex: (f) => [
    { graphId: f.graphId, nodeKind: "RotPerson", fieldPath: "embedding" },
  ],
  executeDdl: () => ["CREATE TABLE rot_gate_probe (x INTEGER)"],
  clearGraph: (f) => [f.graphId],
  clearGraphPreservingContributionMaterializations: (f) => [f.graphId],
};

function memberOfClaim(f: BackendMemberFixture) {
  return {
    graphId: f.graphId,
    direction: "source",
    cardinality: "one",
    edgeKind: "rotMemberOf",
    edgeId: "m-new",
    fromKind: "RotPerson",
    fromId: "p2",
    toKind: "RotTeam",
    toId: "t1",
  } as const;
}

/** Valid arguments for every callable member classified `"read"`. */
export const READ_MEMBER_ARGUMENTS: {
  readonly [M in BackendMembersWithAccess<"read">]: ArgumentBuilder<M>;
} = {
  dialect: () => ({ unreachable: "a static description, not callable" }),
  capabilities: () => ({ unreachable: "a static description, not callable" }),
  tableNames: () => ({ unreachable: "a static description, not callable" }),
  fulltextStrategy: () => ({
    unreachable: "a static description, not callable",
  }),
  vectorStrategy: () => ({
    unreachable: "a static description, not callable",
  }),
  fenceSql: () => ({ unreachable: "a static description, not callable" }),
  schemaProvisioning: () => ({
    unreachable: "a static description, not callable",
  }),
  catalog: () => ({ unreachable: "a bag of probes, not callable" }),
  lineage: () => ({ unreachable: "a bag of probes, not callable" }),
  recordedTime: () => ({ unreachable: "a bag of probes, not callable" }),
  close: () => ({
    unreachable: "ends the backend the rest of the case still uses",
  }),
  adoptTransaction: (f) => [f.nativeTransaction],
  getNode: (f) => [f.graphId, "RotPerson", "p1"],
  getNodes: (f) => [f.graphId, "RotPerson", ["p1", "p2"]],
  findNodesByKind: (f) => [{ graphId: f.graphId, kind: "RotPerson" }],
  findNodesAcrossKinds: (f) => [
    { graphId: f.graphId, kinds: ["RotPerson", "RotTeam"], limit: 10 },
  ],
  countNodesByKind: (f) => [{ graphId: f.graphId, kind: "RotPerson" }],
  getEdge: (f) => [f.graphId, "k1"],
  getEdges: (f) => [f.graphId, ["k1", "m1"]],
  countEdgesAtEndpoint: (f) => [
    {
      graphId: f.graphId,
      edgeKind: "rotKnows",
      endpoint: "from",
      endpointKind: "RotPerson",
      endpointId: "p1",
    },
  ],
  countEdgesByKind: (f) => [{ graphId: f.graphId, kind: "rotKnows" }],
  edgeExistsBetween: (f) => [
    {
      graphId: f.graphId,
      edgeKind: "rotKnows",
      fromKind: "RotPerson",
      fromId: "p1",
      toKind: "RotPerson",
      toId: "p2",
    },
  ],
  findEdgesConnectedTo: (f) => [
    { graphId: f.graphId, nodeKind: "RotPerson", nodeId: "p1" },
  ],
  findEdgesConnectedToNodes: (f) => [
    { graphId: f.graphId, nodeKind: "RotPerson", nodeIds: ["p1"] },
  ],
  findEdgesByKind: (f) => [{ graphId: f.graphId, kind: "rotKnows" }],
  findActiveEdgesBySourceV1: (f) => [
    {
      graphId: f.graphId,
      edgeKind: "rotKnows",
      fromKind: "RotPerson",
      fromId: "p1",
    },
  ],
  findEdgesByMatchIdentity: (f) => [
    {
      graphId: f.graphId,
      identities: [{ kind: "rotKnows", name: "match", key: "k" }],
    },
  ],
  findEdgesAcrossKinds: (f) => [
    { graphId: f.graphId, kinds: ["rotKnows", "rotMemberOf"], limit: 10 },
  ],
  findEdgesByEndpointSet: (f) => [
    {
      graphId: f.graphId,
      kind: "rotKnows",
      side: "from",
      endpointKind: "RotPerson",
      endpointIds: ["p1"],
    },
  ],
  findEdgesByHeterogeneousEndpointSet: (f) => [
    {
      graphId: f.graphId,
      edgeKinds: ["rotKnows"],
      side: "from",
      endpoints: [{ kind: "RotPerson", id: "p1" }],
    },
  ],
  checkUnique: (f) => [
    {
      graphId: f.graphId,
      nodeKind: "RotPerson",
      constraintName: "rot_person_email",
      key: "p1@example.test",
    },
  ],
  checkUniqueBatch: (f) => [
    {
      graphId: f.graphId,
      nodeKind: "RotPerson",
      constraintName: "rot_person_email",
      keys: ["p1@example.test"],
    },
  ],
  vectorSearch: (f) => [
    {
      ...slot(f),
      queryEmbedding: [0.1, 0.2],
      limit: 1,
    },
  ],
  fulltextSearch: (f) => [
    { graphId: f.graphId, nodeKind: "RotPerson", query: "p1", limit: 1 },
  ],
  hybridSearch: () => ({
    unreachable: "needs a vector slot and a fulltext field on one kind",
  }),
  getActiveSchema: (f) => [f.graphId],
  getSchemaVersion: (f) => [f.graphId, f.schemaVersion],
  getIndexMaterialization: () => ["rot_gate_index"],
  getIndexMaterializations: () => [["rot_gate_index"]],
  getContributionMaterialization: (f) => [
    {
      graphId: f.graphId,
      logicalName: "fulltext",
      owner: "fulltext",
      tableName: "rot_gate_fulltext",
    },
  ],
  getReconciliationMarker: (f) => [f.graphId],
  getAllKindRemovals: (f) => [f.graphId],
  getPendingKindRemovals: (f) => [f.graphId],
  probeContributions: (f) => [f.graphId, []],
  verifyContributions: (f) => [f.graphId, []],
  readConstraintFenceViolations: (f) => [
    {
      graphId: f.graphId,
      uniqueConstraintNames: ["rot_person_email"],
      disjointKindPairs: [],
      edgeCardinalities: [],
    },
  ],
  revisionChangesJournalReady: () => [],
  assertBaseSchemaCurrent: () => [],
  assertRuntimeContributionsInitialized: (f) => [f.graphId],
  assertVectorSlotInitialized: (f) => [slot(f)],
  assertVectorSlotsInitialized: (f) => [[slot(f)]],
  tableExists: () => ({
    unreachable:
      "only on the transaction schemaWriteTransaction() hands out, which is refused",
  }),
  identityTableDdl: (f) => [f.identityTableNames],
  recordedTableDdl: () => ({
    unreachable: "derives DDL text for relation names the case does not own",
  }),
  compileSql: () => [sql`SELECT 1`],
};
