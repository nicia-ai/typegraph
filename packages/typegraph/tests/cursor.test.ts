/**
 * Cursor Encoding/Decoding Tests
 *
 * Tests for the cursor module which handles keyset pagination cursors.
 * Cursors are opaque URL-safe base64-encoded JSON containing:
 * - Version for forward compatibility
 * - Direction indicator (forward/backward)
 * - Column values at cursor position
 * - Column identifiers for validation
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "../src";
import { type OrderSpec } from "../src/query/ast";
import {
  buildColumnId,
  buildCursorFromRow,
  decodeCursor,
  encodeCursor,
  extractCursorValue,
  validateCursorColumns,
} from "../src/query/cursor";

describe("Cursor Encoding", () => {
  it("encodes cursor data to URL-safe base64", () => {
    const data = {
      v: 1,
      d: "f" as const,
      vals: ["Alice", 25],
      cols: ["p.name", "p.age"],
    };

    const encoded = encodeCursor(data);

    // Should be URL-safe (no +, /, or =)
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");

    // Should be decodable
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(data);
  });

  it("handles special characters in values", () => {
    const data = {
      v: 1,
      d: "b" as const,
      vals: ["O'Brien", "test@example.com", "hello/world"],
      cols: ["p.name", "p.email", "p.path"],
    };

    const encoded = encodeCursor(data);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(data);
  });

  it("handles null and undefined values", () => {
    const data = {
      v: 1,
      d: "f" as const,
      // eslint-disable-next-line unicorn/no-null -- testing JSON null handling
      vals: [null, undefined, "value"],
      cols: ["p.a", "p.b", "p.c"],
    };

    const encoded = encodeCursor(data);
    const decoded = decodeCursor(encoded);
    // eslint-disable-next-line unicorn/no-null -- JSON serialization converts undefined to null
    expect(decoded.vals[0]).toBe(null);
    // eslint-disable-next-line unicorn/no-null -- JSON serialization converts undefined to null
    expect(decoded.vals[1]).toBe(null);
    expect(decoded.vals[2]).toBe("value");
  });

  it("handles numeric values", () => {
    const data = {
      v: 1,
      d: "f" as const,
      vals: [42, 3.141_59, -100, 0],
      cols: ["p.a", "p.b", "p.c", "p.d"],
    };

    const encoded = encodeCursor(data);
    const decoded = decodeCursor(encoded);
    expect(decoded.vals).toEqual([42, 3.141_59, -100, 0]);
  });
});

describe("Cursor Decoding", () => {
  it("throws ValidationError for invalid base64", () => {
    expect(() => decodeCursor("not-valid-base64!!!")).toThrow(ValidationError);
  });

  it("throws ValidationError for invalid JSON", () => {
    const invalidJson = btoa("not json");
    expect(() => decodeCursor(invalidJson)).toThrow(ValidationError);
  });

  it("throws ValidationError for unsupported version", () => {
    const futureVersion = btoa(
      JSON.stringify({
        v: 999,
        d: "f",
        vals: [],
        cols: [],
      }),
    );
    expect(() => decodeCursor(futureVersion)).toThrow(ValidationError);
    expect(() => decodeCursor(futureVersion)).toThrow(/version/i);
  });

  it("throws ValidationError for invalid direction", () => {
    const invalidDirection = btoa(
      JSON.stringify({
        v: 1,
        d: "x",
        vals: [],
        cols: [],
      }),
    );
    expect(() => decodeCursor(invalidDirection)).toThrow(ValidationError);
    expect(() => decodeCursor(invalidDirection)).toThrow(/direction/i);
  });

  it("throws ValidationError for mismatched column count", () => {
    const mismatchedCounts = btoa(
      JSON.stringify({
        v: 1,
        d: "f",
        vals: [1, 2, 3],
        cols: ["a", "b"],
      }),
    );
    expect(() => decodeCursor(mismatchedCounts)).toThrow(ValidationError);
    expect(() => decodeCursor(mismatchedCounts)).toThrow(/mismatch/i);
  });
});

describe("buildColumnId", () => {
  it("builds column ID from field ref path", () => {
    const orderSpec: OrderSpec = {
      field: {
        __type: "field_ref",
        alias: "p",
        path: ["props", "name"],
      },
      direction: "asc",
    };

    const columnId = buildColumnId(orderSpec);
    expect(columnId).toBe("p.name");
  });

  it("handles simple paths", () => {
    const orderSpec: OrderSpec = {
      field: {
        __type: "field_ref",
        alias: "person",
        path: ["id"],
      },
      direction: "desc",
    };

    const columnId = buildColumnId(orderSpec);
    expect(columnId).toBe("person.id");
  });
});

describe("extractCursorValue", () => {
  it("extracts value from alias-keyed row using path", () => {
    const row = {
      p: { id: "123", props: { name: "Alice", age: 30 } },
    };

    // Path navigates through the nested structure
    const spec: OrderSpec = {
      field: {
        __type: "field_ref",
        alias: "p",
        path: ["props", "name"],
      },
      direction: "asc",
    };

    const value = extractCursorValue(row, spec);
    expect(value).toBe("Alice");
  });

  it("extracts id field", () => {
    const row = {
      p: { id: "123", props: { name: "Alice" } },
    };

    const spec: OrderSpec = {
      field: {
        __type: "field_ref",
        alias: "p",
        path: ["id"],
      },
      direction: "asc",
    };

    const value = extractCursorValue(row, spec);
    expect(value).toBe("123");
  });

  it("handles nested paths", () => {
    const row = {
      p: {
        props: {
          address: {
            city: "New York",
          },
        },
      },
    };

    const spec: OrderSpec = {
      field: {
        __type: "field_ref",
        alias: "p",
        path: ["props", "address", "city"],
      },
      direction: "asc",
    };

    const value = extractCursorValue(row, spec);
    expect(value).toBe("New York");
  });

  it("returns undefined for missing values", () => {
    const row = {
      p: { props: {} },
    };

    const spec: OrderSpec = {
      field: {
        __type: "field_ref",
        alias: "p",
        path: ["props", "nonexistent"],
      },
      direction: "asc",
    };

    const value = extractCursorValue(row, spec);
    expect(value).toBeUndefined();
  });
});

describe("buildCursorFromRow", () => {
  it("builds forward cursor from row", () => {
    const row = {
      p: { id: "123", props: { name: "Alice", age: 30 } },
    };

    const orderSpecs: OrderSpec[] = [
      {
        field: {
          __type: "field_ref",
          alias: "p",
          path: ["props", "name"],
        },
        direction: "asc",
      },
    ];

    const cursor = buildCursorFromRow(row, orderSpecs, "f");
    const decoded = decodeCursor(cursor);

    expect(decoded.d).toBe("f");
    expect(decoded.vals).toEqual(["Alice"]);
  });

  it("builds backward cursor from row with multiple columns", () => {
    const row = {
      p: { id: "123", props: { name: "Bob", age: 25 } },
    };

    const orderSpecs: OrderSpec[] = [
      {
        field: {
          __type: "field_ref",
          alias: "p",
          path: ["props", "name"],
        },
        direction: "asc",
      },
      {
        field: {
          __type: "field_ref",
          alias: "p",
          path: ["props", "age"],
        },
        direction: "desc",
      },
    ];

    const cursor = buildCursorFromRow(row, orderSpecs, "b");
    const decoded = decodeCursor(cursor);

    expect(decoded.d).toBe("b");
    expect(decoded.vals).toEqual(["Bob", 25]);
  });
});

describe("validateCursorColumns", () => {
  it("validates matching columns", () => {
    const cursorData = {
      v: 1,
      d: "f" as const,
      vals: ["Alice"],
      cols: ["p.name"],
    };

    const orderSpecs: OrderSpec[] = [
      {
        field: {
          __type: "field_ref",
          alias: "p",
          path: ["props", "name"],
        },
        direction: "asc",
      },
    ];

    // Should not throw
    expect(() => {
      validateCursorColumns(cursorData, orderSpecs);
    }).not.toThrow();
  });

  it("throws for column count mismatch", () => {
    const cursorData = {
      v: 1,
      d: "f" as const,
      vals: ["Alice", 30],
      cols: ["p.name", "p.age"],
    };

    const orderSpecs: OrderSpec[] = [
      {
        field: {
          __type: "field_ref",
          alias: "p",
          path: ["props", "name"],
        },
        direction: "asc",
      },
    ];

    expect(() => {
      validateCursorColumns(cursorData, orderSpecs);
    }).toThrow(ValidationError);
  });

  it("throws for column name mismatch", () => {
    const cursorData = {
      v: 1,
      d: "f" as const,
      vals: ["Alice"],
      cols: ["p.email"],
    };

    const orderSpecs: OrderSpec[] = [
      {
        field: {
          __type: "field_ref",
          alias: "p",
          path: ["props", "name"],
        },
        direction: "asc",
      },
    ];

    expect(() => {
      validateCursorColumns(cursorData, orderSpecs);
    }).toThrow(ValidationError);
  });
});
