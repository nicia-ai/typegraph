/**
 * Shared Arbitrary Generators for Property-Based Tests
 *
 * Reusable fast-check arbitraries for TypeGraph domain objects.
 * Import these to reduce duplication across property tests.
 */
import fc from "fast-check";

import { isObjectSchema } from "../../src/schema/migration";
import { type JsonSchema } from "../../src/schema/types";
import { requireDefined } from "../../src/utils/presence";

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
// JSON-Schema Arbitraries (structural subtyping)
//
// Promoted here (rather than kept local to the structural-subtype property
// test) so the child/parent-agreement
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

/** Patterns and formats a string leaf may carry; compared by equality. */
const PATTERN_POOL = ["^a", "b$", "^[a-c]+$"] as const;
const FORMAT_POOL = ["email", "uuid", "date-time"] as const;

function stringLeafArb(): fc.Arbitrary<JsonSchema> {
  return fc
    .record(
      {
        minLength: fc.option(fc.nat({ max: 4 }), { nil: undefined }),
        maxLength: fc.option(fc.integer({ min: 4, max: 12 }), {
          nil: undefined,
        }),
        pattern: fc.option(fc.constantFrom(...PATTERN_POOL), {
          nil: undefined,
        }),
        format: fc.option(fc.constantFrom(...FORMAT_POOL), { nil: undefined }),
      },
      { requiredKeys: [] },
    )
    .map((bounds) => ({ type: "string", ...bounds }) as JsonSchema);
}

function numberLeafArb(): fc.Arbitrary<JsonSchema> {
  return fc
    .record(
      {
        type: fc.constantFrom("number", "integer"),
        minimum: fc.option(fc.integer({ min: -10, max: 0 }), {
          nil: undefined,
        }),
        maximum: fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }),
        exclusiveMinimum: fc.option(fc.integer({ min: -12, max: -1 }), {
          nil: undefined,
        }),
        exclusiveMaximum: fc.option(fc.integer({ min: 1, max: 12 }), {
          nil: undefined,
        }),
        multipleOf: fc.option(fc.constantFrom(2, 0.5, 0.25), {
          nil: undefined,
        }),
      },
      { requiredKeys: ["type"] },
    )
    .map((bounds) => bounds as JsonSchema);
}

/** A union of bare primitives, as the projection writes `.nullable()`. */
function typeTokenArrayLeafArb(): fc.Arbitrary<JsonSchema> {
  return fc
    .record(
      {
        type: fc.constantFrom<JsonSchema["type"]>(
          ["string", "null"],
          ["number", "null"],
          ["string", "number"],
        ),
        minLength: fc.option(fc.nat({ max: 3 }), { nil: undefined }),
      },
      { requiredKeys: ["type"] },
    )
    .map((fields) => fields as JsonSchema);
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
    typeTokenArrayLeafArb(),
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

/** A closed tuple, as the projection writes `z.tuple()` with no rest. */
function tupleContainerArb(
  schemaArb: fc.Arbitrary<JsonSchema>,
): fc.Arbitrary<JsonSchema> {
  return fc.array(schemaArb, { minLength: 1, maxLength: 3 }).map((members) => ({
    type: "array",
    prefixItems: members,
    items: false,
    minItems: members.length,
    maxItems: members.length,
  }));
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
    .record({
      fields: fc.uniqueArray(fieldArb, {
        selector: (field) => field.name,
        maxLength: OBJECT_FIELD_NAME_POOL.length,
      }),
      // `false` (the common `z.object` shape), `{}` — an explicitly OPEN,
      // unconstrained extras schema (`z.looseObject`'s projection) — or a
      // typed catchall (`.catchall(schema)`), so P2 and P6 also exercise
      // compareObject's width-subtyping branch for a parent property the
      // child leaves to its own open extras. The tightening operations
      // below keep a typed catchall's extras under it (see
      // `tightenAddRequiredPropertyArb`).
      extras: fc.oneof(
        fc.constant<false | JsonSchema>(false),
        fc.constant<false | JsonSchema>({}),
        schemaArb,
      ),
    })
    .map(({ fields, extras }) => {
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
        additionalProperties: extras,
      };
    });
}

/** A record, as the projection writes `z.record(keys, values)`. */
function recordContainerArb(
  schemaArb: fc.Arbitrary<JsonSchema>,
): fc.Arbitrary<JsonSchema> {
  return fc
    .record({
      keys: fc.oneof(
        fc.constant<JsonSchema>({ type: "string" }),
        fc.constant<JsonSchema>({ type: "string", minLength: 1 }),
        fc
          .subarray([...OBJECT_FIELD_NAME_POOL], { minLength: 1 })
          .map((names): JsonSchema => ({ type: "string", enum: names })),
      ),
      values: schemaArb,
    })
    .map(({ keys, values }) => ({
      type: "object",
      propertyNames: keys,
      additionalProperties: values,
    }));
}

function unionContainerArb(
  schemaArb: fc.Arbitrary<JsonSchema>,
): fc.Arbitrary<JsonSchema> {
  return fc.oneof(
    fc
      .tuple(schemaArb, schemaArb)
      .map(([first, second]) => ({ anyOf: [first, second] })),
    // Members of different types, the shape of an exclusive `oneOf`.
    fc
      .tuple(stringLeafArb(), numberLeafArb())
      .map(([first, second]) => ({ oneOf: [first, second] })),
  );
}

const jsonSchemaLetrec = fc.letrec<{
  schema: JsonSchema;
  container: JsonSchema;
}>((tie) => ({
  schema: fc.oneof({ maxDepth: 3 }, scalarSchemaArb(), tie("container")),
  container: fc.oneof(
    arrayContainerArb(tie("schema")),
    tupleContainerArb(tie("schema")),
    objectContainerArb(tie("schema")),
    recordContainerArb(tie("schema")),
    unionContainerArb(tie("schema")),
  ),
}));

/**
 * A JSON Schema drawn from the fragment `isStructuralSubtype` actually
 * compares: scalars (string with optional length bounds, `pattern` and
 * `format`; number or integer with optional inclusive and exclusive bounds
 * and `multipleOf`; a `type` token array; integer, boolean, null), `enum` /
 * `const` over a small fixed value pool, an array of a subschema with
 * optional item-count bounds, a closed tuple, an object with 0-3 properties
 * split between required and optional whose extras are closed, open or a
 * typed catchall, a record with `propertyNames`, a 2-member `anyOf`, and a
 * `oneOf` of a string and a number. Depth is capped at 3. Deliberately never generates `$ref`, `not`, `allOf`, or an
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
  // A key the parent does not name must satisfy the parent's typed catchall.
  const extras = parent.additionalProperties;
  const propertySchemaArb =
    typeof extras === "object" && Object.keys(extras).length > 0 ?
      tightenArb(extras)
    : comparableSchemaArb;
  return fc
    .tuple(fc.constantFrom(...freshNames), propertySchemaArb)
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
  // Dropping a declared property is only a sound tightening when `parent` is
  // CLOSED: an open `parent` still constrains that property name
  // through its own additional-properties schema, so simply omitting the
  // property from `properties` would fall back to that OPEN schema — which
  // may be looser than the one being dropped, un-tightening the child.
  if (parent.additionalProperties !== false) return undefined;
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
    tightenArb(
      requireDefined(
        parentProps[name],
        `Expected property "${name}" to be present.`,
      ),
    ).map((tightenedProperty) => ({
      ...parent,
      properties: { ...parentProps, [name]: tightenedProperty },
    })),
  );
}

function tightenExclusiveBoundsArb(
  parent: JsonSchema,
): fc.Arbitrary<JsonSchema> | undefined {
  const exclusiveMinimum =
    typeof parent["exclusiveMinimum"] === "number" ?
      parent["exclusiveMinimum"]
    : undefined;
  const exclusiveMaximum =
    typeof parent["exclusiveMaximum"] === "number" ?
      parent["exclusiveMaximum"]
    : undefined;
  if (exclusiveMinimum === undefined && exclusiveMaximum === undefined) {
    return undefined;
  }
  return fc
    .record({ lowerDelta: fc.nat({ max: 2 }), upperDelta: fc.nat({ max: 2 }) })
    .map(({ lowerDelta, upperDelta }) => ({
      ...parent,
      ...(exclusiveMinimum === undefined ?
        {}
      : { exclusiveMinimum: exclusiveMinimum + lowerDelta }),
      ...(exclusiveMaximum === undefined ?
        {}
      : { exclusiveMaximum: exclusiveMaximum - upperDelta }),
    }));
}

function replaceMember(
  members: readonly JsonSchema[],
  index: number,
  member: JsonSchema,
): JsonSchema[] {
  return members.map((existing, position) =>
    position === index ? member : existing,
  );
}

/** One `key` member list (`prefixItems`, `anyOf`, `oneOf`) with a member tightened. */
function tightenMemberArb(
  parent: JsonSchema,
  key: "prefixItems" | "anyOf" | "oneOf",
): fc.Arbitrary<JsonSchema> | undefined {
  const members = parent[key];
  if (members === undefined || members.length === 0) return undefined;
  return fc.nat({ max: members.length - 1 }).chain((index) =>
    tightenArb(requireDefined(members[index])).map((member) => ({
      ...parent,
      [key]: replaceMember(members, index, member),
    })),
  );
}

/** An array's `items`, or an object's typed extras, tightened. */
function tightenSubschemaArb(
  parent: JsonSchema,
  key: "items" | "additionalProperties",
): fc.Arbitrary<JsonSchema> | undefined {
  const subschema = parent[key];
  if (typeof subschema !== "object" || Object.keys(subschema).length === 0) {
    return undefined;
  }
  return tightenArb(subschema).map((tightened) => ({
    ...parent,
    [key]: tightened,
  }));
}

/**
 * A schema guaranteed BY CONSTRUCTION to be a structural subtype of `parent`:
 * identity, or one of the tightening operations applicable to `parent`'s
 * shape (raise a string/number bound or an exclusive bound, narrow an enum,
 * promote an enum member to `const`, add a fresh required property, drop an
 * optional property, or recursively tighten one existing property, tuple
 * member, union member, array item schema or typed extras schema). Only operations that apply to
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
    tightenExclusiveBoundsArb(parent),
    tightenMemberArb(parent, "prefixItems"),
    tightenMemberArb(parent, "anyOf"),
    tightenMemberArb(parent, "oneOf"),
    tightenSubschemaArb(parent, "items"),
    tightenSubschemaArb(parent, "additionalProperties"),
  ].filter(
    (candidate): candidate is fc.Arbitrary<JsonSchema> =>
      candidate !== undefined,
  );
  return fc.oneof(...candidates);
}
