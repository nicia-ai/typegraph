/**
 * The consumers of a transaction's view that sit outside the backend
 * TypeGraph hands a transaction callback: a backend a public constructor
 * builds over the callback's native handle, a Store built over that backend,
 * a backend adopted over a savepoint's native handle, and a sibling binding
 * whose marker cache another binding of the same transaction invalidates.
 *
 * Each case either states the contract (`expect`) or pins a hazard main has
 * too (`expectObservation`, with the value main produces today).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  embedding,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import {
  createPostgresBackend,
  createPostgresTransactionBackend,
} from "../../../src/backend/postgres";
import { createSqliteBackend } from "../../../src/backend/sqlite";
import type {
  AdapterBackend,
  GraphBackend,
  InsertNodeParams,
  TransactionBackend,
} from "../../../src/backend/types";
import { TypeGraphError } from "../../../src/errors";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";
import { expectObservation } from "../../helpers/known-defect";
import type {
  IntegrationLaneDriver,
  IntegrationTestContext,
} from "./test-context";

let graphCounter = 0;

function nextGraphId(): string {
  graphCounter += 1;
  return `tv_consumers_${graphCounter}`;
}

function node(graphId: string, id: string): InsertNodeParams {
  return { graphId, kind: "TvItem", id, props: { label: id } };
}

/** A settled call as its error class, `"fulfilled"`, or `"untyped: …"`. */
async function outcomeOf(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
    return "fulfilled";
  } catch (error) {
    return error instanceof TypeGraphError ?
        error.name
      : `untyped: ${String(error).split("\n")[0]?.trim() ?? ""}`;
  }
}

async function nodeIds(
  backend: GraphBackend,
  graphId: string,
): Promise<readonly string[]> {
  const rows = await backend.execute<{ id: string }>(
    asCompiledRowsSql(sql`
      SELECT id FROM ${sql.identifier(requireDefined(backend.tableNames).nodes)}
      WHERE graph_id = ${graphId} ORDER BY id
    `),
  );
  return rows.map((row) => row.id);
}

const POSTGRES_DRIVERS: readonly IntegrationLaneDriver[] = [
  "pglite",
  "node-postgres",
  "postgres-js",
];

function isPostgresLane(context: IntegrationTestContext): boolean {
  return POSTGRES_DRIVERS.includes(context.driver);
}

/**
 * Whether the native handle a transaction TypeGraph opens hands its callback
 * is a transaction object rather than the root connection: every PostgreSQL
 * driver, and libSQL (Drizzle's per-transaction session). better-sqlite3's
 * manual frame hands the callback the root connection itself, and a backend
 * built over that is a root backend, not a transaction's.
 */
function nativeIsTransactionHandle(context: IntegrationTestContext): boolean {
  return isPostgresLane(context) || context.driver === "libsql";
}

/** The public constructors that accept a transaction's native handle. */
const PUBLIC_CONSTRUCTORS = {
  createPostgresTransactionBackend: (native: unknown) =>
    createPostgresTransactionBackend(
      native as never,
    ) as AdapterBackend<unknown>,
  createPostgresBackend: (native: unknown) =>
    createPostgresBackend(native as never) as AdapterBackend<unknown>,
  createSqliteBackend: (native: unknown) =>
    createSqliteBackend(native as never) as AdapterBackend<unknown>,
} as const;

type PublicConstructor = keyof typeof PUBLIC_CONSTRUCTORS;

function constructorsFor(
  context: IntegrationTestContext,
): readonly PublicConstructor[] {
  if (!nativeIsTransactionHandle(context)) return [];
  return isPostgresLane(context) ?
      ["createPostgresTransactionBackend", "createPostgresBackend"]
    : ["createSqliteBackend"];
}

/** A vector slot no schema declares, so only `createVectorIndex` provisions it. */
function slotFor(backend: GraphBackend, graphId: string) {
  return {
    graphId,
    nodeKind: "TvDoc",
    fieldPath: "embedding",
    dimensions: 3,
    metric: "cosine",
    indexType:
      requireDefined(backend.capabilities.vector).indexTypes[0] ?? "none",
  } as const;
}

type SlotParams = ReturnType<typeof slotFor>;

/** The member a transaction backend deletes a slot's marker with. */
function deletingSlot(backend: TransactionBackend): Readonly<{
  deleteSchemaVectorSlotContribution: (slot: SlotParams) => Promise<void>;
}> {
  return backend as unknown as Readonly<{
    deleteSchemaVectorSlotContribution: (slot: SlotParams) => Promise<void>;
  }>;
}

/**
 * The members of a backend a public constructor builds whose statements the
 * profile composes on its Drizzle handle (markers, materialization records,
 * graph templates, DDL, maintenance), each called with arguments that reach
 * its statement, keyed by the label the outcome is reported under.
 */
function handleStatementCalls(
  backend: GraphBackend,
  graphId: string,
): Readonly<Record<string, (() => Promise<unknown>) | undefined>> {
  const attemptedAt = "2026-01-01T00:00:00.000Z";
  const indexName = `${graphId}_late_index`;
  const claim = {
    indexName,
    graphId,
    entity: "node",
    kind: "TvItem",
    signature: "late",
    schemaVersion: 1,
  } as const;
  function bound<TArguments extends readonly unknown[]>(
    member: ((...args: TArguments) => Promise<unknown>) | undefined,
    ...args: TArguments
  ): (() => Promise<unknown>) | undefined {
    return member === undefined ? undefined : () => member(...args);
  }
  return {
    recordContributionMaterialization: bound(
      backend.recordContributionMaterialization,
      {
        graphId,
        logicalName: "late",
        owner: "late",
        tableName: "late",
        signature: "late",
        attemptedAt,
        materializedAt: attemptedAt,
        error: undefined,
      },
    ),
    getContributionMaterialization: bound(
      backend.getContributionMaterialization,
      { graphId, logicalName: "late", owner: "late", tableName: "late" },
    ),
    ensureContributionMaterializationsTable: bound(
      backend.ensureContributionMaterializationsTable,
    ),
    setReconciliationMarker: bound(backend.setReconciliationMarker, graphId, 1),
    getReconciliationMarker: bound(backend.getReconciliationMarker, graphId),
    recordKindRemoval: bound(backend.recordKindRemoval, {
      graphId,
      kindName: "TvItem",
      entity: "node",
      schemaVersion: 1,
      attemptedAt,
      removedAt: undefined,
      error: undefined,
    }),
    getAllKindRemovals: bound(backend.getAllKindRemovals, graphId),
    getPendingKindRemovals: bound(backend.getPendingKindRemovals, graphId),
    recordIndexMaterialization: bound(backend.recordIndexMaterialization, {
      ...claim,
      attemptedAt,
      materializedAt: attemptedAt,
      error: undefined,
    }),
    getIndexMaterialization: bound(backend.getIndexMaterialization, indexName),
    claimIndexMaterialization: bound(backend.claimIndexMaterialization, {
      ...claim,
      token: "late",
      leaseMs: 60_000,
    }),
    releaseIndexMaterializationClaim: bound(
      backend.releaseIndexMaterializationClaim,
      { indexName, token: "late" },
    ),
    registerGraphTemplate: bound(backend.registerGraphTemplate, {
      templateId: `${graphId}_late_template`,
      schemaHash: "late",
      schemaDoc: { graphId } as never,
    }),
    executeDdl: bound(
      backend.executeDdl,
      `CREATE TABLE IF NOT EXISTS ${graphId}_late_ddl (x INTEGER)`,
    ),
    refreshStatistics: bound(backend.refreshStatistics),
  };
}

/** What the root reads of each record a late handle statement would write. */
async function lateRecords(
  backend: GraphBackend,
  graphId: string,
): Promise<Readonly<Record<string, unknown>>> {
  return {
    contribution: await backend.getContributionMaterialization?.({
      graphId,
      logicalName: "late",
      owner: "late",
      tableName: "late",
    }),
    reconciliation: await backend.getReconciliationMarker?.(graphId),
    kindRemovals: ((await backend.getAllKindRemovals?.(graphId)) ?? []).length,
    index: await backend.getIndexMaterialization?.(`${graphId}_late_index`),
    ddlTable: await backend.catalog?.tableExists(`${graphId}_late_ddl`),
  };
}

/** A promise and the function that fulfils it. */
function createLatch(): Readonly<{
  promise: Promise<undefined>;
  open: () => void;
}> {
  const opener: { open?: () => void } = {};
  const promise = new Promise<undefined>((resolve) => {
    opener.open = () => {
      resolve(undefined);
    };
  });
  return { promise, open: requireDefined(opener.open) };
}

export function registerTransactionViewConsumerTests(
  context: IntegrationTestContext,
): void {
  describe("a backend a public constructor builds over a transaction TypeGraph opened", () => {
    for (const end of ["rolled back", "committed"] as const) {
      it(`is refused once TypeGraph ${end} the transaction, and its late write is not saved`, async () => {
        const constructors = constructorsFor(context);
        if (constructors.length === 0) return;
        const backend = context.getBackend();
        const observed: Record<string, unknown> = {};
        const expected: Record<string, unknown> = {};
        for (const name of constructors) {
          const graphId = nextGraphId();
          let kept: GraphBackend | undefined;
          const transaction = await outcomeOf(
            backend.transactionWithNative(async (tx, native) => {
              const built = PUBLIC_CONSTRUCTORS[name](native);
              kept = built;
              await built.insertNode(node(graphId, "built-inside"));
              await tx.insertNode(node(graphId, "owner"));
              if (end === "rolled back") throw new Error("callback failed");
            }),
          );
          const late = await outcomeOf(
            requireDefined(kept).insertNode(node(graphId, "built-late")),
          );
          observed[name] = {
            transaction,
            late,
            nodes: await nodeIds(backend, graphId),
          };
          expected[name] = {
            transaction:
              end === "rolled back" ?
                "untyped: Error: callback failed"
              : "fulfilled",
            late: "TransactionClosedError",
            nodes: end === "rolled back" ? [] : ["built-inside", "owner"],
          };
        }
        expect(observed).toEqual(expected);
      });
    }
    it("refuses every member that composes its statement on the Drizzle handle once TypeGraph rolled the transaction back, and none of them writes", async () => {
      const constructors = constructorsFor(context);
      if (constructors.length === 0) return;
      const backend = context.getBackend();
      const observed: Record<string, unknown> = {};
      const expected: Record<string, unknown> = {};
      for (const name of constructors) {
        const graphId = nextGraphId();
        let kept: GraphBackend | undefined;
        await outcomeOf(
          backend.transactionWithNative(async (_tx, native) => {
            kept = PUBLIC_CONSTRUCTORS[name](native);
            await kept.insertNode(node(graphId, "built-inside"));
            throw new Error("callback failed");
          }),
        );
        const late: Record<string, string> = {};
        for (const [member, call] of Object.entries(
          handleStatementCalls(requireDefined(kept), graphId),
        )) {
          if (call !== undefined) late[member] = await outcomeOf(call());
        }
        observed[name] = {
          late,
          records: await lateRecords(backend, graphId),
        };
        expected[name] = {
          late: Object.fromEntries(
            Object.keys(late).map((member) => [
              member,
              "TransactionClosedError",
            ]),
          ),
          records: {
            contribution: undefined,
            reconciliation: undefined,
            kindRemovals: 0,
            index: undefined,
            ddlTable: false,
          },
        };
      }
      expect(observed).toEqual(expected);
    });
  });

  describe("a Store over a transaction backend re-embedding a vector field", () => {
    it("re-embeds inside the caller's transaction, and the commit keeps the embeddings", async () => {
      if (!isPostgresLane(context)) return;
      const backend = context.getBackend();
      if (backend.capabilities.vector === undefined) return;
      const graphId = nextGraphId();
      const Document = defineNode("TvDoc", {
        schema: z.object({ title: z.string(), embedding: embedding(3) }),
      });
      const graph = defineGraph({
        id: graphId,
        nodes: { TvDoc: { type: Document } },
        edges: {},
      });
      const [root] = await createAdapterStoreWithSchema(graph, backend);
      await root.nodes.TvDoc.create(
        { title: "a", embedding: [1, 0, 0] },
        { id: "a" },
      );
      let reembed = "not run";
      await backend.transactionWithNative(async (_tx, native) => {
        const [scoped] = await createAdapterStoreWithSchema(
          graph,
          createPostgresTransactionBackend(
            native as never,
          ) as AdapterBackend<unknown>,
        );
        // The caller catches whatever reembed throws and commits.
        reembed = await outcomeOf(
          scoped.reembedVectorField("TvDoc", "embedding", {
            embed: (batch) =>
              Promise.resolve(
                new Map(batch.map((each) => [each.id, [0, 1, 0]])),
              ),
          }),
        );
      });
      const hits = await root.search.vector("TvDoc", {
        fieldPath: "embedding",
        queryEmbedding: [0, 1, 0],
        limit: 5,
      });
      // The score tells the re-embedded vector [0, 1, 0] (cosine 1 to the
      // query) from the original [1, 0, 0] (cosine 0), which would also be
      // the sole hit.
      expect({
        reembed,
        hits: hits.map((hit) => ({
          id: hit.node.id,
          score: Number(hit.score.toFixed(6)),
        })),
      }).toEqual({ reembed: "fulfilled", hits: [{ id: "a", score: 1 }] });
    });

    // `materializeIndexes()` drops an IVFFlat index before it rebuilds it
    // with `createVectorIndex`: the other caller that removes storage first.
    // In a caller's transaction the rebuild cannot run (PostgreSQL refuses
    // `CREATE INDEX CONCURRENTLY` in a transaction block and aborts it), so
    // the drop rolls back with the transaction. A refusal that left the
    // transaction usable would let the caller commit the drop.
    it("keeps an IVFFlat index a rebuild inside the caller's transaction dropped", async () => {
      if (!isPostgresLane(context)) return;
      const backend = context.getBackend();
      const strategy = backend.vectorStrategy;
      if (
        strategy === undefined ||
        backend.capabilities.vector?.indexTypes.includes("ivfflat") !== true
      ) {
        return;
      }
      const graphId = nextGraphId();
      const Document = defineNode("TvDoc", {
        schema: z.object({
          title: z.string(),
          embedding: embedding(3, { indexType: "ivfflat" }),
        }),
      });
      const graph = defineGraph({
        id: graphId,
        nodes: { TvDoc: { type: Document } },
        edges: {},
      });
      const [root] = await createAdapterStoreWithSchema(graph, backend);
      await root.nodes.TvDoc.create(
        { title: "a", embedding: [1, 0, 0] },
        { id: "a" },
      );
      // Built without a materialization record, so `materializeIndexes()`
      // rebuilds it.
      await requireDefined(backend.createVectorIndex)({
        graphId,
        nodeKind: "TvDoc",
        fieldPath: "embedding",
        dimensions: 3,
        metric: "cosine",
        indexType: "ivfflat",
      });
      const tableName = strategy.tableName(graphId, "TvDoc", "embedding");
      async function indexCount(): Promise<number> {
        const [row] = await backend.execute<{ count: number | string }>(
          asCompiledRowsSql(
            sql`SELECT COUNT(*) AS count FROM pg_indexes WHERE tablename = ${tableName} AND indexdef LIKE '%ivfflat%'`,
          ),
        );
        return Number(requireDefined(row).count);
      }
      const before = await indexCount();
      // Which index members the rebuild reached, in order, and how each
      // settled: the drop must run for the test to say anything about it.
      const attempted: string[] = [];
      let materialized = "not run";
      const transaction = await outcomeOf(
        backend.transactionWithNative(async (_tx, native) => {
          const built = createPostgresTransactionBackend(
            native as never,
          ) as AdapterBackend<unknown>;
          const dropVectorIndex = requireDefined(built.dropVectorIndex);
          const createIndex = requireDefined(built.createVectorIndex);
          const recorded = deriveBackend(built, {
            async dropVectorIndex(params) {
              const result = await outcomeOf(dropVectorIndex(params));
              attempted.push(`dropVectorIndex: ${result}`);
              if (result !== "fulfilled") throw new Error(result);
            },
            async createVectorIndex(params) {
              const result = await outcomeOf(createIndex(params));
              attempted.push(`createVectorIndex: ${result}`);
              if (result !== "fulfilled") throw new Error(result);
            },
          });
          const [scoped] = await createAdapterStoreWithSchema(graph, recorded);
          // The caller catches what the rebuild throws, and commits: the
          // failed `CREATE INDEX CONCURRENTLY` aborted the transaction, so
          // the failure record cannot be written and the commit rolls back.
          materialized = await outcomeOf(scoped.materializeIndexes());
        }),
      );
      expect({
        transaction,
        attempted: attempted.map((entry) => entry.split("\n")[0]),
        materialized,
        before,
        after: await indexCount(),
      }).toEqual({
        transaction: "TransactionOutcomeUnknownError",
        attempted: [
          "dropVectorIndex: fulfilled",
          expect.stringMatching(/^createVectorIndex: untyped: /) as unknown,
        ],
        materialized: expect.stringMatching(
          /^untyped: Error: Failed query: insert into "typegraph_index_materializations"/,
        ) as unknown,
        before: 1,
        after: 1,
      });
    });
  });

  // A savepoint is identified by the transaction that encloses it, so a
  // backend adopted over the savepoint's handle admits through the enclosing
  // transaction's view and outlives the savepoint. Savepoint lifetime is not
  // tracked yet; main has no view at all and saves the late write too.
  // PostgreSQL only: a backend built over a libSQL transaction handle cannot
  // open a savepoint (its `BEGIN IMMEDIATE` fails inside the transaction),
  // and better-sqlite3 hands the callback the root connection.
  describe("a backend adopted over a savepoint's native handle (known defect)", () => {
    it("is refused once the savepoint rolls back, and its late write is not saved", async () => {
      if (!isPostgresLane(context)) return;
      const backend = context.getBackend();
      const graphId = nextGraphId();
      let late = "not run";
      await backend.transactionWithNative(async (_tx, native) => {
        const enclosing =
          PUBLIC_CONSTRUCTORS.createPostgresTransactionBackend(native);
        let adopted: TransactionBackend | undefined;
        const savepointOutcome = await outcomeOf(
          enclosing.transactionWithNative(
            async (_savepoint, savepointNative) => {
              adopted = enclosing.adoptTransaction(savepointNative);
              await adopted.insertNode(node(graphId, "savepoint-inside"));
              throw new Error("savepoint callback failed");
            },
          ),
        );
        expect(savepointOutcome).toBe(
          "untyped: Error: savepoint callback failed",
        );
        // The savepoint rolled back; the enclosing transaction commits.
        late = await outcomeOf(
          requireDefined(adopted).insertNode(node(graphId, "savepoint-late")),
        );
      });
      expectObservation({
        lane: { driver: context.driver },
        observed: { late, nodes: await nodeIds(backend, graphId) },
        correct: { late: "TransactionClosedError", nodes: [] },
        defects: [
          {
            label: "savepoint adoption outlives its savepoint",
            on: { driver: POSTGRES_DRIVERS },
            today: { late: "fulfilled", nodes: ["savepoint-late"] },
          },
        ],
      });
    });
  });

  // A savepoint a constructor-built backend opens gets a view of its own,
  // closed when the savepoint ends: the enclosing transaction's end does not
  // reach it. A savepoint callback the enclosing callback left pending can
  // therefore write after the enclosing transaction rolled back, on the
  // released connection. Savepoint lifetime is not tracked yet; main has no
  // view at all and saves the late write too.
  describe("a savepoint a constructor-built backend opened, left pending when its enclosing transaction ends (known defect)", () => {
    it("is refused once the enclosing transaction rolled back, and its late write is not saved", async () => {
      if (!isPostgresLane(context)) return;
      const backend = context.getBackend();
      const graphId = nextGraphId();
      const { promise: gate, open: release } = createLatch();
      let nested: Promise<string> | undefined;
      let lateInsert = "not run";
      const enclosingOutcome = await outcomeOf(
        backend.transactionWithNative(async (_tx, native) => {
          const enclosing =
            PUBLIC_CONSTRUCTORS.createPostgresTransactionBackend(native);
          const { promise: inside, open: entered } = createLatch();
          nested = outcomeOf(
            enclosing.transaction(async (savepoint) => {
              entered();
              await gate;
              lateInsert = await outcomeOf(
                savepoint.insertNode(node(graphId, "savepoint-late")),
              );
            }),
          );
          await inside;
          throw new Error("callback failed");
        }),
      );
      release();
      // The savepoint's own end fails on every driver once its enclosing
      // transaction is gone; what is pinned is the write before it.
      await requireDefined(nested);
      expect(enclosingOutcome).toBe("untyped: Error: callback failed");
      expectObservation({
        lane: { driver: context.driver },
        observed: { lateInsert, nodes: await nodeIds(backend, graphId) },
        correct: { lateInsert: "TransactionClosedError", nodes: [] },
        defects: [
          {
            label: "savepoint view outlives its enclosing transaction",
            on: { driver: ["node-postgres", "postgres-js"] },
            today: { lateInsert: "fulfilled", nodes: ["savepoint-late"] },
          },
          {
            label: "savepoint view outlives its enclosing transaction (PGlite)",
            on: { driver: ["pglite"] },
            today: { lateInsert: "untyped: Error: Failed query:", nodes: [] },
          },
        ],
      });
    });
  });

  // Each PostgreSQL binding of a transaction reads markers on the session
  // through a cache of its own, and eviction reaches the evicting binding's
  // cache and the root's, never a sibling's: the owner keeps authorising
  // with the marker its adoption deleted. Main binds the same way (and
  // evicts only the evicting binding's cache), so it is pinned. On libSQL the
  // owner shares the root cache, which the eviction reaches, but then reads
  // the marker on the root connection, which does not see the transaction's
  // delete: the writer-slot known limit
  // (`tests/backends/sqlite/libsql-transaction-marker-snapshot.test.ts`).
  describe("a vector slot's marker one binding of a transaction deletes (known defects)", () => {
    it("no longer authorises a sibling binding that had confirmed it", async () => {
      const backend = context.getBackend();
      const createVectorIndex = backend.createVectorIndex;
      if (
        createVectorIndex === undefined ||
        backend.capabilities.vector === undefined
      ) {
        return;
      }
      const slot = slotFor(backend, nextGraphId());
      await createVectorIndex(slot);
      const embeddingParams = { ...slot, nodeId: "d1" };
      let observed: Readonly<Record<string, string>> = {};
      await backend.transactionWithNative(async (tx, native) => {
        const deleteEmbedding = requireDefined(tx.deleteEmbedding);
        // The owner confirms the marker, and caches the confirmation.
        const ownerWarm = await outcomeOf(deleteEmbedding(embeddingParams));
        await deletingSlot(
          backend.adoptTransaction(native),
        ).deleteSchemaVectorSlotContribution(slot);
        observed = {
          ownerWarm,
          ownerAfterDelete: await outcomeOf(deleteEmbedding(embeddingParams)),
        };
      });
      expectObservation({
        lane: { driver: context.driver },
        observed,
        correct: {
          ownerWarm: "fulfilled",
          ownerAfterDelete: "StoreNotInitializedError",
        },
        defects: [
          {
            label: "sibling marker cache",
            on: { driver: POSTGRES_DRIVERS },
            today: { ownerWarm: "fulfilled", ownerAfterDelete: "fulfilled" },
          },
          {
            label: "libSQL writer-slot marker read on the root connection",
            on: { driver: ["libsql"] },
            today: { ownerWarm: "fulfilled", ownerAfterDelete: "fulfilled" },
          },
        ],
      });
    });
  });
}
