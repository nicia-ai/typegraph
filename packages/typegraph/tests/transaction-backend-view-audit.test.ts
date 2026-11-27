/**
 * Every member of a transaction backend, and whether what it issues passes
 * through the transaction's view — the one owner of "this transaction ended,
 * refuse" (`src/backend/drizzle/execution/transaction-view.ts`).
 *
 * {@link TRANSACTION_BACKEND_MEMBER_ROUTES} is a `Record` over
 * `keyof InternalOperationBackend`, the type both bundled dialects build their
 * transaction backends as (a superset of the public `TransactionBackend`), so a
 * member added to either type does not compile here until it states its route.
 * The runtime cases then hold each bundled dialect to the table: a member it
 * carries is never routed `absent`, a member routed `absent` is never carried,
 * and on better-sqlite3 no member of a transaction backend reaches the driver
 * once its transaction has ended.
 */
import Database from "better-sqlite3";
import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  embedding,
  searchable,
} from "../src";
import type { InternalOperationBackend } from "../src/backend/drizzle/operation-backend-core";
import { tables } from "../src/backend/drizzle/schema/sqlite";
import { createSqliteBackend } from "../src/backend/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";
import { ConfigurationError, TransactionClosedError } from "../src/errors";
import { sqliteVecStrategy } from "../src/query/dialect/vector/sqlite-vec-strategy";
import { sql as portableSql } from "../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledSelectSql,
  asCompiledStatementSql,
  asCompiledTemporaryStatementSql,
} from "../src/query/sql-intent";
import type { SerializedSchema } from "../src/schema/types";
import { requireDefined } from "../src/utils/presence";
import {
  setupSharedPgliteEngine,
  type SharedPgliteEngine,
} from "./backends/postgres/pglite-correctness-harness";

/**
 * - `view`: every statement it issues is admitted through the transaction's
 *   view, so it settles before COMMIT / ROLLBACK and is refused after.
 * - `refused`: refuses before any statement, whether the transaction is open
 *   or ended (a root-only operation).
 * - `no-statement`: a value, or a function that never reaches the connection.
 * - `absent`: the dialect's transaction backend does not carry it.
 */
/**
 * Members both bundled transaction backends carry that neither
 * `InternalOperationBackend` nor `TransactionBackend` declares: hybrid search is
 * assembled beside the shared operation layer, keyed by the root
 * `GraphBackend` member it mirrors.
 */
type TransactionOnlyRuntimeMember = Extract<keyof GraphBackend, "hybridSearch">;

type Route = "view" | "refused" | "no-statement" | "absent";
type Disposition = Readonly<{ sqlite: Route; postgres: Route }>;

const VIEW = { sqlite: "view", postgres: "view" } as const;
const NO_STATEMENT = {
  sqlite: "no-statement",
  postgres: "no-statement",
} as const;
/**
 * Root lifecycle, provisioning and administration members the type admits but
 * neither bundled transaction backend carries; `lineage` / `recordedTime`
 * would run on the session argument they are handed, and no bundled profile
 * declares them.
 */
const ABSENT = { sqlite: "absent", postgres: "absent" } as const;
const POSTGRES_ONLY_VIEW = { sqlite: "absent", postgres: "view" } as const;

const TRANSACTION_BACKEND_MEMBER_ROUTES = {
  // Identity and SQL rendering.
  dialect: NO_STATEMENT,
  capabilities: NO_STATEMENT,
  tableNames: NO_STATEMENT,
  fulltextStrategy: NO_STATEMENT,
  vectorStrategy: NO_STATEMENT,
  fenceSql: { sqlite: "absent", postgres: "no-statement" },
  compileSql: NO_STATEMENT,
  // Node and edge reads and writes, uniques and claims.
  insertNode: VIEW,
  insertNodeIfAbsent: VIEW,
  insertNodeWithSchemaFence: VIEW,
  insertNodeIfAbsentWithSchemaFence: VIEW,
  commands: VIEW,
  insertNodeNoReturn: VIEW,
  insertNodesBatch: VIEW,
  insertNodesBatchReturning: VIEW,
  updateNode: VIEW,
  upsertHeterogeneousNodes: POSTGRES_ONLY_VIEW,
  updateResolvedNodesBatch: VIEW,
  compareAndSetNode: VIEW,
  updateNodeSet: VIEW,
  deleteNode: VIEW,
  hardDeleteNode: VIEW,
  hardDeleteNodesBatch: VIEW,
  lockNodes: VIEW,
  getNode: VIEW,
  getNodes: VIEW,
  findNodesByKind: VIEW,
  findNodesAcrossKinds: VIEW,
  countNodesByKind: VIEW,
  insertEdge: VIEW,
  insertEdgeNoReturn: VIEW,
  insertEdgesBatch: VIEW,
  insertEdgesBatchReturning: VIEW,
  insertEdgesDurableBatchReturning: VIEW,
  updateEdge: VIEW,
  deleteEdge: VIEW,
  deleteEdgesBatch: VIEW,
  hardDeleteEdge: VIEW,
  hardDeleteEdgesBatch: VIEW,
  getEdge: VIEW,
  getEdges: VIEW,
  countEdgesAtEndpoint: VIEW,
  edgeExistsBetween: VIEW,
  findEdgesConnectedTo: VIEW,
  findEdgesConnectedToNodes: VIEW,
  findEdgesByKind: VIEW,
  findActiveEdgesBySourceV1: VIEW,
  findEdgesByMatchIdentity: VIEW,
  findEdgesAcrossKinds: VIEW,
  findEdgesByEndpointSet: VIEW,
  findEdgesByHeterogeneousEndpointSet: VIEW,
  countEdgesByKind: VIEW,
  insertUnique: VIEW,
  insertUniqueBatch: VIEW,
  deleteUnique: VIEW,
  hardDeleteUniquesByNodeIds: VIEW,
  hardDeleteUniquesByConcreteKind: VIEW,
  checkUnique: VIEW,
  checkUniqueBatch: VIEW,
  claimEdgeCardinality: VIEW,
  claimEdgeCardinalityGuarded: VIEW,
  claimEdgeCardinalityBatch: VIEW,
  purgeEdgeClaims: VIEW,
  readConstraintFenceViolations: VIEW,
  // Schema reads, fences and commits.
  getActiveSchema: VIEW,
  getSchemaVersion: VIEW,
  lockSchemaVersionForWrite: VIEW,
  lockSchemaVersionAndGraphWrite: POSTGRES_ONLY_VIEW,
  commitSchemaVersion: VIEW,
  setActiveVersion: VIEW,
  // Vector and fulltext projections. Their contribution-marker reads run
  // through the transaction's marker gate, which admits them through the
  // same view (SQLite) or reads on the pinned session's queue (PostgreSQL).
  upsertEmbedding: VIEW,
  upsertEmbeddingBatch: VIEW,
  deleteEmbedding: VIEW,
  deleteEmbeddingBatch: VIEW,
  vectorSearch: VIEW,
  hybridSearch: VIEW,
  createVectorIndex: { sqlite: "refused", postgres: "refused" },
  dropVectorIndex: VIEW,
  deleteSchemaVectorSlotContribution: VIEW,
  upsertFulltext: VIEW,
  deleteFulltext: VIEW,
  upsertFulltextBatch: VIEW,
  deleteFulltextBatch: VIEW,
  fulltextSearch: VIEW,
  recordContributionMaterialization: VIEW,
  // Raw statements, DDL on the transaction, catalog probes.
  execute: VIEW,
  executeRaw: { sqlite: "view", postgres: "absent" },
  executeStatement: VIEW,
  executeTemporaryStatement: VIEW,
  executeSchemaDdl: VIEW,
  tableExists: VIEW,
  catalog: VIEW,
  clearGraph: VIEW,
  clearGraphPreservingContributionMaterializations: VIEW,
  // Atomic programs: one exclusive slot on the session queue, admitted
  // through its view. SQLite builds no executor at transaction scope.
  executeAtomicNodeBatch: POSTGRES_ONLY_VIEW,
  executeAtomicNodeDeleteBatch: POSTGRES_ONLY_VIEW,
  executeAtomicNodeReplacementBatch: POSTGRES_ONLY_VIEW,
  executeAtomicNodeResolvedMutationSet: POSTGRES_ONLY_VIEW,
  executeAtomicNodeResolvedUpdateBatch: POSTGRES_ONLY_VIEW,
  executeAtomicEdgeBatch: POSTGRES_ONLY_VIEW,
  executeAtomicEdgeDeleteBatch: POSTGRES_ONLY_VIEW,
  executeAtomicEdgeMutationProgram: POSTGRES_ONLY_VIEW,
  executeAtomicEdgeResolvedUpdateBatch: POSTGRES_ONLY_VIEW,
  // Root-only members the type admits.
  ensureIndexMaterializationsTable: ABSENT,
  getIndexMaterialization: ABSENT,
  getIndexMaterializations: ABSENT,
  recordIndexMaterialization: ABSENT,
  ensureContributionMaterializationsTable: ABSENT,
  getContributionMaterialization: ABSENT,
  assertRuntimeContributionsInitialized: ABSENT,
  ensureRuntimeContributions: ABSENT,
  ensureFulltextTable: ABSENT,
  ensureKindRemovalsTable: ABSENT,
  getPendingKindRemovals: ABSENT,
  getAllKindRemovals: ABSENT,
  recordKindRemoval: ABSENT,
  ensureReconciliationMarkersTable: ABSENT,
  getReconciliationMarker: ABSENT,
  setReconciliationMarker: ABSENT,
  bootstrapTables: ABSENT,
  executeDdl: ABSENT,
  lineage: ABSENT,
  recordedTime: ABSENT,
} as const satisfies Record<
  keyof InternalOperationBackend | TransactionOnlyRuntimeMember,
  Disposition
>;

type Member = keyof typeof TRANSACTION_BACKEND_MEMBER_ROUTES;

const MEMBERS = Object.keys(
  TRANSACTION_BACKEND_MEMBER_ROUTES,
) as readonly Member[];

function isMember(key: string): key is Member {
  return Object.hasOwn(TRANSACTION_BACKEND_MEMBER_ROUTES, key);
}

const AuditDocument = defineNode("AuditDoc", {
  schema: z.object({
    title: searchable({ language: "english" }),
    vector: embedding(3).optional(),
  }),
});
const graph = defineGraph({
  id: "transaction_backend_view_audit",
  nodes: { AuditDoc: { type: AuditDocument } },
  edges: {},
});

/** Keys a backend `transaction()` hands its callback, and that handle. */
async function escapedTransaction(
  backend: GraphBackend,
): Promise<TransactionBackend> {
  let escaped: TransactionBackend | undefined;
  await backend.transaction((tx) => {
    escaped = tx;
    return Promise.resolve();
  });
  return requireDefined(escaped);
}

/**
 * Every carried member is routed, nothing routed `absent` is carried, and
 * every member routed anything else is carried.
 */
function routeMismatches(
  tx: TransactionBackend,
  dialect: keyof Disposition,
): readonly string[] {
  const carried = Object.keys(tx);
  const unrouted = carried
    .filter((key) => !isMember(key))
    .map((key) => `${key}: carried but not in the table`);
  const misrouted = MEMBERS.flatMap((member) => {
    const routedAbsent =
      TRANSACTION_BACKEND_MEMBER_ROUTES[member][dialect] === "absent";
    const isCarried = carried.includes(member);
    if (routedAbsent && isCarried) {
      return [`${member}: routed absent but carried`];
    }
    if (!routedAbsent && !isCarried) {
      return [`${member}: routed but not carried`];
    }
    return [];
  });
  return [...unrouted, ...misrouted];
}

/**
 * A better-sqlite3 connection whose statement executions are counted from
 * the moment {@link DriverSpy.startCounting} is called. Every statement a
 * bundled SQLite backend runs is prepared on this client, so a count of zero
 * means nothing reached the connection.
 */
type DriverSpy = Readonly<{
  backend: GraphBackend;
  startCounting: () => void;
  executed: () => readonly string[];
  close: () => void;
}>;

const STATEMENT_METHODS = new Set(["run", "all", "get", "iterate"]);

function createSpiedSqliteBackend(path: string): DriverSpy {
  const client = new Database(path);
  sqliteVec.load(client);
  const executed: string[] = [];
  let counting = false;
  const prepare = client.prepare.bind(client);
  client.prepare = ((source: string) => {
    const statement = prepare(source);
    return new Proxy(statement, {
      get(target, property, receiver: unknown) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (counting && STATEMENT_METHODS.has(String(property))) {
            executed.push(source);
          }
          const result: unknown = Reflect.apply(value, target, args);
          return result === target ? receiver : result;
        };
      },
    });
  }) as typeof client.prepare;
  const exec = client.exec.bind(client);
  client.exec = (source: string) => {
    if (counting) executed.push(source);
    return exec(source);
  };
  const backend = createSqliteBackend(drizzle(client), {
    executionProfile: { isSync: true },
    tables,
    vector: sqliteVecStrategy,
  });
  return {
    backend,
    startCounting: () => {
      counting = true;
    },
    executed: () => executed,
    close: () => {
      client.close();
    },
  };
}

/** Arguments that reach a member's statement path for the audit graph. */
const SLOT = {
  graphId: graph.id,
  nodeKind: "AuditDoc",
  fieldPath: "vector",
  dimensions: 3,
  metric: "cosine",
  indexType: "none",
} as const;

/**
 * The members whose marker reads used to reach the connection through the
 * root materializer on SQLite, called with arguments that get past
 * validation to that read.
 */
const MARKER_GATED_CALLS = {
  upsertEmbedding: (tx: TransactionBackend) =>
    requireDefined(tx.upsertEmbedding)({
      ...SLOT,
      nodeId: "d1",
      embedding: [0.1, 0.2, 0.3],
    }),
  deleteEmbedding: (tx: TransactionBackend) =>
    requireDefined(tx.deleteEmbedding)({ ...SLOT, nodeId: "d1" }),
  upsertFulltext: (tx: TransactionBackend) =>
    requireDefined(tx.upsertFulltext)({
      graphId: graph.id,
      nodeKind: "AuditDoc",
      nodeId: "d1",
      content: "late",
      language: "english",
    }),
  fulltextSearch: (tx: TransactionBackend) =>
    requireDefined(tx.fulltextSearch)({
      graphId: graph.id,
      nodeKind: "AuditDoc",
      query: "late",
      limit: 1,
    }),
  createVectorIndex: (tx: TransactionBackend) =>
    requireDefined(tx.createVectorIndex)(SLOT),
} as const satisfies Partial<
  Record<Member, (tx: TransactionBackend) => Promise<unknown>>
>;

/** "closed", "administration", or what else `pending` did. */
function outcome(pending: Promise<unknown>): Promise<string> {
  return pending.then(
    () => "fulfilled",
    (error: unknown) => {
      if (error instanceof TransactionClosedError) return "closed";
      if (
        error instanceof ConfigurationError &&
        error.details["capability"] === "contributionAdministration"
      ) {
        return "administration";
      }
      return String(error);
    },
  );
}

/**
 * A transaction backend as the audit calls it: every member the SQLite
 * transaction backend is built with, the schema-write ones included, plus the
 * hybrid search assembled beside it.
 */
type AuditedTransaction = InternalOperationBackend &
  Pick<GraphBackend, "hybridSearch">;

/** One call into a member, with arguments that reach its statement path. */
type MemberCall = (tx: AuditedTransaction) => Promise<unknown>;

/** The members better-sqlite3 routes through the transaction's view. */
type SqliteViewMember = {
  [
    M in Member
  ]: (typeof TRANSACTION_BACKEND_MEMBER_ROUTES)[M]["sqlite"] extends "view" ? M
  : never;
}[Member];

/** A cardinality-claim request for the audit graph. */
const CLAIM = {
  graphId: graph.id,
  edgeKind: "auditLink",
  edgeId: "e1",
  fromKind: "AuditDoc",
  fromId: "d1",
  toKind: "AuditDoc",
  toId: "d2",
  direction: "source",
  cardinality: "one",
} as const;

const NODE = {
  graphId: graph.id,
  kind: "AuditDoc",
  id: "d1",
  props: { title: "audit" },
} as const;

const EDGE = {
  graphId: graph.id,
  id: "e1",
  kind: "auditLink",
  fromKind: "AuditDoc",
  fromId: "d1",
  toKind: "AuditDoc",
  toId: "d2",
  props: {},
} as const;

const SCHEMA_FENCE = { graphId: graph.id, expectedVersion: 1 } as const;

const UNIQUE = {
  graphId: graph.id,
  nodeKind: "AuditDoc",
  constraintName: "audit_title",
  key: "audit",
  nodeId: "d1",
  concreteKind: "AuditDoc",
} as const;

/** Candidate ids for the set-based node updates. */
function candidateIds() {
  return asCompiledSelectSql(
    portableSql`SELECT id FROM ${portableSql.identifier(getTableName(tables.nodes))} WHERE graph_id = ${graph.id}`,
  );
}

/**
 * For every member better-sqlite3 routes through the view, one call — or,
 * for a member that is a bag of functions, one call per function that issues
 * a statement — with valid arguments for the audit graph. A member added to
 * the routes as `view` does not compile here until it has a call.
 */
const MEMBER_CALLS = {
  insertNode: (tx) => tx.insertNode(NODE),
  insertNodeIfAbsent: (tx) => requireDefined(tx.insertNodeIfAbsent)(NODE),
  insertNodeWithSchemaFence: (tx) =>
    requireDefined(tx.insertNodeWithSchemaFence)(NODE, SCHEMA_FENCE),
  insertNodeIfAbsentWithSchemaFence: (tx) =>
    requireDefined(tx.insertNodeIfAbsentWithSchemaFence)(NODE, SCHEMA_FENCE),
  commands: {
    execute: (tx) =>
      tx.commands.execute(
        {
          kind: "node.create",
          plan: {
            entity: "node",
            params: NODE,
            idGenerated: false,
            mode: { kind: "ordinary" },
            claims: [],
            projections: [],
          },
        },
        { session: "transaction", coordination: "none" },
      ),
  },
  insertNodeNoReturn: (tx) => requireDefined(tx.insertNodeNoReturn)(NODE),
  insertNodesBatch: (tx) => requireDefined(tx.insertNodesBatch)([NODE]),
  insertNodesBatchReturning: (tx) =>
    requireDefined(tx.insertNodesBatchReturning)([NODE]),
  updateNode: (tx) => tx.updateNode(NODE),
  updateResolvedNodesBatch: (tx) =>
    requireDefined(tx.updateResolvedNodesBatch)({
      entries: [{ ...NODE, expectedVersion: 1 }],
    }),
  compareAndSetNode: (tx) =>
    requireDefined(tx.compareAndSetNode)({
      operation: "compareAndSet",
      graphId: graph.id,
      kind: "AuditDoc",
      patch: { title: "patched" },
      candidateIds: candidateIds(),
      candidateIdColumn: "id",
      expected: { title: { kind: "value", value: "audit" } },
    }),
  updateNodeSet: (tx) =>
    requireDefined(tx.updateNodeSet)({
      operation: "updateWhere",
      graphId: graph.id,
      kind: "AuditDoc",
      patch: { title: "patched" },
      candidateIds: candidateIds(),
      candidateIdColumn: "id",
    }),
  deleteNode: (tx) => tx.deleteNode(NODE),
  hardDeleteNode: (tx) => tx.hardDeleteNode(NODE),
  hardDeleteNodesBatch: (tx) =>
    requireDefined(tx.hardDeleteNodesBatch)({
      graphId: graph.id,
      kind: "AuditDoc",
      ids: ["d1"],
    }),
  lockNodes: (tx) => tx.lockNodes(graph.id, "AuditDoc", ["d1"], "delete"),
  getNode: (tx) => tx.getNode(graph.id, "AuditDoc", "d1"),
  getNodes: (tx) => requireDefined(tx.getNodes)(graph.id, "AuditDoc", ["d1"]),
  findNodesByKind: (tx) =>
    tx.findNodesByKind({ graphId: graph.id, kind: "AuditDoc" }),
  findNodesAcrossKinds: (tx) =>
    requireDefined(tx.findNodesAcrossKinds)({
      graphId: graph.id,
      kinds: ["AuditDoc"],
      limit: 1,
    }),
  countNodesByKind: (tx) =>
    tx.countNodesByKind({ graphId: graph.id, kind: "AuditDoc" }),
  insertEdge: (tx) => tx.insertEdge(EDGE),
  insertEdgeNoReturn: (tx) => requireDefined(tx.insertEdgeNoReturn)(EDGE),
  insertEdgesBatch: (tx) => requireDefined(tx.insertEdgesBatch)([EDGE]),
  insertEdgesBatchReturning: (tx) =>
    requireDefined(tx.insertEdgesBatchReturning)([EDGE]),
  insertEdgesDurableBatchReturning: (tx) =>
    requireDefined(tx.insertEdgesDurableBatchReturning)([
      { ...EDGE, matchIdentity: { name: "audit", key: "k" } },
    ]),
  updateEdge: (tx) => tx.updateEdge(EDGE),
  deleteEdge: (tx) => tx.deleteEdge(EDGE),
  deleteEdgesBatch: (tx) =>
    requireDefined(tx.deleteEdgesBatch)({ graphId: graph.id, ids: ["e1"] }),
  hardDeleteEdge: (tx) => tx.hardDeleteEdge(EDGE),
  hardDeleteEdgesBatch: (tx) =>
    requireDefined(tx.hardDeleteEdgesBatch)({ graphId: graph.id, ids: ["e1"] }),
  getEdge: (tx) => tx.getEdge(graph.id, "e1"),
  getEdges: (tx) => requireDefined(tx.getEdges)(graph.id, ["e1"]),
  countEdgesAtEndpoint: (tx) =>
    tx.countEdgesAtEndpoint({
      graphId: graph.id,
      edgeKind: "auditLink",
      endpoint: "from",
      endpointKind: "AuditDoc",
      endpointId: "d1",
    }),
  edgeExistsBetween: (tx) => tx.edgeExistsBetween(EDGE_BETWEEN),
  findEdgesConnectedTo: (tx) =>
    tx.findEdgesConnectedTo({
      graphId: graph.id,
      nodeKind: "AuditDoc",
      nodeId: "d1",
    }),
  findEdgesConnectedToNodes: (tx) =>
    requireDefined(tx.findEdgesConnectedToNodes)({
      graphId: graph.id,
      nodeKind: "AuditDoc",
      nodeIds: ["d1"],
    }),
  findEdgesByKind: (tx) =>
    tx.findEdgesByKind({ graphId: graph.id, kind: "auditLink" }),
  findActiveEdgesBySourceV1: (tx) =>
    requireDefined(tx.findActiveEdgesBySourceV1)({
      graphId: graph.id,
      edgeKind: "auditLink",
      fromKind: "AuditDoc",
      fromId: "d1",
    }),
  findEdgesByMatchIdentity: (tx) =>
    requireDefined(tx.findEdgesByMatchIdentity)({
      graphId: graph.id,
      identities: [{ kind: "auditLink", name: "audit", key: "k" }],
    }),
  findEdgesAcrossKinds: (tx) =>
    requireDefined(tx.findEdgesAcrossKinds)({
      graphId: graph.id,
      kinds: ["auditLink"],
      limit: 1,
    }),
  findEdgesByEndpointSet: (tx) =>
    requireDefined(tx.findEdgesByEndpointSet)({
      graphId: graph.id,
      kind: "auditLink",
      side: "from",
      endpointKind: "AuditDoc",
      endpointIds: ["d1"],
    }),
  findEdgesByHeterogeneousEndpointSet: (tx) =>
    requireDefined(tx.findEdgesByHeterogeneousEndpointSet)({
      graphId: graph.id,
      side: "from",
      endpoints: [{ kind: "AuditDoc", id: "d1" }],
      edgeKinds: ["auditLink"],
    }),
  countEdgesByKind: (tx) =>
    tx.countEdgesByKind({ graphId: graph.id, kind: "auditLink" }),
  insertUnique: (tx) => tx.insertUnique(UNIQUE),
  insertUniqueBatch: (tx) => requireDefined(tx.insertUniqueBatch)([UNIQUE]),
  deleteUnique: (tx) => tx.deleteUnique(UNIQUE),
  hardDeleteUniquesByNodeIds: (tx) =>
    requireDefined(tx.hardDeleteUniquesByNodeIds)({
      graphId: graph.id,
      concreteKind: "AuditDoc",
      nodeIds: ["d1"],
    }),
  hardDeleteUniquesByConcreteKind: (tx) =>
    requireDefined(tx.hardDeleteUniquesByConcreteKind)({
      graphId: graph.id,
      concreteKind: "AuditDoc",
    }),
  checkUnique: (tx) => tx.checkUnique(UNIQUE),
  checkUniqueBatch: (tx) =>
    requireDefined(tx.checkUniqueBatch)({ ...UNIQUE, keys: ["audit"] }),
  claimEdgeCardinality: (tx) => requireDefined(tx.claimEdgeCardinality)(CLAIM),
  claimEdgeCardinalityGuarded: (tx) =>
    requireDefined(tx.claimEdgeCardinalityGuarded)(CLAIM),
  claimEdgeCardinalityBatch: (tx) =>
    requireDefined(tx.claimEdgeCardinalityBatch)([CLAIM]),
  purgeEdgeClaims: (tx) =>
    requireDefined(tx.purgeEdgeClaims)({ graphId: graph.id, edgeIds: ["e1"] }),
  readConstraintFenceViolations: (tx) =>
    requireDefined(tx.readConstraintFenceViolations)({
      graphId: graph.id,
      uniqueConstraintNames: ["audit_title"],
      disjointKindPairs: [],
      edgeCardinalities: [],
    }),
  getActiveSchema: (tx) => tx.getActiveSchema(graph.id),
  getSchemaVersion: (tx) => tx.getSchemaVersion(graph.id, 1),
  lockSchemaVersionForWrite: (tx) =>
    requireDefined(tx.lockSchemaVersionForWrite)(SCHEMA_FENCE),
  commitSchemaVersion: (tx) =>
    tx.commitSchemaVersion({
      graphId: graph.id,
      expected: { kind: "active", version: 1 },
      version: 2,
      schemaHash: "audit",
      schemaDoc: requireDefined(activeSchemaDocument),
    }),
  setActiveVersion: (tx) =>
    tx.setActiveVersion({
      graphId: graph.id,
      expected: { kind: "active", version: 1 },
      version: 1,
    }),
  upsertEmbedding: (tx) => MARKER_GATED_CALLS.upsertEmbedding(tx),
  upsertEmbeddingBatch: (tx) =>
    requireDefined(tx.upsertEmbeddingBatch)({
      ...SLOT,
      rows: [{ nodeId: "d1", embedding: [0.1, 0.2, 0.3] }],
    }),
  deleteEmbedding: (tx) => MARKER_GATED_CALLS.deleteEmbedding(tx),
  deleteEmbeddingBatch: (tx) =>
    requireDefined(tx.deleteEmbeddingBatch)({ ...SLOT, nodeIds: ["d1"] }),
  vectorSearch: (tx) =>
    requireDefined(tx.vectorSearch)({
      ...SLOT,
      queryEmbedding: [0.1, 0.2, 0.3],
      limit: 1,
    }),
  hybridSearch: (tx) =>
    requireDefined(tx.hybridSearch)({
      graphId: graph.id,
      nodeKind: "AuditDoc",
      vector: {
        fieldPath: "vector",
        queryEmbedding: [0.1, 0.2, 0.3],
        metric: "cosine",
        dimensions: 3,
        indexType: "none",
        k: 1,
      },
      fulltext: { query: "audit", k: 1 },
      fusion: { k: 60, vectorWeight: 1, fulltextWeight: 1 },
      limit: 1,
    }),
  dropVectorIndex: (tx) =>
    requireDefined(tx.dropVectorIndex)({
      graphId: graph.id,
      nodeKind: "AuditDoc",
      fieldPath: "vector",
    }),
  deleteSchemaVectorSlotContribution: (tx) =>
    tx.deleteSchemaVectorSlotContribution(SLOT),
  upsertFulltext: (tx) => MARKER_GATED_CALLS.upsertFulltext(tx),
  deleteFulltext: (tx) =>
    requireDefined(tx.deleteFulltext)({
      graphId: graph.id,
      nodeKind: "AuditDoc",
      nodeId: "d1",
    }),
  upsertFulltextBatch: (tx) =>
    requireDefined(tx.upsertFulltextBatch)({
      graphId: graph.id,
      nodeKind: "AuditDoc",
      rows: [{ nodeId: "d1", content: "audit", language: "english" }],
    }),
  deleteFulltextBatch: (tx) =>
    requireDefined(tx.deleteFulltextBatch)({
      graphId: graph.id,
      nodeKind: "AuditDoc",
      nodeIds: ["d1"],
    }),
  fulltextSearch: (tx) => MARKER_GATED_CALLS.fulltextSearch(tx),
  recordContributionMaterialization: (tx) =>
    requireDefined(tx.recordContributionMaterialization)({
      graphId: graph.id,
      logicalName: "audit",
      owner: "audit",
      tableName: "audit",
      signature: "audit",
      attemptedAt: "2026-01-01T00:00:00.000Z",
      materializedAt: undefined,
      error: undefined,
    }),
  execute: (tx) => tx.execute(asCompiledRowsSql(portableSql`SELECT 1 AS one`)),
  executeRaw: (tx) => requireDefined(tx.executeRaw)("SELECT 1 AS one", []),
  executeStatement: (tx) =>
    requireDefined(tx.executeStatement)(
      asCompiledStatementSql(
        portableSql`CREATE TEMP TABLE IF NOT EXISTS audit_statement (x)`,
      ),
    ),
  executeTemporaryStatement: (tx) =>
    requireDefined(tx.executeTemporaryStatement)(
      asCompiledTemporaryStatementSql(
        portableSql`CREATE TEMP TABLE IF NOT EXISTS audit_temporary (x)`,
      ),
    ),
  executeSchemaDdl: (tx) =>
    tx.executeSchemaDdl("CREATE TABLE IF NOT EXISTS audit_ddl (x)"),
  tableExists: (tx) => tx.tableExists("audit_absent_table"),
  catalog: {
    tableExists: (tx) =>
      requireDefined(tx.catalog).tableExists("audit_absent_table"),
    tablesExist: (tx) =>
      requireDefined(tx.catalog).tablesExist(["audit_absent_table"]),
    indexStates: (tx) =>
      requireDefined(tx.catalog).indexStates(["audit_absent_index"]),
    dropInvalidIndex: (tx) =>
      requireDefined(tx.catalog).dropInvalidIndex("audit_absent_index"),
    columnTypes: (tx) => requireDefined(tx.catalog).columnTypes("audit_ddl"),
  },
  clearGraph: (tx) => tx.clearGraph(graph.id),
  clearGraphPreservingContributionMaterializations: (tx) =>
    requireDefined(tx.clearGraphPreservingContributionMaterializations)(
      graph.id,
    ),
} as const satisfies Record<
  SqliteViewMember,
  MemberCall | Readonly<Record<string, MemberCall>>
>;

const EDGE_BETWEEN = {
  graphId: graph.id,
  edgeKind: "auditLink",
  fromKind: "AuditDoc",
  fromId: "d1",
  toKind: "AuditDoc",
  toId: "d2",
} as const;

/** The members PGlite routes through the view that better-sqlite3 does not carry. */
type PostgresOnlyViewMember = {
  [M in Member]: (typeof TRANSACTION_BACKEND_MEMBER_ROUTES)[M] extends (
    typeof POSTGRES_ONLY_VIEW
  ) ?
    M
  : never;
}[Member];

/** An edge postimage for the resolved edge updates. */
const EDGE_ROW = {
  graph_id: graph.id,
  id: "e1",
  kind: "auditLink",
  from_kind: "AuditDoc",
  from_id: "d1",
  to_kind: "AuditDoc",
  to_id: "d2",
  props: {},
  valid_from: undefined,
  valid_to: undefined,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  deleted_at: undefined,
} as const;

/**
 * For every member PGlite alone routes through the view, one call with valid
 * arguments for the audit graph. A member added to the routes as PostgreSQL-only
 * `view` does not compile here until it has a call.
 */
const POSTGRES_ONLY_MEMBER_CALLS = {
  upsertHeterogeneousNodes: (tx) =>
    requireDefined(tx.upsertHeterogeneousNodes)({
      entries: [
        {
          kind: "AuditDoc",
          id: "d1",
          props: { title: "audit" },
          updateProps: { title: "audit" },
        },
      ],
      schemaFence: SCHEMA_FENCE,
    }),
  lockSchemaVersionAndGraphWrite: (tx) =>
    requireDefined(tx.lockSchemaVersionAndGraphWrite)({
      ...SCHEMA_FENCE,
      fenceRow: "leave",
    }),
  executeAtomicNodeBatch: (tx) =>
    requireDefined(tx.executeAtomicNodeBatch)({
      entries: [{ idSource: "caller", params: NODE }],
      resultMode: "count",
      schemaFence: SCHEMA_FENCE,
    }),
  executeAtomicNodeDeleteBatch: (tx) =>
    requireDefined(tx.executeAtomicNodeDeleteBatch)({
      graphId: graph.id,
      kind: "AuditDoc",
      ids: ["d1"],
      schemaFence: SCHEMA_FENCE,
    }),
  executeAtomicNodeReplacementBatch: (tx) =>
    requireDefined(tx.executeAtomicNodeReplacementBatch)({
      entries: [{ params: NODE }],
      releaseClaims: false,
      schemaFence: SCHEMA_FENCE,
    }),
  executeAtomicNodeResolvedMutationSet: (tx) =>
    requireDefined(tx.executeAtomicNodeResolvedMutationSet)({
      creates: [{ idSource: "caller", params: NODE }],
      updates: [{ ...NODE, id: "d2", expectedVersion: 1 }],
      schemaFence: SCHEMA_FENCE,
    }),
  executeAtomicNodeResolvedUpdateBatch: (tx) =>
    requireDefined(tx.executeAtomicNodeResolvedUpdateBatch)({
      entries: [{ ...NODE, expectedVersion: 1 }],
      schemaFence: SCHEMA_FENCE,
    }),
  executeAtomicEdgeBatch: (tx) =>
    requireDefined(tx.executeAtomicEdgeBatch)({
      claims: [],
      params: [EDGE],
      resultMode: "count",
      schemaFence: SCHEMA_FENCE,
    }),
  executeAtomicEdgeDeleteBatch: (tx) =>
    requireDefined(tx.executeAtomicEdgeDeleteBatch)({
      graphId: graph.id,
      expectedKind: "auditLink",
      ids: ["e1"],
      schemaFence: SCHEMA_FENCE,
    }),
  executeAtomicEdgeMutationProgram: (tx) =>
    requireDefined(tx.executeAtomicEdgeMutationProgram)({
      kind: "resolved-set",
      creates: [EDGE],
      updates: [{ existing: { ...EDGE_ROW, id: "e2" }, props: {} }],
      schemaFence: SCHEMA_FENCE,
    }),
  executeAtomicEdgeResolvedUpdateBatch: (tx) =>
    requireDefined(tx.executeAtomicEdgeResolvedUpdateBatch)({
      entries: [{ existing: EDGE_ROW, props: { note: "late" } }],
      schemaFence: SCHEMA_FENCE,
    }),
} as const satisfies Record<PostgresOnlyViewMember, MemberCall>;

/**
 * Every call PGlite routes through the view: the shared calls for each member
 * PGlite routes `view`, and the PostgreSQL-only ones.
 */
function labelledPostgresMemberCalls(): readonly (readonly [
  string,
  MemberCall,
])[] {
  return [
    ...labelledMemberCalls().filter(([label]) => {
      const member = label.split(".")[0] as Member;
      return TRANSACTION_BACKEND_MEMBER_ROUTES[member].postgres === "view";
    }),
    ...Object.entries(POSTGRES_ONLY_MEMBER_CALLS).map(
      ([label, call]) => [label, call as MemberCall] as const,
    ),
  ];
}

/** The audit graph's active schema document, read once before the cases. */
let activeSchemaDocument: SerializedSchema | undefined;

/** Every call in {@link MEMBER_CALLS}, labelled `member` or `member.function`. */
function labelledMemberCalls(): readonly (readonly [string, MemberCall])[] {
  return Object.entries(MEMBER_CALLS).flatMap(
    ([member, entry]): (readonly [string, MemberCall])[] =>
      typeof entry === "function" ?
        [[member, entry as MemberCall]]
      : Object.entries(entry as Readonly<Record<string, MemberCall>>).map(
          ([name, call]) => [`${member}.${name}`, call] as const,
        ),
  );
}

/**
 * Calls that issue no statement on the audit backend's driver, though their
 * member is routed `view`: sqlite-vec builds no ANN index, so dropping one is
 * a no-op, and SQLite has no invalid-index state to drop. They are held to
 * that (no statement while open, nothing to refuse once ended) so a change
 * that makes either issue a statement fails here and moves it into the main
 * audit.
 */
const STATEMENT_FREE_ON_SQLITE_VEC: ReadonlySet<string> = new Set([
  "dropVectorIndex",
  "catalog.dropInvalidIndex",
]);

/**
 * How many calls the PGlite case makes, so a filter that drops calls cannot
 * pass it vacuously: every shared call PGlite routes `view` (all but
 * `executeRaw`, which it does not carry, and `createVectorIndex`, refused)
 * plus the PostgreSQL-only ones.
 */
const EXPECTED_POSTGRES_VIEW_CALLS =
  labelledMemberCalls().length -
  1 +
  Object.keys(POSTGRES_ONLY_MEMBER_CALLS).length;

/**
 * A call PGlite's transaction catalog refuses before any statement, open or
 * ended: PostgreSQL refuses `DROP INDEX CONCURRENTLY` in a transaction block.
 */
const ROOT_ONLY_ON_POSTGRES: ReadonlySet<string> = new Set([
  "catalog.dropInvalidIndex",
]);

/** Rolls the open transaction a case drives back, after the call settled. */
const ROLLBACK_AFTER_CALL = new Error("roll the audit transaction back");

describe("transaction backend members", () => {
  let engine: SharedPgliteEngine;
  let path: string;

  beforeAll(async () => {
    engine = await setupSharedPgliteEngine();
    path = `${process.env["TMPDIR"] ?? "/tmp"}/transaction-backend-view-inventory-${process.pid}-${Date.now()}.sqlite`;
    const { backend } = createLocalSqliteBackend({ path });
    await createStoreWithSchema(graph, backend);
    await backend.close();
  });

  afterAll(async () => {
    await engine.dispose();
  });

  it("routes every member a better-sqlite3 transaction backend carries", async () => {
    const { backend } = createLocalSqliteBackend();
    const tx = await escapedTransaction(backend);
    expect(routeMismatches(tx, "sqlite")).toEqual([]);
    await backend.close();
  });

  it("issues no statement from a better-sqlite3 member routed no-statement or refused, on an open transaction", async () => {
    const spy = createSpiedSqliteBackend(path);
    const reached: string[] = [];
    const refusals: Record<string, string> = {};
    try {
      await spy.backend.transaction(async (tx) => {
        spy.startCounting();
        for (const member of MEMBERS) {
          const route = TRANSACTION_BACKEND_MEMBER_ROUTES[member].sqlite;
          const before = spy.executed().length;
          if (route === "refused") {
            refusals[member] = await outcome(
              requireDefined(
                MARKER_GATED_CALLS[member as keyof typeof MARKER_GATED_CALLS],
              )(tx),
            );
          } else if (route === "no-statement") {
            readOrRender(tx, member);
          } else {
            continue;
          }
          if (spy.executed().length > before) reached.push(member);
        }
      });
    } finally {
      spy.close();
    }
    expect({ reached, refusals }).toEqual({
      reached: [],
      refusals: { createVectorIndex: "administration" },
    });
  });

  it("routes every member a PGlite transaction backend carries", async () => {
    const backend = engine.makeBackend();
    await backend.bootstrapTables?.();
    const tx = await escapedTransaction(backend);
    expect(routeMismatches(tx, "postgres")).toEqual([]);
  });
});

describe("a better-sqlite3 transaction backend once its transaction ended", () => {
  let path: string;

  beforeAll(async () => {
    path = `${process.env["TMPDIR"] ?? "/tmp"}/transaction-backend-view-audit-${process.pid}-${Date.now()}.sqlite`;
    // Materialize the graph's fulltext and vector storage on one connection;
    // each case then opens a second, whose marker cache starts cold.
    const { backend } = createLocalSqliteBackend({ path });
    await createStoreWithSchema(graph, backend);
    const active = requireDefined(await backend.getActiveSchema(graph.id));
    activeSchemaDocument = JSON.parse(active.schema_doc) as SerializedSchema;
    await backend.close();
  });

  it("reaches the driver from no marker-gated member, and refuses each with a typed error", async () => {
    const spy = createSpiedSqliteBackend(path);
    const tx = await escapedTransaction(spy.backend);
    spy.startCounting();
    const outcomes: Record<string, string> = {};
    for (const [member, call] of Object.entries(MARKER_GATED_CALLS)) {
      outcomes[member] = await outcome(call(tx));
    }
    expect({ outcomes, executed: spy.executed() }).toEqual({
      outcomes: {
        upsertEmbedding: "closed",
        deleteEmbedding: "closed",
        upsertFulltext: "closed",
        fulltextSearch: "closed",
        createVectorIndex: "administration",
      },
      executed: [],
    });
    spy.close();
  });

  // Each call is first shown to reach the driver on an open transaction, so
  // its refusal after the end is the view's, not an argument check's.
  it("reaches the driver from every view member while open, and from none once ended, refusing each with TransactionClosedError", async () => {
    const statementsWhileOpen: Record<string, number> = {};
    for (const [label, call] of labelledMemberCalls()) {
      const spy = createSpiedSqliteBackend(path);
      try {
        await spy.backend
          .transaction(async (tx) => {
            spy.startCounting();
            await call(tx as unknown as AuditedTransaction).catch(() => {
              // A statement that reached the driver and failed still counts.
            });
            // Counted before the frame's own ROLLBACK.
            statementsWhileOpen[label] = spy.executed().length;
            throw ROLLBACK_AFTER_CALL;
          })
          .catch(() => {
            // Rolled back on purpose: nothing a call wrote outlives its case.
          });
      } finally {
        spy.close();
      }
    }

    const spy = createSpiedSqliteBackend(path);
    const ended = (await escapedTransaction(
      spy.backend,
    )) as unknown as AuditedTransaction;
    spy.startCounting();
    const outcomesOnceEnded: Record<string, string> = {};
    const reachedOnceEnded: string[] = [];
    for (const [label, call] of labelledMemberCalls()) {
      const before = spy.executed().length;
      outcomesOnceEnded[label] = await outcome(call(ended));
      if (spy.executed().length > before) reachedOnceEnded.push(label);
    }
    spy.close();

    const labels = labelledMemberCalls().map(([label]) => label);
    function isStatementFree(label: string): boolean {
      return STATEMENT_FREE_ON_SQLITE_VEC.has(label);
    }
    expect({
      silentWhileOpen: labels.filter(
        (label) => !isStatementFree(label) && statementsWhileOpen[label] === 0,
      ),
      notRefusedOnceEnded: labels
        .filter(
          (label) =>
            !isStatementFree(label) && outcomesOnceEnded[label] !== "closed",
        )
        .map((label) => `${label}: ${outcomesOnceEnded[label]}`),
      statementFree: [...STATEMENT_FREE_ON_SQLITE_VEC].map((label) => ({
        label,
        whileOpen: statementsWhileOpen[label],
        onceEnded: outcomesOnceEnded[label],
      })),
      reachedOnceEnded,
    }).toEqual({
      silentWhileOpen: [],
      notRefusedOnceEnded: [],
      statementFree: [...STATEMENT_FREE_ON_SQLITE_VEC].map((label) => ({
        label,
        whileOpen: 0,
        onceEnded: "fulfilled",
      })),
      reachedOnceEnded: [],
    });
  });
});

describe("a PGlite transaction backend once its transaction ended", () => {
  let engine: SharedPgliteEngine;
  let backend: GraphBackend;

  beforeAll(async () => {
    engine = await setupSharedPgliteEngine();
    backend = engine.makeBackend();
    await createStoreWithSchema(graph, backend);
    const active = requireDefined(await backend.getActiveSchema(graph.id));
    activeSchemaDocument = JSON.parse(active.schema_doc) as SerializedSchema;
  });

  afterAll(async () => {
    await engine.dispose();
  });

  // Each call is first shown not to be refused on an open transaction (each
  // in a transaction of its own, rolled back, since a failed statement aborts
  // a PostgreSQL transaction), so its refusal after the end is the view's.
  it("refuses every member routed through the view with TransactionClosedError, and only once its transaction ended", async () => {
    const calls = labelledPostgresMemberCalls();
    const refusedWhileOpen: string[] = [];
    for (const [label, call] of calls) {
      await backend
        .transaction(async (tx) => {
          if (
            (await outcome(call(tx as unknown as AuditedTransaction))) ===
            "closed"
          ) {
            refusedWhileOpen.push(label);
          }
          throw ROLLBACK_AFTER_CALL;
        })
        .catch(() => {
          // Rolled back on purpose: nothing a call wrote outlives its case.
        });
    }

    const ended = (await escapedTransaction(
      backend,
    )) as unknown as AuditedTransaction;
    const notRefusedOnceEnded: string[] = [];
    const rootOnce: Record<string, string> = {};
    for (const [label, call] of calls) {
      const result = await outcome(call(ended));
      if (ROOT_ONLY_ON_POSTGRES.has(label)) rootOnce[label] = result;
      else if (result !== "closed") {
        notRefusedOnceEnded.push(`${label}: ${result}`);
      }
    }
    expect({
      calls: calls.length,
      refusedWhileOpen,
      notRefusedOnceEnded,
      rootOnce,
    }).toEqual({
      calls: EXPECTED_POSTGRES_VIEW_CALLS,
      refusedWhileOpen: [],
      notRefusedOnceEnded: [],
      rootOnce: {
        "catalog.dropInvalidIndex": expect.stringContaining(
          "dropInvalidIndex requires a root PostgreSQL backend",
        ) as unknown,
      },
    });
  });
});

/**
 * Reads a `no-statement` member; a function among them (the SQL renderer) is
 * called the way the query compiler calls it.
 */
function readOrRender(tx: TransactionBackend, member: Member): void {
  const value: unknown = (tx as unknown as Record<string, unknown>)[member];
  if (typeof value !== "function") return;
  Reflect.apply(value, undefined, [asCompiledRowsSql(portableSql`SELECT 1`)]);
}
