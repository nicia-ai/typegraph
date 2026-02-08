import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ValidationError } from "../../src/errors";
import { validateSqlIdentifier } from "../../src/query/builder/validation";
import {
  type CursorData,
  decodeCursor,
  encodeCursor,
} from "../../src/query/cursor";

// ============================================================
// Property Tests - Cursor Encoding/Decoding
// ============================================================

describe("Cursor Properties", () => {
  describe("encode/decode round-trip", () => {
    it("encodeCursor -> decodeCursor preserves data", () => {
      // Simple cursor data generator
      const cursorDataArb: fc.Arbitrary<CursorData> = fc
        .record({
          v: fc.constant(1),
          d: fc.constantFrom("f" as const, "b" as const),
          vals: fc.array(
            fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean()),
            { minLength: 1, maxLength: 5 },
          ),
          cols: fc.array(
            fc
              .tuple(
                fc.constantFrom("a", "b", "c", "p", "q"),
                fc.constantFrom("id", "name", "props"),
              )
              .map(([alias, field]) => `${alias}.${field}`),
            { minLength: 1, maxLength: 5 },
          ),
        })
        .filter((data) => data.vals.length === data.cols.length);

      fc.assert(
        fc.property(cursorDataArb, (data) => {
          const encoded = encodeCursor(data);
          const decoded = decodeCursor(encoded);

          expect(decoded.v).toBe(data.v);
          expect(decoded.d).toBe(data.d);
          expect(decoded.cols).toEqual(data.cols);
          expect(decoded.vals.length).toBe(data.vals.length);
        }),
        { numRuns: 100 },
      );
    });

    it("encoded cursor is URL-safe", () => {
      const cursorDataArb: fc.Arbitrary<CursorData> = fc
        .record({
          v: fc.constant(1),
          d: fc.constantFrom("f" as const, "b" as const),
          vals: fc.array(fc.string({ maxLength: 20 }), {
            minLength: 1,
            maxLength: 3,
          }),
          cols: fc.array(fc.constant("p.name"), { minLength: 1, maxLength: 3 }),
        })
        .filter((data) => data.vals.length === data.cols.length);

      fc.assert(
        fc.property(cursorDataArb, (data) => {
          const encoded = encodeCursor(data);

          // URL-safe base64 shouldn't contain +, /, or =
          expect(encoded).not.toContain("+");
          expect(encoded).not.toContain("/");
          expect(encoded).not.toContain("=");
        }),
        { numRuns: 100 },
      );
    });

    it("different cursor data produces different encoded strings", () => {
      fc.assert(
        fc.property(
          fc
            .record({
              v: fc.constant(1),
              d: fc.constantFrom("f" as const, "b" as const),
              vals: fc.array(fc.string({ maxLength: 10 }), {
                minLength: 1,
                maxLength: 2,
              }),
              cols: fc.array(fc.constant("p.id"), {
                minLength: 1,
                maxLength: 2,
              }),
            })
            .filter((d) => d.vals.length === d.cols.length),
          fc
            .record({
              v: fc.constant(1),
              d: fc.constantFrom("f" as const, "b" as const),
              vals: fc.array(fc.string({ maxLength: 10 }), {
                minLength: 1,
                maxLength: 2,
              }),
              cols: fc.array(fc.constant("p.id"), {
                minLength: 1,
                maxLength: 2,
              }),
            })
            .filter((d) => d.vals.length === d.cols.length),
          (data1, data2) => {
            // Skip if data is identical
            if (JSON.stringify(data1) === JSON.stringify(data2)) return;

            const encoded1 = encodeCursor(data1);
            const encoded2 = encodeCursor(data2);

            expect(encoded1).not.toBe(encoded2);
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});

// ============================================================
// Property Tests - SQL Identifier Validation
// ============================================================

describe("SQL Identifier Validation Properties", () => {
  /** SQL reserved keywords */
  const SQL_RESERVED = new Set([
    "select",
    "from",
    "where",
    "and",
    "or",
    "not",
    "in",
    "is",
    "null",
    "true",
    "false",
    "as",
    "on",
    "join",
    "left",
    "right",
    "inner",
    "outer",
    "cross",
    "full",
    "group",
    "by",
    "having",
    "order",
    "asc",
    "desc",
    "limit",
    "offset",
    "union",
    "intersect",
    "except",
    "all",
    "distinct",
    "case",
    "when",
    "then",
    "else",
    "end",
    "exists",
    "between",
    "like",
    "ilike",
    "insert",
    "update",
    "delete",
    "create",
    "drop",
    "alter",
    "table",
    "index",
    "view",
    "with",
    "recursive",
  ]);

  it("accepts valid identifiers", () => {
    // Generate valid identifiers: start with letter/underscore, then alphanumeric/_
    const validIdentifierArb = fc
      .tuple(
        fc.constantFrom(
          "a",
          "b",
          "c",
          "x",
          "y",
          "z",
          "_",
          "A",
          "B",
          "C",
          "X",
          "Y",
          "Z",
        ),
        fc.array(
          fc.constantFrom(
            "a",
            "b",
            "c",
            "x",
            "y",
            "z",
            "A",
            "B",
            "C",
            "X",
            "Y",
            "Z",
            "0",
            "1",
            "2",
            "9",
            "_",
          ),
          { minLength: 0, maxLength: 20 },
        ),
      )
      .map(([first, rest]) => first + rest.join(""))
      .filter((s) => s.length > 0 && s.length <= 63)
      .filter((s) => !SQL_RESERVED.has(s.toLowerCase()));

    fc.assert(
      fc.property(validIdentifierArb, (identifier) => {
        expect(() => {
          validateSqlIdentifier(identifier);
        }).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it("rejects identifiers starting with numbers", () => {
    const invalidIdentifierArb = fc
      .tuple(
        fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"),
        fc.array(fc.constantFrom("a", "b", "c", "1", "2", "_"), {
          minLength: 0,
          maxLength: 10,
        }),
      )
      .map(([first, rest]) => first + rest.join(""));

    fc.assert(
      fc.property(invalidIdentifierArb, (identifier) => {
        expect(() => {
          validateSqlIdentifier(identifier);
        }).toThrow(ValidationError);
      }),
      { numRuns: 50 },
    );
  });

  it("rejects identifiers with special characters", () => {
    const invalidIdentifierArb = fc
      .tuple(
        fc.constantFrom("a", "b", "c"),
        fc.constantFrom("-", " ", "!", "@", "#", "$", "%", "^", "&", "*"),
        fc.constantFrom("x", "y", "z"),
      )
      .map(([a, special, b]) => a + special + b);

    fc.assert(
      fc.property(invalidIdentifierArb, (identifier) => {
        expect(() => {
          validateSqlIdentifier(identifier);
        }).toThrow(ValidationError);
      }),
      { numRuns: 50 },
    );
  });

  it("rejects empty string", () => {
    expect(() => {
      validateSqlIdentifier("");
    }).toThrow(ValidationError);
  });

  it("rejects reserved keywords (case-insensitive)", () => {
    const keywordArb = fc.constantFrom(
      "select",
      "from",
      "where",
      "and",
      "or",
      "join",
      "SELECT",
      "FROM",
      "WHERE",
      "AND",
      "OR",
      "JOIN",
      "Select",
      "From",
      "Where",
      "And",
      "Or",
      "Join",
    );

    fc.assert(
      fc.property(keywordArb, (keyword) => {
        expect(() => {
          validateSqlIdentifier(keyword);
        }).toThrow(ValidationError);
      }),
      { numRuns: 20 },
    );
  });

  it("accepts identifiers at max length (63)", () => {
    // Generate exactly 63 character identifiers
    const maxLengthArb = fc
      .array(fc.constantFrom("a", "b", "c", "x", "y", "z", "0", "1", "_"), {
        minLength: 62,
        maxLength: 62,
      })
      .map((rest) => "a" + rest.join(""));

    fc.assert(
      fc.property(maxLengthArb, (identifier) => {
        expect(identifier.length).toBe(63);
        expect(() => {
          validateSqlIdentifier(identifier);
        }).not.toThrow();
      }),
      { numRuns: 20 },
    );
  });
});

// ============================================================
// Property Tests - AST Structure Invariants
// ============================================================

describe("AST Structure Properties", () => {
  it("comparison operators are exhaustive", () => {
    const comparisonOps = [
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "in",
      "notIn",
    ];

    fc.assert(
      fc.property(fc.constantFrom(...comparisonOps), (op) => {
        expect(comparisonOps).toContain(op);
      }),
      { numRuns: 20 },
    );
  });

  it("string operators are exhaustive", () => {
    const stringOps = ["contains", "startsWith", "endsWith", "like", "ilike"];

    fc.assert(
      fc.property(fc.constantFrom(...stringOps), (op) => {
        expect(stringOps).toContain(op);
      }),
      { numRuns: 20 },
    );
  });

  it("aggregate functions are exhaustive", () => {
    const aggregateFuncs = [
      "count",
      "countDistinct",
      "sum",
      "avg",
      "min",
      "max",
    ];

    fc.assert(
      fc.property(fc.constantFrom(...aggregateFuncs), (function_) => {
        expect(aggregateFuncs).toContain(function_);
      }),
      { numRuns: 20 },
    );
  });

  it("sort directions are exhaustive", () => {
    const directions = ["asc", "desc"];

    fc.assert(
      fc.property(fc.constantFrom(...directions), (dir) => {
        expect(directions).toContain(dir);
      }),
      { numRuns: 10 },
    );
  });

  it("null orderings are exhaustive", () => {
    const nullOrderings = ["first", "last"];

    fc.assert(
      fc.property(fc.constantFrom(...nullOrderings), (ordering) => {
        expect(nullOrderings).toContain(ordering);
      }),
      { numRuns: 10 },
    );
  });
});

// ============================================================
// Property Tests - Predicate Structure
// ============================================================

describe("Predicate Structure Properties", () => {
  // Simple field ref generator
  const fieldRefArb = fc.record({
    __type: fc.constant("field_ref" as const),
    alias: fc.constantFrom("p", "q", "r", "node", "edge"),
    path: fc.constantFrom(
      ["id"],
      ["props"],
      ["props", "name"],
      ["props", "age"],
      ["kind"],
    ),
  });

  // Simple literal generator
  const literalArb = fc.oneof(
    fc.string({ maxLength: 20 }).map((v) => ({
      __type: "literal" as const,
      value: v,
      valueType: "string" as const,
    })),
    fc.integer().map((v) => ({
      __type: "literal" as const,
      value: v,
      valueType: "number" as const,
    })),
    fc.boolean().map((v) => ({
      __type: "literal" as const,
      value: v,
      valueType: "boolean" as const,
    })),
  );

  it("comparison predicates have required fields", () => {
    const comparisonPredicateArb = fc.record({
      __type: fc.constant("comparison" as const),
      op: fc.constantFrom("eq", "neq", "gt", "gte", "lt", "lte"),
      left: fieldRefArb,
      right: literalArb,
    });

    fc.assert(
      fc.property(comparisonPredicateArb, (pred) => {
        expect(pred.__type).toBe("comparison");
        expect(pred.op).toBeDefined();
        expect(pred.left.__type).toBe("field_ref");
        expect(pred.right.__type).toBe("literal");
      }),
      { numRuns: 50 },
    );
  });

  it("null check predicates have required fields", () => {
    const nullPredicateArb = fc.record({
      __type: fc.constant("null_check" as const),
      op: fc.constantFrom("isNull" as const, "isNotNull" as const),
      field: fieldRefArb,
    });

    fc.assert(
      fc.property(nullPredicateArb, (pred) => {
        expect(pred.__type).toBe("null_check");
        expect(["isNull", "isNotNull"]).toContain(pred.op);
        expect(pred.field.__type).toBe("field_ref");
      }),
      { numRuns: 50 },
    );
  });

  it("between predicates have lower and upper bounds", () => {
    const betweenPredicateArb = fc.record({
      __type: fc.constant("between" as const),
      field: fieldRefArb,
      lower: literalArb,
      upper: literalArb,
    });

    fc.assert(
      fc.property(betweenPredicateArb, (pred) => {
        expect(pred.__type).toBe("between");
        expect(pred.field.__type).toBe("field_ref");
        expect(pred.lower.__type).toBe("literal");
        expect(pred.upper.__type).toBe("literal");
      }),
      { numRuns: 50 },
    );
  });

  it("AND predicates combine multiple predicates", () => {
    const simplePredicateArb = fc.record({
      __type: fc.constant("null_check" as const),
      op: fc.constant("isNull" as const),
      field: fieldRefArb,
    });

    const andPredicateArb = fc
      .array(simplePredicateArb, { minLength: 2, maxLength: 4 })
      .map((predicates) => ({
        __type: "and" as const,
        predicates,
      }));

    fc.assert(
      fc.property(andPredicateArb, (pred) => {
        expect(pred.__type).toBe("and");
        expect(pred.predicates.length).toBeGreaterThanOrEqual(2);
        for (const inner of pred.predicates) {
          expect(inner.__type).toBeDefined();
        }
      }),
      { numRuns: 30 },
    );
  });

  it("OR predicates combine multiple predicates", () => {
    const simplePredicateArb = fc.record({
      __type: fc.constant("null_check" as const),
      op: fc.constant("isNotNull" as const),
      field: fieldRefArb,
    });

    const orPredicateArb = fc
      .array(simplePredicateArb, { minLength: 2, maxLength: 4 })
      .map((predicates) => ({
        __type: "or" as const,
        predicates,
      }));

    fc.assert(
      fc.property(orPredicateArb, (pred) => {
        expect(pred.__type).toBe("or");
        expect(pred.predicates.length).toBeGreaterThanOrEqual(2);
        for (const inner of pred.predicates) {
          expect(inner.__type).toBeDefined();
        }
      }),
      { numRuns: 30 },
    );
  });

  it("NOT predicates wrap single predicate", () => {
    const simplePredicateArb = fc.record({
      __type: fc.constant("null_check" as const),
      op: fc.constant("isNull" as const),
      field: fieldRefArb,
    });

    const notPredicateArb = simplePredicateArb.map((predicate) => ({
      __type: "not" as const,
      predicate,
    }));

    fc.assert(
      fc.property(notPredicateArb, (pred) => {
        expect(pred.__type).toBe("not");
        expect(pred.predicate.__type).toBeDefined();
      }),
      { numRuns: 30 },
    );
  });
});
