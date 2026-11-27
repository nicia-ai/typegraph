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
import { canonicalEqual, canonicalJson } from "../schema/canonical";
import { storedJsonText } from "../utils/date";
import { hasOwnKey } from "../utils/object";
import { reviveStoredDateProps } from "./stored-date-revival";

/**
 * Where a re-validating write's retained props come from: a stored row, which
 * holds only values the store wrote, or a stored-form document (an interchange
 * document, a merge plan), whose values are meant to be what a store wrote
 * but come from outside this store.
 */
export type RetainedForm = "row" | "document";

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
      /** The after-image does not parse. */
      reason: "invalid";
      error: z.ZodError;
      /** Unstated properties whose stored value their own schema refuses. */
      invalidStoredProperties: readonly string[];
    }>
  | Readonly<{
      success: false;
      /**
       * The after-image parses, but only with these unstated values rewritten
       * by the schema, and the object's own refinements checked the rewritten
       * values rather than the stored ones the write keeps.
       */
      reason: "rewritten";
      rewrittenStoredProperties: readonly string[];
    }>;

/** Whether `props` holds a stored value for `key` (an `undefined` is none). */
function holdsStoredValue(
  props: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return hasOwnKey(props, key) && props[key] !== undefined;
}

/**
 * A value as the text a backend stores for it (`storedJsonText`, a `Date` by
 * the instant it holds), with object keys sorted, or `undefined` for none.
 */
function storedText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return canonicalJson(JSON.parse(storedJsonText(value)));
}

/**
 * A copy of the retained values for the parse to read, so a schema step that
 * mutates its argument in place cannot reach the value the write keeps. A value
 * `structuredClone` cannot copy (a class instance with a function property)
 * is read as retained.
 */
function parseCopy(
  revived: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(revived).map(([key, value]) => {
      try {
        return [key, structuredClone(value)] as const;
      } catch {
        return [key, value] as const;
      }
    }),
  );
}

/** The JSON type a value is stored as; a `Date` is stored as text. */
function storedJsonType(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) return "string";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

type UnstatedValue =
  /** The parse left it as stored (up to object key order): its output. */
  | Readonly<{ kind: "unchanged"; value: unknown }>
  /** The parse rewrote it: the stored value, kept. */
  | Readonly<{ kind: "kept"; value: unknown }>
  /** A document value the schema changed the JSON type of: its output. */
  | Readonly<{ kind: "parsed"; value: unknown }>;

/**
 * What a write stores for an unstated property it retains a value for.
 *
 * The parse's output is stored when it equals the retained value up to object
 * key order (`canonicalJson`): the same value, in the schema's key order, so a
 * uniqueness claim over an object property is keyed as a create keys it
 * whatever key order the backend returned the row in. Otherwise the schema
 * rewrote the value and the retained one is kept — except a document value
 * whose stored JSON type the schema changes (`"7"` under `z.coerce.number()`):
 * no store wrote that value, so it is input, and the parsed value is stored.
 */
function unstatedValue(
  parsed: unknown,
  retained: unknown,
  form: RetainedForm,
): UnstatedValue {
  if (storedText(parsed) === storedText(retained)) {
    return { kind: "unchanged", value: parsed };
  }
  if (
    form === "document" &&
    parsed !== undefined &&
    storedJsonType(parsed) !== storedJsonType(retained)
  ) {
    return { kind: "parsed", value: parsed };
  }
  return { kind: "kept", value: retained };
}

/**
 * The props a re-validating write persists: the schema's output for every
 * stated property and every property `retained` holds no value for, and for
 * every other property — declared or not — its {@link unstatedValue}. Also
 * returns the unstated properties whose stored value was kept over a rewrite.
 */
function persistedProps(
  parsed: Readonly<Record<string, unknown>>,
  retained: Readonly<Record<string, unknown>>,
  stated: ReadonlySet<string>,
  form: RetainedForm,
): Readonly<{ persisted: Record<string, unknown>; rewritten: string[] }> {
  const rewritten: string[] = [];
  const keeps = (key: string) =>
    !stated.has(key) && holdsStoredValue(retained, key);
  const valueOf = (key: string, value: unknown): unknown => {
    if (!keeps(key)) return value;
    const unstated = unstatedValue(value, retained[key], form);
    if (unstated.kind === "kept") rewritten.push(key);
    return unstated.value;
  };
  const fromParse = Object.entries(parsed).map(
    ([key, value]) => [key, valueOf(key, value)] as const,
  );
  const onlyRetained = Object.entries(retained).filter(
    ([key]) => keeps(key) && !hasOwnKey(parsed, key),
  );
  // `Object.fromEntries` defines own data properties, so a stored
  // `__proto__` key stays a property rather than reaching the setter.
  return {
    persisted: Object.fromEntries([...fromParse, ...onlyRetained]),
    rewritten,
  };
}

/**
 * Whether an object schema carries a check other than `.overwrite()` — a
 * `.refine()` or `.superRefine()` — which validates the object as parsed.
 */
function hasObjectRefinement(schema: z.ZodType): boolean {
  const checks =
    (
      schema.def as Readonly<{
        checks?: readonly Readonly<{
          _zod: Readonly<{ def: Readonly<{ check: string }> }>;
        }>[];
      }>
    ).checks ?? [];
  return checks.some((check) => check._zod.def.check !== "overwrite");
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
 * own declared schema refuses on its own, and the undeclared ones a
 * `.strict()` object refuses as unknown keys. An undeclared key another issue
 * names (a refinement's path) is not itself refused.
 */
function invalidStoredPropertiesOf(
  schema: z.ZodType,
  error: z.ZodError,
  retained: Readonly<Record<string, unknown>>,
  stated: ReadonlySet<string>,
): readonly string[] {
  const shape = objectSchemaShape(schema) ?? {};
  const unstated = (key: string) =>
    !stated.has(key) && hasOwnKey(retained, key);
  const refusedUnknown = error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" && issue.path.length === 0 ?
      issue.keys
    : [],
  );
  const refusedDeclared = error.issues
    .flatMap((issue) => issueProperties(issue))
    .filter((key) => {
      const propertySchema = hasOwnKey(shape, key) ? shape[key] : undefined;
      return (
        propertySchema !== undefined &&
        !propertySchema.safeParse(retained[key]).success
      );
    });
  return [...new Set([...refusedUnknown, ...refusedDeclared])].filter((key) =>
    unstated(key),
  );
}

/**
 * Re-validates the after-image `{...retained, ...stated}` through `schema`
 * and returns what the write persists. `retained` is in stored form — the
 * row's props, or a stored-form document (`form`) — and is revived before
 * the parse; `stated` is the caller's patch in input form. The parse reads a
 * copy of the retained values, so a schema step that mutates its argument in
 * place cannot reach the value the write keeps.
 */
export function revalidateWrite(
  schema: z.ZodType,
  retained: Readonly<Record<string, unknown>>,
  stated: Readonly<Record<string, unknown>>,
  form: RetainedForm = "row",
): RevalidatedWrite {
  const revived = reviveStoredDateProps(schema, { ...retained });
  const statedKeys = statedPropertyKeys(stated);
  const result = schema.safeParse({ ...parseCopy(revived), ...stated });
  if (!result.success) {
    return {
      success: false,
      reason: "invalid",
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
  const { persisted, rewritten } = persistedProps(
    parsed,
    revived,
    statedKeys,
    form,
  );
  if (rewritten.length > 0 && hasObjectRefinement(schema)) {
    return {
      success: false,
      reason: "rewritten",
      rewrittenStoredProperties: rewritten,
    };
  }
  return { success: true, parsed, persisted };
}

/**
 * Whether two props objects store the same text: compared as the JSON the
 * backends write (`storedJsonText`, so a `Date` compares by the instant it
 * holds, whatever its own serializer says) with object keys in any order. The
 * one comparison a write makes between what it would store and what is
 * stored: the set update's after-image check and the coalescing dirty checks.
 */
export function storedPropsEqual(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  return canonicalEqual(
    JSON.parse(storedJsonText(left)),
    JSON.parse(storedJsonText(right)),
  );
}

/**
 * A failed {@link revalidateWrite}'s reasons, one line per property, for a
 * caller that reports a string (an import's row error).
 */
export function describeRevalidationFailure(
  outcome: Extract<RevalidatedWrite, { success: false }>,
  formatZodError: (error: z.ZodError) => string,
): string {
  return outcome.reason === "invalid" ?
      formatZodError(outcome.error)
    : outcome.rewrittenStoredProperties
        .map((property) => `${property}: ${REWRITTEN_MESSAGE}`)
        .join("; ");
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

const INVALID_MESSAGE =
  "The stored value is not valid input to its own schema, and the write does not state this property";

const REWRITTEN_MESSAGE =
  "The schema rewrites the stored value, so the object's refinements would check the rewritten value rather than the stored one the write keeps; state this property";

function storedPropertyIssue(
  property: string,
  message: string,
): ValidationIssue {
  return { path: property, message, code: STORED_PROPERTY_INVALID_CODE };
}

function storedPropertyRefusal(
  context: ValidationContext,
  properties: readonly string[],
  issues: readonly ValidationIssue[],
  cause: unknown,
): ValidationError {
  const named = properties.map((property) => `"${property}"`).join(", ");
  return new ValidationError(
    `Invalid ${context.entityType} props for ${locationOf(context)}: the stored value of ${named} cannot be validated as stored`,
    refusalDetails(context, issues),
    {
      cause,
      suggestion: `The write re-validates the whole row but does not state ${named}. State a valid value for each, or repair the stored rows (validateStore reports them).`,
    },
  );
}

/**
 * {@link revalidateWrite}, refused with a `ValidationError` when the
 * after-image does not validate or the persisted props hold a `Date` no
 * backend can store. An unstated property whose stored value its own schema
 * refuses, or whose rewritten value the object's refinements checked instead
 * of the stored one, is reported with {@link STORED_PROPERTY_INVALID_CODE}.
 */
export function validateRevalidatingWrite(
  schema: z.ZodType,
  retained: Readonly<Record<string, unknown>>,
  stated: Readonly<Record<string, unknown>>,
  context: ValidationContext,
  form: RetainedForm = "row",
): Record<string, unknown> {
  const outcome = revalidateWrite(schema, retained, stated, form);
  if (outcome.success) {
    const unstorable = unstorableDateIssue(outcome.persisted);
    if (unstorable === undefined) return outcome.persisted;
    throw new ValidationError(
      `Invalid ${context.entityType} props for ${locationOf(context)}: ${unstorable.path}: ${unstorable.message}`,
      refusalDetails(context, [unstorable]),
      {
        suggestion:
          "A Date outside the years 0001 to 9999 cannot be stored as a date on every backend.",
      },
    );
  }
  if (outcome.reason === "rewritten") {
    const properties = outcome.rewrittenStoredProperties;
    throw storedPropertyRefusal(
      context,
      properties,
      properties.map((property) =>
        storedPropertyIssue(property, REWRITTEN_MESSAGE),
      ),
      undefined,
    );
  }
  const invalidStored = new Set(outcome.invalidStoredProperties);
  if (invalidStored.size === 0) {
    throw new ValidationError(
      `Invalid ${context.entityType} props for ${locationOf(context)}: ${outcome.error.message}`,
      refusalDetails(
        context,
        outcome.error.issues.map((issue) => zodIssueToValidationIssue(issue)),
      ),
      { cause: outcome.error },
    );
  }
  // The Zod issues the stored-property issues explain are replaced by them:
  // each one every property of which is an invalid stored property.
  const unexplained = outcome.error.issues.filter((issue) => {
    const properties = issueProperties(issue);
    return (
      properties.length === 0 ||
      !properties.every((property) => invalidStored.has(property))
    );
  });
  throw storedPropertyRefusal(
    context,
    [...invalidStored],
    [
      ...[...invalidStored].map((property) =>
        storedPropertyIssue(property, INVALID_MESSAGE),
      ),
      ...unexplained.map((issue) => zodIssueToValidationIssue(issue)),
    ],
    outcome.error,
  );
}

/** Props objects whose values are in stored form ({@link storedFormProps}). */
const STORED_FORM_PROPS = new WeakSet<object>();

/**
 * `props` — a document's STORED-form props, the bytes a store wrote — marked
 * so the store's write paths re-validate them without restating any: every
 * property it carries is stored as it carries it
 * ({@link validateRevalidatingWrite} with nothing stated, as a document). The
 * mark is bound to the returned object; a copy of it is input form again.
 * Internal: a graph merge's apply marks the planned writes it hands the
 * store's collections, and an endpoint get-or-create the props it probed with.
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
      validateRevalidatingWrite(schema, props, {}, context, "document")
    : (validateProps(schema, props, context) as Record<string, unknown>);
}

/**
 * The after-image parts of a write over `existing` (`undefined` for a
 * create): stored-form props are retained over the row as a document,
 * stating nothing; input-form props are the stated patch over the row.
 */
export function revalidatingWriteParts(
  existing: Readonly<Record<string, unknown>> | undefined,
  input: Readonly<Record<string, unknown>>,
): Readonly<{
  retained: Readonly<Record<string, unknown>>;
  stated: Readonly<Record<string, unknown>>;
  form: RetainedForm;
}> {
  if (isStoredFormProps(input)) {
    return {
      retained: { ...existing, ...input },
      stated: {},
      form: "document",
    };
  }
  return { retained: existing ?? {}, stated: input, form: "row" };
}
