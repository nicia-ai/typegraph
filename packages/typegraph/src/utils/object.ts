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
 * Own-key membership for a bag whose KEYS ARE DATA — a props record parsed out
 * of a JSON column, a JSON-Schema `properties` map, a serialized-schema kind
 * table. The single owner of that question; every path asking it calls here.
 *
 * `in` is the wrong operator for these bags because it also finds inherited
 * members: `"toString" in {}` is `true`, as are `"constructor"`, `"valueOf"`,
 * `"__proto__"`, and the rest of `Object.prototype`. A bag that does NOT carry
 * the key therefore reads as if it does, and the `bag[key]` read that follows
 * yields the inherited member instead of stored data.
 *
 * Reachable, and not through anything exotic: a schema may DECLARE a field named
 * after a prototype member — `z.object({ toString: z.string() })` is an ordinary
 * schema — and such a field survives validation, storage, and the JSON round-trip
 * as normal data. (`__proto__` is the narrower case: Zod drops an own `__proto__`
 * key and `bag["__proto__"] = value` assigns a prototype rather than creating one,
 * so no validated write produces it — but the unvalidated trusted import writes a
 * caller's bag verbatim, and JSON parses `__proto__` back as an own key.)
 *
 * `in` remains correct — and stays in use — where the key set is statically
 * known: a discriminated union's tag, a capability probe, a brand check. The
 * distinction is whether the key came from data or from the code.
 */
export function hasOwnKey(
  bag: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return Object.hasOwn(bag, key);
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
