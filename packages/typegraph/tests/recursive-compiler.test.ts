/**
 * Unit tests for recursive CTE compilation.
 *
 * Tests variable-length path traversal query generation.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { UnsupportedPredicateError } from "../src/errors";
import {
  type FieldRef,
  type OrderSpec,
  type QueryAst,
  type Traversal,
  type VariableLengthSpec,
} from "../src/query/ast";
import { type PredicateCompilerContext } from "../src/query/compiler/predicates";
import {
  compileVariableLengthQuery,
  hasVariableLengthTraversal,
  MAX_EXPLICIT_RECURSIVE_DEPTH,
  MAX_RECURSIVE_DEPTH,
} from "../src/query/compiler/recursive";
import { DEFAULT_SQL_SCHEMA } from "../src/query/compiler/schema";
import { postgresDialect, sqliteDialect } from "../src/query/dialect";
import { toSqlString } from "./sql-test-utils";

// ============================================================
// Test Helpers
// ============================================================

function createVariableLengthSpec(
  overrides: Partial<VariableLengthSpec> = {},
): VariableLengthSpec {
  return {
    minDepth: 1,
    maxDepth: -1, // unlimited
    cyclePolicy: "prevent",
    ...overrides,
  };
}

function createTraversal(overrides: Partial<Traversal> = {}): Traversal {
  return {
    edgeAlias: "e",
    edgeKinds: ["RELATES_TO"],
    direction: "out",
    nodeAlias: "target",
    nodeKinds: ["Node"],
    joinFromAlias: "source",
    joinEdgeField: "from_id",
    optional: false,
    ...overrides,
  };
}

function createAst(overrides: Partial<QueryAst> = {}): QueryAst {
  return {
    start: {
      alias: "source",
      kinds: ["StartNode"],
      includeSubClasses: false,
    },
    traversals: [
      createTraversal({
        variableLength: createVariableLengthSpec(),
      }),
    ],
    predicates: [],
    projection: {
      fields: [
        {
          outputName: "id",
          source: {
            __type: "field_ref",
            alias: "source",
            path: ["id"],
          },
        },
      ],
    },
    temporalMode: { mode: "current" },
    ...overrides,
  };
}

function createContext(
  dialect: PredicateCompilerContext["dialect"] = sqliteDialect,
): PredicateCompilerContext {
  return {
    dialect,
    schema: DEFAULT_SQL_SCHEMA,
    compileQuery: () => sql`SELECT 1`,
  };
}

function createFieldRef(
  alias: string,
  path: string[],
  valueType: "string" | "number" | "boolean" | "date" = "string",
): FieldRef {
  return {
    __type: "field_ref",
    alias,
    path,
    valueType,
  };
}

function createOrderSpec(
  alias: string,
  field: string,
  direction: "asc" | "desc" = "asc",
  nulls?: "first" | "last",
): OrderSpec {
  const spec: OrderSpec = {
    field: createFieldRef(alias, ["props", field]),
    direction,
  };
  if (nulls !== undefined) {
    return { ...spec, nulls };
  }
  return spec;
}

function getSqlString(ast: QueryAst, ctx = createContext()): string {
  const result = compileVariableLengthQuery(ast, "test-graph", ctx);
  return toSqlString(result);
}

// ============================================================
// hasVariableLengthTraversal
// ============================================================

describe("hasVariableLengthTraversal", () => {
  it("returns true when traversal has variableLength", () => {
    const ast = createAst();

    expect(hasVariableLengthTraversal(ast)).toBe(true);
  });

  it("returns false when no traversals", () => {
    const ast = createAst({ traversals: [] });

    expect(hasVariableLengthTraversal(ast)).toBe(false);
  });

  it("returns false when traversal has no variableLength", () => {
    const ast = createAst({
      traversals: [createTraversal({})],
    });

    expect(hasVariableLengthTraversal(ast)).toBe(false);
  });

  it("returns true when any traversal has variableLength", () => {
    const ast = createAst({
      traversals: [
        createTraversal({}),
        createTraversal({ variableLength: createVariableLengthSpec() }),
      ],
    });

    expect(hasVariableLengthTraversal(ast)).toBe(true);
  });
});

// ============================================================
// compileVariableLengthQuery - Basic
// ============================================================

describe("compileVariableLengthQuery", () => {
  describe("basic compilation", () => {
    it("generates WITH RECURSIVE clause", () => {
      const ast = createAst();

      const sql = getSqlString(ast);

      expect(sql).toContain("WITH RECURSIVE");
    });

    it("generates recursive_cte", () => {
      const ast = createAst();

      const sql = getSqlString(ast);

      expect(sql).toContain("recursive_cte");
    });

    it("includes base case selecting from typegraph_nodes", () => {
      const ast = createAst();

      const sql = getSqlString(ast);

      expect(sql).toContain('FROM "typegraph_nodes"');
    });

    it("includes UNION ALL for recursive part", () => {
      const ast = createAst();

      const sql = getSqlString(ast);

      expect(sql).toContain("UNION ALL");
    });

    it("includes graph_id filter", () => {
      const ast = createAst();

      const sql = getSqlString(ast);

      expect(sql).toContain("graph_id");
      expect(sql).toContain("test-graph");
    });

    it("includes kind filter for start nodes", () => {
      const ast = createAst();

      const sql = getSqlString(ast);

      expect(sql).toContain("StartNode");
    });

    it("includes depth tracking", () => {
      const ast = createAst();

      const sql = getSqlString(ast);

      expect(sql).toContain("0 AS depth");
      expect(sql).toContain("r.depth + 1");
    });
  });

  // ============================================================
  // Error Handling
  // ============================================================

  describe("error handling", () => {
    it("throws when no variable-length traversal found", () => {
      const ast = createAst({
        traversals: [createTraversal({})],
      });

      expect(() => getSqlString(ast)).toThrow(
        "No variable-length traversal found",
      );
    });

    it("throws UnsupportedPredicateError for multiple traversals", () => {
      const ast = createAst({
        traversals: [
          createTraversal({ variableLength: createVariableLengthSpec() }),
          createTraversal({
            edgeAlias: "e2",
            nodeAlias: "target2",
          }),
        ],
      });

      expect(() => getSqlString(ast)).toThrow(UnsupportedPredicateError);
      expect(() => getSqlString(ast)).toThrow("multiple traversals");
    });
  });

  // ============================================================
  // Direction
  // ============================================================

  describe("direction", () => {
    it("uses from_id for outbound traversals", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            direction: "out",
            variableLength: createVariableLengthSpec(),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("e.from_id");
      expect(sql).toContain("e.from_kind = r.target_kind");
      expect(sql).toContain("n.kind = e.to_kind");
    });

    it("uses to_id for inbound traversals", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            direction: "in",
            variableLength: createVariableLengthSpec(),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("e.to_id");
      expect(sql).toContain("e.to_kind = r.target_kind");
      expect(sql).toContain("n.kind = e.from_kind");
    });

    it("adds endpoint kind filters for outbound traversals", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            direction: "out",
            variableLength: createVariableLengthSpec(),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("e.from_kind");
      expect(sql).toContain("e.to_kind");
    });

    it("adds endpoint kind filters for inbound traversals", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            direction: "in",
            variableLength: createVariableLengthSpec(),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("e.to_kind");
      expect(sql).toContain("e.from_kind");
    });

    it("adds inverse branch for bidirectional recursive traversal", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            direction: "out",
            inverseEdgeKinds: ["RELATES_TO"],
            variableLength: createVariableLengthSpec(),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain('"typegraph_edges" e');
      expect(sql).toContain("e.from_id = r.target_id");
      expect(sql).toContain("e.to_id = r.target_id");
      expect(sql).toContain("e.from_id = e.to_id");
    });

    it("forces worktable-first join order on sqlite recursive steps", () => {
      const ast = createAst();

      const sql = getSqlString(ast, createContext(sqliteDialect));

      expect(sql).toMatch(
        /FROM recursive_cte r\s+CROSS JOIN "typegraph_edges" e/,
      );
      expect(sql).toMatch(/WHERE e\.from_id = r\.target_id/);
    });

    it("keeps ON-clause joins for postgres recursive steps", () => {
      const ast = createAst();

      const sql = getSqlString(ast, createContext(postgresDialect));

      expect(sql).toMatch(
        /FROM recursive_cte r\s+JOIN "typegraph_edges" e ON e\.from_id = r\.target_id/,
      );
      expect(sql).not.toContain("CROSS JOIN");
    });
  });

  // ============================================================
  // Depth Limits
  // ============================================================

  describe("depth limits", () => {
    it("enforces MAX_RECURSIVE_DEPTH for unlimited queries", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            variableLength: createVariableLengthSpec({ maxDepth: -1 }),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain(`r.depth < ${MAX_RECURSIVE_DEPTH}`);
    });

    it("uses specified maxDepth when less than MAX_RECURSIVE_DEPTH", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            variableLength: createVariableLengthSpec({ maxDepth: 5 }),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("r.depth < 5");
    });

    it("allows explicit maxDepth above MAX_RECURSIVE_DEPTH", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            variableLength: createVariableLengthSpec({ maxDepth: 500 }),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("r.depth < 500");
    });

    it("throws when explicit maxDepth exceeds MAX_EXPLICIT_RECURSIVE_DEPTH", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            variableLength: createVariableLengthSpec({ maxDepth: 5000 }),
          }),
        ],
      });

      expect(() => getSqlString(ast)).toThrow(
        `maxHops(5000) exceeds maximum explicit depth of ${MAX_EXPLICIT_RECURSIVE_DEPTH}`,
      );
    });

    it("applies minDepth filter in final SELECT", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            variableLength: createVariableLengthSpec({ minDepth: 2 }),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("WHERE depth >= 2");
    });

    it("omits minDepth filter when minDepth is 0", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            variableLength: createVariableLengthSpec({ minDepth: 0 }),
          }),
        ],
      });

      const sql = getSqlString(ast);

      // Should not have depth filter
      expect(sql).not.toContain("WHERE depth >=");
    });
  });

  // ============================================================
  // Path Collection
  // ============================================================

  describe("path collection", () => {
    it("includes path in projection when pathAlias is provided", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            variableLength: createVariableLengthSpec({
              pathAlias: "target_path",
            }),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("path AS");
    });

    it("uses custom pathAlias when provided", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            variableLength: createVariableLengthSpec({
              pathAlias: "custom_path",
            }),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain('path AS "custom_path"');
    });

    it("uses custom depthAlias when provided", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            variableLength: createVariableLengthSpec({
              depthAlias: "hop_count",
            }),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain('depth AS "hop_count"');
    });
  });

  describe("selective projection", () => {
    it("compiles selective projection for recursive node aliases", () => {
      const ast = createAst({
        selectiveFields: [
          {
            alias: "source",
            field: "id",
            outputName: "source_id_only",
            isSystemField: true,
          },
          {
            alias: "target",
            field: "name",
            outputName: "target_name_only",
            isSystemField: false,
            valueType: "string",
          },
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain('source_id AS "source_id_only"');
      expect(sql).toContain("target_props");
      expect(sql).toContain('AS "target_name_only"');
    });

    it("prunes unreferenced recursive columns for selective projections", () => {
      const ast = createAst({
        selectiveFields: [
          {
            alias: "target",
            field: "id",
            outputName: "target_id_only",
            isSystemField: true,
          },
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain('target_id AS "target_id_only"');
      expect(sql).toContain("target_kind");
      expect(sql).not.toContain("source_props");
      expect(sql).not.toContain("source_version");
      expect(sql).not.toContain("target_props");
      expect(sql).not.toContain("target_created_at");
    });

    it("keeps ORDER BY columns when selective projection is enabled", () => {
      const ast = createAst({
        selectiveFields: [
          {
            alias: "target",
            field: "id",
            outputName: "target_id_only",
            isSystemField: true,
          },
        ],
        orderBy: [createOrderSpec("source", "name", "asc")],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("source_props");
      expect(sql).toContain('target_id AS "target_id_only"');
    });

    it("throws for recursive selective projection on unsupported aliases", () => {
      const ast = createAst({
        selectiveFields: [
          {
            alias: "e",
            field: "id",
            outputName: "edge_id_only",
            isSystemField: true,
          },
        ],
      });

      expect(() => getSqlString(ast)).toThrow(UnsupportedPredicateError);
      expect(() => getSqlString(ast)).toThrow("does not support alias");
    });
  });

  // ============================================================
  // ORDER BY
  // ============================================================

  describe("ORDER BY", () => {
    it("adds ORDER BY clause when specified", () => {
      const ast = createAst({
        orderBy: [createOrderSpec("source", "name", "asc")],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("ORDER BY");
    });

    it("compiles ascending order", () => {
      const ast = createAst({
        orderBy: [createOrderSpec("source", "name", "asc")],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("ASC");
    });

    it("compiles descending order", () => {
      const ast = createAst({
        orderBy: [createOrderSpec("source", "name", "desc")],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("DESC");
    });

    it("compiles NULLS FIRST", () => {
      const ast = createAst({
        orderBy: [createOrderSpec("source", "name", "asc", "first")],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("IS NULL) DESC");
      expect(sql).toContain(" ASC");
    });

    it("compiles NULLS LAST", () => {
      const ast = createAst({
        orderBy: [createOrderSpec("source", "name", "desc", "last")],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("IS NULL) ASC");
      expect(sql).toContain(" DESC");
    });

    it("compiles multiple order specifications", () => {
      const ast = createAst({
        orderBy: [
          createOrderSpec("source", "name", "asc"),
          createOrderSpec("source", "age", "desc"),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("ASC");
      expect(sql).toContain("DESC");
    });

    it("throws for array valueType", () => {
      const ast = createAst({
        orderBy: [
          {
            field: createFieldRef("source", ["props", "tags"], "string"),
            direction: "asc",
          },
        ],
      });
      // Override valueType to array
      (ast.orderBy![0]!.field as { valueType: string }).valueType = "array";

      expect(() => getSqlString(ast)).toThrow(UnsupportedPredicateError);
      expect(() => getSqlString(ast)).toThrow("arrays or objects");
    });

    it("throws for object valueType", () => {
      const ast = createAst({
        orderBy: [
          {
            field: createFieldRef("source", ["props", "metadata"], "string"),
            direction: "asc",
          },
        ],
      });
      // Override valueType to object
      (ast.orderBy![0]!.field as { valueType: string }).valueType = "object";

      expect(() => getSqlString(ast)).toThrow(UnsupportedPredicateError);
    });

    it("omits ORDER BY when not specified", () => {
      const ast = createAst({});

      const sql = getSqlString(ast);

      expect(sql).not.toContain("ORDER BY");
    });

    it("omits ORDER BY when empty array", () => {
      const ast = createAst({ orderBy: [] });

      const sql = getSqlString(ast);

      expect(sql).not.toContain("ORDER BY");
    });
  });

  // ============================================================
  // LIMIT and OFFSET
  // ============================================================

  describe("LIMIT and OFFSET", () => {
    it("adds LIMIT clause when specified", () => {
      const ast = createAst({ limit: 10 });

      const sql = getSqlString(ast);

      expect(sql).toContain("LIMIT");
      expect(sql).toContain("10");
    });

    it("adds OFFSET clause when specified", () => {
      const ast = createAst({ offset: 5 });

      const sql = getSqlString(ast);

      expect(sql).toContain("OFFSET");
      expect(sql).toContain("5");
    });

    it("combines LIMIT and OFFSET", () => {
      const ast = createAst({ limit: 20, offset: 10 });

      const sql = getSqlString(ast);

      expect(sql).toContain("LIMIT");
      expect(sql).toContain("20");
      expect(sql).toContain("OFFSET");
      expect(sql).toContain("10");
    });

    it("omits LIMIT/OFFSET when not specified", () => {
      const ast = createAst({});

      const sql = getSqlString(ast);

      expect(sql).not.toContain("LIMIT");
      expect(sql).not.toContain("OFFSET");
    });
  });

  // ============================================================
  // Cycle Detection
  // ============================================================

  describe("cycle detection", () => {
    it("includes cycle check in recursive part", () => {
      const ast = createAst();

      const sql = getSqlString(ast);

      // SQLite uses INSTR for cycle detection
      expect(sql).toContain("INSTR");
    });

    it("initializes path in base case", () => {
      const ast = createAst();

      const sql = getSqlString(ast);

      // SQLite uses string concatenation for path
      expect(sql).toContain("'|' ||");
      expect(sql).toContain("|| '|' AS path");
    });

    it("skips cycle/path tracking when cyclePolicy is allow", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            variableLength: createVariableLengthSpec({
              maxDepth: 5,
              cyclePolicy: "allow",
            }),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).not.toContain("INSTR");
      expect(sql).not.toContain(" AS path");
    });

    it("keeps cycle/path tracking when path projection is enabled", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            variableLength: createVariableLengthSpec({
              maxDepth: 5,
              pathAlias: "path",
            }),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("INSTR");
      expect(sql).toContain(" AS path");
    });
  });

  // ============================================================
  // Multiple Edge/Node Kinds
  // ============================================================

  describe("multiple kinds", () => {
    it("handles multiple edge kinds with IN clause", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            edgeKinds: ["FOLLOWS", "LIKES", "SHARES"],
            variableLength: createVariableLengthSpec(),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("e.kind IN");
      expect(sql).toContain("FOLLOWS");
      expect(sql).toContain("LIKES");
      expect(sql).toContain("SHARES");
    });

    it("handles multiple node kinds with IN clause", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            nodeKinds: ["Person", "Organization", "Group"],
            variableLength: createVariableLengthSpec(),
          }),
        ],
      });

      const sql = getSqlString(ast);

      expect(sql).toContain("n.kind IN");
      expect(sql).toContain("Person");
      expect(sql).toContain("Organization");
      expect(sql).toContain("Group");
    });

    it("uses equality for single kind", () => {
      const ast = createAst({
        traversals: [
          createTraversal({
            edgeKinds: ["RELATES_TO"],
            nodeKinds: ["Node"],
            variableLength: createVariableLengthSpec(),
          }),
        ],
      });

      const sql = getSqlString(ast);

      // Single kinds should use = instead of IN
      expect(sql).toContain("e.kind = ");
      expect(sql).toContain("n.kind = ");
    });
  });
});

// ============================================================
// Predicates
// ============================================================

describe("predicates", () => {
  describe("start node predicates", () => {
    it("includes start node predicates in base case WHERE", () => {
      const ast = createAst({
        predicates: [
          {
            targetAlias: "source",
            targetType: "node",
            expression: {
              __type: "comparison",
              op: "eq",
              left: createFieldRef("source", ["props", "status"]),
              right: {
                __type: "literal",
                value: "active",
                valueType: "string",
              },
            },
          },
        ],
      });

      const sqlString = getSqlString(ast);

      // The predicate should appear in the base case WHERE clause
      expect(sqlString).toContain("status");
      expect(sqlString).toContain("active");
    });

    it("includes multiple start node predicates", () => {
      const ast = createAst({
        predicates: [
          {
            targetAlias: "source",
            targetType: "node",
            expression: {
              __type: "comparison",
              op: "eq",
              left: createFieldRef("source", ["props", "status"]),
              right: {
                __type: "literal",
                value: "active",
                valueType: "string",
              },
            },
          },
          {
            targetAlias: "source",
            targetType: "node",
            expression: {
              __type: "comparison",
              op: "gt",
              left: createFieldRef("source", ["props", "priority"], "number"),
              right: { __type: "literal", value: 5, valueType: "number" },
            },
          },
        ],
      });

      const sqlString = getSqlString(ast);

      expect(sqlString).toContain("status");
      expect(sqlString).toContain("priority");
    });
  });

  describe("edge predicates", () => {
    it("includes edge predicates in recursive case WHERE", () => {
      const ast = createAst({
        predicates: [
          {
            targetAlias: "e",
            targetType: "edge",
            expression: {
              __type: "comparison",
              op: "gte",
              left: createFieldRef("e", ["props", "weight"], "number"),
              right: { __type: "literal", value: 10, valueType: "number" },
            },
          },
        ],
      });

      const sqlString = getSqlString(ast);

      // Regression test: edge predicates must be included in the recursive case.
      expect(sqlString).toContain("weight");
    });

    it("includes edge predicates with string comparison", () => {
      const ast = createAst({
        predicates: [
          {
            targetAlias: "e",
            targetType: "edge",
            expression: {
              __type: "comparison",
              op: "eq",
              left: createFieldRef("e", ["props", "relationship_type"]),
              right: {
                __type: "literal",
                value: "strong",
                valueType: "string",
              },
            },
          },
        ],
      });

      const sqlString = getSqlString(ast);

      // Edge predicate should filter edges in the recursive step
      expect(sqlString).toContain("relationship_type");
      expect(sqlString).toContain("strong");
    });
  });

  describe("target node predicates", () => {
    it("includes target node predicates in recursive case WHERE", () => {
      const ast = createAst({
        predicates: [
          {
            targetAlias: "target",
            targetType: "node",
            expression: {
              __type: "comparison",
              op: "eq",
              left: createFieldRef("target", ["props", "enabled"]),
              right: { __type: "literal", value: true, valueType: "boolean" },
            },
          },
        ],
      });

      const sqlString = getSqlString(ast);

      // Target node predicates should be applied to the joined node 'n'
      // in the recursive case
      expect(sqlString).toContain("enabled");
    });
  });
});

// ============================================================
// MAX_RECURSIVE_DEPTH constant
// ============================================================

describe("MAX_RECURSIVE_DEPTH", () => {
  it("is a reasonable limit", () => {
    expect(MAX_RECURSIVE_DEPTH).toBeGreaterThanOrEqual(50);
    expect(MAX_RECURSIVE_DEPTH).toBeLessThanOrEqual(1000);
  });

  it("is exported and accessible", () => {
    expect(typeof MAX_RECURSIVE_DEPTH).toBe("number");
  });
});

describe("MAX_EXPLICIT_RECURSIVE_DEPTH", () => {
  it("is a reasonable limit", () => {
    expect(MAX_EXPLICIT_RECURSIVE_DEPTH).toBeGreaterThanOrEqual(500);
    expect(MAX_EXPLICIT_RECURSIVE_DEPTH).toBeLessThanOrEqual(5000);
  });

  it("is exported and accessible", () => {
    expect(typeof MAX_EXPLICIT_RECURSIVE_DEPTH).toBe("number");
  });
});
