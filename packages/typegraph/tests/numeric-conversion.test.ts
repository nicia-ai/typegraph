import { describe, expect, it } from "vitest";

import { isRepresentableNumericText } from "../src/query/dialect/numeric-conversion";

describe("isRepresentableNumericText", () => {
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
      `0.${"0".repeat(20_000)}`,
    ];
    expect(
      accepted.filter((text) => !isRepresentableNumericText(text)),
    ).toEqual([]);
  });

  it("refuses text past either bound and text that is not decimal", () => {
    const refused = [
      `1${"0".repeat(131_072)}`,
      `0.${"0".repeat(16_383)}1`,
      "1e131072",
      "1e-16384",
      "1e200000",
      "-1e-20000",
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
