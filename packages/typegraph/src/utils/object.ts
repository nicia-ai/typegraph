/**
 * Plain-object predicate. Excludes class instances (Date, Map, Set,
 * RegExp, Buffer, …) and arrays. Used wherever the caller needs to
 * distinguish a literal `{}` from anything else — e.g. JSON-value
 * validation and runtime-document structural checks.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Builds an object dropping any keys whose value is `undefined`.
 *
 * Lets callers construct discriminated-union members and `defineNode` /
 * `defineEdge` option objects without tripping over
 * `exactOptionalPropertyTypes: true` — which forbids setting `optional:
 * undefined` on a type that declares `optional?: boolean`. The cast keeps
 * call sites readable; this helper is the single typed seam.
 */
export function compactUndefined<T extends object>(value: {
  [K in keyof T]: T[K] | undefined;
}): T {
  const result: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (fieldValue !== undefined) result[key] = fieldValue;
  }
  return result as T;
}

/**
 * Recursively `Object.freeze` every plain object / array reachable from
 * `value`. Already-frozen branches are skipped. Returns the input for
 * convenient chaining; the freeze is in-place.
 *
 * Class instances and other non-plain values are left alone — only their
 * containers freeze.
 */
export function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeDeep(nested);
  }
  return Object.freeze(value);
}
