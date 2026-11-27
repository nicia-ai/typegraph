import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { sha256Hex, sha256HexSync } from "../src/utils/hash";
import { propertyRuns } from "./property/run-budget";

describe("sha256HexSync", () => {
  it("matches the FIPS 180-4 test vectors", () => {
    expect(sha256HexSync("abc", 32)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256HexSync("", 32)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(
      sha256HexSync(
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        32,
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("is the digest the Web Crypto sha256Hex computes, for any input and length", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: "grapheme", maxLength: 300 }),
        fc.integer({ min: 1, max: 32 }),
        async (input, byteLength) => {
          expect(sha256HexSync(input, byteLength)).toBe(
            await sha256Hex(input, byteLength),
          );
        },
      ),
      { numRuns: propertyRuns({ ci: 300, local: 200 }) },
    );
    // Inputs across the 55/56/64-byte padding boundaries.
    for (let length = 50; length < 130; length += 1) {
      const input = "x".repeat(length);
      expect(sha256HexSync(input, 32)).toBe(await sha256Hex(input, 32));
    }
  });
});
