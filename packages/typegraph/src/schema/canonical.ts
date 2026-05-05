/**
 * Canonical-form helpers for deterministic schema serialization.
 *
 * Used by both content-hashing (`computeSchemaHash`) and structural diffing
 * (`computeSchemaDiff`) to ensure that semantically-equivalent objects with
 * differently-ordered keys produce identical canonical strings.
 */

/**
 * `JSON.stringify` replacer that sorts object keys recursively.
 *
 * Apply via `JSON.stringify(value, sortedReplacer)` to obtain output in
 * which sibling keys at every depth appear in lexicographic order.
 *
 * Arrays are passed through unchanged — array order is semantically
 * meaningful and must not be normalized.
 */
export function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
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
