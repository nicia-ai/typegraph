/**
 * Hash utilities — FNV-1a for fast non-cryptographic identifier
 * generation, SHA-256 (truncated) for collision-resistant signatures.
 */
import { FNV1A_OFFSET_BASIS, FNV1A_PRIME } from "../constants";
import { requireDefined } from "./presence";

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

/**
 * Deterministic 8-char hash for collision-safe truncation of over-long
 * identifiers. Self-contained so the strategy layer has no backend-runtime
 * dependency.
 */
export function shortHash(input: string): string {
  let h1 = 0xde_ad_be_ef;
  let h2 = 0x41_c6_ce_57;
  for (let index = 0; index < input.length; index++) {
    const ch = requireDefined(input.codePointAt(index));
    h1 = Math.imul(h1 ^ ch, 0x9e_37_79_b1);
    h2 = Math.imul(h2 ^ ch, 0x5f_35_64_95);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 0x85_eb_ca_6b) ^
    Math.imul(h2 ^ (h2 >>> 13), 0xc2_b2_ae_35);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 0x85_eb_ca_6b) ^
    Math.imul(h1 ^ (h1 >>> 13), 0xc2_b2_ae_35);
  const hi = (h2 >>> 0).toString(16).padStart(8, "0");
  const lo = (h1 >>> 0).toString(16).padStart(8, "0");
  return `${hi}${lo}`.slice(0, 8);
}
