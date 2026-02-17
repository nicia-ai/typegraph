import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  type LogicalPlan,
  lowerStandardQueryToLogicalPlan,
} from "../src/query/compiler";
import { emitStandardQuerySql } from "../src/query/compiler/emitter";
import { toSqlString } from "./sql-test-utils";

function createBasePlan(): LogicalPlan {
  const ast = {
    limit: 10,
    orderBy: [
      {
        direction: "asc" as const,
        field: {
          __type: "field_ref" as const,
          alias: "p",
          path: ["id"] as const,
          valueType: "string" as const,
        },
      },
    ],
    predicates: [],
    projection: {
      fields: [
        {
          outputName: "id",
          source: {
            __type: "field_ref" as const,
            alias: "p",
            path: ["id"] as const,
          },
        },
      ],
    },
    start: {
      alias: "p",
      includeSubClasses: false,
      kinds: ["Person"],
    },
    temporalMode: { mode: "current" as const },
    traversals: [],
  };

  return lowerStandardQueryToLogicalPlan({
    ast,
    dialect: "sqlite",
    effectiveLimit: 10,
    graphId: "graph_emitter",
  });
}

describe("emitStandardQuerySql", () => {
  it("assembles SELECT query from standard fragments", () => {
    const logicalPlan = createBasePlan();

    const projection = sql.raw(`cte_p.p_id AS "id"`);
    const result = emitStandardQuerySql({
      ctes: [sql.raw(`cte_p AS (SELECT 'p-1' AS p_id)`)],
      fromClause: sql`FROM cte_p`,
      limitOffset: sql`LIMIT 10`,
      logicalPlan,
      orderBy: sql`ORDER BY cte_p.p_id ASC`,
      projection,
    });

    const sqlText = toSqlString(result);
    expect(sqlText).toContain("WITH cte_p AS (SELECT 'p-1' AS p_id)");
    expect(sqlText).toContain(`SELECT cte_p.p_id AS "id"`);
    expect(sqlText).toContain("FROM cte_p");
    expect(sqlText).toContain("ORDER BY cte_p.p_id ASC");
    expect(sqlText).toContain("LIMIT 10");
  });

  it("rejects plans whose root is not a project node", () => {
    const invalidPlan: LogicalPlan = {
      metadata: {
        dialect: "sqlite",
        graphId: "graph_invalid",
      },
      root: {
        alias: "p",
        graphId: "graph_invalid",
        id: "plan_invalid",
        kinds: ["Person"],
        op: "scan",
        source: "nodes",
      },
    };

    expect(() =>
      emitStandardQuerySql({
        ctes: [],
        fromClause: sql`FROM cte_p`,
        logicalPlan: invalidPlan,
        projection: sql.raw("cte_p.p_id AS id"),
      }),
    ).toThrow('expected logical plan root to be "project"');
  });

  it("rejects ORDER BY clause when plan has no sort node", () => {
    const plan = lowerStandardQueryToLogicalPlan({
      ast: {
        predicates: [],
        projection: {
          fields: [
            {
              outputName: "id",
              source: {
                __type: "field_ref" as const,
                alias: "p",
                path: ["id"] as const,
              },
            },
          ],
        },
        start: { alias: "p", includeSubClasses: false, kinds: ["Person"] },
        temporalMode: { mode: "current" as const },
        traversals: [],
      },
      dialect: "sqlite",
      graphId: "graph_no_sort",
    });

    expect(() =>
      emitStandardQuerySql({
        ctes: [],
        fromClause: sql`FROM cte_p`,
        logicalPlan: plan,
        orderBy: sql`ORDER BY cte_p.p_id ASC`,
        projection: sql.raw("cte_p.p_id AS id"),
      }),
    ).toThrow("received ORDER BY clause for a plan without sort");
  });

  it("rejects LIMIT/OFFSET clause when plan has no limit_offset node", () => {
    const plan = lowerStandardQueryToLogicalPlan({
      ast: {
        predicates: [],
        projection: {
          fields: [
            {
              outputName: "id",
              source: {
                __type: "field_ref" as const,
                alias: "p",
                path: ["id"] as const,
              },
            },
          ],
        },
        start: { alias: "p", includeSubClasses: false, kinds: ["Person"] },
        temporalMode: { mode: "current" as const },
        traversals: [],
      },
      dialect: "sqlite",
      graphId: "graph_no_limit",
    });

    expect(() =>
      emitStandardQuerySql({
        ctes: [],
        fromClause: sql`FROM cte_p`,
        limitOffset: sql`LIMIT 10`,
        logicalPlan: plan,
        projection: sql.raw("cte_p.p_id AS id"),
      }),
    ).toThrow("received LIMIT/OFFSET clause for a plan without limit_offset");
  });

  it("rejects missing ORDER BY when plan has a sort node", () => {
    const plan = createBasePlan();

    expect(() =>
      emitStandardQuerySql({
        ctes: [],
        fromClause: sql`FROM cte_p`,
        limitOffset: sql`LIMIT 10`,
        logicalPlan: plan,
        projection: sql.raw("cte_p.p_id AS id"),
      }),
    ).toThrow("expected ORDER BY clause for plan containing a sort");
  });

  it("rejects missing LIMIT/OFFSET when plan has a limit_offset node", () => {
    const plan = createBasePlan();

    expect(() =>
      emitStandardQuerySql({
        ctes: [],
        fromClause: sql`FROM cte_p`,
        logicalPlan: plan,
        orderBy: sql`ORDER BY cte_p.p_id ASC`,
        projection: sql.raw("cte_p.p_id AS id"),
      }),
    ).toThrow(
      "expected LIMIT/OFFSET clause for plan containing a limit_offset",
    );
  });

  it("assembles query with no CTEs", () => {
    const plan = lowerStandardQueryToLogicalPlan({
      ast: {
        predicates: [],
        projection: {
          fields: [
            {
              outputName: "id",
              source: {
                __type: "field_ref" as const,
                alias: "p",
                path: ["id"] as const,
              },
            },
          ],
        },
        start: { alias: "p", includeSubClasses: false, kinds: ["Person"] },
        temporalMode: { mode: "current" as const },
        traversals: [],
      },
      dialect: "sqlite",
      graphId: "graph_no_cte",
    });

    const result = emitStandardQuerySql({
      ctes: [],
      fromClause: sql`FROM nodes`,
      logicalPlan: plan,
      projection: sql.raw("id"),
    });

    const sqlText = toSqlString(result);
    expect(sqlText).not.toContain("WITH ");
    expect(sqlText).toContain("SELECT id");
    expect(sqlText).toContain("FROM nodes");
  });

  it("assembles query with multiple CTEs", () => {
    const logicalPlan = createBasePlan();

    const result = emitStandardQuerySql({
      ctes: [
        sql.raw("cte_p AS (SELECT 'p-1' AS p_id)"),
        sql.raw("cte_f AS (SELECT 'f-1' AS f_id, 'p-1' AS p_id)"),
      ],
      fromClause: sql`FROM cte_f`,
      limitOffset: sql`LIMIT 10`,
      logicalPlan,
      orderBy: sql`ORDER BY cte_f.f_id ASC`,
      projection: sql.raw("cte_f.f_id AS id"),
    });

    const sqlText = toSqlString(result);
    expect(sqlText).toContain("WITH cte_p AS");
    expect(sqlText).toContain(", cte_f AS");
    expect(sqlText).toContain("SELECT cte_f.f_id AS id");
  });

  it("assembles query with GROUP BY and HAVING on aggregate plan", () => {
    const plan = lowerStandardQueryToLogicalPlan({
      ast: {
        groupBy: {
          fields: [
            {
              __type: "field_ref" as const,
              alias: "p",
              path: ["props", "name"] as const,
              valueType: "string" as const,
            },
          ],
        },
        having: {
          __type: "aggregate_comparison",
          aggregate: {
            __type: "aggregate",
            field: {
              __type: "field_ref" as const,
              alias: "p",
              path: ["id"] as const,
              valueType: "string" as const,
            },
            function: "count",
          },
          op: "gt",
          value: { __type: "literal", value: 1, valueType: "number" },
        },
        predicates: [],
        projection: {
          fields: [
            {
              outputName: "name",
              source: {
                __type: "field_ref" as const,
                alias: "p",
                path: ["props", "name"] as const,
                valueType: "string" as const,
              },
            },
            {
              outputName: "cnt",
              source: {
                __type: "aggregate" as const,
                field: {
                  __type: "field_ref" as const,
                  alias: "p",
                  path: ["id"] as const,
                  valueType: "string" as const,
                },
                function: "count" as const,
              },
            },
          ],
        },
        start: { alias: "p", includeSubClasses: false, kinds: ["Person"] },
        temporalMode: { mode: "current" as const },
        traversals: [],
      },
      dialect: "sqlite",
      graphId: "graph_agg",
    });

    const result = emitStandardQuerySql({
      ctes: [sql.raw("cte_p AS (SELECT 'p-1' AS p_id, 'Alice' AS p_name)")],
      fromClause: sql`FROM cte_p`,
      groupBy: sql`GROUP BY cte_p.p_name`,
      having: sql`HAVING COUNT(cte_p.p_id) > 1`,
      logicalPlan: plan,
      projection: sql.raw("cte_p.p_name AS name, COUNT(cte_p.p_id) AS cnt"),
    });

    const sqlText = toSqlString(result);
    expect(sqlText).toContain("GROUP BY cte_p.p_name");
    expect(sqlText).toContain("HAVING COUNT(cte_p.p_id) > 1");
  });

  it("rejects GROUP BY clause when plan has no aggregate node", () => {
    const plan = lowerStandardQueryToLogicalPlan({
      ast: {
        predicates: [],
        projection: {
          fields: [
            {
              outputName: "id",
              source: {
                __type: "field_ref" as const,
                alias: "p",
                path: ["id"] as const,
              },
            },
          ],
        },
        start: { alias: "p", includeSubClasses: false, kinds: ["Person"] },
        temporalMode: { mode: "current" as const },
        traversals: [],
      },
      dialect: "sqlite",
      graphId: "graph_no_agg",
    });

    expect(() =>
      emitStandardQuerySql({
        ctes: [],
        fromClause: sql`FROM cte_p`,
        groupBy: sql`GROUP BY cte_p.p_name`,
        logicalPlan: plan,
        projection: sql.raw("cte_p.p_name AS name"),
      }),
    ).toThrow("GROUP BY clause for a plan without aggregate");
  });

  it("rejects HAVING clause when plan has no aggregate node", () => {
    const plan = lowerStandardQueryToLogicalPlan({
      ast: {
        predicates: [],
        projection: {
          fields: [
            {
              outputName: "id",
              source: {
                __type: "field_ref" as const,
                alias: "p",
                path: ["id"] as const,
              },
            },
          ],
        },
        start: { alias: "p", includeSubClasses: false, kinds: ["Person"] },
        temporalMode: { mode: "current" as const },
        traversals: [],
      },
      dialect: "sqlite",
      graphId: "graph_no_agg_having",
    });

    expect(() =>
      emitStandardQuerySql({
        ctes: [],
        fromClause: sql`FROM cte_p`,
        having: sql`HAVING COUNT(*) > 1`,
        logicalPlan: plan,
        projection: sql.raw("cte_p.p_id AS id"),
      }),
    ).toThrow("HAVING clause for a plan without aggregate");
  });
});
