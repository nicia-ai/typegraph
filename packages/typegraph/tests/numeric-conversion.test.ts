import { describe, expect, it } from "vitest";

import { isRepresentableNumericText } from "../src/query/dialect/numeric-conversion";

describe("isRepresentableNumericText", () => {
  // Every case was checked against PostgreSQL 18's numeric input (PGlite):
  // the accepted ones cast, the refused ones raise 22P02 or 22003.
  it("accepts decimal text within NUMERIC's 131072 integer and 16383 fraction digits", () => {
    const accepted = [
      "0",
      "-0",
      "0.000",
      "1",
      "-12.5",
      "1e39",
      "1e9999",
      "-1e-400",
      `1${"0".repeat(131_071)}`,
      `0.${"0".repeat(16_382)}1`,
      "1e131071",
      "1e-16383",
      "12.5e131070",
      `0.${"0".repeat(16_383)}`,
      `1.${"0".repeat(16_383)}`,
      "0e-16383",
      "0.00e-16381",
      "1.5e-16382",
      "0e200000",
      "0e999999999",
      "1e+5",
    ];
    expect(
      accepted.filter((text) => !isRepresentableNumericText(text)),
    ).toEqual([]);
  });

  it("refuses text past either bound, counting every written fraction digit, and text that is not decimal", () => {
    const refused = [
      `1${"0".repeat(131_072)}`,
      `0.${"0".repeat(16_383)}1`,
      "1e131072",
      "1e-16384",
      "1e200000",
      "-1e-20000",
      // A scale counts every written fraction digit, a zero's and trailing
      // zeros included, less the exponent.
      `0.${"0".repeat(20_000)}`,
      `0.${"0".repeat(16_384)}`,
      `1.${"0".repeat(16_384)}`,
      "0e-20000",
      "0e-16384",
      "0.00e-16382",
      "1.5e-16383",
      "15e-16384",
      "0.1e131073",
      "10e131071",
      // The input bounds an exponent before it reads the digits.
      "0e1073741824",
      "0e99999999999999999999",
      "NaN",
      "Infinity",
      " 1",
      "1 ",
      "0x10",
      "",
      "-",
      ".",
    ];
    expect(refused.filter((text) => isRepresentableNumericText(text))).toEqual(
      [],
    );
  });
});
