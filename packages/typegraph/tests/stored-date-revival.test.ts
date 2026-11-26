import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  reviveStoredDateProps,
  reviveStoredDates,
} from "../src/store/stored-date-revival";

const TEXT = "2024-01-02T03:04:05.678Z";
const DATE = new Date(TEXT);

describe("reviveStoredDates", () => {
  it.for([
    ["z.date()", z.date()],
    ["z.coerce.date()", z.coerce.date()],
    ["a refined z.date()", z.date().refine((date) => date.getTime() > 0)],
    ["optional", z.date().optional()],
    ["nullable", z.date().nullable()],
    ["default", z.date().default(new Date(0))],
    ["prefault", z.date().prefault(new Date(0))],
    ["catch", z.date().catch(new Date(0))],
    ["readonly", z.date().readonly()],
    ["nonoptional", z.date().optional().nonoptional()],
    ["stacked wrappers", z.date().nullable().optional().default(new Date(0))],
  ] as const)("revives canonical text under %s", ([, schema]) => {
    expect(reviveStoredDates(schema, TEXT)).toEqual(DATE);
  });

  it.for([
    ["date-only text", z.date(), "2024-01-02"],
    ["text without milliseconds", z.date(), "2024-01-02T03:04:05Z"],
    ["text with an offset", z.date(), "2024-01-02T03:04:05.678+00:00"],
    ["not a date at all", z.date(), "yesterday"],
    ["a number", z.date(), 1_704_164_645_678],
    // eslint-disable-next-line unicorn/no-null -- a stored JSON null
    ["null under nullable", z.date().nullable(), null],
    ["a string schema", z.string(), TEXT],
    ["a union with a date", z.union([z.date(), z.string()]), TEXT],
    ["a date pipe", z.date().transform((date) => date.getTime()), TEXT],
    // The query compiler types this field as a date (its output); its input is
    // a string, which a revived `Date` would fail.
    ["a string piped into a date", z.string().pipe(z.coerce.date()), TEXT],
    ["a record of dates", z.record(z.string(), z.date()), { at: TEXT }],
    ["a tuple of dates", z.tuple([z.date()]), [TEXT]],
    ["a lazy date", z.lazy(() => z.date()), TEXT],
    // Canonical text no backend stores as a date: PostgreSQL refuses year 0000.
    ["year-zero text", z.date(), "0000-01-01T00:00:00.000Z"],
    // An overwrite runs on every parse, so a revived Date would be rewritten.
    [
      "a date with an overwrite",
      z.date().overwrite((date) => new Date(date.getTime() + 1)),
      TEXT,
    ],
    [
      "an optional date with an overwrite",
      z
        .date()
        .overwrite((date) => new Date(date.getTime() + 1))
        .optional(),
      TEXT,
    ],
  ] as const)("leaves %s as stored", ([, schema, value]) => {
    expect(reviveStoredDates(schema, value)).toBe(value);
  });

  it("revives inside nested objects and arrays", () => {
    const schema = z.object({
      title: z.string(),
      review: z.object({ at: z.date(), by: z.string() }).optional(),
      revisions: z.array(z.date()),
    });
    const stored = {
      title: TEXT,
      review: { at: TEXT, by: "editor" },
      revisions: [TEXT, "2024-01-02"],
    };
    expect(reviveStoredDates(schema, stored)).toEqual({
      title: TEXT,
      review: { at: DATE, by: "editor" },
      revisions: [DATE, "2024-01-02"],
    });
    expect(stored.review.at).toBe(TEXT);
  });

  it("returns the stored object itself when nothing is revived", () => {
    const schema = z.object({ title: z.string(), at: z.date().optional() });
    const stored = { title: "a", extra: TEXT };
    expect(reviveStoredDateProps(schema, stored)).toBe(stored);
  });

  it("leaves undeclared properties, including an own __proto__ key, as stored", () => {
    const schema = z.object({ at: z.date() });
    const stored = JSON.parse(
      `{"at":"${TEXT}","__proto__":"${TEXT}","other":"${TEXT}"}`,
    ) as Record<string, unknown>;
    const revived = reviveStoredDateProps(schema, stored);
    expect(revived["at"]).toEqual(DATE);
    expect(Object.hasOwn(revived, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(revived, "__proto__")?.value).toBe(
      TEXT,
    );
    expect(Object.getPrototypeOf(revived)).toBe(Object.prototype);
    expect(revived["other"]).toBe(TEXT);
  });

  it("revives nothing under an object that rewrites itself on every parse", () => {
    const schema = z
      .object({ at: z.date() })
      .overwrite((value) => ({ at: new Date(value.at.getTime() + 1) }));
    const stored = { at: TEXT };
    expect(reviveStoredDateProps(schema, stored)).toBe(stored);
  });

  it("revives through a refined object schema", () => {
    const schema = z
      .object({ from: z.date(), to: z.date() })
      .refine((range) => range.from <= range.to);
    const revived = reviveStoredDateProps(schema, { from: TEXT, to: TEXT });
    expect(schema.safeParse(revived).success).toBe(true);
  });
});
