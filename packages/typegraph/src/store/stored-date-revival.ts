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
 *    with no `.overwrite()` check on the schema under those wrappers (one
 *    rewrites its value on every parse, so it would rewrite the revived,
 *    untouched value). An `.overwrite()` on a wrapper is not consulted: the
 *    revived value is parsed through it, so a rewriting one changes an
 *    untouched date on every update. That re-parse of values the caller did
 *    not touch is the deferred update-validation design, not this one;
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
 * revives before parsing it through the kind's schema, and a graph merge's
 * planned writes, which carry the props the branch read.
 *
 * The opposite direction — a validated `Date` to the stored text — is
 * {@link encodeStoredDatesFor}, for a write that hands the backend JSON
 * rather than props for the backend to serialize (the set-update patch and
 * the `compareAndSet` expectation). Both encode a `Date` with the one encoder
 * every stored text comes from, `dateInstantText`.
 *
 * Reads ask a different question — not "does this position's input accept
 * only a `Date`" but "is this position's OUTPUT a `Date`" — and the query
 * compiler's field typing already answers it: a `FieldTypeInfo` whose
 * `valueType` is `"date"` (a `z.date()`, a `z.coerce.date()`, a pipe whose
 * output is one, under the same wrappers, inside a nested object, array or
 * record). {@link storedReadPlan} compiles that typing once into the list of
 * positions that lead to a date, and every read decoder applies it through
 * {@link decodeStoredValue}, whose one leaf is {@link decodeStoredDate}: only
 * portable timestamp text becomes a `Date`; a `Date` a driver already decoded
 * passes through; anything else — non-canonical text, a number, garbage — is
 * returned exactly as stored, so a read never produces an `Invalid Date`. A
 * mixed union (`z.union([z.date(), z.string()])`), a tuple and a
 * `.transform()` type as `unknown` there, so they still read as text. A read
 * applies no parse, transform or refinement: user code never runs on a read.
 *
 * Whole rows reach callers through `rowToNode` / `rowToEdge` and the query
 * compiler's selectable rows, which take a {@link StoredPropsReader} resolved
 * from the registry ({@link storedPropsReaders}); a graph whose kinds hold no
 * date position gets the reader that returns the props it is handed.
 */
import { type z } from "zod";

import { objectSchemaShape } from "../core/kind-schema";
import {
  type FieldTypeInfo,
  kindShapeTypeInfo,
} from "../query/schema-introspector";
import { type KindRegistry } from "../registry/kind-registry";
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
  // an object or array holding it — would rewrite a revived stored value, so
  // nothing at or below it is revived and the re-parse refuses as before.
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
 * where {@link reviveStoredDates} revives the stored text as that `Date` when
 * the row is parsed through its schema again. Anywhere else (a union, a
 * record, `z.any()`, an `.overwrite()`) the stored text would be re-parsed as
 * a string — whatever a read returns there — so the row would hold a value the
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

/**
 * A stored value at a position whose schema output is a `Date`, as a read
 * returns it: portable timestamp text ({@link isPortableTimestamp}) becomes the
 * `Date` it encodes, a `Date` (a driver's `timestamptz`, or a custom backend
 * that already decoded) passes through, and every other value is returned
 * exactly as stored — never an `Invalid Date`. The single leaf of every read
 * decoder: row props, selected fields, projections and aggregates.
 */
export function decodeStoredDate(value: unknown): unknown {
  return typeof value === "string" && isPortableTimestamp(value) ?
      new Date(value)
    : value;
}

/**
 * A date a query expression yields that the caller stated — a date literal or
 * parameter — rather than stored property text, as a read returns it: a valid
 * `Date` passes through, and text or a number the engine returns becomes the
 * `Date` it names whenever that is a valid instant, so a stated date outside
 * the portable years (`0000`, `+010000`) comes back as the `Date` stated.
 * Anything else is returned as is — never an `Invalid Date`. Which leaf a
 * query result uses is decided by the expression's origin
 * (`decodeExpressionDate`), never by a terminal.
 */
export function decodeStatedDate(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (typeof value !== "string" && typeof value !== "number") return value;
  const decoded = new Date(value);
  return Number.isNaN(decoded.getTime()) ? value : decoded;
}

/**
 * The positions under a value that lead to a date, compiled from its field
 * typing: the date itself, the declared keys of an object that lead to one,
 * the element of an array, or the value of a record. A value with no date
 * position has no plan.
 */
export type StoredReadPlan =
  | Readonly<{ form: "date" }>
  | Readonly<{
      form: "object";
      keys: readonly (readonly [key: string, plan: StoredReadPlan])[];
    }>
  | Readonly<{ form: "array"; element: StoredReadPlan }>
  | Readonly<{ form: "record"; value: StoredReadPlan }>;

const DATE_PLAN: StoredReadPlan = Object.freeze({ form: "date" });

function compileStoredReadPlan(
  info: FieldTypeInfo,
): StoredReadPlan | undefined {
  switch (info.valueType) {
    case "date": {
      return DATE_PLAN;
    }
    case "array": {
      const element =
        info.elementTypeInfo === undefined ?
          undefined
        : storedReadPlan(info.elementTypeInfo);
      return element === undefined ? undefined : (
          Object.freeze({ form: "array", element })
        );
    }
    case "object": {
      if (info.shape !== undefined) return shapeReadPlan(info.shape);
      const value =
        info.recordValueType === undefined ?
          undefined
        : storedReadPlan(info.recordValueType);
      return value === undefined ? undefined : (
          Object.freeze({ form: "record", value })
        );
    }
    case "boolean":
    case "embedding":
    case "number":
    case "string":
    case "unknown": {
      return undefined;
    }
  }
}

function shapeReadPlan(
  shape: Readonly<Record<string, FieldTypeInfo>>,
): StoredReadPlan | undefined {
  const keys = Object.entries(shape).flatMap(([key, info]) => {
    const plan = storedReadPlan(info);
    return plan === undefined ? [] : [[key, plan] as const];
  });
  return keys.length === 0 ?
      undefined
    : Object.freeze({ form: "object", keys: Object.freeze(keys) });
}

/** `FieldTypeInfo` objects are built once per kind and cached, so a plan is too. */
const readPlanCache = new WeakMap<
  FieldTypeInfo,
  Readonly<{ plan: StoredReadPlan | undefined }>
>();

/**
 * The read plan of a position typed `info`, or `undefined` when nothing at
 * or below it is typed as a date. Compiled once per `FieldTypeInfo`.
 */
export function storedReadPlan(
  info: FieldTypeInfo,
): StoredReadPlan | undefined {
  const cached = readPlanCache.get(info);
  if (cached !== undefined) return cached.plan;
  const plan = compileStoredReadPlan(info);
  readPlanCache.set(info, { plan });
  return plan;
}

function decodeObjectPositions(
  keys: readonly (readonly [string, StoredReadPlan])[],
  value: Record<string, unknown>,
): Record<string, unknown> {
  const changed: (readonly [string, unknown])[] = [];
  for (const [key, plan] of keys) {
    if (!Object.hasOwn(value, key)) continue;
    const element = value[key];
    const next = decodeStoredValue(plan, element);
    if (next !== element) changed.push([key, next]);
  }
  if (changed.length === 0) return value;
  // Copied, never mutated: `value` may be an object a driver or a custom
  // backend handed over. `Object.fromEntries` and the spread define own data
  // properties, so a stored `__proto__` key stays a property rather than
  // reaching the setter, and every key keeps its stored position.
  return { ...value, ...Object.fromEntries(changed) };
}

function decodeRecordPositions(
  plan: StoredReadPlan,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return decodeObjectPositions(
    Object.keys(value).map((key) => [key, plan] as const),
    value,
  );
}

/**
 * `value`, as stored at a position whose read plan is `plan`, with every
 * date position decoded ({@link decodeStoredDate}). Returns `value` itself
 * when there is no plan or nothing changed, and never mutates it.
 */
export function decodeStoredValue(
  plan: StoredReadPlan | undefined,
  value: unknown,
): unknown {
  if (plan === undefined) return value;
  switch (plan.form) {
    case "date": {
      return decodeStoredDate(value);
    }
    case "array": {
      if (!Array.isArray(value)) return value;
      const items = value as readonly unknown[];
      const decoded = items.map((item) =>
        decodeStoredValue(plan.element, item),
      );
      return decoded.some((item, index) => item !== items[index]) ? decoded : (
          value
        );
    }
    case "object": {
      return isPlainObject(value) ?
          decodeObjectPositions(plan.keys, value)
        : value;
    }
    case "record": {
      return isPlainObject(value) ?
          decodeRecordPositions(plan.value, value)
        : value;
    }
  }
}

/**
 * A row's parsed props, as a read returns them, for the row's kind. Never
 * mutates `props`; returns it itself when the kind has no date position.
 */
export type StoredPropsReader = (
  kind: string,
  props: Record<string, unknown>,
) => Record<string, unknown>;

/** The node and edge readers of one registry. */
export type StoredPropsReaders = Readonly<{
  node: StoredPropsReader;
  edge: StoredPropsReader;
}>;

/** The reader of a graph with no date position: the props as stored. */
export const passStoredProps: StoredPropsReader = (_kind, props) => props;

function kindReadPlans(
  kinds: ReadonlyMap<string, Readonly<{ schema: z.ZodType }>>,
): ReadonlyMap<string, StoredReadPlan> {
  const plans = new Map<string, StoredReadPlan>();
  for (const [kind, type] of kinds) {
    const shape = kindShapeTypeInfo(type.schema);
    const plan = shape === undefined ? undefined : shapeReadPlan(shape);
    if (plan !== undefined) plans.set(kind, plan);
  }
  return plans;
}

function readerFor(
  plans: ReadonlyMap<string, StoredReadPlan>,
): StoredPropsReader {
  if (plans.size === 0) return passStoredProps;
  return (kind, props) => {
    const plan = plans.get(kind);
    return plan === undefined ? props : (
        (decodeStoredValue(plan, props) as Record<string, unknown>)
      );
  };
}

const registryReaders = new WeakMap<KindRegistry, StoredPropsReaders>();

/**
 * The node and edge props readers of a registry, compiled once per registry.
 * A kind the registry does not hold, and every kind of a graph with no date
 * position, reads its props as stored.
 */
export function storedPropsReaders(registry: KindRegistry): StoredPropsReaders {
  const cached = registryReaders.get(registry);
  if (cached !== undefined) return cached;
  const readers: StoredPropsReaders = Object.freeze({
    node: readerFor(kindReadPlans(registry.nodeKinds)),
    edge: readerFor(kindReadPlans(registry.edgeKinds)),
  });
  registryReaders.set(registry, readers);
  return readers;
}

/**
 * Props a read returned, back in the form the store persists them: every
 * `Date` a read decoded replaced by the text it was decoded from. A read
 * decodes only portable timestamp text, which `Date.prototype.toJSON` writes
 * back byte for byte, so this is the exact inverse of
 * {@link decodeStoredValue} for a read's own output. For a consumer whose
 * contract is the stored form — graph merge compares, fingerprints and
 * re-writes a committed row's props as JSON — and that reads the row through
 * the public read surface. Returns `props` itself when it holds no `Date`.
 */
export function storedFormOfReadProps(
  props: Record<string, unknown>,
): Record<string, unknown> {
  return encodeStoredDates(props) as Record<string, unknown>;
}
