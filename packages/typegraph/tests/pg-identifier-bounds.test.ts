/**
 * PostgreSQL Identifier Bounding Tests
 *
 * PostgreSQL truncates identifiers at 63 *bytes*, not characters, so
 * `truncateToBytes` must never split a multi-byte UTF-8 character. Keeping
 * long query-generated names distinct is the generated-identifier owner's job,
 * pinned in `generated-identifier.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { truncateToBytes } from "../src/utils/identifier";

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
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
