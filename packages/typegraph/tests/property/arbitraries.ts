/**
 * Shared Arbitrary Generators for Property-Based Tests
 *
 * Reusable fast-check arbitraries for TypeGraph domain objects.
 * Import these to reduce duplication across property tests.
 */
import fc from "fast-check";

import { isObjectSchema } from "../../src/schema/migration";
import { type JsonSchema } from "../../src/schema/types";

// ============================================================
// String Arbitraries
// ============================================================

/**
 * Unicode strings including edge cases.
 */
export const unicodeStringArb = fc.oneof(
  fc.string(), // ASCII
  fc.string({ unit: "grapheme" }), // Unicode graphemes
  fc.constant(""), // Empty
  fc.constant(" ".repeat(3)), // Whitespace only
  fc.constantFrom(
    "日本語", // Japanese
    "中文", // Chinese
    "한국어", // Korean
    "العربية", // Arabic
    "עברית", // Hebrew
    "Ελληνικά", // Greek
    "Кириллица", // Cyrillic
    "🎉🚀💻", // Emoji
    "Hello\nWorld", // Newlines
    "Tab\there", // Tabs
    "Quote's\"here", // Quotes
    String.raw`Back\slash`, // Backslash
  ),
);

// ============================================================
// Query-Related Arbitraries
// ============================================================

/**
 * Sort directions.
 */
export const sortDirectionArb = fc.constantFrom("asc", "desc");

// ============================================================
// JSON-Schema Arbitraries (structural subtyping, Item C.2)
//
// Promoted here (rather than kept local to the structural-subtype property
// test) per the lead's ruling so the C.1 lane's child/parent-agreement
// property test can import them without re-spelling the generator.
// ============================================================

/**
 * Object-schema field names the generator draws from. Kept disjoint from
 * `ADDED_PROPERTY_NAME_POOL` (below) so `tightenArb`'s "add a required
 * property" operation never needs to filter for a name collision — the two
 * pools simply never overlap.
 */
const OBJECT_FIELD_NAME_POOL = ["fieldA", "fieldB", "fieldC"] as const;

/** Property names `tightenArb` uses when adding a new required property. */
const ADDED_PROPERTY_NAME_POOL = [
  "addedW",
  "addedX",
  "addedY",
  "addedZ",
] as const;

/** A small fixed pool of scalar values for `enum` / `const` generation. */
const ENUM_VALUE_POOL: readonly unknown[] = [
  "alpha",
  "beta",
  "gamma",
  0,
  1,
  2,
  true,
  false,
];

function stringLeafArb(): fc.Arbitrary<JsonSchema> {
  return fc
    .record(
      {
        minLength: fc.option(fc.nat({ max: 4 }), { nil: undefined }),
        maxLength: fc.option(fc.integer({ min: 4, max: 12 }), {
          nil: undefined,
        }),
      },
      { requiredKeys: [] },
    )
    .map((bounds) => ({ type: "string", ...bounds }) as JsonSchema);
}

function numberLeafArb(): fc.Arbitrary<JsonSchema> {
  return fc
    .record(
      {
        minimum: fc.option(fc.integer({ min: -10, max: 0 }), {
          nil: undefined,
        }),
        maximum: fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }),
      },
      { requiredKeys: [] },
    )
    .map((bounds) => ({ type: "number", ...bounds }) as JsonSchema);
}

function enumLeafArb(): fc.Arbitrary<JsonSchema> {
  return fc
    .subarray([...ENUM_VALUE_POOL], { minLength: 1 })
    .map((values) => ({ enum: values }));
}

function constLeafArb(): fc.Arbitrary<JsonSchema> {
  return fc.constantFrom(...ENUM_VALUE_POOL).map((value) => ({ const: value }));
}

function scalarSchemaArb(): fc.Arbitrary<JsonSchema> {
  return fc.oneof(
    stringLeafArb(),
    numberLeafArb(),
    fc.constant<JsonSchema>({ type: "integer" }),
    fc.constant<JsonSchema>({ type: "boolean" }),
    fc.constant<JsonSchema>({ type: "null" }),
    enumLeafArb(),
    constLeafArb(),
  );
}

function arrayContainerArb(
  schemaArb: fc.Arbitrary<JsonSchema>,
): fc.Arbitrary<JsonSchema> {
  return fc
    .record(
      {
        items: schemaArb,
        minItems: fc.option(fc.nat({ max: 2 }), { nil: undefined }),
        maxItems: fc.option(fc.integer({ min: 2, max: 5 }), { nil: undefined }),
      },
      { requiredKeys: ["items"] },
    )
    .map((fields) => ({ type: "array", ...fields }) as JsonSchema);
}

function objectContainerArb(
  schemaArb: fc.Arbitrary<JsonSchema>,
): fc.Arbitrary<JsonSchema> {
  const fieldArb = fc.record({
    name: fc.constantFrom(...OBJECT_FIELD_NAME_POOL),
    propertySchema: schemaArb,
    isRequired: fc.boolean(),
  });
  return fc
    .uniqueArray(fieldArb, {
      selector: (field) => field.name,
      maxLength: OBJECT_FIELD_NAME_POOL.length,
    })
    .map((fields) => {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const field of fields) {
        properties[field.name] = field.propertySchema;
        if (field.isRequired) required.push(field.name);
      }
      return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      };
    });
}

function unionContainerArb(
  schemaArb: fc.Arbitrary<JsonSchema>,
): fc.Arbitrary<JsonSchema> {
  return fc
    .tuple(schemaArb, schemaArb)
    .map(([first, second]) => ({ anyOf: [first, second] }));
}

const jsonSchemaLetrec = fc.letrec<{
  schema: JsonSchema;
  container: JsonSchema;
}>((tie) => ({
  schema: fc.oneof({ maxDepth: 3 }, scalarSchemaArb(), tie("container")),
  container: fc.oneof(
    arrayContainerArb(tie("schema")),
    objectContainerArb(tie("schema")),
    unionContainerArb(tie("schema")),
  ),
}));

/**
 * A JSON Schema drawn from the fragment `isStructuralSubtype` actually
 * compares: scalars (string with optional length bounds, number with
 * optional numeric bounds, integer, boolean, null), `enum` / `const` over a
 * small fixed value pool, an array of a subschema with optional item-count
 * bounds, an object with 0-3 properties split between required and optional
 * (always `additionalProperties: false`), and a 2-member `anyOf`. Depth is
 * capped at 3. Deliberately never generates `$ref`, `not`, `allOf`, or an
 * unrecognized key — reflexivity is claimed only over this comparable
 * fragment, not over constructs the predicate refuses.
 */
export const comparableSchemaArb: fc.Arbitrary<JsonSchema> =
  jsonSchemaLetrec.schema;

function omitProperty(
  properties: Readonly<Record<string, JsonSchema>>,
  name: string,
): Record<string, JsonSchema> {
  const remaining: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key !== name) remaining[key] = value;
  }
  return remaining;
}

// Each bound tightens independently of the other: raising `minLength` (or
// `minimum`) is a valid tightening regardless of the current `maxLength` (or
// `maximum`), and vice versa. An earlier version tried to keep the two
// bounds mutually "sensible" by clamping the lowered bound up to the raised
// one — but that clamp could push the lowered bound BACK UP past the
// parent's own value, silently un-tightening it (caught by property P3:
// chaining two such tightenings produced a schema that was no longer a
// subtype of the original parent). Applying each bound in isolation avoids
// the interaction entirely.
function tightenStringArb(
  parent: JsonSchema,
): fc.Arbitrary<JsonSchema> | undefined {
  if (parent.type !== "string") return undefined;
  const parentMaxLength = parent.maxLength;
  return fc
    .record({
      minLengthDelta: fc.nat({ max: 3 }),
      maxLengthDelta: fc.nat({ max: 3 }),
    })
    .map(({ minLengthDelta, maxLengthDelta }) => ({
      ...parent,
      minLength: (parent.minLength ?? 0) + minLengthDelta,
      ...(parentMaxLength === undefined ?
        {}
      : { maxLength: parentMaxLength - maxLengthDelta }),
    }));
}

function tightenNumericArb(
  parent: JsonSchema,
): fc.Arbitrary<JsonSchema> | undefined {
  if (parent.type !== "number" && parent.type !== "integer") return undefined;
  const parentMaximum = parent.maximum;
  return fc
    .record({
      minimumDelta: fc.nat({ max: 3 }),
      maximumDelta: fc.nat({ max: 3 }),
    })
    .map(({ minimumDelta, maximumDelta }) => ({
      ...parent,
      minimum: (parent.minimum ?? 0) + minimumDelta,
      ...(parentMaximum === undefined ?
        {}
      : { maximum: parentMaximum - maximumDelta }),
    }));
}

function tightenEnumArb(
  parent: JsonSchema,
): fc.Arbitrary<JsonSchema> | undefined {
  if (parent.enum === undefined || parent.enum.length === 0) return undefined;
  return fc
    .subarray([...parent.enum], { minLength: 1 })
    .map((values) => ({ ...parent, enum: values }));
}

function tightenToConstFromEnumArb(
  parent: JsonSchema,
): fc.Arbitrary<JsonSchema> | undefined {
  if (parent.enum === undefined || parent.enum.length === 0) return undefined;
  return fc
    .constantFrom(...parent.enum)
    .map((value) => ({ ...parent, const: value }));
}

function tightenAddRequiredPropertyArb(
  parent: JsonSchema,
): fc.Arbitrary<JsonSchema> | undefined {
  if (!isObjectSchema(parent)) return undefined;
  const parentProps = parent.properties ?? {};
  const freshNames = ADDED_PROPERTY_NAME_POOL.filter(
    (name) => !Object.hasOwn(parentProps, name),
  );
  if (freshNames.length === 0) return undefined;
  return fc
    .tuple(fc.constantFrom(...freshNames), comparableSchemaArb)
    .map(([name, propertySchema]) => ({
      ...parent,
      properties: { ...parentProps, [name]: propertySchema },
      required: [...(parent.required ?? []), name],
    }));
}

function tightenDropOptionalPropertyArb(
  parent: JsonSchema,
): fc.Arbitrary<JsonSchema> | undefined {
  if (!isObjectSchema(parent)) return undefined;
  const parentProps = parent.properties ?? {};
  const parentRequired = new Set(parent.required);
  const optionalNames = Object.keys(parentProps).filter(
    (name) => !parentRequired.has(name),
  );
  if (optionalNames.length === 0) return undefined;
  return fc.constantFrom(...optionalNames).map((name) => ({
    ...parent,
    properties: omitProperty(parentProps, name),
  }));
}

function tightenNestedPropertyArb(
  parent: JsonSchema,
): fc.Arbitrary<JsonSchema> | undefined {
  if (!isObjectSchema(parent)) return undefined;
  const parentProps = parent.properties ?? {};
  const names = Object.keys(parentProps);
  if (names.length === 0) return undefined;
  return fc.constantFrom(...names).chain((name) =>
    tightenArb(requireOwnProperty(parentProps, name)).map(
      (tightenedProperty) => ({
        ...parent,
        properties: { ...parentProps, [name]: tightenedProperty },
      }),
    ),
  );
}

function requireOwnProperty(
  properties: Readonly<Record<string, JsonSchema>>,
  name: string,
): JsonSchema {
  const value = properties[name];
  if (value === undefined) {
    throw new TypeError(`Expected property "${name}" to be present.`);
  }
  return value;
}

/**
 * A schema guaranteed BY CONSTRUCTION to be a structural subtype of `parent`:
 * identity, or one of the tightening operations applicable to `parent`'s
 * shape (raise a string/number bound, narrow an enum, promote an enum member
 * to `const`, add a fresh required property, drop an optional property, or
 * recursively tighten one existing property). Only operations that apply to
 * `parent`'s actual shape are offered, so the result is always well-typed.
 */
export function tightenArb(parent: JsonSchema): fc.Arbitrary<JsonSchema> {
  const candidates = [
    fc.constant(parent),
    tightenStringArb(parent),
    tightenNumericArb(parent),
    tightenEnumArb(parent),
    tightenToConstFromEnumArb(parent),
    tightenAddRequiredPropertyArb(parent),
    tightenDropOptionalPropertyArb(parent),
    tightenNestedPropertyArb(parent),
  ].filter(
    (candidate): candidate is fc.Arbitrary<JsonSchema> =>
      candidate !== undefined,
  );
  return fc.oneof(...candidates);
}
