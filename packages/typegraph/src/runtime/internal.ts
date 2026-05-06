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
