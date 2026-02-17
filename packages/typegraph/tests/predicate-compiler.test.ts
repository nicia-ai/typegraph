/**
 * Unit tests for predicate expression compilation.
 *
 * Tests the compilation of predicate AST nodes to SQL.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { UnsupportedPredicateError } from "../src/errors";
import {
  type ArrayPredicate,
  type BetweenPredicate,
  type ComparisonPredicate,
  type FieldRef,
  type LiteralValue,
  type NullPredicate,
  type ObjectPredicate,
  type PredicateExpression,
  type QueryAst,
  type StringPredicate,
} from "../src/query/ast";
import {
  compileFieldColumn,
  compileFieldValue,
  compilePredicateExpression,
  extractVectorSimilarityPredicates,
  type PredicateCompilerContext,
} from "../src/query/compiler/predicates";
import { DEFAULT_SQL_SCHEMA } from "../src/query/compiler/schema";
import { postgresDialect } from "../src/query/dialect/postgres";
import { sqliteDialect } from "../src/query/dialect/sqlite";
import { type JsonPointer } from "../src/query/json-pointer";
import { toSqlString } from "./sql-test-utils";

// ============================================================
// Test Helpers
// ============================================================

/**
 * Creates a field reference for testing.
 */
function field(
  alias: string,
  path: readonly string[],
  options?: { jsonPointer?: JsonPointer; valueType?: FieldRef["valueType"] },
): FieldRef {
  return {
    __type: "field_ref",
    alias,
    path,
    jsonPointer: options?.jsonPointer,
    valueType: options?.valueType,
  };
}

/**
 * Creates a JsonPointer from a string for testing.
 */
function ptr(pointer: string): JsonPointer {
  return pointer as JsonPointer;
}

/**
 * Creates a minimal QueryAst for subquery tests.
 */
function subqueryAst(alias: string, kind: string, graphId?: string): QueryAst {
  const base: QueryAst = {
    start: {
      alias,
      kinds: [kind],
      includeSubClasses: false,
    },
    traversals: [],
    predicates: [],
    projection: {
      fields: [
        {
          outputName: `${alias}_id`,
          source: field(alias, ["id"], { valueType: "string" }),
        },
      ],
    },
    temporalMode: { mode: "current" },
  };
  if (graphId !== undefined) {
    return { ...base, graphId };
  }
  return base;
}

/**
 * Creates a literal value for testing.
 */
function literal(
  value: string | number | boolean,
  valueType?: LiteralValue["valueType"],
): LiteralValue {
  return { __type: "literal", value, valueType };
}

/**
 * Creates compiler context with SQLite dialect.
 */
function createContext(cteColumnPrefix?: string): PredicateCompilerContext {
  const base: PredicateCompilerContext = {
    dialect: sqliteDialect,
    schema: DEFAULT_SQL_SCHEMA,
    compileQuery: () => sql`SELECT 1`,
  };
  if (cteColumnPrefix !== undefined) {
    return { ...base, cteColumnPrefix };
  }
  return base;
}

// ============================================================
// Field Column Compilation
// ============================================================

describe("compileFieldColumn", () => {
  describe("without CTE prefix", () => {
    it("compiles id field with alias", () => {
      const f = field("p", ["id"]);
      const result = compileFieldColumn(f);
      expect(toSqlString(result)).toBe("p_id");
    });

    it("compiles kind field with alias", () => {
      const f = field("n", ["kind"]);
      const result = compileFieldColumn(f);
      expect(toSqlString(result)).toBe("n_kind");
    });

    it("compiles props field with alias", () => {
      const f = field("x", ["props"]);
      const result = compileFieldColumn(f);
      expect(toSqlString(result)).toBe("x_props");
    });

    it("compiles nested props path with alias", () => {
      const f = field("p", ["props", "name"]);
      const result = compileFieldColumn(f);
      expect(toSqlString(result)).toBe("p_props");
    });

    it("compiles custom path with underscore join", () => {
      const f = field("a", ["custom", "path"]);
      const result = compileFieldColumn(f);
      expect(toSqlString(result)).toBe("a_custom_path");
    });
  });

  describe("with CTE alias", () => {
    it("includes CTE alias qualifier", () => {
      const f = field("p", ["id"]);
      const result = compileFieldColumn(f, "cte_p");
      expect(toSqlString(result)).toBe("cte_p.p_id");
    });

    it("qualifies props field", () => {
      const f = field("n", ["props", "value"]);
      const result = compileFieldColumn(f, "cte_n");
      expect(toSqlString(result)).toBe("cte_n.n_props");
    });
  });

  describe("with CTE column prefix (empty string)", () => {
    it("uses raw id column without qualifier", () => {
      const f = field("p", ["id"]);
      const result = compileFieldColumn(f, undefined, "");
      expect(toSqlString(result)).toBe("id");
    });

    it("uses raw kind column without qualifier", () => {
      const f = field("p", ["kind"]);
      const result = compileFieldColumn(f, undefined, "");
      expect(toSqlString(result)).toBe("kind");
    });

    it("uses raw props column without qualifier", () => {
      const f = field("p", ["props", "name"]);
      const result = compileFieldColumn(f, undefined, "");
      expect(toSqlString(result)).toBe("props");
    });
  });

  describe("with CTE column prefix (table alias)", () => {
    it("qualifies id column with table alias", () => {
      const f = field("p", ["id"]);
      const result = compileFieldColumn(f, undefined, "n");
      expect(toSqlString(result)).toBe("n.id");
    });

    it("qualifies kind column with table alias", () => {
      const f = field("p", ["kind"]);
      const result = compileFieldColumn(f, undefined, "n");
      expect(toSqlString(result)).toBe("n.kind");
    });

    it("qualifies props column with table alias", () => {
      const f = field("p", ["props"]);
      const result = compileFieldColumn(f, undefined, "n");
      expect(toSqlString(result)).toBe("n.props");
    });

    it("joins custom path segments", () => {
      const f = field("p", ["custom", "field"]);
      const result = compileFieldColumn(f, undefined, "t");
      expect(toSqlString(result)).toBe("t.custom_field");
    });
  });
});

// ============================================================
// Field Value Compilation
// ============================================================

describe("compileFieldValue", () => {
  describe("non-JSON fields", () => {
    it("returns column directly for id field", () => {
      const f = field("p", ["id"]);
      const result = compileFieldValue(f, sqliteDialect, "string");
      expect(toSqlString(result)).toBe("p_id");
    });

    it("returns column directly for kind field", () => {
      const f = field("p", ["kind"]);
      const result = compileFieldValue(f, sqliteDialect, "string");
      expect(toSqlString(result)).toBe("p_kind");
    });
  });

  describe("JSON fields with type extraction", () => {
    it("extracts text for string type", () => {
      const f = field("p", ["props", "name"]);
      const result = compileFieldValue(f, sqliteDialect, "string");
      expect(toSqlString(result)).toContain("json_extract");
    });

    it("extracts number for number type", () => {
      const f = field("p", ["props", "age"]);
      const result = compileFieldValue(f, sqliteDialect, "number");
      expect(toSqlString(result)).toContain("json_extract");
    });

    it("extracts boolean for boolean type", () => {
      const f = field("p", ["props", "active"]);
      const result = compileFieldValue(f, sqliteDialect, "boolean");
      expect(toSqlString(result)).toContain("json_extract");
    });

    it("extracts date for date type", () => {
      const f = field("p", ["props", "createdAt"]);
      const result = compileFieldValue(f, sqliteDialect, "date");
      expect(toSqlString(result)).toContain("json_extract");
    });

    it("extracts JSON for array type", () => {
      const f = field("p", ["props", "tags"]);
      const result = compileFieldValue(f, sqliteDialect, "array");
      expect(toSqlString(result)).toContain("json_extract");
    });

    it("extracts JSON for object type", () => {
      const f = field("p", ["props", "metadata"]);
      const result = compileFieldValue(f, sqliteDialect, "object");
      expect(toSqlString(result)).toContain("json_extract");
    });

    it("extracts text for undefined type", () => {
      const f = field("p", ["props", "value"]);
      const result = compileFieldValue(f, sqliteDialect);
      expect(toSqlString(result)).toContain("json_extract");
    });

    it("treats unknown type as undefined", () => {
      const f = field("p", ["props", "value"]);
      const result = compileFieldValue(f, sqliteDialect, "unknown");
      expect(toSqlString(result)).toContain("json_extract");
    });
  });

  describe("with JSON pointer override", () => {
    it("uses override pointer instead of field path", () => {
      const f = field("p", ["props"]);
      const result = compileFieldValue(
        f,
        sqliteDialect,
        "string",
        undefined,
        ptr("/custom/path"),
      );
      expect(toSqlString(result)).toContain("json_extract");
    });
  });

  describe("with explicit jsonPointer on field", () => {
    it("uses field jsonPointer when present", () => {
      const f = field("p", ["props", "data"], {
        jsonPointer: ptr("/nested/value"),
      });
      const result = compileFieldValue(f, sqliteDialect, "string");
      expect(toSqlString(result)).toContain("json_extract");
    });
  });

  describe("props without nested path", () => {
    it("returns column directly when no JSON path", () => {
      const f = field("p", ["props"]);
      const result = compileFieldValue(f, sqliteDialect, "object");
      expect(toSqlString(result)).toBe("p_props");
    });
  });
});

// ============================================================
// Comparison Predicates
// ============================================================

describe("comparison predicates", () => {
  const ctx = createContext();

  describe("basic operators", () => {
    it("compiles eq operator", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "eq",
        left: field("p", ["props", "name"]),
        right: literal("test"),
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain("=");
    });

    it("compiles neq operator", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "neq",
        left: field("p", ["props", "status"]),
        right: literal("deleted"),
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain("!=");
    });

    it("compiles gt operator", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "gt",
        left: field("p", ["props", "count"], { valueType: "number" }),
        right: literal(10, "number"),
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain(">");
    });

    it("compiles gte operator", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "gte",
        left: field("p", ["props", "score"], { valueType: "number" }),
        right: literal(50, "number"),
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain(">=");
    });

    it("compiles lt operator", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "lt",
        left: field("p", ["props", "priority"], { valueType: "number" }),
        right: literal(5, "number"),
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain("<");
    });

    it("compiles lte operator", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "lte",
        left: field("p", ["props", "level"], { valueType: "number" }),
        right: literal(100, "number"),
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain("<=");
    });
  });

  describe("in/notIn operators", () => {
    it("compiles in with multiple values", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "in",
        left: field("p", ["props", "status"]),
        right: [literal("active"), literal("pending"), literal("review")],
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain("IN");
    });

    it("compiles notIn with multiple values", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "notIn",
        left: field("p", ["props", "type"]),
        right: [literal("spam"), literal("deleted")],
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain("NOT IN");
    });

    it("compiles in with empty array as always false", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "in",
        left: field("p", ["props", "id"]),
        right: [],
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toBe("1=0");
    });

    it("compiles notIn with empty array as always true", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "notIn",
        left: field("p", ["props", "id"]),
        right: [],
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toBe("1=1");
    });

    it("compiles in with single value as array", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "in",
        left: field("p", ["id"]),
        right: [literal("abc123")],
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain("IN");
    });
  });

  describe("type coercion", () => {
    it("uses date extraction for date field with string literal", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "gt",
        left: field("p", ["props", "createdAt"], { valueType: "date" }),
        right: literal("2024-01-01T00:00:00Z", "string"),
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain("json_extract");
    });
  });

  describe("error cases", () => {
    it("throws for array value comparison", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "eq",
        left: field("p", ["props", "tags"], { valueType: "array" }),
        right: literal("test", "array"),
      };
      expect(() => compilePredicateExpression(expr, ctx)).toThrow(
        UnsupportedPredicateError,
      );
    });

    it("throws for object value comparison", () => {
      const expr: ComparisonPredicate = {
        __type: "comparison",
        op: "eq",
        left: field("p", ["props", "meta"], { valueType: "object" }),
        right: literal("test", "object"),
      };
      expect(() => compilePredicateExpression(expr, ctx)).toThrow(
        UnsupportedPredicateError,
      );
    });
  });
});

// ============================================================
// String Predicates
// ============================================================

describe("string predicates", () => {
  const ctx = createContext();

  it("compiles contains operator", () => {
    const expr: StringPredicate = {
      __type: "string_op",
      op: "contains",
      field: field("p", ["props", "description"]),
      pattern: "search",
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("LIKE");
    expect(toSqlString(result)).toContain("%");
  });

  it("compiles startsWith operator", () => {
    const expr: StringPredicate = {
      __type: "string_op",
      op: "startsWith",
      field: field("p", ["props", "title"]),
      pattern: "Hello",
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("LIKE");
  });

  it("compiles endsWith operator", () => {
    const expr: StringPredicate = {
      __type: "string_op",
      op: "endsWith",
      field: field("p", ["props", "email"]),
      pattern: ".com",
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("LIKE");
  });

  it("compiles like operator", () => {
    const expr: StringPredicate = {
      __type: "string_op",
      op: "like",
      field: field("p", ["props", "pattern"]),
      pattern: "test%value",
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("LIKE");
  });

  it("compiles ilike operator with case insensitivity", () => {
    const expr: StringPredicate = {
      __type: "string_op",
      op: "ilike",
      field: field("p", ["props", "name"]),
      pattern: "test",
    };
    const result = compilePredicateExpression(expr, ctx);
    // SQLite uses LOWER() for ilike
    expect(toSqlString(result)).toContain("LOWER");
  });

  it("escapes special LIKE characters in contains", () => {
    const expr: StringPredicate = {
      __type: "string_op",
      op: "contains",
      field: field("p", ["props", "text"]),
      pattern: "100%_discount",
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("LIKE");
  });
});

// ============================================================
// Null Check Predicates
// ============================================================

describe("null check predicates", () => {
  const ctx = createContext();

  it("compiles isNull check", () => {
    const expr: NullPredicate = {
      __type: "null_check",
      op: "isNull",
      field: field("p", ["props", "deletedAt"]),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("IS NULL");
  });

  it("compiles isNotNull check", () => {
    const expr: NullPredicate = {
      __type: "null_check",
      op: "isNotNull",
      field: field("p", ["props", "name"]),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("IS NOT NULL");
  });
});

// ============================================================
// Between Predicates
// ============================================================

describe("between predicates", () => {
  const ctx = createContext();

  it("compiles between for numeric values", () => {
    const expr: BetweenPredicate = {
      __type: "between",
      field: field("p", ["props", "score"], { valueType: "number" }),
      lower: literal(0, "number"),
      upper: literal(100, "number"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("BETWEEN");
    expect(toSqlString(result)).toContain("AND");
  });

  it("compiles between for date values", () => {
    const expr: BetweenPredicate = {
      __type: "between",
      field: field("p", ["props", "createdAt"], { valueType: "date" }),
      lower: literal("2024-01-01T00:00:00Z", "date"),
      upper: literal("2024-12-31T23:59:59Z", "date"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("BETWEEN");
  });

  it("throws for array type between", () => {
    const expr: BetweenPredicate = {
      __type: "between",
      field: field("p", ["props", "values"], { valueType: "array" }),
      lower: literal(0, "array"),
      upper: literal(10, "array"),
    };
    expect(() => compilePredicateExpression(expr, ctx)).toThrow(
      UnsupportedPredicateError,
    );
  });

  it("throws for object type between", () => {
    const expr: BetweenPredicate = {
      __type: "between",
      field: field("p", ["props", "data"], { valueType: "object" }),
      lower: literal(0, "object"),
      upper: literal(10, "object"),
    };
    expect(() => compilePredicateExpression(expr, ctx)).toThrow(
      UnsupportedPredicateError,
    );
  });
});

// ============================================================
// Logical Predicates (AND, OR, NOT)
// ============================================================

describe("logical predicates", () => {
  const ctx = createContext();

  describe("and predicate", () => {
    it("joins predicates with AND", () => {
      const expr: PredicateExpression = {
        __type: "and",
        predicates: [
          {
            __type: "comparison",
            op: "eq",
            left: field("p", ["props", "status"]),
            right: literal("active"),
          },
          {
            __type: "comparison",
            op: "gt",
            left: field("p", ["props", "score"], { valueType: "number" }),
            right: literal(50, "number"),
          },
        ],
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain("AND");
    });

    it("wraps compound AND in parentheses", () => {
      const expr: PredicateExpression = {
        __type: "and",
        predicates: [
          {
            __type: "comparison",
            op: "eq",
            left: field("p", ["props", "a"]),
            right: literal(1, "number"),
          },
          {
            __type: "comparison",
            op: "eq",
            left: field("p", ["props", "b"]),
            right: literal(2, "number"),
          },
        ],
      };
      const result = compilePredicateExpression(expr, ctx);
      const sqlString = toSqlString(result);
      expect(sqlString.startsWith("(")).toBe(true);
      expect(sqlString.endsWith(")")).toBe(true);
    });
  });

  describe("or predicate", () => {
    it("joins predicates with OR", () => {
      const expr: PredicateExpression = {
        __type: "or",
        predicates: [
          {
            __type: "comparison",
            op: "eq",
            left: field("p", ["props", "type"]),
            right: literal("admin"),
          },
          {
            __type: "comparison",
            op: "eq",
            left: field("p", ["props", "type"]),
            right: literal("moderator"),
          },
        ],
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain("OR");
    });
  });

  describe("not predicate", () => {
    it("wraps predicate with NOT", () => {
      const expr: PredicateExpression = {
        __type: "not",
        predicate: {
          __type: "comparison",
          op: "eq",
          left: field("p", ["props", "deleted"]),
          right: literal(true, "boolean"),
        },
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain("NOT");
    });

    it("wraps complex expression in parentheses", () => {
      const expr: PredicateExpression = {
        __type: "not",
        predicate: {
          __type: "and",
          predicates: [
            {
              __type: "comparison",
              op: "eq",
              left: field("p", ["props", "a"]),
              right: literal(1, "number"),
            },
            {
              __type: "comparison",
              op: "eq",
              left: field("p", ["props", "b"]),
              right: literal(2, "number"),
            },
          ],
        },
      };
      const result = compilePredicateExpression(expr, ctx);
      expect(toSqlString(result)).toContain("NOT (");
    });
  });

  describe("nested logical expressions", () => {
    it("compiles deeply nested AND/OR/NOT", () => {
      const expr: PredicateExpression = {
        __type: "and",
        predicates: [
          {
            __type: "or",
            predicates: [
              {
                __type: "comparison",
                op: "eq",
                left: field("p", ["props", "a"]),
                right: literal(1, "number"),
              },
              {
                __type: "comparison",
                op: "eq",
                left: field("p", ["props", "b"]),
                right: literal(2, "number"),
              },
            ],
          },
          {
            __type: "not",
            predicate: {
              __type: "comparison",
              op: "eq",
              left: field("p", ["props", "c"]),
              right: literal(3, "number"),
            },
          },
        ],
      };
      const result = compilePredicateExpression(expr, ctx);
      const sqlString = toSqlString(result);
      expect(sqlString).toContain("AND");
      expect(sqlString).toContain("OR");
      expect(sqlString).toContain("NOT");
    });
  });
});

// ============================================================
// Array Predicates
// ============================================================

describe("array predicates", () => {
  const ctx = createContext();

  it("compiles isEmpty", () => {
    const expr: ArrayPredicate = {
      __type: "array_op",
      op: "isEmpty",
      field: field("p", ["props", "tags"]),
    };
    const result = compilePredicateExpression(expr, ctx);
    const sqlString = toSqlString(result);
    expect(sqlString).toContain("IS NULL");
    expect(sqlString).toContain("json_array_length");
    expect(sqlString).toContain("= 0");
  });

  it("compiles isNotEmpty", () => {
    const expr: ArrayPredicate = {
      __type: "array_op",
      op: "isNotEmpty",
      field: field("p", ["props", "items"]),
    };
    const result = compilePredicateExpression(expr, ctx);
    const sqlString = toSqlString(result);
    expect(sqlString).toContain("IS NOT NULL");
    expect(sqlString).toContain("json_array_length");
    expect(sqlString).toContain("> 0");
  });

  it("compiles lengthEq", () => {
    const expr: ArrayPredicate = {
      __type: "array_op",
      op: "lengthEq",
      field: field("p", ["props", "tags"]),
      length: 5,
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("json_array_length");
    expect(toSqlString(result)).toContain("=");
  });

  it("compiles lengthGt", () => {
    const expr: ArrayPredicate = {
      __type: "array_op",
      op: "lengthGt",
      field: field("p", ["props", "tags"]),
      length: 3,
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain(">");
  });

  it("compiles lengthGte", () => {
    const expr: ArrayPredicate = {
      __type: "array_op",
      op: "lengthGte",
      field: field("p", ["props", "tags"]),
      length: 3,
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain(">=");
  });

  it("compiles lengthLt", () => {
    const expr: ArrayPredicate = {
      __type: "array_op",
      op: "lengthLt",
      field: field("p", ["props", "tags"]),
      length: 10,
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("<");
  });

  it("compiles lengthLte", () => {
    const expr: ArrayPredicate = {
      __type: "array_op",
      op: "lengthLte",
      field: field("p", ["props", "tags"]),
      length: 10,
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("<=");
  });

  it("compiles contains with value", () => {
    const expr: ArrayPredicate = {
      __type: "array_op",
      op: "contains",
      field: field("p", ["props", "tags"]),
      values: [literal("important")],
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("json_each");
  });

  it("compiles contains with undefined value as false", () => {
    const expr: ArrayPredicate = {
      __type: "array_op",
      op: "contains",
      field: field("p", ["props", "tags"]),
      values: [],
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toBe("1=0");
  });

  it("compiles containsAll with multiple values", () => {
    const expr: ArrayPredicate = {
      __type: "array_op",
      op: "containsAll",
      field: field("p", ["props", "tags"]),
      values: [literal("a"), literal("b"), literal("c")],
    };
    const result = compilePredicateExpression(expr, ctx);
    const sqlString = toSqlString(result);
    expect(sqlString).toContain("AND");
    expect(sqlString).toContain("json_each");
  });

  it("compiles containsAll with empty values as true", () => {
    const expr: ArrayPredicate = {
      __type: "array_op",
      op: "containsAll",
      field: field("p", ["props", "tags"]),
      values: [],
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toBe("1=1");
  });

  it("compiles containsAny with multiple values", () => {
    const expr: ArrayPredicate = {
      __type: "array_op",
      op: "containsAny",
      field: field("p", ["props", "tags"]),
      values: [literal("x"), literal("y")],
    };
    const result = compilePredicateExpression(expr, ctx);
    const sqlString = toSqlString(result);
    expect(sqlString).toContain("OR");
    expect(sqlString).toContain("json_each");
  });

  it("compiles containsAny with empty values as false", () => {
    const expr: ArrayPredicate = {
      __type: "array_op",
      op: "containsAny",
      field: field("p", ["props", "tags"]),
      values: [],
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toBe("1=0");
  });
});

// ============================================================
// Object Predicates
// ============================================================

describe("object predicates", () => {
  const ctx = createContext();

  it("compiles hasKey", () => {
    const expr: ObjectPredicate = {
      __type: "object_op",
      op: "hasKey",
      field: field("p", ["props", "metadata"]),
      pointer: ptr("/settings"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("json_type");
    expect(toSqlString(result)).toContain("IS NOT NULL");
  });

  it("compiles hasPath", () => {
    const expr: ObjectPredicate = {
      __type: "object_op",
      op: "hasPath",
      field: field("p", ["props", "config"]),
      pointer: ptr("/deep/nested/value"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("json_type");
  });

  it("compiles pathEquals", () => {
    const expr: ObjectPredicate = {
      __type: "object_op",
      op: "pathEquals",
      field: field("p", ["props", "settings"]),
      pointer: ptr("/theme"),
      value: literal("dark"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("=");
  });

  it("throws for pathEquals without value", () => {
    const expr: ObjectPredicate = {
      __type: "object_op",
      op: "pathEquals",
      field: field("p", ["props", "settings"]),
      pointer: ptr("/theme"),
    };
    expect(() => compilePredicateExpression(expr, ctx)).toThrow(
      UnsupportedPredicateError,
    );
  });

  it("throws for pathEquals with array type", () => {
    const expr: ObjectPredicate = {
      __type: "object_op",
      op: "pathEquals",
      field: field("p", ["props", "data"]),
      pointer: ptr("/items"),
      value: literal("test", "array"),
      valueType: "array",
    };
    expect(() => compilePredicateExpression(expr, ctx)).toThrow(
      UnsupportedPredicateError,
    );
  });

  it("throws for pathEquals with object type", () => {
    const expr: ObjectPredicate = {
      __type: "object_op",
      op: "pathEquals",
      field: field("p", ["props", "data"]),
      pointer: ptr("/nested"),
      value: literal("test", "object"),
      valueType: "object",
    };
    expect(() => compilePredicateExpression(expr, ctx)).toThrow(
      UnsupportedPredicateError,
    );
  });

  it("compiles pathContains", () => {
    const expr: ObjectPredicate = {
      __type: "object_op",
      op: "pathContains",
      field: field("p", ["props", "data"]),
      pointer: ptr("/tags"),
      value: literal("featured"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("json_each");
  });

  it("throws for pathContains without value", () => {
    const expr: ObjectPredicate = {
      __type: "object_op",
      op: "pathContains",
      field: field("p", ["props", "data"]),
      pointer: ptr("/tags"),
    };
    expect(() => compilePredicateExpression(expr, ctx)).toThrow(
      UnsupportedPredicateError,
    );
  });

  it("compiles pathIsNull", () => {
    const expr: ObjectPredicate = {
      __type: "object_op",
      op: "pathIsNull",
      field: field("p", ["props", "metadata"]),
      pointer: ptr("/optional"),
    };
    const result = compilePredicateExpression(expr, ctx);
    const sqlString = toSqlString(result);
    expect(sqlString).toContain("IS NULL");
  });

  it("compiles pathIsNotNull", () => {
    const expr: ObjectPredicate = {
      __type: "object_op",
      op: "pathIsNotNull",
      field: field("p", ["props", "metadata"]),
      pointer: ptr("/required"),
    };
    const result = compilePredicateExpression(expr, ctx);
    const sqlString = toSqlString(result);
    expect(sqlString).toContain("IS NOT NULL");
  });
});

// ============================================================
// Aggregate Predicates
// ============================================================

describe("aggregate predicates", () => {
  const ctx = createContext();

  it("compiles count aggregate", () => {
    const expr: PredicateExpression = {
      __type: "aggregate_comparison",
      op: "gt",
      aggregate: {
        __type: "aggregate",
        function: "count",
        field: field("p", ["id"]),
      },
      value: literal(5, "number"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("COUNT");
  });

  it("compiles countDistinct aggregate", () => {
    const expr: PredicateExpression = {
      __type: "aggregate_comparison",
      op: "eq",
      aggregate: {
        __type: "aggregate",
        function: "countDistinct",
        field: field("p", ["props", "category"]),
      },
      value: literal(10, "number"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("COUNT(DISTINCT");
  });

  it("compiles sum aggregate", () => {
    const expr: PredicateExpression = {
      __type: "aggregate_comparison",
      op: "gte",
      aggregate: {
        __type: "aggregate",
        function: "sum",
        field: field("p", ["props", "amount"], { valueType: "number" }),
      },
      value: literal(1000, "number"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("SUM");
  });

  it("compiles avg aggregate", () => {
    const expr: PredicateExpression = {
      __type: "aggregate_comparison",
      op: "lt",
      aggregate: {
        __type: "aggregate",
        function: "avg",
        field: field("p", ["props", "score"], { valueType: "number" }),
      },
      value: literal(50, "number"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("AVG");
  });

  it("compiles min aggregate", () => {
    const expr: PredicateExpression = {
      __type: "aggregate_comparison",
      op: "neq",
      aggregate: {
        __type: "aggregate",
        function: "min",
        field: field("p", ["props", "priority"], { valueType: "number" }),
      },
      value: literal(0, "number"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("MIN");
  });

  it("compiles max aggregate", () => {
    const expr: PredicateExpression = {
      __type: "aggregate_comparison",
      op: "lte",
      aggregate: {
        __type: "aggregate",
        function: "max",
        field: field("p", ["props", "level"], { valueType: "number" }),
      },
      value: literal(100, "number"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("MAX");
  });

  it("throws for unknown aggregate function", () => {
    const expr: PredicateExpression = {
      __type: "aggregate_comparison",
      op: "eq",
      aggregate: {
        __type: "aggregate",
        function: "median" as "count", // Invalid function
        field: field("p", ["props", "value"]),
      },
      value: literal(50, "number"),
    };
    expect(() => compilePredicateExpression(expr, ctx)).toThrow(
      UnsupportedPredicateError,
    );
  });

  it("throws for unsupported comparison operator", () => {
    const expr: PredicateExpression = {
      __type: "aggregate_comparison",
      op: "like" as "eq", // Invalid operator for aggregate
      aggregate: {
        __type: "aggregate",
        function: "count",
        field: field("p", ["id"]),
      },
      value: literal(5, "number"),
    };
    expect(() => compilePredicateExpression(expr, ctx)).toThrow(
      UnsupportedPredicateError,
    );
  });
});

// ============================================================
// Subquery Predicates
// ============================================================

describe("subquery predicates", () => {
  it("compiles EXISTS subquery", () => {
    const ctx: PredicateCompilerContext = {
      dialect: sqliteDialect,
      schema: DEFAULT_SQL_SCHEMA,
      compileQuery: () => sql`SELECT 1 FROM users WHERE active = 1`,
    };

    const expr: PredicateExpression = {
      __type: "exists",
      negated: false,
      subquery: subqueryAst("u", "User", "test"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("EXISTS");
  });

  it("compiles NOT EXISTS subquery", () => {
    const ctx: PredicateCompilerContext = {
      dialect: sqliteDialect,
      schema: DEFAULT_SQL_SCHEMA,
      compileQuery: () => sql`SELECT 1 FROM deleted_users`,
    };

    const expr: PredicateExpression = {
      __type: "exists",
      negated: true,
      subquery: subqueryAst("u", "User", "test"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("NOT EXISTS");
  });

  it("compiles IN subquery", () => {
    const ctx: PredicateCompilerContext = {
      dialect: sqliteDialect,
      schema: DEFAULT_SQL_SCHEMA,
      compileQuery: () => sql`SELECT user_id FROM admins`,
    };

    const expr: PredicateExpression = {
      __type: "in_subquery",
      negated: false,
      field: field("p", ["id"]),
      subquery: subqueryAst("a", "Admin", "test"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("IN");
  });

  it("compiles IN subquery with type-aware field extraction", () => {
    const ctx: PredicateCompilerContext = {
      dialect: postgresDialect,
      schema: DEFAULT_SQL_SCHEMA,
      compileQuery: () => sql`SELECT score FROM scores`,
    };

    const expr: PredicateExpression = {
      __type: "in_subquery",
      negated: false,
      field: field("p", ["props", "score"], { valueType: "number" }),
      subquery: {
        ...subqueryAst("s", "Score", "test"),
        projection: {
          fields: [
            {
              outputName: "score",
              source: field("s", ["props", "score"], { valueType: "number" }),
            },
          ],
        },
      },
    };
    const result = compilePredicateExpression(expr, ctx);
    const sqlString = toSqlString(result);

    expect(sqlString).toContain("::numeric");
    expect(sqlString).toContain(" IN (");
  });

  it("compiles NOT IN subquery", () => {
    const ctx: PredicateCompilerContext = {
      dialect: sqliteDialect,
      schema: DEFAULT_SQL_SCHEMA,
      compileQuery: () => sql`SELECT blocked_id FROM blocklist`,
    };

    const expr: PredicateExpression = {
      __type: "in_subquery",
      negated: true,
      field: field("p", ["props", "userId"]),
      subquery: subqueryAst("b", "Blocked", "test"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("NOT IN");
  });

  it("rejects IN subqueries that project more than one column", () => {
    const ctx: PredicateCompilerContext = {
      dialect: sqliteDialect,
      schema: DEFAULT_SQL_SCHEMA,
      compileQuery: () => sql`SELECT user_id, role FROM admins`,
    };

    const expr: PredicateExpression = {
      __type: "in_subquery",
      negated: false,
      field: field("p", ["id"]),
      subquery: {
        ...subqueryAst("a", "Admin", "test"),
        projection: {
          fields: [
            {
              outputName: "a_id",
              source: field("a", ["id"], { valueType: "string" }),
            },
            {
              outputName: "a_role",
              source: field("a", ["props", "role"], { valueType: "string" }),
            },
          ],
        },
      },
    };

    expect(() => compilePredicateExpression(expr, ctx)).toThrow(
      "must project exactly 1 column",
    );
  });

  it("rejects IN subqueries with known scalar type mismatches", () => {
    const ctx: PredicateCompilerContext = {
      dialect: postgresDialect,
      schema: DEFAULT_SQL_SCHEMA,
      compileQuery: () => sql`SELECT name FROM people`,
    };

    const expr: PredicateExpression = {
      __type: "in_subquery",
      negated: false,
      field: field("p", ["props", "age"], { valueType: "number" }),
      subquery: {
        ...subqueryAst("a", "Admin", "test"),
        projection: {
          fields: [
            {
              outputName: "a_name",
              source: field("a", ["props", "name"], { valueType: "string" }),
            },
          ],
        },
      },
    };

    expect(() => compilePredicateExpression(expr, ctx)).toThrow(
      "type mismatch",
    );
  });

  it("rejects IN subqueries with non-scalar value types", () => {
    const ctx: PredicateCompilerContext = {
      dialect: sqliteDialect,
      schema: DEFAULT_SQL_SCHEMA,
      compileQuery: () => sql`SELECT profile FROM people`,
    };

    const expr: PredicateExpression = {
      __type: "in_subquery",
      negated: false,
      field: field("p", ["props", "profile"], { valueType: "object" }),
      subquery: {
        ...subqueryAst("a", "Admin", "test"),
        projection: {
          fields: [
            {
              outputName: "a_profile",
              source: field("a", ["props", "profile"], {
                valueType: "object",
              }),
            },
          ],
        },
      },
    };

    expect(() => compilePredicateExpression(expr, ctx)).toThrow(
      "does not support object values",
    );
  });

  it("throws when graphId is not specified on EXISTS subquery", () => {
    const ctx: PredicateCompilerContext = {
      dialect: sqliteDialect,
      schema: DEFAULT_SQL_SCHEMA,
      compileQuery: () => sql`SELECT 1`,
    };

    const expr: PredicateExpression = {
      __type: "exists",
      negated: false,
      subquery: subqueryAst("u", "User"), // graphId not specified
    };
    expect(() => compilePredicateExpression(expr, ctx)).toThrow(
      "EXISTS subquery must have a graphId",
    );
  });
});

// ============================================================
// Vector Similarity Predicates
// ============================================================

describe("vector similarity predicates", () => {
  const ctx = createContext();

  it("returns no-op condition for vector similarity", () => {
    const expr: PredicateExpression = {
      __type: "vector_similarity",
      field: field("p", ["props", "embedding"], { valueType: "embedding" }),
      queryEmbedding: [0.1, 0.2, 0.3],
      metric: "cosine",
      limit: 10,
    };
    const result = compilePredicateExpression(expr, ctx);
    // Vector similarity is handled by query structure, not predicate
    expect(toSqlString(result)).toBe("1=1");
  });
});

// ============================================================
// Extract Vector Similarity Predicates
// ============================================================

describe("extractVectorSimilarityPredicates", () => {
  it("extracts vector_similarity from flat predicate list", () => {
    const predicates = [
      {
        expression: {
          __type: "vector_similarity",
          field: field("p", ["props", "embedding"]),
          queryEmbedding: [0.1, 0.2],
          metric: "cosine",
          limit: 5,
        } as PredicateExpression,
      },
    ];
    const result = extractVectorSimilarityPredicates(predicates);
    expect(result).toHaveLength(1);
    expect(result[0]!.__type).toBe("vector_similarity");
  });

  it("extracts from nested AND predicates", () => {
    const predicates = [
      {
        expression: {
          __type: "and",
          predicates: [
            {
              __type: "comparison",
              op: "eq",
              left: field("p", ["props", "active"]),
              right: literal(true),
            },
            {
              __type: "vector_similarity",
              field: field("p", ["props", "embedding"]),
              queryEmbedding: [0.1, 0.2],
              metric: "l2",
              limit: 10,
            },
          ],
        } as PredicateExpression,
      },
    ];
    const result = extractVectorSimilarityPredicates(predicates);
    expect(result).toHaveLength(1);
  });

  it("rejects vector predicates nested under OR", () => {
    const predicates = [
      {
        expression: {
          __type: "or",
          predicates: [
            {
              __type: "vector_similarity",
              field: field("p", ["props", "emb1"]),
              queryEmbedding: [0.1],
              metric: "cosine",
              limit: 5,
            },
            {
              __type: "vector_similarity",
              field: field("p", ["props", "emb2"]),
              queryEmbedding: [0.2],
              metric: "l2",
              limit: 5,
            },
          ],
        } as PredicateExpression,
      },
    ];
    expect(() => extractVectorSimilarityPredicates(predicates)).toThrow(
      /cannot be nested under OR or NOT/i,
    );
  });

  it("rejects vector predicates nested under NOT", () => {
    const predicates = [
      {
        expression: {
          __type: "not",
          predicate: {
            __type: "vector_similarity",
            field: field("p", ["props", "embedding"]),
            queryEmbedding: [0.1],
            metric: "cosine",
            limit: 5,
          },
        } as PredicateExpression,
      },
    ];
    expect(() => extractVectorSimilarityPredicates(predicates)).toThrow(
      /cannot be nested under OR or NOT/i,
    );
  });

  it("returns empty array when no vector predicates", () => {
    const predicates = [
      {
        expression: {
          __type: "comparison",
          op: "eq",
          left: field("p", ["props", "name"]),
          right: literal("test"),
        } as PredicateExpression,
      },
    ];
    const result = extractVectorSimilarityPredicates(predicates);
    expect(result).toHaveLength(0);
  });

  it("handles empty predicate list", () => {
    const result = extractVectorSimilarityPredicates([]);
    expect(result).toHaveLength(0);
  });

  it("rejects deeply nested vector predicates under OR/NOT", () => {
    const predicates = [
      {
        expression: {
          __type: "and",
          predicates: [
            {
              __type: "or",
              predicates: [
                {
                  __type: "not",
                  predicate: {
                    __type: "and",
                    predicates: [
                      {
                        __type: "vector_similarity",
                        field: field("p", ["props", "embedding"]),
                        queryEmbedding: [0.1],
                        metric: "cosine",
                        limit: 5,
                      },
                      {
                        __type: "comparison",
                        op: "eq",
                        left: field("p", ["props", "x"]),
                        right: literal(1),
                      },
                    ],
                  },
                },
                {
                  __type: "comparison",
                  op: "eq",
                  left: field("p", ["props", "y"]),
                  right: literal(2),
                },
              ],
            },
            {
              __type: "comparison",
              op: "eq",
              left: field("p", ["props", "z"]),
              right: literal(3),
            },
          ],
        } as PredicateExpression,
      },
    ];
    expect(() => extractVectorSimilarityPredicates(predicates)).toThrow(
      /cannot be nested under OR or NOT/i,
    );
  });
});

// ============================================================
// CTE Column Prefix Context
// ============================================================

describe("CTE column prefix context", () => {
  it("uses raw column names with empty prefix", () => {
    const ctx = createContext("");
    const expr: ComparisonPredicate = {
      __type: "comparison",
      op: "eq",
      left: field("p", ["id"]),
      right: literal("abc123"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("id");
    expect(toSqlString(result)).not.toContain("p_id");
  });

  it("uses table-qualified names with prefix", () => {
    const ctx = createContext("n");
    const expr: ComparisonPredicate = {
      __type: "comparison",
      op: "eq",
      left: field("p", ["props", "name"]),
      right: literal("test"),
    };
    const result = compilePredicateExpression(expr, ctx);
    expect(toSqlString(result)).toContain("n.props");
  });
});

// ============================================================
// Mixed Value Types Error
// ============================================================

describe("mixed literal value types", () => {
  it("throws for mixed types in comparison array", () => {
    const ctx = createContext();
    const expr: ComparisonPredicate = {
      __type: "comparison",
      op: "in",
      left: field("p", ["props", "value"]),
      right: [literal(1, "number"), literal("two", "string")],
    };
    expect(() => compilePredicateExpression(expr, ctx)).toThrow(
      UnsupportedPredicateError,
    );
  });
});
