/**
 * What a write that re-validates a stored row persists: the one owner of the
 * rule every such write applies.
 *
 * The store persists a kind schema's OUTPUT. A write that leaves a row behind
 * an existing one — `update`, `upsertById` over a live or deleted row,
 * `updateWhere`, `compareAndSet`, the bulk updates, an edge's `validTo` end —
 * still validates the row it leaves as a whole: the caller's patch merged over
 * the stored props (their date text revived, `reviveStoredDateProps`) is
 * parsed through the complete kind schema, so constraints, refinements and
 * cross-field checks see every property, a `.default()` added since the row
 * was written is filled, and a schema tightened since then is enforced.
 *
 * What it persists is not that parse's output for every property:
 *
 *  - a property the write STATES ({@link statedPropertyKeys}: an own key of
 *    the patch, whatever its value, `undefined` included) is stored as the
 *    schema makes it, exactly as a create stores it — its transform,
 *    `.overwrite()`, `.catch()` fallback, default or coercion applies, and a
 *    stated `undefined` removes an optional property or fills its default;
 *  - every other property the row holds is stored as it was stored. The
 *    parse is a check of it, not a rewrite: a schema step that changes a
 *    value — a non-idempotent transform, a rewriting `.overwrite()`, a
 *    `.catch()` substituting its fallback for a value it refuses — never
 *    reaches a value the caller did not touch. That includes a property the
 *    schema does not declare (a key the schema no longer has): the row keeps
 *    it, as it keeps every untouched value;
 *  - a property the row does not hold and the write does not state is stored
 *    as the schema makes it — a newly added `.default()` is filled, because
 *    there is no stored value to keep.
 *
 * "Stated" is decided at top-level key granularity: a nested object or array
 * property is touched as a whole, so a patch of `address` stores the schema's
 * output for the whole object, and a patch that does not name it keeps every
 * byte of it. A value an object-level `.overwrite()` or refinement derives
 * from other properties is a property like any other: it is recomputed when
 * the write states it, and otherwise keeps its stored value, even when the
 * write states the property it was derived from.
 *
 * A document that carries props in their stored form — an interchange
 * document `exportGraph` wrote, a graph merge's planned write — states
 * nothing: every property it carries is stored as it carries it, after the
 * same whole-object validation ({@link storedFormProps} marks such props for
 * the store's write paths).
 *
 * When the parse fails at a property the write does not state, and that
 * property's stored value is refused by its own schema alone, the write is
 * refused with a typed issue ({@link STORED_PROPERTY_INVALID_CODE}) naming the
 * property: its stored value is not valid input to its own schema (a
 * type-changing transform, a constraint tightened since the row was written,
 * an undeclared key under a `.strict()` schema). A failure the property's own
 * schema does not explain — a cross-field refinement — is reported as Zod
 * reports it.
 *
 * Uniqueness keys, index and sidecar values, history and the coalescing
 * dirty check are all derived from the persisted props this returns, so an
 * untouched value cannot change a claim or a sidecar.
 */
import { type z } from "zod";

import { objectSchemaShape } from "../core/kind-schema";
import {
  STORED_PROPERTY_INVALID_CODE,
  ValidationError,
  type ValidationIssue,
} from "../errors";
import {
  unstorableDateIssue,
  validateProps,
  type ValidationContext,
  zodIssueToValidationIssue,
} from "../errors/validation";
import { hasOwnKey } from "../utils/object";
import { reviveStoredDateProps } from "./stored-date-revival";

/**
 * The properties a write states: every own key of its patch, whatever its
 * value. A key set to `undefined` is stated (it removes an optional property
 * or fills its default); a key the patch does not carry is not.
 */
function statedPropertyKeys(
  stated: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  return new Set(Object.keys(stated));
}

/** A re-validating write's outcome, before any caller reports it. */
export type RevalidatedWrite =
  | Readonly<{
      success: true;
      /** The props the write stores. */
      persisted: Record<string, unknown>;
      /** The schema's output for the whole after-image. */
      parsed: Record<string, unknown>;
    }>
  | Readonly<{
      success: false;
      error: z.ZodError;
      /** Unstated properties whose stored value their own schema refuses. */
      invalidStoredProperties: readonly string[];
    }>;

/** Whether `props` holds a stored value for `key` (an `undefined` is none). */
function holdsStoredValue(
  props: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return hasOwnKey(props, key) && props[key] !== undefined;
}

/**
 * The props a re-validating write persists: the schema's output for every
 * stated property and every property `retained` holds no value for, and the
 * retained value for every other property — declared or not.
 */
function persistedProps(
  parsed: Readonly<Record<string, unknown>>,
  retained: Readonly<Record<string, unknown>>,
  stated: ReadonlySet<string>,
): Record<string, unknown> {
  const keeps = (key: string) =>
    !stated.has(key) && holdsStoredValue(retained, key);
  const fromParse = Object.entries(parsed).map(([key, value]) =>
    keeps(key) ? ([key, retained[key]] as const) : ([key, value] as const),
  );
  const onlyRetained = Object.entries(retained).filter(
    ([key]) => keeps(key) && !hasOwnKey(parsed, key),
  );
  // `Object.fromEntries` defines own data properties, so a stored
  // `__proto__` key stays a property rather than reaching the setter.
  return Object.fromEntries([...fromParse, ...onlyRetained]);
}

/**
 * The top-level properties a Zod issue is about: the head of its path, or the
 * keys a `.strict()` object refuses at its root. None for an object-level
 * issue without a path.
 */
function issueProperties(
  issue: z.ZodError["issues"][number],
): readonly string[] {
  if (issue.code === "unrecognized_keys" && issue.path.length === 0) {
    return issue.keys;
  }
  const [head] = issue.path;
  return typeof head === "string" ? [head] : [];
}

/**
 * The unstated properties a failed parse reports whose retained value their
 * own declared schema refuses on its own — or which the schema does not
 * declare at all, where it refuses unknown keys.
 */
function invalidStoredPropertiesOf(
  schema: z.ZodType,
  error: z.ZodError,
  retained: Readonly<Record<string, unknown>>,
  stated: ReadonlySet<string>,
): readonly string[] {
  const shape = objectSchemaShape(schema) ?? {};
  const reported = error.issues.flatMap((issue) => issueProperties(issue));
  return [...new Set(reported)].filter((key) => {
    if (stated.has(key) || !hasOwnKey(retained, key)) return false;
    const propertySchema = hasOwnKey(shape, key) ? shape[key] : undefined;
    return !propertySchema?.safeParse(retained[key]).success;
  });
}

/**
 * Re-validates the after-image `{...retained, ...stated}` through `schema`
 * and returns what the write persists. `retained` is in stored form — the
 * row's props, or a stored-form document — and is revived before the parse;
 * `stated` is the caller's patch in input form.
 */
export function revalidateWrite(
  schema: z.ZodType,
  retained: Readonly<Record<string, unknown>>,
  stated: Readonly<Record<string, unknown>>,
): RevalidatedWrite {
  const revived = reviveStoredDateProps(schema, { ...retained });
  const statedKeys = statedPropertyKeys(stated);
  const result = schema.safeParse({ ...revived, ...stated });
  if (!result.success) {
    return {
      success: false,
      error: result.error,
      invalidStoredProperties: invalidStoredPropertiesOf(
        schema,
        result.error,
        revived,
        statedKeys,
      ),
    };
  }
  const parsed = result.data as Record<string, unknown>;
  return {
    success: true,
    parsed,
    persisted: persistedProps(parsed, revived, statedKeys),
  };
}

function locationOf(context: ValidationContext): string {
  return context.id === undefined ?
      `new ${context.kind}`
    : `${context.kind}/${context.id}`;
}

function refusalDetails(
  context: ValidationContext,
  issues: readonly ValidationIssue[],
) {
  return {
    entityType: context.entityType,
    kind: context.kind,
    operation: context.operation,
    ...(context.id !== undefined && { id: context.id }),
    issues,
  };
}

/**
 * {@link revalidateWrite}, refused with a `ValidationError` when the
 * after-image does not validate or the persisted props hold a `Date` no
 * backend can store. An issue at an unstated property whose stored value its
 * own schema refuses carries {@link STORED_PROPERTY_INVALID_CODE}.
 */
export function validateRevalidatingWrite(
  schema: z.ZodType,
  retained: Readonly<Record<string, unknown>>,
  stated: Readonly<Record<string, unknown>>,
  context: ValidationContext,
): Record<string, unknown> {
  const outcome = revalidateWrite(schema, retained, stated);
  const location = locationOf(context);
  if (outcome.success) {
    const unstorable = unstorableDateIssue(outcome.persisted);
    if (unstorable === undefined) return outcome.persisted;
    throw new ValidationError(
      `Invalid ${context.entityType} props for ${location}: ${unstorable.path}: ${unstorable.message}`,
      refusalDetails(context, [unstorable]),
      {
        suggestion:
          "A Date outside the years 0001 to 9999 cannot be stored as a date on every backend.",
      },
    );
  }
  const invalidStored = new Set(outcome.invalidStoredProperties);
  const storedIssues = [...invalidStored].map((property): ValidationIssue => ({
    path: property,
    message:
      "The stored value is not valid input to its own schema, and the write does not state this property",
    code: STORED_PROPERTY_INVALID_CODE,
  }));
  // The Zod issues the stored-property issues explain are replaced by them:
  // each one every property of which is an invalid stored property.
  const unexplained = outcome.error.issues.filter((issue) => {
    const properties = issueProperties(issue);
    return (
      properties.length === 0 ||
      !properties.every((property) => invalidStored.has(property))
    );
  });
  const otherIssues = unexplained.map((issue) =>
    zodIssueToValidationIssue(issue),
  );
  if (storedIssues.length === 0) {
    throw new ValidationError(
      `Invalid ${context.entityType} props for ${location}: ${outcome.error.message}`,
      refusalDetails(context, otherIssues),
      { cause: outcome.error },
    );
  }
  const named = [...invalidStored].map((property) => `"${property}"`);
  throw new ValidationError(
    `Invalid ${context.entityType} props for ${location}: the stored value of ${named.join(", ")} is not valid input to its own schema`,
    refusalDetails(context, [...storedIssues, ...otherIssues]),
    {
      cause: outcome.error,
      suggestion: `The write re-validates the whole row but does not state ${named.join(", ")}. State a valid value for each, or repair the stored rows (validateStore reports them).`,
    },
  );
}

/** Props objects whose values are in stored form ({@link storedFormProps}). */
const STORED_FORM_PROPS = new WeakSet<object>();

/**
 * `props` — a document's STORED-form props, the bytes a store wrote — marked
 * so the store's write paths re-validate them without restating any: every
 * property it carries is stored as it carries it
 * ({@link validateRevalidatingWrite} with nothing stated). The mark is bound
 * to the returned object; a copy of it is input form again. Internal: a graph
 * merge's apply marks the planned writes it hands the store's collections.
 */
export function storedFormProps(
  props: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const marked = { ...props };
  STORED_FORM_PROPS.add(marked);
  return marked;
}

/** Whether `props` was marked by {@link storedFormProps}. */
function isStoredFormProps(
  props: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return props !== undefined && STORED_FORM_PROPS.has(props);
}

/**
 * A create's props, validated: input-form props as every create validates
 * them (`validateProps`), stored-form props ({@link storedFormProps})
 * re-validated without stating any, so each is stored as carried.
 */
export function validateCreateProps(
  schema: z.ZodType,
  props: Readonly<Record<string, unknown>>,
  context: ValidationContext,
): Record<string, unknown> {
  return isStoredFormProps(props) ?
      validateRevalidatingWrite(schema, props, {}, context)
    : (validateProps(schema, props, context) as Record<string, unknown>);
}

/**
 * The after-image retained and stated parts of a write over `existing`
 * (`undefined` for a create): stored-form props are retained over the row,
 * stating nothing; input-form props are the stated patch.
 */
export function revalidatingWriteParts(
  existing: Readonly<Record<string, unknown>> | undefined,
  input: Readonly<Record<string, unknown>>,
): Readonly<{
  retained: Readonly<Record<string, unknown>>;
  stated: Readonly<Record<string, unknown>>;
}> {
  if (isStoredFormProps(input)) {
    return { retained: { ...existing, ...input }, stated: {} };
  }
  return { retained: existing ?? {}, stated: input };
}
