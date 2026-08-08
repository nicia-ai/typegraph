/**
 * Canonical-form helpers for deterministic schema serialization.
 *
 * Used by both content-hashing (`computeSchemaHash`) and structural diffing
 * (`computeSchemaDiff`) to ensure that semantically-equivalent objects with
 * differently-ordered keys produce identical canonical strings.
 */

import { createDataKeyedBag } from "../utils/object";

/**
 * `JSON.stringify` replacer that sorts object keys recursively.
 *
 * Apply via `JSON.stringify(value, sortedReplacer)` to obtain output in
 * which sibling keys at every depth appear in lexicographic order.
 *
 * Arrays are passed through unchanged — array order is semantically
 * meaningful and must not be normalized.
 *
 * The re-keyed object is null-prototype ({@link createDataKeyedBag}): every key
 * here is DATA — a kind name, a property name, a JSON-Schema keyword — and
 * `sorted["__proto__"] = value` on a `{}` literal reaches the prototype setter
 * instead of creating an entry. The key would then be missing from the
 * canonical string, so a schema declaring such a property would hash and
 * compare equal to one that does not: `computeSchemaHash` would report
 * "unchanged" and `computeSchemaDiff` would find no change to migrate. Output
 * is byte-identical for every value without such a key, so no existing
 * schema's hash moves.
 */
export function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const sorted = createDataKeyedBag<unknown>();
    for (const key of Object.keys(value).toSorted()) {
      sorted[key] = (value as Record<string, unknown>)[key];
    }
    return sorted;
  }
  return value;
}

/**
 * Compare two values for canonical-form equality.
 *
 * Returns `true` when both values produce identical JSON under `sortedReplacer`
 * — i.e., they have the same JSON structure regardless of object key order.
 * Used by diff machinery to detect semantic changes in JSON-shaped fields.
 *
 * Note: callers must handle `undefined` themselves — `JSON.stringify(undefined)`
 * returns `undefined`, so two `undefined` inputs would compare equal here, which
 * may or may not be the desired semantics depending on context.
 */
export function canonicalEqual(a: unknown, b: unknown): boolean {
  return (
    JSON.stringify(a, sortedReplacer) === JSON.stringify(b, sortedReplacer)
  );
}
