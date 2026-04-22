/**
 * SQL builders for fulltext read operations.
 *
 * Write operations (upsert / delete, single and batch) are owned by the
 * active `FulltextStrategy` — see `src/query/dialect/fulltext-strategy.ts`.
 * A strategy-level `buildUpsert` / `buildBatchUpsert` / `buildDelete` /
 * `buildBatchDelete` means alternate backends (pg_trgm, ParadeDB/pg_search,
 * pgroonga) control the full write pipeline, not just read SQL.
 *
 * The search builder stays here because it composes fragments from the
 * strategy (`matchCondition`, `rankExpression`, `snippetExpression`) into
 * a single `SELECT` shape that is identical across dialects.
 */
import { type SQL, sql } from "drizzle-orm";

import type { FulltextStrategy } from "../../../query/dialect/fulltext-strategy";
import type { FulltextQueryMode, FulltextSearchParams } from "../../types";
import { quotedTableName } from "./shared";

function resolveMode(mode: FulltextQueryMode | undefined): FulltextQueryMode {
  return mode ?? "websearch";
}

export function buildFulltextSearch(
  tableName: string,
  params: FulltextSearchParams,
  strategy: FulltextStrategy,
): SQL {
  assertValidSearchParams(params);

  const mode = resolveMode(params.mode);
  const table = quotedTableName(tableName);
  const matchCondition = strategy.matchCondition(
    tableName,
    params.query,
    mode,
    params.language,
  );
  const rankExpression = strategy.rankExpression(
    tableName,
    params.query,
    mode,
    params.language,
  );

  const conditions: SQL[] = [
    matchCondition,
    sql`"graph_id" = ${params.graphId}`,
    sql`"node_kind" = ${params.nodeKind}`,
  ];
  if (params.minScore !== undefined) {
    conditions.push(sql`${rankExpression} >= ${params.minScore}`);
  }

  const snippetExpr =
    params.includeSnippets === true && strategy.supportsSnippets
      ? strategy.snippetExpression(
          tableName,
          params.query,
          mode,
          params.language,
        )
      : sql`NULL`;

  return sql`
    SELECT
      "node_id" AS node_id,
      ${rankExpression} AS score,
      ${snippetExpr} AS snippet
    FROM ${table}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY ${rankExpression} DESC, "node_id" ASC
    LIMIT ${params.limit}
  `;
}

function assertValidSearchParams(params: FulltextSearchParams): void {
  if (!Number.isInteger(params.limit) || params.limit <= 0) {
    throw new Error(`limit must be a positive integer, got: ${params.limit}`);
  }
  if (params.minScore !== undefined && !Number.isFinite(params.minScore)) {
    throw new TypeError(
      `minScore must be a finite number, got: ${params.minScore}`,
    );
  }
}
