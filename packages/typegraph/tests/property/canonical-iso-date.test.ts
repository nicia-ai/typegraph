/**
 * `isCanonicalIsoDate` decides "canonical" for every write path that stores a
 * timestamp and every predicate operand compared with one. It replaced a
 * `Date` round-trip with a range check over the regex-captured fields; these
 * properties pin that the replacement accepts and refuses exactly the strings
 * the round-trip did — not approximately, for every input.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isCanonicalIsoDate } from "../../src/utils/date";
import { propertyRuns } from "./run-budget";

/**
 * The implementation `isCanonicalIsoDate` replaced, kept verbatim as the
 * oracle: the strict shape, then a `Date` parse whose `toISOString()` must
 * reproduce the input exactly. Do not "simplify" it — its whole value is
 * being the old semantics.
 */
const ORACLE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function roundTripIsCanonicalIsoDate(value: string): boolean {
  if (!ORACLE_PATTERN.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

type Fields = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}>;

/** The canonical-shaped text of any field values, valid or not. */
function shaped(fields: Fields): string {
  return (
    `${pad(fields.year, 4)}-${pad(fields.month, 2)}-${pad(fields.day, 2)}` +
    `T${pad(fields.hour, 2)}:${pad(fields.minute, 2)}:${pad(fields.second, 2)}` +
    `.${pad(fields.millisecond, 3)}Z`
  );
}

function expectAgreement(value: string): void {
  expect({ value, verdict: isCanonicalIsoDate(value) }).toEqual({
    value,
    verdict: roundTripIsCanonicalIsoDate(value),
  });
}

/** A field value, biased toward the bounds a range check can get wrong. */
function boundedField(
  max: number,
  boundaries: readonly number[],
): fc.Arbitrary<number> {
  return fc.oneof(fc.constantFrom(...boundaries), fc.integer({ min: 0, max }));
}

/** Years whose leap status each Gregorian rule decides, plus the range ends. */
const BOUNDARY_YEARS = [
  0, 1, 3, 4, 99, 100, 200, 300, 400, 1600, 1700, 1800, 1900, 1970, 1999, 2000,
  2023, 2024, 2100, 2400, 9996, 9999,
] as const;

const regexShapedArb: fc.Arbitrary<string> = fc
  .record({
    year: boundedField(9999, BOUNDARY_YEARS),
    month: boundedField(99, [0, 1, 2, 11, 12, 13, 99]),
    day: boundedField(99, [0, 1, 28, 29, 30, 31, 32, 99]),
    hour: boundedField(99, [0, 23, 24, 99]),
    minute: boundedField(99, [0, 59, 60, 99]),
    second: boundedField(99, [0, 59, 60, 99]),
    millisecond: boundedField(999, [0, 999]),
  })
  .map((fields) => shaped(fields));

const validArb: fc.Arbitrary<string> = fc
  .date({
    min: new Date("0000-01-01T00:00:00.000Z"),
    max: new Date("9999-12-31T23:59:59.999Z"),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString());

/** One character edit of a canonical string: the near misses of the shape. */
const nearMissArb: fc.Arbitrary<string> = fc
  .tuple(
    validArb,
    fc.nat(),
    fc.constantFrom("delete", "insert", "replace"),
    fc.oneof(
      fc.constantFrom(
        "0",
        "9",
        "-",
        ":",
        ".",
        "T",
        "t",
        "Z",
        "z",
        " ",
        "+",
        "٠",
        "１",
        "\n",
      ),
      fc.string({ minLength: 1, maxLength: 1 }),
    ),
  )
  .map(([value, at, edit, character]) => {
    const index = at % (value.length + 1);
    if (edit === "delete")
      return value.slice(0, index) + value.slice(index + 1);
    if (edit === "insert")
      return value.slice(0, index) + character + value.slice(index);
    return value.slice(0, index) + character + value.slice(index + 1);
  });

describe("isCanonicalIsoDate equivalence with the Date round-trip", () => {
  it("accepts every canonical string the round-trip accepts", () => {
    fc.assert(
      fc.property(validArb, (value) => {
        expect(isCanonicalIsoDate(value)).toBe(true);
        expectAgreement(value);
      }),
      { numRuns: propertyRuns({ ci: 2000, local: 2000 }) },
    );
  });

  it("agrees on every regex-shaped string, valid or not (month 13, Feb 30, hour 24, leap years)", () => {
    fc.assert(
      fc.property(regexShapedArb, (value) => {
        expectAgreement(value);
      }),
      { numRuns: propertyRuns({ ci: 20_000, local: 20_000 }) },
    );
  });

  it("agrees on strings that do not match the shape", () => {
    fc.assert(
      fc.property(
        fc.oneof(nearMissArb, fc.string(), fc.string({ unit: "grapheme" })),
        (value) => {
          expectAgreement(value);
        },
      ),
      { numRuns: propertyRuns({ ci: 5000, local: 5000 }) },
    );
  });

  it("agrees on every month and day of the leap-rule boundary years", () => {
    for (const year of BOUNDARY_YEARS) {
      for (let month = 0; month <= 13; month += 1) {
        for (let day = 0; day <= 32; day += 1) {
          expectAgreement(
            shaped({
              year,
              month,
              day,
              hour: 12,
              minute: 0,
              second: 0,
              millisecond: 0,
            }),
          );
        }
      }
    }
  });

  it("agrees on February 28, 29 and 30 of every four-digit year", () => {
    for (let year = 0; year <= 9999; year += 1) {
      for (const day of [28, 29, 30]) {
        expectAgreement(
          shaped({
            year,
            month: 2,
            day,
            hour: 0,
            minute: 0,
            second: 0,
            millisecond: 0,
          }),
        );
      }
    }
  });

  it("agrees on every time of day at and past the field bounds", () => {
    for (let hour = 0; hour <= 25; hour += 1) {
      for (const minute of [0, 59, 60, 61]) {
        for (const second of [0, 59, 60, 61]) {
          for (const millisecond of [0, 999]) {
            for (const [year, month, day] of [
              [2024, 12, 31],
              [9999, 12, 31],
              [0, 1, 1],
            ] as const) {
              expectAgreement(
                shaped({ year, month, day, hour, minute, second, millisecond }),
              );
            }
          }
        }
      }
    }
  });
});

/**
 * Values a caller can pass where the type says `string`: a boxed `String` and
 * an object whose `toString()` is canonical text both pass the coercing
 * pattern test, and the oracle's closing `===` refused them.
 */
function nonPrimitiveForms(value: string): readonly unknown[] {
  return [new Object(value), { toString: () => value }];
}

describe("isCanonicalIsoDate input boundary", () => {
  it("refuses a non-primitive whose text is canonical, as the oracle does", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("0000-01-01T00:00:00.000Z"),
          max: new Date("9999-12-31T23:59:59.999Z"),
          noInvalidDate: true,
        }),
        (date) => {
          const text = date.toISOString();
          expect(isCanonicalIsoDate(text)).toBe(true);
          for (const form of nonPrimitiveForms(text)) {
            const input = form as string;
            expect({
              verdict: isCanonicalIsoDate(input),
              oracle: roundTripIsCanonicalIsoDate(input),
            }).toEqual({ verdict: false, oracle: false });
          }
        },
      ),
      { numRuns: propertyRuns({ ci: 1000, local: 1000 }) },
    );
  });
});
