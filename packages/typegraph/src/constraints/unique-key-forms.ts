/**
 * What a uniqueness key needs to know about a kind's fields so that the key
 * of a row does not depend on which form its props arrived in.
 *
 * A uniqueness key is derived from props in two forms. A write derives it from
 * the VALIDATED props it is about to store: a `z.date()` value is a `Date`,
 * and an object is in the order the kind's schema outputs it. A release, an
 * update's before-image, a resolved-claim lookup and a merge derive it from
 * the STORED props a row reads back: the same `Date` is its ISO text, and on a
 * backend whose props column normalizes JSON (PostgreSQL `jsonb`) the same
 * object comes back with its keys reordered. Keyed as they arrive, the two
 * forms of one value produced different bytes, so a release named a key the
 * write never claimed and the claim it should have given back stayed held.
 *
 * {@link uniqueKeyFormsFor} is the kind-level answer the one key owner
 * (`computeUniqueKey`) reads, so every claim, release, probe, lookup and
 * merge signature keys a value the same way whichever form it holds:
 *
 *  - a field whose schema OUTPUT is a date (the query compiler's own field
 *    typing, `schemaIntrospectorFor`) keys as the JSON text of its ISO
 *    timestamp. That is the form every create has always written — a `Date`
 *    stringified through `JSON.stringify` — so the claims a store already holds
 *    keep their bytes and need no migration;
 *  - an object at a position the schema declares a plain object shape keys in
 *    the schema's shape order, which is the order validation outputs it in, so
 *    a reordered stored object keys exactly as the object that was written.
 *
 * Neither rule changes the key of a value a write derives from validated
 * props: a `Date` already stringified to that JSON text, and a validated
 * object is already in shape order.
 *
 * Not recoverable from stored props, and so not covered: the key order of a
 * `z.record()` or of the undeclared keys of a loose object on a backend that
 * reorders JSON (its validated order is the caller's input order, which the
 * store does not keep), and a `Date` at a position whose schema output is not
 * a date — a union with another member, `z.unknown()`, a `.transform()`. The
 * stored text of such a `Date` is indistinguishable from a string.
 */
import { type z } from "zod";

import { objectSchemaShape } from "../core/kind-schema";
import { schemaIntrospectorFor } from "../query/schema-introspector";
import { type KindRegistry } from "../registry/kind-registry";
import { isPlainObject } from "../utils/object";

/**
 * How one kind's uniqueness keys read its fields. Obtain it from
 * {@link uniqueKeyFormsFor}; a caller never builds one.
 */
export type UniqueKeyForms = Readonly<{
  /** Whether the field's schema output is a date. */
  isDateField: (field: string) => boolean;
  /**
   * The field's value with every object the schema declares a plain shape for
   * in that shape's order.
   */
  inOutputOrder: (field: string, value: unknown) => unknown;
}>;

/**
 * The forms of a field the kind's schema does not describe (an unregistered
 * kind): every value keys as it is, which is what a key has always been.
 */
const UNDESCRIBED_FORMS: UniqueKeyForms = {
  isDateField: () => false,
  inOutputOrder: (_field, value) => value,
};

/** Schema wrappers whose output is their inner schema's output. */
const OUTPUT_TRANSPARENT_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "catch",
  "readonly",
  "nonoptional",
]);

type OutputSchemaDef = Readonly<{
  innerType?: z.ZodType;
  out?: z.ZodType;
  element?: z.ZodType;
  valueType?: z.ZodType;
}>;

/**
 * The schema that produces a position's output: wrappers that pass their inner
 * schema's output through are skipped, and a pipe is read at its output side.
 */
function outputSchema(schema: z.ZodType): z.ZodType {
  const def = schema.def as OutputSchemaDef;
  if (
    OUTPUT_TRANSPARENT_WRAPPER_TYPES.has(schema.type) &&
    def.innerType !== undefined
  ) {
    return outputSchema(def.innerType);
  }
  if (schema.type === "pipe" && def.out !== undefined) {
    return outputSchema(def.out);
  }
  return schema;
}

/**
 * `value` with every object at a position `schema` declares a plain shape for
 * rebuilt in that shape's order, its undeclared keys after the declared ones
 * in the order they arrived. Arrays and record values are walked; any other
 * value is returned as is.
 *
 * Walked together with the value rather than compiled ahead: a recursive
 * schema (a shape whose getter returns the schema itself) is finite only
 * along a finite value.
 */
function valueInOutputOrder(schema: z.ZodType, value: unknown): unknown {
  const output = outputSchema(schema);
  const shape = objectSchemaShape(output);
  if (shape !== undefined) {
    if (!isPlainObject(value)) return value;
    const declared = Object.keys(shape)
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => {
        const propertySchema = shape[key];
        return [
          key,
          propertySchema === undefined ?
            value[key]
          : valueInOutputOrder(propertySchema, value[key]),
        ] as const;
      });
    const undeclared = Object.keys(value)
      .filter((key) => !Object.hasOwn(shape, key))
      .map((key) => [key, value[key]] as const);
    // `Object.fromEntries` defines own data properties, so a `__proto__` key
    // stays a property rather than reaching the setter.
    return Object.fromEntries([...declared, ...undeclared]);
  }
  const def = output.def as OutputSchemaDef;
  if (output.type === "array" && def.element !== undefined) {
    const element = def.element;
    return Array.isArray(value) ?
        value.map((item: unknown) => valueInOutputOrder(element, item))
      : value;
  }
  if (output.type === "record" && def.valueType !== undefined) {
    const recordValue = def.valueType;
    return isPlainObject(value) ?
        Object.fromEntries(
          Object.entries(value).map(
            ([key, item]) =>
              [key, valueInOutputOrder(recordValue, item)] as const,
          ),
        )
      : value;
  }
  return value;
}

function buildUniqueKeyForms(
  registry: KindRegistry,
  kind: string,
): UniqueKeyForms {
  const kindType = registry.nodeKinds.get(kind);
  if (kindType === undefined) return UNDESCRIBED_FORMS;
  const shape = objectSchemaShape(kindType.schema);
  const introspector = schemaIntrospectorFor(registry);
  const dateFields = new Map<string, boolean>();
  return {
    isDateField: (field) => {
      const cached = dateFields.get(field);
      if (cached !== undefined) return cached;
      const isDate =
        introspector.getFieldTypeInfo(kind, field)?.valueType === "date";
      dateFields.set(field, isDate);
      return isDate;
    },
    inOutputOrder: (field, value) => {
      const fieldSchema =
        shape !== undefined && Object.hasOwn(shape, field) ?
          shape[field]
        : undefined;
      return fieldSchema === undefined ? value : (
          valueInOutputOrder(fieldSchema, value)
        );
    },
  };
}

const formsByRegistry = new WeakMap<
  KindRegistry,
  Map<string, UniqueKeyForms>
>();

/**
 * How a node kind's uniqueness keys read its fields, built once per registry
 * and kind. Every derivation of a node uniqueness key passes the forms of the
 * kind whose row the props belong to.
 */
export function uniqueKeyFormsFor(
  registry: KindRegistry,
  kind: string,
): UniqueKeyForms {
  const byKind =
    formsByRegistry.get(registry) ?? new Map<string, UniqueKeyForms>();
  formsByRegistry.set(registry, byKind);
  const cached = byKind.get(kind);
  if (cached !== undefined) return cached;
  const forms = buildUniqueKeyForms(registry, kind);
  byKind.set(kind, forms);
  return forms;
}
