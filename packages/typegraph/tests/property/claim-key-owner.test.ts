/**
 * The key owner keys a stored value as it keys the parse output it was
 * stored from.
 *
 * For a generated field schema and a generated input `x`, the key of
 * `parse(x)` equals the key of `storedRoundTrip(parse(x))`, where the round
 * trip is what storage does to a value: JSON serialisation (a `Date` becomes
 * its ISO text, `undefined` properties vanish) followed by PostgreSQL `jsonb`'s
 * key order (shorter keys first, then by bytes). The schemas cover every
 * position the walk reaches: strings, numbers, booleans, dates, a pipe whose
 * output is a date, nested objects (inputs stating their keys in another
 * order), arrays, `.optional()`, `.nullable()`, `.default()` (with a literal
 * whose key order differs from the shape's), `z.lazy()` and a union with
 * `null`.
 *
 * Two further laws pin compatibility. The walk is idempotent. And without a
 * `.default()` object, a parse output is already canonical: the walk returns
 * it unchanged and the key equals the one the raw renderer
 * (`computeUniqueKey`, the rendering main keyed a create with) gives it, so
 * no existing key moves.
 *
 * REVERT CHECK: see the report. Keying both sides with `computeUniqueKey`
 * (no canonical rendering) fails the round-trip law on the first top-level
 * date; disabling the lazy, pipe or union arm of the walk fails it on the
 * first date under that wrapper; disabling object reordering fails it on the
 * first object whose shape order is not `jsonb`'s.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { computeUniqueKey, uniqueFieldsKey } from "../../src/constraints";
import { claimKeyValue } from "../../src/constraints/claim-key";
import { propertyRuns } from "./run-budget";

type Generated = Readonly<{
  schema: z.ZodType;
  input: fc.Arbitrary<unknown>;
  /** Whether a `.default()` object sits anywhere in the schema. */
  hasDefault: boolean;
}>;

const PORTABLE_DATE = fc.date({
  min: new Date("0001-01-01T00:00:00.000Z"),
  max: new Date("9999-12-31T23:59:59.999Z"),
  noInvalidDate: true,
});

const PROPERTY_NAMES = ["a", "b", "zeta", "id", "longer_name", "k2"] as const;

const LEAVES: readonly Generated[] = [
  { schema: z.string(), input: fc.string(), hasDefault: false },
  {
    schema: z.number(),
    input: fc.double({ noNaN: true, noDefaultInfinity: true }),
    hasDefault: false,
  },
  { schema: z.boolean(), input: fc.boolean(), hasDefault: false },
  { schema: z.date(), input: PORTABLE_DATE, hasDefault: false },
  {
    schema: z.string().pipe(z.coerce.date()),
    input: PORTABLE_DATE.map((date) => date.toISOString()),
    hasDefault: false,
  },
];

/** `value` with its own keys restated in a shuffled order. */
function reordered(
  value: Readonly<Record<string, unknown>>,
): fc.Arbitrary<Record<string, unknown>> {
  return fc
    .shuffledSubarray(Object.keys(value), {
      minLength: Object.keys(value).length,
    })
    .map((keys) =>
      Object.fromEntries(keys.map((key) => [key, value[key]] as const)),
    );
}

function objectOf(
  fields: readonly (readonly [string, Generated])[],
): Generated {
  const shape = Object.fromEntries(
    fields.map(([name, field]) => [name, field.schema] as const),
  );
  return {
    schema: z.object(shape),
    input: fc
      .record(
        Object.fromEntries(
          fields.map(([name, field]) => [name, field.input] as const),
        ),
      )
      .chain((value) => reordered(value)),
    hasDefault: fields.some(([, field]) => field.hasDefault),
  };
}

const GENERATED: fc.Arbitrary<Generated> = fc.letrec<{
  node: Generated;
}>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, depthIdentifier: "schema" },
    fc.constantFrom(...LEAVES),
    fc
      .uniqueArray(fc.tuple(fc.constantFrom(...PROPERTY_NAMES), tie("node")), {
        minLength: 1,
        maxLength: 4,
        selector: ([name]) => name,
      })
      .map((fields) => objectOf(fields)),
    tie("node").map((element) => ({
      schema: z.array(element.schema),
      input: fc.array(element.input, { maxLength: 3 }),
      hasDefault: element.hasDefault,
    })),
    tie("node").map((inner) => ({
      schema: inner.schema.optional(),
      input: fc.option(inner.input, { nil: undefined }),
      hasDefault: inner.hasDefault,
    })),
    tie("node").map((inner) => ({
      schema: inner.schema.nullable(),
      // eslint-disable-next-line unicorn/no-null -- a nullable value is null
      input: fc.option(inner.input, { nil: null }),
      hasDefault: inner.hasDefault,
    })),
    tie("node").map((inner) => ({
      schema: z.lazy(() => inner.schema),
      input: inner.input,
      hasDefault: inner.hasDefault,
    })),
    tie("node").map((inner) => ({
      schema: z.union([inner.schema, z.null()]),
      // eslint-disable-next-line unicorn/no-null -- the union's null branch
      input: fc.option(inner.input, { nil: null }),
      hasDefault: inner.hasDefault,
    })),
    // A default object whose literal states its keys in another order than
    // the shape: the parse returns the literal as written.
    fc
      .uniqueArray(fc.tuple(fc.constantFrom(...PROPERTY_NAMES), tie("node")), {
        minLength: 2,
        maxLength: 4,
        selector: ([name]) => name,
      })
      .chain((fields) => {
        const object = objectOf(fields);
        return object.input.chain((stated) =>
          reordered(object.schema.parse(stated) as Record<string, unknown>).map(
            (literal) => ({
              schema: (object.schema as z.ZodObject).default(literal as never),
              input: fc.constantFrom(undefined, stated),
              hasDefault: true,
            }),
          ),
        );
      }),
  ),
})).node;

/** Orders an object's keys as PostgreSQL `jsonb` returns them. */
function jsonbKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element: unknown) => jsonbKeyOrder(element));
  }
  if (typeof value !== "object" || value === null) return value;
  const keys = Object.keys(value).toSorted((left, right) =>
    left.length === right.length ?
      Buffer.compare(Buffer.from(left), Buffer.from(right))
    : left.length - right.length,
  );
  return Object.fromEntries(
    keys.map(
      (key) =>
        [key, jsonbKeyOrder((value as Record<string, unknown>)[key])] as const,
    ),
  );
}

/** What storage does to a props bag: JSON text, then `jsonb`'s key order. */
function storedRoundTrip(
  props: Record<string, unknown>,
): Record<string, unknown> {
  // JSON semantics, not a clone: a `Date` must become its ISO text.
  // eslint-disable-next-line unicorn/prefer-structured-clone
  return jsonbKeyOrder(JSON.parse(JSON.stringify(props))) as Record<
    string,
    unknown
  >;
}

const CASES = GENERATED.chain((field) =>
  field.input.map((input) => ({ field, input })),
);

function parseField(
  field: Generated,
  input: unknown,
): Readonly<{ kind: z.ZodType; parsed: Record<string, unknown> }> {
  const kind = z.object({ v: field.schema });
  const parsed = kind.parse(input === undefined ? {} : { v: input });
  return { kind, parsed: parsed };
}

describe("the key owner keys a stored value as its parse output", () => {
  it("key(parse(x)) === key(storedRoundTrip(parse(x)))", () => {
    fc.assert(
      fc.property(CASES, ({ field, input }) => {
        const { kind, parsed } = parseField(field, input);
        expect(
          uniqueFieldsKey(kind, storedRoundTrip(parsed), ["v"], "binary"),
        ).toBe(uniqueFieldsKey(kind, parsed, ["v"], "binary"));
      }),
      { numRuns: propertyRuns({ ci: 2000, local: 500 }) },
    );
  });

  it("the walk is idempotent", () => {
    fc.assert(
      fc.property(CASES, ({ field, input }) => {
        const once = claimKeyValue(
          field.schema,
          parseField(field, input).parsed["v"],
        );
        expect(claimKeyValue(field.schema, once)).toBe(once);
      }),
      { numRuns: propertyRuns({ ci: 2000, local: 500 }) },
    );
  });

  it("leaves a parse output without a default object as it is, so its key is the one main keyed", () => {
    fc.assert(
      fc.property(
        CASES.filter(({ field }) => !field.hasDefault),
        ({ field, input }) => {
          const { kind, parsed } = parseField(field, input);
          const value = parsed["v"];
          expect({
            walked: claimKeyValue(field.schema, value) === value,
            key: uniqueFieldsKey(kind, parsed, ["v"], "binary"),
          }).toEqual({
            walked: true,
            key: computeUniqueKey(parsed, ["v"], "binary"),
          });
        },
      ),
      { numRuns: propertyRuns({ ci: 2000, local: 500 }) },
    );
  });

  it("states the date rule: a Date and its stored text key as the quoted ISO text", () => {
    const at = new Date("2024-01-02T03:04:05.000Z");
    const text = at.toISOString();
    const quoted = JSON.stringify(text);
    const positions: readonly Readonly<{
      name: string;
      schema: z.ZodType;
      value: unknown;
      stored: unknown;
      key: string;
    }>[] = [
      {
        name: "top level",
        schema: z.date(),
        value: at,
        stored: text,
        key: quoted,
      },
      {
        name: "optional",
        schema: z.date().optional(),
        value: at,
        stored: text,
        key: quoted,
      },
      {
        name: "nullable",
        schema: z.date().nullable(),
        value: at,
        stored: text,
        key: quoted,
      },
      {
        name: "default",
        schema: z.date().default(at),
        value: at,
        stored: text,
        key: quoted,
      },
      {
        name: "lazy",
        schema: z.lazy(() => z.date()),
        value: at,
        stored: text,
        key: quoted,
      },
      {
        name: "union with null",
        schema: z.union([z.date(), z.null()]),
        value: at,
        stored: text,
        key: quoted,
      },
      {
        name: "piped",
        schema: z.string().pipe(z.coerce.date()),
        value: at,
        stored: text,
        key: quoted,
      },
      {
        name: "nested",
        schema: z.object({ at: z.date() }),
        value: { at },
        stored: { at: text },
        key: `{"at":${quoted}}`,
      },
      {
        name: "array element",
        schema: z.array(z.date()),
        value: [at],
        stored: [text],
        key: `[${quoted}]`,
      },
    ];
    expect(
      positions.map((position) => {
        const kind = z.object({ v: position.schema });
        return {
          name: position.name,
          fromDate: uniqueFieldsKey(
            kind,
            { v: position.value },
            ["v"],
            "binary",
          ),
          fromText: uniqueFieldsKey(
            kind,
            { v: position.stored },
            ["v"],
            "binary",
          ),
        };
      }),
    ).toEqual(
      positions.map((position) => ({
        name: position.name,
        fromDate: position.key,
        fromText: position.key,
      })),
    );
  });

  it("leaves a union whose branches disagree, and a lazy schema that resolves to itself, as given", () => {
    const text = "2024-01-02T03:04:05.000Z";
    const disagreeing = z.object({ v: z.union([z.date(), z.string()]) });
    const selfReferential: z.ZodType = z.lazy(() => selfReferential);
    const cyclic = z.object({ v: selfReferential });
    expect({
      disagreeing: uniqueFieldsKey(disagreeing, { v: text }, ["v"], "binary"),
      cyclic: uniqueFieldsKey(cyclic, { v: text }, ["v"], "binary"),
    }).toEqual({ disagreeing: text, cyclic: text });
  });
});
