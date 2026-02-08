import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ValidationError } from "../../src/errors";
import { type FieldRef, type OrderSpec } from "../../src/query/ast";
import {
  buildColumnId,
  buildCursorFromRow,
  type CursorData,
  decodeCursor,
  encodeCursor,
  extractCursorValue,
  validateCursorColumns,
} from "../../src/query/cursor";
import {
  adjustOrderByForDirection,
  buildCursorPredicate,
  buildPaginatedResult,
  parsePaginateOptions,
} from "../../src/query/execution/pagination";
import { jsonPointer } from "../../src/query/json-pointer";

// ============================================================
// Helpers
// ============================================================

function createFieldRef(alias: string, path: readonly string[]): FieldRef {
  return { __type: "field_ref", alias, path };
}

function createOrderSpec(
  alias: string,
  path: readonly string[],
  direction: "asc" | "desc" = "asc",
): OrderSpec {
  return {
    field: createFieldRef(alias, path),
    direction,
  };
}

/**
 * Creates a valid encoded cursor for testing.
 */
function validCursor(direction: "f" | "b" = "f"): string {
  return encodeCursor({
    v: 1,
    d: direction,
    vals: [1],
    cols: ["p.id"],
  });
}

/**
 * Mock context builder for testing paginated results.
 * Cast to any since we only need the row structure for cursor building.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock
const mockBuildContext = (row: Record<string, unknown>) => row as any;

// ============================================================
// Property Tests - Cursor Encoding/Decoding
// ============================================================

describe("Cursor Encoding Properties", () => {
  describe("round-trip", () => {
    it("encode then decode preserves all data", () => {
      const cursorDataArb: fc.Arbitrary<CursorData> = fc
        .record({
          v: fc.constant(1),
          d: fc.constantFrom("f" as const, "b" as const),
          vals: fc.array(
            fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean()),
            { minLength: 1, maxLength: 5 },
          ),
          cols: fc.array(fc.constantFrom("p.id", "p.name", "q.value"), {
            minLength: 1,
            maxLength: 5,
          }),
        })
        .filter((d) => d.vals.length === d.cols.length);

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

    it("encoded cursors are URL-safe", () => {
      const cursorDataArb: fc.Arbitrary<CursorData> = fc
        .record({
          v: fc.constant(1),
          d: fc.constantFrom("f" as const, "b" as const),
          vals: fc.array(fc.string({ maxLength: 30 }), {
            minLength: 1,
            maxLength: 3,
          }),
          cols: fc.array(fc.constant("p.name"), { minLength: 1, maxLength: 3 }),
        })
        .filter((d) => d.vals.length === d.cols.length);

      fc.assert(
        fc.property(cursorDataArb, (data) => {
          const encoded = encodeCursor(data);

          // URL-safe base64: no +, /, or = (padding removed)
          expect(encoded).not.toContain("+");
          expect(encoded).not.toContain("/");
          expect(encoded).not.toContain("=");
        }),
        { numRuns: 100 },
      );
    });

    it("different data produces different cursors", () => {
      const dataArb: fc.Arbitrary<CursorData> = fc
        .record({
          v: fc.constant(1),
          d: fc.constantFrom("f" as const, "b" as const),
          vals: fc.array(fc.integer({ min: 0, max: 1000 }), {
            minLength: 1,
            maxLength: 2,
          }),
          cols: fc.array(fc.constant("p.id"), { minLength: 1, maxLength: 2 }),
        })
        .filter((d) => d.vals.length === d.cols.length);

      fc.assert(
        fc.property(dataArb, dataArb, (data1, data2) => {
          if (JSON.stringify(data1) === JSON.stringify(data2)) return;

          const encoded1 = encodeCursor(data1);
          const encoded2 = encodeCursor(data2);

          expect(encoded1).not.toBe(encoded2);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe("validation", () => {
    it("rejects invalid direction", () => {
      const invalidData = {
        v: 1,
        d: "x", // Invalid
        vals: [1],
        cols: ["p.id"],
      };
      const encoded = btoa(JSON.stringify(invalidData));

      expect(() => decodeCursor(encoded)).toThrow(ValidationError);
    });

    it("rejects mismatched vals/cols length", () => {
      const invalidData = {
        v: 1,
        d: "f",
        vals: [1, 2, 3],
        cols: ["p.id"], // Mismatched length
      };
      const encoded = btoa(JSON.stringify(invalidData));

      expect(() => decodeCursor(encoded)).toThrow(ValidationError);
    });

    it("rejects unsupported version", () => {
      const futureData = {
        v: 999, // Future version
        d: "f",
        vals: [1],
        cols: ["p.id"],
      };
      const encoded = btoa(JSON.stringify(futureData));

      expect(() => decodeCursor(encoded)).toThrow(ValidationError);
    });
  });
});

// ============================================================
// Property Tests - Column ID Building
// ============================================================

describe("Column ID Properties", () => {
  it("produces consistent format: flattens props paths, keeps system paths", () => {
    const specArb = fc.record({
      field: fc.record({
        __type: fc.constant("field_ref" as const),
        alias: fc.constantFrom("p", "q", "node", "edge"),
        path: fc.array(fc.constantFrom("id", "props", "name", "value"), {
          minLength: 1,
          maxLength: 3,
        }),
      }),
      direction: fc.constantFrom("asc" as const, "desc" as const),
    });

    fc.assert(
      fc.property(specArb, (spec) => {
        const columnId = buildColumnId(spec);
        const { alias, path } = spec.field;

        // Props paths are flattened: ["props", "name"] -> "alias.name"
        // System paths are kept as-is: ["id"] -> "alias.id"
        const expected =
          path.length >= 2 && path[0] === "props" ?
            `${alias}.${path.slice(1).join(".")}`
          : `${alias}.${path.join(".")}`;
        expect(columnId).toBe(expected);
      }),
      { numRuns: 50 },
    );
  });

  it("is deterministic", () => {
    const specArb = fc.record({
      field: fc.record({
        __type: fc.constant("field_ref" as const),
        alias: fc.constantFrom("a", "b", "c"),
        path: fc.array(fc.constantFrom("x", "y", "z"), {
          minLength: 1,
          maxLength: 2,
        }),
      }),
      direction: fc.constantFrom("asc" as const, "desc" as const),
    });

    fc.assert(
      fc.property(specArb, (spec) => {
        const id1 = buildColumnId(spec);
        const id2 = buildColumnId(spec);
        expect(id1).toBe(id2);
      }),
      { numRuns: 30 },
    );
  });
});

// ============================================================
// Property Tests - Cursor Value Extraction
// ============================================================

describe("Cursor Value Extraction Properties", () => {
  it("extracts top-level aliased values", () => {
    const valueArb = fc.oneof(
      fc.string({ maxLength: 20 }),
      fc.integer(),
      fc.boolean(),
    );

    fc.assert(
      fc.property(valueArb, (value) => {
        const row = {
          p: { id: value },
        };
        const spec = createOrderSpec("p", ["id"]);

        const extracted = extractCursorValue(row, spec);
        expect(extracted).toBe(value);
      }),
      { numRuns: 50 },
    );
  });

  it("extracts nested props values", () => {
    const valueArb = fc.string({ maxLength: 20 });

    fc.assert(
      fc.property(valueArb, (value) => {
        const row = {
          p: { props: { name: value } },
        };
        const spec = createOrderSpec("p", ["props", "name"]);

        const extracted = extractCursorValue(row, spec);
        expect(extracted).toBe(value);
      }),
      { numRuns: 50 },
    );
  });

  it("extracts flattened props values for cursor fields", () => {
    const valueArb = fc.string({ maxLength: 20 });

    const spec: OrderSpec = {
      field: {
        __type: "field_ref",
        alias: "p",
        path: ["props"],
        jsonPointer: jsonPointer(["name"]),
      },
      direction: "asc",
    };

    fc.assert(
      fc.property(valueArb, (value) => {
        const row = {
          p: { name: value },
        };

        const extracted = extractCursorValue(row, spec);
        expect(extracted).toBe(value);
      }),
      { numRuns: 50 },
    );
  });

  it("returns undefined for missing paths", () => {
    const row = { p: { id: 1 } };
    const spec = createOrderSpec("p", ["props", "missing"]);

    const extracted = extractCursorValue(row, spec);
    expect(extracted).toBeUndefined();
  });

  it("returns undefined for missing alias", () => {
    const row = { p: { id: 1 } };
    const spec = createOrderSpec("q", ["id"]); // Wrong alias

    const extracted = extractCursorValue(row, spec);
    expect(extracted).toBeUndefined();
  });
});

// ============================================================
// Property Tests - Order Direction Adjustment
// ============================================================

describe("Order Direction Adjustment Properties", () => {
  it("forward direction preserves original order", () => {
    const specsArb = fc.array(
      fc.record({
        field: fc.record({
          __type: fc.constant("field_ref" as const),
          alias: fc.constantFrom("p", "q"),
          path: fc.array(fc.constant("id"), { minLength: 1, maxLength: 1 }),
        }),
        direction: fc.constantFrom("asc" as const, "desc" as const),
      }),
      { minLength: 1, maxLength: 3 },
    );

    fc.assert(
      fc.property(specsArb, (specs) => {
        const adjusted = adjustOrderByForDirection(specs, "forward");

        expect(adjusted).toEqual(specs);
      }),
      { numRuns: 30 },
    );
  });

  it("backward direction reverses all directions", () => {
    const specsArb = fc.array(
      fc.record({
        field: fc.record({
          __type: fc.constant("field_ref" as const),
          alias: fc.constantFrom("p", "q"),
          path: fc.array(fc.constant("id"), { minLength: 1, maxLength: 1 }),
        }),
        direction: fc.constantFrom("asc" as const, "desc" as const),
      }),
      { minLength: 1, maxLength: 3 },
    );

    fc.assert(
      fc.property(specsArb, (specs) => {
        const adjusted = adjustOrderByForDirection(specs, "backward");

        for (const [index, spec] of specs.entries()) {
          const original = spec.direction;
          const reversed = adjusted[index]!.direction;

          expect(reversed).toBe(original === "asc" ? "desc" : "asc");
        }
      }),
      { numRuns: 30 },
    );
  });

  it("double reversal returns to original", () => {
    const specsArb = fc.array(
      fc.record({
        field: fc.record({
          __type: fc.constant("field_ref" as const),
          alias: fc.constant("p"),
          path: fc.array(fc.constant("id"), { minLength: 1, maxLength: 1 }),
        }),
        direction: fc.constantFrom("asc" as const, "desc" as const),
      }),
      { minLength: 1, maxLength: 3 },
    );

    fc.assert(
      fc.property(specsArb, (specs) => {
        const once = adjustOrderByForDirection(specs, "backward");
        const twice = adjustOrderByForDirection(once, "backward");

        for (const [index, spec] of specs.entries()) {
          expect(twice[index]!.direction).toBe(spec.direction);
        }
      }),
      { numRuns: 30 },
    );
  });

  it("preserves field references unchanged", () => {
    const spec: OrderSpec = {
      field: createFieldRef("p", ["props", "name"]),
      direction: "asc",
    };

    const adjusted = adjustOrderByForDirection([spec], "backward");

    expect(adjusted[0]!.field).toEqual(spec.field);
  });
});

// ============================================================
// Property Tests - Cursor Predicate Building
// ============================================================

describe("Cursor Predicate Properties", () => {
  describe("single column", () => {
    it("forward ASC uses gt operator", () => {
      const orderBy = [createOrderSpec("p", ["id"], "asc")];
      const cursorData: CursorData = {
        v: 1,
        d: "f",
        vals: [100],
        cols: ["p.id"],
      };

      const predicate = buildCursorPredicate(
        cursorData,
        orderBy,
        "forward",
        "p",
      );

      expect(predicate.expression.__type).toBe("comparison");
      if (predicate.expression.__type !== "comparison") return;
      expect(predicate.expression.op).toBe("gt");
    });

    it("forward DESC uses lt operator", () => {
      const orderBy = [createOrderSpec("p", ["id"], "desc")];
      const cursorData: CursorData = {
        v: 1,
        d: "f",
        vals: [100],
        cols: ["p.id"],
      };

      const predicate = buildCursorPredicate(
        cursorData,
        orderBy,
        "forward",
        "p",
      );

      expect(predicate.expression.__type).toBe("comparison");
      if (predicate.expression.__type !== "comparison") return;
      expect(predicate.expression.op).toBe("lt");
    });

    it("backward ASC uses lt operator", () => {
      const orderBy = [createOrderSpec("p", ["id"], "asc")];
      const cursorData: CursorData = {
        v: 1,
        d: "b",
        vals: [100],
        cols: ["p.id"],
      };

      const predicate = buildCursorPredicate(
        cursorData,
        orderBy,
        "backward",
        "p",
      );

      expect(predicate.expression.__type).toBe("comparison");
      if (predicate.expression.__type !== "comparison") return;
      expect(predicate.expression.op).toBe("lt");
    });

    it("backward DESC uses gt operator", () => {
      const orderBy = [createOrderSpec("p", ["id"], "desc")];
      const cursorData: CursorData = {
        v: 1,
        d: "b",
        vals: [100],
        cols: ["p.id"],
      };

      const predicate = buildCursorPredicate(
        cursorData,
        orderBy,
        "backward",
        "p",
      );

      expect(predicate.expression.__type).toBe("comparison");
      if (predicate.expression.__type !== "comparison") return;
      expect(predicate.expression.op).toBe("gt");
    });
  });

  describe("multiple columns", () => {
    it("creates OR of AND conditions pattern", () => {
      const orderBy = [
        createOrderSpec("p", ["name"], "asc"),
        createOrderSpec("p", ["id"], "asc"),
      ];
      const cursorData: CursorData = {
        v: 1,
        d: "f",
        vals: ["Alice", 100],
        cols: ["p.name", "p.id"],
      };

      const predicate = buildCursorPredicate(
        cursorData,
        orderBy,
        "forward",
        "p",
      );

      // Should be: (name > 'Alice') OR (name = 'Alice' AND id > 100)
      expect(predicate.expression.__type).toBe("or");
      if (predicate.expression.__type !== "or") return;
      expect(predicate.expression.predicates).toHaveLength(2);
      // First: name > 'Alice'
      expect(predicate.expression.predicates[0]!.__type).toBe("comparison");
      // Second: name = 'Alice' AND id > 100
      expect(predicate.expression.predicates[1]!.__type).toBe("and");
    });

    it("three columns creates three OR branches", () => {
      const orderBy = [
        createOrderSpec("p", ["a"], "asc"),
        createOrderSpec("p", ["b"], "asc"),
        createOrderSpec("p", ["c"], "asc"),
      ];
      const cursorData: CursorData = {
        v: 1,
        d: "f",
        vals: [1, 2, 3],
        cols: ["p.a", "p.b", "p.c"],
      };

      const predicate = buildCursorPredicate(
        cursorData,
        orderBy,
        "forward",
        "p",
      );

      // (a > 1) OR (a = 1 AND b > 2) OR (a = 1 AND b = 2 AND c > 3)
      expect(predicate.expression.__type).toBe("or");
      if (predicate.expression.__type !== "or") return;
      expect(predicate.expression.predicates).toHaveLength(3);
    });
  });

  describe("null handling", () => {
    it("null cursor value produces isNull for equality", () => {
      const orderBy = [
        createOrderSpec("p", ["name"], "asc"),
        createOrderSpec("p", ["id"], "asc"),
      ];
      const cursorData: CursorData = {
        v: 1,
        d: "f",
        // eslint-disable-next-line unicorn/no-null -- Testing null handling explicitly
        vals: [null, 100],
        cols: ["p.name", "p.id"],
      };

      const predicate = buildCursorPredicate(
        cursorData,
        orderBy,
        "forward",
        "p",
      );

      // The second OR branch should have: name IS NULL AND id > 100
      expect(predicate.expression.__type).toBe("or");
      const orExpr = predicate.expression;
      expect(orExpr.__type).toBe("or");
      if (orExpr.__type !== "or") return;
      const secondBranch = orExpr.predicates[1];
      expect(secondBranch?.__type).toBe("and");
      if (secondBranch?.__type !== "and") return;
      expect(secondBranch.predicates[0]!.__type).toBe("null_check");
    });

    it("null in comparison produces isNotNull", () => {
      const orderBy = [createOrderSpec("p", ["name"], "asc")];
      const cursorData: CursorData = {
        v: 1,
        d: "f",
        // eslint-disable-next-line unicorn/no-null -- Testing null handling explicitly
        vals: [null],
        cols: ["p.name"],
      };

      const predicate = buildCursorPredicate(
        cursorData,
        orderBy,
        "forward",
        "p",
      );

      expect(predicate.expression.__type).toBe("null_check");
      if (predicate.expression.__type !== "null_check") return;
      expect(predicate.expression.op).toBe("isNotNull");
    });
  });
});

// ============================================================
// Property Tests - Cursor Column Validation
// ============================================================

describe("Cursor Column Validation Properties", () => {
  it("accepts matching columns", () => {
    const orderBy = [
      createOrderSpec("p", ["id"], "asc"),
      createOrderSpec("p", ["name"], "asc"),
    ];
    const cursorData: CursorData = {
      v: 1,
      d: "f",
      vals: [1, "test"],
      cols: ["p.id", "p.name"],
    };

    expect(() => {
      validateCursorColumns(cursorData, orderBy);
    }).not.toThrow();
  });

  it("rejects column count mismatch", () => {
    const orderBy = [createOrderSpec("p", ["id"], "asc")];
    const cursorData: CursorData = {
      v: 1,
      d: "f",
      vals: [1, 2],
      cols: ["p.id", "p.extra"],
    };

    expect(() => {
      validateCursorColumns(cursorData, orderBy);
    }).toThrow(ValidationError);
  });

  it("rejects column name mismatch", () => {
    const orderBy = [createOrderSpec("p", ["id"], "asc")];
    const cursorData: CursorData = {
      v: 1,
      d: "f",
      vals: [1],
      cols: ["p.name"], // Wrong column
    };

    expect(() => {
      validateCursorColumns(cursorData, orderBy);
    }).toThrow(ValidationError);
  });

  it("column order matters", () => {
    const orderBy = [
      createOrderSpec("p", ["id"], "asc"),
      createOrderSpec("p", ["name"], "asc"),
    ];
    const cursorData: CursorData = {
      v: 1,
      d: "f",
      vals: [1, "test"],
      cols: ["p.name", "p.id"], // Swapped order
    };

    expect(() => {
      validateCursorColumns(cursorData, orderBy);
    }).toThrow(ValidationError);
  });
});

// ============================================================
// Property Tests - Pagination Options Parsing
// ============================================================

describe("Pagination Options Parsing Properties", () => {
  it("detects forward pagination from first/after", () => {
    const options1 = { first: 10 };
    const options2 = { first: 10, after: validCursor("f") };

    expect(parsePaginateOptions(options1).isBackward).toBe(false);
    expect(parsePaginateOptions(options2).isBackward).toBe(false);
  });

  it("detects backward pagination from last/before", () => {
    const options1 = { last: 10 };
    const options2 = { last: 10, before: validCursor("b") };

    expect(parsePaginateOptions(options1).isBackward).toBe(true);
    expect(parsePaginateOptions(options2).isBackward).toBe(true);
  });

  it("extracts limit from first or last", () => {
    const limitArb = fc.integer({ min: 1, max: 100 });

    fc.assert(
      fc.property(limitArb, (limit) => {
        const forwardOptions = { first: limit };
        const backwardOptions = { last: limit };

        expect(parsePaginateOptions(forwardOptions).limit).toBe(limit);
        expect(parsePaginateOptions(backwardOptions).limit).toBe(limit);
      }),
      { numRuns: 30 },
    );
  });

  it("defaults to 20 when no limit specified", () => {
    const options = {};
    expect(parsePaginateOptions(options).limit).toBe(20);
  });

  it("extracts cursor from after or before", () => {
    // Generate valid cursor data and encode it
    const cursorDataArb: fc.Arbitrary<CursorData> = fc
      .record({
        v: fc.constant(1),
        d: fc.constantFrom("f" as const, "b" as const),
        vals: fc.array(fc.integer({ min: 1, max: 100 }), {
          minLength: 1,
          maxLength: 2,
        }),
        cols: fc.array(fc.constantFrom("p.id", "p.name"), {
          minLength: 1,
          maxLength: 2,
        }),
      })
      .filter((d) => d.vals.length === d.cols.length);

    fc.assert(
      fc.property(cursorDataArb, (data) => {
        const cursor = encodeCursor(data);
        const afterOptions = { first: 10, after: cursor };
        const beforeOptions = { last: 10, before: cursor };

        expect(parsePaginateOptions(afterOptions).cursor).toBe(cursor);
        expect(parsePaginateOptions(beforeOptions).cursor).toBe(cursor);
      }),
      { numRuns: 30 },
    );
  });
});

// ============================================================
// Property Tests - Paginated Result Construction
// ============================================================

describe("Paginated Result Properties", () => {
  it("hasNextPage/hasPrevPage logic for forward pagination", () => {
    const orderBy = [createOrderSpec("p", ["id"], "asc")];
    const rows = [{ p: { id: 1 } }, { p: { id: 2 } }];
    const data = rows;

    // Forward, has more, no cursor (first page)
    const result1 = buildPaginatedResult(
      data,
      rows,
      orderBy,
      10,
      true, // hasMore
      false, // not backward
      undefined, // no cursor
      mockBuildContext,
    );
    expect(result1.hasNextPage).toBe(true);
    expect(result1.hasPrevPage).toBe(false);

    // Forward, has more, with cursor (middle page)
    const result2 = buildPaginatedResult(
      data,
      rows,
      orderBy,
      10,
      true,
      false,
      "somecursor",
      mockBuildContext,
    );
    expect(result2.hasNextPage).toBe(true);
    expect(result2.hasPrevPage).toBe(true);

    // Forward, no more, with cursor (last page)
    const result3 = buildPaginatedResult(
      data,
      rows,
      orderBy,
      10,
      false, // no more
      false,
      "somecursor",
      mockBuildContext,
    );
    expect(result3.hasNextPage).toBe(false);
    expect(result3.hasPrevPage).toBe(true);
  });

  it("hasNextPage/hasPrevPage logic for backward pagination", () => {
    const orderBy = [createOrderSpec("p", ["id"], "asc")];
    const rows = [{ p: { id: 1 } }, { p: { id: 2 } }];
    const data = rows;

    // Backward, has more, with cursor
    const result1 = buildPaginatedResult(
      data,
      rows,
      orderBy,
      10,
      true, // hasMore
      true, // backward
      "somecursor",
      mockBuildContext,
    );
    expect(result1.hasNextPage).toBe(true); // Has cursor means can go forward
    expect(result1.hasPrevPage).toBe(true); // hasMore in backward = more before
  });

  it("empty results have no cursors", () => {
    const orderBy = [createOrderSpec("p", ["id"], "asc")];

    const result = buildPaginatedResult(
      [],
      [],
      orderBy,
      10,
      false,
      false,
      undefined,
      mockBuildContext,
    );

    expect(result.nextCursor).toBeUndefined();
    expect(result.prevCursor).toBeUndefined();
  });

  it("generates cursors from first and last rows", () => {
    const orderBy = [createOrderSpec("p", ["id"], "asc")];
    const rows = [{ p: { id: 1 } }, { p: { id: 2 } }, { p: { id: 3 } }];

    const result = buildPaginatedResult(
      rows,
      rows,
      orderBy,
      10,
      true, // hasMore
      false,
      "cursor",
      mockBuildContext,
    );

    // Should have both cursors since hasMore and has cursor
    expect(result.nextCursor).toBeDefined();
    expect(result.prevCursor).toBeDefined();

    // Cursors should be decodable
    if (!result.nextCursor || !result.prevCursor) return;
    const decodedNext = decodeCursor(result.nextCursor);
    expect(decodedNext.d).toBe("f");
    const decodedPrevious = decodeCursor(result.prevCursor);
    expect(decodedPrevious.d).toBe("b");
  });
});

// ============================================================
// Property Tests - Build Cursor From Row
// ============================================================

describe("Build Cursor From Row Properties", () => {
  it("cursor contains correct direction", () => {
    const directionArb = fc.constantFrom("f" as const, "b" as const);

    fc.assert(
      fc.property(directionArb, (direction) => {
        const orderBy = [createOrderSpec("p", ["id"], "asc")];
        const row = { p: { id: 42 } };

        const cursor = buildCursorFromRow(row, orderBy, direction);
        const decoded = decodeCursor(cursor);

        expect(decoded.d).toBe(direction);
      }),
      { numRuns: 10 },
    );
  });

  it("cursor contains values from all order columns", () => {
    const orderBy = [
      createOrderSpec("p", ["id"], "asc"),
      createOrderSpec("p", ["name"], "asc"),
    ];
    const row = { p: { id: 42, name: "Alice" } };

    const cursor = buildCursorFromRow(row, orderBy, "f");
    const decoded = decodeCursor(cursor);

    expect(decoded.vals).toHaveLength(2);
    expect(decoded.cols).toHaveLength(2);
    expect(decoded.cols).toEqual(["p.id", "p.name"]);
  });

  it("cursor values match row values", () => {
    const valueArb = fc.integer({ min: 1, max: 1000 });

    fc.assert(
      fc.property(valueArb, (value) => {
        const orderBy = [createOrderSpec("p", ["id"], "asc")];
        const row = { p: { id: value } };

        const cursor = buildCursorFromRow(row, orderBy, "f");
        const decoded = decodeCursor(cursor);

        expect(decoded.vals[0]).toBe(value);
      }),
      { numRuns: 50 },
    );
  });
});
