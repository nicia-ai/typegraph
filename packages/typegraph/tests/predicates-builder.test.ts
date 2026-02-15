/**
 * Unit tests for predicate builder functions.
 *
 * Tests the fluent API for building type-safe predicates.
 */
import { describe, expect, it } from "vitest";

import { type QueryAst } from "../src/query/ast";
import { jsonPointer } from "../src/query/json-pointer";
import {
  arrayField,
  baseField,
  dateField,
  embeddingField,
  exists,
  fieldRef,
  inSubquery,
  notExists,
  notInSubquery,
  numberField,
  objectField,
  stringField,
} from "../src/query/predicates";

// ============================================================
// fieldRef
// ============================================================

describe("fieldRef", () => {
  it("creates basic field reference", () => {
    const ref = fieldRef("p", ["props", "name"]);

    expect(ref.__type).toBe("field_ref");
    expect(ref.alias).toBe("p");
    expect(ref.path).toEqual(["props", "name"]);
  });

  it("creates field reference with jsonPointer", () => {
    const pointer = jsonPointer(["nested", "value"]);
    const ref = fieldRef("p", ["props"], { jsonPointer: pointer });

    expect(ref.jsonPointer).toBe("/nested/value");
  });

  it("creates field reference with valueType", () => {
    const ref = fieldRef("p", ["props", "count"], { valueType: "number" });

    expect(ref.valueType).toBe("number");
  });

  it("creates field reference with elementType", () => {
    const ref = fieldRef("p", ["props", "tags"], {
      valueType: "array",
      elementType: "string",
    });

    expect(ref.valueType).toBe("array");
    expect(ref.elementType).toBe("string");
  });

  it("omits undefined options", () => {
    const ref = fieldRef("p", ["id"], {});

    expect(ref).not.toHaveProperty("jsonPointer");
    expect(ref).not.toHaveProperty("valueType");
    expect(ref).not.toHaveProperty("elementType");
  });
});

// ============================================================
// baseField
// ============================================================

describe("baseField", () => {
  const field = fieldRef("p", ["props", "value"]);

  it("creates eq predicate", () => {
    const pred = baseField(field).eq("test");

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("eq");
  });

  it("creates neq predicate", () => {
    const pred = baseField(field).neq("test");

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("neq");
  });

  it("creates isNull predicate", () => {
    const pred = baseField(field).isNull();

    expect(pred.__expr.__type).toBe("null_check");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("isNull");
  });

  it("creates isNotNull predicate", () => {
    const pred = baseField(field).isNotNull();

    expect(pred.__expr.__type).toBe("null_check");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("isNotNull");
  });

  it("creates in predicate", () => {
    const pred = baseField(field).in(["a", "b", "c"]);

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as { op: string; right: unknown };
    expect(expr.op).toBe("in");
    expect(Array.isArray(expr.right)).toBe(true);
  });

  it("creates notIn predicate", () => {
    const pred = baseField(field).notIn(["x", "y"]);

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("notIn");
  });
});

// ============================================================
// stringField
// ============================================================

describe("stringField", () => {
  const field = fieldRef("p", ["props", "name"]);

  it("inherits base operations", () => {
    const builder = stringField(field);

    expect(typeof builder.eq).toBe("function");
    expect(typeof builder.neq).toBe("function");
    expect(typeof builder.isNull).toBe("function");
    expect(typeof builder.isNotNull).toBe("function");
    expect(typeof builder.in).toBe("function");
    expect(typeof builder.notIn).toBe("function");
  });

  it("creates contains predicate", () => {
    const pred = stringField(field).contains("search");

    expect(pred.__expr.__type).toBe("string_op");
    const expr = pred.__expr as { op: string; pattern: string };
    expect(expr.op).toBe("contains");
    expect(expr.pattern).toBe("search");
  });

  it("creates startsWith predicate", () => {
    const pred = stringField(field).startsWith("prefix");

    expect(pred.__expr.__type).toBe("string_op");
    const expr = pred.__expr as { op: string; pattern: string };
    expect(expr.op).toBe("startsWith");
    expect(expr.pattern).toBe("prefix");
  });

  it("creates endsWith predicate", () => {
    const pred = stringField(field).endsWith("suffix");

    expect(pred.__expr.__type).toBe("string_op");
    const expr = pred.__expr as { op: string; pattern: string };
    expect(expr.op).toBe("endsWith");
    expect(expr.pattern).toBe("suffix");
  });

  it("creates like predicate", () => {
    const pred = stringField(field).like("test%");

    expect(pred.__expr.__type).toBe("string_op");
    const expr = pred.__expr as { op: string; pattern: string };
    expect(expr.op).toBe("like");
    expect(expr.pattern).toBe("test%");
  });

  it("creates ilike predicate", () => {
    const pred = stringField(field).ilike("TEST");

    expect(pred.__expr.__type).toBe("string_op");
    const expr = pred.__expr as { op: string; pattern: string };
    expect(expr.op).toBe("ilike");
    expect(expr.pattern).toBe("TEST");
  });
});

// ============================================================
// numberField
// ============================================================

describe("numberField", () => {
  const field = fieldRef("p", ["props", "score"], { valueType: "number" });

  it("inherits base operations", () => {
    const builder = numberField(field);

    expect(typeof builder.eq).toBe("function");
    expect(typeof builder.in).toBe("function");
  });

  it("creates gt predicate", () => {
    const pred = numberField(field).gt(10);

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("gt");
  });

  it("creates gte predicate", () => {
    const pred = numberField(field).gte(10);

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("gte");
  });

  it("creates lt predicate", () => {
    const pred = numberField(field).lt(100);

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("lt");
  });

  it("creates lte predicate", () => {
    const pred = numberField(field).lte(100);

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("lte");
  });

  it("creates between predicate", () => {
    const pred = numberField(field).between(0, 100);

    expect(pred.__expr.__type).toBe("between");
    const expr = pred.__expr as {
      lower: { value: number };
      upper: { value: number };
    };
    expect(expr.lower.value).toBe(0);
    expect(expr.upper.value).toBe(100);
  });
});

// ============================================================
// dateField
// ============================================================

describe("dateField", () => {
  const field = fieldRef("p", ["props", "createdAt"], { valueType: "date" });

  it("creates gt predicate with Date", () => {
    const date = new Date("2024-01-01T00:00:00Z");
    const pred = dateField(field).gt(date);

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("gt");
  });

  it("creates gt predicate with string", () => {
    const pred = dateField(field).gt("2024-01-01T00:00:00Z");

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("gt");
  });

  it("creates between predicate with Date objects", () => {
    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-12-31T23:59:59Z");
    const pred = dateField(field).between(start, end);

    expect(pred.__expr.__type).toBe("between");
    const expr = pred.__expr as {
      lower: { valueType: string };
      upper: { valueType: string };
    };
    expect(expr.lower.valueType).toBe("date");
    expect(expr.upper.valueType).toBe("date");
  });

  it("creates between predicate with string dates", () => {
    const pred = dateField(field).between(
      "2024-01-01T00:00:00Z",
      "2024-12-31T23:59:59Z",
    );

    expect(pred.__expr.__type).toBe("between");
  });
});

// ============================================================
// arrayField
// ============================================================

describe("arrayField", () => {
  const field = fieldRef("p", ["props", "tags"], { valueType: "array" });

  it("creates isEmpty predicate", () => {
    const pred = arrayField(field).isEmpty();

    expect(pred.__expr.__type).toBe("array_op");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("isEmpty");
  });

  it("creates isNotEmpty predicate", () => {
    const pred = arrayField(field).isNotEmpty();

    expect(pred.__expr.__type).toBe("array_op");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("isNotEmpty");
  });

  it("creates lengthEq predicate", () => {
    const pred = arrayField(field).lengthEq(5);

    expect(pred.__expr.__type).toBe("array_op");
    const expr = pred.__expr as { op: string; length: number };
    expect(expr.op).toBe("lengthEq");
    expect(expr.length).toBe(5);
  });

  it("creates lengthGt predicate", () => {
    const pred = arrayField(field).lengthGt(3);

    expect(pred.__expr.__type).toBe("array_op");
    const expr = pred.__expr as { op: string; length: number };
    expect(expr.op).toBe("lengthGt");
    expect(expr.length).toBe(3);
  });

  it("creates lengthGte predicate", () => {
    const pred = arrayField(field).lengthGte(3);

    expect(pred.__expr.__type).toBe("array_op");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("lengthGte");
  });

  it("creates lengthLt predicate", () => {
    const pred = arrayField(field).lengthLt(10);

    expect(pred.__expr.__type).toBe("array_op");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("lengthLt");
  });

  it("creates lengthLte predicate", () => {
    const pred = arrayField(field).lengthLte(10);

    expect(pred.__expr.__type).toBe("array_op");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("lengthLte");
  });

  it("creates contains predicate", () => {
    const pred = arrayField<string>(field).contains("important");

    expect(pred.__expr.__type).toBe("array_op");
    const expr = pred.__expr as unknown as { op: string; values: unknown[] };
    expect(expr.op).toBe("contains");
    expect(expr.values).toHaveLength(1);
  });

  it("creates containsAll predicate", () => {
    const pred = arrayField<string>(field).containsAll(["a", "b", "c"]);

    expect(pred.__expr.__type).toBe("array_op");
    const expr = pred.__expr as unknown as { op: string; values: unknown[] };
    expect(expr.op).toBe("containsAll");
    expect(expr.values).toHaveLength(3);
  });

  it("creates containsAny predicate", () => {
    const pred = arrayField<string>(field).containsAny(["x", "y"]);

    expect(pred.__expr.__type).toBe("array_op");
    const expr = pred.__expr as unknown as { op: string; values: unknown[] };
    expect(expr.op).toBe("containsAny");
    expect(expr.values).toHaveLength(2);
  });
});

// ============================================================
// objectField
// ============================================================

describe("objectField", () => {
  const field = fieldRef("p", ["props", "metadata"]);

  it("creates hasKey predicate", () => {
    const pred = objectField(field).hasKey("setting");

    expect(pred.__expr.__type).toBe("object_op");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("hasKey");
  });

  it("creates hasPath predicate", () => {
    const pred = objectField(field).hasPath("/nested/value");

    expect(pred.__expr.__type).toBe("object_op");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("hasPath");
  });

  it("creates pathEquals predicate", () => {
    const pred = objectField(field).pathEquals("/theme", "dark");

    expect(pred.__expr.__type).toBe("object_op");
    const expr = pred.__expr as { op: string; value?: { value: unknown } };
    expect(expr.op).toBe("pathEquals");
    expect(expr.value?.value).toBe("dark");
  });

  it("creates pathContains predicate", () => {
    const pred = objectField(field).pathContains("/tags", "featured");

    expect(pred.__expr.__type).toBe("object_op");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("pathContains");
  });

  it("creates pathIsNull predicate", () => {
    const pred = objectField(field).pathIsNull("/optional");

    expect(pred.__expr.__type).toBe("object_op");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("pathIsNull");
  });

  it("creates pathIsNotNull predicate", () => {
    const pred = objectField(field).pathIsNotNull("/required");

    expect(pred.__expr.__type).toBe("object_op");
    const expr = pred.__expr as { op: string };
    expect(expr.op).toBe("pathIsNotNull");
  });

  it("creates nested field builder with get", () => {
    type TestType = Record<string, unknown> & {
      name: string;
      nested: { value: number };
    };
    const builder = objectField<TestType>(field).get("name");

    // Should return a field builder
    expect(typeof builder.eq).toBe("function");
  });

  it("creates nested field builder with field", () => {
    const builder = objectField(field).field("/nested/value");

    expect(typeof builder.eq).toBe("function");
  });
});

// ============================================================
// embeddingField
// ============================================================

describe("embeddingField", () => {
  const field = fieldRef("p", ["props", "embedding"], {
    valueType: "embedding",
  });

  it("inherits base operations", () => {
    const builder = embeddingField(field);

    expect(typeof builder.eq).toBe("function");
    expect(typeof builder.isNull).toBe("function");
  });

  it("creates similarTo predicate with default options", () => {
    const queryVector = [0.1, 0.2, 0.3];
    const pred = embeddingField(field).similarTo(queryVector, 10);

    expect(pred.__expr.__type).toBe("vector_similarity");
    const expr = pred.__expr as unknown as {
      queryEmbedding: readonly number[];
      limit: number;
      metric: string;
    };
    expect(expr.queryEmbedding).toEqual(queryVector);
    expect(expr.limit).toBe(10);
    expect(expr.metric).toBe("cosine");
  });

  it("creates similarTo predicate with custom metric", () => {
    const pred = embeddingField(field).similarTo([0.1, 0.2], 5, {
      metric: "l2",
    });

    expect(pred.__expr.__type).toBe("vector_similarity");
    const expr = pred.__expr as { metric: string };
    expect(expr.metric).toBe("l2");
  });

  it("creates similarTo predicate with minScore", () => {
    const pred = embeddingField(field).similarTo([0.1, 0.2], 5, {
      minScore: 0.8,
    });

    expect(pred.__expr.__type).toBe("vector_similarity");
    const expr = pred.__expr as { minScore: number };
    expect(expr.minScore).toBe(0.8);
  });

  it("creates similarTo predicate with all options", () => {
    const pred = embeddingField(field).similarTo([0.1], 3, {
      metric: "inner_product",
      minScore: 0.5,
    });

    expect(pred.__expr.__type).toBe("vector_similarity");
    const expr = pred.__expr as {
      metric: string;
      minScore: number;
      limit: number;
    };
    expect(expr.metric).toBe("inner_product");
    expect(expr.minScore).toBe(0.5);
    expect(expr.limit).toBe(3);
  });
});

// ============================================================
// Subquery Predicates
// ============================================================

describe("subquery predicates", () => {
  const singleColumnSubqueryAst: QueryAst = {
    graphId: "test",
    start: {
      alias: "u",
      kinds: ["User"],
      includeSubClasses: false,
    },
    traversals: [],
    predicates: [],
    projection: {
      fields: [
        {
          outputName: "u_id",
          source: fieldRef("u", ["id"], { valueType: "string" }),
        },
      ],
    },
    temporalMode: { mode: "current" },
  };

  describe("exists", () => {
    it("creates exists predicate", () => {
      const pred = exists(singleColumnSubqueryAst);

      expect(pred.__expr.__type).toBe("exists");
      const expr = pred.__expr as { negated: boolean; subquery: unknown };
      expect(expr.negated).toBe(false);
      expect(expr.subquery).toBe(singleColumnSubqueryAst);
    });
  });

  describe("notExists", () => {
    it("creates not exists predicate", () => {
      const pred = notExists(singleColumnSubqueryAst);

      expect(pred.__expr.__type).toBe("exists");
      const expr = pred.__expr as { negated: boolean };
      expect(expr.negated).toBe(true);
    });
  });

  describe("inSubquery", () => {
    it("creates in subquery predicate", () => {
      const refField = fieldRef("p", ["id"]);
      const pred = inSubquery(refField, singleColumnSubqueryAst);

      expect(pred.__expr.__type).toBe("in_subquery");
      const expr = pred.__expr as {
        negated: boolean;
        field: unknown;
        subquery: unknown;
      };
      expect(expr.negated).toBe(false);
      expect(expr.field).toBe(refField);
      expect(expr.subquery).toBe(singleColumnSubqueryAst);
    });

    it("rejects subqueries with multiple projected columns", () => {
      const invalidSubquery: QueryAst = {
        ...singleColumnSubqueryAst,
        projection: {
          fields: [
            {
              outputName: "u_id",
              source: fieldRef("u", ["id"], { valueType: "string" }),
            },
            {
              outputName: "u_name",
              source: fieldRef("u", ["props", "name"], { valueType: "string" }),
            },
          ],
        },
      };

      expect(() => inSubquery(fieldRef("p", ["id"]), invalidSubquery)).toThrow(
        "must project exactly 1 column",
      );
    });

    it("rejects subqueries with no projected columns", () => {
      const invalidSubquery: QueryAst = {
        ...singleColumnSubqueryAst,
        projection: { fields: [] },
      };

      expect(() => inSubquery(fieldRef("p", ["id"]), invalidSubquery)).toThrow(
        "must project exactly 1 column",
      );
    });

    it("rejects mismatched scalar types when both sides are known", () => {
      const numericField = fieldRef("p", ["props", "age"], {
        valueType: "number",
      });
      const stringSubquery: QueryAst = {
        ...singleColumnSubqueryAst,
        projection: {
          fields: [
            {
              outputName: "u_name",
              source: fieldRef("u", ["props", "name"], { valueType: "string" }),
            },
          ],
        },
      };

      expect(() => inSubquery(numericField, stringSubquery)).toThrow(
        "type mismatch",
      );
    });

    it("rejects non-scalar value types", () => {
      const objectField = fieldRef("p", ["props", "profile"], {
        valueType: "object",
      });
      const objectSubquery: QueryAst = {
        ...singleColumnSubqueryAst,
        projection: {
          fields: [
            {
              outputName: "u_profile",
              source: fieldRef("u", ["props", "profile"], {
                valueType: "object",
              }),
            },
          ],
        },
      };

      expect(() => inSubquery(objectField, objectSubquery)).toThrow(
        "does not support object values",
      );
    });
  });

  describe("notInSubquery", () => {
    it("creates not in subquery predicate", () => {
      const refField = fieldRef("p", ["props", "category"]);
      const pred = notInSubquery(refField, singleColumnSubqueryAst);

      expect(pred.__expr.__type).toBe("in_subquery");
      const expr = pred.__expr as { negated: boolean };
      expect(expr.negated).toBe(true);
    });

    it("applies the same type validation as IN subqueries", () => {
      const numericField = fieldRef("p", ["props", "age"], {
        valueType: "number",
      });
      const stringSubquery: QueryAst = {
        ...singleColumnSubqueryAst,
        projection: {
          fields: [
            {
              outputName: "u_name",
              source: fieldRef("u", ["props", "name"], { valueType: "string" }),
            },
          ],
        },
      };

      expect(() => notInSubquery(numericField, stringSubquery)).toThrow(
        "type mismatch",
      );
    });
  });
});

// ============================================================
// Predicate Chaining
// ============================================================

describe("predicate chaining", () => {
  const field = fieldRef("p", ["props", "value"]);

  it("chains with and", () => {
    const a = baseField(field).eq(1);
    const b = baseField(field).eq(2);
    const combined = a.and(b);

    expect(combined.__expr.__type).toBe("and");
  });

  it("chains with or", () => {
    const a = baseField(field).eq(1);
    const b = baseField(field).eq(2);
    const combined = a.or(b);

    expect(combined.__expr.__type).toBe("or");
  });

  it("applies not", () => {
    const pred = baseField(field).eq(1).not();

    expect(pred.__expr.__type).toBe("not");
  });

  it("chains multiple operations", () => {
    const pred = baseField(field)
      .eq(1)
      .or(baseField(field).eq(2))
      .and(baseField(field).isNotNull())
      .not();

    expect(pred.__expr.__type).toBe("not");
  });
});

// ============================================================
// Literal Value Handling
// ============================================================

describe("literal value handling", () => {
  const field = fieldRef("p", ["props", "value"]);

  it("handles string literals", () => {
    const pred = baseField(field).eq("test");

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as {
      right: { value: unknown; valueType: string };
    };
    expect(expr.right.value).toBe("test");
    expect(expr.right.valueType).toBe("string");
  });

  it("handles number literals", () => {
    const pred = baseField(field).eq(42);

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as {
      right: { value: unknown; valueType: string };
    };
    expect(expr.right.value).toBe(42);
    expect(expr.right.valueType).toBe("number");
  });

  it("handles boolean literals", () => {
    const pred = baseField(field).eq(true);

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as {
      right: { value: unknown; valueType: string };
    };
    expect(expr.right.value).toBe(true);
    expect(expr.right.valueType).toBe("boolean");
  });

  it("handles Date literals", () => {
    const date = new Date("2024-01-15T10:30:00.000Z");
    const pred = baseField(field).eq(date);

    expect(pred.__expr.__type).toBe("comparison");
    const expr = pred.__expr as {
      right: { value: unknown; valueType: string };
    };
    expect(expr.right.value).toBe("2024-01-15T10:30:00.000Z");
    expect(expr.right.valueType).toBe("date");
  });

  it("throws for unsupported value types", () => {
    expect(() => {
      baseField(field).eq({ nested: "object" } as unknown as string);
    }).toThrow("Unsupported literal value type");
  });
});
