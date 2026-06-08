/**
 * The single canonical property serializer for the merge primitive.
 *
 * Hoisted to T2 (rather than living next to the clustering code) because three
 * separate phases must agree byte-for-byte on the serialized form of a property
 * bag:
 *
 *   - state-diff (T3) — to detect whether an inherited node's props changed,
 *   - clustering / property union (T8) — to compare member values,
 *   - edge repoint + dedupe (T9) — to key the `(from|type|to|propsKey)` tuple.
 *
 * {@link canonicalValueKey} is the SINGLE-VALUE sibling: the same recursive
 * key-sort over an arbitrary {@link JsonValue} (scalar / array / object), so the
 * conflict-resolution layer (T8 / `conflict-policy.ts`) decides value equality and
 * tie-breaks on the canonical form too — two branches that wrote a logically-equal
 * nested object with different key order must NOT register as a conflict.
 *
 * Determinism rules:
 *   - Object keys are sorted lexicographically at every nesting level, so two
 *     objects that differ only by key insertion order serialize identically.
 *   - Arrays preserve order (order is semantically meaningful in a list).
 *   - `undefined` keys are dropped (JSON has no `undefined`; an absent key and a
 *     key set to `undefined` are treated as the same absence).
 *   - All other JSON-representable values serialize via their natural form.
 *
 * IMPORTANT contract for callers: the input MUST be a PARSED plain object, never
 * a JSON string. Backend rows store `props` as a JSON string; callers MUST
 * `JSON.parse` first. Passing a string would serialize the string literal (with
 * its own incidental key order) rather than the canonical structure, so the
 * `propsKey` would NOT be stable across staged-vs-committed representations.
 */

import type { JsonValue } from "./typegraph-internal";
import { sortedReplacer } from "./typegraph-internal";

/**
 * Produces a deterministic, recursively key-sorted JSON serialization of a
 * parsed property object.
 *
 * Delegates to the schema layer's {@link sortedReplacer} — the single canonical
 * JSON serializer in the codebase (also used by `computeSchemaHash` /
 * `computeSchemaDiff`) — so the merge primitive and the schema layer can never
 * drift on what "canonical form" means. The replacer sorts object keys at every
 * depth while preserving array order; `JSON.stringify` omits `undefined`-valued
 * keys, matching the "an absent key and a key set to `undefined` are the same
 * absence" rule in the module docs.
 *
 * @param props A PARSED plain object (NOT a JSON string). See module docs.
 * @returns A canonical JSON string suitable for equality comparison / dedupe
 *   keying. Equivalent objects (key order aside) yield identical strings;
 *   objects differing in any value yield differing strings.
 */
export function canonicalizeProps(
  props: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify(props, sortedReplacer);
}

/**
 * Produces a deterministic, recursively key-sorted JSON serialization of a single
 * {@link JsonValue} — the per-value analogue of {@link canonicalizeProps}.
 *
 * Used by the conflict layer to compare candidate values, dedupe them, and
 * tie-break, so a nested object's incidental key order can never make two
 * logically-equal values look different (which would surface a spurious conflict).
 *
 * @param value Any parsed JSON value (scalar, array, or object). Not a JSON string.
 * @returns A canonical JSON string suitable for equality / dedupe / ordering.
 */
export function canonicalValueKey(value: JsonValue): string {
  return JSON.stringify(value, sortedReplacer);
}

/**
 * Parses a stored row's JSON `props` string into the PARSED plain object that
 * {@link canonicalizeProps} requires. Malformed JSON, a non-object, or an array
 * all collapse to `{}` — a parse error never escapes. Backend-written rows hold
 * valid JSON, but an external / legacy / truncated `props` value must not crash a
 * state diff or a base-version fingerprint. Centralized so the diff and the
 * fingerprint can never disagree on what a malformed row parses to.
 */
export function parseRowProps(
  props: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(props);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}
