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

  it("rejects suffix clauses when plan has no sort or limit_offset nodes", () => {
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
      start: { alias: "p", includeSubClasses: false, kinds: ["Person"] },
      temporalMode: { mode: "current" as const },
      traversals: [],
    };

    const plan = lowerSetOperationToLogicalPlan({
      dialect: "sqlite",
      graphId: "graph_set_op_no_suffix",
      op: {
        __type: "set_operation",
        left: leaf,
        operator: "union",
        right: leaf,
      },
    });

    expect(() =>
      emitSetOperationQuerySql({
        baseQuery: sql`SELECT 1 UNION SELECT 2`,
        logicalPlan: plan,
        suffixClauses: [sql`LIMIT 5`],
      }),
    ).toThrow(
      "received suffix clauses for a plan without top-level sort or limit_offset",
    );
  });

  it("rejects missing suffix clauses when plan has limit_offset node", () => {
    const plan = createSetOperationPlan();

    expect(() =>
      emitSetOperationQuerySql({
        baseQuery: sql`SELECT 1 UNION SELECT 2`,
        logicalPlan: plan,
      }),
    ).toThrow(
      "expected suffix clauses for plan containing top-level sort or limit_offset",
    );
  });

  it("rejects mismatched suffix clause count", () => {
    const plan = createSetOperationPlan();

    expect(() =>
      emitSetOperationQuerySql({
        baseQuery: sql`SELECT 1 UNION SELECT 2`,
        logicalPlan: plan,
        suffixClauses: [sql`LIMIT 5`, sql`ORDER BY 1`],
      }),
    ).toThrow("expected 1 top-level suffix clause(s) from logical plan, got 2");
  });

  it("assembles set-operation query without CTEs", () => {
    const plan = createSetOperationPlan();
    const result = emitSetOperationQuerySql({
      baseQuery: sql`SELECT 1 UNION SELECT 2`,
      logicalPlan: plan,
      suffixClauses: [sql`LIMIT 5`],
    });

    const sqlText = toSqlString(result);
    expect(sqlText).not.toContain("WITH ");
    expect(sqlText).toContain("SELECT 1 UNION SELECT 2");
    expect(sqlText).toContain("LIMIT 5");
  });

  it("assembles minimal set-operation query without suffix or CTEs", () => {
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
      start: { alias: "p", includeSubClasses: false, kinds: ["Person"] },
      temporalMode: { mode: "current" as const },
      traversals: [],
    };

    const plan = lowerSetOperationToLogicalPlan({
      dialect: "sqlite",
      graphId: "graph_set_op_minimal",
      op: {
        __type: "set_operation",
        left: leaf,
        operator: "intersect",
        right: leaf,
      },
    });

    const result = emitSetOperationQuerySql({
      baseQuery: sql`SELECT id FROM a INTERSECT SELECT id FROM b`,
      logicalPlan: plan,
    });

    const sqlText = toSqlString(result);
    expect(sqlText).not.toContain("WITH ");
    expect(sqlText).not.toContain("LIMIT");
    expect(sqlText).toContain("INTERSECT");
  });

  it("assembles set-operation query with multiple CTEs", () => {
    const plan = createSetOperationPlan();
    const result = emitSetOperationQuerySql({
      baseQuery: sql`SELECT id FROM cte_a UNION SELECT id FROM cte_b`,
      ctes: [
        sql.raw("cte_a AS (SELECT 'a1' AS id)"),
        sql.raw("cte_b AS (SELECT 'b1' AS id)"),
      ],
      logicalPlan: plan,
      suffixClauses: [sql`LIMIT 5`],
    });

    const sqlText = toSqlString(result);
    expect(sqlText).toContain("WITH cte_a AS");
    expect(sqlText).toContain(", cte_b AS");
    expect(sqlText).toContain("UNION");
    expect(sqlText).toContain("LIMIT 5");
  });
});
