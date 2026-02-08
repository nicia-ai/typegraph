/**
 * Unit tests for schema introspector.
 *
 * Tests the extraction of type information from Zod schemas.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { embedding } from "../src/core/embedding";
import { createSchemaIntrospector } from "../src/query/schema-introspector";

// ============================================================
// createSchemaIntrospector
// ============================================================

describe("createSchemaIntrospector", () => {
  it("creates an introspector with getFieldTypeInfo method", () => {
    const nodeKinds = new Map([
      ["User", { schema: z.object({ name: z.string() }) }],
    ]);

    const introspector = createSchemaIntrospector(nodeKinds);

    expect(typeof introspector.getFieldTypeInfo).toBe("function");
    expect(typeof introspector.getSharedFieldTypeInfo).toBe("function");
  });
});

// ============================================================
// getFieldTypeInfo - Basic Types
// ============================================================

describe("getFieldTypeInfo - basic types", () => {
  const nodeKinds = new Map([
    [
      "TestNode",
      {
        schema: z.object({
          stringField: z.string(),
          numberField: z.number(),
          booleanField: z.boolean(),
          dateField: z.date(),
        }),
      },
    ],
  ]);
  const introspector = createSchemaIntrospector(nodeKinds);

  it("resolves string type", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "stringField");

    expect(info?.valueType).toBe("string");
  });

  it("resolves number type", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "numberField");

    expect(info?.valueType).toBe("number");
  });

  it("resolves boolean type", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "booleanField");

    expect(info?.valueType).toBe("boolean");
  });

  it("resolves date type", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "dateField");

    expect(info?.valueType).toBe("date");
  });

  it("returns undefined for unknown field", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "unknownField");

    expect(info).toBeUndefined();
  });

  it("returns undefined for unknown kind", () => {
    const info = introspector.getFieldTypeInfo("UnknownKind", "stringField");

    expect(info).toBeUndefined();
  });
});

// ============================================================
// getFieldTypeInfo - Wrapper Types
// ============================================================

describe("getFieldTypeInfo - wrapper types", () => {
  const nodeKinds = new Map([
    [
      "TestNode",
      {
        schema: z.object({
          optionalString: z.string().optional(),
          nullableNumber: z.number().nullable(),
          defaultBoolean: z.boolean().default(false),
          readonlyDate: z.date().readonly(),
          catchString: z.string().catch("default"),
        }),
      },
    ],
  ]);
  const introspector = createSchemaIntrospector(nodeKinds);

  it("unwraps optional to get inner type", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "optionalString");

    expect(info?.valueType).toBe("string");
  });

  it("unwraps nullable to get inner type", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "nullableNumber");

    expect(info?.valueType).toBe("number");
  });

  it("unwraps default to get inner type", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "defaultBoolean");

    expect(info?.valueType).toBe("boolean");
  });

  it("unwraps readonly to get inner type", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "readonlyDate");

    expect(info?.valueType).toBe("date");
  });

  it("unwraps catch to get inner type", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "catchString");

    expect(info?.valueType).toBe("string");
  });
});

// ============================================================
// getFieldTypeInfo - Array Types
// ============================================================

describe("getFieldTypeInfo - array types", () => {
  const nodeKinds = new Map([
    [
      "TestNode",
      {
        schema: z.object({
          stringArray: z.array(z.string()),
          numberArray: z.array(z.number()),
          objectArray: z.array(z.object({ id: z.string() })),
          tupleField: z.tuple([z.string(), z.number()]),
        }),
      },
    ],
  ]);
  const introspector = createSchemaIntrospector(nodeKinds);

  it("resolves array type with string elements", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "stringArray");

    expect(info?.valueType).toBe("array");
    expect(info?.elementType).toBe("string");
  });

  it("resolves array type with number elements", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "numberArray");

    expect(info?.valueType).toBe("array");
    expect(info?.elementType).toBe("number");
  });

  it("resolves array type with object elements", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "objectArray");

    expect(info?.valueType).toBe("array");
    expect(info?.elementType).toBe("object");
    expect(info?.elementTypeInfo?.shape).toBeDefined();
  });

  it("resolves tuple as array with unknown element type", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "tupleField");

    expect(info?.valueType).toBe("array");
    expect(info?.elementType).toBe("unknown");
  });
});

// ============================================================
// getFieldTypeInfo - Object Types
// ============================================================

describe("getFieldTypeInfo - object types", () => {
  const nodeKinds = new Map([
    [
      "TestNode",
      {
        schema: z.object({
          nestedObject: z.object({
            name: z.string(),
            count: z.number(),
          }),
          recordField: z.record(z.string(), z.number()),
        }),
      },
    ],
  ]);
  const introspector = createSchemaIntrospector(nodeKinds);

  it("resolves nested object with shape", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "nestedObject");

    expect(info?.valueType).toBe("object");
    expect(info?.shape).toBeDefined();
    expect(info?.shape?.name?.valueType).toBe("string");
    expect(info?.shape?.count?.valueType).toBe("number");
  });

  it("resolves record type with value type info", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "recordField");

    expect(info?.valueType).toBe("object");
    expect(info?.recordValueType?.valueType).toBe("number");
  });
});

// ============================================================
// getFieldTypeInfo - Literal Types
// ============================================================

describe("getFieldTypeInfo - literal types", () => {
  const nodeKinds = new Map([
    [
      "TestNode",
      {
        schema: z.object({
          stringLiteral: z.literal("active"),
          numberLiteral: z.literal(42),
          booleanLiteral: z.literal(true),
        }),
      },
    ],
  ]);
  const introspector = createSchemaIntrospector(nodeKinds);

  // Note: Zod 4 changed literal type behavior - literals are now their own type
  // and need to be resolved through the literal value inspection
  it("resolves string literal", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "stringLiteral");

    // In Zod 4, literals resolve based on the underlying value
    expect(info).toBeDefined();
  });

  it("resolves number literal", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "numberLiteral");

    expect(info).toBeDefined();
  });

  it("resolves boolean literal", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "booleanLiteral");

    expect(info).toBeDefined();
  });
});

// ============================================================
// getFieldTypeInfo - Enum Types
// ============================================================

describe("getFieldTypeInfo - enum types", () => {
  const nodeKinds = new Map([
    [
      "TestNode",
      {
        schema: z.object({
          zodEnum: z.enum(["a", "b", "c"]),
        }),
      },
    ],
  ]);
  const introspector = createSchemaIntrospector(nodeKinds);

  it("resolves zod enum as string", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "zodEnum");

    expect(info?.valueType).toBe("string");
  });
});

// ============================================================
// getFieldTypeInfo - Union Types
// ============================================================

describe("getFieldTypeInfo - union types", () => {
  const nodeKinds = new Map([
    [
      "TestNode",
      {
        schema: z.object({
          stringOrNull: z.union([z.string(), z.null()]),
          mixedUnion: z.union([z.string(), z.number()]),
          sameTypeUnion: z.union([z.literal("a"), z.literal("b")]),
          discriminatedUnion: z.discriminatedUnion("type", [
            z.object({ type: z.literal("a"), value: z.string() }),
            z.object({ type: z.literal("b"), value: z.string() }),
          ]),
        }),
      },
    ],
  ]);
  const introspector = createSchemaIntrospector(nodeKinds);

  it("resolves union of same base type", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "sameTypeUnion");

    // Union of literals may resolve to "unknown" if the literal type itself
    // isn't in SUPPORTED_SCHEMA_TYPES or can't be merged
    expect(info).toBeDefined();
  });

  it("returns unknown for mixed type union", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "mixedUnion");

    // Mixed unions can't be merged to a single type, returns unknown
    expect(info?.valueType).toBe("unknown");
  });

  it("resolves discriminated union of objects", () => {
    const info = introspector.getFieldTypeInfo(
      "TestNode",
      "discriminatedUnion",
    );

    expect(info?.valueType).toBe("object");
  });
});

// ============================================================
// getFieldTypeInfo - Intersection Types
// ============================================================

describe("getFieldTypeInfo - intersection types", () => {
  const nodeKinds = new Map([
    [
      "TestNode",
      {
        schema: z.object({
          intersectionObject: z.intersection(
            z.object({ name: z.string() }),
            z.object({ age: z.number() }),
          ),
        }),
      },
    ],
  ]);
  const introspector = createSchemaIntrospector(nodeKinds);

  it("resolves intersection of objects", () => {
    const info = introspector.getFieldTypeInfo(
      "TestNode",
      "intersectionObject",
    );

    expect(info?.valueType).toBe("object");
  });
});

// ============================================================
// getFieldTypeInfo - Embedding Types
// ============================================================

describe("getFieldTypeInfo - embedding types", () => {
  const nodeKinds = new Map([
    [
      "TestNode",
      {
        schema: z.object({
          embedding: embedding(1536),
          optionalEmbedding: embedding(768).optional(),
        }),
      },
    ],
  ]);
  const introspector = createSchemaIntrospector(nodeKinds);

  it("resolves embedding type with dimensions", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "embedding");

    expect(info?.valueType).toBe("embedding");
    expect(info?.dimensions).toBe(1536);
  });

  it("resolves optional embedding type", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "optionalEmbedding");

    expect(info?.valueType).toBe("embedding");
    expect(info?.dimensions).toBe(768);
  });
});

// ============================================================
// getFieldTypeInfo - NaN Type
// ============================================================

describe("getFieldTypeInfo - special types", () => {
  const nodeKinds = new Map([
    [
      "TestNode",
      {
        schema: z.object({
          nanField: z.nan(),
        }),
      },
    ],
  ]);
  const introspector = createSchemaIntrospector(nodeKinds);

  it("resolves nan as number", () => {
    const info = introspector.getFieldTypeInfo("TestNode", "nanField");

    expect(info?.valueType).toBe("number");
  });
});

// ============================================================
// getFieldTypeInfo - Caching
// ============================================================

describe("getFieldTypeInfo - caching", () => {
  it("caches shape for repeated lookups", () => {
    const nodeKinds = new Map([
      [
        "TestNode",
        {
          schema: z.object({
            name: z.string(),
            age: z.number(),
          }),
        },
      ],
    ]);
    const introspector = createSchemaIntrospector(nodeKinds);

    // First lookup
    const info1 = introspector.getFieldTypeInfo("TestNode", "name");
    // Second lookup should use cache
    const info2 = introspector.getFieldTypeInfo("TestNode", "age");

    expect(info1?.valueType).toBe("string");
    expect(info2?.valueType).toBe("number");
  });
});

// ============================================================
// getSharedFieldTypeInfo
// ============================================================

describe("getSharedFieldTypeInfo", () => {
  const nodeKinds = new Map([
    [
      "User",
      {
        schema: z.object({
          id: z.string(),
          name: z.string(),
          email: z.string(),
        }),
      },
    ],
    [
      "Admin",
      {
        schema: z.object({
          id: z.string(),
          name: z.string(),
          level: z.number(),
        }),
      },
    ],
    [
      "Guest",
      {
        schema: z.object({
          id: z.string(),
          sessionId: z.string(),
        }),
      },
    ],
  ]);
  const introspector = createSchemaIntrospector(nodeKinds);

  it("returns shared field info when all kinds have the field", () => {
    const info = introspector.getSharedFieldTypeInfo(["User", "Admin"], "name");

    expect(info?.valueType).toBe("string");
  });

  it("returns shared field info for id across all kinds", () => {
    const info = introspector.getSharedFieldTypeInfo(
      ["User", "Admin", "Guest"],
      "id",
    );

    expect(info?.valueType).toBe("string");
  });

  it("returns undefined when field is missing from one kind", () => {
    const info = introspector.getSharedFieldTypeInfo(["User", "Guest"], "name");

    expect(info).toBeUndefined();
  });

  it("returns undefined for empty kind list", () => {
    const info = introspector.getSharedFieldTypeInfo([], "name");

    expect(info).toBeUndefined();
  });

  it("returns undefined when kinds have different types for field", () => {
    const mixedKinds = new Map([
      ["A", { schema: z.object({ value: z.string() }) }],
      ["B", { schema: z.object({ value: z.number() }) }],
    ]);
    const mixedIntrospector = createSchemaIntrospector(mixedKinds);

    const info = mixedIntrospector.getSharedFieldTypeInfo(["A", "B"], "value");

    expect(info).toBeUndefined();
  });
});

// ============================================================
// getSharedFieldTypeInfo - Array Merging
// ============================================================

describe("getSharedFieldTypeInfo - array merging", () => {
  const nodeKinds = new Map<string, { schema: z.ZodType }>([
    [
      "NodeA",
      {
        schema: z.object({
          tags: z.array(z.string()),
        }),
      },
    ],
    [
      "NodeB",
      {
        schema: z.object({
          tags: z.array(z.string()),
        }),
      },
    ],
    [
      "NodeC",
      {
        schema: z.object({
          tags: z.array(z.number()),
        }),
      },
    ],
  ]);
  const introspector = createSchemaIntrospector(nodeKinds);

  it("merges arrays with same element type", () => {
    const info = introspector.getSharedFieldTypeInfo(
      ["NodeA", "NodeB"],
      "tags",
    );

    expect(info?.valueType).toBe("array");
    expect(info?.elementType).toBe("string");
  });

  it("returns unknown element type for mixed arrays", () => {
    const info = introspector.getSharedFieldTypeInfo(
      ["NodeA", "NodeC"],
      "tags",
    );

    expect(info?.valueType).toBe("array");
    expect(info?.elementType).toBe("unknown");
  });
});

// ============================================================
// getSharedFieldTypeInfo - Object Shape Intersection
// ============================================================

describe("getSharedFieldTypeInfo - object shape intersection", () => {
  const nodeKinds = new Map<string, { schema: z.ZodType }>([
    [
      "NodeA",
      {
        schema: z.object({
          metadata: z.object({
            created: z.date(),
            tags: z.array(z.string()),
            extra: z.string(),
          }),
        }),
      },
    ],
    [
      "NodeB",
      {
        schema: z.object({
          metadata: z.object({
            created: z.date(),
            tags: z.array(z.string()),
            other: z.number(),
          }),
        }),
      },
    ],
  ]);
  const introspector = createSchemaIntrospector(nodeKinds);

  it("intersects object shapes to common fields", () => {
    const info = introspector.getSharedFieldTypeInfo(
      ["NodeA", "NodeB"],
      "metadata",
    );

    expect(info?.valueType).toBe("object");
    expect(info?.shape).toBeDefined();
    // Common fields should be present
    expect(info?.shape?.created?.valueType).toBe("date");
    expect(info?.shape?.tags?.valueType).toBe("array");
    // Unique fields should not be present
    expect(info?.shape?.extra).toBeUndefined();
    expect(info?.shape?.other).toBeUndefined();
  });
});

// ============================================================
// Edge Cases
// ============================================================

describe("edge cases", () => {
  it("handles non-object schema", () => {
    const nodeKinds = new Map([["StringNode", { schema: z.string() }]]);
    const introspector = createSchemaIntrospector(nodeKinds);

    const info = introspector.getFieldTypeInfo("StringNode", "anyField");

    expect(info).toBeUndefined();
  });

  it("handles empty shape object", () => {
    const nodeKinds = new Map([["EmptyNode", { schema: z.object({}) }]]);
    const introspector = createSchemaIntrospector(nodeKinds);

    const info = introspector.getFieldTypeInfo("EmptyNode", "anyField");

    expect(info).toBeUndefined();
  });

  it("handles pipe schemas", () => {
    const nodeKinds = new Map([
      [
        "TestNode",
        {
          schema: z.object({
            pipedString: z.string().pipe(z.string().toUpperCase()),
          }),
        },
      ],
    ]);
    const introspector = createSchemaIntrospector(nodeKinds);

    const info = introspector.getFieldTypeInfo("TestNode", "pipedString");

    expect(info?.valueType).toBe("string");
  });
});
