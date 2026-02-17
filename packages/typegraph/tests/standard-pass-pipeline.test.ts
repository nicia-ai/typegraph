/**
 * Standard Pass Pipeline Unit Tests
 *
 * Tests the multi-pass optimization pipeline including column pruning,
 * limit pushdown, traversal collapsing, and vector/temporal passes.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type {
  FieldRef,
  NodePredicate,
  PredicateExpression,
  QueryAst,
  SelectiveField,
  Traversal,
} from "../src/query/ast";
import { type PredicateCompilerContext } from "../src/query/compiler/predicates";
import { DEFAULT_SQL_SCHEMA } from "../src/query/compiler/schema";
import {
  runStandardQueryPassPipeline,
  shouldMaterializeTraversalCte,
} from "../src/query/compiler/standard-pass-pipeline";
import { getDialect } from "../src/query/dialect";
import type { DialectAdapter } from "../src/query/dialect/types";

// ============================================================
// Helpers
// ============================================================

function makeFieldRef(
  alias: string,
  path: string[],
  valueType?: string,
): FieldRef {
  return {
    __type: "field_ref",
    alias,
    path,
    ...(valueType === undefined ?
      {}
    : { valueType: valueType as FieldRef["valueType"] }),
  };
}

function makeLiteral(value: string | number | boolean) {
  return {
    __type: "literal" as const,
    value,
    valueType: typeof value as "string" | "number" | "boolean",
  };
}

function makeComparison(
  alias: string,
  path: string[],
  value: string | number | boolean,
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" = "eq",
): PredicateExpression {
  return {
    __type: "comparison",
    op,
    left: makeFieldRef(alias, path),
    right: makeLiteral(value),
  };
}

function makeNodePredicate(
  alias: string,
  expression: PredicateExpression,
): NodePredicate {
  return { targetAlias: alias, expression };
}

function makeTraversal(overrides: Partial<Traversal> = {}): Traversal {
  return {
    edgeAlias: "e_worksAt",
    edgeKinds: ["worksAt"],
    direction: "out" as const,
    nodeAlias: "c",
    nodeKinds: ["Company"],
    joinFromAlias: "p",
    joinEdgeField: "from_id" as const,
    optional: false,
    ...overrides,
  };
}

function makeSelectiveField(
  alias: string,
  field: string,
  isSystemField = false,
  valueType?: string,
): SelectiveField {
  return {
    alias,
    field,
    outputName: `${alias}_${field}`,
    isSystemField,
    ...(valueType === undefined ?
      {}
    : { valueType: valueType as SelectiveField["valueType"] }),
  };
}

function makeMinimalAst(overrides: Partial<QueryAst> = {}): QueryAst {
  return {
    start: { alias: "p", kinds: ["Person"], includeSubClasses: false },
    traversals: [],
    predicates: [],
    projection: {
      fields: [
        {
          outputName: "p",
          source: makeFieldRef("p", ["props"]),
        },
      ],
    },
    temporalMode: { mode: "current" },
    ...overrides,
  };
}

function makePipelineContext(
  dialect: DialectAdapter = getDialect("sqlite"),
): PredicateCompilerContext {
  return {
    dialect,
    schema: DEFAULT_SQL_SCHEMA,
    compileQuery: () => sql`SELECT 1`,
  };
}

// ============================================================
// shouldMaterializeTraversalCte
// ============================================================

describe("shouldMaterializeTraversalCte", () => {
  const sqliteDialect = getDialect("sqlite");
  const postgresDialect = getDialect("postgres");

  it("returns false for postgres (materialization disabled)", () => {
    expect(shouldMaterializeTraversalCte(postgresDialect, 3, 0)).toBe(false);
    expect(shouldMaterializeTraversalCte(postgresDialect, 3, 1)).toBe(false);
  });

  it("returns false for single traversal", () => {
    expect(shouldMaterializeTraversalCte(sqliteDialect, 1, 0)).toBe(false);
  });

  it("returns true for intermediate traversals on sqlite", () => {
    // traversalCount=3, index=0 (not last) → materialize
    expect(shouldMaterializeTraversalCte(sqliteDialect, 3, 0)).toBe(true);
    // traversalCount=3, index=1 (not last) → materialize
    expect(shouldMaterializeTraversalCte(sqliteDialect, 3, 1)).toBe(true);
  });

  it("returns false for the last traversal on sqlite", () => {
    // traversalCount=3, index=2 (last) → don't materialize
    expect(shouldMaterializeTraversalCte(sqliteDialect, 3, 2)).toBe(false);
  });
});

// ============================================================
// runStandardQueryPassPipeline — column pruning
// ============================================================

describe("column pruning pass", () => {
  it("disables column pruning for simple non-selective queries", () => {
    const ast = makeMinimalAst();
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.requiredColumnsByAlias).toBeUndefined();
  });

  it("enables column pruning when selectiveFields are present", () => {
    const ast = makeMinimalAst({
      selectiveFields: [makeSelectiveField("p", "name", false, "string")],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.requiredColumnsByAlias).toBeDefined();
    expect(state.requiredColumnsByAlias?.get("p")?.has("props")).toBe(true);
    expect(state.requiredColumnsByAlias?.get("p")?.has("id")).toBe(true);
  });

  it("enables column pruning when groupBy is present", () => {
    const ast = makeMinimalAst({
      groupBy: { fields: [makeFieldRef("p", ["props", "name"])] },
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.requiredColumnsByAlias).toBeDefined();
  });

  it("enables column pruning when having is present", () => {
    const ast = makeMinimalAst({
      having: {
        __type: "aggregate_comparison",
        op: "gt",
        aggregate: {
          __type: "aggregate",
          function: "count",
          field: makeFieldRef("p", ["id"]),
        },
        value: makeLiteral(5),
      },
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.requiredColumnsByAlias).toBeDefined();
  });

  it("enables column pruning when projection contains aggregates", () => {
    const ast = makeMinimalAst({
      projection: {
        fields: [
          {
            outputName: "total",
            source: {
              __type: "aggregate",
              function: "count",
              field: makeFieldRef("p", ["id"]),
            },
          },
        ],
      },
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.requiredColumnsByAlias).toBeDefined();
  });

  it("includes predicate fields in required columns", () => {
    const ast = makeMinimalAst({
      selectiveFields: [makeSelectiveField("p", "name", false, "string")],
      predicates: [
        makeNodePredicate("p", makeComparison("p", ["props", "age"], 30)),
      ],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.requiredColumnsByAlias?.get("p")?.has("props")).toBe(true);
  });

  it("includes orderBy fields in required columns", () => {
    const ast = makeMinimalAst({
      selectiveFields: [makeSelectiveField("p", "name", false, "string")],
      orderBy: [
        { field: makeFieldRef("p", ["props", "age"]), direction: "asc" },
      ],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.requiredColumnsByAlias?.get("p")?.has("props")).toBe(true);
  });
});

// ============================================================
// runStandardQueryPassPipeline — traversal limit pushdown
// ============================================================

describe("traversal limit pushdown", () => {
  it("does not push down limit without a limit clause", () => {
    const ast = makeMinimalAst({
      traversals: [
        makeTraversal({ nodeAlias: "c", joinFromAlias: "p" }),
        makeTraversal({
          nodeAlias: "loc",
          edgeAlias: "e_loc",
          joinFromAlias: "c",
        }),
      ],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.traversalCteLimit).toBeUndefined();
  });

  it("does not push down when offset is present", () => {
    const ast = makeMinimalAst({
      limit: 10,
      offset: 5,
      traversals: [
        makeTraversal({ nodeAlias: "c", joinFromAlias: "p" }),
        makeTraversal({
          nodeAlias: "loc",
          edgeAlias: "e_loc",
          joinFromAlias: "c",
        }),
      ],
      predicates: [
        makeNodePredicate("p", makeComparison("p", ["id"], "abc123")),
      ],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.traversalCteLimit).toBeUndefined();
  });

  it("does not push down with fewer than 2 traversals", () => {
    const ast = makeMinimalAst({
      limit: 10,
      traversals: [makeTraversal()],
      predicates: [
        makeNodePredicate("p", makeComparison("p", ["id"], "abc123")),
      ],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.traversalCteLimit).toBeUndefined();
  });

  it("does not push down when orderBy is present", () => {
    const ast = makeMinimalAst({
      limit: 10,
      orderBy: [
        { field: makeFieldRef("p", ["props", "name"]), direction: "asc" },
      ],
      traversals: [
        makeTraversal({ nodeAlias: "c", joinFromAlias: "p" }),
        makeTraversal({
          nodeAlias: "loc",
          edgeAlias: "e_loc",
          joinFromAlias: "c",
        }),
      ],
      predicates: [
        makeNodePredicate("p", makeComparison("p", ["id"], "abc123")),
      ],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.traversalCteLimit).toBeUndefined();
  });

  it("does not push down when optional traversals exist", () => {
    const ast = makeMinimalAst({
      limit: 10,
      traversals: [
        makeTraversal({ nodeAlias: "c", joinFromAlias: "p" }),
        makeTraversal({
          nodeAlias: "loc",
          edgeAlias: "e_loc",
          joinFromAlias: "c",
          optional: true,
        }),
      ],
      predicates: [
        makeNodePredicate("p", makeComparison("p", ["id"], "abc123")),
      ],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.traversalCteLimit).toBeUndefined();
  });

  it("does not push down when groupBy is present", () => {
    const ast = makeMinimalAst({
      limit: 10,
      groupBy: { fields: [makeFieldRef("p", ["kind"])] },
      traversals: [
        makeTraversal({ nodeAlias: "c", joinFromAlias: "p" }),
        makeTraversal({
          nodeAlias: "loc",
          edgeAlias: "e_loc",
          joinFromAlias: "c",
        }),
      ],
      predicates: [
        makeNodePredicate("p", makeComparison("p", ["id"], "abc123")),
      ],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.traversalCteLimit).toBeUndefined();
  });

  it("pushes down limit * 8 when all conditions are met", () => {
    const ast = makeMinimalAst({
      limit: 10,
      traversals: [
        makeTraversal({ nodeAlias: "c", joinFromAlias: "p" }),
        makeTraversal({
          nodeAlias: "loc",
          edgeAlias: "e_loc",
          joinFromAlias: "c",
        }),
      ],
      predicates: [
        makeNodePredicate("p", makeComparison("p", ["id"], "abc123")),
      ],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.traversalCteLimit).toBe(80); // 10 * 8
  });

  it("caps pushdown at 10,000", () => {
    const ast = makeMinimalAst({
      limit: 2000,
      traversals: [
        makeTraversal({ nodeAlias: "c", joinFromAlias: "p" }),
        makeTraversal({
          nodeAlias: "loc",
          edgeAlias: "e_loc",
          joinFromAlias: "c",
        }),
      ],
      predicates: [
        makeNodePredicate("p", makeComparison("p", ["id"], "abc123")),
      ],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.traversalCteLimit).toBe(10_000);
  });

  it("uses limit itself when limit > limit * 8 (limit=0)", () => {
    const ast = makeMinimalAst({
      limit: 0,
      traversals: [
        makeTraversal({ nodeAlias: "c", joinFromAlias: "p" }),
        makeTraversal({
          nodeAlias: "loc",
          edgeAlias: "e_loc",
          joinFromAlias: "c",
        }),
      ],
      predicates: [
        makeNodePredicate("p", makeComparison("p", ["id"], "abc123")),
      ],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.traversalCteLimit).toBe(0);
  });

  it("requires id equality predicate on start alias", () => {
    // No id equality → no pushdown
    const ast = makeMinimalAst({
      limit: 10,
      traversals: [
        makeTraversal({ nodeAlias: "c", joinFromAlias: "p" }),
        makeTraversal({
          nodeAlias: "loc",
          edgeAlias: "e_loc",
          joinFromAlias: "c",
        }),
      ],
      predicates: [
        makeNodePredicate("p", makeComparison("p", ["props", "name"], "Alice")),
      ],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.traversalCteLimit).toBeUndefined();
  });
});

// ============================================================
// runStandardQueryPassPipeline — selective traversal rowset collapsing
// ============================================================

describe("selective traversal rowset collapsing", () => {
  it("does not collapse without traversals", () => {
    const ast = makeMinimalAst({
      selectiveFields: [makeSelectiveField("p", "name")],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.shouldCollapseSelectiveTraversalRowset).toBe(false);
    expect(state.collapsedTraversalCteAlias).toBeUndefined();
  });

  it("does not collapse without selectiveFields", () => {
    const ast = makeMinimalAst({
      traversals: [makeTraversal()],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.shouldCollapseSelectiveTraversalRowset).toBe(false);
  });

  it("does not collapse when traversals have optional joins", () => {
    const ast = makeMinimalAst({
      traversals: [makeTraversal({ optional: true })],
      selectiveFields: [makeSelectiveField("p", "name")],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.shouldCollapseSelectiveTraversalRowset).toBe(false);
  });

  it("does not collapse when groupBy is present", () => {
    const ast = makeMinimalAst({
      traversals: [makeTraversal()],
      selectiveFields: [makeSelectiveField("p", "name")],
      groupBy: { fields: [makeFieldRef("p", ["kind"])] },
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.shouldCollapseSelectiveTraversalRowset).toBe(false);
  });

  it("collapses when conditions are met", () => {
    const ast = makeMinimalAst({
      traversals: [makeTraversal({ nodeAlias: "c", joinFromAlias: "p" })],
      selectiveFields: [makeSelectiveField("p", "name")],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.shouldCollapseSelectiveTraversalRowset).toBe(true);
    expect(state.collapsedTraversalCteAlias).toBe("cte_c");
  });

  it("does not collapse when traversal chain is non-linear", () => {
    // Second traversal joins from "p" instead of "c" (non-linear)
    const ast = makeMinimalAst({
      traversals: [
        makeTraversal({ nodeAlias: "c", joinFromAlias: "p" }),
        makeTraversal({
          nodeAlias: "d",
          edgeAlias: "e2",
          joinFromAlias: "p", // skips "c" — non-linear
        }),
      ],
      selectiveFields: [makeSelectiveField("p", "name")],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.shouldCollapseSelectiveTraversalRowset).toBe(false);
  });
});

// ============================================================
// runStandardQueryPassPipeline — vector predicate pass
// ============================================================

describe("vector predicate pass", () => {
  it("sets vectorPredicate to undefined when no vector predicates", () => {
    const ast = makeMinimalAst();
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.vectorPredicate).toBeUndefined();
  });
});

// ============================================================
// runStandardQueryPassPipeline — effective limit
// ============================================================

describe("effective limit resolution", () => {
  it("passes through undefined limit when no vector predicate", () => {
    const ast = makeMinimalAst();
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.effectiveLimit).toBeUndefined();
  });

  it("passes through explicit limit when no vector predicate", () => {
    const ast = makeMinimalAst({ limit: 25 });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.effectiveLimit).toBe(25);
  });
});

// ============================================================
// runStandardQueryPassPipeline — logical plan generation
// ============================================================

describe("logical plan generation", () => {
  it("produces a logical plan for a basic query", () => {
    const ast = makeMinimalAst();
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.logicalPlan).toBeDefined();
  });

  it("produces a logical plan for a query with traversals", () => {
    const ast = makeMinimalAst({
      traversals: [makeTraversal()],
    });
    const ctx = makePipelineContext();
    const state = runStandardQueryPassPipeline(ast, "test_graph", ctx);
    expect(state.logicalPlan).toBeDefined();
  });
});
