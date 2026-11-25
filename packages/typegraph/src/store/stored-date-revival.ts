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
 *    the shape of a nested `z.object()`, or the element of a `z.array()`;
 *  - the stored value is canonical ISO text ({@link isCanonicalIsoDate}) —
 *    exactly the text the store writes for a `Date`, so the revived `Date`
 *    serializes back to the same bytes.
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

import { isCanonicalIsoDate } from "../utils/date";

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
  shape?: Readonly<Record<string, z.ZodType>>;
  element?: z.ZodType;
}>;

function unwrapTransparentWrappers(schema: z.ZodType): z.ZodType {
  const inner = (schema.def as SchemaDef).innerType;
  return TRANSPARENT_WRAPPER_TYPES.has(schema.type) && inner !== undefined ?
      unwrapTransparentWrappers(inner)
    : schema;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
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
  const def = unwrapped.def as SchemaDef;
  if (unwrapped.type === "date") {
    return typeof value === "string" && isCanonicalIsoDate(value) ?
        new Date(value)
      : value;
  }
  if (unwrapped.type === "object") {
    return def.shape !== undefined && isPlainRecord(value) ?
        reviveObject(def.shape, value)
      : value;
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
