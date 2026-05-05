/**
 * Property-based tests for the runtime extension document and compiler.
 *
 * fast-check generates arbitrary documents over the v1 property-type
 * subset, and the suite asserts the load-bearing invariant from issue
 * #101 PR 3:
 *
 * - `compileRuntimeExtension(defineRuntimeExtension(doc))` always
 *   succeeds and produces a Zod schema that accepts the document's own
 *   example values.
 *
 * The arbitraries don't try to cover *every* combination — that's the
 * unit suite's job. They do cover enough of the cross-product
 * (refinement + modifier + nesting) to catch surprising compositions
 * where a refinement and a wrapper don't compose.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type z } from "zod";

import { getEmbeddingDimensions } from "../../src/core/embedding";
import { getSearchableMetadata } from "../../src/core/searchable";
import {
  compileRuntimeExtension,
  defineRuntimeExtension,
  type RuntimeArrayItemType,
  type RuntimeObjectFieldProperty,
  type RuntimePropertyType,
} from "../../src/runtime";

// ============================================================
// Identifier arbitraries
// ============================================================

const propertyNameArb = fc.stringMatching(/^[a-z][a-zA-Z0-9]*$/).filter(
  (s) =>
    s.length > 0 &&
    s.length <= 16 &&
    // Stay clear of structural reserved keys: id, kind, meta. The validator
    // would reject these and surface as a property-test failure.
    !["id", "kind", "meta"].includes(s),
);

const nodeKindNameArb = fc
  .stringMatching(/^[A-Z][a-zA-Z0-9]*$/)
  .filter((s) => s.length >= 2 && s.length <= 16);

const enumValueArb = fc
  .stringMatching(/^[a-z]+$/)
  .filter((s) => s.length > 0 && s.length <= 8);

// ============================================================
// Property type + example value arbitraries
// ============================================================

type PropertyAndExample = Readonly<{
  property: RuntimePropertyType;
  example: unknown;
}>;

const stringPropertyArb: fc.Arbitrary<PropertyAndExample> = fc
  .record({
    minLength: fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined }),
    maxLength: fc.option(fc.integer({ min: 5, max: 32 }), { nil: undefined }),
    optional: fc.boolean(),
    wantSearchable: fc.boolean(),
  })
  .map(
    ({
      minLength,
      maxLength,
      optional,
      wantSearchable,
    }): PropertyAndExample => {
      const property: Record<string, unknown> = { type: "string" };
      if (minLength !== undefined) property.minLength = minLength;
      if (maxLength !== undefined) property.maxLength = maxLength;
      if (optional) property.optional = true;
      if (wantSearchable) property.searchable = { language: "english" };
      const example = "x".repeat(Math.max(minLength ?? 0, 1));
      return {
        property: property as unknown as RuntimePropertyType,
        example,
      };
    },
  );

const numberPropertyArb: fc.Arbitrary<PropertyAndExample> = fc
  .record({
    int: fc.boolean(),
    optional: fc.boolean(),
  })
  .map(({ int, optional }): PropertyAndExample => {
    const property: Record<string, unknown> = { type: "number" };
    if (int) property.int = true;
    if (optional) property.optional = true;
    return {
      property: property as unknown as RuntimePropertyType,
      example: int ? 7 : 1.5,
    };
  });

const booleanPropertyArb: fc.Arbitrary<PropertyAndExample> = fc
  .record({ optional: fc.boolean() })
  .map(({ optional }): PropertyAndExample => {
    const property: Record<string, unknown> = { type: "boolean" };
    if (optional) property.optional = true;
    return {
      property: property as unknown as RuntimePropertyType,
      example: true,
    };
  });

const enumPropertyArb: fc.Arbitrary<PropertyAndExample> = fc
  .uniqueArray(enumValueArb, { minLength: 1, maxLength: 5 })
  .map((values): PropertyAndExample => {
    return {
      property: { type: "enum", values },
      example: values[0],
    };
  });

const leafPropertyArb: fc.Arbitrary<PropertyAndExample> = fc.oneof(
  stringPropertyArb,
  numberPropertyArb,
  booleanPropertyArb,
  enumPropertyArb,
);

const arrayPropertyArb: fc.Arbitrary<PropertyAndExample> = leafPropertyArb.map(
  (leaf): PropertyAndExample => {
    return {
      property: {
        type: "array",
        items: leaf.property as RuntimeArrayItemType,
      },
      example: [leaf.example],
    };
  },
);

const objectPropertyArb: fc.Arbitrary<PropertyAndExample> = fc
  .uniqueArray(fc.tuple(propertyNameArb, leafPropertyArb), {
    minLength: 1,
    maxLength: 4,
    selector: ([name]) => name,
  })
  .map((entries): PropertyAndExample => {
    const properties: Record<string, RuntimeObjectFieldProperty> = {};
    const example: Record<string, unknown> = {};
    for (const [name, leaf] of entries) {
      properties[name] = leaf.property as RuntimeObjectFieldProperty;
      example[name] = leaf.example;
    }
    return {
      property: { type: "object", properties },
      example,
    };
  });

const propertyArb: fc.Arbitrary<PropertyAndExample> = fc.oneof(
  leafPropertyArb,
  arrayPropertyArb,
  objectPropertyArb,
);

// ============================================================
// Document + example payload arbitrary
// ============================================================

type NodeAndExample = Readonly<{
  kindName: string;
  properties: Record<string, RuntimePropertyType>;
  example: Record<string, unknown>;
}>;

const nodeArb: fc.Arbitrary<NodeAndExample> = fc
  .record({
    kindName: nodeKindNameArb,
    fields: fc.uniqueArray(
      fc.tuple(propertyNameArb, propertyArb, fc.boolean()),
      {
        minLength: 1,
        maxLength: 5,
        selector: ([name]) => name,
      },
    ),
  })
  .map(({ kindName, fields }) => {
    const properties: Record<string, RuntimePropertyType> = {};
    const example: Record<string, unknown> = {};
    for (const [name, propertyAndExample, includeOptional] of fields) {
      properties[name] = propertyAndExample.property;
      // Optional fields are present in the example payload only when the
      // accompanying boolean from the arbitrary says so. Required fields
      // are always present — that's what `optional !== true` enforces.
      if (propertyAndExample.property.optional !== true || includeOptional) {
        example[name] = propertyAndExample.example;
      }
    }
    return { kindName, properties, example };
  });

// ============================================================
// Property tests
// ============================================================

describe("runtime extension property tests", () => {
  it("compiles every well-formed document and accepts the example payload", () => {
    fc.assert(
      fc.property(nodeArb, ({ kindName, properties, example }) => {
        const document = defineRuntimeExtension({
          nodes: { [kindName]: { properties } },
        });
        const compiled = compileRuntimeExtension(document);
        expect(compiled.nodes).toHaveLength(1);
        const node = compiled.nodes[0]!;
        expect(node.type.kind).toBe(kindName);

        const result = node.type.schema.safeParse(example);
        expect(result.success).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("preserves searchable language metadata on string properties", () => {
    const arb = fc.record({
      kindName: nodeKindNameArb,
      propertyName: propertyNameArb,
      language: fc.constantFrom(
        "english",
        "spanish",
        "german",
        "french",
        "simple",
      ),
    });
    fc.assert(
      fc.property(arb, ({ kindName, propertyName, language }) => {
        const document = defineRuntimeExtension({
          nodes: {
            [kindName]: {
              properties: {
                [propertyName]: { type: "string", searchable: { language } },
              },
            },
          },
        });
        const compiled = compileRuntimeExtension(document);
        const schema = compiled.nodes[0]!.type.schema.shape[propertyName];
        expect(schema).toBeDefined();
        expect(getSearchableMetadata(schema! as z.ZodType)).toEqual({
          language,
        });
      }),
      { numRuns: 50 },
    );
  });

  it("preserves embedding dimensions on array-of-number properties", () => {
    const arb = fc.record({
      kindName: nodeKindNameArb,
      propertyName: propertyNameArb,
      dimensions: fc.integer({ min: 1, max: 4096 }),
    });
    fc.assert(
      fc.property(arb, ({ kindName, propertyName, dimensions }) => {
        const document = defineRuntimeExtension({
          nodes: {
            [kindName]: {
              properties: {
                [propertyName]: {
                  type: "array",
                  items: { type: "number" },
                  embedding: { dimensions },
                },
              },
            },
          },
        });
        const compiled = compileRuntimeExtension(document);
        const schema = compiled.nodes[0]!.type.schema.shape[propertyName];
        expect(schema).toBeDefined();
        expect(getEmbeddingDimensions(schema! as z.ZodType)).toBe(dimensions);
      }),
      { numRuns: 30 },
    );
  });
});
