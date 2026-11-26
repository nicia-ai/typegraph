/**
 * A uniqueness key does not depend on which form its props are in.
 *
 * For every value a kind accepts, the key derived from the VALIDATED props a
 * write stores equals the key derived from the STORED props a release reads
 * back — the JSON round trip of those props, with every object's keys in an
 * arbitrary order, as a backend that normalizes JSON (PostgreSQL `jsonb`)
 * returns them. And the key of the validated props is byte-for-byte the key
 * every create has always written (`JSON.stringify` for a non-string value,
 * the text itself for a string), so claims a store already holds keep matching.
 *
 * MUTATION CHECK: drop the `forms.isDateField` test in `computeUniqueKey` —
 * the stored-form property fails on the first date. Return the value as is
 * from `inOutputOrder` — it fails on the first reordered object.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../src";
import { computeUniqueKey, uniqueKeyFormsFor } from "../../src/constraints";
import { type Collation } from "../../src/core/types";
import { buildKindRegistry } from "../../src/registry/builders";
import { propertyRuns } from "./run-budget";

const Sample = defineNode("Sample", {
  schema: z.object({
    label: z.string(),
    count: z.number(),
    flag: z.boolean(),
    at: z.date(),
    maybeAt: z.date().optional(),
    piped: z.string().pipe(z.coerce.date()),
    isoText: z.iso.datetime(),
    slot: z.object({
      zone: z.string(),
      at: z.date(),
      inner: z.object({ second: z.number(), first: z.string() }),
    }),
    slots: z.array(z.object({ zone: z.string(), when: z.date() })),
    dates: z.array(z.date()),
  }),
});

const graph = defineGraph({
  id: "unique_key_forms_property",
  nodes: { Sample: { type: Sample } },
  edges: {},
});

const FORMS = uniqueKeyFormsFor(buildKindRegistry(graph), "Sample");
const FIELDS = Object.keys(Sample.schema.shape);
const COLLATIONS: readonly Collation[] = ["binary", "caseInsensitive"];

const dateArb = fc.date({
  min: new Date("0001-01-01T00:00:00.000Z"),
  max: new Date("9999-12-31T23:59:59.999Z"),
  noInvalidDate: true,
});

const sampleInputArb = fc.record({
  label: fc.string(),
  count: fc.oneof(
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
  ),
  flag: fc.boolean(),
  at: dateArb,
  maybeAt: fc.option(dateArb, { nil: undefined }),
  piped: dateArb.map((date) => date.toISOString()),
  isoText: dateArb.map((date) => date.toISOString()),
  slot: fc.record({
    zone: fc.string(),
    at: dateArb,
    inner: fc.record({ second: fc.integer(), first: fc.string() }),
  }),
  slots: fc.array(fc.record({ zone: fc.string(), when: dateArb }), {
    maxLength: 3,
  }),
  dates: fc.array(dateArb, { maxLength: 3 }),
});

/**
 * `value` with every object's keys in the order `rank` gives them: what a
 * backend that normalizes JSON hands back.
 */
function reorderKeys(
  value: unknown,
  rank: (keys: string[]) => string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => reorderKeys(item, rank));
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      rank(Object.keys(record)).map((key) => [
        key,
        reorderKeys(record[key], rank),
      ]),
    );
  }
  return value;
}

/** PostgreSQL `jsonb`'s key order: shorter keys first, then bytewise. */
function jsonbOrder(keys: string[]): string[] {
  return keys.toSorted((left, right) =>
    left.length === right.length ?
      left < right ? -1
      : left > right ? 1
      : 0
    : left.length - right.length,
  );
}

/** The bytes a create wrote for one field before key forms existed. */
function legacyFieldKey(value: unknown, collation: Collation): string {
  const text =
    typeof value === "string" ? value
    : typeof value === "number" || typeof value === "boolean" ? value.toString()
    : JSON.stringify(value);
  return collation === "caseInsensitive" ? text.toLowerCase() : text;
}

describe("uniqueness key forms", () => {
  it("keys validated props and their stored round trip identically, under any key order", () => {
    fc.assert(
      fc.property(
        sampleInputArb,
        fc.constantFrom<"insertion" | "jsonb" | "reversed">(
          "insertion",
          "jsonb",
          "reversed",
        ),
        (input, order) => {
          const validated = Sample.schema.parse(input) as Record<
            string,
            unknown
          >;
          // The stored form is the JSON text the store writes, read back: a
          // deep clone would keep the `Date`s this round trip turns into text.
          const storedText = JSON.stringify(validated);
          const roundTripped = JSON.parse(storedText) as unknown;
          const stored = reorderKeys(
            roundTripped,
            order === "insertion" ? (keys) => keys
            : order === "jsonb" ? jsonbOrder
            : (keys) => keys.toReversed(),
          ) as Record<string, unknown>;
          for (const collation of COLLATIONS) {
            for (const field of FIELDS) {
              expect(computeUniqueKey(stored, [field], collation, FORMS)).toBe(
                computeUniqueKey(validated, [field], collation, FORMS),
              );
            }
            expect(computeUniqueKey(stored, FIELDS, collation, FORMS)).toBe(
              computeUniqueKey(validated, FIELDS, collation, FORMS),
            );
          }
        },
      ),
      { numRuns: propertyRuns({ ci: 500, local: 500 }) },
    );
  });

  it("keys validated props with the bytes every create has always written", () => {
    fc.assert(
      fc.property(sampleInputArb, (input) => {
        const validated = Sample.schema.parse(input) as Record<string, unknown>;
        for (const collation of COLLATIONS) {
          for (const field of FIELDS) {
            const value = validated[field];
            if (value === undefined) continue;
            expect(computeUniqueKey(validated, [field], collation, FORMS)).toBe(
              legacyFieldKey(value, collation),
            );
          }
        }
      }),
      { numRuns: propertyRuns({ ci: 500, local: 500 }) },
    );
  });
});
