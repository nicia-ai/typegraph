/**
 * Structural subtyping over the projected JSON Schema fragment.
 *
 * `isStructuralSubtype(child, parent)` answers one question: is every value
 * that satisfies `child` guaranteed to also satisfy `parent`, judged
 * ENTIRELY on the projected JSON Schema (`serializeSchemaProperties`,
 * src/schema/serializer.ts) — never on the originating Zod schema and never
 * on stored data. Because the projection erases refinements, transforms,
 * and brands (`.refine`, `.superRefine`, `.brand`, `.pipe`, `.lazy`,
 * `.toLowerCase()` all collapse to their base schema — see the inventory in
 * the plan's evidence section), this predicate is necessarily blind to them
 * too: a Zod-level narrowing with no JSON-Schema trace cannot be judged.
 *
 * This is a different question from `isBreakingPropertyChange`
 * (./migration.ts), which answers "do rows that were valid before a schema
 * edit stay valid after it" — and the two disagree in both directions over
 * the same pair of schemas:
 *   - a child that ADDS a required property is a structural subtype (every
 *     child-valid value already satisfies the parent, which asks less) but
 *     IS a breaking migration (an existing row lacks the new field);
 *   - a child that relaxes a parent-required property to optional is a SAFE
 *     migration (every existing row still validates) but is NOT a
 *     structural subtype (the parent's guarantee no longer holds).
 * Do not reach for one where the other is asked.
 *
 * ## The rule set (in the order `compareSchemas` applies it)
 *
 * 1. A pair nested past `MAX_STRUCTURAL_SUBTYPE_DEPTH` is `incomparable`
 *    ("max-depth-exceeded") — schemas arrive from persisted documents, and
 *    the guard mirrors `MAX_JSON_POINTER_DEPTH` (src/query/json-pointer.ts).
 * 2. Either side carrying `$ref` is `incomparable` ("schema-reference"): the
 *    projection emits `$ref` exactly at a self- or mutually-recursive cycle,
 *    which is why recursion here cannot diverge.
 * 3. Either side carrying a keyword this predicate recognizes as
 *    CONSTRAINING but does not model — `not` (`z.never()`), `allOf`
 *    (`z.intersection`, whose subtyping is a named follow-up), or
 *    `contentEncoding` (`z.file()`) — is `incomparable` ("unsupported-keyword").
 * 4. Any OTHER keyword outside `COMPARABLE_KEYWORDS` is silently IGNORED for
 *    subtyping. This is deliberately the opposite of `isBreakingPropertyChange`'s
 *    diff rule, where an unrecognized key is user data whose change must be
 *    surfaced: standard JSON Schema semantics treat a keyword a reader does
 *    not understand as adding no constraint, and this predicate follows that
 *    reading. A `searchable()` field's `_searchableField` tag
 *    (src/core/searchable.ts:120) and an arbitrary `.meta()` key both fall
 *    out of this rule with no special case — see `format` below for the one
 *    keyword this predicate recognizes AND still treats as non-constraining.
 * 5. If the two schemas are identical once irrelevant keywords are dropped,
 *    they are mutual subtypes — this is what makes reflexivity hold for
 *    every comparable schema by construction.
 * 6. If either side is a union (`anyOf`, or `oneOf` — read as `anyOf`; the
 *    projection emits `oneOf` only for `z.discriminatedUnion`, whose members
 *    are mutually exclusive by construction, so the two readings coincide
 *    over this fragment, with no overlap detection performed), every child
 *    member must find SOME parent member it subtypes. This is also what
 *    handles nullability with no special case: `z.string()` is a subtype of
 *    `z.string().nullable()` (`anyOf: [string, null]`) because the lone
 *    child member matches the union's first member; the reverse is not,
 *    because the union's `null` member matches nothing on a bare `string`
 *    parent.
 * 7. Otherwise the two are compared as leaves: value sets (`const`/`enum`)
 *    must narrow, type tokens must agree (`integer` narrows `number`),
 *    objects compare property-by-property with the child allowed to add or
 *    drop optional properties (width subtyping — the parent's
 *    `additionalProperties: false` is NOT applied to the child's added
 *    keys, only an explicit non-`false` `additionalProperties` schema
 *    constrains them), arrays compare bounds/items/tuple prefixes, strings
 *    compare length bounds and `pattern` (`format` is an ANNOTATION here,
 *    not a constraint — the projection emits it exactly where `pattern`
 *    already carries the real constraint, e.g. `z.email()`, `z.uuid()`,
 *    `z.iso.*`), and numbers compare bounds folding `exclusiveMinimum` /
 *    `exclusiveMaximum` in.
 *
 * An unmodeled construct always yields `{ verdict: "incomparable" }` and is
 * never silently accepted as a match.
 */
import { createDataKeyedBag, hasOwnKey } from "../utils/object";
import { requireDefined } from "../utils/presence";
import { sortedReplacer } from "./canonical";
import {
  isObjectSchema,
  propertySchemasEqual,
  propertyTypeSignature,
  stripSchemaMetadata,
} from "./migration";
import { type JsonSchema } from "./types";

// ============================================================
// Public API
// ============================================================

/** Why a comparable pair is not a subtype. */
export type StructuralSubtypeReason =
  | "missing-required-property"
  | "optional-in-child-required-in-parent"
  | "type-token-mismatch"
  | "unconstrained-where-parent-constrains"
  | "value-set-not-subset"
  | "string-length-not-tighter"
  | "pattern-mismatch"
  | "numeric-bound-not-tighter"
  | "multiple-of-mismatch"
  | "array-bounds-not-tighter"
  | "tuple-arity-mismatch"
  | "no-matching-union-member"
  | "property-names-mismatch";

/** Why the pair cannot be decided at all. */
export type StructuralIncomparableReason =
  | "unsupported-keyword"
  | "schema-reference"
  | "type-token-array"
  | "unsupported-construct"
  | "max-depth-exceeded";

/**
 * The result of comparing a `child` schema against a `parent` schema. A
 * single discriminant (`verdict`) distinguishes all three outcomes: use
 * `result.verdict === "subtype"` for the happy path, and the `reason` /
 * `path` fields (present on both failure shapes) to explain a refusal.
 * `path` is a human-readable trail — property names and the segment
 * constants below — not a JSON Pointer.
 */
export type StructuralSubtypeResult =
  | Readonly<{ verdict: "subtype" }>
  | Readonly<{
      verdict: "not-subtype";
      reason: StructuralSubtypeReason;
      path: readonly string[];
    }>
  | Readonly<{
      verdict: "incomparable";
      reason: StructuralIncomparableReason;
      path: readonly string[];
    }>;

/**
 * Is every value that satisfies `child` guaranteed to also satisfy `parent`?
 * See the module doc comment above for the complete rule set and its
 * relationship to `isBreakingPropertyChange`.
 */
export function isStructuralSubtype(
  child: JsonSchema,
  parent: JsonSchema,
): StructuralSubtypeResult {
  return compareSchemas(child, parent, [], 0);
}

// ============================================================
// Named constants
// ============================================================

const MAX_STRUCTURAL_SUBTYPE_DEPTH = 64;

const ARRAY_ITEM_SEGMENT = "[]";
const ADDITIONAL_PROPERTIES_SEGMENT = "{additionalProperties}";
const PROPERTY_NAMES_SEGMENT = "{propertyNames}";

function tupleIndexSegment(index: number): string {
  return `[${index}]`;
}

function unionMemberSegment(index: number): string {
  return `anyOf[${index}]`;
}

const OBJECT_TYPE_TOKEN = "object";
const ARRAY_TYPE_TOKEN = "array";
const STRING_TYPE_TOKEN = "string";
const NUMBER_TYPE_TOKEN = "number";
const INTEGER_TYPE_TOKEN = "integer";
const BOOLEAN_TYPE_TOKEN = "boolean";
const NULL_TYPE_TOKEN = "null";

const ANY_OF_SIGNATURE = "anyOf";
const ONE_OF_SIGNATURE = "oneOf";

/**
 * Keywords the Zod projection can emit that DO constrain the value space but
 * this predicate does not model the semantics of. Unlike an ordinary
 * unrecognized keyword (silently ignored per rule 4 in the module doc
 * comment above), these are keywords this predicate KNOWS constrain values —
 * treating them as decoration would accept subtype verdicts that are not
 * actually sound (e.g. reading `z.never()`'s `not: {}` as "no constraint"
 * would make every schema a subtype of the bottom type). `allOf`
 * (`z.intersection`) is named explicitly per the lead's ruling: intersection
 * subtyping is real and deliberately deferred, not merely undecorated.
 */
const UNMODELED_CONSTRAINING_KEYWORDS: ReadonlySet<string> = new Set([
  "not",
  "allOf",
  "contentEncoding",
]);

/**
 * Exactly the constraining keywords this predicate actively compares. Every
 * other key surviving `stripSchemaMetadata` — `format` included, since the
 * projection emits it as a pure annotation alongside the `pattern` that
 * carries the actual constraint — is dropped by `comparableKeywords` and
 * never blocks a verdict. That drop is rule 4 above, deliberately the
 * opposite of `isBreakingPropertyChange`'s diff rule (there, an unrecognized
 * key is user data whose change must be surfaced; here, an unrecognized key
 * constrains nothing, so it cannot make two schemas differ for subtyping
 * purposes) because the two predicates answer different questions.
 */
const COMPARABLE_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "anyOf",
  "oneOf",
]);

const SUBTYPE: StructuralSubtypeResult = { verdict: "subtype" };

// ============================================================
// Result builders
// ============================================================

function notSubtype(
  reason: StructuralSubtypeReason,
  path: readonly string[],
): StructuralSubtypeResult {
  return { verdict: "not-subtype", reason, path };
}

function incomparable(
  reason: StructuralIncomparableReason,
  path: readonly string[],
): StructuralSubtypeResult {
  return { verdict: "incomparable", reason, path };
}

// ============================================================
// Keyword partitioning
// ============================================================

/**
 * `undefined` when `schema` carries no keyword this predicate knows
 * constrains values but cannot model; otherwise the `incomparable` result to
 * return immediately.
 */
function unmodeledConstruct(
  schema: JsonSchema,
  path: readonly string[],
): StructuralSubtypeResult | undefined {
  const stripped = stripSchemaMetadata(schema);
  for (const key of Object.keys(stripped)) {
    if (UNMODELED_CONSTRAINING_KEYWORDS.has(key)) {
      return incomparable("unsupported-keyword", path);
    }
  }
  return undefined;
}

/**
 * `schema` reduced to only the keywords this predicate compares — migration
 * metadata (description/title/default/$schema) and any keyword outside
 * `COMPARABLE_KEYWORDS` (an annotation like `format`, or an arbitrary
 * unrecognized key such as `_searchableField` or a user `.meta()` entry) are
 * dropped. Used only for the equality fast path below; the per-construct
 * comparison functions read the original schema directly.
 */
function comparableKeywords(schema: JsonSchema): Record<string, unknown> {
  const stripped = stripSchemaMetadata(schema);
  const kept = createDataKeyedBag<unknown>();
  for (const [key, value] of Object.entries(stripped)) {
    if (COMPARABLE_KEYWORDS.has(key)) kept[key] = value;
  }
  return kept;
}

function hasKeywordOutsideValueSet(keywords: Record<string, unknown>): boolean {
  for (const key of Object.keys(keywords)) {
    if (key !== "const" && key !== "enum") return true;
  }
  return false;
}

// ============================================================
// Entry point
// ============================================================

function compareSchemas(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
  depth: number,
): StructuralSubtypeResult {
  if (depth > MAX_STRUCTURAL_SUBTYPE_DEPTH) {
    return incomparable("max-depth-exceeded", path);
  }

  if (hasOwnKey(child, "$ref") || hasOwnKey(parent, "$ref")) {
    return incomparable("schema-reference", path);
  }

  const childUnmodeled = unmodeledConstruct(child, path);
  if (childUnmodeled !== undefined) return childUnmodeled;
  const parentUnmodeled = unmodeledConstruct(parent, path);
  if (parentUnmodeled !== undefined) return parentUnmodeled;

  if (
    propertySchemasEqual(comparableKeywords(child), comparableKeywords(parent))
  ) {
    return SUBTYPE;
  }

  const childSignature = propertyTypeSignature(child);
  const parentSignature = propertyTypeSignature(parent);
  if (isUnionSignature(childSignature) || isUnionSignature(parentSignature)) {
    return compareUnion(child, parent, path, depth);
  }

  return compareLeaf(child, parent, path, depth);
}

function isUnionSignature(signature: string): boolean {
  return signature === ANY_OF_SIGNATURE || signature === ONE_OF_SIGNATURE;
}

// ============================================================
// Unions
// ============================================================

function unionMembers(schema: JsonSchema): readonly JsonSchema[] {
  return schema.anyOf ?? schema.oneOf ?? [schema];
}

function compareUnion(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
  depth: number,
): StructuralSubtypeResult {
  const childMembers = unionMembers(child);
  const parentMembers = unionMembers(parent);

  for (const [childIndex, childMember] of childMembers.entries()) {
    const memberPath = [...path, unionMemberSegment(childIndex)];
    let matchedParentMember = false;
    for (const parentMember of parentMembers) {
      const probeResult = compareSchemas(
        childMember,
        parentMember,
        memberPath,
        depth + 1,
      );
      if (probeResult.verdict === "incomparable") return probeResult;
      if (probeResult.verdict === "subtype") {
        matchedParentMember = true;
        break;
      }
    }
    if (!matchedParentMember) {
      return notSubtype("no-matching-union-member", memberPath);
    }
  }

  return SUBTYPE;
}

// ============================================================
// Leaves
// ============================================================

function compareLeaf(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
  depth: number,
): StructuralSubtypeResult {
  const valueSetResult = compareValueSets(child, parent, path);
  if (valueSetResult.verdict !== "subtype") return valueSetResult;

  const childType = child.type;
  const parentType = parent.type;

  if (Array.isArray(childType) || Array.isArray(parentType)) {
    return incomparable("type-token-array", path);
  }

  if (parentType !== undefined && childType === undefined) {
    return notSubtype("unconstrained-where-parent-constrains", path);
  }

  const isIntegerNarrowingNumber =
    childType === INTEGER_TYPE_TOKEN && parentType === NUMBER_TYPE_TOKEN;
  if (
    childType !== undefined &&
    parentType !== undefined &&
    childType !== parentType &&
    !isIntegerNarrowingNumber
  ) {
    return notSubtype("type-token-mismatch", path);
  }

  if (isObjectSchema(child) && isObjectSchema(parent)) {
    return compareObject(child, parent, path, depth);
  }

  switch (childType ?? parentType) {
    case ARRAY_TYPE_TOKEN: {
      return compareArray(child, parent, path, depth);
    }
    case STRING_TYPE_TOKEN: {
      return compareStringConstraints(child, parent, path);
    }
    case NUMBER_TYPE_TOKEN:
    case INTEGER_TYPE_TOKEN: {
      return compareNumericConstraints(child, parent, path);
    }
    case BOOLEAN_TYPE_TOKEN:
    case NULL_TYPE_TOKEN: {
      return SUBTYPE;
    }
    case OBJECT_TYPE_TOKEN: {
      return compareObject(child, parent, path, depth);
    }
    // `undefined` here means neither side carries a `type` token at all —
    // both are `{}`, or both carry only `const`/`enum` (already checked
    // above by `compareValueSets`).
    case undefined:
    default: {
      if (
        hasKeywordOutsideValueSet(comparableKeywords(child)) ||
        hasKeywordOutsideValueSet(comparableKeywords(parent))
      ) {
        return incomparable("unsupported-construct", path);
      }
      return SUBTYPE;
    }
  }
}

function canonicalValueKey(value: unknown): string {
  return JSON.stringify(value, sortedReplacer);
}

function allowedValues(schema: JsonSchema): ReadonlySet<string> | undefined {
  if (hasOwnKey(schema, "const")) {
    return new Set([canonicalValueKey(schema.const)]);
  }
  if (schema.enum !== undefined) {
    return new Set(schema.enum.map((value) => canonicalValueKey(value)));
  }
  return undefined;
}

function compareValueSets(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
): StructuralSubtypeResult {
  const parentValues = allowedValues(parent);
  if (parentValues === undefined) return SUBTYPE;

  const childValues = allowedValues(child);
  if (childValues === undefined) {
    return notSubtype("value-set-not-subset", path);
  }
  for (const value of childValues) {
    if (!parentValues.has(value)) {
      return notSubtype("value-set-not-subset", path);
    }
  }
  return SUBTYPE;
}

// ============================================================
// Objects
// ============================================================

function additionalPropertiesSchema(
  value: boolean | JsonSchema | undefined,
): JsonSchema | undefined {
  if (value === false) return undefined;
  if (value === undefined || value === true) return {};
  return value;
}

function compareObject(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
  depth: number,
): StructuralSubtypeResult {
  const childProps = child.properties ?? {};
  const parentProps = parent.properties ?? {};
  const childRequired = new Set(child.required);
  const parentRequired = new Set(parent.required);

  for (const name of parentRequired) {
    if (!hasOwnKey(childProps, name)) {
      return notSubtype("missing-required-property", [...path, name]);
    }
    if (!childRequired.has(name)) {
      return notSubtype("optional-in-child-required-in-parent", [
        ...path,
        name,
      ]);
    }
  }

  for (const [name, parentProperty] of Object.entries(parentProps)) {
    if (!hasOwnKey(childProps, name)) continue;
    const propertyResult = compareSchemas(
      requireDefined(childProps[name]),
      parentProperty,
      [...path, name],
      depth + 1,
    );
    if (propertyResult.verdict !== "subtype") return propertyResult;
  }

  // Width subtyping. The parent's `additionalProperties: false` (or its
  // absence) is not applied to the child's extra keys — every `z.object`
  // projects `false`, so this branch is skipped for the common case, and the
  // child's added properties are unconstrained rather than refused.
  const parentAdditional = parent.additionalProperties;
  if (parentAdditional !== undefined && parentAdditional !== false) {
    const parentAdditionalSchema = requireDefined(
      additionalPropertiesSchema(parentAdditional),
    );

    for (const [name, childProperty] of Object.entries(childProps)) {
      if (hasOwnKey(parentProps, name)) continue;
      const extraResult = compareSchemas(
        childProperty,
        parentAdditionalSchema,
        [...path, name],
        depth + 1,
      );
      if (extraResult.verdict !== "subtype") return extraResult;
    }

    if (child.additionalProperties !== false) {
      const childAdditionalSchema = requireDefined(
        additionalPropertiesSchema(child.additionalProperties),
      );
      const additionalResult = compareSchemas(
        childAdditionalSchema,
        parentAdditionalSchema,
        [...path, ADDITIONAL_PROPERTIES_SEGMENT],
        depth + 1,
      );
      if (additionalResult.verdict !== "subtype") return additionalResult;
    }
  }

  // A JSON object's keys are always strings, so a child with no explicit
  // `propertyNames` (every construct but `z.record`) is exactly as tight as
  // one declaring `{"type":"string"}` — defaulting to that avoids a spurious
  // mismatch when comparing a plain object against a `z.record` parent.
  const childPropertyNames = child.propertyNames ?? { type: STRING_TYPE_TOKEN };
  if (
    parent.propertyNames !== undefined &&
    !propertySchemasEqual(childPropertyNames, parent.propertyNames)
  ) {
    return notSubtype("property-names-mismatch", [
      ...path,
      PROPERTY_NAMES_SEGMENT,
    ]);
  }

  return SUBTYPE;
}

// ============================================================
// Arrays and tuples
// ============================================================

function compareArray(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
  depth: number,
): StructuralSubtypeResult {
  const childMinItems = child.minItems ?? 0;
  const parentMinItems = parent.minItems ?? 0;
  if (childMinItems < parentMinItems) {
    return notSubtype("array-bounds-not-tighter", path);
  }

  const childMaxItems = child.maxItems ?? Number.POSITIVE_INFINITY;
  const parentMaxItems = parent.maxItems ?? Number.POSITIVE_INFINITY;
  if (childMaxItems > parentMaxItems) {
    return notSubtype("array-bounds-not-tighter", path);
  }

  const childPrefix = child.prefixItems;
  const parentPrefix = parent.prefixItems;

  if (parentPrefix !== undefined) {
    if (childPrefix?.length !== parentPrefix.length) {
      return notSubtype("tuple-arity-mismatch", path);
    }
    for (const [index, parentMember] of parentPrefix.entries()) {
      const memberResult = compareSchemas(
        requireDefined(childPrefix[index]),
        parentMember,
        [...path, tupleIndexSegment(index)],
        depth + 1,
      );
      if (memberResult.verdict !== "subtype") return memberResult;
    }
  } else if (childPrefix !== undefined && parent.items !== undefined) {
    // A tuple narrowing a homogeneous parent array: every prefix member must
    // itself narrow the parent's item type.
    for (const [index, childMember] of childPrefix.entries()) {
      const memberResult = compareSchemas(
        childMember,
        parent.items,
        [...path, tupleIndexSegment(index)],
        depth + 1,
      );
      if (memberResult.verdict !== "subtype") return memberResult;
    }
  }

  if (parent.items !== undefined) {
    // A tuple with no rest element (`prefixItems` present, `items` absent)
    // has no elements beyond its prefix under the Zod tuple projection, even
    // though the JSON Schema alone does not encode a bound — so there is no
    // tail left to compare against `parent.items`.
    const childIsClosedTuple =
      childPrefix !== undefined && child.items === undefined;
    if (!childIsClosedTuple) {
      if (child.items === undefined) {
        return notSubtype("unconstrained-where-parent-constrains", [
          ...path,
          ARRAY_ITEM_SEGMENT,
        ]);
      }
      const itemsResult = compareSchemas(
        child.items,
        parent.items,
        [...path, ARRAY_ITEM_SEGMENT],
        depth + 1,
      );
      if (itemsResult.verdict !== "subtype") return itemsResult;
    }
  }

  return SUBTYPE;
}

// ============================================================
// Strings
// ============================================================

function compareStringConstraints(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
): StructuralSubtypeResult {
  const childMinLength = child.minLength ?? 0;
  const parentMinLength = parent.minLength ?? 0;
  if (childMinLength < parentMinLength) {
    return notSubtype("string-length-not-tighter", path);
  }

  const childMaxLength = child.maxLength ?? Number.POSITIVE_INFINITY;
  const parentMaxLength = parent.maxLength ?? Number.POSITIVE_INFINITY;
  if (childMaxLength > parentMaxLength) {
    return notSubtype("string-length-not-tighter", path);
  }

  if (parent.pattern !== undefined && child.pattern !== parent.pattern) {
    return notSubtype("pattern-mismatch", path);
  }

  return SUBTYPE;
}

// ============================================================
// Numbers
// ============================================================

type NumericBound = Readonly<{ value: number; exclusive: boolean }>;

function readNumber(schema: JsonSchema, keyword: string): number | undefined {
  const value = schema[keyword];
  return typeof value === "number" ? value : undefined;
}

function lowerBound(schema: JsonSchema): NumericBound | undefined {
  const minimum = readNumber(schema, "minimum");
  const exclusiveMinimum = readNumber(schema, "exclusiveMinimum");
  if (minimum === undefined && exclusiveMinimum === undefined) return undefined;
  if (exclusiveMinimum === undefined)
    return { value: requireDefined(minimum), exclusive: false };
  if (minimum === undefined)
    return { value: exclusiveMinimum, exclusive: true };
  return exclusiveMinimum >= minimum ?
      { value: exclusiveMinimum, exclusive: true }
    : { value: minimum, exclusive: false };
}

function upperBound(schema: JsonSchema): NumericBound | undefined {
  const maximum = readNumber(schema, "maximum");
  const exclusiveMaximum = readNumber(schema, "exclusiveMaximum");
  if (maximum === undefined && exclusiveMaximum === undefined) return undefined;
  if (exclusiveMaximum === undefined)
    return { value: requireDefined(maximum), exclusive: false };
  if (maximum === undefined)
    return { value: exclusiveMaximum, exclusive: true };
  return exclusiveMaximum <= maximum ?
      { value: exclusiveMaximum, exclusive: true }
    : { value: maximum, exclusive: false };
}

/** Is `child`'s lower bound at least as tight as `parent`'s? */
function lowerBoundTighterOrEqual(
  child: NumericBound,
  parent: NumericBound,
): boolean {
  if (child.value !== parent.value) return child.value > parent.value;
  return child.exclusive || !parent.exclusive;
}

/** Is `child`'s upper bound at least as tight as `parent`'s? */
function upperBoundTighterOrEqual(
  child: NumericBound,
  parent: NumericBound,
): boolean {
  if (child.value !== parent.value) return child.value < parent.value;
  return child.exclusive || !parent.exclusive;
}

function compareNumericConstraints(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
): StructuralSubtypeResult {
  const parentLower = lowerBound(parent);
  if (parentLower !== undefined) {
    const childLower = lowerBound(child);
    if (
      childLower === undefined ||
      !lowerBoundTighterOrEqual(childLower, parentLower)
    ) {
      return notSubtype("numeric-bound-not-tighter", path);
    }
  }

  const parentUpper = upperBound(parent);
  if (parentUpper !== undefined) {
    const childUpper = upperBound(child);
    if (
      childUpper === undefined ||
      !upperBoundTighterOrEqual(childUpper, parentUpper)
    ) {
      return notSubtype("numeric-bound-not-tighter", path);
    }
  }

  if (
    parent.multipleOf !== undefined &&
    child.multipleOf !== parent.multipleOf
  ) {
    return notSubtype("multiple-of-mismatch", path);
  }

  return SUBTYPE;
}
