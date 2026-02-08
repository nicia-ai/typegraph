/**
 * Unit tests for set operation compilation.
 *
 * Tests UNION, INTERSECT, EXCEPT compilation to SQL.
 */
import { type SQL, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  type FieldRef,
  type OrderSpec,
  type QueryAst,
  type SetOperation,
} from "../src/query/ast";
import { DEFAULT_SQL_SCHEMA } from "../src/query/compiler/schema";
import {
  compileSetOperation,
  type QueryCompilerFunction,
} from "../src/query/compiler/set-operations";
import { sqliteDialect } from "../src/query/dialect";
import { jsonPointer } from "../src/query/json-pointer";
import { toSqlString } from "./sql-test-utils";

// ============================================================
// Test Helpers
// ============================================================

function createMinimalAst(alias: string, extraFields: string[] = []): QueryAst {
  const fields = [
    {
      outputName: "id",
      source: {
        __type: "field_ref" as const,
        alias,
        path: ["id"] as readonly string[],
      },
    },
    // Add extra projected fields (JSON props)
    ...extraFields.map((field) => ({
      outputName: field,
      source: {
        __type: "field_ref" as const,
        alias,
        path: ["props", field] as readonly string[],
        jsonPointer: jsonPointer([field]),
        valueType: "string" as const,
      },
    })),
  ];
  return {
    start: {
      alias,
      kinds: ["TestKind"],
      includeSubClasses: false,
    },
    traversals: [],
    predicates: [],
    projection: { fields },
    temporalMode: { mode: "current" },
  };
}

function createSetOperation(
  operator: SetOperation["operator"],
  leftAlias = "a",
  rightAlias = "b",
  extraFields: string[] = [],
): SetOperation {
  return {
    __type: "set_operation",
    operator,
    left: createMinimalAst(leftAlias, extraFields),
    right: createMinimalAst(rightAlias, extraFields),
  };
}

function createFieldRef(alias: string, field: string): FieldRef {
  return {
    __type: "field_ref",
    alias,
    path: ["props", field],
    jsonPointer: jsonPointer([field]),
    valueType: "string",
  };
}

function createOrderSpec(
  alias: string,
  field: string,
  direction: "asc" | "desc" = "asc",
): OrderSpec {
  return {
    field: createFieldRef(alias, field),
    direction,
  };
}

function mockCompileQuery(ast: QueryAst, _graphId: string): SQL {
  // Return a simple mock SQL that identifies the query by its start alias
  return sql`SELECT * FROM ${sql.raw(ast.start.alias)}`;
}

function getSqlString(
  op: SetOperation,
  compileQuery: QueryCompilerFunction = mockCompileQuery,
): string {
  const result = compileSetOperation(
    op,
    "test-graph",
    sqliteDialect,
    DEFAULT_SQL_SCHEMA,
    compileQuery,
  );
  return toSqlString(result);
}

// ============================================================
// Basic Set Operations
// ============================================================

describe("compileSetOperation", () => {
  describe("basic operations", () => {
    it("compiles UNION operation", () => {
      const op = createSetOperation("union");

      const sql = getSqlString(op);

      expect(sql).toContain("UNION");
      expect(sql).not.toContain("UNION ALL");
    });

    it("compiles UNION ALL operation", () => {
      const op = createSetOperation("unionAll");

      const sql = getSqlString(op);

      expect(sql).toContain("UNION ALL");
    });

    it("compiles INTERSECT operation", () => {
      const op = createSetOperation("intersect");

      const sql = getSqlString(op);

      expect(sql).toContain("INTERSECT");
    });

    it("compiles EXCEPT operation", () => {
      const op = createSetOperation("except");

      const sql = getSqlString(op);

      expect(sql).toContain("EXCEPT");
    });

    it("produces correct SQLite format with merged CTEs", () => {
      const op = createSetOperation("union");

      const sql = getSqlString(op);

      // SQLite uses merged CTEs: WITH cte1 AS (...), cte2 AS (...) SELECT ... UNION SELECT ...
      // No parentheses around individual queries (SQLite doesn't support CTEs in parentheses)
      expect(sql).toMatch(/WITH\s+cte_q0_a/);
      expect(sql).toMatch(/cte_q1_b/);
      expect(sql).toMatch(
        /SELECT.*FROM\s+cte_q0_a.*UNION.*SELECT.*FROM\s+cte_q1_b/s,
      );
    });
  });

  // ============================================================
  // Nested Set Operations
  // ============================================================

  describe("nested operations", () => {
    it("compiles nested set operation on left side", () => {
      const inner = createSetOperation("union", "inner1", "inner2");
      const outer: SetOperation = {
        __type: "set_operation",
        operator: "intersect",
        left: inner,
        right: createMinimalAst("outer"),
      };

      const sql = getSqlString(outer);

      expect(sql).toContain("UNION");
      expect(sql).toContain("INTERSECT");
    });

    it("compiles nested set operation on right side", () => {
      const inner = createSetOperation("except", "inner1", "inner2");
      const outer: SetOperation = {
        __type: "set_operation",
        operator: "union",
        left: createMinimalAst("outer"),
        right: inner,
      };

      const sql = getSqlString(outer);

      expect(sql).toContain("EXCEPT");
      expect(sql).toContain("UNION");
    });

    it("compiles deeply nested operations", () => {
      // (a UNION b) INTERSECT (c EXCEPT d)
      const leftInner = createSetOperation("union", "a", "b");
      const rightInner = createSetOperation("except", "c", "d");
      const outer: SetOperation = {
        __type: "set_operation",
        operator: "intersect",
        left: leftInner,
        right: rightInner,
      };

      const sql = getSqlString(outer);

      expect(sql).toContain("UNION");
      expect(sql).toContain("INTERSECT");
      expect(sql).toContain("EXCEPT");
    });
  });

  // ============================================================
  // ORDER BY
  // ============================================================

  describe("ORDER BY", () => {
    it("adds ORDER BY clause when specified", () => {
      const op: SetOperation = {
        ...createSetOperation("union", "a", "b", ["name"]),
        orderBy: [createOrderSpec("a", "name", "asc")],
      };

      const sql = getSqlString(op);

      expect(sql).toContain("ORDER BY");
      // Should reference output column name, not CTE column
      expect(sql).toContain('"name"');
    });

    it("compiles ascending order with NULLS LAST emulation", () => {
      const op: SetOperation = {
        ...createSetOperation("union", "a", "b", ["name"]),
        orderBy: [createOrderSpec("a", "name", "asc")],
      };

      const sql = getSqlString(op);

      expect(sql).toContain("ORDER BY");
      // IS NULL emulation: (col IS NULL) ASC for NULLS LAST, then col ASC
      expect(sql).toMatch(/\("name" IS NULL\) ASC.*"name" ASC/);
    });

    it("compiles descending order with NULLS FIRST emulation", () => {
      const op: SetOperation = {
        ...createSetOperation("union", "a", "b", ["name"]),
        orderBy: [createOrderSpec("a", "name", "desc")],
      };

      const sql = getSqlString(op);

      expect(sql).toContain("ORDER BY");
      // IS NULL emulation: (col IS NULL) DESC for NULLS FIRST, then col DESC
      expect(sql).toMatch(/\("name" IS NULL\) DESC.*"name" DESC/);
    });

    it("compiles multiple order fields", () => {
      const op: SetOperation = {
        ...createSetOperation("union", "a", "b", ["name", "age"]),
        orderBy: [
          createOrderSpec("a", "name", "asc"),
          createOrderSpec("a", "age", "desc"),
        ],
      };

      const sql = getSqlString(op);

      expect(sql).toContain("ORDER BY");
      expect(sql).toContain('"name"');
      expect(sql).toContain('"age"');
    });

    it("omits ORDER BY when empty array", () => {
      const op: SetOperation = {
        ...createSetOperation("union"),
        orderBy: [],
      };

      const sql = getSqlString(op);

      expect(sql).not.toContain("ORDER BY");
    });

    it("throws descriptive error when ordering by non-projected field", () => {
      const op: SetOperation = {
        // Projection only has "id", not "name"
        ...createSetOperation("union"),
        orderBy: [createOrderSpec("a", "name", "asc")],
      };

      expect(() => getSqlString(op)).toThrow(
        /ORDER BY field.*name.*is not in the projection/,
      );
    });

    it("includes available columns in validation error", () => {
      const op: SetOperation = {
        ...createSetOperation("union", "a", "b", ["email"]),
        orderBy: [createOrderSpec("a", "name", "asc")],
      };

      expect(() => getSqlString(op)).toThrow(/Available columns:.*id.*email/);
    });

    it("throws when ordering with SELECT * (empty projection)", () => {
      // Create a set operation with empty projection (SELECT *)
      const emptyProjectionAst: QueryAst = {
        start: { alias: "a", kinds: ["TestKind"], includeSubClasses: false },
        traversals: [],
        predicates: [],
        projection: { fields: [] }, // SELECT *
        temporalMode: { mode: "current" },
      };
      const op: SetOperation = {
        __type: "set_operation",
        operator: "union",
        left: emptyProjectionAst,
        right: emptyProjectionAst,
        orderBy: [createOrderSpec("a", "name", "asc")],
      };

      expect(() => getSqlString(op)).toThrow(
        /ORDER BY requires explicit field projection/,
      );
    });

    it("normalizes equivalent field representations for matching", () => {
      // Create projection with path: ["props"] + jsonPointer
      const projectionWithPointer: QueryAst = {
        start: { alias: "a", kinds: ["TestKind"], includeSubClasses: false },
        traversals: [],
        predicates: [],
        projection: {
          fields: [
            {
              outputName: "name",
              source: {
                __type: "field_ref",
                alias: "a",
                path: ["props"],
                jsonPointer: jsonPointer(["name"]),
                valueType: "string",
              },
            },
          ],
        },
        temporalMode: { mode: "current" },
      };

      // Create ORDER BY with path: ["props", "name"] (no explicit jsonPointer)
      const orderByWithPath: FieldRef = {
        __type: "field_ref",
        alias: "a",
        path: ["props", "name"], // Equivalent representation
        valueType: "string",
      };

      const op: SetOperation = {
        __type: "set_operation",
        operator: "union",
        left: projectionWithPointer,
        right: projectionWithPointer,
        orderBy: [{ field: orderByWithPath, direction: "asc" }],
      };

      // Should not throw - both representations should be recognized as equivalent
      const sqlString = getSqlString(op);
      expect(sqlString).toContain("ORDER BY");
      expect(sqlString).toContain('"name"');
    });
  });

  // ============================================================
  // LIMIT and OFFSET
  // ============================================================

  describe("LIMIT and OFFSET", () => {
    it("adds LIMIT clause when specified", () => {
      const op: SetOperation = {
        ...createSetOperation("union"),
        limit: 10,
      };

      const sql = getSqlString(op);

      expect(sql).toContain("LIMIT");
      expect(sql).toContain("10");
    });

    it("adds OFFSET clause when specified", () => {
      const op: SetOperation = {
        ...createSetOperation("union"),
        offset: 5,
      };

      const sql = getSqlString(op);

      expect(sql).toContain("OFFSET");
      expect(sql).toContain("5");
    });

    it("combines LIMIT and OFFSET", () => {
      const op: SetOperation = {
        ...createSetOperation("union"),
        limit: 20,
        offset: 10,
      };

      const sql = getSqlString(op);

      expect(sql).toContain("LIMIT");
      expect(sql).toContain("20");
      expect(sql).toContain("OFFSET");
      expect(sql).toContain("10");
    });

    it("combines ORDER BY with LIMIT and OFFSET", () => {
      const op: SetOperation = {
        ...createSetOperation("intersect", "a", "b", ["name"]),
        orderBy: [createOrderSpec("a", "name", "desc")],
        limit: 50,
        offset: 25,
      };

      const sql = getSqlString(op);

      expect(sql).toContain("INTERSECT");
      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("LIMIT");
      expect(sql).toContain("OFFSET");
    });
  });

  // ============================================================
  // Integration with real query compiler
  // ============================================================

  describe("with custom compile function", () => {
    it("SQLite compilation includes graph_id filtering", () => {
      // Note: SQLite uses internal compilation (not custom compile function)
      // to handle CTE merging. The custom compile function is only used
      // for PostgreSQL which supports CTEs in parentheses.
      const op = createSetOperation("union");

      const sqlString = getSqlString(op);

      // SQLite compiles internally but should still include graph_id filtering
      expect(sqlString).toContain("graph_id");
      expect(sqlString).toContain("test-graph");
    });
  });
});
