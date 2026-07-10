/**
 * PostgreSQL Identifier Bounding Tests
 *
 * PostgreSQL truncates identifiers at 63 *bytes*, not characters. These tests
 * pin the two guarantees the shared `identifier` helpers must uphold:
 *   - `truncateToBytes` never splits a multi-byte UTF-8 character.
 *   - `boundPgIdentifier` leaves short names untouched, yet keeps two long
 *     names that share a >63-byte prefix distinct (and within the limit) by
 *     hashing the full, untruncated input.
 */
import { describe, expect, it } from "vitest";

import { boundPgIdentifier, truncateToBytes } from "../src/utils/identifier";

const MAX_PG_IDENTIFIER_BYTES = 63;

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Mirrors selectivePropsCteColumnName's length-prefixed encoding. */
function encodeSelectivePropsColumn(alias: string, field: string): string {
  return `__tg_${alias.length}:${alias}:${field.length}:${field}`;
}

describe("truncateToBytes", () => {
  const multibyteCases = [
    { label: "2-byte Latin (é)", character: "é" },
    { label: "3-byte CJK (日)", character: "日" },
    { label: "4-byte astral emoji (😀)", character: "😀" },
  ] as const;

  for (const { label, character } of multibyteCases) {
    it(`never splits a ${label} character`, () => {
      const repeated = character.repeat(5);
      const characterBytes = utf8ByteLength(character);

      // Sweep every byte budget from below one character to beyond the whole
      // string so odd cut points fall in the middle of a multi-byte sequence.
      for (let maxBytes = 0; maxBytes <= repeated.length * 4 + 2; maxBytes++) {
        const truncated = truncateToBytes(repeated, maxBytes);

        expect(utf8ByteLength(truncated)).toBeLessThanOrEqual(maxBytes);
        expect(repeated.startsWith(truncated)).toBe(true);
        expect(truncated.includes("�")).toBe(false);
        // Only whole characters survive — never a dangling partial byte, so
        // the result re-composes exactly from copies of the source character.
        expect(utf8ByteLength(truncated) % characterBytes).toBe(0);
        expect(truncated).toBe(
          character.repeat(truncated.length / character.length),
        );
      }
    });
  }

  it("returns the value unchanged when it already fits", () => {
    expect(truncateToBytes("short_alias", 63)).toBe("short_alias");
    expect(truncateToBytes("日本語", 9)).toBe("日本語");
  });
});

describe("boundPgIdentifier", () => {
  it("returns short names unchanged", () => {
    expect(boundPgIdentifier("__tg_6:friend:4:name", "friend\0name")).toBe(
      "__tg_6:friend:4:name",
    );
    expect(boundPgIdentifier("sg_n_Task_abc123", "Task\0title")).toBe(
      "sg_n_Task_abc123",
    );
  });

  it("leaves a name exactly at the limit unchanged", () => {
    const atLimit = "a".repeat(MAX_PG_IDENTIFIER_BYTES);
    expect(utf8ByteLength(atLimit)).toBe(MAX_PG_IDENTIFIER_BYTES);
    expect(boundPgIdentifier(atLimit, "a\0field")).toBe(atLimit);
  });

  it("keeps two long pairs distinct when their prefixes collide under truncation", () => {
    // Encoded exactly as selectivePropsCteColumnName does, with a 63-char alias
    // so the `__tg_<len>:<alias>:` prefix alone already overflows 63 bytes.
    const longAlias = "a".repeat(63);
    const nameField = encodeSelectivePropsColumn(longAlias, "name");
    const roleField = encodeSelectivePropsColumn(longAlias, "role");

    // Naive 63-byte truncation collapses both onto the same identifier: the
    // trailing `:name` / `:role` bytes are discarded. This is the exact bug.
    expect(truncateToBytes(nameField, MAX_PG_IDENTIFIER_BYTES)).toBe(
      truncateToBytes(roleField, MAX_PG_IDENTIFIER_BYTES),
    );

    const boundedName = boundPgIdentifier(nameField, `${longAlias}\0name`);
    const boundedRole = boundPgIdentifier(roleField, `${longAlias}\0role`);

    expect(boundedName).not.toBe(boundedRole);
    expect(utf8ByteLength(boundedName)).toBeLessThanOrEqual(
      MAX_PG_IDENTIFIER_BYTES,
    );
    expect(utf8ByteLength(boundedRole)).toBeLessThanOrEqual(
      MAX_PG_IDENTIFIER_BYTES,
    );
  });

  it("bounds a multi-byte name without splitting a character", () => {
    const longMultibyte = "日".repeat(40);
    const bounded = boundPgIdentifier(longMultibyte, "kind\0field");

    expect(utf8ByteLength(bounded)).toBeLessThanOrEqual(
      MAX_PG_IDENTIFIER_BYTES,
    );
    expect(bounded.includes("�")).toBe(false);
  });

  it("is deterministic for identical inputs", () => {
    const longAlias = "b".repeat(70);
    const encoded = `__tg_${longAlias.length}:${longAlias}:4:name`;

    expect(boundPgIdentifier(encoded, `${longAlias}\0name`)).toBe(
      boundPgIdentifier(encoded, `${longAlias}\0name`),
    );
  });
});
