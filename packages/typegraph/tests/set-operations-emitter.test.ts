import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  type LogicalPlan,
  lowerSetOperationToLogicalPlan,
  lowerStandardQueryToLogicalPlan,
} from "../src/query/compiler";
import { emitSetOperationQuerySql } from "../src/query/compiler/emitter";
import { toSqlString } from "./sql-test-utils";

function createSetOperationPlan(): LogicalPlan {
  const leaf = {
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

  return lowerSetOperationToLogicalPlan({
    dialect: "sqlite",
    graphId: "graph_set_op_emitter",
    op: {
      __type: "set_operation",
      left: leaf,
      limit: 5,
      operator: "union",
      right: leaf,
    },
  });
}

describe("emitSetOperationQuerySql", () => {
  it("assembles set-operation query fragments", () => {
    const logicalPlan = createSetOperationPlan();
    const result = emitSetOperationQuerySql({
      baseQuery: sql`SELECT 1 UNION SELECT 2`,
      ctes: [sql.raw("c0 AS (SELECT 1)")],
      logicalPlan,
      suffixClauses: [sql`LIMIT 5`],
    });

    const sqlText = toSqlString(result);
    expect(sqlText).toContain("WITH c0 AS (SELECT 1)");
    expect(sqlText).toContain("SELECT 1 UNION SELECT 2");
    expect(sqlText).toContain("LIMIT 5");
  });

  it('rejects plans without a "set_op" node', () => {
    const simplePlan = lowerStandardQueryToLogicalPlan({
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
        start: {
          alias: "p",
          includeSubClasses: false,
          kinds: ["Person"],
        },
        temporalMode: { mode: "current" as const },
        traversals: [],
      },
      dialect: "sqlite",
      graphId: "graph_simple",
    });

    expect(() =>
      emitSetOperationQuerySql({
        baseQuery: sql`SELECT 1`,
        logicalPlan: simplePlan,
      }),
    ).toThrow('expected logical plan to contain a "set_op" node');
  });
});
