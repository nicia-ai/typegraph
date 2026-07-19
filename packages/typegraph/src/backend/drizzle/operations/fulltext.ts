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
import { isSqlFragment, type SqlFragment } from "../../../query/sql-fragment";
import type {
  FulltextQueryMode,
  FulltextSearchParams,
  SqlDialect,
} from "../../types";
import { toDrizzleSql } from "../execution/types";
import { codePointOrderKey, quotedTableName } from "./shared";

function resolveMode(mode: FulltextQueryMode | undefined): FulltextQueryMode {
  return mode ?? "websearch";
}

export function buildFulltextSearch(
  tableName: string,
  params: FulltextSearchParams,
  strategy: FulltextStrategy,
  dialect: SqlDialect,
  candidates?: SQL | SqlFragment,
): SQL {
  assertValidSearchParams(params);

  const mode = resolveMode(params.mode);
  const table = quotedTableName(tableName);
  const matchCondition = toDrizzleSql(
    strategy.matchCondition(tableName, params.query, mode, params.language),
    dialect,
  );
  const rankExpression = toDrizzleSql(
    strategy.rankExpression(tableName, params.query, mode, params.language),
    dialect,
  );

  const conditions: SQL[] = [
    matchCondition,
    sql`"graph_id" = ${params.graphId}`,
    sql`"node_kind" = ${params.nodeKind}`,
  ];
  if (params.minScore !== undefined) {
    conditions.push(sql`${rankExpression} >= ${params.minScore}`);
  }
  // Liveness pushdown: rank only rows whose node is current, so top-k can
  // never be crowded out by index drift (side-table rows for tombstoned or
  // expired nodes). Plain `IN (subquery)` on both engines: SQLite
  // materializes it once, and with fresh planner statistics Postgres
  // hashes it for ~0.5ms over the unfiltered scan. Like every candidate
  // membership shape (hash join, ANY(ARRAY), LATERAL all measured worse
  // or no better), it cliffs when statistics are stale — the answer is
  // `store.refreshStatistics()` after bulk loads (the documented setup),
  // not a cleverer SQL form.
  if (candidates !== undefined) {
    const candidateSql =
      isSqlFragment(candidates) ? toDrizzleSql(candidates, dialect) : candidates;
    conditions.push(sql`"node_id" IN (${candidateSql})`);
  }

  const snippetExpr =
    params.includeSnippets === true && strategy.supportsSnippets ?
      toDrizzleSql(
        strategy.snippetExpression(
          tableName,
          params.query,
          mode,
          params.language,
        ),
        dialect,
      )
    : sql`NULL`;

  const pageClause =
    params.offset === undefined || params.offset === 0 ?
      sql`LIMIT ${params.limit}`
    : sql`LIMIT ${params.limit} OFFSET ${params.offset}`;
  return sql`
    SELECT
      "node_id" AS node_id,
      ${rankExpression} AS score,
      ${snippetExpr} AS snippet
    FROM ${table}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY ${rankExpression} DESC, ${codePointOrderKey(sql.raw('"node_id"'), dialect)} ASC
    ${pageClause}
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
