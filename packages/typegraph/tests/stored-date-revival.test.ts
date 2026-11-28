import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { kindShapeTypeInfo } from "../src/query/schema-introspector";
import { buildKindRegistry } from "../src/registry";
import {
  decodeStoredDate,
  decodeStoredValue,
  passStoredProps,
  reviveStoredDateProps,
  reviveStoredDates,
  storedFormOfReadProps,
  storedPropsReaders,
  storedReadPlan,
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

/** The read plan of a schema's props, as the store compiles it per kind. */
function propsPlan(schema: z.ZodType) {
  const shape = kindShapeTypeInfo(schema);
  if (shape === undefined) throw new Error("expected an object schema");
  return storedReadPlan({ valueType: "object", shape });
}

describe("decodeStoredDate", () => {
  it("decodes portable timestamp text and passes a Date through", () => {
    expect(decodeStoredDate(TEXT)).toEqual(DATE);
    const driverDate = new Date(TEXT);
    expect(decodeStoredDate(driverDate)).toBe(driverDate);
  });

  it.for([
    ["text without milliseconds", "2024-01-02T03:04:05Z"],
    ["date-only text", "2024-01-02"],
    ["text with an offset", "2024-01-02T03:04:05.678+00:00"],
    ["year-zero text", "0000-01-01T00:00:00.000Z"],
    ["extended-year text", "+010000-01-01T00:00:00.000Z"],
    ["garbage", "not a date"],
    ["a number", 1_704_164_645_678],
    // eslint-disable-next-line unicorn/no-null -- a stored JSON null
    ["null", null],
  ] as const)("returns %s exactly as stored", ([, value]) => {
    expect(decodeStoredDate(value)).toBe(value);
  });
});

describe("storedReadPlan", () => {
  it("lists only the positions whose schema output is a Date", () => {
    const plan = propsPlan(
      z.object({
        title: z.string(),
        plain: z.date(),
        opt: z.date().optional(),
        nul: z.date().nullable(),
        defaulted: z.date().default(new Date(0)),
        coerced: z.coerce.date(),
        piped: z.string().pipe(z.coerce.date()),
        nested: z.object({ at: z.date(), by: z.string() }),
        arr: z.array(z.date()),
        rec: z.record(z.string(), z.date()),
        iso: z.iso.datetime(),
        uniDS: z.union([z.date(), z.string()]),
        uniDN: z.union([z.date(), z.number()]),
        tuple: z.tuple([z.date()]),
        xform: z.date().transform((date) => date.getTime()),
        anything: z.unknown(),
      }),
    );
    const date = { form: "date" };
    expect(plan).toEqual({
      form: "object",
      keys: [
        ["plain", date],
        ["opt", date],
        ["nul", date],
        ["defaulted", date],
        ["coerced", date],
        ["piped", date],
        ["nested", { form: "object", keys: [["at", date]] }],
        ["arr", { form: "array", element: date }],
        ["rec", { form: "record", value: date }],
      ],
    });
  });

  it("has no plan for a kind with no date position", () => {
    expect(
      propsPlan(
        z.object({
          title: z.string(),
          nested: z.object({ at: z.string() }),
          iso: z.iso.datetime(),
        }),
      ),
    ).toBeUndefined();
  });
});

describe("decodeStoredValue", () => {
  const plan = propsPlan(
    z.object({
      plain: z.date(),
      nested: z.object({ at: z.date() }),
      arr: z.array(z.date()),
      rec: z.record(z.string(), z.date()),
    }),
  );

  it("decodes every planned position without mutating the stored props", () => {
    const stored = {
      plain: TEXT,
      nested: { at: TEXT },
      arr: [TEXT, "not a date"],
      rec: { first: TEXT },
      extra: TEXT,
    };
    const snapshot = structuredClone(stored);
    expect(decodeStoredValue(plan, stored)).toEqual({
      plain: DATE,
      nested: { at: DATE },
      arr: [DATE, "not a date"],
      rec: { first: DATE },
      extra: TEXT,
    });
    expect(stored).toEqual(snapshot);
  });

  it("returns the props themselves when nothing decodes", () => {
    const stored = { plain: "2024-01-02T03:04:05Z", arr: [] };
    expect(decodeStoredValue(plan, stored)).toBe(stored);
    expect(decodeStoredValue(undefined, stored)).toBe(stored);
  });

  it("keeps a stored __proto__ key an own property in its stored position", () => {
    const stored = JSON.parse(
      `{"__proto__":"${TEXT}","plain":"${TEXT}","after":1}`,
    ) as Record<string, unknown>;
    const decoded = decodeStoredValue(plan, stored) as Record<string, unknown>;
    expect(Object.keys(decoded)).toEqual(["__proto__", "plain", "after"]);
    expect(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value).toBe(
      TEXT,
    );
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(decoded["plain"]).toEqual(DATE);
  });

  it("is inverted byte for byte by storedFormOfReadProps", () => {
    const stored = {
      plain: TEXT,
      nested: { at: TEXT },
      arr: [TEXT],
      rec: { first: TEXT },
    };
    const decoded = decodeStoredValue(plan, stored) as Record<string, unknown>;
    expect(decoded["plain"]).toEqual(DATE);
    // The props themselves, before any serialization: `JSON.stringify` would
    // turn a surviving `Date` into the same text.
    const restored = storedFormOfReadProps(decoded);
    expect(restored).toStrictEqual(stored);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(stored));
  });
});

describe("storedPropsReaders", () => {
  it("returns the stored props reader for a graph with no date position", () => {
    const Plain = defineNode("Plain", {
      schema: z.object({ name: z.string() }),
    });
    const plainEdge = defineEdge("plainEdge", { schema: z.object({}) });
    const registry = buildKindRegistry(
      defineGraph({
        id: "undated",
        nodes: { Plain: { type: Plain } },
        edges: { plainEdge: { type: plainEdge, from: [Plain], to: [Plain] } },
      }),
    );
    const readers = storedPropsReaders(registry);
    expect(readers.node).toBe(passStoredProps);
    expect(readers.edge).toBe(passStoredProps);
    expect(storedPropsReaders(registry)).toBe(readers);
  });

  it("decodes a dated kind and passes an undated or unknown kind through", () => {
    const Dated = defineNode("Dated", { schema: z.object({ at: z.date() }) });
    const Plain = defineNode("Plain", { schema: z.object({ at: z.string() }) });
    const readers = storedPropsReaders(
      buildKindRegistry(
        defineGraph({
          id: "dated",
          nodes: { Dated: { type: Dated }, Plain: { type: Plain } },
          edges: {},
        }),
      ),
    );
    expect(readers.node("Dated", { at: TEXT })).toEqual({ at: DATE });
    const plain = { at: TEXT };
    expect(readers.node("Plain", plain)).toBe(plain);
    expect(readers.node("Unregistered", plain)).toBe(plain);
    expect(readers.edge).toBe(passStoredProps);
  });
});
