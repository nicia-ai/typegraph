/**
 * Hash utilities — FNV-1a for fast non-cryptographic identifier
 * generation, SHA-256 (truncated) for collision-resistant signatures.
 */
import { FNV1A_OFFSET_BASIS, FNV1A_PRIME } from "../constants";

/**
 * FNV-1a hash of `input`, returned as a base-36 encoded string. Used for
 * generating short, deterministic identifiers (column aliases, index
 * name suffixes, etc.).
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

/**
 * Hex-truncated SHA-256 of `input` via the Web Crypto API. Works in
 * Node.js 16+, Cloudflare Workers, Deno, and browsers.
 *
 * `byteLength` controls how many bytes of the digest are emitted —
 * default 8 (16 hex chars, ~64 bits, sufficient for schema-version and
 * per-graph index signatures). Pass 16 (32 hex chars) when hashes are
 * compared against externally-stored signatures.
 */
export async function sha256Hex(
  input: string,
  byteLength = 8,
): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let index = 0; index < byteLength; index++) {
    const byte = bytes[index];
    if (byte === undefined) break;
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
