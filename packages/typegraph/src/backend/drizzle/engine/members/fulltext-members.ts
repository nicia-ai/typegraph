/**
 * Fulltext CRUD and search: five members shared verbatim by every SQL
 * engine profile. Each statement is built by the dialect's
 * `CommonOperationStrategy` and run through the execution primitives the
 * dialect already exposes — this group never touches `executionAdapter`
 * or `db.execute` / `db.run` directly, so it carries none of a dialect's
 * own serialization or transaction-framing story.
 */
import { chunk as chunkArray } from "../../../../utils/array";
import { coerceNumericScore, nowIso } from "../../../row-mappers";
import type {
  DeleteFulltextBatchParams,
  DeleteFulltextParams,
  FulltextSearchParams,
  FulltextSearchResult,
  UpsertFulltextBatchParams,
  UpsertFulltextParams,
} from "../../../types";
import type { ExecutableSql } from "../../execution/types";
import type { CommonOperationStrategy } from "../../operations/strategy";

/**
 * The execution primitives fulltext statements run through. Each dialect's
 * `execAll` / `execRun` already carries that dialect's own serialization
 * story (SQLite queues through its serialized queue; PostgreSQL routes
 * straight to its pooled execution adapter) — this member group only ever
 * calls them, so the dialect's own wrapping is preserved without this file
 * knowing it exists.
 */
type FulltextMembersExecution = Readonly<{
  execAll: <TRow>(query: ExecutableSql) => Promise<readonly TRow[]>;
  execRun: (query: ExecutableSql) => Promise<void>;
}>;

/**
 * The dialect-derived chunk sizes fulltext batch writes partition against.
 * Each dialect computes these from its own bind-parameter budget
 * (`computePostgresBatchChunkSizes` / `computeSqliteBatchChunkSizes`); they
 * are not part of the portable `OperationBackendBatchConfig`, which has no
 * fulltext-specific fields.
 */
type FulltextBatchChunkSizes = Readonly<{
  fulltextUpsertBatchSize: number;
  fulltextDeleteChunkSize: number;
}>;

export type CreateFulltextMembersDeps = Readonly<{
  /** The dialect's fulltext SQL builders, already closed over its table names and fulltext strategy. */
  strategy: Pick<
    CommonOperationStrategy,
    | "buildUpsertFulltext"
    | "buildDeleteFulltext"
    | "buildUpsertFulltextBatch"
    | "buildDeleteFulltextBatch"
    | "buildFulltextSearch"
  >;
  execution: FulltextMembersExecution;
  batchConfig: FulltextBatchChunkSizes;
}>;

export type FulltextMembers = Readonly<{
  upsertFulltext: (params: UpsertFulltextParams) => Promise<void>;
  deleteFulltext: (params: DeleteFulltextParams) => Promise<void>;
  upsertFulltextBatch: (params: UpsertFulltextBatchParams) => Promise<void>;
  deleteFulltextBatch: (params: DeleteFulltextBatchParams) => Promise<void>;
  fulltextSearch: (
    params: FulltextSearchParams,
  ) => Promise<readonly FulltextSearchResult[]>;
}>;

/**
 * Builds the fulltext member group. Moved out of the two dialect files
 * unchanged: same statements, same batch chunking, same numeric-score
 * coercion.
 */
export function createFulltextMembers(
  deps: CreateFulltextMembersDeps,
): FulltextMembers {
  const { strategy, execution, batchConfig } = deps;
  const { execAll, execRun } = execution;

  return {
    async upsertFulltext(params: UpsertFulltextParams): Promise<void> {
      const timestamp = nowIso();
      const statements = strategy.buildUpsertFulltext(params, timestamp);
      for (const stmt of statements) {
        await execRun(stmt);
      }
    },

    async deleteFulltext(params: DeleteFulltextParams): Promise<void> {
      const statements = strategy.buildDeleteFulltext(params);
      for (const stmt of statements) {
        await execRun(stmt);
      }
    },

    async upsertFulltextBatch(
      params: UpsertFulltextBatchParams,
    ): Promise<void> {
      if (params.rows.length === 0) return;
      const timestamp = nowIso();
      // The strategy emits ONE statement over every row it is given, so
      // the bind budget is enforced here — same contract as node/edge
      // batch inserts.
      for (const rows of chunkArray(
        params.rows,
        batchConfig.fulltextUpsertBatchSize,
      )) {
        const statements = strategy.buildUpsertFulltextBatch(
          { ...params, rows },
          timestamp,
        );
        for (const stmt of statements) {
          await execRun(stmt);
        }
      }
    },

    async deleteFulltextBatch(
      params: DeleteFulltextBatchParams,
    ): Promise<void> {
      if (params.nodeIds.length === 0) return;
      for (const nodeIds of chunkArray(
        params.nodeIds,
        batchConfig.fulltextDeleteChunkSize,
      )) {
        const statements = strategy.buildDeleteFulltextBatch({
          ...params,
          nodeIds,
        });
        for (const stmt of statements) {
          await execRun(stmt);
        }
      }
    },

    async fulltextSearch(
      params: FulltextSearchParams,
    ): Promise<readonly FulltextSearchResult[]> {
      const query = strategy.buildFulltextSearch(params);
      // A numeric score column can come back as a string on either engine
      // (PostgreSQL's `numeric` type preserves precision as text; SQLite's
      // dynamic typing can hand back a string for the aggregate rank score
      // too), so coerce at the backend boundary — FulltextSearchResult.score
      // is always `number`.
      const rows = await execAll<{
        node_id: string;
        score: number | string;
        snippet: string | null;
      }>(query);
      return rows.map((row, index) => ({
        nodeId: row.node_id,
        score: coerceNumericScore(row.score),
        rank: index + 1,
        ...(row.snippet === null ? {} : { snippet: row.snippet }),
      }));
    },
  };
}
