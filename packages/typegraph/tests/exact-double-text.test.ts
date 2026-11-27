import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseExactDoubleText } from "../src/query/dialect/exact-double-text";

/**
 * The exact binary text of a finite nonzero double, from its bits: the
 * significand scaled to [2^52, 2^53) and the exponent of its last bit, as
 * `sqliteExactDoubleText` renders it.
 */
function exactText(double: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, double);
  const bits = view.getBigUint64(0);
  const sign = bits >> 63n === 1n ? "-" : "";
  const biased = Number((bits >> 52n) & 0x7_ffn);
  let significand = bits & ((1n << 52n) - 1n);
  let exponent: number;
  if (biased === 0) {
    // A subnormal: shift its significand up into [2^52, 2^53).
    exponent = -1074;
    while (significand < 1n << 52n) {
      significand <<= 1n;
      exponent -= 1;
    }
  } else {
    significand |= 1n << 52n;
    exponent = biased - 1075;
  }
  return `${sign}${significand}p${exponent}`;
}

describe("parseExactDoubleText", () => {
  it("reads back every finite double from its exact binary text", () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        (double) => {
          const parsed = parseExactDoubleText(
            double === 0 ? "0" : exactText(double),
          );
          expect(parsed === double).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
    for (const double of [
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      2 ** -1022,
      2 ** -1022 - Number.MIN_VALUE,
      Number.MAX_VALUE,
      1,
      0.1,
    ])
      expect(parseExactDoubleText(exactText(double))).toBe(double);
  });

  it("reads the forms SQLite renders", () => {
    expect(parseExactDoubleText("0")).toBe(0);
    expect(parseExactDoubleText("4503599627370496p-52")).toBe(1);
    expect(parseExactDoubleText("-4503599627370496p-51")).toBe(-2);
    expect(parseExactDoubleText("4503599627370496p-1126")).toBe(
      Number.MIN_VALUE,
    );
    expect(parseExactDoubleText("9007199254740991p971")).toBe(Number.MAX_VALUE);
  });

  it("refuses text that is not the exact binary text of a finite double", () => {
    for (const text of [
      "",
      "1",
      "0.1",
      "1e3",
      "-0",
      "Inf",
      "-Inf",
      // A significand outside [2^52, 2^53).
      "4503599627370495p-52",
      "9007199254740992p-53",
      "0004503599627370496p-52",
      // Past the largest finite double.
      "4503599627370496p972",
      // A subnormal whose significand would lose a set bit.
      "4503599627370497p-1126",
      // Below the smallest subnormal.
      "4503599627370496p-1127",
      " 4503599627370496p-52",
      "4503599627370496P-52",
    ])
      expect({ text, parsed: parseExactDoubleText(text) }).toEqual({
        text,
        parsed: undefined,
      });
  });
});
