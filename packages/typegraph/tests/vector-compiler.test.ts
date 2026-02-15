import { describe, expect, it } from "vitest";

import { type QueryAst, type VectorMetricType } from "../src/query/ast";
import { compileQuery } from "../src/query/compiler";
import { jsonPointer } from "../src/query/json-pointer";
import { fieldRef } from "../src/query/predicates";
import { toSqlString } from "./sql-test-utils";

function buildVectorAst(metric: VectorMetricType, minScore: number): QueryAst {
  return {
    graphId: "graph_1",
    start: {
      alias: "d",
      kinds: ["Document"],
      includeSubClasses: false,
    },
    traversals: [],
    predicates: [
      {
        targetAlias: "d",
        expression: {
          __type: "vector_similarity",
          field: fieldRef("d", ["props", "embedding"], {
            jsonPointer: jsonPointer(["embedding"]),
            valueType: "embedding",
          }),
          queryEmbedding: [0.1, 0.2, 0.3],
          metric,
          limit: 10,
          minScore,
        },
      },
    ],
    projection: {
      fields: [
        {
          outputName: "id",
          source: fieldRef("d", ["id"], { valueType: "string" }),
        },
      ],
    },
    temporalMode: { mode: "current" },
  };
}

describe("vector compilation semantics", () => {
  it("uses cosine minScore as similarity threshold and emits cosine score", () => {
    const query = compileQuery(buildVectorAst("cosine", 0.75), "graph_1", {
      dialect: "postgres",
    });
    const sql = toSqlString(query);

    expect(sql).toContain("<= 0.25");
    expect(sql).toContain("1.0 -");
  });

  it("uses l2 minScore as a max-distance threshold and emits raw distance score", () => {
    const query = compileQuery(buildVectorAst("l2", 0.4), "graph_1", {
      dialect: "postgres",
    });
    const sql = toSqlString(query);

    expect(sql).toContain("<= 0.4");
    expect(sql).not.toContain("1.0 -");
  });

  it("uses inner_product minScore as minimum inner-product and emits raw distance score", () => {
    const query = compileQuery(
      buildVectorAst("inner_product", 0.6),
      "graph_1",
      {
        dialect: "postgres",
      },
    );
    const sql = toSqlString(query);

    expect(sql).toContain("<= -0.6");
    expect(sql).not.toContain("1.0 -");
  });

  it("rejects inner_product vector similarity for sqlite dialect", () => {
    expect(() =>
      compileQuery(buildVectorAst("inner_product", 0.6), "graph_1", {
        dialect: "sqlite",
      }),
    ).toThrow(/metric "inner_product" is not supported/i);
  });

  it("rejects vector predicates nested under OR", () => {
    const ast: QueryAst = {
      ...buildVectorAst("cosine", 0.2),
      predicates: [
        {
          targetAlias: "d",
          expression: {
            __type: "or",
            predicates: [
              {
                __type: "vector_similarity",
                field: fieldRef("d", ["props", "embedding"], {
                  jsonPointer: jsonPointer(["embedding"]),
                  valueType: "embedding",
                }),
                queryEmbedding: [0.1, 0.2, 0.3],
                metric: "cosine",
                limit: 10,
              },
              {
                __type: "comparison",
                op: "eq",
                left: fieldRef("d", ["props", "status"], {
                  jsonPointer: jsonPointer(["status"]),
                  valueType: "string",
                }),
                right: {
                  __type: "literal",
                  value: "active",
                  valueType: "string",
                },
              },
            ],
          },
        },
      ],
    };

    expect(() => compileQuery(ast, "graph_1", { dialect: "postgres" })).toThrow(
      /cannot be nested under OR or NOT/i,
    );
  });
});
