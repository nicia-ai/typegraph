/**
 * Runtime validation for JSON-serializable values.
 *
 * Used at definition-time boundaries (e.g., `defineNode`/`defineEdge` annotations)
 * to reject values that would silently break `JSON.stringify` round-trips or
 * throw at hash time. Catches accidental violations from untyped JS callers
 * and `as any` escape hatches that bypass the `JsonValue` type.
 */
import { ConfigurationError } from "../errors";

/**
 * Asserts that `value` is JSON-serializable.
 *
 * Throws `ConfigurationError` with a dotted path identifying the offending
 * field. Rejects `bigint`, `function`, `symbol`, `undefined`, and class
 * instances such as `Date`, `Map`, `Set`, regex literals, and Buffers — all
 * of which either throw or silently coerce under `JSON.stringify`.
 *
 * @param value - The value to validate
 * @param rootLabel - Label for the root of the value (e.g., `"annotations"`)
 *   used as the prefix of the error path
 * @param ownerKind - Human-readable owner identifier for the error message
 *   (e.g., `'Node "Person"'`)
 */
export function assertJsonValue(
  value: unknown,
  rootLabel: string,
  ownerKind: string,
): void {
  walk(value, rootLabel, ownerKind);
}

function walk(value: unknown, path: string, ownerKind: string): void {
  if (value === null) return;
  const valueType = typeof value;
  if (valueType === "number") {
    // NaN/Infinity/-Infinity are not JSON values; JSON.stringify silently
    // coerces them to `null`, which would change the canonical hash input
    // without the consumer noticing.
    if (!Number.isFinite(value)) {
      throwInvalid(path, describeNonFinite(value as number), ownerKind);
    }
    return;
  }
  if (valueType === "string" || valueType === "boolean") return;
  if (
    valueType === "bigint" ||
    valueType === "function" ||
    valueType === "symbol" ||
    valueType === "undefined"
  ) {
    throwInvalid(path, valueType, ownerKind);
  }
  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      walk(element, `${path}[${index}]`, ownerKind);
    }
    return;
  }
  if (!isPlainObject(value)) {
    throwInvalid(path, describeNonPlain(value), ownerKind);
  }
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    walk(nested, `${path}.${key}`, ownerKind);
  }
}

function isPlainObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeNonFinite(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  return "non-finite number";
}

function describeNonPlain(value: unknown): string {
  const constructorName = (value as { constructor?: { name?: unknown } } | null)
    ?.constructor?.name;
  if (typeof constructorName === "string" && constructorName.length > 0) {
    return `${constructorName} instance`;
  }
  return "non-plain object";
}

function throwInvalid(path: string, kind: string, ownerKind: string): never {
  throw new ConfigurationError(
    `${ownerKind} ${path} contains a non-JSON value (${kind}). Annotations must be JSON-serializable.`,
    { path, valueKind: kind },
    {
      suggestion:
        "Use only strings, numbers, booleans, null, arrays, and plain objects in annotations.",
    },
  );
}
