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
 *  - a union whose branches disagree: each branch that can hold a value the
 *    walk changes is walked (a `z.null()`, `z.undefined()`, `z.void()` or
 *    `z.never()` branch holds only values the walk returns as given, so it
 *    has no say), and the value is canonicalised only when every such branch
 *    renders it to the same key text. `z.union([z.date(), z.null()])` is
 *    therefore read as a date. `z.union([z.date(), z.string()])` disagrees on
 *    ISO text (one branch reads a date, the other a string), so that text
 *    keys as given, as does an object under a union of shapes whose key
 *    orders differ;
 *  - a record, tuple, intersection, map or set, and every undeclared property.
 *
 * Nothing is parsed: no transform, refinement or coercion runs, because a
 * schema whose parse does not reproduce its own output (a transform that
 * appends to its input) would key a value the row does not hold.
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
  getter?: () => z.ZodType;
  out?: z.ZodType;
  options?: readonly z.ZodType[];
}>;

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

function walkObject(
  shape: Readonly<Record<string, z.ZodType>>,
  value: Record<string, unknown>,
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
        walkValue(propertySchema, element, new Set())
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
): unknown {
  const [first, ...rest] = options
    .filter(
      (option) => !VALUELESS_TYPES.has(unwrapTransparentWrappers(option).type),
    )
    .map((option) => walkValue(option, value, lazySeen));
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
): unknown {
  const unwrapped = unwrapTransparentWrappers(schema);
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
      return walkValue(def.getter(), value, new Set([...lazySeen, unwrapped]));
    }
    case "pipe": {
      const out = def.out;
      return out === undefined || out.type === "transform" ?
          value
        : walkValue(out, value, lazySeen);
    }
    case "union": {
      return def.options === undefined ?
          value
        : walkUnion(def.options, value, lazySeen);
    }
    case "array": {
      const element = def.element;
      if (element === undefined || !Array.isArray(value)) return value;
      const items = value as readonly unknown[];
      const walked = items.map((item) => walkValue(element, item, new Set()));
      return walked.some((item, index) => item !== items[index]) ? walked : (
          value
        );
    }
    default: {
      const shape = objectSchemaShape(unwrapped);
      return shape !== undefined && isPlainObject(value) ?
          walkObject(shape, value)
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
  return walkValue(schema, value, new Set());
}
