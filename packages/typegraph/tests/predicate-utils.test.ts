/**
 * Predicate Utilities Unit Tests
 *
 * Tests buildPredicateIndex, getPredicatesForAlias,
 * compileKindFilter, and getNodeKindsForAlias.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { CompilerInvariantError } from "../src/errors";
import type { NodePredicate, QueryAst } from "../src/query/ast";
import {
  buildPredicateIndex,
  compileKindFilter,
  getNodeKindsForAlias,
  getPredicatesForAlias,
} from "../src/query/compiler/predicate-utils";
import { toSqlString } from "./sql-test-utils";

// ============================================================
// Helpers
// ============================================================

function makeFieldRef(alias: string, path = ["props", "name"]) {
  return { __type: "field_ref" as const, alias, path };
}

function makeLiteral(value: string | number | boolean) {
  return {
    __type: "literal" as const,
    value,
    valueType: typeof value as "string" | "number" | "boolean",
  };
}

function makeNodePredicate(
  alias: string,
  targetType?: "node" | "edge",
): NodePredicate {
  return {
    targetAlias: alias,
    ...(targetType === undefined ? {} : { targetType }),
    expression: {
      __type: "comparison",
      op: "eq",
      left: makeFieldRef(alias),
      right: makeLiteral("test"),
    },
  };
}

function makeMinimalAst(overrides: Partial<QueryAst> = {}): QueryAst {
  return {
    start: { alias: "p", kinds: ["Person"], includeSubClasses: false },
    traversals: [],
    predicates: [],
    projection: { fields: [] },
    temporalMode: { mode: "current" },
    ...overrides,
  };
}

// ============================================================
// buildPredicateIndex / getPredicatesForAlias
// ============================================================

describe("buildPredicateIndex", () => {
  it("builds an empty index from an AST with no predicates", () => {
    const ast = makeMinimalAst();
    const index = buildPredicateIndex(ast);
    expect(index.byAliasAndType.size).toBe(0);
  });

  it("indexes a single node predicate", () => {
    const predicate = makeNodePredicate("p");
    const ast = makeMinimalAst({ predicates: [predicate] });
    const index = buildPredicateIndex(ast);

    const result = getPredicatesForAlias(index, "p", "node");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(predicate);
  });

  it("indexes an edge predicate separately from node predicates", () => {
    const nodePred = makeNodePredicate("e1");
    const edgePred = makeNodePredicate("e1", "edge");
    const ast = makeMinimalAst({ predicates: [nodePred, edgePred] });
    const index = buildPredicateIndex(ast);

    expect(getPredicatesForAlias(index, "e1", "node")).toHaveLength(1);
    expect(getPredicatesForAlias(index, "e1", "edge")).toHaveLength(1);
    expect(getPredicatesForAlias(index, "e1", "node")[0]).toBe(nodePred);
    expect(getPredicatesForAlias(index, "e1", "edge")[0]).toBe(edgePred);
  });

  it("groups multiple predicates for the same alias", () => {
    const pred1 = makeNodePredicate("p");
    const pred2 = makeNodePredicate("p");
    const pred3 = makeNodePredicate("q");
    const ast = makeMinimalAst({ predicates: [pred1, pred2, pred3] });
    const index = buildPredicateIndex(ast);

    expect(getPredicatesForAlias(index, "p", "node")).toHaveLength(2);
    expect(getPredicatesForAlias(index, "q", "node")).toHaveLength(1);
  });

  it("returns empty array for unknown alias", () => {
    const ast = makeMinimalAst({ predicates: [makeNodePredicate("p")] });
    const index = buildPredicateIndex(ast);

    const result = getPredicatesForAlias(index, "unknown", "node");
    expect(result).toHaveLength(0);
  });

  it("returns empty array for wrong target type", () => {
    const ast = makeMinimalAst({ predicates: [makeNodePredicate("p")] });
    const index = buildPredicateIndex(ast);

    expect(getPredicatesForAlias(index, "p", "edge")).toHaveLength(0);
  });

  it("treats undefined targetType as node", () => {
    const predicate: NodePredicate = {
      targetAlias: "p",
      // targetType omitted — should default to "node"
      expression: {
        __type: "null_check",
        op: "isNull",
        field: makeFieldRef("p"),
      },
    };
    const ast = makeMinimalAst({ predicates: [predicate] });
    const index = buildPredicateIndex(ast);

    expect(getPredicatesForAlias(index, "p", "node")).toHaveLength(1);
    expect(getPredicatesForAlias(index, "p", "edge")).toHaveLength(0);
  });
});

// ============================================================
// compileKindFilter
// ============================================================

describe("compileKindFilter", () => {
  const column = sql.raw('"kind"');

  it("produces 1 = 0 for empty kinds array", () => {
    const result = compileKindFilter(column, []);
    expect(toSqlString(result)).toContain("1 = 0");
  });

  it("produces equality check for single kind", () => {
    const result = compileKindFilter(column, ["Person"]);
    const sqlString = toSqlString(result);
    expect(sqlString).toContain('"kind"');
    expect(sqlString).toContain("Person");
    expect(sqlString).toContain("=");
  });

  it("produces IN clause for multiple kinds", () => {
    const result = compileKindFilter(column, ["Person", "Company"]);
    const sqlString = toSqlString(result);
    expect(sqlString).toContain("IN");
    expect(sqlString).toContain("Person");
    expect(sqlString).toContain("Company");
  });
});

// ============================================================
// getNodeKindsForAlias
// ============================================================

describe("getNodeKindsForAlias", () => {
  it("returns start kinds for the start alias", () => {
    const ast = makeMinimalAst();
    expect(getNodeKindsForAlias(ast, "p")).toEqual(["Person"]);
  });

  it("returns traversal nodeKinds for a traversal alias", () => {
    const ast = makeMinimalAst({
      traversals: [
        {
          edgeAlias: "e_worksAt",
          edgeKinds: ["worksAt"],
          direction: "out",
          nodeAlias: "c",
          nodeKinds: ["Company", "Organization"],
          joinFromAlias: "p",
          joinEdgeField: "from_id",
          optional: false,
        },
      ],
    });
    expect(getNodeKindsForAlias(ast, "c")).toEqual(["Company", "Organization"]);
  });

  it("throws CompilerInvariantError for unknown alias", () => {
    const ast = makeMinimalAst();
    expect(() => getNodeKindsForAlias(ast, "unknown")).toThrow(
      CompilerInvariantError,
    );
  });

  it("returns correct kinds when multiple traversals exist", () => {
    const ast = makeMinimalAst({
      traversals: [
        {
          edgeAlias: "e1",
          edgeKinds: ["worksAt"],
          direction: "out",
          nodeAlias: "c",
          nodeKinds: ["Company"],
          joinFromAlias: "p",
          joinEdgeField: "from_id",
          optional: false,
        },
        {
          edgeAlias: "e2",
          edgeKinds: ["locatedIn"],
          direction: "out",
          nodeAlias: "loc",
          nodeKinds: ["Location"],
          joinFromAlias: "c",
          joinEdgeField: "from_id",
          optional: false,
        },
      ],
    });
    expect(getNodeKindsForAlias(ast, "c")).toEqual(["Company"]);
    expect(getNodeKindsForAlias(ast, "loc")).toEqual(["Location"]);
  });
});
