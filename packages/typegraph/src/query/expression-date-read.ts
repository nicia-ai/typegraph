/**
 * The date facts a query expression, or a relation column built from one,
 * carries for its result decode.
 *
 * They live under one module-private symbol rather than as string keys of the
 * expression: a structured field expression is also a proxy over its schema's
 * nested fields, and every string key an expression owns is a name a schema
 * field can no longer be reached by. A symbol key is invisible to that
 * namespace, survives the spreads and rest copies the builders make, and stays
 * off the public `DatabaseExpression` type.
 */
import {
  sharedStoredReadPlan,
  type StoredReadPlan,
} from "../store/stored-date-revival";
import { hasOwnKey } from "../utils/object";

/** @internal What a result decode needs to know about the dates it yields. */
export type ExpressionDateRead = Readonly<{
  /**
   * The date positions under a structured (array or object) property the
   * expression reads, from the property's schema typing: its result decodes
   * them as every other read does (`decodeStoredValue`). A scalar date decodes
   * by `valueType` alone.
   */
  readPlan?: StoredReadPlan;
  /**
   * `"stated"` when every date the expression yields is one the caller stated
   * — a date literal or parameter, or a composition of only those — rather
   * than stored property text. For a collection of scalars it describes the
   * elements. The result decodes it with the stated-date leaf
   * (`decodeExpressionDate`); any other date decodes with the stored-text leaf.
   */
  dateOrigin?: "stated";
  /** The fields of each collected record whose dates the caller stated. */
  elementDateOrigins?: Readonly<Record<string, "stated">>;
}>;

const EXPRESSION_DATE_READ = Symbol("typegraph.expressionDateRead");

type DateReadCarrier = Readonly<{
  [EXPRESSION_DATE_READ]: ExpressionDateRead;
}>;

/**
 * @internal The origin `read` gives the collected record field `name`: an
 * own-key lookup, because a field name is the caller's, and `constructor` or
 * `__proto__` must never read an `Object.prototype` member as an origin.
 */
export function elementDateOriginOf(
  read: ExpressionDateRead,
  name: string,
): "stated" | undefined {
  const origins = read.elementDateOrigins;
  return origins !== undefined && hasOwnKey(origins, name) ?
      origins[name]
    : undefined;
}

/** The date read of a value carrying none: nothing it yields is decoded as a date. */
export const NO_DATE_READ: ExpressionDateRead = Object.freeze({});

function carriesDateRead(value: object): value is DateReadCarrier {
  return EXPRESSION_DATE_READ in value;
}

/**
 * @internal The date facts `carrier` (an expression or a relation column)
 * carries — the one reader of them.
 */
export function dateReadOf(carrier: object): ExpressionDateRead {
  return carriesDateRead(carrier) ?
      carrier[EXPRESSION_DATE_READ]
    : NO_DATE_READ;
}

/** `read` without its absent facts, or {@link NO_DATE_READ} when it has none. */
function compactDateRead(
  read: Readonly<{
    readPlan?: StoredReadPlan | undefined;
    dateOrigin?: "stated" | undefined;
    elementDateOrigins?: Readonly<Record<string, "stated">> | undefined;
  }>,
): ExpressionDateRead {
  const compact: ExpressionDateRead = {
    ...(read.readPlan === undefined ? {} : { readPlan: read.readPlan }),
    ...(read.dateOrigin === undefined ? {} : { dateOrigin: read.dateOrigin }),
    ...(read.elementDateOrigins === undefined ?
      {}
    : { elementDateOrigins: read.elementDateOrigins }),
  };
  return Object.keys(compact).length === 0 ? NO_DATE_READ : compact;
}

/**
 * @internal `value` with `read` as its date facts — the one writer of them. A
 * copy; `value` is never mutated.
 */
export function withDateRead<Value extends object>(
  value: Value,
  read: ExpressionDateRead,
): Value {
  const compact = compactDateRead(read);
  if (compact === NO_DATE_READ && !carriesDateRead(value)) return value;
  return { ...value, [EXPRESSION_DATE_READ]: compact };
}

/**
 * @internal The date facts of a value that may be any one of several — a
 * `coalesce()` or `when()` branch, an operand of a set operation: the read
 * plan positions every one shares (`sharedStoredReadPlan`), and an origin only
 * where every one carries it. A position or origin that only some carry reads
 * as stored text, never decoded under another one's typing, whatever the
 * order of the values.
 */
export function sharedDateRead(
  reads: readonly ExpressionDateRead[],
): ExpressionDateRead {
  const [first, ...rest] = reads;
  if (first === undefined) return NO_DATE_READ;
  let readPlan = first.readPlan;
  for (const read of rest) {
    readPlan =
      readPlan === undefined || read.readPlan === undefined ?
        undefined
      : sharedStoredReadPlan(readPlan, read.readPlan);
  }
  const statedFields = Object.keys(first.elementDateOrigins ?? {}).filter(
    (name) =>
      reads.every((read) => elementDateOriginOf(read, name) === "stated"),
  );
  return compactDateRead({
    readPlan,
    ...(reads.every((read) => read.dateOrigin === "stated") ?
      { dateOrigin: "stated" as const }
    : {}),
    ...(statedFields.length === 0 ?
      {}
    : {
        elementDateOrigins: Object.fromEntries(
          statedFields.map((name) => [name, "stated"] as const),
        ),
      }),
  });
}
