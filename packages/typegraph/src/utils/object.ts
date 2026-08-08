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
 * Own-key read of a data-keyed bag: an absent key reads `undefined`, never an
 * inherited `Object.prototype` member. The read companion to {@link hasOwnKey}
 * (see its doc for why `bag[key]` alone is wrong for these bags), and like it
 * the single owner — every path reading a data-keyed bag by a data-supplied
 * key calls here rather than re-spelling the guard.
 */
export function readOwnProperty(
  bag: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  return hasOwnKey(bag, key) ? bag[key] : undefined;
}

/**
 * Creates an accumulator whose KEYS ARE DATA — a kind name, a property name, a
 * JSON-Schema keyword, an entity's property bag. The write-side companion to
 * {@link hasOwnKey} / {@link readOwnProperty}, and like them the single owner
 * of the question: every accumulator keyed by data is built here.
 *
 * Null-prototype, because `bag[key] = value` on a `{}` literal does NOT create
 * an entry when `key` is `__proto__`: it invokes `Object.prototype`'s
 * `__proto__` SETTER, which either reparents the bag (object value) or does
 * nothing at all (primitive value). Either way the value is silently dropped,
 * and every later own-key read answers as if the writer never wrote it — the
 * write-side mirror of the inherited-member read `hasOwnKey` exists to prevent.
 *
 * Reachable, and not through anything exotic: kind names are validated against
 * `/^[A-Za-z_][A-Za-z0-9_]*$/`, which admits `__proto__` (as it does
 * `toString` and `constructor`); extension property names are unrestricted
 * apart from a reserved list; and `JSON.parse` yields `__proto__` as an
 * ordinary own key, so any document read off disk or the wire can carry one.
 *
 * A plain `{}` remains correct — and stays in use — for records whose keys are
 * statically known: an options object, a discriminated-union member, a fixed
 * lookup table.
 *
 * ## Spread it at the boundary
 *
 * The null prototype is an INTERNAL write-side protection, not something a
 * caller asked for. A bag that escapes into a value this library RETURNS must
 * be copied with a spread — `return { ...bag }` — at that boundary: returned
 * as-is it has no `toString`, no `hasOwnProperty`, and answers `false` to
 * `instanceof Object`, which is a public behavior change against every other
 * object the library hands back. The spread is safe precisely where a
 * key-by-key rebuild would not be: it copies own properties with
 * CreateDataProperty rather than Set, so an own `__proto__` key survives the
 * copy while `Object.prototype` is restored.
 */
export function createDataKeyedBag<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
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
