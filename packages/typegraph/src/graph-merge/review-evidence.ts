import { MergeReviewError } from "./errors";
import { compareStrings } from "./node-key";
import { normalizeMergeOptions } from "./options";
import type { GraphDef, JsonValue } from "./typegraph-internal";
import { sha256Hex, sortedReplacer } from "./typegraph-internal";
import type { MergeOptions } from "./types";

/** Canonical content identity shared by review wire validation and row evidence. */
export function reviewJson(value: unknown): string {
  // Missing optional fields must compare distinctly from every JSON value.
  if (value === undefined) return "undefined";
  return JSON.stringify(value, sortedReplacer);
}

export async function reviewDigest(value: unknown): Promise<string> {
  return sha256Hex(reviewJson(value), 32);
}

/**
 * Preserve every normalized option, including Maps and the presence of callbacks.
 * Callback code/closure identity is deliberately supplied by MergeReviewPolicy.
 * Tagged values keep a literal object from impersonating a callback or Map.
 */
export function reviewOptionEvidence<G extends GraphDef>(
  options: Omit<MergeOptions<G>, "target"> | undefined,
): JsonValue {
  return encodeOption(normalizeMergeOptions(options), new Set());
}

function encodeOption(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === undefined) return ["undefined"];
  if (typeof value === "function") return ["callback"];
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return ["literal", value];
  }
  if (typeof value === "number" && Number.isFinite(value))
    return ["number", value];
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new MergeReviewError(
      "Merge options contain unsupported or cyclic review evidence.",
    );
  }
  const nextAncestors = new Set([...ancestors, value]);
  if (Array.isArray(value)) {
    return [
      "array",
      value.map((item: unknown) => encodeOption(item, nextAncestors)),
    ];
  }
  if (value instanceof Map) {
    const entries = [...(value as ReadonlyMap<unknown, unknown>)].map(
      ([key, entry]) => [
        encodeOption(key, nextAncestors),
        encodeOption(entry, nextAncestors),
      ],
    );
    entries.sort((left, right) =>
      compareStrings(reviewJson(left), reviewJson(right)),
    );
    return ["map", entries];
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new MergeReviewError(
      "Merge options contain a non-JSON object without a review representation.",
    );
  }
  return [
    "object",
    Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => [key, encodeOption(entry, nextAncestors)]),
  ];
}
