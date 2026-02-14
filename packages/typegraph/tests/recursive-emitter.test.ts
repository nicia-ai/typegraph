import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  type LogicalPlan,
  lowerRecursiveQueryToLogicalPlan,
} from "../src/query/compiler";
import { emitRecursiveQuerySql } from "../src/query/compiler/emitter";
import { toSqlString } from "./sql-test-utils";

function createRecursivePlan(): LogicalPlan {
  const ast = {
    limit: 5,
    orderBy: [
      {
        direction: "asc" as const,
        field: {
          __type: "field_ref" as const,
          alias: "f",
          path: ["id"] as const,
          valueType: "string" as const,
        },
      },
    ],
    predicates: [],
    projection: {
      fields: [
        {
          outputName: "friendId",
          source: {
            __type: "field_ref" as const,
            alias: "f",
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
    traversals: [
      {
        direction: "out" as const,
        edgeAlias: "e",
        edgeKinds: ["knows"] as const,
        joinEdgeField: "from_id" as const,
        joinFromAlias: "p",
        nodeAlias: "f",
        nodeKinds: ["Person"] as const,
        optional: false,
        variableLength: {
          cyclePolicy: "prevent" as const,
          maxDepth: 3,
          minDepth: 1,
        },
      },
    ],
  };

  return lowerRecursiveQueryToLogicalPlan({
    ast,
    dialect: "sqlite",
    graphId: "graph_recursive_emitter",
  });
}

describe("emitRecursiveQuerySql", () => {
  it("assembles recursive query from fragments", () => {
    const logicalPlan = createRecursivePlan();
    const result = emitRecursiveQuerySql({
      depthFilter: sql`WHERE depth >= 1`,
      limitOffset: sql`LIMIT 5`,
      logicalPlan,
      orderBy: sql`ORDER BY depth ASC`,
      projection: sql.raw(`f_id AS "friendId"`),
      recursiveCte: sql.raw(
        `recursive_cte AS (SELECT 'p-1' AS p_id, 'f-1' AS f_id, 1 AS depth)`,
      ),
    });

    const sqlText = toSqlString(result);
    expect(sqlText).toContain("WITH RECURSIVE");
    expect(sqlText).toContain("recursive_cte AS");
    expect(sqlText).toContain(`SELECT f_id AS "friendId"`);
    expect(sqlText).toContain("FROM recursive_cte");
    expect(sqlText).toContain("WHERE depth >= 1");
    expect(sqlText).toContain("ORDER BY depth ASC");
    expect(sqlText).toContain("LIMIT 5");
  });

  it("rejects plans whose root is not a project node", () => {
    const invalidPlan: LogicalPlan = {
      metadata: {
        dialect: "sqlite",
        graphId: "graph_invalid_recursive",
      },
      root: {
        alias: "p",
        graphId: "graph_invalid_recursive",
        id: "plan_invalid",
        kinds: ["Person"],
        op: "scan",
        source: "nodes",
      },
    };

    expect(() =>
      emitRecursiveQuerySql({
        depthFilter: sql`WHERE depth >= 1`,
        logicalPlan: invalidPlan,
        projection: sql.raw("f_id AS friend_id"),
        recursiveCte: sql.raw("recursive_cte AS (SELECT 1)"),
      }),
    ).toThrow('expected logical plan root to be "project"');
  });

  it("rejects ORDER BY clause when plan has no sort node", () => {
    const plan = lowerRecursiveQueryToLogicalPlan({
      ast: {
        predicates: [],
        projection: {
          fields: [
            {
              outputName: "friendId",
              source: {
                __type: "field_ref" as const,
                alias: "f",
                path: ["id"] as const,
              },
            },
          ],
        },
        start: { alias: "p", includeSubClasses: false, kinds: ["Person"] },
        temporalMode: { mode: "current" as const },
        traversals: [
          {
            direction: "out" as const,
            edgeAlias: "e",
            edgeKinds: ["knows"] as const,
            joinEdgeField: "from_id" as const,
            joinFromAlias: "p",
            nodeAlias: "f",
            nodeKinds: ["Person"] as const,
            optional: false,
            variableLength: {
              cyclePolicy: "prevent" as const,
              maxDepth: 3,
              minDepth: 1,
            },
          },
        ],
      },
      dialect: "sqlite",
      graphId: "graph_recursive_no_sort",
    });

    expect(() =>
      emitRecursiveQuerySql({
        depthFilter: sql`WHERE depth >= 1`,
        logicalPlan: plan,
        orderBy: sql`ORDER BY depth ASC`,
        projection: sql.raw("f_id AS friend_id"),
        recursiveCte: sql.raw("recursive_cte AS (SELECT 1)"),
      }),
    ).toThrow("received ORDER BY clause for a plan without sort");
  });

  it("rejects LIMIT/OFFSET clause when plan has no limit_offset node", () => {
    const plan = lowerRecursiveQueryToLogicalPlan({
      ast: {
        predicates: [],
        projection: {
          fields: [
            {
              outputName: "friendId",
              source: {
                __type: "field_ref" as const,
                alias: "f",
                path: ["id"] as const,
              },
            },
          ],
        },
        start: { alias: "p", includeSubClasses: false, kinds: ["Person"] },
        temporalMode: { mode: "current" as const },
        traversals: [
          {
            direction: "out" as const,
            edgeAlias: "e",
            edgeKinds: ["knows"] as const,
            joinEdgeField: "from_id" as const,
            joinFromAlias: "p",
            nodeAlias: "f",
            nodeKinds: ["Person"] as const,
            optional: false,
            variableLength: {
              cyclePolicy: "prevent" as const,
              maxDepth: 3,
              minDepth: 1,
            },
          },
        ],
      },
      dialect: "sqlite",
      graphId: "graph_recursive_no_limit",
    });

    expect(() =>
      emitRecursiveQuerySql({
        depthFilter: sql`WHERE depth >= 1`,
        limitOffset: sql`LIMIT 5`,
        logicalPlan: plan,
        projection: sql.raw("f_id AS friend_id"),
        recursiveCte: sql.raw("recursive_cte AS (SELECT 1)"),
      }),
    ).toThrow("received LIMIT/OFFSET clause for a plan without limit_offset");
  });

  it("assembles minimal recursive query with only depth filter", () => {
    const plan = lowerRecursiveQueryToLogicalPlan({
      ast: {
        predicates: [],
        projection: {
          fields: [
            {
              outputName: "friendId",
              source: {
                __type: "field_ref" as const,
                alias: "f",
                path: ["id"] as const,
              },
            },
          ],
        },
        start: { alias: "p", includeSubClasses: false, kinds: ["Person"] },
        temporalMode: { mode: "current" as const },
        traversals: [
          {
            direction: "out" as const,
            edgeAlias: "e",
            edgeKinds: ["knows"] as const,
            joinEdgeField: "from_id" as const,
            joinFromAlias: "p",
            nodeAlias: "f",
            nodeKinds: ["Person"] as const,
            optional: false,
            variableLength: {
              cyclePolicy: "prevent" as const,
              maxDepth: 5,
              minDepth: 1,
            },
          },
        ],
      },
      dialect: "sqlite",
      graphId: "graph_recursive_minimal",
    });

    const result = emitRecursiveQuerySql({
      depthFilter: sql`WHERE depth >= 1`,
      logicalPlan: plan,
      projection: sql.raw(`f_id AS "friendId"`),
      recursiveCte: sql.raw(
        "recursive_cte AS (SELECT 'p-1' AS p_id, 'f-1' AS f_id, 1 AS depth)",
      ),
    });

    const sqlText = toSqlString(result);
    expect(sqlText).toContain("WITH RECURSIVE");
    expect(sqlText).toContain("WHERE depth >= 1");
    expect(sqlText).not.toContain("ORDER BY");
    expect(sqlText).not.toContain("LIMIT");
  });

  it("rejects missing ORDER BY when plan has a sort node", () => {
    const logicalPlan = createRecursivePlan();

    expect(() =>
      emitRecursiveQuerySql({
        depthFilter: sql`WHERE depth >= 1`,
        limitOffset: sql`LIMIT 5`,
        logicalPlan,
        projection: sql.raw("f_id AS friend_id"),
        recursiveCte: sql.raw("recursive_cte AS (SELECT 1)"),
      }),
    ).toThrow("expected ORDER BY clause for plan containing a sort");
  });

  it("rejects missing LIMIT/OFFSET when plan has a limit_offset node", () => {
    const logicalPlan = createRecursivePlan();

    expect(() =>
      emitRecursiveQuerySql({
        depthFilter: sql`WHERE depth >= 1`,
        logicalPlan,
        orderBy: sql`ORDER BY depth ASC`,
        projection: sql.raw("f_id AS friend_id"),
        recursiveCte: sql.raw("recursive_cte AS (SELECT 1)"),
      }),
    ).toThrow(
      "expected LIMIT/OFFSET clause for plan containing a limit_offset",
    );
  });
});
