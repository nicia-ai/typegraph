/**
 * `compareCodePoints` must reproduce the order a SQL engine would use.
 *
 * SQLite's `BINARY` collation, Postgres's `C` collation, and UTF-8 byte order
 * are all code-point order. JavaScript's `<` compares UTF-16 code *units*,
 * which disagrees for astral characters. The hybrid-search fusion fallback
 * must pick the same tie-break winner as the single-statement SQL path, so it
 * sorts with `compareCodePoints`, not `compareStrings`.
 */
import { describe, expect, it } from "vitest";

import { compareCodePoints, compareStrings } from "../src/utils/compare";
import { requireDefined } from "../src/utils/presence";

/** UTF-8 byte order — what SQLite BINARY / Postgres `C` actually compare. */
function compareUtf8Bytes(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const leftByte = requireDefined(leftBytes[index]);
    const rightByte = requireDefined(rightBytes[index]);
    if (leftByte !== rightByte) return leftByte < rightByte ? -1 : 1;
  }
  if (leftBytes.length === rightBytes.length) return 0;
  return leftBytes.length < rightBytes.length ? -1 : 1;
}

/** Never returns `-0`, which `toBe` (Object.is) would distinguish from `0`. */
function sign(value: number): number {
  if (value < 0) return -1;
  return value > 0 ? 1 : 0;
}

// U+1F600 GRINNING FACE (astral, surrogate pair) vs U+FFFD REPLACEMENT
// CHARACTER (BMP). Code point: U+FFFD < U+1F600. UTF-16 code unit: the
// surrogate lead U+D83D < U+FFFD, so `<` reverses them.
const ASTRAL = "\u{1F600}";
const HIGH_BMP = "�";

describe("compareCodePoints", () => {
  it("orders plain ASCII exactly as compareStrings does", () => {
    const samples = ["", "a", "ab", "b", "A", "_", "0", "a_b", "ab"];
    for (const left of samples) {
      for (const right of samples) {
        expect(sign(compareCodePoints(left, right))).toBe(
          sign(compareStrings(left, right)),
        );
      }
    }
  });

  it("agrees with UTF-8 byte order where compareStrings does not", () => {
    expect(sign(compareCodePoints(ASTRAL, HIGH_BMP))).toBe(
      sign(compareUtf8Bytes(ASTRAL, HIGH_BMP)),
    );
    // The bug this exists to avoid: code-unit order disagrees with the engine.
    expect(sign(compareStrings(ASTRAL, HIGH_BMP))).not.toBe(
      sign(compareUtf8Bytes(ASTRAL, HIGH_BMP)),
    );
  });

  it("matches UTF-8 byte order across a mixed corpus", () => {
    const corpus = [
      "",
      "a",
      "z",
      "A",
      "_",
      "~",
      "é",
      "ß",
      "日",
      "\u{10000}",
      ASTRAL,
      HIGH_BMP,
      "a\u{1F600}",
      "a�",
      "node-01",
      "node-1",
    ];
    for (const left of corpus) {
      for (const right of corpus) {
        expect(sign(compareCodePoints(left, right))).toBe(
          sign(compareUtf8Bytes(left, right)),
        );
      }
    }
  });

  it("is a total order: antisymmetric, reflexive, and transitive on the corpus", () => {
    const corpus = ["a", "b", ASTRAL, HIGH_BMP, "日", "", "ab"];
    for (const value of corpus) {
      expect(compareCodePoints(value, value)).toBe(0);
    }
    for (const left of corpus) {
      for (const right of corpus) {
        expect(sign(compareCodePoints(left, right))).toBe(
          sign(-compareCodePoints(right, left)),
        );
      }
    }
    const sorted = [...corpus].toSorted((a, b) => compareCodePoints(a, b));
    for (let index = 1; index < sorted.length; index += 1) {
      expect(
        compareCodePoints(
          requireDefined(sorted[index - 1]),
          requireDefined(sorted[index]),
        ),
      ).toBeLessThan(1);
    }
  });

  it("orders a prefix below the string that extends it", () => {
    expect(compareCodePoints("node", "node-1")).toBeLessThan(0);
    expect(compareCodePoints("node-1", "node")).toBeGreaterThan(0);
  });
});
