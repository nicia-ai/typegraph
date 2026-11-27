/**
 * The plan a filtered HNSW search must keep, shared by the PGlite and server
 * PostgreSQL suites: the HNSW index scan, by name, inside the materialized
 * candidate read, whatever the planner may cost a tiebreak at.
 *
 * A second ORDER BY key on the index-driven read (the node id that breaks a
 * distance tie) is only satisfied by an incremental sort above the ordered
 * index scan. Where the planner prices that above a sequential scan and a
 * full sort, or cannot use one, it scores every row instead: 10,000 vectors,
 * a filter admitting 5,000, `k = 1`, and incremental sort disabled leave a
 * sequential scan behind such a read.
 */
import { expect } from "vitest";

import { type VectorSearchParams } from "../../../src/backend/types";
import {
  INDEX_CANDIDATES_CTE,
  pgvectorIndexName,
  pgvectorStrategy,
} from "../../../src/query/dialect/vector/pgvector-strategy";
import { type VectorSlot } from "../../../src/query/dialect/vector-strategy";
import { renderPostgres, sql } from "../../../src/query/sql-fragment";
import { requireDefined } from "../../../src/utils/presence";
import { type PlanSession } from "./ivfflat-resort-plan";

const VECTOR_COUNT = 10_000;

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Seeds `slot`'s table (created by the caller, empty) with 10,000 vectors,
 * builds its HNSW index, and EXPLAINs a `k = 1` search whose candidates are
 * half the rows, under the default planner settings and with incremental
 * sort disabled, asserting each plan reads the HNSW index.
 */
export async function expectFilteredHnswPlansUseIndex(
  session: PlanSession,
  slot: VectorSlot,
  params: (overrides: Partial<VectorSearchParams>) => VectorSearchParams,
): Promise<void> {
  const table = pgvectorStrategy.tableName(
    slot.graphId,
    slot.nodeKind,
    slot.fieldPath,
  );
  await session.query(
    `INSERT INTO "${table}" (graph_id, node_id, embedding, created_at, updated_at)
     SELECT $1, 'n' || lpad(i::text, 5, '0'),
       ('[' || array_to_string(ARRAY(SELECT sin(i * 7.3 + j * 1.9) FROM generate_series(1, ${slot.dimensions}) j), ',') || ']')::vector,
       now(), now()
     FROM generate_series(1, ${VECTOR_COUNT}) i`,
    [slot.graphId],
  );
  const index = renderPostgres(
    requireDefined(pgvectorStrategy.buildCreateIndex?.(slot)),
  );
  await session.query(index.sql, [...index.params]);
  await session.query(`ANALYZE "${table}"`);
  const candidates = sql`SELECT node_id FROM ${sql.identifier(table)} WHERE right(node_id, 1) IN ('0', '2', '4', '6', '8')`;
  const compiled = renderPostgres(
    pgvectorStrategy.buildSearch(
      slot,
      params({
        limit: 1,
        indexType: "hnsw",
        queryEmbedding: Array.from(
          { length: slot.dimensions },
          (_unused, index_) => Math.cos(index_ * 0.7),
        ),
      }),
      candidates,
    ),
  );
  const indexScan = new RegExp(
    String.raw`Index Scan using ${escapeRegExp(pgvectorIndexName(slot))} on ${escapeRegExp(table)}\b`,
  );
  for (const setting of [undefined, "enable_incremental_sort"]) {
    if (setting !== undefined) await session.query(`SET ${setting} = off`);
    try {
      const plan = await session.query(`EXPLAIN (COSTS OFF) ${compiled.sql}`, [
        ...compiled.params,
      ]);
      const planText = plan.rows
        .map((row) => {
          const line = row["QUERY PLAN"];
          return typeof line === "string" ? line : "";
        })
        .join("\n");
      const candidateRead = planText.slice(
        Math.max(0, planText.indexOf(`CTE ${INDEX_CANDIDATES_CTE}`)),
      );
      expect({ setting, indexScan: indexScan.test(candidateRead) }).toEqual({
        setting,
        indexScan: true,
      });
    } finally {
      if (setting !== undefined) await session.query(`RESET ${setting}`);
    }
  }
}
