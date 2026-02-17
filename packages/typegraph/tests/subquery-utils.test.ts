/**
 * Subquery Utilities Unit Tests
 *
 * Tests type compatibility, column count, and value type resolution
 * for IN/NOT IN subquery predicates.
 */
import { describe, expect, it } from "vitest";

import type { QueryAst, ValueType } from "../src/query/ast";
import {
  getSingleSubqueryColumnValueType,
  getSubqueryColumnCount,
  isInSubqueryTypeCompatible,
  isUnsupportedInSubqueryValueType,
} from "../src/query/subquery-utils";

// ============================================================
// Helpers
// ============================================================

function makeSubqueryAst(
  projectionFields: {
    outputName: string;
    valueType?: ValueType;
  }[],
  selectiveFields?: {
    alias: string;
    field: string;
    outputName: string;
    isSystemField: boolean;
    valueType?: ValueType;
  }[],
): QueryAst {
  return {
    start: { alias: "q", kinds: ["Item"], includeSubClasses: false },
    traversals: [],
    predicates: [],
    projection: {
      fields: projectionFields.map((field) => ({
        outputName: field.outputName,
        source: {
          __type: "field_ref" as const,
          alias: "q",
          path: ["props", field.outputName],
          valueType: field.valueType,
        },
      })),
    },
    temporalMode: { mode: "current" },
    ...(selectiveFields === undefined ? {} : { selectiveFields }),
  };
}

function makeAggregateSubqueryAst(
  aggregateFunction: "count" | "countDistinct" | "sum" | "avg" | "min" | "max",
  fieldValueType?: ValueType,
): QueryAst {
  return {
    start: { alias: "q", kinds: ["Item"], includeSubClasses: false },
    traversals: [],
    predicates: [],
    projection: {
      fields: [
        {
          outputName: "agg",
          source: {
            __type: "aggregate" as const,
            function: aggregateFunction,
            field: {
              __type: "field_ref" as const,
              alias: "q",
              path: ["props", "value"],
              valueType: fieldValueType,
            },
          },
        },
      ],
    },
    temporalMode: { mode: "current" },
  };
}

// ============================================================
// isUnsupportedInSubqueryValueType
// ============================================================

describe("isUnsupportedInSubqueryValueType", () => {
  it("returns true for array type", () => {
    expect(isUnsupportedInSubqueryValueType("array")).toBe(true);
  });

  it("returns true for object type", () => {
    expect(isUnsupportedInSubqueryValueType("object")).toBe(true);
  });

  it("returns true for embedding type", () => {
    expect(isUnsupportedInSubqueryValueType("embedding")).toBe(true);
  });

  it("returns false for string type", () => {
    expect(isUnsupportedInSubqueryValueType("string")).toBe(false);
  });

  it("returns false for number type", () => {
    expect(isUnsupportedInSubqueryValueType("number")).toBe(false);
  });

  it("returns false for boolean type", () => {
    expect(isUnsupportedInSubqueryValueType("boolean")).toBe(false);
  });

  it("returns false for date type", () => {
    expect(isUnsupportedInSubqueryValueType("date")).toBe(false);
  });

  it("returns false for undefined (unknown) type", () => {
    expect(isUnsupportedInSubqueryValueType()).toBe(false);
  });

  it("returns false for explicit 'unknown' type (normalized to undefined)", () => {
    expect(isUnsupportedInSubqueryValueType("unknown")).toBe(false);
  });
});

// ============================================================
// isInSubqueryTypeCompatible
// ============================================================

describe("isInSubqueryTypeCompatible", () => {
  it("compatible when both types are undefined", () => {
    expect(isInSubqueryTypeCompatible()).toBe(true);
  });

  it("compatible when left is undefined", () => {
    expect(isInSubqueryTypeCompatible(undefined, "string")).toBe(true);
  });

  it("compatible when right is undefined", () => {
    expect(isInSubqueryTypeCompatible("number")).toBe(true);
  });

  it("compatible when both are 'unknown'", () => {
    expect(isInSubqueryTypeCompatible("unknown", "unknown")).toBe(true);
  });

  it("compatible when left is 'unknown' and right is a concrete type", () => {
    expect(isInSubqueryTypeCompatible("unknown", "string")).toBe(true);
  });

  it("compatible when both types match", () => {
    expect(isInSubqueryTypeCompatible("string", "string")).toBe(true);
    expect(isInSubqueryTypeCompatible("number", "number")).toBe(true);
    expect(isInSubqueryTypeCompatible("boolean", "boolean")).toBe(true);
    expect(isInSubqueryTypeCompatible("date", "date")).toBe(true);
  });

  it("incompatible when types differ", () => {
    expect(isInSubqueryTypeCompatible("string", "number")).toBe(false);
    expect(isInSubqueryTypeCompatible("number", "boolean")).toBe(false);
    expect(isInSubqueryTypeCompatible("date", "string")).toBe(false);
  });
});

// ============================================================
// getSubqueryColumnCount
// ============================================================

describe("getSubqueryColumnCount", () => {
  it("returns count based on projection fields", () => {
    const ast = makeSubqueryAst([
      { outputName: "id", valueType: "string" },
      { outputName: "name", valueType: "string" },
    ]);
    expect(getSubqueryColumnCount(ast)).toBe(2);
  });

  it("returns 1 for single column projection", () => {
    const ast = makeSubqueryAst([{ outputName: "id", valueType: "string" }]);
    expect(getSubqueryColumnCount(ast)).toBe(1);
  });

  it("prefers selectiveFields over projection when present", () => {
    const ast = makeSubqueryAst(
      [
        { outputName: "id", valueType: "string" },
        { outputName: "name", valueType: "string" },
      ],
      [
        {
          alias: "q",
          field: "id",
          outputName: "q_id",
          isSystemField: true,
          valueType: "string",
        },
      ],
    );
    // selectiveFields has 1 entry, so column count should be 1
    expect(getSubqueryColumnCount(ast)).toBe(1);
  });

  it("returns count from aggregate projection", () => {
    const ast = makeAggregateSubqueryAst("count");
    expect(getSubqueryColumnCount(ast)).toBe(1);
  });
});

// ============================================================
// getSingleSubqueryColumnValueType
// ============================================================

describe("getSingleSubqueryColumnValueType", () => {
  it("returns the value type for a single column projection", () => {
    const ast = makeSubqueryAst([{ outputName: "name", valueType: "string" }]);
    expect(getSingleSubqueryColumnValueType(ast)).toBe("string");
  });

  it("returns undefined for multi-column projection", () => {
    const ast = makeSubqueryAst([
      { outputName: "id", valueType: "string" },
      { outputName: "name", valueType: "string" },
    ]);
    expect(getSingleSubqueryColumnValueType(ast)).toBeUndefined();
  });

  it("returns undefined when single column has undefined valueType", () => {
    const ast = makeSubqueryAst([{ outputName: "data" }]);
    expect(getSingleSubqueryColumnValueType(ast)).toBeUndefined();
  });

  it("normalizes 'unknown' to undefined", () => {
    const ast = makeSubqueryAst([{ outputName: "data", valueType: "unknown" }]);
    expect(getSingleSubqueryColumnValueType(ast)).toBeUndefined();
  });

  it("returns 'number' for count aggregate", () => {
    const ast = makeAggregateSubqueryAst("count");
    expect(getSingleSubqueryColumnValueType(ast)).toBe("number");
  });

  it("returns 'number' for sum aggregate", () => {
    const ast = makeAggregateSubqueryAst("sum");
    expect(getSingleSubqueryColumnValueType(ast)).toBe("number");
  });

  it("returns 'number' for avg aggregate", () => {
    const ast = makeAggregateSubqueryAst("avg");
    expect(getSingleSubqueryColumnValueType(ast)).toBe("number");
  });

  it("returns field valueType for min aggregate", () => {
    const ast = makeAggregateSubqueryAst("min", "date");
    expect(getSingleSubqueryColumnValueType(ast)).toBe("date");
  });

  it("returns field valueType for max aggregate", () => {
    const ast = makeAggregateSubqueryAst("max", "number");
    expect(getSingleSubqueryColumnValueType(ast)).toBe("number");
  });

  it("returns undefined for min/max with 'unknown' valueType", () => {
    const ast = makeAggregateSubqueryAst("min", "unknown");
    expect(getSingleSubqueryColumnValueType(ast)).toBeUndefined();
  });

  it("prefers selectiveFields when present", () => {
    const ast = makeSubqueryAst(
      [{ outputName: "id", valueType: "string" }],
      [
        {
          alias: "q",
          field: "age",
          outputName: "q_age",
          isSystemField: false,
          valueType: "number",
        },
      ],
    );
    expect(getSingleSubqueryColumnValueType(ast)).toBe("number");
  });
});
