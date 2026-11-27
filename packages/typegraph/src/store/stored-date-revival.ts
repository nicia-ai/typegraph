/**
 * Stored date text and the `Date` a kind's schema accepts: the one owner of
 * both directions.
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
 *    with no `.overwrite()` check on the schema under those wrappers. An
 *    `.overwrite()` on a wrapper is not consulted: the revived value is
 *    parsed through it. Either way the parse only validates an untouched
 *    value; what a re-validating write stores for it is the stored value
 *    (`revalidateWrite`), so a rewriting check never reaches it;
 *  - the stored value is portable timestamp text ({@link isPortableTimestamp}):
 *    exactly the text the store writes for a `Date` it accepts (canonical UTC
 *    ISO in the years 0001 to 9999), so the revived `Date` serializes back to
 *    the same bytes and passes the store's own date-storability check.
 *
 * Every other value is returned as stored: a non-canonical string (which
 * `z.date()` still refuses, as before), a value under a union, record, tuple,
 * intersection, lazy schema or pipe (`z.date().transform(…)` included), and
 * every property the schema does not declare. Nothing else
 * about validation changes: the caller still parses the result through the
 * complete kind schema, and a caller's own input is never passed here.
 *
 * This is an INPUT-side decision, deliberately not the query compiler's field
 * typing (`schemaIntrospectorFor`), which follows a pipe to its output to
 * decide where a stored value compares as a date: `z.string().pipe(z.coerce.date())`
 * is a date there, but its input is a string that a revived `Date` would fail.
 *
 * The same decision serves every document that carries props in their stored
 * form: an interchange document `exportGraph` wrote, which `importGraph`
 * revives before parsing it through the kind's schema, and a graph merge's
 * planned writes, which carry the props the branch read.
 *
 * The opposite direction — a validated `Date` to the stored text — is
 * {@link encodeStoredDatesFor}, for a write that hands the backend JSON
 * rather than props for the backend to serialize (the set-update patch and
 * the `compareAndSet` expectation). Both encode a `Date` with the one encoder
 * every stored text comes from, `dateInstantText`.
 *
 * Reads are unchanged: they return the stored text.
 */
import { type z } from "zod";

import { objectSchemaShape } from "../core/kind-schema";
import { dateInstantText, isPortableTimestamp } from "../utils/date";
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
 * value on every parse. Nothing at or below one is revived, so its stored text
 * is parsed as stored (and refused by a `z.date()`), as it always was.
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

function reviveObject(
  shape: Readonly<Record<string, z.ZodType>>,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const entries = Object.entries(value).map(([key, element]) => {
    const propertySchema = Object.hasOwn(shape, key) ? shape[key] : undefined;
    return [
      key,
      propertySchema === undefined ? element : (
        reviveStoredDates(propertySchema, element)
      ),
    ] as const;
  });
  const changed = entries.some(([key, element]) => element !== value[key]);
  // `Object.fromEntries` defines own data properties, so a stored
  // `__proto__` key stays a property rather than reaching the setter.
  return changed ? Object.fromEntries(entries) : value;
}

/**
 * `value`, as stored for a position whose schema is `schema`, with every
 * stored date text that position's schema accepts only as a `Date` revived
 * to that `Date`. Returns `value` itself when nothing is revived.
 */
export function reviveStoredDates(schema: z.ZodType, value: unknown): unknown {
  const unwrapped = unwrapTransparentWrappers(schema);
  // A schema that rewrites its value on every parse — on the date itself or on
  // an object or array holding it — is not revived through, so the re-parse
  // refuses its stored text as before.
  if (hasOverwriteCheck(unwrapped)) return value;
  const def = unwrapped.def as SchemaDef;
  if (unwrapped.type === "date") {
    return typeof value === "string" && isPortableTimestamp(value) ?
        new Date(value)
      : value;
  }
  const shape = objectSchemaShape(unwrapped);
  if (shape !== undefined) {
    return isPlainObject(value) ? reviveObject(shape, value) : value;
  }
  if (unwrapped.type === "array") {
    const element = def.element;
    if (element === undefined || !Array.isArray(value)) return value;
    const items = value as readonly unknown[];
    const revived = items.map((item) => reviveStoredDates(element, item));
    return revived.some((item, index) => item !== items[index]) ? revived : (
        value
      );
  }
  return value;
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
 * `value`, as validated by a kind's schema, with every `Date` it holds —
 * itself, an array element, or a plain-object value at any depth — replaced
 * by the text the store persists for it: the ISO text of the instant it
 * holds (`dateInstantText`), exactly what the backends write for a `Date` on
 * the single-row write paths (`storedJsonText`), so a set update's encoded
 * patch stores the same bytes. The inverse
 * of {@link reviveStoredDates} for every `Date` the store accepts (the
 * validation boundary refuses an invalid or unstorable `Date` first).
 *
 * Every other value is returned untouched — a `Map`, a class instance or a
 * non-finite number is left for the caller's JSON check to refuse — and
 * `value` itself is returned when it holds no `Date`.
 */
function encodeStoredDates(value: unknown): unknown {
  if (value instanceof Date) return dateInstantText(value);
  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    const encoded = items.map((item) => encodeStoredDates(item));
    return encoded.some((item, index) => item !== items[index]) ? encoded : (
        value
      );
  }
  if (!isPlainObject(value)) return value;
  const entries = Object.entries(value).map(
    ([key, element]) => [key, encodeStoredDates(element)] as const,
  );
  const changed = entries.some(([key, element]) => element !== value[key]);
  // `Object.fromEntries` defines own data properties, so a `__proto__` key
  // stays a property rather than reaching the setter.
  return changed ? Object.fromEntries(entries) : value;
}

/** A value encoded for storage, or the first `Date` it would not read back. */
export type StoredDateEncoding =
  | Readonly<{ kind: "encoded"; value: unknown }>
  | Readonly<{ kind: "not-revivable"; path: string }>;

function propsPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return parent === "" ? key : `${parent}.${key}`;
}

/** The first position where `original` holds a `Date` and `revived` does not. */
function findUnrevivedDate(
  original: unknown,
  revived: unknown,
  path: string,
): string | undefined {
  if (original instanceof Date) {
    return revived instanceof Date ? undefined : path;
  }
  if (Array.isArray(original)) {
    const revivedItems = revived as readonly unknown[];
    for (const [index, item] of (original as readonly unknown[]).entries()) {
      const found = findUnrevivedDate(
        item,
        revivedItems[index],
        propsPath(path, index),
      );
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isPlainObject(original)) return undefined;
  const revivedObject = revived as Record<string, unknown>;
  for (const [key, element] of Object.entries(original)) {
    const found = findUnrevivedDate(
      element,
      revivedObject[key],
      propsPath(path, key),
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * `value`, validated by `schema`, encoded for a write that hands the backend
 * JSON ({@link encodeStoredDates}) — but only when every `Date` it holds sits
 * where {@link reviveStoredDates} reads the stored text back as that `Date`.
 * Anywhere else (a union, a record, `z.any()`, an `.overwrite()`) the stored
 * text would be read back as a string, so the row would hold a value the
 * schema distinguishes from the `Date` that was written, and a uniqueness
 * claim rebuilt from it would not match the claim a create takes for that
 * `Date`. Such a value is reported with the path of the first such `Date`, for
 * the caller to refuse.
 */
export function encodeStoredDatesFor(
  schema: z.ZodType,
  value: unknown,
  path: string,
): StoredDateEncoding {
  const encoded = encodeStoredDates(value);
  if (encoded === value) return { kind: "encoded", value };
  const unrevived = findUnrevivedDate(
    value,
    reviveStoredDates(schema, encoded),
    path,
  );
  return unrevived === undefined ?
      { kind: "encoded", value: encoded }
    : { kind: "not-revivable", path: unrevived };
}
