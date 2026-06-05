import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { ConfigurationError } from "../src/errors";
import { type QueryAst, type VectorMetricType } from "../src/query/ast";
import { compileQuery, type CompileQueryOptions } from "../src/query/compiler";
import {
  vectorSlotKey,
  type VectorSlotMap,
} from "../src/query/compiler/schema";
import { pgvectorStrategy } from "../src/query/dialect/vector/pgvector-strategy";
import { type VectorStrategy } from "../src/query/dialect/vector-strategy";
import { jsonPointer } from "../src/query/json-pointer";
import { fieldRef } from "../src/query/predicates";
import { toSqlString } from "./sql-test-utils";

// The compiler resolves the per-field table for `(Document, embedding)`
// from the active strategy + declared slot map. Tests that compile a
// vector predicate pass both, mirroring what the store wires up. The slot
// map is keyed by `vectorSlotKey(kind, fieldPath)` (NUL-separated) — the
// same construction the store uses, so the compiler's per-kind branch
// resolution matches production rather than passing vacuously.
const VECTOR_SLOTS: VectorSlotMap = new Map([
  [
    vectorSlotKey("Document", "embedding"),
    { dimensions: 3, metric: "cosine", indexType: "hnsw" },
  ],
]);

function pgVectorOptions(): CompileQueryOptions {
  return {
    dialect: "postgres",
    vectorStrategy: pgvectorStrategy,
    vectorSlots: VECTOR_SLOTS,
  };
}

function buildVectorAst(
  metric: VectorMetricType | undefined,
  minScore: number,
): QueryAst {
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
          // Omit metric entirely when undefined (caller didn't specify one).
          ...(metric === undefined ? {} : { metric }),
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
  it("scans the strategy's per-(kind, field) table, not a shared embeddings table", () => {
    const sql = toSqlString(
      compileQuery(
        buildVectorAst("cosine", 0.75),
        "graph_1",
        pgVectorOptions(),
      ),
    );

    // The clean-cut decision dropped the shared `typegraph_node_embeddings`
    // table; the `similarTo()` CTE now scans the strategy's per-field table.
    expect(sql).toContain("tg_vec_graph_1_document_embedding");
    expect(sql).not.toContain("typegraph_node_embeddings");
    // The single declaring kind needs no UNION, but the kind is carried as a
    // `'Document' AS node_kind` literal so the output contract is identical
    // to the multi-kind (includeSubClasses) UNION-ALL case.
    expect(sql).toContain("AS node_kind");
    // The empty-body fallback (WHERE 1 = 0) only fires when no kind in the
    // alias declares the field — the slot map prevents that here.
    expect(sql).not.toContain("WHERE 1 = 0");
  });

  it("preserves the cte_embeddings output contract (node_id, node_kind, distance, score, ord)", () => {
    const sql = toSqlString(
      compileQuery(buildVectorAst("cosine", 0.5), "graph_1", pgVectorOptions()),
    );

    // These five columns are the byte-stable contract the hybrid RRF and the
    // rest of the emitter depend on; the per-field UNION-ALL rewrite must not
    // change them.
    expect(sql).toMatch(/cte_embeddings AS \(/);
    expect(sql).toContain("AS node_id");
    expect(sql).toContain("AS node_kind");
    expect(sql).toContain("AS distance");
    expect(sql).toContain("AS score");
    expect(sql).toMatch(/ROW_NUMBER\(\) OVER \(ORDER BY distance ASC\) AS ord/);
    // The inner k-cutoff bounds the ranked set to the predicate's limit.
    expect(sql).toMatch(/ORDER BY distance ASC\s+LIMIT 10/);
  });

  it("rejects vector relevance ranking when window functions are unavailable", () => {
    let caught: unknown;
    try {
      compileQuery(buildVectorAst("cosine", 0.5), "graph_1", {
        ...pgVectorOptions(),
        windowFunctions: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(caught).toMatchObject({
      details: {
        capability: "windowFunctions",
        operation: "vector relevance ranking",
        windowFunctions: false,
      },
    });
  });

  it("unions per-(kind, field) tables across kinds the alias resolves to (includeSubClasses)", () => {
    const childSlots: VectorSlotMap = new Map([
      [
        vectorSlotKey("Document", "embedding"),
        { dimensions: 3, metric: "cosine", indexType: "hnsw" },
      ],
      [
        vectorSlotKey("Memo", "embedding"),
        { dimensions: 3, metric: "cosine", indexType: "hnsw" },
      ],
    ]);
    const ast: QueryAst = {
      ...buildVectorAst("cosine", 0.5),
      start: {
        alias: "d",
        kinds: ["Document", "Memo"],
        includeSubClasses: true,
      },
    };

    const sql = toSqlString(
      compileQuery(ast, "graph_1", {
        dialect: "postgres",
        vectorStrategy: pgvectorStrategy,
        vectorSlots: childSlots,
      }),
    );

    // One per-field table per declaring kind, fused by UNION ALL — only the
    // includeSubClasses path yields more than one branch.
    expect(sql).toContain("tg_vec_graph_1_document_embedding");
    expect(sql).toContain("tg_vec_graph_1_memo_embedding");
    expect(sql).toMatch(/UNION ALL/);
  });

  it("uses cosine minScore as similarity threshold and emits cosine score", () => {
    const query = compileQuery(
      buildVectorAst("cosine", 0.75),
      "graph_1",
      pgVectorOptions(),
    );
    const sql = toSqlString(query);

    // cosine minScore 0.75 → max distance threshold 1 - 0.75 = 0.25.
    expect(sql).toContain("<= 0.25");
    // cosine score is similarity = 1 - distance (shared score helper).
    expect(sql).toContain("1 - (");
  });

  it("uses l2 minScore as a max-distance threshold and emits raw distance score", () => {
    const query = compileQuery(
      buildVectorAst("l2", 0.4),
      "graph_1",
      pgVectorOptions(),
    );
    const sql = toSqlString(query);

    expect(sql).toContain("<= 0.4");
    expect(sql).not.toContain("1 - (");
  });

  it("uses inner_product minScore as minimum inner-product and emits raw distance score", () => {
    const query = compileQuery(
      buildVectorAst("inner_product", 0.6),
      "graph_1",
      pgVectorOptions(),
    );
    const sql = toSqlString(query);

    expect(sql).toContain("<= -0.6");
    expect(sql).not.toContain("1 - (");
  });

  it("emits a no-row embeddings CTE when no resolved kind declares the field", () => {
    // No slot map → no kind in the alias backs a per-field table. The CTE
    // must still compile with the right column shape and yield zero rows so
    // the rest of the emitter (which always references cte_embeddings) works.
    const sql = toSqlString(
      compileQuery(buildVectorAst("cosine", 0.5), "graph_1", {
        dialect: "postgres",
        vectorStrategy: pgvectorStrategy,
      }),
    );

    expect(sql).toContain("WHERE 1 = 0");
    expect(sql).not.toContain("tg_vec_graph_1_document_embedding");
    // Even the empty body carries the contract columns.
    expect(sql).toContain("AS node_id");
    expect(sql).toContain("AS node_kind");
    expect(sql).toContain("AS distance");
    expect(sql).toContain("AS score");
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

describe("vector metric validation follows the active strategy, not the dialect", () => {
  // A custom Postgres-dialect override that drops `inner_product` — exactly the
  // case the dialect's built-in metric list (which includes `inner_product`)
  // would otherwise mis-validate. Spreads the real strategy so every SQL-gen
  // method is present; only the advertised capabilities differ.
  const cosineL2OnlyStrategy: VectorStrategy = {
    ...pgvectorStrategy,
    name: "pgvector-cosine-l2-only",
    capabilities: {
      ...pgvectorStrategy.capabilities,
      metrics: ["cosine", "l2"],
    },
  };

  it("rejects a metric the active strategy omits even though the dialect allows it", () => {
    // Same `postgres` dialect (which lists inner_product), same query — only the
    // strategy differs. Validation must follow the strategy and reject.
    expect(() =>
      compileQuery(buildVectorAst("inner_product", 0.5), "graph_1", {
        dialect: "postgres",
        vectorStrategy: cosineL2OnlyStrategy,
        vectorSlots: VECTOR_SLOTS,
      }),
    ).toThrow(/not supported by vector strategy "pgvector-cosine-l2-only"/);
  });

  it("accepts the same metric when the active strategy advertises it", () => {
    // pgvectorStrategy supports inner_product → same dialect, same query,
    // different strategy ⇒ accepted. Proves the check reads the strategy.
    expect(() =>
      compileQuery(buildVectorAst("inner_product", 0.5), "graph_1", {
        dialect: "postgres",
        vectorStrategy: pgvectorStrategy,
        vectorSlots: VECTOR_SLOTS,
      }),
    ).not.toThrow();
  });
});

// Compiles a `similarTo` predicate that OMITS its metric, against a slot whose
// declared metric is `metric`. The compiled SQL should reflect the declared
// metric (resolved per kind), not a cosine default.
function compileWithDeclaredMetric(metric: "cosine" | "l2"): string {
  const slots: VectorSlotMap = new Map([
    [
      vectorSlotKey("Document", "embedding"),
      { dimensions: 3, metric, indexType: "hnsw" },
    ],
  ]);
  return toSqlString(
    compileQuery(buildVectorAst(undefined, 0.5), "graph_1", {
      dialect: "postgres",
      vectorStrategy: pgvectorStrategy,
      vectorSlots: slots,
    }),
  );
}

describe("vector predicate without an explicit metric uses the declared metric", () => {
  it("emits the l2 operator (<->) for an l2-declared field, not cosine (<=>)", () => {
    const sql = compileWithDeclaredMetric("l2");
    expect(sql).toContain("<->");
    expect(sql).not.toContain("<=>");
  });

  it("emits the cosine operator (<=>) for a cosine-declared field", () => {
    const sql = compileWithDeclaredMetric("cosine");
    expect(sql).toContain("<=>");
    expect(sql).not.toContain("<->");
  });

  it("pgvector buildCreateIndex emits CONCURRENTLY only when requested (#5)", () => {
    const slot = {
      graphId: "g1",
      nodeKind: "Doc",
      fieldPath: "embedding",
      dimensions: 3,
      metric: "cosine" as const,
      indexType: "hnsw" as const,
    };
    const ddlText = (concurrent: boolean): string =>
      new PgDialect().sqlToQuery(
        pgvectorStrategy.buildCreateIndex!(slot, { concurrent })!,
      ).sql;
    expect(ddlText(true)).toContain("CREATE INDEX CONCURRENTLY");
    expect(ddlText(false)).not.toContain("CONCURRENTLY");
  });

  it("rejects an out-of-range cosine minScore even with no explicit metric (#3)", () => {
    // No explicit metric → the cosine range check used to be skipped, compiling
    // `distance <= (1 - 5)` and silently returning nothing. It must throw now.
    const slots: VectorSlotMap = new Map([
      [
        vectorSlotKey("Document", "embedding"),
        { dimensions: 3, metric: "cosine", indexType: "hnsw" },
      ],
    ]);
    expect(() =>
      compileQuery(buildVectorAst(undefined, 5), "graph_1", {
        dialect: "postgres",
        vectorStrategy: pgvectorStrategy,
        vectorSlots: slots,
      }),
    ).toThrow(/between -1 and 1/);
  });
});
