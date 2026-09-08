/**
 * Structural subtyping over the projected JSON Schema fragment.
 *
 * `isStructuralSubtype(child, parent)` answers one question: is every value
 * that satisfies `child` guaranteed to also satisfy `parent`, judged
 * ENTIRELY on the projected JSON Schema (`serializeSchemaProperties`,
 * src/schema/serializer.ts) — never on the originating Zod schema and never
 * on stored data. Because the projection erases refinements, transforms,
 * and brands (`.refine`, `.superRefine`, `.brand`, `.pipe`, `.lazy`,
 * `.toLowerCase()` all collapse to their base schema), this predicate is
 * necessarily blind to them too: a Zod-level narrowing with no JSON-Schema
 * trace cannot be judged.
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
 * 2. If child and parent are the SAME schema — every keyword equal, once only
 *    non-constraining metadata (`description`/`title`/`default`/`$schema`)
 *    is dropped — child is trivially a subtype of parent, regardless of
 *    which keywords either side carries. This runs before rules 3–4 on
 *    purpose: it is what lets a child that copies a `$ref` (recursive
 *    `z.lazy`) or `allOf` (`z.intersection`) property VERBATIM from its
 *    parent still compare as a subtype for that property, even though rules
 *    3–4 can never judge `$ref`/`allOf` on their own. Two DIFFERENT `$ref`
 *    targets, or a child that merely narrows an `allOf` member, still fall
 *    through to rule 3/4 and are refused — this rule only ever fires on
 *    exact equality, so it cannot mask a genuine incompatibility.
 * 3. Either side carrying `$ref` is `incomparable` ("schema-reference"): the
 *    projection emits `$ref` exactly at a self- or mutually-recursive cycle,
 *    which is why recursion here cannot diverge.
 * 4. Either side carrying a keyword this predicate recognizes as
 *    CONSTRAINING but does not model the semantics of — `not` (`z.never()`),
 *    `allOf` (`z.intersection`, whose subtyping is a named follow-up),
 *    `contentEncoding` (`z.file()`), or a standard JSON Schema 2020-12
 *    vocabulary keyword this predicate's rule set never modeled
 *    (`uniqueItems`, `contains`/`minContains`/`maxContains`,
 *    `minProperties`/`maxProperties`, `patternProperties`,
 *    `dependentRequired`/`dependentSchemas`, `if`/`then`/`else`,
 *    `unevaluatedProperties`/`unevaluatedItems` — none emitted by the Zod
 *    projection today, but reachable through a hand-written `JsonSchema`) —
 *    is `incomparable` ("unsupported-keyword").
 * 5. Any OTHER keyword outside `COMPARABLE_KEYWORDS` is silently IGNORED for
 *    subtyping. This is deliberately the opposite of `isBreakingPropertyChange`'s
 *    diff rule, where an unrecognized key is user data whose change must be
 *    surfaced: standard JSON Schema semantics treat a keyword a reader does
 *    not understand as adding no constraint, and this predicate follows that
 *    reading. A `searchable()` field's `_searchableField` tag
 *    (src/core/searchable.ts:120) and an arbitrary `.meta()` key both fall
 *    out of this rule with no special case. `format` is NOT covered by this
 *    rule — see rule 8 below for why it is compared as a constraint instead.
 * 6. If the two schemas are identical once irrelevant keywords are dropped,
 *    they are mutual subtypes — a NARROWER identity check than rule 2 above
 *    (it tolerates schemas that differ only in an annotation/unrecognized
 *    key), reachable only once rules 3–4 have already cleared both sides of
 *    `$ref` and any unmodeled constraining keyword.
 * 7. If either side is a union (`anyOf`, or `oneOf` — read as `anyOf`; the
 *    projection emits `oneOf` only for `z.discriminatedUnion`, whose members
 *    are mutually exclusive by construction, so the two readings coincide
 *    over this fragment, with no overlap detection performed), every child
 *    member must find SOME parent member it subtypes — checking every parent
 *    member before concluding `incomparable`, so the verdict never depends on
 *    the order the parent declared its members in (a member that cannot be
 *    judged does not stop the search for a later member that matches). This
 *    is also what handles nullability with no special case: `z.string()` is a
 *    subtype of `z.string().nullable()` (`anyOf: [string, null]`) because the
 *    lone child member matches the union's first member; the reverse is not,
 *    because the union's `null` member matches nothing on a bare `string`
 *    parent. A union keyword is ANDed with any sibling keyword on the same
 *    schema object, not replaced by it — `{ type: "string", anyOf: [...] }`
 *    admits only strings that also match a member — so once the member check
 *    passes, the parent's sibling keywords (with `anyOf`/`oneOf` removed) are
 *    compared too, through the ordinary rule set; the child's own sibling
 *    keywords are not, since dropping them is conservative (see
 *    `compareUnionSiblingConstraints`).
 * 8. Otherwise the two are compared as leaves: value sets (`const`/`enum`)
 *    must narrow, type tokens must agree (`integer` narrows `number`),
 *    objects compare property-by-property with the child allowed to add or
 *    drop optional properties (width subtyping — the parent's
 *    `additionalProperties: false` is NOT applied to the child's added
 *    keys, only an explicit non-`false` `additionalProperties` schema
 *    constrains them; and a parent-declared property the child leaves to its
 *    own OPEN additional-properties schema is compared against that schema
 *    rather than skipped, since an open child does not actually omit the
 *    property — it just declares no NAMED constraint for it), arrays compare
 *    bounds/items/tuple prefixes (a closed parent tuple — `prefixItems` with
 *    no `items` — additionally requires the child be bounded to the same
 *    arity, since the Zod tuple projection encodes "no rest element" only by
 *    omitting `items`, not with an explicit length bound), strings compare
 *    length bounds, `pattern`, and `format` (`format` carries a real
 *    constraint here, not merely an annotation: `z.url()` and `z.jwt()`
 *    project `format` with no accompanying `pattern`, so treating it as
 *    decoration would accept a bare `z.string()` as a subtype of either),
 *    and numbers compare bounds folding `exclusiveMinimum` /
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
  | "format-mismatch"
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
// C.1 ↔ C.2 agreement projection
// ============================================================

/**
 * Exactly the JSON Schema keywords TypeScript's structural assignability
 * over `z.infer` can see: the shape (`type`, `properties`, `required`,
 * `items`, `prefixItems`, `anyOf`, `oneOf`, `additionalProperties`) and
 * literal value sets (`const`, `enum`) — both of which round-trip through a
 * Zod schema's inferred TYPE. Every value-level constraint this predicate
 * also compares (`minLength`/`maxLength`, `pattern`, `format`,
 * `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`, `multipleOf`,
 * `minItems`/`maxItems`) narrows a value at RUNTIME without narrowing its
 * static TYPE — `z.string()` and `z.string().min(3)` share the type
 * `string` — so C.1's compile-time check is blind to them.
 */
const TYPE_VISIBLE_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "items",
  "prefixItems",
  "anyOf",
  "oneOf",
  "additionalProperties",
]);

function projectTypeVisibleValue(key: string, value: unknown): unknown {
  switch (key) {
    case "properties": {
      const projected = createDataKeyedBag<JsonSchema>();
      for (const [propertyName, propertySchema] of Object.entries(
        value as Record<string, JsonSchema>,
      )) {
        projected[propertyName] = projectTypeVisible(propertySchema);
      }
      return projected;
    }
    case "items": {
      return projectTypeVisible(value as JsonSchema);
    }
    case "prefixItems":
    case "anyOf":
    case "oneOf": {
      return (value as readonly JsonSchema[]).map((member) =>
        projectTypeVisible(member),
      );
    }
    case "additionalProperties": {
      return typeof value === "boolean" ? value : (
          projectTypeVisible(value as JsonSchema)
        );
    }
    default: {
      return value;
    }
  }
}

/**
 * `schema`, recursively reduced to only {@link TYPE_VISIBLE_KEYWORDS} — the
 * fragment of a JSON Schema that TypeScript's structural assignability over
 * `z.infer` can actually see. Feeds {@link isTypeLevelSubtype}.
 */
export function projectTypeVisible(schema: JsonSchema): JsonSchema {
  const projected = createDataKeyedBag<unknown>();
  for (const [key, value] of Object.entries(schema)) {
    if (!TYPE_VISIBLE_KEYWORDS.has(key)) continue;
    projected[key] = projectTypeVisibleValue(key, value);
  }
  return projected;
}

/**
 * The RUNTIME prediction of what `subClassOf(child, parent)` / C.1's
 * conditional-type check resolves to: `isStructuralSubtype` applied to each
 * side's {@link projectTypeVisible} projection, rather than the full schema.
 *
 * One comparison engine (`isStructuralSubtype`), one projection
 * (`projectTypeVisible`) — this is not a second walk of the schema, only a
 * narrower view fed into the same predicate C.2 uses.
 *
 * `isStructuralSubtype(c, p).verdict === "subtype"` implies
 * `isTypeLevelSubtype(c, p).verdict === "subtype"` — a hierarchy C.2 accepts
 * always compiles under C.1
 * (`tests/property/typed-subsumption-agreement.test.ts`). The converse does
 * NOT hold: TypeScript cannot see a value-level constraint, so
 * `isTypeLevelSubtype` accepts pairs `isStructuralSubtype` refuses (a bare
 * `z.string()` child under a `z.string().min(3)` parent erases to identical
 * types but is not a runtime subtype) — this is "C.1 is a filter, C.2 is the
 * authority" (roadmap §1.3), not a defect in either predicate.
 */
export function isTypeLevelSubtype(
  child: JsonSchema,
  parent: JsonSchema,
): StructuralSubtypeResult {
  return isStructuralSubtype(
    projectTypeVisible(child),
    projectTypeVisible(parent),
  );
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
 *
 * The remaining entries are standard JSON Schema 2020-12 vocabulary keywords
 * this predicate's rule set does not model at all, even though the Zod
 * projection never emits them today — the public `isStructuralSubtype`
 * surface accepts a hand-written `JsonSchema`, and silently treating an
 * unimplemented constraint as decoration would be unsound for that caller
 * the same way it was for `format` before this predicate learned to compare
 * it (see `COMPARABLE_KEYWORDS`).
 */
export const UNMODELED_CONSTRAINING_KEYWORDS: ReadonlySet<string> = new Set([
  "not",
  "allOf",
  "contentEncoding",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

/**
 * Exactly the constraining keywords this predicate actively compares. Every
 * other key surviving `stripSchemaMetadata` and `UNMODELED_CONSTRAINING_KEYWORDS`
 * — an arbitrary `.meta()` key or `searchable()`'s `_searchableField` tag —
 * is dropped by `comparableKeywords` and never blocks a verdict. That drop is
 * rule 4 above, deliberately the opposite of `isBreakingPropertyChange`'s
 * diff rule (there, an unrecognized key is user data whose change must be
 * surfaced; here, an unrecognized key constrains nothing, so it cannot make
 * two schemas differ for subtyping purposes) because the two predicates
 * answer different questions. `format` is NOT one of the dropped keys: the
 * Zod projection emits it with no accompanying `pattern` for `z.url()` and
 * `z.jwt()`, so ignoring it would accept a bare `z.string()` as a subtype of
 * either — it is compared exactly like `pattern` (present on the child,
 * absent or identical on the parent).
 */
export const COMPARABLE_KEYWORDS: ReadonlySet<string> = new Set([
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
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "anyOf",
  "oneOf",
]);

/**
 * Standard JSON Schema annotation keywords the Zod projection is known to
 * emit that carry no constraint (unlike `UNMODELED_CONSTRAINING_KEYWORDS`)
 * and so fall out of rule 4 with no special case, the same way an arbitrary
 * `.meta()` key or `searchable()`'s `_searchableField` tag does. Listed here
 * — rather than left to fall silently through rule 4 unnamed — only so the
 * projection-coverage test (`tests/structural-subtype.test.ts`) can tell a
 * keyword the projection is KNOWN to emit today from one a future Zod
 * upgrade adds that no one has classified yet; adding an entry here does not
 * change this module's runtime behavior in any way. `readOnly` (`.readonly()`)
 * is the only keyword in this bucket at present.
 */
export const KNOWN_IGNORED_KEYWORDS: ReadonlySet<string> = new Set([
  "readOnly",
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

  // A schema is trivially a subtype of itself, regardless of which keywords
  // it carries — including `$ref` (recursive `z.lazy`) and `allOf`
  // (`z.intersection`), which the guards just below cannot judge at all.
  // This full-schema identity check (every keyword, not just
  // COMPARABLE_KEYWORDS) must run BEFORE those guards, or a child that
  // copies a parent's `$ref`/`allOf` property verbatim is refused as
  // SCHEMA_INCOMPARABLE instead of accepted as an identical, and therefore
  // trivially compatible, property.
  if (
    propertySchemasEqual(
      stripSchemaMetadata(child),
      stripSchemaMetadata(parent),
    )
  ) {
    return SUBTYPE;
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

  if (isUnionSchema(child) || isUnionSchema(parent)) {
    const unionResult = compareUnion(child, parent, path, depth);
    if (unionResult.verdict !== "subtype") return unionResult;
    return compareUnionSiblingConstraints(child, parent, path, depth);
  }

  return compareLeaf(child, parent, path, depth);
}

/**
 * Whether `schema` itself carries a union keyword (`anyOf` or `oneOf`).
 * Checked directly on the keyword rather than through migration's
 * `propertyTypeSignature` — that helper is the diff's construct SELECTOR
 * (which reads `type` before `anyOf`/`oneOf`, so a schema carrying both would
 * silently hide its union from a caller using it as a union detector) and is
 * not the right owner for this question.
 */
function isUnionSchema(schema: JsonSchema): boolean {
  return hasOwnKey(schema, "anyOf") || hasOwnKey(schema, "oneOf");
}

// ============================================================
// Unions
// ============================================================

function unionMembers(schema: JsonSchema): readonly JsonSchema[] {
  return schema.anyOf ?? schema.oneOf ?? [schema];
}

/**
 * `schema` with `anyOf`/`oneOf` removed, everything else untouched. Used to
 * isolate a union schema's SIBLING keywords — the constraints ANDed alongside
 * the union rather than expressed by it.
 */
function withoutUnionKeywords(schema: JsonSchema): JsonSchema {
  const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = schema;
  return rest;
}

/**
 * A union keyword (`anyOf`/`oneOf`) is ANDed with every sibling keyword on
 * the same schema object, never replaced by it: `{ type: "string", anyOf:
 * [...] }` admits only strings that ALSO match one of the `anyOf` members.
 * `compareUnion` decides the member-matching half of that AND; this decides
 * the other half by re-running the ordinary comparison against the PARENT's
 * sibling keywords with `anyOf`/`oneOf` stripped off.
 *
 * Only the parent side needs this. Dropping the CHILD's own sibling keywords
 * when it is a union is conservative — treating the child as looser than it
 * really is can only produce a false `incomparable`/`not-subtype` refusal,
 * never a false `subtype` accept — so no equivalent check runs for `child`.
 * Dropping the PARENT's sibling keywords is unsound: it silently narrows what
 * the parent constraint set actually excludes, which is exactly the defect
 * this function closes (C2-R2-01).
 */
function compareUnionSiblingConstraints(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
  depth: number,
): StructuralSubtypeResult {
  if (!isUnionSchema(parent)) return SUBTYPE;
  const parentSiblings = withoutUnionKeywords(parent);
  if (Object.keys(stripSchemaMetadata(parentSiblings)).length === 0) {
    return SUBTYPE;
  }
  return compareSchemas(child, parentSiblings, path, depth);
}

function compareUnion(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
  depth: number,
): StructuralSubtypeResult {
  const childMembers = unionMembers(child);
  const parentMembers = unionMembers(parent);
  const childIsUnion = isUnionSchema(child);

  for (const [childIndex, childMember] of childMembers.entries()) {
    // Only a real union member gets an `anyOf[i]` segment. When `child`
    // itself carries no `anyOf`/`oneOf` (`compareUnion` was reached because
    // `parent` is the union), `unionMembers` synthesizes a single-element
    // `[child]` — appending a segment for that synthesized member would
    // point a caller at a path the child schema never actually has.
    const memberPath =
      childIsUnion ? [...path, unionMemberSegment(childIndex)] : path;
    let matchedParentMember = false;
    // A parent member that is itself incomparable does not end the search:
    // the schema is order-insensitive by construction (unions are sets), so
    // a LATER parent member that matches must still be found before this
    // reports `incomparable` (C2-R2-04) — the top-level verdict for a given
    // pair must not depend on the declared order of the parent's members.
    let firstIncomparable: StructuralSubtypeResult | undefined;
    for (const parentMember of parentMembers) {
      const probeResult = compareSchemas(
        childMember,
        parentMember,
        memberPath,
        depth + 1,
      );
      if (probeResult.verdict === "subtype") {
        matchedParentMember = true;
        break;
      }
      if (
        probeResult.verdict === "incomparable" &&
        firstIncomparable === undefined
      ) {
        firstIncomparable = probeResult;
      }
    }
    if (!matchedParentMember) {
      return (
        firstIncomparable ?? notSubtype("no-matching-union-member", memberPath)
      );
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

/**
 * The single owner of "does this side permit undeclared keys, and under what
 * schema": `undefined` when the side is CLOSED (an explicit
 * `additionalProperties: false` — every `z.object` projects this), otherwise
 * the schema those undeclared keys must satisfy (`{}`, the top type, when
 * `additionalProperties` is `true` or absent; the catchall schema itself
 * otherwise). Every caller in `compareObject` reads this one function rather
 * than re-spelling the `!== undefined && !== false` / `!== false` checks —
 * two such inline re-spellings previously disagreed with each other (one
 * treating an ABSENT `additionalProperties` as open, the other as closed),
 * which is exactly the seam that let a `z.looseObject`/`z.record`/`.catchall`
 * child evade a parent-declared property by leaving it undeclared.
 */
function openExtrasSchema(schema: JsonSchema): JsonSchema | undefined {
  const additionalProperties = schema.additionalProperties;
  if (additionalProperties === false) return undefined;
  if (additionalProperties === undefined || additionalProperties === true) {
    return {};
  }
  return additionalProperties;
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

  const childExtrasSchema = openExtrasSchema(child);

  for (const [name, parentProperty] of Object.entries(parentProps)) {
    if (hasOwnKey(childProps, name)) {
      const propertyResult = compareSchemas(
        requireDefined(childProps[name]),
        parentProperty,
        [...path, name],
        depth + 1,
      );
      if (propertyResult.verdict !== "subtype") return propertyResult;
      continue;
    }
    // The child does not declare `name` by name. A CLOSED child (the common
    // `z.object` case) genuinely omits it — the "child may omit optional
    // parent properties" rule. An OPEN child (`z.looseObject`, `z.record`,
    // `.catchall`) does not omit it: any value satisfying the child could
    // still carry `name`, so the child's additional-properties schema must
    // itself narrow the parent's declared property, not be skipped (this is
    // the fix for the width-subtyping evasion above).
    if (childExtrasSchema === undefined) continue;
    const extraResult = compareSchemas(
      childExtrasSchema,
      parentProperty,
      [...path, name],
      depth + 1,
    );
    if (extraResult.verdict !== "subtype") return extraResult;
  }

  // Width subtyping for keys NEITHER side declares by name. The parent's
  // `additionalProperties: false` (or its absence) is not applied to the
  // child's extra keys — every `z.object` projects `false`, so this branch is
  // skipped for the common case, and the child's added properties are
  // unconstrained rather than refused.
  const parentExtrasSchema = openExtrasSchema(parent);
  if (parentExtrasSchema !== undefined) {
    for (const [name, childProperty] of Object.entries(childProps)) {
      if (hasOwnKey(parentProps, name)) continue;
      const extraResult = compareSchemas(
        childProperty,
        parentExtrasSchema,
        [...path, name],
        depth + 1,
      );
      if (extraResult.verdict !== "subtype") return extraResult;
    }

    if (childExtrasSchema !== undefined) {
      const additionalResult = compareSchemas(
        childExtrasSchema,
        parentExtrasSchema,
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
    // A parent tuple with no rest element (`prefixItems` present, `items`
    // absent) has no elements beyond its declared prefix under the Zod tuple
    // projection (see the `childIsClosedTuple` comment below for the mirror
    // case). A child of equal prefix arity that ALSO carries `items` (a rest
    // element, e.g. `z.tuple([string], number)`) permits values longer than
    // the parent ever allows, even though the prefix lengths matched above.
    if (parent.items === undefined && child.items !== undefined) {
      return notSubtype("tuple-arity-mismatch", path);
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

  // `format` carries a real constraint, mirroring `pattern`: `z.url()` and
  // `z.jwt()` project `format` with no accompanying `pattern`, so a parent
  // format with no matching child format is not narrowed by anything else.
  if (parent.format !== undefined && child.format !== parent.format) {
    return notSubtype("format-mismatch", path);
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
