/**
 * Byte-bounded truncation for generated SQL identifiers.
 *
 * PostgreSQL silently truncates any identifier longer than 63 *bytes* —
 * not characters — keeping only the leading bytes. Callers that shorten a
 * name themselves (and append a discriminator) must cut on a character
 * boundary, which `truncateToBytes` guarantees. Query-generated names are
 * bounded and kept unique per statement by `src/query/generated-identifier.ts`.
 */
import { requireDefined } from "./presence";

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
  while (
    end > 0 &&
    requireDefined(encoded[end]) >= 0x80 &&
    requireDefined(encoded[end]) < 0xc0
  ) {
    end--;
  }

  return new TextDecoder().decode(encoded.slice(0, end));
}
