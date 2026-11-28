/**
 * The plan an IVFFlat search under `ivfflat.iterative_scan = relaxed_order`
 * must keep, shared by the PGlite and server PostgreSQL suites: the IVFFlat
 * index scan inside the materialized wrapper, and a full Sort directly above
 * the wrapper's CTE Scan that re-sorts the relaxed candidates.
 *
 * PostgreSQL 17 and later carry a materialized CTE's sort order to the outer
 * query, so an outer ORDER BY on the keys the relaxed scan claims to be
 * sorted by would be planned without that Sort.
 */
import { expect } from "vitest";

import { type VectorSearchParams } from "../../../src/backend/types";
import {
  pgvectorIndexName,
  pgvectorStrategy,
} from "../../../src/query/dialect/vector/pgvector-strategy";
import { type VectorSlot } from "../../../src/query/dialect/vector-strategy";
import { renderPostgres, sql } from "../../../src/query/sql-fragment";

/** One session: every statement runs on the same connection. */
export type PlanSession = Readonly<{
  query: (
    text: string,
    params?: readonly unknown[],
  ) => Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

const RESORT_ABOVE_CTE_SCAN =
  /\n\s*->\s+Sort\n\s+Sort Key: \(\(?tg_vec_index_candidates\.distance \+ '?0'?(?:::double precision)?\)?\)?, tg_vec_index_candidates\.node_id COLLATE "C"\n\s+->\s+CTE Scan on tg_vec_index_candidates/;

/**
 * The plan's text from the materialized wrapper on: the relaxed scan the
 * wrapper's CTE runs. A generic `Index Scan` would also match the embedding
 * table's primary-key scan.
 */
function relaxedCtePlan(planText: string): string {
  const start = planText.indexOf("CTE tg_vec_index_candidates");
  return start === -1 ? "" : planText.slice(start);
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * EXPLAINs the IVFFlat search of `slot` (seeded and indexed by the caller)
 * with and without a candidate set and an offset, with the planner held to
 * the index scan, and asserts each plan keeps the re-sort.
 */
export async function expectIvfflatPlansResort(
  session: PlanSession,
  slot: VectorSlot,
  params: (overrides: Partial<VectorSearchParams>) => VectorSearchParams,
): Promise<void> {
  const table = pgvectorStrategy.tableName(
    slot.graphId,
    slot.nodeKind,
    slot.fieldPath,
  );
  // Statistics and no sequential or bitmap scan, so the planner takes the
  // IVFFlat index scan whose relaxed order the wrapper must correct.
  await session.query(`ANALYZE "${table}"`);
  await session.query("SET enable_seqscan = off");
  await session.query("SET enable_bitmapscan = off");
  await session.query("SET ivfflat.iterative_scan = relaxed_order");
  try {
    for (const candidates of [
      undefined,
      sql`SELECT node_id FROM ${sql.identifier(table)}`,
    ]) {
      for (const offset of [undefined, 2]) {
        const compiled = renderPostgres(
          pgvectorStrategy.buildSearch(
            slot,
            params({
              limit: 5,
              indexType: "ivfflat",
              ...(offset === undefined ? {} : { offset }),
            }),
            candidates,
          ),
        );
        const plan = await session.query(
          `EXPLAIN (COSTS OFF) ${compiled.sql}`,
          [...compiled.params],
        );
        const planText = plan.rows
          .map((row) => {
            const line = row["QUERY PLAN"];
            return typeof line === "string" ? line : "";
          })
          .join("\n");
        // The relaxed scan is the IVFFlat index itself, by name, inside the
        // materialized wrapper: a fallback to a B-tree scan and a full sort
        // would also show an `Index Scan`.
        expect(relaxedCtePlan(planText)).toMatch(
          new RegExp(
            String.raw`Index Scan using ${escapeRegExp(pgvectorIndexName(slot))} on ${escapeRegExp(table)}\b`,
          ),
        );
        expect(planText).toMatch(RESORT_ABOVE_CTE_SCAN);
      }
    }
  } finally {
    await session.query("RESET enable_seqscan");
    await session.query("RESET enable_bitmapscan");
    await session.query("RESET ivfflat.iterative_scan");
  }
}
