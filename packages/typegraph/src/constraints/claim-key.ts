/**
 * The canonical rendering of a value a uniqueness key is derived from.
 *
 * A claim key is the text of the constraint's field values
 * ({@link uniqueKeyValueText}). The same stored value reaches the key owner in
 * two renderings: as a write's parse output, where a `z.date()` value is a
 * `Date` and a `z.object()` value has whatever key order the parse produced,
 * and as the row reads back from storage, where the same date is its ISO text
 * and PostgreSQL's `jsonb` has reordered the object's keys. Keyed as given,
 * the two renderings produce different keys for one value, and a claim one
 * path takes is invisible to a probe another path makes.
 *
 * {@link claimKeyValue} maps both renderings to one, by the schema's
 * structure alone. It is applied by the key owner itself
 * (`uniqueConstraintKey` and `uniqueFieldsKey` in `./index`), to every value
 * on every path, so no caller chooses between a "validated" and a "stored"
 * reading. It is idempotent, and on a parse output whose objects already
 * follow their shapes it returns its input unchanged.
 *
 * At each position the schema reaches:
 *
 *  - **a date** (`z.date()`, `z.coerce.date()`, a refined date): a `Date` is
 *    kept, and stored timestamp text ({@link isPortableTimestamp}, exactly the
 *    text the store writes for a `Date`) becomes that `Date`. A `Date` and its
 *    stored text therefore render identically: at a top-level field as the
 *    JSON-quoted ISO text (`"\"2024-01-02T03:04:05.000Z\""`), which is what a
 *    create has always keyed, and nested inside an object or array as the ISO
 *    text inside that value's JSON.
 *  - **an object** (`z.object()`): rebuilt with its declared keys in the
 *    shape's order and its undeclared keys after them in their given order,
 *    then each declared value walked through its property schema.
 *  - **an array** (`z.array()`): each element walked through the element
 *    schema.
 *
 * The walk reaches a position through the transparent wrappers
 * (`.optional()`, `.nullable()`, `.default()`, `.prefault()`, `.catch()`,
 * `.readonly()`, `.nonoptional()`), through `z.lazy()` (a lazy schema that
 * resolves back to itself without descending into the value stops the walk
 * there), and through the output side of a pipe whose output is a plain
 * schema (`z.string().pipe(z.coerce.date())`, `z.preprocess()`, a codec),
 * because a key is derived from a parse's output. It stops, leaving the value
 * as given, at:
 *
 *  - a pipe whose output is a transform (`.transform()`): the output's
 *    structure is the function's, which no schema states;
 *  - an `.overwrite()` check, for the same reason;
 *  - a union whose branches disagree: each branch that can hold the value is
 *    walked, and the value is canonicalised only when every such branch
 *    renders it to the same key text. A `z.null()`, `z.undefined()`,
 *    `z.void()` or `z.never()` branch holds only values the walk returns as
 *    given, so it has no say. Neither has a branch that structurally cannot
 *    hold the value ({@link branchExcludes}): a primitive of another type
 *    (`z.number()` for a string), a non-array for `z.array()`, a non-object
 *    for `z.object()`, or an object whose required `z.literal()` /
 *    `z.enum()` property is missing or holds another value (a discriminator).
 *    When every branch is excluded, every branch with a say is walked, as if
 *    none were. `z.union([z.date(), z.null()])` and
 *    `z.union([z.date(), z.number()])` are therefore read as a date.
 *    `z.union([z.date(), z.string()])` disagrees on ISO text (one branch
 *    reads a date, the other a string), so that text keys as given, as does an
 *    object under a union of shapes whose key orders differ and that no
 *    discriminator tells apart;
 *  - a record, tuple, intersection, map or set, and every undeclared property.
 *
 * Nothing is parsed: no transform, refinement or coercion runs, because a
 * schema whose parse does not reproduce its own output (a transform that
 * appends to its input) would key a value the row does not hold.
 *
 * The walk is linear in the value. One derivation walks each value at each
 * schema at most once ({@link WalkMemo}): a union whose branches share a
 * recursive property schema walks that property's value once, not once per
 * branch per level, which would be exponential in the depth.
 */
import { type z } from "zod";

import { objectSchemaShape } from "../core/kind-schema";
import {
  hasOverwriteCheck,
  unwrapTransparentWrappers,
} from "../core/schema-wrappers";
import { isPortableTimestamp } from "../utils/date";
import { isPlainObject } from "../utils/object";

type WalkedSchemaDef = Readonly<{
  element?: z.ZodType;
  entries?: Readonly<Record<string, unknown>>;
  getter?: () => z.ZodType;
  out?: z.ZodType;
  options?: readonly z.ZodType[];
  values?: readonly unknown[];
}>;

/**
 * One key derivation's walked values: per schema (with its transparent
 * wrappers peeled off, which the walk does not distinguish), per value, the
 * value's canonical rendering. A value is walked at a schema at most once, so
 * a value two union branches both descend into, through the same property
 * schema, is walked once. Recorded only for a walk entered with no lazy schema
 * already resolved at its position, the one state in which the rendering
 * depends on nothing but the schema and the value.
 */
type WalkMemo = Map<z.ZodType, Map<unknown, unknown>>;

/**
 * The text one field value contributes to a unique key, before collation:
 * a string as itself, a number or boolean as its `toString()`, anything else
 * (a `Date`, an object, an array) as its JSON text.
 */
export function uniqueKeyValueText(value: unknown): string {
  return (
    typeof value === "string" ? value
    : typeof value === "number" || typeof value === "boolean" ? value.toString()
    : jsonText(value)
  );
}

/** `JSON.stringify`, which answers `undefined` for a function or symbol. */
function jsonText(value: unknown): string {
  const text: unknown = JSON.stringify(value);
  return typeof text === "string" ? text : "";
}

/**
 * The schema types that hold only `null` / `undefined` (or nothing), values
 * the walk returns as given: a union branch of one of them has no say in how
 * the union's value is read.
 */
const VALUELESS_TYPES: ReadonlySet<string> = new Set([
  "null",
  "undefined",
  "void",
  "never",
]);

/**
 * Whether a value at a position whose schema is `schema` structurally cannot
 * be one `schema` holds: the schema's type, or a required literal property
 * of an object schema, rules it out. `false` whenever that is not certain —
 * `null` and `undefined` (which a wrapper admits), a schema the walk does
 * not interpret, a transform's output — so excluding a branch never drops one
 * that holds the value. Bounded by the schema, not the value: an object's
 * properties are read one level deep and only at a literal or enum.
 */
function branchExcludes(
  schema: z.ZodType,
  value: unknown,
  lazySeen: ReadonlySet<z.ZodType>,
): boolean {
  if (value === null || value === undefined) return false;
  const unwrapped = unwrapTransparentWrappers(schema);
  if (hasOverwriteCheck(unwrapped)) return false;
  const def = unwrapped.def as WalkedSchemaDef;
  const schemaType: string = unwrapped.type;
  switch (schemaType) {
    case "string":
    case "number":
    case "boolean": {
      return typeof value !== schemaType;
    }
    case "date": {
      return !(value instanceof Date) && typeof value !== "string";
    }
    case "literal":
    case "enum": {
      const allowed =
        schemaType === "literal" ?
          def.values
        : Object.values(def.entries ?? {});
      return allowed !== undefined && !allowed.includes(value);
    }
    case "array": {
      return !Array.isArray(value);
    }
    case "lazy": {
      if (def.getter === undefined || lazySeen.has(unwrapped)) return false;
      return branchExcludes(
        def.getter(),
        value,
        new Set([...lazySeen, unwrapped]),
      );
    }
    case "pipe": {
      const out = def.out;
      return out !== undefined && out.type !== "transform" ?
          branchExcludes(out, value, lazySeen)
        : false;
    }
    case "union": {
      const options = def.options ?? [];
      return (
        options.length > 0 &&
        options.every((option) => branchExcludes(option, value, lazySeen))
      );
    }
    default: {
      const shape = objectSchemaShape(unwrapped);
      if (shape === undefined) return false;
      if (!isPlainObject(value)) return true;
      return Object.entries(shape).some(
        ([key, propertySchema]) =>
          (propertySchema.type === "literal" ||
            propertySchema.type === "enum") &&
          (!Object.hasOwn(value, key) ||
            branchExcludes(propertySchema, value[key], new Set())),
      );
    }
  }
}

function walkObject(
  shape: Readonly<Record<string, z.ZodType>>,
  value: Record<string, unknown>,
  memo: WalkMemo,
): Record<string, unknown> {
  const declared = Object.keys(shape).filter((key) =>
    Object.hasOwn(value, key),
  );
  const undeclared = Object.keys(value).filter(
    (key) => !Object.hasOwn(shape, key),
  );
  const entries = [...declared, ...undeclared].map((key) => {
    const element = value[key];
    const propertySchema = Object.hasOwn(shape, key) ? shape[key] : undefined;
    return [
      key,
      propertySchema === undefined ? element : (
        walkValue(propertySchema, element, new Set(), memo)
      ),
    ] as const;
  });
  const givenKeys = Object.keys(value);
  const changed = entries.some(
    ([key, element], index) =>
      element !== value[key] || key !== givenKeys[index],
  );
  // `Object.fromEntries` defines own data properties, so a `__proto__` key
  // stays a property rather than reaching the setter.
  return changed ? Object.fromEntries(entries) : value;
}

function walkUnion(
  options: readonly z.ZodType[],
  value: unknown,
  lazySeen: ReadonlySet<z.ZodType>,
  memo: WalkMemo,
): unknown {
  const withSay = options.filter(
    (option) => !VALUELESS_TYPES.has(unwrapTransparentWrappers(option).type),
  );
  const holding = withSay.filter(
    (option) => !branchExcludes(option, value, lazySeen),
  );
  const [first, ...rest] = (holding.length === 0 ? withSay : holding).map(
    (option) => walkValue(option, value, lazySeen, memo),
  );
  if (first === undefined) return value;
  const text = uniqueKeyValueText(first);
  return rest.every((candidate) => uniqueKeyValueText(candidate) === text) ?
      first
    : value;
}

/**
 * Walks one value through its schema. `lazySeen` holds the lazy schemas
 * resolved at THIS value position since the walk last descended into the
 * value; it is what stops a lazy schema that resolves back to itself. A
 * descent into an object property or array element starts a fresh set, so a
 * recursive schema is walked as deep as the value is.
 */
function walkValue(
  schema: z.ZodType,
  value: unknown,
  lazySeen: ReadonlySet<z.ZodType>,
  memo: WalkMemo,
): unknown {
  const unwrapped = unwrapTransparentWrappers(schema);
  if (lazySeen.size > 0) return walkUnwrapped(unwrapped, value, lazySeen, memo);
  const walked = memo.get(unwrapped);
  if (walked?.has(value) === true) return walked.get(value);
  const result = walkUnwrapped(unwrapped, value, lazySeen, memo);
  // Read again: the walk of a recursive schema records deeper values under
  // this same schema, so the map it filled is the one to extend.
  const recorded = memo.get(unwrapped);
  if (recorded === undefined) memo.set(unwrapped, new Map([[value, result]]));
  else recorded.set(value, result);
  return result;
}

/** {@link walkValue} at a schema whose transparent wrappers are peeled off. */
function walkUnwrapped(
  unwrapped: z.ZodType,
  value: unknown,
  lazySeen: ReadonlySet<z.ZodType>,
  memo: WalkMemo,
): unknown {
  if (hasOverwriteCheck(unwrapped)) return value;
  const def = unwrapped.def as WalkedSchemaDef;
  // Widened to `string`: the walk handles a handful of schema types and
  // passes every other one through, so it is not a switch over all of them.
  const schemaType: string = unwrapped.type;
  switch (schemaType) {
    case "date": {
      return typeof value === "string" && isPortableTimestamp(value) ?
          new Date(value)
        : value;
    }
    case "lazy": {
      if (def.getter === undefined || lazySeen.has(unwrapped)) return value;
      return walkValue(
        def.getter(),
        value,
        new Set([...lazySeen, unwrapped]),
        memo,
      );
    }
    case "pipe": {
      const out = def.out;
      return out === undefined || out.type === "transform" ?
          value
        : walkValue(out, value, lazySeen, memo);
    }
    case "union": {
      return def.options === undefined ?
          value
        : walkUnion(def.options, value, lazySeen, memo);
    }
    case "array": {
      const element = def.element;
      if (element === undefined || !Array.isArray(value)) return value;
      const items = value as readonly unknown[];
      const walked = items.map((item) =>
        walkValue(element, item, new Set(), memo),
      );
      return walked.some((item, index) => item !== items[index]) ? walked : (
          value
        );
    }
    default: {
      const shape = objectSchemaShape(unwrapped);
      return shape !== undefined && isPlainObject(value) ?
          walkObject(shape, value, memo)
        : value;
    }
  }
}

/**
 * `value`, held at a position whose schema is `schema`, in the canonical
 * rendering a uniqueness key is derived from (see the module comment).
 * Returns `value` itself when it is already canonical.
 */
export function claimKeyValue(schema: z.ZodType, value: unknown): unknown {
  return walkValue(schema, value, new Set(), new Map());
}
