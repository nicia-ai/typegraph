/**
 * What a uniqueness key needs to know about a kind's fields so that the key
 * of a date does not depend on which form its props arrived in.
 *
 * A uniqueness key is derived from props in two forms. A write derives it from
 * the VALIDATED props it is about to store, where a `z.date()` value is a
 * `Date`. A release, an update's before-image and a resolved-claim lookup
 * derive it from the STORED props a row reads back, where the same value is
 * its ISO text. Keyed as they arrived, the `Date` keyed as its JSON text
 * (quoted) and the stored text keyed raw, so a release named a key the write
 * never claimed and the claim it should have given back stayed held.
 *
 * {@link uniqueKeyFormsFor} answers, for the one key owner
 * (`computeUniqueKey`), whether a field's schema OUTPUT is a date — the query
 * compiler's own field typing ({@link resolveFieldTypeInfo}). Such a field
 * keys as the JSON text of its ISO timestamp in either form. That is the form
 * every create has always written, so claims a create wrote keep their bytes
 * and need no migration.
 *
 * Deliberately NOT normalized, because changing their bytes would break claims
 * already stored: object key order (a backend that normalizes JSON, such as
 * PostgreSQL `jsonb`, returns an object's keys reordered, and a `.default()`
 * object is written in its literal's order, not its shape's), and a `Date` at a
 * position whose output is not only a date — a union with another member,
 * `z.unknown()`, a `.transform()` — whose stored text cannot be told apart
 * from a string.
 */
import { objectSchemaShape } from "../core/kind-schema";
import { resolveFieldTypeInfo } from "../query/schema-introspector";
import { type KindRegistry } from "../registry/kind-registry";

/**
 * How one kind's uniqueness keys read its fields. Obtain it from
 * {@link uniqueKeyFormsFor}; a caller never builds one.
 */
export type UniqueKeyForms = Readonly<{
  /** Whether the field's schema output is a date. */
  isDateField: (field: string) => boolean;
}>;

/** The forms of an unregistered kind: no field is known to be a date. */
const UNDESCRIBED_FORMS: UniqueKeyForms = { isDateField: () => false };

function buildUniqueKeyForms(
  registry: KindRegistry,
  kind: string,
): UniqueKeyForms {
  const kindType = registry.nodeKinds.get(kind);
  const shape =
    kindType === undefined ? undefined : objectSchemaShape(kindType.schema);
  if (shape === undefined) return UNDESCRIBED_FORMS;
  const dateFields = new Map<string, boolean>();
  return {
    isDateField: (field) => {
      const cached = dateFields.get(field);
      if (cached !== undefined) return cached;
      // The one field alone: typing the whole kind would also walk properties
      // no constraint names, and a recursive one never finishes.
      const fieldSchema =
        Object.hasOwn(shape, field) ? shape[field] : undefined;
      const isDate =
        fieldSchema !== undefined &&
        resolveFieldTypeInfo(fieldSchema).valueType === "date";
      dateFields.set(field, isDate);
      return isDate;
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
