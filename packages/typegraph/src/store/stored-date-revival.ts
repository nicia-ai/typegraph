/**
 * Stored date text, revived to the `Date` a kind's schema accepts.
 *
 * The store persists props as JSON, so a `z.date()` property's `Date` is
 * written as its `toISOString()` text and read back as that text. A path that
 * runs STORED props through the kind's schema again — an update merging its
 * patch over the current row, a set update checking its after-images,
 * `validateStore` — would otherwise hand `z.date()` a string, which it refuses:
 * an update that never touched the date property failed validation.
 *
 * {@link reviveStoredDates} is the one decision every such path makes. It
 * replaces a value with `new Date(value)` exactly when both hold:
 *
 *  - the schema at the value's position accepts only a `Date`: a `z.date()`
 *    (including `z.coerce.date()` and a refined `z.date()`), reached from the
 *    props object through `.optional()`, `.nullable()`, `.default()`,
 *    `.prefault()`, `.catch()`, `.readonly()` and `.nonoptional()` wrappers,
 *    the shape of a nested `z.object()`, or the element of a `z.array()`,
 *    with no `.overwrite()` check on the way (one rewrites its value on every
 *    parse, so it would rewrite the revived, untouched value);
 *  - the stored value is portable timestamp text ({@link isPortableTimestamp}):
 *    exactly the text the store writes for a `Date` it accepts (canonical UTC
 *    ISO in the years 0001 to 9999), so the revived `Date` serializes back to
 *    the same bytes and passes the store's own date-storability check.
 *
 * Every other value is returned as stored: a non-canonical string (which
 * `z.date()` still refuses, as before), a value under a union, record, tuple,
 * intersection, lazy schema or pipe (`z.date().transform(…)` included — what a
 * transform's output re-parses to is the deferred update-validation design,
 * not this one), and every property the schema does not declare. Nothing else
 * about validation changes: the caller still parses the result through the
 * complete kind schema, and a caller's own input is never passed here.
 *
 * This is an INPUT-side decision, deliberately not the query compiler's field
 * typing (`schemaIntrospectorFor`), which follows a pipe to its output to
 * decide where a stored value compares as a date: `z.string().pipe(z.coerce.date())`
 * is a date there, but its input is a string that a revived `Date` would fail.
 *
 * Reads are unchanged: they return the stored text.
 */
import { type z } from "zod";

import { objectSchemaShape } from "../core/kind-schema";
import { isPortableTimestamp } from "../utils/date";
import { isPlainObject } from "../utils/object";

/** The schema wrappers whose input is their inner schema's input. */
const TRANSPARENT_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "catch",
  "readonly",
  "nonoptional",
]);

type SchemaDef = Readonly<{
  innerType?: z.ZodType;
  element?: z.ZodType;
  checks?: readonly Readonly<{
    _zod: Readonly<{ def: Readonly<{ check: string }> }>;
  }>[];
}>;

/**
 * Whether a schema carries an `.overwrite()` check: one that replaces the
 * value on every parse, so parsing a revived stored value again would rewrite
 * the untouched property instead of keeping it.
 */
function hasOverwriteCheck(schema: z.ZodType): boolean {
  const checks = (schema.def as SchemaDef).checks ?? [];
  return checks.some((check) => check._zod.def.check === "overwrite");
}

function unwrapTransparentWrappers(schema: z.ZodType): z.ZodType {
  const inner = (schema.def as SchemaDef).innerType;
  return TRANSPARENT_WRAPPER_TYPES.has(schema.type) && inner !== undefined ?
      unwrapTransparentWrappers(inner)
    : schema;
}

/**
 * What a walk over a stored value does at each position its schema reaches:
 * revive stored date text (always), and — for a claim key only — also put a
 * declared object's keys back in the order its schema's parse emits them.
 */
type StoredValueWalk = Readonly<{ ordersObjectKeys: boolean }>;

const REVIVE_ONLY: StoredValueWalk = { ordersObjectKeys: false };
const CLAIM_KEY: StoredValueWalk = { ordersObjectKeys: true };

/**
 * The entries of a stored object in the order a parse through `shape` emits
 * them: the declared keys in the shape's order, then every undeclared key in
 * its stored order (a Zod object's parse writes its shape first and then the
 * extras a loose object or catchall keeps, in their input order).
 */
function shapeOrderedEntries(
  shape: Readonly<Record<string, z.ZodType>>,
  value: Record<string, unknown>,
): readonly (readonly [string, unknown])[] {
  const declared = Object.keys(shape).filter((key) =>
    Object.hasOwn(value, key),
  );
  const undeclared = Object.keys(value).filter(
    (key) => !Object.hasOwn(shape, key),
  );
  return [...declared, ...undeclared].map((key) => [key, value[key]] as const);
}

function walkObject(
  shape: Readonly<Record<string, z.ZodType>>,
  value: Record<string, unknown>,
  walk: StoredValueWalk,
): Record<string, unknown> {
  const source =
    walk.ordersObjectKeys ?
      shapeOrderedEntries(shape, value)
    : Object.entries(value);
  const entries = source.map(([key, element]) => {
    const propertySchema = Object.hasOwn(shape, key) ? shape[key] : undefined;
    return [
      key,
      propertySchema === undefined ? element : (
        walkStoredValue(propertySchema, element, walk)
      ),
    ] as const;
  });
  const storedKeys = Object.keys(value);
  const changed = entries.some(
    ([key, element], index) =>
      element !== value[key] || key !== storedKeys[index],
  );
  // `Object.fromEntries` defines own data properties, so a stored
  // `__proto__` key stays a property rather than reaching the setter.
  return changed ? Object.fromEntries(entries) : value;
}

function walkStoredValue(
  schema: z.ZodType,
  value: unknown,
  walk: StoredValueWalk,
): unknown {
  const unwrapped = unwrapTransparentWrappers(schema);
  // A schema that rewrites its value on every parse — on the date itself or on
  // an object or array holding it — would rewrite a revived stored value, so
  // nothing at or below it is revived and the re-parse refuses as before. Its
  // output's key order is the rewrite's own, which no shape states, so nothing
  // below it is reordered either: the stored order is the best evidence.
  if (hasOverwriteCheck(unwrapped)) return value;
  const def = unwrapped.def as SchemaDef;
  if (unwrapped.type === "date") {
    return typeof value === "string" && isPortableTimestamp(value) ?
        new Date(value)
      : value;
  }
  const shape = objectSchemaShape(unwrapped);
  if (shape !== undefined) {
    return isPlainObject(value) ? walkObject(shape, value, walk) : value;
  }
  if (unwrapped.type === "array") {
    const element = def.element;
    if (element === undefined || !Array.isArray(value)) return value;
    const items = value as readonly unknown[];
    const walked = items.map((item) => walkStoredValue(element, item, walk));
    return walked.some((item, index) => item !== items[index]) ? walked : value;
  }
  return value;
}

/**
 * `value`, as stored for a position whose schema is `schema`, with every
 * stored date text that position's schema accepts only as a `Date` revived
 * to that `Date`. Returns `value` itself when nothing is revived.
 */
export function reviveStoredDates(schema: z.ZodType, value: unknown): unknown {
  return walkStoredValue(schema, value, REVIVE_ONLY);
}

/**
 * A kind's stored props with their stored date text revived
 * ({@link reviveStoredDates}), ready to be parsed through the kind's schema
 * again. Returns `props` itself when nothing is revived.
 */
export function reviveStoredDateProps(
  schema: z.ZodType,
  props: Record<string, unknown>,
): Record<string, unknown> {
  return reviveStoredDates(schema, props) as Record<string, unknown>;
}

/**
 * THE props a uniqueness key is derived from when a path holds a node's
 * STORED props rather than props it validated: a tombstone a lookup or a
 * revival reads, the row an update replaces, a verbatim import's document
 * value, a merge's after-image.
 *
 * A claim is keyed from the value the row stores, in the rendering a create
 * of that value keys. Two things about a stored rendering differ from the
 * props a write validated, and this walk restores both, by the schema's
 * structure alone:
 *
 *  - a date: a `Date` is stored as its ISO text, which is revived
 *    ({@link reviveStoredDates});
 *  - an object's key order: a parse through a `z.object()` emits its declared
 *    keys in the shape's order, and the key of an object value is its JSON
 *    text, but PostgreSQL's `jsonb` hands an object back in its own key order.
 *    Each object the walk reaches (through the wrappers, nested shapes and
 *    array elements revival follows) is rebuilt in the shape's order, its
 *    undeclared keys after, so the key derived here is the key a create of
 *    the same value derived, on every backend.
 *
 * Nothing is parsed: no transform, refinement or coercion runs, because a
 * schema whose parse does not reproduce its own output (a transform that
 * appends to its input, a coercion of a value it already produced) would key
 * a value the row does not hold, and a date the walk cannot reach (under
 * `z.lazy()` or `z.union()`) would fail the parse rather than key as its
 * stored text. What the walk does not reach keeps its stored rendering: an
 * object under a union, lazy schema, pipe, record or `.overwrite()`, the
 * undeclared keys of a loose object (whose relative order `jsonb` loses), and
 * a `z.record()` value, whose parse keeps its input order.
 */
export function storedNodeClaimProps(
  schema: z.ZodType,
  props: Record<string, unknown>,
): Record<string, unknown> {
  return walkStoredValue(schema, props, CLAIM_KEY) as Record<string, unknown>;
}
