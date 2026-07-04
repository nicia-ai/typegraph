/**
 * Planner-shape pins for facade search candidates:
 *
 * - The hybrid statement's fused CTE must be MATERIALIZED: Postgres
 *   inlines single-use CTEs, and the inlined fusion subtree re-executed
 *   once per candidate node row under a nested-loop join (277ms at 2000
 *   docs in the regression that motivated this).
 * - The backend's default candidates carry FULL current-read semantics
 *   (tombstones AND validity window) with the instant BOUND as a
 *   parameter — per-row SQL now() calls across two search legs dominated
 *   unfiltered facade searches.
 * - The store compiles builder-query candidates ONLY when a `where`
 *   predicate exists; unfiltered searches use the flat backend form.
 */
import { type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
} from "../src";
import { buildHybridSearchStatement } from "../src/backend/drizzle/operations/hybrid";
import { liveNodeIdsSubquery } from "../src/backend/drizzle/operations/shared";
import { tables } from "../src/backend/drizzle/schema/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";

const sqliteDialect = new SQLiteSyncDialect();
function sqlToText(query: SQL): string {
  return sqliteDialect.sqlToQuery(query).sql;
}

describe("search candidates planning shapes", () => {
  it("materializes the hybrid fused CTE", () => {
    const statement = buildHybridSearchStatement({
      vectorSql: liveNodeIdsSubquery(
        tables.nodes,
        "g",
        "Doc",
        "2026-01-01T00:00:00.000Z",
      ),
      vectorScoreDescending: true,
      fulltextSql: liveNodeIdsSubquery(
        tables.nodes,
        "g",
        "Doc",
        "2026-01-01T00:00:00.000Z",
      ),
      nodes: tables.nodes,
      graphId: "g",
      nodeKind: "Doc",
      fusionK: 60,
      vectorWeight: 1,
      fulltextWeight: 1,
      limit: 10,
      offset: 0,
    });
    expect(sqlToText(statement)).toContain("tg_hybrid_fused AS MATERIALIZED");
  });

  it("default candidates bind the currency instant as a parameter", () => {
    const subquery = liveNodeIdsSubquery(
      tables.nodes,
      "g",
      "Doc",
      "2026-01-01T00:00:00.000Z",
    );
    const text = sqlToText(subquery);
    expect(text).toContain("valid_from");
    expect(text).toContain("valid_to");
    // Bound parameter, never a per-row SQL clock call.
    expect(text).not.toMatch(/strftime|now\(\)/i);
  });

  it("compiles builder candidates only for filtered searches", async () => {
    const Document = defineNode("PlanDoc", {
      schema: z.object({
        title: searchable(),
        category: z.string(),
      }),
    });
    const graph = defineGraph({
      id: "cand_plan",
      nodes: { PlanDoc: { type: Document } },
      edges: {},
    });
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      await store.nodes.PlanDoc.create({ title: "signal", category: "a" });

      const fulltextSpy = vi.spyOn(
        backend as {
          fulltextSearch: NonNullable<GraphBackend["fulltextSearch"]>;
        },
        "fulltextSearch",
      );
      await store.search.fulltext("PlanDoc", { query: "signal", limit: 5 });
      expect(fulltextSpy.mock.calls[0]![0].candidates).toBeUndefined();

      fulltextSpy.mockClear();
      await store.search.fulltext("PlanDoc", {
        query: "signal",
        limit: 5,
        where: (document) => document.category.eq("a"),
      });
      expect(fulltextSpy.mock.calls[0]![0].candidates).toBeDefined();
    } finally {
      await backend.close();
    }
  });
});
