/**
 * FNV-1a hash utilities.
 *
 * FNV-1a is a fast, non-cryptographic hash function used for generating
 * short, deterministic, collision-resistant identifiers (column aliases,
 * index name suffixes, etc.).
 */
import { FNV1A_OFFSET_BASIS, FNV1A_PRIME } from "../constants";

/**
 * FNV-1a hash of `input`, returned as a base-36 encoded string.
 */
export function fnv1aBase36(input: string): string {
  let hash = FNV1A_OFFSET_BASIS;
  for (const character of input) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    hash ^= codePoint;
    hash = Math.imul(hash, FNV1A_PRIME);
  }
  return (hash >>> 0).toString(36);
}
