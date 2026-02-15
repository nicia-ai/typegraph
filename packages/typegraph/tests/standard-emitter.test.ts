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
});
