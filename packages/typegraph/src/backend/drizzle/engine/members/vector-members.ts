/**
 * Embedding CRUD, vector search, and ANN index lifecycle: the eight members
 * every SQL engine profile with a vector strategy exposes. Every statement
 * this group issues goes through the dialect's `execRun` (or, for search,
 * the dialect's own override-aware runner) — this group never touches
 * `executionAdapter` or `db.execute` / `db.run` directly.
 *
 * Two genuine per-engine differences do not collapse into shared code, and
 * are threaded through as explicit deps rather than re-spelled here:
 *
 * - **`applySearchOverrides`.** PostgreSQL validates a per-search `efSearch`
 *   against pgvector's own ceiling, computes any transaction-local GUC
 *   overrides the search needs (`SET LOCAL hnsw.*` / `ivfflat.*`), and runs
 *   the query through the runner that wraps them in a transaction. No SQLite
 *   engine this package bundles has a per-search frontier knob at all, so
 *   its arm calls the same portable `resolveEfSearchOverride` predicate
 *   purely to refuse a requested override, then runs the query unmodified.
 * - **`runIndexBuild`.** PostgreSQL routes an ANN index build through the
 *   serial fallback that retries under `parallel_workers = 0` when the
 *   parallel build exhausts dynamic shared memory; SQLite has no such
 *   build-resource failure mode and just runs the statement.
 *
 * Every other member — the embedding writes, the schema-vector-slot
 * contribution delete, and the index-build/drop wrapping around the two
 * seams above — is the same statement sequence on both engines.
 */
import {
  assertVectorSearchLimit,
  type VectorSlot,
  type VectorStrategy,
} from "../../../../query/dialect/vector-strategy";
import { chunk as chunkArray } from "../../../../utils/array";
import { isMissingTableError } from "../../../../utils/sql-errors";
import { buildLiveNodeCandidates } from "../../../live-node-candidates";
import { nowIso } from "../../../row-mappers";
import {
  type CreateVectorIndexParams,
  type DeleteEmbeddingParams,
  type DropVectorIndexParams,
  type UpsertEmbeddingBatchParams,
  type UpsertEmbeddingParams,
  type VectorSearchParams,
  type VectorSearchResult,
} from "../../../types";
import type { ContributionMaterializer } from "../../contribution-materializations";
import type { ExecutableSql } from "../../execution/types";
import type { CommonOperationStrategy } from "../../operations/strategy";
import {
  mapVectorWriteError,
  vectorSlotFromCreateIndexParams,
  vectorSlotFromDropIndexParams,
  vectorSlotFromParams,
} from "../../vector-runtime";
import type { EngineTableNames } from "../profile";

/** One raw row a search runner hands back, before it is mapped to {@link VectorSearchResult}. */
type VectorSearchRawRow = Readonly<{ node_id: string; score: number }>;

/**
 * Deps needed only when a vector strategy is active. `undefined` collapses
 * every field: with no strategy there is no per-field storage to write,
 * search, or index, so the always-present members below return
 * immediately without touching any of them — mirroring a fulltext-less
 * backend.
 */
export type CreateVectorMembersDeps =
  | Readonly<{ vectorStrategy: undefined }>
  | Readonly<{
      vectorStrategy: VectorStrategy;
      execution: Readonly<{
        execRun: (query: ExecutableSql) => Promise<void>;
      }>;
      /** Dialect-derived embedding batch size (from the dialect's own bind-parameter budget). */
      batchConfig: Readonly<{ embeddingUpsertBatchSize: number }>;
      tableNames: Pick<EngineTableNames, "nodes">;
      contributionMaterializer: Pick<
        ContributionMaterializer,
        "assertVectorSlot" | "ensureVectorSlot" | "evictVectorSlot"
      >;
      operationStrategy: Pick<
        CommonOperationStrategy,
        "buildDeleteContributionMaterialization"
      >;
      /**
       * Resolves this engine's per-search `efSearch` handling and runs the
       * already-built query. See the module doc comment for what each
       * engine's arm does. Never wrapped by the caller's own error mapping —
       * pass the query through unmodified on success.
       */
      applySearchOverrides: (
        query: ExecutableSql,
        params: Pick<VectorSearchParams, "efSearch" | "indexType">,
      ) => Promise<readonly VectorSearchRawRow[]>;
      /**
       * Runs one already-built ANN index-creation statement. See the module
       * doc comment for what each engine's arm does.
       */
      runIndexBuild: (
        params: Readonly<{ slot: VectorSlot; indexStatement: ExecutableSql }>,
      ) => Promise<void>;
    }>;

export type VectorMembers = Readonly<{
  upsertEmbedding?: (params: UpsertEmbeddingParams) => Promise<void>;
  upsertEmbeddingBatch?: (
    params: UpsertEmbeddingBatchParams,
  ) => Promise<void>;
  deleteEmbedding?: (params: DeleteEmbeddingParams) => Promise<void>;
  deleteEmbeddingBatch?: (
    params: Omit<DeleteEmbeddingParams, "nodeId"> &
      Readonly<{ nodeIds: readonly string[] }>,
  ) => Promise<void>;
  vectorSearch?: (
    params: VectorSearchParams,
  ) => Promise<readonly VectorSearchResult[]>;
  deleteSchemaVectorSlotContribution: (slot: VectorSlot) => Promise<void>;
  createVectorIndex: (params: CreateVectorIndexParams) => Promise<void>;
  dropVectorIndex: (params: DropVectorIndexParams) => Promise<void>;
}>;

/**
 * Builds the vector member group. Moved out of the two dialect files
 * unchanged: same statements, same batch chunking, same slot-marker
 * assertions — only the two seams the module doc comment names differ.
 */
export function createVectorMembers(
  deps: CreateVectorMembersDeps,
): VectorMembers {
  return {
    ...(deps.vectorStrategy === undefined ?
      {}
    : {
        async upsertEmbedding(params: UpsertEmbeddingParams): Promise<void> {
          const { vectorStrategy, execution, contributionMaterializer } =
            deps;
          const slot = vectorSlotFromParams(params);
          // Assert the slot's durable marker (SELECT, cached) — never DDL.
          // The per-field table is provisioned by the privileged migrator
          // (`createStoreWithSchema` → `materializeVectorContributions`), so
          // a least-privilege runtime role writes embeddings without CREATE.
          await contributionMaterializer.assertVectorSlot(slot);
          const statements = vectorStrategy.buildUpsert(
            slot,
            params,
            nowIso(),
          );
          try {
            for (const statement of statements) {
              await execution.execRun(statement);
            }
          } catch (error) {
            throw mapVectorWriteError(error, params);
          }
        },

        async upsertEmbeddingBatch(
          params: UpsertEmbeddingBatchParams,
        ): Promise<void> {
          if (params.rows.length === 0) return;
          const { vectorStrategy, execution, batchConfig, contributionMaterializer } =
            deps;
          const slot = vectorSlotFromParams(params);
          // Same SELECT-only marker assert as the single-row path — never DDL.
          await contributionMaterializer.assertVectorSlot(slot);
          // Last-write-wins dedupe: a multi-row upsert cannot affect one
          // row twice.
          const rowsById = new Map(
            params.rows.map((row) => [row.nodeId, row] as const),
          );
          const rows = [...rowsById.values()];
          const timestamp = nowIso();
          try {
            for (const chunk of chunkArray(
              rows,
              batchConfig.embeddingUpsertBatchSize,
            )) {
              const statements =
                vectorStrategy.buildUpsertBatch === undefined ?
                  chunk.flatMap((row) =>
                    vectorStrategy.buildUpsert(
                      slot,
                      {
                        graphId: params.graphId,
                        nodeKind: params.nodeKind,
                        nodeId: row.nodeId,
                        fieldPath: params.fieldPath,
                        embedding: row.embedding,
                        dimensions: params.dimensions,
                        metric: params.metric,
                        indexType: params.indexType,
                      },
                      timestamp,
                    ),
                  )
                : vectorStrategy.buildUpsertBatch(
                    slot,
                    { ...params, rows: chunk },
                    timestamp,
                  );
              for (const statement of statements) {
                await execution.execRun(statement);
              }
            }
          } catch (error) {
            throw mapVectorWriteError(error, params);
          }
        },

        async deleteEmbedding(params: DeleteEmbeddingParams): Promise<void> {
          const { vectorStrategy, execution, contributionMaterializer } =
            deps;
          // Assert the slot's durable marker before deleting. A delete can
          // run before any embedding was ever written for the field (e.g. a
          // node hard-deleted having never carried one); the per-field table
          // was provisioned at boot, so the DELETE targets an existing
          // (possibly empty) table and is a clean no-op — never a DELETE
          // against a missing relation, which would abort an enclosing
          // transaction on an engine where DDL-less DELETE against a
          // missing table is an error (PostgreSQL). SELECT-only assert,
          // never DDL.
          const slot = vectorSlotFromParams(params);
          await contributionMaterializer.assertVectorSlot(slot);
          const statements = vectorStrategy.buildDelete(slot, params);
          for (const statement of statements) {
            await execution.execRun(statement);
          }
        },

        async deleteEmbeddingBatch(
          params: Omit<DeleteEmbeddingParams, "nodeId"> &
            Readonly<{ nodeIds: readonly string[] }>,
        ): Promise<void> {
          if (params.nodeIds.length === 0) return;
          const { vectorStrategy, execution, batchConfig, contributionMaterializer } =
            deps;
          const slot = vectorSlotFromParams(params);
          await contributionMaterializer.assertVectorSlot(slot);
          for (const nodeIds of chunkArray(
            [...new Set(params.nodeIds)],
            batchConfig.embeddingUpsertBatchSize,
          )) {
            const statements = vectorStrategy.buildDeleteBatch(slot, {
              ...params,
              nodeIds,
            });
            for (const statement of statements) {
              await execution.execRun(statement);
            }
          }
        },

        async vectorSearch(
          params: VectorSearchParams,
        ): Promise<readonly VectorSearchResult[]> {
          const { vectorStrategy, tableNames, applySearchOverrides } = deps;
          assertVectorSearchLimit(params.limit);
          const slot = vectorSlotFromParams(params);
          // Deliberately NOT marker-gated: search is read-only (no DDL
          // hazard to gate), and its params carry the caller's runtime
          // metric override, which legitimately diverges from the
          // provisioned shape on strategies that bake the metric into the
          // DDL (sqlite-vec; pgvector's table DDL is metric-free but the
          // contract is kept identical across dialects). An unprovisioned
          // slot surfaces the engine's missing-relation error — the same
          // contract as a query-builder `similarTo()` predicate;
          // `createVerifiedStore` catches both at attach.
          const query = vectorStrategy.buildSearch(
            slot,
            params,
            // Store-compiled candidates (predicates + subclass + currency)
            // take precedence; the live-node default covers direct backend use.
            params.candidates ??
              buildLiveNodeCandidates(
                tableNames.nodes,
                params.graphId,
                params.nodeKind,
                nowIso(),
              ),
          );
          let rows: readonly VectorSearchRawRow[];
          try {
            rows = await applySearchOverrides(query, params);
          } catch (error) {
            // A query vector whose dimension no longer matches the stored
            // column surfaces the same typed error as the write path.
            throw mapVectorWriteError(error, params);
          }
          return rows.map((row) => ({
            nodeId: row.node_id,
            score: row.score,
          }));
        },
      }),

    async deleteSchemaVectorSlotContribution(slot: VectorSlot): Promise<void> {
      if (deps.vectorStrategy === undefined) return;
      const { vectorStrategy, execution, operationStrategy, contributionMaterializer } =
        deps;
      for (const contribution of vectorStrategy.ownedTables(slot)) {
        await execution.execRun(
          operationStrategy.buildDeleteContributionMaterialization({
            graphId: slot.graphId,
            logicalName: contribution.logicalName,
            owner: contribution.owner,
            tableName: contribution.tableName,
          }),
        );
      }
      // Eviction is conservative if the surrounding transaction later rolls
      // back: the next access re-reads the still-durable marker.
      contributionMaterializer.evictVectorSlot(slot);
    },

    async createVectorIndex(params: CreateVectorIndexParams): Promise<void> {
      if (deps.vectorStrategy === undefined) return;
      const { vectorStrategy, contributionMaterializer, runIndexBuild } =
        deps;
      const slot = vectorSlotFromCreateIndexParams(params);
      // Ensure the per-field table + its durable marker first (privileged,
      // idempotent), then create its ANN index. A strategy's `ownedTables`
      // may or may not fold the index DDL into the table it builds, so this
      // explicit step both picks up the slot's declared index parameters
      // (e.g. `m`/`ef_construction`/`lists`) and covers slots whose index
      // intent changed after the table was first materialized.
      await contributionMaterializer.ensureVectorSlot(slot);
      const indexStatement = vectorStrategy.buildCreateIndex?.(slot, {
        concurrent: params.concurrent === true,
      });
      if (indexStatement !== undefined) {
        await runIndexBuild({ slot, indexStatement });
      }
    },

    async dropVectorIndex(params: DropVectorIndexParams): Promise<void> {
      if (deps.vectorStrategy === undefined) return;
      const { vectorStrategy, execution } = deps;
      const slot = vectorSlotFromDropIndexParams(params);
      const dropStatement = vectorStrategy.buildDropIndex?.(slot);
      if (dropStatement === undefined) return;
      try {
        await execution.execRun(dropStatement);
      } catch (error) {
        // The per-field table (and thus its index) may never have been
        // materialized; treat a missing relation as already-dropped
        // (some drivers error on `DROP INDEX IF EXISTS` against a missing
        // table rather than no-op).
        if (!isMissingTableError(error)) throw error;
      }
    },
  };
}
