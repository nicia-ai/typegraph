/**
 * A uniqueness key of a date does not depend on which form its props are in,
 * and no key changes bytes.
 *
 * For every value a kind accepts, the key derived from the VALIDATED props a
 * write stores equals the key derived from the STORED props a release reads
 * back (the JSON round trip of those props, key order preserved). And the key
 * of the validated props is byte-for-byte the key every create has always
 * written (`JSON.stringify` for a non-string value, the text itself for a
 * string), so claims a store already holds keep matching — including an object
 * `.default()`, which validation returns in its literal's key order.
 *
 * MUTATION CHECK: drop the `forms.isDateField` test in `computeUniqueKey` —
 * the stored-form property fails on the first date. Reorder an object's keys
 * to its shape before keying — the legacy-bytes property fails on the default.
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
    defaulted: z
      .object({ zone: z.string(), at: z.string() })
      .default({ at: "morning", zone: "north" }),
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

const sampleInputArb = fc.record(
  {
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
    defaulted: fc.record({ zone: fc.string(), at: fc.string() }),
    slots: fc.array(fc.record({ zone: fc.string(), when: dateArb }), {
      maxLength: 3,
    }),
    dates: fc.array(dateArb, { maxLength: 3 }),
  },
  {
    requiredKeys: [
      "label",
      "count",
      "flag",
      "at",
      "piped",
      "isoText",
      "slot",
      "slots",
      "dates",
    ],
  },
);

/** The bytes a create wrote for one field before key forms existed. */
function legacyFieldKey(value: unknown, collation: Collation): string {
  const text =
    typeof value === "string" ? value
    : typeof value === "number" || typeof value === "boolean" ? value.toString()
    : JSON.stringify(value);
  return collation === "caseInsensitive" ? text.toLowerCase() : text;
}

describe("uniqueness key forms", () => {
  it("keys validated props and their stored round trip identically", () => {
    fc.assert(
      fc.property(sampleInputArb, (input) => {
        const validated = Sample.schema.parse(input) as Record<string, unknown>;
        // The stored form is the JSON text the store writes, read back: a
        // deep clone would keep the `Date`s this round trip turns into text.
        const storedText = JSON.stringify(validated);
        const stored = JSON.parse(storedText) as Record<string, unknown>;
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
      }),
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
