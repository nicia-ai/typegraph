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

/** SHA-256's 64 round constants (FIPS 180-4, section 4.2.2). */
const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b,
  0x59_f1_11_f1, 0x92_3f_82_a4, 0xab_1c_5e_d5, 0xd8_07_aa_98, 0x12_83_5b_01,
  0x24_31_85_be, 0x55_0c_7d_c3, 0x72_be_5d_74, 0x80_de_b1_fe, 0x9b_dc_06_a7,
  0xc1_9b_f1_74, 0xe4_9b_69_c1, 0xef_be_47_86, 0x0f_c1_9d_c6, 0x24_0c_a1_cc,
  0x2d_e9_2c_6f, 0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da, 0x98_3e_51_52,
  0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7, 0xc6_e0_0b_f3, 0xd5_a7_91_47,
  0x06_ca_63_51, 0x14_29_29_67, 0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc,
  0x53_38_0d_13, 0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85,
  0xa2_bf_e8_a1, 0xa8_1a_66_4b, 0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19,
  0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70, 0x19_a4_c1_16, 0x1e_37_6c_08,
  0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a, 0x5b_9c_ca_4f,
  0x68_2e_6f_f3, 0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08,
  0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7, 0xc6_71_78_f2,
]);

/** SHA-256's initial hash value (FIPS 180-4, section 5.3.3). */
const SHA256_INITIAL_STATE = [
  0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f,
  0x9b_05_68_8c, 0x1f_83_d9_ab, 0x5b_e0_cd_19,
] as const;

function rotateRight(word: number, bits: number): number {
  return (word >>> bits) | (word << (32 - bits));
}

/**
 * Hex-truncated SHA-256 of `input`, computed synchronously: the same digest
 * as {@link sha256Hex}, for a caller that cannot await (a cursor validated
 * while a page plan is built). `byteLength` as for {@link sha256Hex}.
 */
export function sha256HexSync(input: string, byteLength = 8): string {
  const message = new TextEncoder().encode(input);
  // Padding: a 1 bit, zeros, then the message length in bits as a 64-bit
  // big-endian integer, to a multiple of 64 bytes.
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = message.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = new Uint32Array(SHA256_INITIAL_STATE);
  const schedule = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let index = 0; index < 16; index++) {
      schedule[index] = view.getUint32(block + index * 4);
    }
    for (let index = 16; index < 64; index++) {
      const previous2 = requireDefined(schedule[index - 2]);
      const previous15 = requireDefined(schedule[index - 15]);
      const sigma0 =
        rotateRight(previous15, 7) ^
        rotateRight(previous15, 18) ^
        (previous15 >>> 3);
      const sigma1 =
        rotateRight(previous2, 17) ^
        rotateRight(previous2, 19) ^
        (previous2 >>> 10);
      schedule[index] =
        requireDefined(schedule[index - 16]) +
        sigma0 +
        requireDefined(schedule[index - 7]) +
        sigma1;
    }
    // The working variables of FIPS 180-4, section 6.2.2.
    let a = requireDefined(state[0]);
    let b = requireDefined(state[1]);
    let c = requireDefined(state[2]);
    let d = requireDefined(state[3]);
    // eslint-disable-next-line unicorn/name-replacements -- FIPS 180-4's name for the fifth working variable
    let e = requireDefined(state[4]);
    let f = requireDefined(state[5]);
    let g = requireDefined(state[6]);
    let h = requireDefined(state[7]);
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h +
          sum1 +
          choice +
          requireDefined(SHA256_ROUND_CONSTANTS[index]) +
          requireDefined(schedule[index])) >>>
        0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    for (const [index, word] of [a, b, c, d, e, f, g, h].entries()) {
      state[index] = requireDefined(state[index]) + word;
    }
  }

  let hex = "";
  for (let index = 0; index < byteLength && index < 32; index++) {
    const word = requireDefined(state[Math.floor(index / 4)]);
    const byte = (word >>> (24 - (index % 4) * 8)) & 0xff;
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
