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
