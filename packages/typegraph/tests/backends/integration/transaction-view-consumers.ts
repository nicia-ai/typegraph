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
      expect({
        reembed,
        hits: hits.map((hit) => hit.node.id),
      }).toEqual({ reembed: "fulfilled", hits: ["a"] });
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
      await outcomeOf(
        backend.transactionWithNative(async (_tx, native) => {
          const [scoped] = await createAdapterStoreWithSchema(
            graph,
            createPostgresTransactionBackend(
              native as never,
            ) as AdapterBackend<unknown>,
          );
          // The caller does not inspect the result, and commits.
          await scoped.materializeIndexes();
        }),
      );
      expect({ before, after: await indexCount() }).toEqual({
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
