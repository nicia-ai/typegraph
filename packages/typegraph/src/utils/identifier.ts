/**
 * Bounding for generated SQL identifiers (column aliases, index names).
 *
 * PostgreSQL silently truncates any identifier longer than 63 *bytes* —
 * not characters — keeping only the leading bytes. Two distinct generated
 * identifiers that share a >63-byte prefix therefore collapse onto the same
 * physical name, producing an "ambiguous column" error or, worse, a
 * silently wrong value.
 *
 * `boundPgIdentifier` closes that gap: a name that already fits is returned
 * verbatim (short, human-readable identifiers stay readable and previously
 * emitted SQL is unchanged), and a name that does not is truncated by BYTE
 * length to leave room for a deterministic hash suffix computed from the
 * caller's FULL, untruncated input. Hashing the untruncated input is what
 * makes two colliding names diverge — the bytes truncation would discard
 * still shape the suffix.
 */
import { MAX_PG_IDENTIFIER_LENGTH } from "../constants";
import { fnv1aBase36 } from "./hash";

const TEXT_ENCODER = new TextEncoder();

/**
 * Truncates a string so its UTF-8 byte length does not exceed maxBytes.
 * Avoids splitting in the middle of a multi-byte character.
 */
export function truncateToBytes(value: string, maxBytes: number): string {
  const encoded = TEXT_ENCODER.encode(value);
  if (encoded.byteLength <= maxBytes) return value;

  // Walk backwards from the limit to find a clean character boundary.
  // UTF-8 continuation bytes have the form 10xxxxxx (0x80..0xBF).
  let end = maxBytes;
  while (end > 0 && encoded[end]! >= 0x80 && encoded[end]! < 0xc0) {
    end--;
  }

  return new TextDecoder().decode(encoded.slice(0, end));
}

/**
 * Bounds `name` to PostgreSQL's 63-byte identifier limit.
 *
 * Returns `name` unchanged when its UTF-8 byte length already fits, so
 * short identifiers keep their exact, readable form. Otherwise the name is
 * truncated by BYTE length to leave room for `"_" + fnv1aBase36(hashInput)`,
 * and the hash is appended — guaranteeing the result stays within the limit
 * while distinguishing inputs that share a truncated prefix.
 *
 * `hashInput` must be the caller's full, untruncated discriminator (for
 * example `alias + "\0" + field`): hashing the already-truncated `name`
 * would not disambiguate a collision.
 */
export function boundPgIdentifier(name: string, hashInput: string): string {
  if (TEXT_ENCODER.encode(name).byteLength <= MAX_PG_IDENTIFIER_LENGTH) {
    return name;
  }

  const hash = fnv1aBase36(hashInput);
  const truncated = truncateToBytes(
    name,
    MAX_PG_IDENTIFIER_LENGTH - 1 - hash.length,
  );
  return `${truncated}_${hash}`;
}
