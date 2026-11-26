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
 *    the shape of a nested `z.object()`, or the element of a `z.array()`;
 *    where an `.overwrite()` check sits on the way (on the date, a wrapper, or
 *    an object or array holding it), only when parsing the revived value
 *    through that position's schema keeps it — otherwise the check would
 *    rewrite the untouched value, and {@link reviveStoredDateProps} reports
 *    the position for the caller to refuse;
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
 * The same decision serves every document that carries props in their stored
 * form: an interchange document `exportGraph` wrote, which `importGraph`
 * revives before parsing it through the kind's schema.
 *
 * The opposite direction — a validated `Date` to the stored text — is
 * {@link encodeStoredDates}, for a write that hands the backend JSON rather
 * than letting `JSON.stringify` encode the `Date` (the set-update patch and
 * the `compareAndSet` expectation).
 *
 * Reads are unchanged: they return the stored text.
 */
import { type z } from "zod";

import { objectSchemaShape } from "../core/kind-schema";
import { ValidationError, type ValidationIssue } from "../errors";
import { type ValidationContext } from "../errors/validation";
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
 * value on every parse, so parsing a revived stored value again could rewrite
 * the untouched property instead of keeping it.
 */
function hasOverwriteCheck(schema: z.ZodType): boolean {
  const checks = (schema.def as SchemaDef).checks ?? [];
  return checks.some((check) => check._zod.def.check === "overwrite");
}

/**
 * The schema under every transparent wrapper, and whether the schema or any
 * wrapper on the way carries an `.overwrite()` check: one on a wrapper
 * (`z.date().optional().overwrite(…)`) runs on the date just as one on the
 * date itself does.
 */
function unwrapTransparentWrappers(
  schema: z.ZodType,
): Readonly<{ unwrapped: z.ZodType; overwrites: boolean }> {
  const inner = (schema.def as SchemaDef).innerType;
  if (!TRANSPARENT_WRAPPER_TYPES.has(schema.type) || inner === undefined) {
    return { unwrapped: schema, overwrites: hasOverwriteCheck(schema) };
  }
  const below = unwrapTransparentWrappers(inner);
  return {
    unwrapped: below.unwrapped,
    overwrites: below.overwrites || hasOverwriteCheck(schema),
  };
}

/**
 * A stored value with its date text revived, and the first position whose
 * schema would REWRITE the revived value on a parse, if any (see
 * {@link reviveStoredDateProps}).
 */
type Revival = Readonly<{ value: unknown; rewrittenPath?: string }>;

function revived(value: unknown, rewrittenPath?: string): Revival {
  return rewrittenPath === undefined ? { value } : { value, rewrittenPath };
}

function propsPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return parent === "" ? key : `${parent}.${key}`;
}

/** Whether two values store as the same JSON. */
function storeTheSame(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(encodeStoredDates(left)) ===
    JSON.stringify(encodeStoredDates(right))
  );
}

/**
 * Whether parsing `candidate` (a stored value with its dates revived) through
 * the position's own schema returns a value that stores as the same JSON:
 * whether every `.overwrite()` on it keeps the stored value. A parse that
 * throws (an async check, a throwing overwrite) is not known to keep it.
 */
function parseKeepsValue(schema: z.ZodType, candidate: unknown): boolean {
  try {
    const parsed = schema.safeParse(candidate);
    return parsed.success && storeTheSame(parsed.data, candidate);
  } catch {
    return false;
  }
}

function reviveObject(
  shape: Readonly<Record<string, z.ZodType>>,
  value: Record<string, unknown>,
  path: string,
): Revival {
  const entries: (readonly [string, unknown])[] = [];
  let rewrittenPath: string | undefined;
  for (const [key, element] of Object.entries(value)) {
    const propertySchema = Object.hasOwn(shape, key) ? shape[key] : undefined;
    if (propertySchema === undefined) {
      entries.push([key, element]);
      continue;
    }
    const revival = reviveAt(propertySchema, element, propsPath(path, key));
    rewrittenPath ??= revival.rewrittenPath;
    entries.push([key, revival.value]);
  }
  const changed = entries.some(([key, element]) => element !== value[key]);
  // `Object.fromEntries` defines own data properties, so a stored
  // `__proto__` key stays a property rather than reaching the setter.
  return revived(changed ? Object.fromEntries(entries) : value, rewrittenPath);
}

function reviveArray(
  element: z.ZodType,
  items: readonly unknown[],
  path: string,
): Revival {
  const revivedItems: unknown[] = [];
  let rewrittenPath: string | undefined;
  for (const [index, item] of items.entries()) {
    const revival = reviveAt(element, item, propsPath(path, index));
    rewrittenPath ??= revival.rewrittenPath;
    revivedItems.push(revival.value);
  }
  return revived(
    revivedItems.some((item, index) => item !== items[index]) ? revivedItems : (
      items
    ),
    rewrittenPath,
  );
}

/** {@link reviveAt} below the transparent wrappers, ignoring their overwrites. */
function reviveUnwrapped(
  unwrapped: z.ZodType,
  value: unknown,
  path: string,
): Revival {
  if (unwrapped.type === "date") {
    return revived(
      typeof value === "string" && isPortableTimestamp(value) ?
        new Date(value)
      : value,
    );
  }
  const shape = objectSchemaShape(unwrapped);
  if (shape !== undefined) {
    return isPlainObject(value) ?
        reviveObject(shape, value, path)
      : revived(value);
  }
  const element = (unwrapped.def as SchemaDef).element;
  if (unwrapped.type === "array" && element !== undefined) {
    return Array.isArray(value) ?
        reviveArray(element, value, path)
      : revived(value);
  }
  return revived(value);
}

function reviveAt(schema: z.ZodType, value: unknown, path: string): Revival {
  const { unwrapped, overwrites } = unwrapTransparentWrappers(schema);
  const revival = reviveUnwrapped(unwrapped, value, path);
  // An `.overwrite()` on this position runs on every parse. Revive under it
  // only when a parse keeps the revived value: an identity overwrite rewrites
  // nothing, and any other would rewrite the untouched stored value.
  if (
    revival.rewrittenPath !== undefined ||
    !overwrites ||
    revival.value === value ||
    parseKeepsValue(schema, revival.value)
  ) {
    return revival;
  }
  return revived(revival.value, path);
}

/**
 * `value`, as stored for a position whose schema is `schema`, with every
 * stored date text that position's schema accepts only as a `Date` revived
 * to that `Date`. Returns `value` itself when nothing is revived, and leaves
 * the stored text at a position whose schema would rewrite the revived value
 * (see {@link reviveStoredDateProps}, which reports that position instead).
 */
export function reviveStoredDates(schema: z.ZodType, value: unknown): unknown {
  const revival = reviveAt(schema, value, "");
  return revival.rewrittenPath === undefined ? revival.value : value;
}

/**
 * A kind's stored props, revived for parsing through the kind's schema
 * again — and, when a revived date sits under an `.overwrite()` that would
 * rewrite it, the first such path: see {@link reviveStoredDateProps}.
 * `props` is revived everywhere in both cases, for a reader that asks only
 * whether the stored row parses (`validateStore`); a WRITE refuses a
 * `rewritten` revival.
 */
export type StoredDatePropsRevival =
  | Readonly<{ kind: "revived"; props: Record<string, unknown> }>
  | Readonly<{
      kind: "rewritten";
      props: Record<string, unknown>;
      path: string;
    }>;

/**
 * A kind's stored props with their stored date text revived
 * ({@link reviveStoredDates}), ready to be parsed through the kind's schema
 * again (`props` itself when nothing is revived) — or, when a revived date
 * sits under an `.overwrite()` that would not keep it, the path of that
 * position, for the caller to REFUSE the re-validating write.
 *
 * The refusal cannot be left to the re-parse: leaving the text unrevived made
 * `z.date()` refuse it, but under a `.catch()` the refusal was swallowed and
 * the fallback stored over the untouched date, and a write that revived it
 * anyway stored the rewritten date. An `.overwrite()` that keeps the value (an
 * identity, a normalization the stored value already satisfies) is decided by
 * parsing the revived value through that position's own schema, so an update
 * to an unrelated property of such a row succeeds as it does for a plain date.
 */
export function reviveStoredDateProps(
  schema: z.ZodType,
  props: Record<string, unknown>,
): StoredDatePropsRevival {
  const revival = reviveAt(schema, props, "");
  const revivedProps = revival.value as Record<string, unknown>;
  return revival.rewrittenPath === undefined ?
      { kind: "revived", props: revivedProps }
    : { kind: "rewritten", props: revivedProps, path: revival.rewrittenPath };
}

/**
 * `value`, as validated by a kind's schema, with every `Date` it holds —
 * itself, an array element, or a plain-object value at any depth — replaced
 * by the text the store persists for it: the ISO text of the instant it holds
 * (`dateInstantText`, never the value's own `toJSON`), which is exactly what
 * the single-row write paths store, so a set update's encoded patch stores
 * the same bytes. The inverse
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
 * Anywhere else (a union, a record, `z.any()`, an `.overwrite()` that would
 * rewrite it) the stored text would be read back as a string or rewritten, so the row would hold a value the
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
  const revival = reviveAt(schema, encoded, path);
  if (revival.rewrittenPath !== undefined) {
    return { kind: "not-revivable", path: revival.rewrittenPath };
  }
  const unrevived = findUnrevivedDate(value, revival.value, path);
  return unrevived === undefined ?
      { kind: "encoded", value: encoded }
    : { kind: "not-revivable", path: unrevived };
}

/**
 * The issue a re-validating write reports for a stored date whose schema
 * would rewrite it ({@link reviveStoredDateProps}): the write would change a
 * value it never touched.
 */
export function rewrittenStoredDateIssue(path: string): ValidationIssue {
  return {
    path,
    message:
      "The stored date sits under an .overwrite() that rewrites it on every parse, so re-validating the row would change a value this write does not touch",
  };
}

/**
 * The props a re-validating store write parses: `stored` revived
 * ({@link reviveStoredDateProps}) with `patch` laid over it, or a
 * `ValidationError` when a stored date the patch leaves in place would be
 * rewritten by its schema. A property the patch states (or unsets) is the
 * caller's input, so it is neither revived nor checked: an update that
 * replaces a rewriting date stores what its schema makes of the new value.
 */
export function revalidatedStoredProps(
  schema: z.ZodType,
  stored: Record<string, unknown>,
  patch: Readonly<Record<string, unknown>>,
  context: ValidationContext,
): Record<string, unknown> {
  const untouched = Object.fromEntries(
    Object.entries(stored).filter(([key]) => !Object.hasOwn(patch, key)),
  );
  const revival = reviveStoredDateProps(schema, untouched);
  if (revival.kind === "revived") return { ...revival.props, ...patch };
  const issue = rewrittenStoredDateIssue(revival.path);
  const location =
    context.id === undefined ? context.kind : `${context.kind}/${context.id}`;
  throw new ValidationError(
    `Invalid ${context.entityType} props for ${location}: ${issue.path}: ${issue.message}`,
    {
      entityType: context.entityType,
      kind: context.kind,
      operation: context.operation,
      ...(context.id === undefined ? {} : { id: context.id }),
      issues: [issue],
    },
    {
      suggestion:
        "Make the .overwrite() keep a value it has already produced, or state the date property in this write.",
    },
  );
}
