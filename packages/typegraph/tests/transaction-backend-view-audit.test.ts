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

/** Every carried member is routed, and nothing routed `absent` is carried. */
function routeMismatches(
  tx: TransactionBackend,
  dialect: keyof Disposition,
): readonly string[] {
  const carried = Object.keys(tx);
  const unrouted = carried
    .filter((key) => !isMember(key))
    .map((key) => `${key}: carried but not in the table`);
  const misrouted = MEMBERS.filter((member) => {
    const routedAbsent =
      TRANSACTION_BACKEND_MEMBER_ROUTES[member][dialect] === "absent";
    return routedAbsent && carried.includes(member);
  }).map((member) => `${member}: routed absent but carried`);
  return [...unrouted, ...misrouted];
}

describe("transaction backend members", () => {
  let engine: SharedPgliteEngine;

  beforeAll(async () => {
    engine = await setupSharedPgliteEngine();
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

  it("routes every member a PGlite transaction backend carries", async () => {
    const backend = engine.makeBackend();
    await backend.bootstrapTables?.();
    const tx = await escapedTransaction(backend);
    expect(routeMismatches(tx, "postgres")).toEqual([]);
  });
});

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

describe("a better-sqlite3 transaction backend once its transaction ended", () => {
  let path: string;

  beforeAll(async () => {
    path = `${process.env["TMPDIR"] ?? "/tmp"}/transaction-backend-view-audit-${process.pid}-${Date.now()}.sqlite`;
    // Materialize the graph's fulltext and vector storage on one connection;
    // each case then opens a second, whose marker cache starts cold.
    const { backend } = createLocalSqliteBackend({ path });
    await createStoreWithSchema(graph, backend);
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
  });

  it("reaches the driver from no member at all, whatever its arguments", async () => {
    const spy = createSpiedSqliteBackend(path);
    const tx = await escapedTransaction(spy.backend);
    spy.startCounting();
    const reached: string[] = [];
    for (const member of MEMBERS) {
      const value: unknown = (tx as unknown as Record<string, unknown>)[member];
      const route = TRANSACTION_BACKEND_MEMBER_ROUTES[member].sqlite;
      if (route === "no-statement" || route === "absent") continue;
      const before = spy.executed().length;
      const callables: readonly ((...args: unknown[]) => unknown)[] =
        typeof value === "function" ?
          [value as (...args: unknown[]) => unknown]
        : Object.values(value as Record<string, unknown>).filter(
            (entry): entry is (...args: unknown[]) => unknown =>
              typeof entry === "function",
          );
      for (const callable of callables) {
        try {
          await callable(
            { ...SLOT, id: "d1", kind: "AuditDoc" },
            "AuditDoc",
            "d1",
          );
        } catch {
          // Refused, or rejected its arguments: either way the question is
          // only whether a statement reached the driver.
        }
      }
      if (spy.executed().length > before) reached.push(member);
    }
    expect({ reached, executed: spy.executed() }).toEqual({
      reached: [],
      executed: [],
    });
  });
});
