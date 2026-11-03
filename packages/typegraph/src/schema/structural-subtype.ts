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
 * trace cannot be judged. A live graph's registry check therefore compares
 * `structuralSubtypeProjection` (./structural-subtype-projection.ts), which
 * marks where the projection dropped a regex flag, a refinement, a strict
 * object, or read a `.meta()` key as a constraint, so such a pair answers
 * `incomparable` (rule 3) instead of a guess. It also marks each node the
 * projection cannot convert at all, which rule 2 accepts only under an
 * unconstrained parent node or beside a node of the same identity.
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
 *    is dropped and projection spellings are folded (`propertySchemasEqual`:
 *    a union of bare primitives as `anyOf` or a `type` token array, a tuple
 *    with or without its arity restated) — child is trivially a subtype of
 *    parent, regardless of which keywords either side carries. This runs before rules 3–4 on
 *    purpose: it is what lets a child that copies a `$ref` (recursive
 *    `z.lazy`) or `allOf` (`z.intersection`) property VERBATIM from its
 *    parent still compare as a subtype for that property, even though rules
 *    3–4 can never judge `$ref`/`allOf` on their own. Two DIFFERENT `$ref`
 *    targets, or a child that merely narrows an `allOf` member, still fall
 *    through to rule 3/4 and are refused. Equal `$ref` STRINGS are not equal
 *    schemas, though: a reference is resolved against its own side's root
 *    (`#`, or `#/$defs/<name>`), and the rule fires only when every reference
 *    the pair reaches, transitively, resolves to an equal definition on both
 *    sides. The projection names a recursive definition by encounter order,
 *    so two unrelated recursive types share a name; an unresolvable
 *    reference is refused the same way. Rule 6 decides through the same test.
 *    Right after it, a node marked {@link UNPROJECTABLE_NODE_KEYWORD} on
 *    either side (a Zod construct with no JSON Schema spelling, such as
 *    `embedding()`, `z.date()` or a `.transform()`) states nothing to
 *    compare, so the pair is accepted only where no comparison is needed:
 *    the parent node admits every value (`{}`, from `z.unknown()`/`z.any()`,
 *    carrying no constraining keyword), or both nodes carry the same marker
 *    identity — the same Zod instance, plain check-free nodes of one type
 *    (`z.date()` and `z.date()`), or `embedding()`s of equal dimensions and
 *    index options. Every other pair with an unprojectable side is
 *    `incomparable` ("unsupported-construct"), except that a union on the
 *    other side is compared member by member first. The node's siblings are
 *    still compared by the enclosing object or union. Only a live graph's
 *    comparison projection carries the marker.
 * 3. Either side carrying `$ref` is `incomparable` ("schema-reference"): the
 *    projection emits `$ref` exactly at a self- or mutually-recursive cycle,
 *    which is why recursion here cannot diverge. So is a node carrying a
 *    constraint its Zod source states and the projection cannot
 *    ("unsupported-construct"): a regex flag or a constraint-shaped `.meta()`
 *    key on either side ({@link ZOD_ONLY_CONSTRAINT_KEYWORD}), a refinement
 *    or a strict object on the parent
 *    ({@link ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD}). Only a live graph's
 *    comparison projection carries these markers; a bare persisted
 *    projection has lost the facts they record.
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
 *    rule — it is compared as a constraint, see {@link COMPARABLE_KEYWORDS}.
 * 6. If the two schemas are identical once irrelevant keywords are dropped,
 *    they are mutual subtypes — a NARROWER identity check than rule 2 above
 *    (it tolerates schemas that differ only in an annotation/unrecognized
 *    key), reachable only once rules 3–4 have already cleared both sides of
 *    `$ref` and any unmodeled constraining keyword.
 * 7. If either side is a union (`anyOf`, or `oneOf` — read as `anyOf`. For a
 *    PARENT that reading is sound only when no value can match two members,
 *    so a parent `oneOf` must have pairwise provably disjoint members:
 *    different `type` tokens, or one required property pinned to disjoint
 *    `const`/`enum` sets. `z.discriminatedUnion` always qualifies; `z.xor`,
 *    which projects `oneOf` too, qualifies only when its members happen to
 *    be exclusive, and is otherwise `incomparable`
 *    ("unsupported-construct"), as is a parent carrying both `anyOf` and
 *    `oneOf`. A CHILD `oneOf` needs no proof: it admits a subset of what its
 *    members admit together — or a `type`
 *    token array, which the projection emits for a union of bare primitives
 *    such as `z.string().nullable()` and which is read as one member per
 *    token, each carrying every sibling keyword), every child
 *    member must find SOME parent member it subtypes — checking every parent
 *    member before concluding `incomparable`, so the verdict never depends on
 *    the order the parent declared its members in (a member that cannot be
 *    judged does not stop the search for a later member that matches). This
 *    is also what handles nullability with no special case: `z.string()` is a
 *    subtype of `z.string().nullable()` (`type: ["string", "null"]`, or
 *    `anyOf: [string, null]` in a document stored by an earlier projection)
 *    because the lone child member matches the union's first member; the reverse is not,
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
 *    constrains them — the projection writes `false` for every Zod object,
 *    stripping or strict, and a strict parent is caught at rule 3; and a parent-declared property the child leaves to its
 *    own OPEN additional-properties schema is compared against that schema
 *    rather than skipped, since an open child does not actually omit the
 *    property — it just declares no NAMED constraint for it), arrays compare
 *    bounds/items/tuple prefixes (a closed parent tuple — `prefixItems` with
 *    `items: false`, or with no `items` at all in a document stored by an
 *    earlier projection — additionally requires the child be closed at the
 *    same arity), strings compare
 *    length bounds, `pattern`, and `format` (a constraint, not an
 *    annotation — see {@link COMPARABLE_KEYWORDS}), and numbers compare
 *    bounds folding `exclusiveMinimum` /
 *    `exclusiveMaximum` in. A record's key set compares as a subtype too:
 *    the child's `propertyNames` must narrow the parent's. Within these
 *    leaf comparisons, a child pinned to a finite value set (`const` or
 *    `enum`: `z.literal`, `z.enum`) is also judged value by value. A parent
 *    `type`, length bound, `pattern`, numeric bound, or `multipleOf` the
 *    child's own keywords do not imply is still satisfied when every value
 *    the child admits satisfies it, so `z.literal("x")` narrows
 *    `z.string().min(1)` and `z.literal(5)` narrows `z.int()`. Each value is
 *    judged under every reading a validator applies — JSON Schema's and
 *    Zod's, which differ on string length, `pattern` flags, and `multipleOf`
 *    rounding — and a value a reading cannot judge faithfully (an
 *    uncompilable pattern, a standard `format` such as `email`) leaves the
 *    declared-keyword refusal standing.
 *
 * An unmodeled construct always yields `{ verdict: "incomparable" }` and is
 * never silently accepted as a match.
 */
import { decodeJsonPointerSegment } from "../query/json-pointer";
import { createDataKeyedBag, hasOwnKey } from "../utils/object";
import { requireDefined } from "../utils/presence";
import { canonicalJson } from "./canonical";
import {
  closesTupleByOmission,
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
  return compareSchemas(child, parent, [], {
    depth: 0,
    roots: { child, parent },
  });
}

// ============================================================
// Compile-time / runtime agreement projection
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
 * `string` — so the compile-time check is blind to them.
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
    case "prefixItems":
    case "anyOf":
    case "oneOf": {
      return (value as readonly JsonSchema[]).map((member) =>
        projectTypeVisible(member),
      );
    }
    case "items":
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
 * The RUNTIME prediction of what `subClassOf(child, parent)`'s
 * compile-time conditional-type check resolves to: `isStructuralSubtype` applied to each
 * side's {@link projectTypeVisible} projection, rather than the full schema.
 *
 * One comparison engine (`isStructuralSubtype`), one projection
 * (`projectTypeVisible`) — this is not a second walk of the schema, only a
 * narrower view fed into the same predicate the runtime check uses.
 *
 * `isStructuralSubtype(c, p).verdict === "subtype"` implies
 * `isTypeLevelSubtype(c, p).verdict === "subtype"` — a hierarchy the runtime check accepts
 * always compiles under the compile-time check
 * (`tests/property/typed-subsumption-agreement.test.ts`). The converse does
 * NOT hold: TypeScript cannot see a value-level constraint, so
 * `isTypeLevelSubtype` accepts pairs `isStructuralSubtype` refuses (a bare
 * `z.string()` child under a `z.string().min(3)` parent erases to identical
 * types but is not a runtime subtype) — this is "the compile-time check is a
 * filter, the runtime check is the authority", not a defect in either predicate.
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

function typeTokenSegment(index: number): string {
  return `type[${index}]`;
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
 * (`z.intersection`) is named explicitly because intersection subtyping is
 * real and deliberately deferred, not merely undecorated.
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
 * absent or identical on the parent, or satisfied by every value a finite
 * child admits — see `satisfiesFormat`).
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

/**
 * Marks a schema node whose Zod source constrains values in a way the JSON
 * Schema projection cannot state, on either side of a comparison: a regex
 * flag, or a `.meta()` key spelled like a constraining keyword. Written only
 * by `structuralSubtypeProjection` (`./structural-subtype-projection`), never
 * into a persisted document.
 */
export const ZOD_ONLY_CONSTRAINT_KEYWORD = "x-typegraph-zod-only-constraint";

/**
 * Marks a schema node whose Zod source narrows values in a way the JSON
 * Schema projection cannot state, but only in a direction that matters when
 * the node is the PARENT: a refinement, or a strict object. On a child the
 * narrowing only makes the child stricter, which a `subtype` verdict may
 * ignore.
 */
export const ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD =
  "x-typegraph-zod-only-parent-constraint";

/**
 * Marks a schema node `z.toJSONSchema` has no spelling for at all —
 * `embedding()` and any other `z.custom()`, `z.date()`, `z.set()`, `z.map()`,
 * `z.bigint()`, a `.transform()` — where the persisted projection would
 * collapse the whole kind to its placeholder instead. Such a node states
 * nothing to compare, so it narrows only a parent node that admits every
 * value, and matches another unprojectable node only when the two carry the
 * same value here: its IDENTITY, written by the projection as the node type
 * alone for a plain check-free node of a type whose values it fully
 * describes (`z.date()`, `z.bigint()`), the dimensions and index options for
 * an `embedding()`, and the Zod instance otherwise. Every other node of the
 * pair is still judged. A node Zod converts only in part (a
 * dynamic `.catch()` keeps its `type`) does not carry this marker; the
 * projection marks it with {@link ZOD_ONLY_CONSTRAINT_KEYWORD} instead.
 * Written only by `structuralSubtypeProjection`
 * (`./structural-subtype-projection`), never into a persisted document.
 */
export const UNPROJECTABLE_NODE_KEYWORD = "x-typegraph-unprojectable";

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
 * `undefined` when `stripped` (a schema after {@link stripSchemaMetadata})
 * carries no keyword this predicate knows constrains values but cannot model;
 * otherwise the `incomparable` result to return immediately.
 */
function unmodeledConstruct(
  stripped: Readonly<Record<string, unknown>>,
  path: readonly string[],
): StructuralSubtypeResult | undefined {
  for (const key of Object.keys(stripped)) {
    if (UNMODELED_CONSTRAINING_KEYWORDS.has(key)) {
      return incomparable("unsupported-keyword", path);
    }
  }
  return undefined;
}

/**
 * `stripped` (a schema after {@link stripSchemaMetadata}, which drops the
 * migration metadata description/title/default/$schema) reduced to only the
 * keywords this predicate compares — any keyword outside
 * {@link COMPARABLE_KEYWORDS} is dropped. Used only for the equality fast
 * path below; the per-construct comparison functions read the original schema
 * directly.
 */
function comparableKeywords(
  stripped: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
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

/**
 * Where a comparison stands: how deep it has recursed, and the two documents
 * it started from. The roots are what a `$ref` resolves against — a nested
 * schema does not carry its own definitions.
 */
type Walk = Readonly<{
  depth: number;
  roots: Readonly<{ child: JsonSchema; parent: JsonSchema }>;
}>;

function descend(walk: Walk): Walk {
  return { depth: walk.depth + 1, roots: walk.roots };
}

// ============================================================
// References
// ============================================================

const REFERENCE_KEYWORD = "$ref";
const DEFINITIONS_KEYWORD = "$defs";
const ROOT_REFERENCE = "#";
const LOCAL_DEFINITION_PREFIX = `${ROOT_REFERENCE}/${DEFINITIONS_KEYWORD}/`;

/** Every `$ref` target named anywhere inside `value`, added to `into`. */
function collectReferences(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferences(entry, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === REFERENCE_KEYWORD && typeof entry === "string") {
      into.add(entry);
    } else {
      collectReferences(entry, into);
    }
  }
}

/**
 * What `reference` names in `root`: the document itself, or one of its
 * `$defs` — the two forms the projection emits. `undefined` for a reference
 * this predicate cannot follow (a remote document, a deeper pointer) or
 * whose definition is absent.
 */
function resolveReference(
  reference: string,
  root: JsonSchema,
): JsonSchema | undefined {
  if (reference === ROOT_REFERENCE) return root;
  if (!reference.startsWith(LOCAL_DEFINITION_PREFIX)) return undefined;
  const definitions = root[DEFINITIONS_KEYWORD];
  if (definitions === null || typeof definitions !== "object") return undefined;
  const byName = definitions as Record<string, JsonSchema>;
  const name = decodeJsonPointerSegment(
    reference.slice(LOCAL_DEFINITION_PREFIX.length),
  );
  return hasOwnKey(byName, name) ? byName[name] : undefined;
}

/**
 * Every reference reachable from `schema` — its own, and those of each
 * definition they lead to — with what each resolves to in `root`.
 */
function reachableDefinitions(
  schema: unknown,
  root: JsonSchema,
): ReadonlyMap<string, JsonSchema | undefined> {
  const resolved = new Map<string, JsonSchema | undefined>();
  const pending = new Set<string>();
  collectReferences(schema, pending);
  for (const reference of pending) {
    if (resolved.has(reference)) continue;
    const target = resolveReference(reference, root);
    resolved.set(reference, target);
    // Appending while iterating is what walks the closure: a `Set` visits
    // entries added during iteration, and never one it already holds.
    if (target !== undefined) collectReferences(target, pending);
  }
  return resolved;
}

/**
 * Whether two schemas already known to be EQUAL also mean the same thing:
 * every reference either one reaches must resolve, on its own side, to an
 * equal definition.
 *
 * A `$ref` is a name, and the name says nothing about the definition. The
 * projection numbers a recursive schema's definition by encounter order, so
 * two unrelated recursive types in a child and a parent both land on the same
 * name; equal reference strings over different `$defs` are different schemas.
 * A reference neither side can resolve is not evidence of anything and is
 * refused the same way.
 */
function referencesResolveIdentically(
  child: unknown,
  parent: unknown,
  roots: Walk["roots"],
): boolean {
  const childDefinitions = reachableDefinitions(child, roots.child);
  if (childDefinitions.size === 0) return true;
  // One document compared with itself resolves every reference identically,
  // whether or not this predicate can follow it.
  if (roots.child === roots.parent) return true;
  const parentDefinitions = reachableDefinitions(parent, roots.parent);
  if (parentDefinitions.size !== childDefinitions.size) return false;
  for (const [reference, childTarget] of childDefinitions) {
    const parentTarget = parentDefinitions.get(reference);
    if (childTarget === undefined || parentTarget === undefined) return false;
    if (
      !propertySchemasEqual(
        stripSchemaMetadata(childTarget),
        stripSchemaMetadata(parentTarget),
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * THE identity test of this module: the two schemas are equal as written AND
 * every reference they reach resolves to an equal definition. Both identity
 * rules (2 and 6) decide through it, so neither can accept a shared reference
 * name the other would look behind.
 */
function sameSchema(child: unknown, parent: unknown, walk: Walk): boolean {
  return (
    propertySchemasEqual(child, parent) &&
    referencesResolveIdentically(child, parent, walk.roots)
  );
}

// ============================================================
// Unprojectable nodes
// ============================================================

/**
 * Keywords that make a schema node constrain values: every keyword this
 * predicate compares or refuses as unmodeled, a reference, and each marker
 * the comparison projection writes.
 */
function isConstraintBearingKeyword(key: string): boolean {
  return (
    COMPARABLE_KEYWORDS.has(key) ||
    UNMODELED_CONSTRAINING_KEYWORDS.has(key) ||
    key === REFERENCE_KEYWORD ||
    key === ZOD_ONLY_CONSTRAINT_KEYWORD ||
    key === ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD ||
    key === UNPROJECTABLE_NODE_KEYWORD
  );
}

/**
 * Whether `stripped` (a schema after {@link stripSchemaMetadata}) admits
 * every value: `z.unknown()`, `z.any()`, or a node carrying only
 * annotations and keywords rule 5 ignores.
 */
function isUnconstrained(stripped: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(stripped).every((key) => !isConstraintBearingKeyword(key));
}

/**
 * What an unprojectable node stands for (see
 * {@link UNPROJECTABLE_NODE_KEYWORD}), if it is one.
 */
function unprojectableIdentity(schema: JsonSchema): string | undefined {
  if (!hasOwnKey(schema, UNPROJECTABLE_NODE_KEYWORD)) return undefined;
  return String(schema[UNPROJECTABLE_NODE_KEYWORD]);
}

/**
 * The verdict for a pair where either side is an unprojectable node, or
 * `undefined` when neither is, or when the other side is a union whose
 * members must each be compared on their own.
 *
 * An unprojectable node states nothing about the values it admits, so no
 * comparison can show it narrows a parent that constrains anything, nor that
 * a child satisfies a parent it stands for. It is accepted only where that
 * needs no comparison: the parent admits every value, or both sides are
 * unprojectable nodes with the same identity — provably the same values.
 */
function compareUnprojectable(
  child: JsonSchema,
  parent: JsonSchema,
  strippedParent: Readonly<Record<string, unknown>>,
  path: readonly string[],
): StructuralSubtypeResult | undefined {
  const childIdentity = unprojectableIdentity(child);
  const parentIdentity = unprojectableIdentity(parent);
  if (childIdentity === undefined && parentIdentity === undefined) {
    return undefined;
  }
  if (isUnconstrained(strippedParent)) return SUBTYPE;
  if (childIdentity === undefined) {
    return isUnionSchema(child) ? undefined : (
        incomparable("unsupported-construct", path)
      );
  }
  if (parentIdentity === undefined) {
    return isUnionSchema(parent) ? undefined : (
        incomparable("unsupported-construct", path)
      );
  }
  return childIdentity === parentIdentity ? SUBTYPE : (
      incomparable("unsupported-construct", path)
    );
}

function compareSchemas(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
  walk: Walk,
): StructuralSubtypeResult {
  if (walk.depth > MAX_STRUCTURAL_SUBTYPE_DEPTH) {
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
  const strippedChild = stripSchemaMetadata(child);
  const strippedParent = stripSchemaMetadata(parent);
  if (sameSchema(strippedChild, strippedParent, walk)) return SUBTYPE;

  const unprojectableResult = compareUnprojectable(
    child,
    parent,
    strippedParent,
    path,
  );
  if (unprojectableResult !== undefined) return unprojectableResult;

  if (
    hasOwnKey(child, REFERENCE_KEYWORD) ||
    hasOwnKey(parent, REFERENCE_KEYWORD)
  ) {
    return incomparable("schema-reference", path);
  }

  if (
    hasOwnKey(child, ZOD_ONLY_CONSTRAINT_KEYWORD) ||
    hasOwnKey(parent, ZOD_ONLY_CONSTRAINT_KEYWORD) ||
    hasOwnKey(parent, ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD)
  ) {
    return incomparable("unsupported-construct", path);
  }

  const childUnmodeled = unmodeledConstruct(strippedChild, path);
  if (childUnmodeled !== undefined) return childUnmodeled;
  const parentUnmodeled = unmodeledConstruct(strippedParent, path);
  if (parentUnmodeled !== undefined) return parentUnmodeled;

  if (
    sameSchema(
      comparableKeywords(strippedChild),
      comparableKeywords(strippedParent),
      walk,
    )
  ) {
    return SUBTYPE;
  }

  if (!exclusiveUnionReadsAsUnion(parent)) {
    return incomparable("unsupported-construct", path);
  }

  if (isUnionSchema(child) || isUnionSchema(parent)) {
    const unionResult = compareUnion(child, parent, path, walk);
    if (unionResult.verdict !== "subtype") return unionResult;
    return compareUnionSiblingConstraints(child, parent, path, walk);
  }

  return compareLeaf(child, parent, path, walk);
}

/**
 * Whether `schema` itself carries a union keyword (`anyOf` or `oneOf`).
 * Checked directly on the keyword rather than through migration's
 * `propertyTypeSignature` — that helper is the diff's construct SELECTOR
 * (which reads `type` before `anyOf`/`oneOf`, so a schema carrying both would
 * silently hide its union from a caller using it as a union detector) and is
 * not the right owner for this question.
 */
function declaresUnionMembers(schema: JsonSchema): boolean {
  return hasOwnKey(schema, "anyOf") || hasOwnKey(schema, "oneOf");
}

/**
 * Whether `schema` admits more than one alternative: declared members, or a
 * `type` token array. A token array is a union in its own right — `{ type:
 * ["string", "null"] }` admits exactly what `anyOf: [{ type: "string" }, {
 * type: "null" }]` does — and it is how the projection writes a union of bare
 * primitives.
 */
function isUnionSchema(schema: JsonSchema): boolean {
  return declaresUnionMembers(schema) || Array.isArray(schema.type);
}

// ============================================================
// Unions
// ============================================================

/**
 * Whether two schemas provably admit no common value because their `type`
 * tokens differ. `integer` is a `number`, so that pair overlaps; a schema
 * stating no single token proves nothing.
 */
function disjointByTypeToken(left: JsonSchema, right: JsonSchema): boolean {
  const leftType = left.type;
  const rightType = right.type;
  if (typeof leftType !== "string" || typeof rightType !== "string") {
    return false;
  }
  return (
    !typeTokenNarrows(leftType, rightType) &&
    !typeTokenNarrows(rightType, leftType)
  );
}

/** Whether every value of type `child` is a value of type `parent`: the same token, or `integer` under `number`. */
function typeTokenNarrows(
  child: NonNullable<JsonSchema["type"]>,
  parent: NonNullable<JsonSchema["type"]>,
): boolean {
  return (
    child === parent ||
    (child === INTEGER_TYPE_TOKEN && parent === NUMBER_TYPE_TOKEN)
  );
}

/** The value set a schema pins one REQUIRED property to, if it does. */
function requiredPropertyValues(
  schema: JsonSchema,
  propertyName: string,
): ReadonlySet<string> | undefined {
  if (!(schema.required ?? []).includes(propertyName)) return undefined;
  const properties = schema.properties;
  if (properties === undefined || !hasOwnKey(properties, propertyName)) {
    return undefined;
  }
  return allowedValues(requireDefined(properties[propertyName]));
}

/**
 * Whether two object schemas provably admit no common value because some
 * property both REQUIRE is pinned to value sets that share nothing — the
 * shape `z.discriminatedUnion` projects.
 */
function disjointByDiscriminator(left: JsonSchema, right: JsonSchema): boolean {
  for (const propertyName of Object.keys(left.properties ?? {})) {
    const leftValues = requiredPropertyValues(left, propertyName);
    const rightValues = requiredPropertyValues(right, propertyName);
    if (leftValues === undefined || rightValues === undefined) continue;
    if ([...leftValues].every((value) => !rightValues.has(value))) return true;
  }
  return false;
}

function provablyDisjoint(left: JsonSchema, right: JsonSchema): boolean {
  return (
    disjointByTypeToken(left, right) || disjointByDiscriminator(left, right)
  );
}

/**
 * Whether a PARENT's `oneOf` may be read as `anyOf` ({@link unionMembers}).
 *
 * `oneOf` admits a value matching EXACTLY one member, so a child value that
 * matches two is rejected by the parent while a member-wise reading accepts
 * it. The two readings coincide only when no value can match two members,
 * which this proves pairwise or not at all: `z.discriminatedUnion` always
 * passes, `z.xor` passes only when its members happen to be exclusive. A
 * schema carrying both `anyOf` and `oneOf` is the conjunction of the two and
 * is not read through either one.
 *
 * Only the parent is asked. A child's `oneOf` admits a SUBSET of what its
 * members admit together, so reading it as `anyOf` can only cost a refusal.
 */
function exclusiveUnionReadsAsUnion(parent: JsonSchema): boolean {
  const members = parent.oneOf;
  if (members === undefined) return true;
  if (parent.anyOf !== undefined) return false;
  return members.every((left, index) =>
    members.slice(index + 1).every((right) => provablyDisjoint(left, right)),
  );
}

type UnionMember = Readonly<{
  schema: JsonSchema;
  segment: string | undefined;
}>;

/**
 * The alternatives `schema` admits, each with the path segment that names it.
 * Declared members win when a schema carries both forms: its token array is
 * then a sibling keyword, compared like any other. A schema that is not a
 * union is its own single alternative and has no segment: one would point a
 * caller at a path the schema never actually has.
 *
 * A token-array member is the whole schema narrowed to one token. Every
 * other keyword rides along, because a keyword constrains only values of the
 * type it applies to: `{ type: ["string", "null"], minLength: 3 }` is a
 * string of at least three characters, or null.
 */
function unionMembers(schema: JsonSchema): readonly UnionMember[] {
  const declared = schema.anyOf ?? schema.oneOf;
  if (declared !== undefined) {
    return declared.map((member, index) => ({
      schema: member,
      segment: unionMemberSegment(index),
    }));
  }
  const type = schema.type;
  if (typeof type === "string" || type === undefined) {
    return [{ schema, segment: undefined }];
  }
  return type.map((token, index) => ({
    schema: { ...schema, type: token },
    segment: typeTokenSegment(index),
  }));
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
 * this function closes.
 */
function compareUnionSiblingConstraints(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
  walk: Walk,
): StructuralSubtypeResult {
  // A token array's members already carry every sibling keyword.
  if (!declaresUnionMembers(parent)) return SUBTYPE;
  const parentSiblings = withoutUnionKeywords(parent);
  if (Object.keys(stripSchemaMetadata(parentSiblings)).length === 0) {
    return SUBTYPE;
  }
  return compareSchemas(child, parentSiblings, path, walk);
}

function compareUnion(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
  walk: Walk,
): StructuralSubtypeResult {
  const parentMembers = unionMembers(parent);

  for (const childMember of unionMembers(child)) {
    const memberPath =
      childMember.segment === undefined ? path : [...path, childMember.segment];
    let matchedParentMember = false;
    // A parent member that is itself incomparable does not end the search:
    // the schema is order-insensitive by construction (unions are sets), so
    // a LATER parent member that matches must still be found before this
    // reports `incomparable` — the top-level verdict for a given
    // pair must not depend on the declared order of the parent's members.
    let firstIncomparable: StructuralSubtypeResult | undefined;
    for (const parentMember of parentMembers) {
      const probeResult = compareSchemas(
        childMember.schema,
        parentMember.schema,
        memberPath,
        descend(walk),
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
  walk: Walk,
): StructuralSubtypeResult {
  const valueSetResult = compareValueSets(child, parent, path);
  if (valueSetResult.verdict !== "subtype") return valueSetResult;

  // Never a token array here: `compareSchemas` reads one as a union.
  const childType = child.type;
  const parentType = parent.type;

  // A child pinned to values of the parent's type satisfies that type
  // whatever token, if any, the child states itself.
  const pinnedToParentType =
    typeof parentType === "string" &&
    everyAdmittedValue(child, (value) => scalarHasTypeToken(value, parentType));

  if (
    parentType !== undefined &&
    childType === undefined &&
    !pinnedToParentType
  ) {
    return notSubtype("unconstrained-where-parent-constrains", path);
  }

  if (
    childType !== undefined &&
    parentType !== undefined &&
    !typeTokenNarrows(childType, parentType) &&
    !pinnedToParentType
  ) {
    return notSubtype("type-token-mismatch", path);
  }

  if (isObjectSchema(child) && isObjectSchema(parent)) {
    return compareObject(child, parent, path, walk);
  }

  // The parent's token picks the comparison: it is the type whose keywords
  // the child must satisfy.
  switch (parentType ?? childType) {
    case ARRAY_TYPE_TOKEN: {
      return compareArray(child, parent, path, walk);
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
      return compareObject(child, parent, path, walk);
    }
    // `undefined` here means neither side carries a `type` token at all —
    // both are `{}`, or both carry only `const`/`enum` (already checked
    // above by `compareValueSets`).
    case undefined:
    default: {
      if (
        hasKeywordOutsideValueSet(
          comparableKeywords(stripSchemaMetadata(child)),
        ) ||
        hasKeywordOutsideValueSet(
          comparableKeywords(stripSchemaMetadata(parent)),
        )
      ) {
        return incomparable("unsupported-construct", path);
      }
      return SUBTYPE;
    }
  }
}

/** The values a schema's `const` or `enum` pins it to, as written. */
function pinnedValues(schema: JsonSchema): readonly unknown[] | undefined {
  if (hasOwnKey(schema, "const")) return [schema.const];
  return schema.enum;
}

function allowedValues(schema: JsonSchema): ReadonlySet<string> | undefined {
  const values = pinnedValues(schema);
  if (values === undefined) return undefined;
  return new Set(values.map((value) => canonicalJson(value)));
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
// Finite value sets
// ============================================================

/** A JSON value the value-by-value comparison judges. */
type ScalarValue = string | number | boolean | null;

function isScalarValue(value: unknown): value is ScalarValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Whether `value` is a value of type `token`. A scalar is never an `object`
 * or an `array`, and an unknown token is not judged, so both are `false`.
 */
function scalarHasTypeToken(value: ScalarValue, token: string): boolean {
  switch (token) {
    case STRING_TYPE_TOKEN: {
      return typeof value === "string";
    }
    case NUMBER_TYPE_TOKEN: {
      return typeof value === "number" && Number.isFinite(value);
    }
    case INTEGER_TYPE_TOKEN: {
      return Number.isInteger(value);
    }
    case BOOLEAN_TYPE_TOKEN: {
      return typeof value === "boolean";
    }
    case NULL_TYPE_TOKEN: {
      return value === null;
    }
    default: {
      return false;
    }
  }
}

/**
 * The values `schema` pins with `const` or `enum`, when this comparison can
 * judge them: a non-empty set of scalars, each a value of the schema's own
 * `type`. `undefined` otherwise. A pinned value of another type would make the
 * set describe less than the schema's source may admit — the projection
 * writes a literal `NaN` or `Infinity` as `null` under `type: "number"` — and
 * an empty set would satisfy every keyword vacuously.
 */
function admittedScalarValues(
  schema: JsonSchema,
): readonly ScalarValue[] | undefined {
  const pinned = pinnedValues(schema);
  if (pinned === undefined || pinned.length === 0) return undefined;
  if (!pinned.every((value) => isScalarValue(value))) return undefined;
  const { type } = schema;
  if (
    typeof type === "string" &&
    !pinned.every((value) => scalarHasTypeToken(value, type))
  ) {
    return undefined;
  }
  return pinned;
}

/**
 * Whether `schema` pins a finite value set every admitted member of which
 * passes `test`.
 *
 * A finite child satisfies a parent keyword it does not state itself when
 * each of its values does: `z.literal("x")` satisfies `minLength: 1`, while
 * `z.string()` does not. Each comparison asks this only after the child's
 * own declared keyword failed to imply the parent's, so the two answers are
 * alternatives: a value that does not pass `test` leaves the declared
 * comparison's refusal standing, and a `test` that cannot judge a value
 * faithfully returns `false` for it.
 */
function everyAdmittedValue(
  schema: JsonSchema,
  test: (value: ScalarValue) => boolean,
): boolean {
  const values = admittedScalarValues(schema);
  return values?.every((value) => test(value)) === true;
}

function everyAdmittedString(
  schema: JsonSchema,
  test: (value: string) => boolean,
): boolean {
  return everyAdmittedValue(
    schema,
    (value) => typeof value === "string" && test(value),
  );
}

function everyAdmittedNumber(
  schema: JsonSchema,
  test: (value: number) => boolean,
): boolean {
  return everyAdmittedValue(
    schema,
    (value) =>
      typeof value === "number" && Number.isFinite(value) && test(value),
  );
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
  walk: Walk,
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
        descend(walk),
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
      descend(walk),
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
        descend(walk),
      );
      if (extraResult.verdict !== "subtype") return extraResult;
    }

    if (childExtrasSchema !== undefined) {
      const additionalResult = compareSchemas(
        childExtrasSchema,
        parentExtrasSchema,
        [...path, ADDITIONAL_PROPERTIES_SEGMENT],
        descend(walk),
      );
      if (additionalResult.verdict !== "subtype") return additionalResult;
    }
  }

  return comparePropertyNames(child, parent, path, walk);
}

/**
 * Every key the child admits must be a key the parent admits: the child's
 * `propertyNames` is compared as a subtype of the parent's, so
 * `z.record(z.enum(["a", "b"]), V)` narrows `z.record(z.string(), V)`. A
 * JSON object's keys are always strings, so a child with no explicit
 * `propertyNames` (every construct but `z.record`) is exactly as tight as one
 * declaring `{"type":"string"}`.
 */
function comparePropertyNames(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
  walk: Walk,
): StructuralSubtypeResult {
  if (parent.propertyNames === undefined) return SUBTYPE;
  const keyResult = compareSchemas(
    child.propertyNames ?? { type: STRING_TYPE_TOKEN },
    parent.propertyNames,
    [...path, PROPERTY_NAMES_SEGMENT],
    descend(walk),
  );
  if (keyResult.verdict !== "not-subtype") return keyResult;
  return notSubtype("property-names-mismatch", keyResult.path);
}

// ============================================================
// Arrays and tuples
// ============================================================

const CLOSED_TAIL = "closed";
const OPEN_TAIL = "open";

/** What an array admits past its `prefixItems`: nothing, anything, or a schema. */
type ArrayTail = typeof CLOSED_TAIL | typeof OPEN_TAIL | JsonSchema;

/**
 * The projection closes a tuple that has no rest element with `items: false`.
 * A document stored by an earlier projection closes one by omitting `items`
 * beside `prefixItems`, so that spelling is read as closed too; the current
 * projection never emits it.
 */
function arrayTail(schema: JsonSchema): ArrayTail {
  const { items } = schema;
  if (items === false) return CLOSED_TAIL;
  if (items === true) return OPEN_TAIL;
  if (items !== undefined) return items;
  return closesTupleByOmission(schema) ? CLOSED_TAIL : OPEN_TAIL;
}

function isTailSchema(tail: ArrayTail): tail is JsonSchema {
  return typeof tail !== "string";
}

/** A closed array with no declared prefix is the empty tuple. */
function tuplePrefix(
  schema: JsonSchema,
  tail: ArrayTail,
): readonly JsonSchema[] | undefined {
  return schema.prefixItems ?? (tail === CLOSED_TAIL ? [] : undefined);
}

function compareArray(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
  walk: Walk,
): StructuralSubtypeResult {
  const childTail = arrayTail(child);
  const parentTail = arrayTail(parent);
  const childPrefix = tuplePrefix(child, childTail);
  const parentPrefix = tuplePrefix(parent, parentTail);

  // Tuple shape before length bounds: the projection states a closed tuple's
  // arity as `minItems`/`maxItems` too, and a mismatched arity is the more
  // precise refusal.
  if (parentPrefix !== undefined) {
    if (childPrefix?.length !== parentPrefix.length) {
      return notSubtype("tuple-arity-mismatch", path);
    }
    for (const [index, parentMember] of parentPrefix.entries()) {
      const memberResult = compareSchemas(
        requireDefined(childPrefix[index]),
        parentMember,
        [...path, tupleIndexSegment(index)],
        descend(walk),
      );
      if (memberResult.verdict !== "subtype") return memberResult;
    }
    // A closed parent tuple has no elements beyond its declared prefix. A
    // child of equal prefix arity that is not closed too (a rest element,
    // e.g. `z.tuple([string], number)`) permits values longer than the parent
    // ever allows, even though the prefix lengths matched above.
    if (parentTail === CLOSED_TAIL && childTail !== CLOSED_TAIL) {
      return notSubtype("tuple-arity-mismatch", path);
    }
  } else if (childPrefix !== undefined && isTailSchema(parentTail)) {
    // A tuple narrowing a homogeneous parent array: every prefix member must
    // itself narrow the parent's item type.
    for (const [index, childMember] of childPrefix.entries()) {
      const memberResult = compareSchemas(
        childMember,
        parentTail,
        [...path, tupleIndexSegment(index)],
        descend(walk),
      );
      if (memberResult.verdict !== "subtype") return memberResult;
    }
  }

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

  // A closed child has no elements beyond its prefix, so there is no tail
  // left to compare against the parent's.
  if (!isTailSchema(parentTail) || childTail === CLOSED_TAIL) return SUBTYPE;
  if (childTail === OPEN_TAIL) {
    return notSubtype("unconstrained-where-parent-constrains", [
      ...path,
      ARRAY_ITEM_SEGMENT,
    ]);
  }
  return compareSchemas(
    childTail,
    parentTail,
    [...path, ARRAY_ITEM_SEGMENT],
    descend(walk),
  );
}

// ============================================================
// Strings
// ============================================================

/**
 * Length under each reading a validator applies: JSON Schema counts Unicode
 * code points, Zod's `.min()`/`.max()`/`.length()` count UTF-16 code units. A
 * string holding an astral character has more units than points, so a lower
 * bound is judged on points and an upper bound on units — the reading that
 * admits less, which both readings then agree to.
 */
function satisfiesMinLength(value: string, minLength: number): boolean {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code points are what JSON Schema counts
  return [...value].length >= minLength;
}

function satisfiesMaxLength(value: string, maxLength: number): boolean {
  return value.length <= maxLength;
}

/**
 * The flags a projected `pattern` is read under. Zod tests the flagless
 * `RegExp` it was given (a flagged one never reaches this comparison — the
 * projection marks it {@link ZOD_ONLY_CONSTRAINT_KEYWORD}); a JSON Schema
 * validator commonly compiles the pattern with Unicode semantics (`u`). A
 * value satisfies the pattern only when it matches under both readings.
 */
const PATTERN_READING_FLAGS = ["", "u"] as const;

function compilePattern(pattern: string, flags: string): RegExp | undefined {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** A pattern either reading cannot compile is satisfied by nothing. */
function satisfiesPattern(value: string, pattern: string): boolean {
  return PATTERN_READING_FLAGS.every(
    (flags) => compilePattern(pattern, flags)?.test(value) === true,
  );
}

/**
 * The `format` names Zod projects beside a `pattern` that states the whole
 * check: `.startsWith()`, `.endsWith()`, `.includes()`, `.lowercase()`,
 * `.uppercase()`. Zod enforces each through `startsWith`/`endsWith`/
 * `includes` or that same pattern, which a matching value satisfies; to a
 * JSON Schema validator each is an unknown format, which asserts nothing.
 * Every other format — `email`, `uuid`, `date-time`, `uri`, a custom
 * `z.stringFormat()` — states a check of its own that is not evaluated here,
 * so a finite child satisfies it only by declaring the same format.
 */
const PATTERN_STATED_FORMATS: ReadonlySet<string> = new Set([
  "starts_with",
  "ends_with",
  "includes",
  "lowercase",
  "uppercase",
]);

function satisfiesFormat(value: string, parent: JsonSchema): boolean {
  return (
    parent.format !== undefined &&
    PATTERN_STATED_FORMATS.has(parent.format) &&
    parent.pattern !== undefined &&
    satisfiesPattern(value, parent.pattern)
  );
}

function compareStringConstraints(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
): StructuralSubtypeResult {
  const parentMinLength = parent.minLength ?? 0;
  if (
    (child.minLength ?? 0) < parentMinLength &&
    !everyAdmittedString(child, (value) =>
      satisfiesMinLength(value, parentMinLength),
    )
  ) {
    return notSubtype("string-length-not-tighter", path);
  }

  const parentMaxLength = parent.maxLength ?? Number.POSITIVE_INFINITY;
  if (
    (child.maxLength ?? Number.POSITIVE_INFINITY) > parentMaxLength &&
    !everyAdmittedString(child, (value) =>
      satisfiesMaxLength(value, parentMaxLength),
    )
  ) {
    return notSubtype("string-length-not-tighter", path);
  }

  const parentPattern = parent.pattern;
  if (
    parentPattern !== undefined &&
    child.pattern !== parentPattern &&
    !everyAdmittedString(child, (value) =>
      satisfiesPattern(value, parentPattern),
    )
  ) {
    return notSubtype("pattern-mismatch", path);
  }

  // `format` is a constraint, not an annotation — see COMPARABLE_KEYWORDS.
  if (
    parent.format !== undefined &&
    child.format !== parent.format &&
    !everyAdmittedString(child, (value) => satisfiesFormat(value, parent))
  ) {
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

function satisfiesLowerBound(value: number, bound: NumericBound): boolean {
  return bound.exclusive ? value > bound.value : value >= bound.value;
}

function satisfiesUpperBound(value: number, bound: NumericBound): boolean {
  return bound.exclusive ? value < bound.value : value <= bound.value;
}

/** A finite number as `coefficient × 10^exponent`, exactly. */
type ExactDecimal = Readonly<{ coefficient: bigint; exponent: number }>;

const DECIMAL_NUMERAL = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/**
 * `value` read as the shortest decimal numeral that round-trips it — the
 * numeral its JSON form carries, and so the number a JSON Schema validator
 * reading the stored document sees.
 */
function exactDecimal(value: number): ExactDecimal | undefined {
  const match = DECIMAL_NUMERAL.exec(String(value));
  if (match === null) return undefined;
  const [, sign = "", integerDigits = "", fractionDigits = "", exponent = "0"] =
    match;
  return {
    coefficient: BigInt(`${sign}${integerDigits}${fractionDigits}`),
    exponent: Number(exponent) - fractionDigits.length,
  };
}

const SMALLEST_NORMAL_DOUBLE = 2 ** -1022;

function isNormalOrZero(value: number): boolean {
  return value === 0 || Math.abs(value) >= SMALLEST_NORMAL_DOUBLE;
}

/**
 * Whether `value` is a multiple of `divisor` under both readings of
 * `multipleOf`.
 *
 * JSON Schema's: dividing the two decimals yields an integer, decided here
 * with no rounding — `0.3` is a multiple of `0.1`, `0.30000000000000004` is
 * not. Zod's (`floatSafeRemainder`, zod/v4/core): the floating-point quotient
 * lies within `4 × Number.EPSILON` (relative) of an integer. An exact
 * multiple's floating-point quotient is off its integer by at most about
 * `1.5 × Number.EPSILON` relative, so Zod accepts it, provided both operands
 * are normal doubles and the quotient is a safe integer; outside that range
 * the value is not judged.
 */
function isDecimalMultiple(value: number, divisor: number): boolean {
  if (!(divisor > 0) || !isNormalOrZero(divisor) || !isNormalOrZero(value)) {
    return false;
  }
  const numerator = exactDecimal(value);
  const denominator = exactDecimal(divisor);
  if (numerator === undefined || denominator === undefined) return false;
  const exponent = Math.min(numerator.exponent, denominator.exponent);
  const scaledNumerator =
    numerator.coefficient * 10n ** BigInt(numerator.exponent - exponent);
  const scaledDenominator =
    denominator.coefficient * 10n ** BigInt(denominator.exponent - exponent);
  if (scaledNumerator % scaledDenominator !== 0n) return false;
  const quotient = scaledNumerator / scaledDenominator;
  const largestSafeQuotient = BigInt(Number.MAX_SAFE_INTEGER);
  return quotient <= largestSafeQuotient && quotient >= -largestSafeQuotient;
}

function compareNumericConstraints(
  child: JsonSchema,
  parent: JsonSchema,
  path: readonly string[],
): StructuralSubtypeResult {
  const parentLower = lowerBound(parent);
  if (parentLower !== undefined) {
    const childLower = lowerBound(child);
    const declaredTighter =
      childLower !== undefined &&
      lowerBoundTighterOrEqual(childLower, parentLower);
    if (
      !declaredTighter &&
      !everyAdmittedNumber(child, (value) =>
        satisfiesLowerBound(value, parentLower),
      )
    ) {
      return notSubtype("numeric-bound-not-tighter", path);
    }
  }

  const parentUpper = upperBound(parent);
  if (parentUpper !== undefined) {
    const childUpper = upperBound(child);
    const declaredTighter =
      childUpper !== undefined &&
      upperBoundTighterOrEqual(childUpper, parentUpper);
    if (
      !declaredTighter &&
      !everyAdmittedNumber(child, (value) =>
        satisfiesUpperBound(value, parentUpper),
      )
    ) {
      return notSubtype("numeric-bound-not-tighter", path);
    }
  }

  const parentMultipleOf = parent.multipleOf;
  if (
    parentMultipleOf !== undefined &&
    child.multipleOf !== parentMultipleOf &&
    !everyAdmittedNumber(child, (value) =>
      isDecimalMultiple(value, parentMultipleOf),
    )
  ) {
    return notSubtype("multiple-of-mismatch", path);
  }

  return SUBTYPE;
}
