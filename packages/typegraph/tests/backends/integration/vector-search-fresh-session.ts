/**
 * A vector search in a transaction, run on a database session that has not
 * used a vector value yet.
 *
 * PostgreSQL's pgvector defines its search parameters (`hnsw.ef_search`,
 * `hnsw.iterative_scan`, `ivfflat.iterative_scan`) only once its library loads
 * in the session's backend process. A search inside a transaction overrides
 * those parameters for itself and restores them afterwards, so it first reads
 * their current values. Read without `missing_ok`, an undefined parameter
 * raised `42704 unrecognized configuration parameter` and aborted the
 * transaction the search ran in — on any pooled connection whose first vector
 * statement was a transactional approximate search.
 *
 * Every case seeds through one session and then searches through a NEW session
 * over the same storage (`openReopenableStorage`), and asserts what every
 * backend must give: the nearest row, and a transaction that stays usable
 * after the search and commits.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, embedding, type NodeId } from "../../../src";
import type {
  AdapterBackend,
  TransactionBackend,
  VectorSearchParams,
} from "../../../src/backend/types";
import {
  createAdapterStore,
  createAdapterStoreWithSchema,
} from "../../../src/store";
import { requireDefined } from "../../../src/utils/presence";
import type { ReopenableStorage } from "../../helpers/reopenable-storage";
import type { IntegrationTestContext } from "./test-context";

const FreshSessionDocument = defineNode("FreshSessionDocument", {
  schema: z.object({
    title: z.string(),
    embedding: embedding(3, { metric: "cosine", indexType: "hnsw" }),
  }),
});

const freshSessionGraph = defineGraph({
  id: "vector_search_fresh_session",
  nodes: { FreshSessionDocument: { type: FreshSessionDocument } },
  edges: {},
});

const QUERY_VECTOR = [1, 0, 0] as const;

type SkipContext = Readonly<{ skip: (note?: string) => never }>;

type FreshSession = Readonly<{
  backend: AdapterBackend<unknown>;
  nearestId: NodeId<typeof FreshSessionDocument>;
}>;

/** The low-level search for the nearest document, with or without `efSearch`. */
function searchParams(efSearch: number | undefined): VectorSearchParams {
  return {
    graphId: freshSessionGraph.id,
    nodeKind: "FreshSessionDocument",
    fieldPath: "embedding",
    queryEmbedding: QUERY_VECTOR,
    metric: "cosine",
    dimensions: 3,
    indexType: "hnsw",
    limit: 1,
    ...(efSearch === undefined ? {} : { efSearch }),
  };
}

/**
 * The two ways a transaction-scoped backend reaches the search: the backend's
 * own transaction, and a caller's native transaction adopted into TypeGraph.
 */
const TRANSACTION_FORMS = {
  "the backend's transaction": <T>(
    backend: AdapterBackend<unknown>,
    body: (transaction: TransactionBackend) => Promise<T>,
  ) => backend.transaction((transaction) => body(transaction)),
  "an adopted native transaction": <T>(
    backend: AdapterBackend<unknown>,
    body: (transaction: TransactionBackend) => Promise<T>,
  ) =>
    backend.transactionWithNative((_transaction, native) =>
      body(backend.adoptTransaction(native)),
    ),
} as const;

export function registerVectorSearchFreshSessionIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Vector search on a session that has not used a vector yet", () => {
    const opened: ReopenableStorage[] = [];

    afterEach(async () => {
      for (const storage of opened.splice(0)) await storage.close();
    });

    /**
     * Seeds two documents through the storage's first session and returns a
     * backend over a new session on the same storage. Skips a lane whose
     * backend has no vector support.
     */
    async function openFreshSession(ctx: SkipContext): Promise<FreshSession> {
      const storage = await context.openReopenableStorage();
      opened.push(storage);
      if (storage.backend.capabilities.vector?.supported !== true) {
        ctx.skip("this lane's backend has no vector support");
      }
      const [seed] = await createAdapterStoreWithSchema(
        freshSessionGraph,
        storage.backend,
      );
      const nearest = await seed.nodes.FreshSessionDocument.create({
        title: "nearest",
        embedding: [...QUERY_VECTOR],
      });
      await seed.nodes.FreshSessionDocument.create({
        title: "farthest",
        embedding: [0, 1, 0],
      });
      return { backend: await storage.reopen(), nearestId: nearest.id };
    }

    for (const [form, inTransaction] of Object.entries(TRANSACTION_FORMS)) {
      for (const efSearch of [undefined, 64] as const) {
        it(`searches in ${form} (efSearch ${efSearch ?? "omitted"}) and leaves the transaction usable`, async (ctx) => {
          const { backend, nearestId } = await openFreshSession(ctx);
          if (
            efSearch !== undefined &&
            backend.capabilities.vector?.searchFrontierTuning.tunable !== true
          ) {
            ctx.skip("this lane's vector engine refuses efSearch");
          }

          const outcome = await inTransaction(backend, async (transaction) => {
            const hits = await requireDefined(transaction.vectorSearch)(
              searchParams(efSearch),
            );
            // A statement after the search, on the same transaction: an
            // aborted transaction refuses it.
            const nearest = await transaction.getNode(
              freshSessionGraph.id,
              "FreshSessionDocument",
              nearestId,
            );
            return {
              hits: hits.map((hit) => hit.nodeId),
              readAfterSearch: nearest?.id,
            };
          });

          expect(outcome).toEqual({
            hits: [nearestId],
            readAfterSearch: nearestId,
          });
        });
      }
    }

    it("runs an approximate similarTo query in store.transaction", async (ctx) => {
      const { backend, nearestId } = await openFreshSession(ctx);
      const store = createAdapterStore(freshSessionGraph, backend);

      const outcome = await store.transaction(async (transaction) => {
        const rows = await transaction
          .query()
          .from("FreshSessionDocument", "document")
          .whereNode("document", (document) =>
            document.embedding.similarTo([...QUERY_VECTOR], 1, {
              metric: "cosine",
              approximate: true,
            }),
          )
          .select((select) => ({ id: select.document.id }))
          .execute();
        const nearest =
          await transaction.nodes.FreshSessionDocument.getById(nearestId);
        return {
          rows: rows.map((row) => row.id),
          readAfterSearch: nearest?.id,
        };
      });

      expect(outcome).toEqual({
        rows: [nearestId],
        readAfterSearch: nearestId,
      });
    });
  });
}
