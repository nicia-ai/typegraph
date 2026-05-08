/**
 * Property-based tests for the graph-extension document and compiler.
 *
 * fast-check generates arbitrary documents over the v1 property-type
 * subset, and the suite asserts the load-bearing invariant from issue
 * #101 PR 3:
 *
 * - `compileGraphExtension(defineGraphExtension(doc))` always
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
import { z } from "zod";

import { defineGraph } from "../../src/core/define-graph";
import { getEmbeddingDimensions } from "../../src/core/embedding";
import { defineNode } from "../../src/core/node";
import { getSearchableMetadata } from "../../src/core/searchable";
import {
  defineGraphExtension,
  type ExtensionArrayItemType,
  type ExtensionNodeDef,
  type ExtensionObjectFieldProperty,
  type ExtensionPropertyType,
  type GraphExtension,
  validateGraphExtension,
} from "../../src/graph-extension";
// Internal compiler / merge / canonical — reached via file path so
// the property tests can exercise round-trip invariants without
// forcing the barrel to re-export them.
import { compileGraphExtension } from "../../src/graph-extension/compiler";
import { mergeGraphExtension } from "../../src/graph-extension/merge";
import { canonicalEqual, sortedReplacer } from "../../src/schema/canonical";
import {
  computeSchemaHash,
  serializeSchema,
} from "../../src/schema/serializer";

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
  property: ExtensionPropertyType;
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
        property: property as unknown as ExtensionPropertyType,
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
      property: property as unknown as ExtensionPropertyType,
      example: int ? 7 : 1.5,
    };
  });

const booleanPropertyArb: fc.Arbitrary<PropertyAndExample> = fc
  .record({ optional: fc.boolean() })
  .map(({ optional }): PropertyAndExample => {
    const property: Record<string, unknown> = { type: "boolean" };
    if (optional) property.optional = true;
    return {
      property: property as unknown as ExtensionPropertyType,
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
        items: leaf.property as ExtensionArrayItemType,
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
    const properties: Record<string, ExtensionObjectFieldProperty> = {};
    const example: Record<string, unknown> = {};
    for (const [name, leaf] of entries) {
      properties[name] = leaf.property as ExtensionObjectFieldProperty;
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
  properties: Record<string, ExtensionPropertyType>;
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
    const properties: Record<string, ExtensionPropertyType> = {};
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

describe("graph extension property tests", () => {
  it("compiles every well-formed document and accepts the example payload", () => {
    fc.assert(
      fc.property(nodeArb, ({ kindName, properties, example }) => {
        const document = defineGraphExtension({
          nodes: { [kindName]: { properties } },
        });
        const compiled = compileGraphExtension(document);
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
        const document = defineGraphExtension({
          nodes: {
            [kindName]: {
              properties: {
                [propertyName]: { type: "string", searchable: { language } },
              },
            },
          },
        });
        const compiled = compileGraphExtension(document);
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
        const document = defineGraphExtension({
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
        const compiled = compileGraphExtension(document);
        const schema = compiled.nodes[0]!.type.schema.shape[propertyName];
        expect(schema).toBeDefined();
        expect(getEmbeddingDimensions(schema! as z.ZodType)).toBe(dimensions);
      }),
      { numRuns: 30 },
    );
  });
});

// ============================================================
// Multi-node extension arbitrary (for round-trip / merge invariants)
//
// `nodeArb` produces one (kindName, properties) tuple. The next group
// of tests wants extensions with N kinds, so we lift `nodeArb` into a
// `uniqueArray` keyed by `kindName` to avoid colliding kinds.
// ============================================================

const multiNodeExtensionArb: fc.Arbitrary<GraphExtension> = fc
  .uniqueArray(nodeArb, {
    minLength: 1,
    maxLength: 4,
    selector: (n) => n.kindName,
  })
  .map((nodes): GraphExtension => {
    const nodesRecord: Record<string, ExtensionNodeDef> = {};
    for (const { kindName, properties } of nodes) {
      nodesRecord[kindName] = { properties };
    }
    return defineGraphExtension({ nodes: nodesRecord });
  });

const multiNodeRecordArb: fc.Arbitrary<
  readonly Readonly<{
    kindName: string;
    properties: Record<string, ExtensionPropertyType>;
  }>[]
> = fc.uniqueArray(nodeArb, {
  minLength: 2,
  maxLength: 4,
  selector: (n) => n.kindName,
});

// Real-Zod baseline graph for the merge / hash invariants. The
// extension layer never inspects compile-time Zod, but
// `mergeGraphExtension` does call `defineGraph` machinery that
// requires an actual `defineNode` shape.
const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const baselineGraph = defineGraph({
  id: "prop_extension_invariants",
  nodes: { Person: { type: Person } },
  edges: {},
});

// ============================================================
// Algebraic invariants
//
// These pin properties that follow from the design — idempotency of
// the document factory, declaration-order independence of canonical
// hashes, JSON round-trip stability, merge idempotency. They aren't
// strictly redundant with the unit tests because fast-check explores
// the cross-product of property types / refinements that hand-written
// tests can't enumerate.
// ============================================================

describe("graph extension — algebraic invariants", () => {
  it("defineGraphExtension is idempotent under canonical equality", () => {
    fc.assert(
      fc.property(multiNodeExtensionArb, (extension) => {
        const reapplied = defineGraphExtension(extension);
        expect(canonicalEqual(extension, reapplied)).toBe(true);
      }),
      { numRuns: 80 },
    );
  });

  it("canonical-form JSON round-trip preserves the extension", () => {
    fc.assert(
      fc.property(multiNodeExtensionArb, (extension) => {
        const serialized = JSON.stringify(extension, sortedReplacer);
        const parsed = JSON.parse(serialized) as unknown;
        const revalidated = validateGraphExtension(parsed, { strict: true });
        expect(revalidated.success).toBe(true);
        if (!revalidated.success) throw revalidated.error;
        expect(canonicalEqual(extension, revalidated.data)).toBe(true);
      }),
      { numRuns: 80 },
    );
  });

  it("declaration order does not affect the merged-graph schema hash", async () => {
    // Two extensions whose nodes are declared in opposite order must
    // produce the same canonical schema hash — the persistence layer
    // sorts every collection by name before hashing, so insertion
    // order isn't part of the schema's identity.
    await fc.assert(
      fc.asyncProperty(multiNodeRecordArb, async (nodes) => {
        const forward: Record<string, ExtensionNodeDef> = {};
        const reversed: Record<string, ExtensionNodeDef> = {};
        for (const { kindName, properties } of nodes) {
          forward[kindName] = { properties };
        }
        for (const { kindName, properties } of nodes.toReversed()) {
          reversed[kindName] = { properties };
        }
        const forwardGraph = mergeGraphExtension(
          baselineGraph,
          defineGraphExtension({ nodes: forward }),
        );
        const reversedGraph = mergeGraphExtension(
          baselineGraph,
          defineGraphExtension({ nodes: reversed }),
        );
        const forwardHash = await computeSchemaHash(
          serializeSchema(forwardGraph, 1),
        );
        const reversedHash = await computeSchemaHash(
          serializeSchema(reversedGraph, 1),
        );
        expect(forwardHash).toBe(reversedHash);
      }),
      { numRuns: 30 },
    );
  });

  it("mergeGraphExtension is idempotent when the same extension is applied twice", () => {
    fc.assert(
      fc.property(multiNodeExtensionArb, (extension) => {
        const once = mergeGraphExtension(baselineGraph, extension);
        const twice = mergeGraphExtension(once, extension);
        // The merge short-circuits when the union equals the existing
        // document — same reference returned, not just structurally
        // equal. That's the contract `Store.evolve`'s no-op fast path
        // depends on for the agent-loop hot path.
        expect(twice).toBe(once);
      }),
      { numRuns: 40 },
    );
  });
});
